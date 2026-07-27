import * as fs from "node:fs";
import * as module from "node:module";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { CommentCheckerHookInput } from "./core";

export type ProcessResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

export const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
export const PROCESS_TIMEOUT_MS = 30_000;

export type ProcessExecutor = (command: string, args: string[], stdin: string) => Promise<ProcessResult>;

export type RunCommentCheckerOptions = {
	binaryPath?: string;
	customPrompt?: string;
	resolveBinary?: () => string | undefined;
	executor?: ProcessExecutor;
};

export type CommentCheckerRunResult = {
	status: "pass" | "warning" | "error" | "missing";
	message: string;
	binaryPath?: string;
	exitCode?: number | null;
	stdout?: string;
	stderr?: string;
};

export async function runCommentChecker(
	input: CommentCheckerHookInput,
	options: RunCommentCheckerOptions = {},
): Promise<CommentCheckerRunResult> {
	const binaryPath =
		options.binaryPath ?? (options.resolveBinary ? options.resolveBinary() : resolveCommentCheckerBinary());
	if (!binaryPath) {
		return {
			status: "missing",
			message: "comment-checker binary not found. Install @code-yeongyu/comment-checker or reload the package.",
		};
	}

	const args = ["check"];
	if (options.customPrompt) {
		args.push("--prompt", options.customPrompt);
	}

	const executor = options.executor ?? spawnProcess;
	const result = await executor(binaryPath, args, JSON.stringify(input));
	const message = result.stderr || result.stdout;
	if (result.exitCode === 0) {
		return {
			status: "pass",
			message: "",
			binaryPath,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}
	if (result.exitCode === 2) {
		return {
			status: "warning",
			message,
			binaryPath,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}
	return {
		status: "error",
		message,
		binaryPath,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

export function resolveCommentCheckerBinary(): string | undefined {
	const binaryName = process.platform === "win32" ? "comment-checker.exe" : "comment-checker";
	const fromPackageApi = resolvePackageApiBinary();
	if (fromPackageApi) return fromPackageApi;
	const fromPackage = resolvePackageBinary(binaryName);
	if (fromPackage) return fromPackage;
	return $which("comment-checker") ?? undefined;
}

function resolvePackageApiBinary(): string | undefined {
	try {
		const require = module.createRequire(import.meta.url);
		const packageExports: unknown = require("@code-yeongyu/comment-checker");
		if (!isCommentCheckerPackage(packageExports)) return undefined;
		const binaryPath = packageExports.getBinaryPath();
		return fs.existsSync(binaryPath) ? binaryPath : undefined;
	} catch {
		return undefined;
	}
}

function resolvePackageBinary(binaryName: string): string | undefined {
	try {
		const require = module.createRequire(import.meta.url);
		const packagePath = require.resolve("@code-yeongyu/comment-checker/package.json");
		const baseDir = path.dirname(packagePath);
		const candidates =
			process.platform === "win32"
				? [
						path.join(baseDir, "bin", "comment-checker.exe"),
						path.join(baseDir, "bin", "comment-checker.cmd"),
						path.join(baseDir, "bin", "comment-checker"),
					]
				: [path.join(baseDir, "bin", binaryName)];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) return candidate;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function isCommentCheckerPackage(value: unknown): value is { getBinaryPath: () => string } {
	if (typeof value !== "object" || value === null) return false;
	return typeof Object.getOwnPropertyDescriptor(value, "getBinaryPath")?.value === "function";
}

interface OutputAccumulator {
	text: string;
	bytes: number;
	truncated: boolean;
}

function appendOutput(output: OutputAccumulator, chunk: string, maxOutputBytes: number): void {
	if (output.truncated) return;

	const remainingBytes = maxOutputBytes - output.bytes;
	const chunkBytes = Buffer.byteLength(chunk, "utf8");
	if (chunkBytes <= remainingBytes) {
		output.text += chunk;
		output.bytes += chunkBytes;
		return;
	}

	if (remainingBytes > 0) {
		const prefix = truncateUtf8Prefix(chunk, remainingBytes);
		output.text += prefix;
		output.bytes += Buffer.byteLength(prefix, "utf8");
	}
	output.truncated = true;
}

function truncateUtf8Prefix(text: string, maxBytes: number): string {
	let bytes = 0;
	let endIndex = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		endIndex += character.length;
	}
	return text.slice(0, endIndex);
}

function formatOutput(output: OutputAccumulator, streamName: "stdout" | "stderr", maxOutputBytes: number): string {
	if (!output.truncated) return output.text;
	return `${output.text}\n[${streamName} truncated after ${maxOutputBytes} bytes]`;
}

export async function spawnProcess(
	command: string,
	args: string[],
	stdin: string,
	maxOutputBytes: number = MAX_PROCESS_OUTPUT_BYTES,
	processTimeoutMs: number = PROCESS_TIMEOUT_MS,
): Promise<ProcessResult> {
	const outputByteLimit = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0 ? Math.floor(maxOutputBytes) : 0;
	const timeoutLimit = Number.isFinite(processTimeoutMs) && processTimeoutMs > 0 ? Math.floor(processTimeoutMs) : 0;

	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn([command, ...args], {
			stdin: Buffer.from(stdin, "utf-8"),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		return {
			exitCode: null,
			stdout: "",
			stderr: errorMessage,
		};
	}

	let timedOut = false;
	let killTimer: Timer | undefined;

	const timeoutTimer: Timer | undefined =
		timeoutLimit > 0
			? setTimeout(() => {
					timedOut = true;
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => {
						proc.kill("SIGKILL");
					}, 1_000);
					killTimer.unref?.();
				}, timeoutLimit)
			: undefined;
	timeoutTimer?.unref?.();

	const readStream = async (stream: ReadableStream<Uint8Array> | null, name: "stdout" | "stderr"): Promise<string> => {
		if (!stream) return "";
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const output: OutputAccumulator = { text: "", bytes: 0, truncated: false };
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				appendOutput(output, decoder.decode(value, { stream: true }), outputByteLimit);
			}
		}
		appendOutput(output, decoder.decode(), outputByteLimit);
		return formatOutput(output, name, outputByteLimit);
	};

	const [stdoutText, stderrText, exitCode] = await Promise.all([
		readStream(proc.stdout as ReadableStream<Uint8Array> | null, "stdout"),
		readStream(proc.stderr as ReadableStream<Uint8Array> | null, "stderr"),
		proc.exited,
	]);

	if (timeoutTimer) clearTimeout(timeoutTimer);
	if (killTimer) clearTimeout(killTimer);

	let finalStderr = stderrText;
	if (timedOut) {
		const timeoutMsg = `comment-checker process timed out after ${timeoutLimit} ms`;
		finalStderr = finalStderr ? `${finalStderr}\n${timeoutMsg}` : timeoutMsg;
	}

	return {
		exitCode: timedOut ? null : exitCode,
		stdout: stdoutText,
		stderr: finalStderr,
	};
}
