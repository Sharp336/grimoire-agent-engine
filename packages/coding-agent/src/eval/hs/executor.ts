import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { DEFAULT_MAX_BYTES, OutputSink } from "../../session/streaming-output";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import type { EvalDisplayOutput, EvalStatusEvent } from "../types";

export interface HsExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	onStatus?: (event: EvalStatusEvent) => void;
	signal?: AbortSignal;
	sessionId: string;
	reset?: boolean;
	sessionFile?: string;
	artifactPath?: string;
	artifactId?: string;
	session: ToolSession;
	localRoots?: Record<string, string>;
}

export interface HsResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
}

export async function executeHs(code: string, options: HsExecutorOptions): Promise<HsResult> {
	const displayOutputs: EvalDisplayOutput[] = [];
	const outputSink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});

	let tempDir: string | undefined;
	let proc: Subprocess | undefined;
	let aborted = false;

	const onAbort = () => {
		aborted = true;
		if (proc) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
	};

	if (options.signal) {
		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	try {
		if (aborted) {
			throw new DOMException("Execution aborted", "AbortError");
		}

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hs-"));
		const tempFile = path.join(tempDir, "Main.hs");
		fs.writeFileSync(tempFile, code, "utf8");

		const envPatch: Record<string, string> = {};
		if (options.sessionFile) {
			envPatch.PI_SESSION_FILE = options.sessionFile;
		}
		const artifactsDir = options.session.getArtifactsDir?.();
		if (artifactsDir) {
			envPatch.PI_ARTIFACTS_DIR = artifactsDir;
		}
		if (options.localRoots && Object.keys(options.localRoots).length > 0) {
			envPatch.PI_EVAL_LOCAL_ROOTS = JSON.stringify(options.localRoots);
		}

		const targetCwd = options.cwd ?? options.session.cwd;
		if (!fs.existsSync(targetCwd)) {
			fs.mkdirSync(targetCwd, { recursive: true });
		}

		const fullEnv = {
			...process.env,
			...envPatch,
		} as Record<string, string>;

		proc = Bun.spawn(["runhaskell", tempFile], {
			cwd: targetCwd,
			env: fullEnv,
			stdout: "pipe",
			stderr: "pipe",
		});

		const decoder = new TextDecoder();
		const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();

		const stdoutPromise = (async () => {
			try {
				while (true) {
					const { done, value } = await stdoutReader.read();
					if (done) {
						break;
					}
					const text = decoder.decode(value, { stream: true });
					outputSink.push(text);
				}
				outputSink.push(decoder.decode());
			} finally {
				stdoutReader.releaseLock();
			}
		})();

		const stderrPromise = (async () => {
			try {
				while (true) {
					const { done, value } = await stderrReader.read();
					if (done) {
						break;
					}
					const text = decoder.decode(value, { stream: true });
					outputSink.push(text);
				}
				outputSink.push(decoder.decode());
			} finally {
				stderrReader.releaseLock();
			}
		})();

		await Promise.all([stdoutPromise, stderrPromise]);
		const exitCode = await proc.exited;

		if (aborted) {
			throw new DOMException("Execution aborted", "AbortError");
		}

		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} catch (error) {
		const isTimeout =
			(options.signal?.reason && (options.signal.reason as Error).name === "TimeoutError") ||
			(error instanceof Error && error.name === "TimeoutError");

		if (aborted || isTimeout) {
			if (isTimeout) {
				const timeoutMs = options.timeoutMs ?? options.idleTimeoutMs;
				const secs = timeoutMs ? Math.max(1, Math.round(timeoutMs / 1000)) : 30;
				outputSink.push(`Command timed out after ${secs} seconds.`);
			}
			const summary = await outputSink.dump();
			return {
				output: summary.output,
				exitCode: undefined,
				cancelled: true,
				truncated: summary.truncated,
				artifactId: summary.artifactId,
				totalLines: summary.totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				displayOutputs,
			};
		}

		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		outputSink.push(message);
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} finally {
		if (options.signal) {
			options.signal.removeEventListener("abort", onAbort);
		}
		if (tempDir) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}
}
