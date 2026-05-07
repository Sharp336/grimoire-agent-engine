/**
 * Agent Bridge — forwards IM messages to the OMP agent and returns responses.
 *
 * Uses `omp -p` (non-interactive print mode) to process messages and capture output.
 *
 * Architecture:
 *   [DingTalk Message] → AgentBridge.forward() → `omp -p --no-session "msg"` → stdout → [Reply]
 *
 * Future improvements:
 * - Session persistence per conversation (`--session-dir` + `--resume`)
 * - Streaming responses (progressive output instead of wait-for-completion)
 * - Tool result rendering (format file edits, bash output for IM)
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { InboundMessage, SessionRecord } from "./types";

export interface AgentBridgeOptions {
	/** Path to omp binary (default: "omp") */
	ompPath?: string;
	/** Model to use (default: undefined = omp default) */
	model?: string;
	/** Session directory for persistence (default: undefined = ephemeral) */
	sessionDir?: string;
	/** Maximum time to wait for agent response in ms (default: 120000) */
	timeoutMs?: number;
	/** Working directory for agent execution (default: process.cwd()) */
	cwd?: string;
}

export class AgentBridge {
	#options: AgentBridgeOptions;

	constructor(options: AgentBridgeOptions = {}) {
		this.#options = options;
	}

	/**
	 * Forward a message to the OMP agent and return the response text.
	 *
	 * Spawns `omp -p --no-session <message>` and captures stdout.
	 * Returns null if the agent fails or times out.
	 */
	async forward(msg: InboundMessage, session: SessionRecord): Promise<string | null> {
		const text = this.#extractText(msg);
		if (!text.trim()) {
			logger.debug("Empty message, skipping agent");
			return null;
		}

		logger.debug("Forwarding to agent", {
			userId: msg.userId,
			conversationId: msg.conversationId,
			messageLength: text.length,
			sessionId: session.id,
		});

		const ompPath = this.#options.ompPath ?? "omp";
		const timeoutMs = this.#options.timeoutMs ?? 120_000;

		// Build omp command arguments
		const args = ["-p", "--no-session"];
		if (this.#options.model) {
			args.push("--model", this.#options.model);
		}
		if (this.#options.sessionDir) {
			args.push("--session-dir", this.#options.sessionDir);
		}
		args.push(text);

		try {
			const result = await this.#spawnAgent(ompPath, args, timeoutMs);

			if (result.error) {
				logger.error("Agent execution failed", { error: result.error });
				return `执行出错：${result.error}`;
			}

			const response = this.#stripAnsi(result.stdout).trim();
			if (!response) {
				logger.warn("Agent returned empty response");
				return "（Agent 未返回内容）";
			}

			logger.debug("Agent responded", {
				responseLength: response.length,
				exitCode: result.exitCode,
			});

			return response;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("Agent bridge failed", { error: message });
			return `系统错误：${message}`;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Private
	// ═══════════════════════════════════════════════════════════════════

	async #spawnAgent(
		command: string,
		args: string[],
		timeoutMs: number,
	): Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }> {
		const { promise, resolve } = Promise.withResolvers<{
			stdout: string;
			stderr: string;
			exitCode: number;
			error?: string;
		}>();

		const proc = Bun.spawn([command, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			cwd: this.#options.cwd ?? process.cwd(),
			env: { ...process.env },
		});

		// Timeout handler
		const timeout = setTimeout(() => {
			proc.kill("SIGTERM");
			resolve({
				stdout: "",
				stderr: "",
				exitCode: -1,
				error: `Agent timed out after ${timeoutMs}ms`,
			});
		}, timeoutMs);

		// Capture output
		const stdoutChunks: Uint8Array[] = [];
		const stderrChunks: Uint8Array[] = [];

		const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();

		// Read stdout
		(async () => {
			try {
				while (true) {
					const { done, value } = await stdoutReader.read();
					if (done) break;
					stdoutChunks.push(value);
				}
			} catch {
				// ignore
			}
		})();

		// Read stderr
		(async () => {
			try {
				while (true) {
					const { done, value } = await stderrReader.read();
					if (done) break;
					stderrChunks.push(value);
				}
			} catch {
				// ignore
			}
		})();

		// Wait for process exit
		proc.exited.then(exitCode => {
			clearTimeout(timeout);
			const stdout = this.#decodeChunks(stdoutChunks);
			const stderr = this.#decodeChunks(stderrChunks);
			resolve({ stdout, stderr, exitCode });
		});

		return promise;
	}

	#decodeChunks(chunks: Uint8Array[]): string {
		if (chunks.length === 0) return "";
		const total = chunks.reduce((sum, c) => sum + c.length, 0);
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		return new TextDecoder().decode(merged);
	}

	#extractText(msg: InboundMessage): string {
		if (msg.content.type === "text") return msg.content.text;
		if (msg.content.type === "markdown") return msg.content.markdown;
		if (msg.content.type === "voice" && msg.content.text) return msg.content.text;
		return "[non-text message]";
	}

	/**
	 * Strip ANSI escape codes from text.
	 * OMP output may contain color codes, progress indicators, etc.
	 */
	#stripAnsi(text: string): string {
		// eslint-disable-next-line no-control-regex
		return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	}
}
