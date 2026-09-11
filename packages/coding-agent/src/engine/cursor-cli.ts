import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ContentBlock, PromptResponse, ToolKind } from "@oh-my-pi/pi-utils/acp";
import type { CursorAcpOptions } from "./cursor-acp";
import hookSource from "./cursor-hook.txt" with { type: "text" };
import type { CursorSession } from "./cursor-turn";

export interface CursorCliOptions extends CursorAcpOptions {
	/** Exact verified owner-local CLI, never read from a hosted Artifact. */
	command: readonly [string, ...string[]];
	modelId: string;
	/** Own immutable-per-launch plugin directory, outside user repositories. */
	pluginDirectory: string;
	hookNode: string;
}

/** Official headless CLI: ACP currently bypasses local hooks on Windows. */
export class CursorCliSession implements CursorSession {
	#sessionId?: string;
	#child?: ChildProcessWithoutNullStreams;
	#server?: Bun.Server<undefined>;
	#closed = false;
	#ready = false;
	#secret = randomUUID();
	#signal?: AbortSignal;
	#seenHooks = new Set<string>();
	#stopping = false;

	constructor(readonly options: CursorCliOptions) {
		this.#sessionId = options.sessionId;
	}

	async initialize(): Promise<void> {
		if (this.#closed || this.#ready) throw new Error("Cursor runtime is not initializable");
		if (process.platform !== "win32")
			throw new Error("Cursor hook integration is currently verified only on Windows");
		if (!this.#sessionId) {
			const lines: string[] = [];
			await this.#run(["create-chat"], line => lines.push(line));
			const id = lines.join("").trim();
			if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Cursor did not create an exact session identity");
			this.#sessionId = id;
			await this.options.onSession(id);
		}
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			maxRequestBodySize: 4 * 1024 * 1024,
			fetch: request => this.#permission(request),
		});
		const root = this.options.pluginDirectory;
		await fs.mkdir(path.join(root, ".cursor-plugin"), { recursive: true });
		await fs.mkdir(path.join(root, "hooks"), { recursive: true });
		const script = path.join(root, "hook.cjs");
		await fs.writeFile(script, hookSource, { flag: "wx" });
		await fs.writeFile(
			path.join(root, "connection.json"),
			JSON.stringify({ url: `http://127.0.0.1:${this.#server.port}/`, token: this.#secret }),
			{ flag: "wx", mode: 0o600 },
		);
		const command = [this.options.hookNode, script].map(quotePowerShell).join(" ");
		await fs.writeFile(
			path.join(root, ".cursor-plugin", "plugin.json"),
			JSON.stringify({ name: "artel-runtime-permissions", version: "1.0.0", hooks: "./hooks/hooks.json" }),
			{ flag: "wx" },
		);
		await fs.writeFile(
			path.join(root, "hooks", "hooks.json"),
			JSON.stringify({
				version: 1,
				hooks: {
					preToolUse: [{ command, failClosed: true, timeout: 120 }],
				},
			}),
			{ flag: "wx" },
		);
		this.#ready = true;
	}

	async #permission(request: Request): Promise<Response> {
		const deny = () => Response.json({ permission: "deny", agent_message: "Artel did not authorize this tool." });
		if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${this.#secret}`)
			return new Response(null, { status: 403 });
		if (this.#closed || !this.#signal || this.#signal.aborted) return deny();
		try {
			const event = (await request.json()) as Record<string, unknown>;
			if (
				event.hook_event_name !== "preToolUse" ||
				event.conversation_id !== this.#sessionId ||
				typeof event.tool_use_id !== "string" ||
				typeof event.tool_name !== "string"
			)
				return deny();
			// Cursor's own subagents are not Engine-managed children. Never bypass Engine spawn limits.
			if (toolKind(event.tool_name) === "other" || this.#seenHooks.has(event.tool_use_id)) return deny();
			this.#seenHooks.add(event.tool_use_id);
			const outcome = await this.options.onPermission({
				sessionId: this.#sessionId!,
				toolCall: {
					toolCallId: event.tool_use_id,
					title: event.tool_name,
					kind: toolKind(event.tool_name),
					rawInput: event.tool_input,
				},
				options: [{ kind: "allow_once", name: "Allow once", optionId: "allow" }],
			});
			return outcome.outcome.outcome === "selected" &&
				outcome.outcome.optionId === "allow" &&
				!this.#closed &&
				!this.#signal.aborted
				? Response.json({ permission: "allow" })
				: deny();
		} catch {
			return deny();
		}
	}

	async prompt(content: ContentBlock[], signal = new AbortController().signal): Promise<PromptResponse> {
		if (!this.#ready || !this.#sessionId || this.#signal || this.#closed)
			throw new Error("Cursor is not ready for this prompt");
		signal.throwIfAborted();
		if (content.some(block => block.type !== "text"))
			throw new Error("Cursor CLI currently requires file references for non-text attachments");
		this.#signal = signal;
		let result: PromptResponse | undefined;
		const text = content.map(block => (block.type === "text" ? block.text : "")).join("\n\n");
		const cancel = () => this.#stop();
		signal.addEventListener("abort", cancel, { once: true });
		try {
			await this.#run(
				[
					"--model",
					this.options.modelId,
					"--resume",
					this.#sessionId,
					"--plugin-dir",
					this.options.pluginDirectory,
					"--print",
					"--output-format",
					"stream-json",
					"--stream-partial-output",
					text,
				],
				line => {
					const event = JSON.parse(line) as Record<string, unknown>;
					if (event.session_id && event.session_id !== this.#sessionId)
						throw new Error("Cursor changed session identity");
					if (event.type === "thinking" && event.subtype === "delta" && typeof event.text === "string")
						this.#text(event.text, true);
					if (event.type === "assistant" && event.timestamp_ms && !event.model_call_id) {
						const message = record(event.message);
						if (Array.isArray(message.content))
							for (const block of message.content) {
								const item = record(block);
								if (item.type === "text" && typeof item.text === "string") this.#text(item.text, false);
							}
					}
					if (event.type === "tool_call") this.#tool(event);
					if (event.type === "result") {
						if (event.is_error === true || event.subtype !== "success")
							throw new Error("Cursor reported an unsuccessful turn");
						const usage = record(event.usage);
						result = {
							stopReason: "end_turn",
							...(typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number"
								? {
										usage: {
											inputTokens: usage.inputTokens,
											outputTokens: usage.outputTokens,
											totalTokens: usage.inputTokens + usage.outputTokens,
											cachedReadTokens:
												typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0,
											cachedWriteTokens:
												typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0,
										},
									}
								: {}),
						};
					}
				},
			);
			if (!result) throw new Error("Cursor closed without a completed turn; no retry was made");
			return result;
		} catch (error) {
			if (signal.aborted) return { stopReason: "cancelled" };
			throw error;
		} finally {
			signal.removeEventListener("abort", cancel);
			this.#signal = undefined;
		}
	}

	#text(text: string, thinking: boolean): void {
		this.options.onUpdate(
			{
				sessionId: this.#sessionId!,
				update: {
					sessionUpdate: thinking ? "agent_thought_chunk" : "agent_message_chunk",
					content: { type: "text", text },
				},
			},
			false,
		);
	}

	#tool(event: Record<string, unknown>): void {
		const outer = record(event.tool_call);
		const name = Object.keys(outer).find(key => key.endsWith("ToolCall"));
		if (!name || typeof event.call_id !== "string") throw new Error("Cursor tool event has no usable identity");
		const tool = record(outer[name]);
		const completed = event.subtype === "completed";
		const result = record(tool.result);
		this.options.onUpdate(
			{
				sessionId: this.#sessionId!,
				update: {
					sessionUpdate: completed ? "tool_call_update" : "tool_call",
					toolCallId: event.call_id,
					title: name,
					kind: toolKind(name),
					status: completed ? (result.error ? "failed" : "completed") : "pending",
					rawInput: tool.args,
					rawOutput: completed ? result : undefined,
				},
			},
			false,
		);
	}

	async #run(args: string[], consume: (line: string) => void): Promise<void> {
		if (this.#child || this.#closed) throw new Error("Cursor runtime is already busy or closed");
		const env = { ...process.env };
		delete env.CURSOR_API_KEY;
		delete env.CURSOR_AUTH_TOKEN;
		const child = spawn(this.options.command[0], [...this.options.command.slice(1), ...args], {
			cwd: this.options.cwd,
			env,
			windowsHide: true,
			stdio: "pipe",
		});
		this.#child = child;
		this.#stopping = false;
		child.stderr.resume();
		child.stdin.end();
		const done = Promise.withResolvers<number | null>();
		child.once("error", () => done.reject(new Error("Cursor CLI launch failed")));
		child.once("close", code => done.resolve(code));
		void done.promise.catch(() => {});
		const timer = setTimeout(() => this.#stop(), this.options.requestTimeoutMs ?? 120000);
		try {
			for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
				if (line.length > 8 * 1024 * 1024) throw new Error("Cursor output frame is too large");
				if (line.trim()) consume(line);
			}
			if ((await done.promise) !== 0) throw new Error("Cursor CLI stopped unexpectedly");
		} catch (error) {
			this.#stop();
			await done.promise.catch(() => {});
			throw error;
		} finally {
			clearTimeout(timer);
			if (this.#child === child) this.#child = undefined;
		}
	}

	#stop(): void {
		const child = this.#child;
		if (!child || child.exitCode !== null || !child.pid || this.#stopping) return;
		this.#stopping = true;
		if (process.platform === "win32") {
			const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				windowsHide: true,
				stdio: "ignore",
			});
			killer.on("error", () => child.kill());
		} else child.kill();
	}
	dispose(): void {
		this.#closed = true;
		this.#stop();
		this.#server?.stop(true);
	}
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function toolKind(name: string): ToolKind {
	// Unknown/MCP/subagent tools need an explicit Engine mapping, never a substring match.
	const key = name.toLowerCase().replace(/toolcall$/, "");
	const kinds: Record<string, ToolKind> = {
		read: "read",
		write: "edit",
		edit: "edit",
		strreplace: "edit",
		shell: "execute",
		grep: "search",
		glob: "search",
		ls: "read",
		webfetch: "fetch",
		websearch: "search",
	};
	return kinds[key] ?? "other";
}
function quotePowerShell(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
