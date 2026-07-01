/**
 * Subprocess-backed Rust runner.
 *
 * Speaks Evcxr's IDE-mode protocol directly over stdin/stdout. Evcxr is not
 * line-delimited JSON: a cell completes when stdout settles, then the full
 * stdout transcript is analyzed for the success/failure marker and trailing
 * prompt. User stdout/stderr can race the marker, so prompt classification is
 * deliberately delayed until a short quiet period has elapsed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $flag, isBunTestRuntime, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import {
	getRemainingTimeMs,
	isTimeoutReason,
	type KernelShutdownResult,
	type KernelStartOptions,
} from "../kernel-base";
import type { KernelDisplayOutput } from "../py/display";
import { hostHasInheritableConsole, shouldHideKernelWindow } from "../py/spawn-options";
import {
	enumerateRustRuntimes,
	filterEnv,
	type RustRuntime,
	resolveExplicitRustRuntime,
	resolveRustRuntime,
} from "./runtime";

export type { KernelShutdownResult } from "../kernel-base";

const STARTUP_TIMEOUT_MS = 10_000;
const OUTPUT_SETTLE_MS = 50;
const SHUTDOWN_GRACE_MS = 1_000;
const SUCCESS_MARKER = "\u{0091}";
const FAILURE_MARKER = "\u{0092}";
const PROMPT = ">> ";
const WELCOME_PREFIX = "Welcome to evcxr";
const LINE_SEPARATOR = "\u2028";
const PARAGRAPH_SEPARATOR = "\u2029";
const EVCXR_INSTALL_HINT = "Install with: rustup component add rust-src && cargo install --locked evcxr_repl";
const TRANSPORT_SEPARATOR_ERROR =
	"Rust eval cannot transport literal Unicode line/paragraph separators through evcxr; use Rust string escapes such as \\u{2028} instead.";

type RustSubprocess = Subprocess<"pipe", "pipe", "pipe">;
type RustExecutionStatus = "ok" | "error";

export interface RustKernelAvailability {
	ok: boolean;
	evcxrPath?: string;
	runtime?: RustRuntime;
	reason?: string;
}

export interface RustKernelExecuteOptions {
	cwd?: string;
	/** Per-cell env patches are accepted for GenericKernel compatibility; Evcxr's process env is fixed at start. */
	env?: Record<string, string | null | undefined>;
	id: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	onChunk: (text: string) => Promise<void> | void;
	onDisplay: (output: KernelDisplayOutput) => Promise<void> | void;
}

export interface RustKernelExecuteResult {
	status: RustExecutionStatus;
	cancelled: boolean;
	timedOut: boolean;
	kernelKilled?: boolean;
	stdinRequested?: boolean;
}

interface PendingExecution {
	id: string;
	options: RustKernelExecuteOptions;
	resolve: (result: RustKernelExecuteResult) => void;
	reject: (error: Error) => void;
	timedOut: boolean;
	written: boolean;
	stdoutBuffer: string;
	liveStdoutCursor: number;
	liveMarkerSeen: boolean;
	liveMarkerEndIndex: number | undefined;
	livePromptSeen: boolean;
	chunkTail: Promise<void>;
	settleTimer: NodeJS.Timeout | undefined;
	timeoutTimer: NodeJS.Timeout | undefined;
	onAbort: (() => void) | undefined;
	finalized: boolean;
}

type EscapeState = "normal" | "escape" | "csi" | "osc" | "oscEscape" | "string" | "stringEscape" | "charset";

// CAN (0x18) and SUB (0x1a) cancel any in-flight escape sequence (ECMA-48
// §5.4), and C1 controls (0x80-0x9f) cannot legally appear mid-sequence. Evcxr's
// completion markers ARE C1 bytes (U+0091/U+0092), so treating these as aborts
// guarantees an unterminated OSC/DCS/APC/PM string from user code can never
// swallow the marker+prompt and hang the cell until timeout.
function isEscapeAbort(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9f);
}

export class TerminalEscapeStripper {
	#state: EscapeState = "normal";

	write(chunk: string): string {
		let output = "";
		for (const char of chunk) {
			if (this.#state !== "normal" && isEscapeAbort(char)) {
				this.#state = "normal";
			}
			switch (this.#state) {
				case "normal": {
					if (char === "\u001b") {
						this.#state = "escape";
					} else {
						output += char;
					}
					break;
				}
				case "escape": {
					if (char === "[") {
						this.#state = "csi";
					} else if (char === "]") {
						this.#state = "osc";
					} else if (char === "P" || char === "X" || char === "^" || char === "_") {
						this.#state = "string";
					} else if (
						char === "(" ||
						char === ")" ||
						char === "*" ||
						char === "+" ||
						char === "-" ||
						char === "." ||
						char === "/"
					) {
						this.#state = "charset";
					} else {
						this.#state = "normal";
					}
					break;
				}
				case "csi": {
					if (char >= "@" && char <= "~") {
						this.#state = "normal";
					}
					break;
				}
				case "osc": {
					if (char === "\u0007") {
						this.#state = "normal";
					} else if (char === "\u001b") {
						this.#state = "oscEscape";
					}
					break;
				}
				case "oscEscape": {
					this.#state = char === "\\" ? "normal" : "osc";
					break;
				}
				case "string": {
					if (char === "\u001b") {
						this.#state = "stringEscape";
					}
					break;
				}
				case "stringEscape": {
					this.#state = char === "\\" ? "normal" : "string";
					break;
				}
				case "charset": {
					this.#state = "normal";
					break;
				}
			}
		}
		return output;
	}

	end(): string {
		this.#state = "normal";
		return "";
	}
}

// Cache successful probes per resolved cwd + explicit interpreter. Failures are
// not cached so installing Evcxr mid-session is picked up on the next attempt.
const availabilityCache = new Map<string, Promise<RustKernelAvailability>>();

export async function checkRustKernelAvailability(cwd: string, interpreter?: string): Promise<RustKernelAvailability> {
	if (isBunTestRuntime() || $flag("PI_RUST_SKIP_CHECK")) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return await cached;
	const probe = probeRustKernelAvailability(resolvedCwd, interpreter);
	availabilityCache.set(key, probe);
	const result = await probe;
	if (!result.ok && availabilityCache.get(key) === probe) {
		availabilityCache.delete(key);
	}
	return result;
}

async function probeRustKernelAvailability(cwd: string, interpreter?: string): Promise<RustKernelAvailability> {
	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtimes = enumerateRustRuntimes(cwd, baseEnv, interpreter);
		if (runtimes.length === 0) {
			return {
				ok: false,
				reason: `Evcxr executable not found on PATH. ${EVCXR_INSTALL_HINT}`,
			};
		}
		const failures: string[] = [];
		for (const runtime of runtimes) {
			try {
				const versionProbe = await $`${runtime.evcxrPath} --version`.quiet().nothrow().cwd(cwd).env(runtime.env);
				const helpProbe = await $`${runtime.evcxrPath} --help`.quiet().nothrow().cwd(cwd).env(runtime.env);
				const helpText = helpProbe.stdout.toString();
				if (
					versionProbe.exitCode === 0 &&
					helpProbe.exitCode === 0 &&
					helpText.includes("--disable-readline") &&
					helpText.includes("--ide-mode")
				) {
					return { ok: true, evcxrPath: runtime.evcxrPath, runtime };
				}
				const problems: string[] = [];
				if (versionProbe.exitCode !== 0) problems.push(`--version exit code ${versionProbe.exitCode}`);
				if (helpProbe.exitCode !== 0) {
					problems.push(`--help exit code ${helpProbe.exitCode}`);
				} else {
					if (!helpText.includes("--disable-readline")) problems.push("--help missing --disable-readline");
					if (!helpText.includes("--ide-mode")) problems.push("--help missing --ide-mode");
				}
				failures.push(`${runtime.evcxrPath} (${problems.join(", ")})`);
			} catch (err) {
				failures.push(`${runtime.evcxrPath} (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		return {
			ok: false,
			evcxrPath: runtimes[0].evcxrPath,
			reason: `No working Evcxr executable found. Tried: ${failures.join("; ")}`,
		};
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

export class RustKernel {
	readonly id: string;
	#proc: RustSubprocess | null;
	#stdin: Bun.FileSink | null;
	#alive = true;
	#disposed = false;
	#shutdownConfirmed = false;
	#exitedPromise: Promise<number> | null;
	#pending: PendingExecution | null = null;
	#configDir: string;

	constructor(id: string, proc: RustSubprocess, configDir: string) {
		this.id = id;
		this.#proc = proc;
		this.#stdin = proc.stdin;
		this.#configDir = configDir;
		this.#exitedPromise = proc.exited;
		void this.#exitedPromise.then(code => {
			this.#handleProcessExit(code);
		});
		this.#startStdoutReader(proc.stdout as ReadableStream<Uint8Array>);
		this.#startStderrReader(proc.stderr as ReadableStream<Uint8Array>);
	}

	static async start(options: KernelStartOptions): Promise<RustKernel> {
		const availability = await logger.time(
			"RustKernel.start:availabilityCheck",
			checkRustKernelAvailability,
			options.cwd,
			options.interpreter,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Rust kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitRustRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolveRustRuntime(options.cwd, filterEnv(shellEnv));
		}

		const kernelId = Snowflake.next();
		const configHash = Bun.hash(`${options.cwd}\0${kernelId}`).toString(36);
		const configDir = path.join(os.tmpdir(), "omp-evcxr-config", configHash);
		await fs.promises.rm(configDir, { recursive: true, force: true });
		await fs.promises.mkdir(configDir, { recursive: true });

		const spawnEnv: Record<string, string> = {};
		for (const key in runtime.env) {
			const value = runtime.env[key];
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const key in options.env) {
			const value = options.env[key];
			if (typeof value === "string") spawnEnv[key] = value;
		}
		spawnEnv.EVCXR_CONFIG_DIR = configDir;

		let proc: RustSubprocess | undefined;
		try {
			proc = Bun.spawn([runtime.evcxrPath, "--disable-readline", "--ide-mode"], {
				cwd: options.cwd,
				env: spawnEnv,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: shouldHideKernelWindow({
					platform: process.platform,
					hostHasInheritableConsole: hostHasInheritableConsole(),
				}),
			});

			const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
			const startupBudget = Math.min(
				getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS,
				STARTUP_TIMEOUT_MS,
			);
			await waitForStartupPrompt(proc, startupBudget, startup.signal);
			return new RustKernel(kernelId, proc, configDir);
		} catch (err) {
			if (proc) await terminateProcess(proc, SHUTDOWN_GRACE_MS).catch(() => false);
			await fs.promises.rm(configDir, { recursive: true, force: true }).catch(() => {});
			throw err;
		}
	}

	isAlive(): boolean {
		return this.#alive && !this.#disposed;
	}

	async execute(code: string, options: RustKernelExecuteOptions): Promise<RustKernelExecuteResult> {
		if (this.#pending) {
			throw new Error("Rust kernel is already executing a cell");
		}
		if (options.signal?.aborted) {
			return {
				status: "error",
				cancelled: true,
				timedOut: isTimeoutReason(options.signal.reason),
				stdinRequested: false,
			};
		}
		if (!this.isAlive()) {
			throw new Error("Rust kernel is not running");
		}
		if (code.includes(LINE_SEPARATOR) || code.includes(PARAGRAPH_SEPARATOR)) {
			throw new Error(TRANSPORT_SEPARATOR_ERROR);
		}
		if (code.trim().length === 0) {
			return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
		}

		const { promise, resolve, reject } = Promise.withResolvers<RustKernelExecuteResult>();
		const pending: PendingExecution = {
			id: options.id,
			options,
			resolve,
			reject,
			timedOut: false,
			written: false,
			stdoutBuffer: "",
			liveStdoutCursor: 0,
			liveMarkerSeen: false,
			liveMarkerEndIndex: undefined,
			livePromptSeen: false,
			chunkTail: Promise.resolve(),
			settleTimer: undefined,
			timeoutTimer: undefined,
			onAbort: undefined,
			finalized: false,
		};
		this.#pending = pending;

		pending.onAbort = () => {
			this.#cancelPending(pending, isTimeoutReason(options.signal?.reason));
		};
		options.signal?.addEventListener("abort", pending.onAbort, { once: true });
		if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
			pending.timeoutTimer = setTimeout(() => {
				this.#cancelPending(pending, true);
			}, options.timeoutMs);
			pending.timeoutTimer.unref?.();
		}
		if (options.signal?.aborted) {
			this.#cancelPending(pending, isTimeoutReason(options.signal.reason));
		}
		if (pending.finalized) return await promise;

		try {
			this.#writeLine(`${code.replaceAll("\n", LINE_SEPARATOR)}\n`);
			pending.written = true;
		} catch (err) {
			await this.#rejectPending(pending, err instanceof Error ? err : new Error(String(err)));
		}

		return await promise;
	}

	async shutdown(options?: { timeoutMs?: number }): Promise<KernelShutdownResult> {
		if (this.#shutdownConfirmed) {
			await this.#cleanupConfigDir();
			return { confirmed: true };
		}

		this.#alive = false;
		const pending = this.#pending;
		if (pending && !pending.finalized) {
			void this.#finalizePending(pending, {
				status: "error",
				cancelled: true,
				timedOut: pending.timedOut,
				kernelKilled: true,
				stdinRequested: false,
			});
		}

		const proc = this.#proc;
		if (!proc) {
			this.#shutdownConfirmed = true;
			this.#disposed = true;
			await this.#cleanupConfigDir();
			return { confirmed: true };
		}

		try {
			this.#stdin?.end();
		} catch {
			/* ignore */
		}

		const timeoutMs = options?.timeoutMs ?? SHUTDOWN_GRACE_MS;
		try {
			proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		let confirmed = (await this.#waitForExitWithTimeout(timeoutMs)) !== null;
		if (!confirmed) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			confirmed = (await this.#waitForExitWithTimeout(timeoutMs)) !== null;
		}

		this.#shutdownConfirmed = confirmed;
		this.#disposed = true;
		await this.#cleanupConfigDir();
		return { confirmed };
	}

	async #cleanupConfigDir(): Promise<void> {
		await fs.promises.rm(this.#configDir, { recursive: true, force: true }).catch(() => {});
	}

	#writeLine(line: string): void {
		if (!this.#stdin) {
			throw new Error("Rust kernel stdin is not open");
		}
		this.#stdin.write(line);
		this.#stdin.flush();
	}

	#startStdoutReader(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const stripper = new TerminalEscapeStripper();
		const loop = async (): Promise<void> => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const stripped = stripper.write(decoder.decode(value, { stream: true }));
					if (stripped.length > 0) {
						this.#handleStdoutText(stripped);
					}
				}
				const stripped = stripper.write(decoder.decode()) + stripper.end();
				if (stripped.length > 0) {
					this.#handleStdoutText(stripped);
				}
			} catch (err) {
				logger.warn("Rust kernel stdout reader failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* ignore */
				}
			}
		};
		void loop();
	}

	#startStderrReader(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const stripper = new TerminalEscapeStripper();
		const loop = async (): Promise<void> => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const stripped = stripper.write(decoder.decode(value, { stream: true }));
					if (stripped.length > 0) {
						this.#handleStderrText(stripped);
					}
				}
				const stripped = stripper.write(decoder.decode()) + stripper.end();
				if (stripped.length > 0) {
					this.#handleStderrText(stripped);
				}
			} catch (err) {
				logger.warn("Rust kernel stderr reader failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* ignore */
				}
			}
		};
		void loop();
	}

	#handleStdoutText(text: string): void {
		const pending = this.#pending;
		if (!pending || pending.finalized) return;
		pending.stdoutBuffer += text;
		this.#streamStdoutForLiveUx(pending);
		this.#checkArmSettleTimer(pending);
	}

	#handleStderrText(text: string): void {
		const pending = this.#pending;
		if (!pending || pending.finalized) return;
		this.#queueChunk(pending, text);
		// Markers/prompts only ever appear on stdout, so stderr activity cannot
		// ARM the settle timer — but once armed, a compiler diagnostic relayed on
		// stderr can still race in after the stdout marker+prompt, so stderr
		// activity must still EXTEND an already-armed window.
		if (pending.livePromptSeen) this.#resetSettleTimer(pending);
	}

	#streamStdoutForLiveUx(pending: PendingExecution): void {
		// Live UX and correctness use separate passes: stdoutBuffer remains an
		// untouched transcript for the quiescence-time protocol decision, while
		// this pass streams only stdout that is definitely before the first marker.
		if (pending.liveMarkerSeen) return;
		const successIndex = pending.stdoutBuffer.indexOf(SUCCESS_MARKER, pending.liveStdoutCursor);
		const failureIndex = pending.stdoutBuffer.indexOf(FAILURE_MARKER, pending.liveStdoutCursor);
		const markerIndex = firstMarkerIndex(successIndex, failureIndex);
		const streamEnd = markerIndex ?? pending.stdoutBuffer.length;
		if (streamEnd > pending.liveStdoutCursor) {
			this.#queueChunk(pending, pending.stdoutBuffer.slice(pending.liveStdoutCursor, streamEnd));
			pending.liveStdoutCursor = streamEnd;
		}
		if (markerIndex !== undefined) {
			pending.liveMarkerSeen = true;
			const marker = successIndex === markerIndex ? SUCCESS_MARKER : FAILURE_MARKER;
			pending.liveMarkerEndIndex = markerIndex + marker.length;
		}
	}

	// The settle timer must only start counting down once BOTH the completion
	// marker AND the next protocol prompt have been observed live — this gate
	// fixes two distinct, separately-discovered bugs, not one:
	// (1) Arming on ANY stdout/stderr byte (the original design) finalizes too
	//     early: real Rust code takes real time to compile/run, so a cell that
	//     prints something early and then goes quiet during compilation would
	//     be wrongly finalized as "no marker found" well before the marker
	//     actually arrives.
	// (2) Arming on the marker ALONE (without also requiring the prompt) risks
	//     finalizing before evcxr has finished flushing the following ">> "
	//     prompt, since the marker and prompt are two separate writes that can
	//     be split across reads — a mid-prompt settle would leak partial
	//     prompt bytes into #finalizeSettledOutput's output.
	// The prompt search below is additionally scoped to start strictly AFTER
	// the marker's end index (never from the top of the buffer), so a cell
	// that prints its own literal ">> " text BEFORE the real marker can never
	// be mistaken for the protocol prompt.
	#checkArmSettleTimer(pending: PendingExecution): void {
		if (pending.livePromptSeen) {
			this.#resetSettleTimer(pending);
			return;
		}
		if (pending.liveMarkerEndIndex === undefined) return;
		if (pending.stdoutBuffer.indexOf(PROMPT, pending.liveMarkerEndIndex) < 0) return;
		pending.livePromptSeen = true;
		this.#resetSettleTimer(pending);
	}

	#finalizeSettledOutput(pending: PendingExecution): void {
		if (pending.finalized || this.#pending !== pending) return;
		const successIndex = pending.stdoutBuffer.indexOf(SUCCESS_MARKER);
		const failureIndex = pending.stdoutBuffer.indexOf(FAILURE_MARKER);
		const markerIndex = firstMarkerIndex(successIndex, failureIndex);
		if (markerIndex === undefined) {
			logger.warn("Rust kernel output settled without completion marker", {
				kernelId: this.id,
				executionId: pending.id,
			});
			this.#queueUnstreamedStdout(pending, pending.stdoutBuffer);
			void this.#finalizePending(pending, {
				status: "error",
				cancelled: false,
				timedOut: false,
				stdinRequested: false,
			});
			return;
		}

		const marker = successIndex === markerIndex ? SUCCESS_MARKER : FAILURE_MARKER;
		const status: RustExecutionStatus = marker === SUCCESS_MARKER ? "ok" : "error";
		const beforeMarker = pending.stdoutBuffer.slice(0, markerIndex);
		const afterMarker = pending.stdoutBuffer.slice(markerIndex + marker.length);
		const promptIndex = afterMarker.indexOf(PROMPT);
		let output = beforeMarker;
		if (promptIndex >= 0) {
			// Evcxr's own background stdout/stderr relay thread can still be
			// draining queued bytes after the main thread already printed the
			// marker and the next prompt and blocked on stdin — CONFIRMED against
			// evcxr/src/eval_context.rs's `run_and_capture_output`, which itself
			// spin-waits on `!self.stdout_sender.is_empty()` (exponential backoff,
			// 1ms-100ms) specifically to shrink this race before returning to the
			// caller that prints the marker. That wait only guarantees the relay
			// channel's QUEUE is drained, not that the receiving thread has
			// finished its `write!()` syscall for the last dequeued line — so a
			// narrow window remains where legitimate trailing output can still
			// arrive after the prompt in this buffer, and evcxr's own authors
			// could not close it further either. Splice out exactly the one
			// prompt occurrence and keep everything on both sides as cell output —
			// requiring the prompt to be the LAST thing in the buffer would instead
			// misclassify that trailing output as a protocol violation and dump it
			// unstripped (including the raw prompt bytes) into model-visible output.
			//
			// Known residual limitation (accepted, not fixable from this client):
			// if that same trailing output itself contains the literal substring
			// ">> ", it is indistinguishable from the real prompt using text
			// matching alone, since evcxr's protocol provides no unambiguous
			// prompt-boundary marker. This mirrors the already-accepted limitation
			// that user code printing the literal marker bytes cannot be
			// distinguished from a real completion marker either. Both require a
			// protocol change upstream in evcxr to close completely.
			output += afterMarker.slice(0, promptIndex) + afterMarker.slice(promptIndex + PROMPT.length);
		} else {
			logger.warn("Rust kernel output settled without trailing prompt", {
				kernelId: this.id,
				executionId: pending.id,
			});
			output += afterMarker;
		}

		this.#queueUnstreamedStdout(pending, output);
		void this.#finalizePending(pending, {
			status,
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
		});
	}

	#queueUnstreamedStdout(pending: PendingExecution, output: string): void {
		if (output.length <= pending.liveStdoutCursor) return;
		this.#queueChunk(pending, output.slice(pending.liveStdoutCursor));
		pending.liveStdoutCursor = output.length;
	}

	#queueChunk(pending: PendingExecution, text: string): void {
		if (text.length === 0) return;
		pending.chunkTail = pending.chunkTail.then(async () => {
			try {
				await pending.options.onChunk(text);
			} catch (err) {
				logger.warn("Rust kernel output callback failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});
	}

	#resetSettleTimer(pending: PendingExecution): void {
		clearTimeout(pending.settleTimer);
		pending.settleTimer = setTimeout(() => {
			this.#finalizeSettledOutput(pending);
		}, OUTPUT_SETTLE_MS);
		pending.settleTimer.unref?.();
	}

	#cancelPending(pending: PendingExecution, timedOut: boolean): void {
		if (pending.finalized) return;
		pending.timedOut = pending.timedOut || timedOut;
		if (!pending.written) {
			void this.#finalizePending(pending, {
				status: "error",
				cancelled: true,
				timedOut: pending.timedOut,
				stdinRequested: false,
			});
			return;
		}
		this.#alive = false;
		try {
			this.#proc?.kill("SIGINT");
		} catch (err) {
			logger.warn("Failed to interrupt Rust kernel", { error: err instanceof Error ? err.message : String(err) });
		}
		void this.#finalizePending(pending, {
			status: "error",
			cancelled: true,
			timedOut: pending.timedOut,
			kernelKilled: true,
			stdinRequested: false,
		});
		void this.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(err => {
			logger.warn("Failed to shut down cancelled Rust kernel", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async #rejectPending(pending: PendingExecution, error: Error): Promise<void> {
		if (pending.finalized) return;
		this.#cleanupPending(pending);
		pending.finalized = true;
		if (this.#pending === pending) this.#pending = null;
		try {
			await pending.chunkTail;
		} finally {
			pending.reject(error);
		}
	}

	async #finalizePending(pending: PendingExecution, result: RustKernelExecuteResult): Promise<void> {
		if (pending.finalized) return;
		pending.finalized = true;
		this.#cleanupPending(pending);
		if (this.#pending === pending) this.#pending = null;
		await pending.chunkTail;
		pending.resolve(result);
	}

	#cleanupPending(pending: PendingExecution): void {
		clearTimeout(pending.settleTimer);
		clearTimeout(pending.timeoutTimer);
		pending.settleTimer = undefined;
		pending.timeoutTimer = undefined;
		if (pending.onAbort) {
			pending.options.signal?.removeEventListener("abort", pending.onAbort);
			pending.onAbort = undefined;
		}
	}

	#handleProcessExit(code: number): void {
		this.#alive = false;
		void this.#cleanupConfigDir();
		const pending = this.#pending;
		if (!pending || pending.finalized) return;
		this.#queueChunk(pending, `[kernel] Rust kernel exited with code ${code}\n`);
		void this.#finalizePending(pending, {
			status: "error",
			cancelled: false,
			timedOut: pending.timedOut,
			kernelKilled: true,
			stdinRequested: false,
		});
	}

	#waitForExitWithTimeout(timeoutMs: number): Promise<number | null> {
		if (!this.#exitedPromise) return Promise.resolve(0);
		return waitForExitWithTimeout(this.#exitedPromise, timeoutMs);
	}
}

function firstMarkerIndex(successIndex: number, failureIndex: number): number | undefined {
	if (successIndex < 0 && failureIndex < 0) return undefined;
	if (successIndex < 0) return failureIndex;
	if (failureIndex < 0) return successIndex;
	return Math.min(successIndex, failureIndex);
}

async function waitForStartupPrompt(proc: RustSubprocess, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const stripper = new TerminalEscapeStripper();
	let text = "";
	const timeout = Promise.withResolvers<never>();
	const abort = Promise.withResolvers<never>();
	const exit = proc.exited.then((code): never => {
		throw new Error(`Rust kernel exited during startup with code ${code}. ${EVCXR_INSTALL_HINT}`);
	});
	void exit.catch(() => {});
	const timeoutTimer = setTimeout(
		() => {
			timeout.reject(
				new Error(`Rust kernel startup timed out after ${STARTUP_TIMEOUT_MS}ms. ${EVCXR_INSTALL_HINT}`),
			);
		},
		Math.max(0, timeoutMs),
	);
	timeoutTimer.unref?.();
	const onAbort = (): void => {
		const reason = signal?.reason;
		abort.reject(reason instanceof Error ? reason : new Error("Rust kernel startup cancelled"));
	};
	try {
		if (signal?.aborted) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		while (true) {
			const result = await Promise.race([reader.read(), timeout.promise, abort.promise, exit]);
			if (result.done) {
				throw new Error(`Rust kernel stdout closed during startup. ${EVCXR_INSTALL_HINT}`);
			}
			text += stripper.write(decoder.decode(result.value, { stream: true }));
			if (text.includes(WELCOME_PREFIX)) {
				const welcomeIndex = text.indexOf(WELCOME_PREFIX);
				const promptIndex = text.indexOf(PROMPT, welcomeIndex + WELCOME_PREFIX.length);
				if (promptIndex >= 0) return;
			}
		}
	} finally {
		clearTimeout(timeoutTimer);
		signal?.removeEventListener("abort", onAbort);
		try {
			reader.releaseLock();
		} catch {
			/* ignore */
		}
	}
}

async function terminateProcess(proc: RustSubprocess, timeoutMs: number): Promise<boolean> {
	try {
		proc.stdin.end();
	} catch {
		/* ignore */
	}
	try {
		proc.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	let confirmed = (await waitForExitWithTimeout(proc.exited, timeoutMs)) !== null;
	if (!confirmed) {
		try {
			proc.kill("SIGKILL");
		} catch {
			/* ignore */
		}
		confirmed = (await waitForExitWithTimeout(proc.exited, timeoutMs)) !== null;
	}
	return confirmed;
}

function waitForExitWithTimeout(exitedPromise: Promise<number>, timeoutMs: number): Promise<number | null> {
	const { promise, resolve } = Promise.withResolvers<number | null>();
	let settled = false;
	const finish = (value: number | null): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(value);
	};
	const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
	timer.unref?.();
	exitedPromise.then(
		code => finish(code),
		() => finish(null),
	);
	return promise;
}
