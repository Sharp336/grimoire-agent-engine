import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { getActiveProfile, getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { getPromptGateDirectory, PROMPT_GATE_CAPABILITY, PROMPT_GATE_PROTOCOL_VERSION } from "./capability";

const MAXIMUM_CONFIG_BYTES = 64 * 1024;
const MAXIMUM_FRAME_BYTES = 1024 * 1024;
const MAXIMUM_STAGED_REPLACEMENTS = 8;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;

type GateProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface PromptGateConfig {
	filePath: string;
	integrationId: string;
	command: string[];
	commandSha256: string;
	firstDecisionTimeoutMs: number;
}

interface GateFrame {
	version: number;
	event: string;
	integration_id: string;
	decision?: string;
	reason?: string;
	text?: string;
	delivery_token?: string;
}

interface ByteReadResult {
	done: boolean;
	value?: Uint8Array;
}

interface ByteStreamReader {
	read(): Promise<ByteReadResult>;
}

type GateDecision =
	| { decision: "allow" }
	| { decision: "stage"; text: string; deliveryToken: string; proc: GateProcess };

export interface PromptGateDelivery {
	acknowledge(): Promise<void>;
	cancel(): Promise<void>;
}

export interface PromptGateEvaluation {
	text: string;
	delivery?: PromptGateDelivery;
}

export interface PromptGateRequest {
	text: string;
	images?: unknown[];
	sessionId: string;
	cwd: string;
	source: string;
	profile?: string;
	gateDirectory?: string;
}

export class PromptGateBlockedError extends Error {
	constructor(message: string) {
		super(`Prompt gate blocked this prompt: ${message}`);
		this.name = "PromptGateBlockedError";
	}
}

class JsonLineReader {
	readonly #reader: ByteStreamReader;
	readonly #decoder = new TextDecoder();
	#buffer = "";

	constructor(stream: GateProcess["stdout"]) {
		this.#reader = stream.getReader();
	}

	async read(timeoutMs?: number): Promise<string | undefined> {
		const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
		while (true) {
			const newline = this.#buffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
				this.#buffer = this.#buffer.slice(newline + 1);
				return line;
			}
			if (this.#buffer.length > MAXIMUM_FRAME_BYTES) {
				throw new Error(`gate output exceeded ${MAXIMUM_FRAME_BYTES} bytes without a newline`);
			}

			const chunk =
				deadline === undefined
					? await this.#readChunk()
					: await this.#readChunk(Math.max(0, deadline - Date.now()), timeoutMs);
			if (chunk.value !== undefined) {
				this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
			}
			if (chunk.done) {
				this.#buffer += this.#decoder.decode();
				if (this.#buffer.length === 0) return undefined;
				const line = this.#buffer.replace(/\r$/, "");
				this.#buffer = "";
				return line;
			}
		}
	}

	async #readChunk(timeoutMs?: number, timeoutLabelMs = timeoutMs): Promise<ByteReadResult> {
		if (timeoutMs === undefined) return this.#reader.read();
		const { promise: timeout, reject } = Promise.withResolvers<never>();
		const timer = setTimeout(() => reject(new Error(`no decision within ${timeoutLabelMs} ms`)), timeoutMs);
		try {
			return await Promise.race([this.#reader.read(), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseConfig(filePath: string, value: unknown): PromptGateConfig {
	const record = asRecord(value);
	if (!record) throw new Error("configuration must be a JSON object");
	const command =
		Array.isArray(record.command) && record.command.every(item => typeof item === "string")
			? record.command
			: undefined;
	if (
		record.version !== PROMPT_GATE_PROTOCOL_VERSION ||
		record.event !== PROMPT_GATE_CAPABILITY ||
		typeof record.integration_id !== "string" ||
		record.integration_id.length === 0 ||
		!command ||
		command.length === 0 ||
		command.some(part => part.length === 0) ||
		typeof record.command_sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(record.command_sha256) ||
		!Number.isSafeInteger(record.first_decision_timeout_ms) ||
		(record.first_decision_timeout_ms as number) <= 0 ||
		record.on_error !== "block"
	) {
		throw new Error("configuration does not satisfy prompt-gate-v1");
	}
	return {
		filePath,
		integrationId: record.integration_id,
		command,
		commandSha256: record.command_sha256,
		firstDecisionTimeoutMs: record.first_decision_timeout_ms as number,
	};
}

async function loadGateConfigs(directory: string): Promise<PromptGateConfig[]> {
	const directoryStat = await lstat(directory).catch(error => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (directoryStat === undefined) return [];
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		throw new Error("gate path is not a regular directory");
	}

	const names = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
	const configs: PromptGateConfig[] = [];
	const integrationIds = new Set<string>();
	for (const name of names) {
		const filePath = path.join(directory, name);
		const stat = await lstat(filePath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
		if (stat.size > MAXIMUM_CONFIG_BYTES) throw new Error(`${name} exceeds ${MAXIMUM_CONFIG_BYTES} bytes`);
		const bytes = await readFile(filePath, "utf8");
		let decoded: unknown;
		try {
			decoded = JSON.parse(bytes);
		} catch {
			throw new Error(`${name} is not valid JSON`);
		}
		const config = parseConfig(filePath, decoded);
		if (integrationIds.has(config.integrationId)) {
			throw new Error(`${name} repeats integration_id ${config.integrationId}`);
		}
		integrationIds.add(config.integrationId);
		configs.push(config);
	}
	return configs;
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(filePath);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	stream.on("data", chunk => hash.update(chunk));
	stream.on("error", reject);
	stream.on("end", resolve);
	await promise;
	return hash.digest("hex");
}

async function verifyCommand(config: PromptGateConfig): Promise<void> {
	const executable = config.command[0];
	if (!path.isAbsolute(executable)) throw new Error("gate command executable must be absolute");
	const stat = await lstat(executable);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("gate command executable must be a regular file");
	if (process.platform !== "win32" && (stat.mode & 0o111) === 0) throw new Error("gate command is not executable");
	if ((await sha256File(executable)) !== config.commandSha256) throw new Error("gate command digest does not match");
}

function parseFrame(line: string, config: PromptGateConfig): GateFrame {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		throw new Error("gate returned malformed JSON");
	}
	const frame = asRecord(decoded);
	if (
		!frame ||
		frame.version !== PROMPT_GATE_PROTOCOL_VERSION ||
		frame.integration_id !== config.integrationId ||
		typeof frame.event !== "string"
	) {
		throw new Error("gate returned a frame for a different protocol or integration");
	}
	return frame as unknown as GateFrame;
}

async function waitForExit(proc: GateProcess): Promise<number> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => reject(new Error("gate process did not exit after delivery")),
		PROCESS_EXIT_TIMEOUT_MS,
	);
	try {
		return await Promise.race([proc.exited, timeout]);
	} catch (error) {
		proc.kill();
		await proc.exited;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function stopProcess(proc: GateProcess): Promise<void> {
	try {
		await proc.stdin.end();
	} catch {}
	if ((await waitForExit(proc)) !== 0) throw new Error("gate process exited unsuccessfully");
}

async function evaluateGate(
	config: PromptGateConfig,
	request: Omit<PromptGateRequest, "gateDirectory">,
): Promise<GateDecision> {
	await verifyCommand(config);
	const proc = Bun.spawn(config.command, {
		cwd: request.cwd,
		env: process.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderrReader = proc.stderr.getReader();
	void (async () => {
		while (!(await stderrReader.read()).done) {}
	})().catch(() => {});
	const reader = new JsonLineReader(proc.stdout);
	const input = {
		version: PROMPT_GATE_PROTOCOL_VERSION,
		event: PROMPT_GATE_CAPABILITY,
		integration_id: config.integrationId,
		text: request.text,
		images: request.images?.map(() => ({})) ?? [],
		session_id: request.sessionId,
		cwd: request.cwd,
		profile: request.profile ?? getActiveProfile() ?? "default",
		source: request.source,
	};
	try {
		proc.stdin.write(`${JSON.stringify(input)}\n`);
		await proc.stdin.flush();

		const firstLine = await reader.read(config.firstDecisionTimeoutMs);
		if (firstLine === undefined) throw new Error("gate exited without a decision");
		const first = parseFrame(firstLine, config);
		if (first.event !== PROMPT_GATE_CAPABILITY || (first.decision !== "allow" && first.decision !== "block")) {
			throw new Error("gate returned an invalid first decision");
		}
		if (first.decision === "allow") {
			await stopProcess(proc);
			return { decision: "allow" };
		}

		const stagedLine = await reader.read();
		if (stagedLine === undefined) {
			const exitCode = await proc.exited;
			throw new Error(
				typeof first.reason === "string" && first.reason.length > 0
					? first.reason
					: `gate blocked the prompt and exited with status ${exitCode}`,
			);
		}
		const staged = parseFrame(stagedLine, config);
		if (staged.event === PROMPT_GATE_CAPABILITY && staged.decision === "block") {
			throw new Error(
				typeof staged.reason === "string" && staged.reason.length > 0
					? staged.reason
					: "gate could not review the prompt",
			);
		}
		if (
			staged.event !== "stage_approved" ||
			typeof staged.text !== "string" ||
			staged.text.trim().length === 0 ||
			typeof staged.delivery_token !== "string" ||
			staged.delivery_token.length === 0
		) {
			throw new Error("gate returned an invalid staged approval");
		}
		return { decision: "stage", text: staged.text, deliveryToken: staged.delivery_token, proc };
	} catch (error) {
		if (proc.exitCode === null) proc.kill();
		await proc.exited;
		throw error;
	}
}

async function evaluateWithConfigs(
	configs: PromptGateConfig[],
	request: Omit<PromptGateRequest, "gateDirectory">,
	stagedTokens: Set<string>,
): Promise<PromptGateEvaluation> {
	for (const config of configs) {
		let result: GateDecision;
		try {
			result = await evaluateGate(config, request);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new PromptGateBlockedError(`${path.basename(config.filePath)}: ${detail}`);
		}
		if (result.decision === "allow") continue;
		if (stagedTokens.size >= MAXIMUM_STAGED_REPLACEMENTS || stagedTokens.has(result.deliveryToken)) {
			result.proc.kill();
			await result.proc.exited;
			throw new PromptGateBlockedError("staged approval cycle exceeded the delivery limit");
		}

		const nextTokens = new Set(stagedTokens).add(result.deliveryToken);
		let replacement: PromptGateEvaluation;
		try {
			replacement = await evaluateWithConfigs(configs, { ...request, text: result.text }, nextTokens);
		} catch (error) {
			result.proc.kill();
			await result.proc.exited;
			throw error;
		}
		let settlement: Promise<void> | undefined;
		const cancel = async (): Promise<void> => {
			await replacement.delivery?.cancel();
			if (result.proc.exitCode === null) result.proc.kill();
			await result.proc.exited;
		};
		return {
			text: replacement.text,
			delivery: {
				acknowledge: () => {
					settlement ??= (async () => {
						try {
							await replacement.delivery?.acknowledge();
							const frame = {
								version: PROMPT_GATE_PROTOCOL_VERSION,
								event: "stage_delivery",
								integration_id: config.integrationId,
								delivery_token: result.deliveryToken,
								status: "delivered",
							};
							result.proc.stdin.write(`${JSON.stringify(frame)}\n`);
							await result.proc.stdin.flush();
							await stopProcess(result.proc);
						} catch (error) {
							await cancel();
							throw error;
						}
					})();
					return settlement;
				},
				cancel: () => {
					settlement ??= cancel();
					return settlement;
				},
			},
		};
	}
	return { text: request.text };
}

export async function runPromptGates(request: PromptGateRequest): Promise<PromptGateEvaluation> {
	const gateDirectory = request.gateDirectory ?? getPromptGateDirectory(getAgentDir());
	let configs: PromptGateConfig[];
	try {
		configs = await loadGateConfigs(gateDirectory);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new PromptGateBlockedError(detail);
	}
	return evaluateWithConfigs(configs, request, new Set());
}
