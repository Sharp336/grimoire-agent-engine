import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { LRUCache } from "lru-cache/raw";

type SpawnOptions = {
	stdin: "pipe";
	stdout: "pipe";
	stderr: "pipe";
};

type FormatterProcessStdin = {
	write(chunk: string | Uint8Array): number | Promise<number>;
	end(chunk?: string | Uint8Array): void | Promise<void>;
	flush?: () => void;
};

type FormatterProcess = {
	readonly stdin: FormatterProcessStdin | null;
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number | null>;
	exitCode: number | null;
	kill: (signal?: Parameters<Bun.Subprocess["kill"]>[0]) => void;
};

type CachedExecutable = { readonly kind: "found"; readonly path: string } | { readonly kind: "missing" };

export type SourceFormatter = (
	toolName: string,
	args: unknown,
	signal: AbortSignal,
) => Promise<Record<string, unknown> | undefined>;

export interface SourceFormatterRuntime {
	which: (name: string) => string | undefined;
	spawn: (command: readonly string[], options: SpawnOptions) => FormatterProcess;
}

export interface SourceFormatterOptions {
	maxInputBytes?: number;
	timeoutMs?: number;
	maxOutputBytes?: number;
	executableCacheSize?: number;
	formattedCacheSize?: number;
	terminateGraceMs?: number;
}

export interface SourceFormatterFactoryConfig {
	runtime?: Partial<SourceFormatterRuntime>;
	options?: SourceFormatterOptions;
}

interface NormalizedSourceFormatterOptions {
	readonly maxInputBytes: number;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
	readonly executableCacheSize: number;
	readonly formattedCacheSize: number;
	readonly terminateGraceMs: number;
}

interface StreamCapture {
	readonly text: string;
	readonly overflowed: boolean;
}

interface FormatterCommand {
	readonly field: "code" | "command" | "content";
	readonly binary: "prettier" | "ruff" | "rustfmt" | "gofmt" | "shfmt";
	readonly args: readonly string[];
	readonly source: string;
}

const PRETTIER_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".json"]);
const PY_EXTS = new Set([".py"]);
const RUST_EXTS = new Set([".rs"]);
const GO_EXTS = new Set([".go"]);
const SHELL_EXTS = new Set([".sh", ".bash", ".zsh", ".ksh", ".csh", ".tcsh", ".fish"]);
const RAW_EXTS = new Set([".md", ".markdown", ".yml", ".yaml", ".css", ".html", ".htm"]);

const DEFAULT_OPTIONS: NormalizedSourceFormatterOptions = {
	maxInputBytes: 256 * 1024,
	timeoutMs: 500,
	maxOutputBytes: 1 * 1024 * 1024,
	executableCacheSize: 64,
	formattedCacheSize: 256,
	terminateGraceMs: 40,
};

const FALLBACK_PY_FILE = "tool-call.py";
const FALLBACK_JS_FILE = "tool-call.js";
const MISSING_EXECUTABLE: CachedExecutable = { kind: "missing" };

const defaultRuntime: SourceFormatterRuntime = {
	which: name => $which(name) ?? undefined,
	spawn: (command, options) => Bun.spawn([...command], options) as unknown as FormatterProcess,
};

const textEncoder = new TextEncoder();

function normalizeOptions(options: SourceFormatterOptions | undefined): NormalizedSourceFormatterOptions {
	return {
		maxInputBytes: options?.maxInputBytes ?? DEFAULT_OPTIONS.maxInputBytes,
		timeoutMs: options?.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
		maxOutputBytes: options?.maxOutputBytes ?? DEFAULT_OPTIONS.maxOutputBytes,
		executableCacheSize: options?.executableCacheSize ?? DEFAULT_OPTIONS.executableCacheSize,
		formattedCacheSize: options?.formattedCacheSize ?? DEFAULT_OPTIONS.formattedCacheSize,
		terminateGraceMs: options?.terminateGraceMs ?? DEFAULT_OPTIONS.terminateGraceMs,
	};
}

function toRecord(args: unknown): Record<string, unknown> | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	return args as Record<string, unknown>;
}

function buildCacheKey(executable: string, argv: readonly string[], source: string): string {
	return JSON.stringify([executable, argv, Bun.hash(source).toString(16)]);
}

function readBounded(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	signal: AbortSignal,
): Promise<StreamCapture> {
	if (!stream || maxBytes <= 0) {
		return Promise.resolve({ text: "", overflowed: false });
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let remaining = maxBytes;
	let overflowed = false;
	const chunks: string[] = [];

	const onAbort = (): void => {
		void reader.cancel();
	};

	if (signal.aborted) {
		onAbort();
	} else {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	return (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				if (remaining <= 0) {
					overflowed = true;
					await reader.cancel();
					break;
				}

				if (value.length <= remaining) {
					chunks.push(decoder.decode(value, { stream: true }));
					remaining -= value.length;
					continue;
				}

				chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
				overflowed = true;
				await reader.cancel();
				break;
			}

			chunks.push(decoder.decode());
			return { text: chunks.join(""), overflowed };
		} catch {
			return { text: chunks.join(""), overflowed: true };
		} finally {
			signal.removeEventListener("abort", onAbort);
			reader.releaseLock();
		}
	})();
}

function inferEvalFormatter(argsRecord: Record<string, unknown>): FormatterCommand | undefined {
	const source = typeof argsRecord.code === "string" ? argsRecord.code : undefined;
	if (!source) return undefined;

	const languageValue = typeof argsRecord.language === "string" ? argsRecord.language.trim().toLowerCase() : "";

	switch (languageValue) {
		case "py":
		case "python":
			return {
				field: "code",
				binary: "ruff",
				args: ["format", "--stdin-filename", FALLBACK_PY_FILE, "-"],
				source,
			};
		case "js":
		case "javascript":
			return {
				field: "code",
				binary: "prettier",
				args: ["--no-config", "--stdin-filepath", FALLBACK_JS_FILE],
				source,
			};
		default:
			return undefined;
	}
}

function inferBashFormatter(argsRecord: Record<string, unknown>): FormatterCommand | undefined {
	const source = typeof argsRecord.command === "string" ? argsRecord.command : undefined;
	if (!source) return undefined;

	return {
		field: "command",
		binary: "shfmt",
		args: [],
		source,
	};
}

function inferWriteFormatter(argsRecord: Record<string, unknown>): FormatterCommand | undefined {
	const source = typeof argsRecord.content === "string" ? argsRecord.content : undefined;
	if (!source) return undefined;

	const writePath =
		typeof argsRecord.path === "string"
			? argsRecord.path
			: typeof argsRecord.file_path === "string"
				? argsRecord.file_path
				: "";
	if (!writePath) return undefined;

	const extension = path.extname(writePath).toLowerCase();
	if (RAW_EXTS.has(extension)) return undefined;

	if (PRETTIER_EXTS.has(extension)) {
		return {
			field: "content",
			binary: "prettier",
			args: ["--no-config", "--stdin-filepath", writePath],
			source,
		};
	}

	if (PY_EXTS.has(extension)) {
		return {
			field: "content",
			binary: "ruff",
			args: ["format", "--stdin-filename", writePath, "-"],
			source,
		};
	}

	if (RUST_EXTS.has(extension)) {
		return {
			field: "content",
			binary: "rustfmt",
			args: ["--emit", "stdout"],
			source,
		};
	}

	if (GO_EXTS.has(extension)) {
		return {
			field: "content",
			binary: "gofmt",
			args: [],
			source,
		};
	}

	if (SHELL_EXTS.has(extension)) {
		return {
			field: "content",
			binary: "shfmt",
			args: [],
			source,
		};
	}

	return undefined;
}

function createFormatterCommand(toolName: string, argsRecord: Record<string, unknown>): FormatterCommand | undefined {
	switch (toolName.toLowerCase()) {
		case "eval":
			return inferEvalFormatter(argsRecord);
		case "bash":
			return inferBashFormatter(argsRecord);
		case "write":
			return inferWriteFormatter(argsRecord);
		default:
			return undefined;
	}
}

type ProcessCompletion = { kind: "exit"; exitCode: number | null } | { kind: "aborted" };

async function waitForProcessExitOrAbort(child: FormatterProcess, signal: AbortSignal): Promise<ProcessCompletion> {
	const { promise, resolve } = Promise.withResolvers<ProcessCompletion>();
	const settleAborted = (): void => resolve({ kind: "aborted" });

	if (signal.aborted) {
		settleAborted();
		return promise;
	}

	const settleExited = (code?: number | null): void => {
		signal.removeEventListener("abort", settleAborted);
		resolve({ kind: "exit", exitCode: code ?? null });
	};

	signal.addEventListener("abort", settleAborted, { once: true });
	void child.exited.then(settleExited, () => settleExited());

	return promise;
}

async function waitForProcessExit(child: FormatterProcess, graceMs: number): Promise<boolean> {
	if (child.exitCode !== null) return true;
	if (graceMs <= 0) return false;

	return await Promise.race<boolean>([
		child.exited.then(
			() => true,
			() => true,
		),
		Bun.sleep(graceMs).then(() => false),
	]);
}

async function terminateSubprocess(child: FormatterProcess, graceMs: number): Promise<void> {
	if (child.exitCode !== null) return;

	try {
		child.kill("SIGTERM");
	} catch {
		return;
	}

	if (await waitForProcessExit(child, graceMs)) return;

	try {
		child.kill("SIGKILL");
	} catch {
		return;
	}

	await child.exited.catch(() => {});
}

async function runFormatter(
	runtime: SourceFormatterRuntime,
	executable: string,
	formatter: FormatterCommand,
	signal: AbortSignal,
	options: NormalizedSourceFormatterOptions,
): Promise<string | undefined> {
	const child = runtime.spawn([executable, ...formatter.args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const outputController = new AbortController();

	try {
		const stdoutStream = child.stdout;
		const stderrStream = child.stderr;
		if (!child.stdin || !stdoutStream || !stderrStream) {
			await terminateSubprocess(child, options.terminateGraceMs);
			return undefined;
		}

		const stdoutPromise = readBounded(stdoutStream, options.maxOutputBytes, outputController.signal);
		const stderrPromise = readBounded(stderrStream, options.maxOutputBytes, outputController.signal);

		const sourceBytes = textEncoder.encode(formatter.source);
		const written = child.stdin.write(sourceBytes);
		if (written instanceof Promise) {
			await written;
		}
		const ended = child.stdin.end();
		if (ended instanceof Promise) {
			await ended;
		}

		const completion = await Promise.race<ProcessCompletion>([
			waitForProcessExitOrAbort(child, signal),
			Bun.sleep(options.timeoutMs).then(() => ({ kind: "aborted" }) as const),
		]);

		if (completion.kind !== "exit") {
			outputController.abort();
			await terminateSubprocess(child, options.terminateGraceMs);
			await Promise.allSettled([stdoutPromise, stderrPromise]);
			return undefined;
		}

		if (completion.exitCode !== 0) {
			await terminateSubprocess(child, options.terminateGraceMs);
			await Promise.allSettled([stdoutPromise, stderrPromise]);
			return undefined;
		}

		const [stdout, stderr] = await Promise.allSettled([stdoutPromise, stderrPromise]);
		if (stdout.status !== "fulfilled" || stderr.status !== "fulfilled") return undefined;
		if (stdout.value.overflowed || stderr.value.overflowed) return undefined;
		if (stdout.value.text.length === 0) return undefined;

		return stdout.value.text;
	} catch {
		await terminateSubprocess(child, options.terminateGraceMs);
		return undefined;
	} finally {
		outputController.abort();
	}
}

export function createSourceFormatter({ runtime, options }: SourceFormatterFactoryConfig = {}): SourceFormatter {
	const mergedRuntime: SourceFormatterRuntime = {
		which: runtime?.which ?? defaultRuntime.which,
		spawn: runtime?.spawn ?? defaultRuntime.spawn,
	};
	const normalized = normalizeOptions(options);
	const executableCache = new LRUCache<string, CachedExecutable>({ max: normalized.executableCacheSize });
	const formattedCache = new LRUCache<string, string>({ max: normalized.formattedCacheSize });

	const resolveExecutable = (name: string): string | undefined => {
		const cached = executableCache.get(name);
		if (cached !== undefined) {
			if (cached.kind === "missing") return undefined;
			return cached.path;
		}

		let resolved: string | undefined;
		try {
			resolved = mergedRuntime.which(name);
		} catch {
			resolved = undefined;
		}

		executableCache.set(name, resolved ? { kind: "found", path: resolved } : MISSING_EXECUTABLE);
		return resolved;
	};

	return async (toolName, args, signal): Promise<Record<string, unknown> | undefined> => {
		if (signal.aborted) return undefined;

		const argsRecord = toRecord(args);
		if (!argsRecord) return undefined;

		const formatter = createFormatterCommand(toolName, argsRecord);
		if (!formatter) return undefined;
		const sourceBytes = textEncoder.encode(formatter.source);
		if (sourceBytes.length > normalized.maxInputBytes) return undefined;
		if (normalized.timeoutMs <= 0) return undefined;
		if (normalized.maxOutputBytes <= 0) return undefined;

		const executable = resolveExecutable(formatter.binary);
		if (!executable) return undefined;

		const cacheKey = buildCacheKey(executable, formatter.args, formatter.source);
		const cached = formattedCache.get(cacheKey);
		if (cached !== undefined) {
			return { ...argsRecord, [formatter.field]: cached };
		}

		const formatted = await runFormatter(mergedRuntime, executable, formatter, signal, normalized);
		if (!formatted) return undefined;

		formattedCache.set(cacheKey, formatted);
		return { ...argsRecord, [formatter.field]: formatted };
	};
}

export const formatToolCallSourceArgs = createSourceFormatter();
