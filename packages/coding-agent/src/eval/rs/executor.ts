import * as path from "node:path";

import { getProjectDir } from "@oh-my-pi/pi-utils";
import {
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	KernelSessionRegistry,
	waitForPromiseWithCancellation,
} from "../executor-base";
import type { KernelDisplayOutput } from "../py/display";
import { checkRustKernelAvailability, RustKernel, type RustKernelAvailability } from "./kernel";

export interface RustExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** Absolute wall-clock deadline in milliseconds since epoch */
	deadlineMs?: number;
	/**
	 * Runtime-work budget (ms). Used only for timeout-annotation text when the
	 * caller drives cancellation via the eval watchdog `signal`. Does not arm a timer.
	 */
	idleTimeoutMs?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => Promise<void> | void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Session identifier for kernel reuse */
	sessionId?: string;
	/** Logical owner identifier for retained kernel cleanup */
	kernelOwnerId?: string;
	/** Explicit interpreter path (`rust.interpreter`). Skips discovery when set. */
	interpreter?: string;
	/** Restart the kernel before executing */
	reset?: boolean;
	/** Session file path for accessing task outputs */
	sessionFile?: string;
	/** Effective artifacts directory for the current session. */
	artifactsDir?: string;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * On-disk roots the prelude helpers substitute for internal-URL schemes
	 * (e.g. `{ local: "/…/artifacts/local" }`). Exported to the kernel as
	 * `PI_EVAL_LOCAL_ROOTS` (JSON).
	 */
	localRoots?: Record<string, string>;
	/** evcxr compile-cache size in MiB; 0 disables. Primed via `:cache` at kernel start. */
	cacheMiB?: number;
}

export interface RustResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: KernelDisplayOutput[];
	stdinRequested: boolean;
}

function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

// ---------------------------------------------------------------------------
// Cancellation plumbing
// ---------------------------------------------------------------------------

class RustExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = timedOut ? "TimeoutError" : "AbortError";
		this.timedOut = timedOut;
	}
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new RustExecutionCancelledError(true);
	}
	return remainingMs;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatTimeoutAnnotation(timeoutMs?: number): string | undefined {
	if (timeoutMs === undefined) return "Command timed out";
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds`;
}

function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const secs = timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000));
	if (kernelKilled) {
		return "eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.";
	}
	const duration = secs === undefined ? "the configured timeout" : `${secs}s`;
	return `eval cell timed out after ${duration}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

function createCancelledRustResult(timedOut: boolean, timeoutMs?: number): RustResult {
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "Command timed out") : "";
	return createCancelledKernelResult(output);
}

// ---------------------------------------------------------------------------
// Kernel start helpers
// ---------------------------------------------------------------------------

async function startKernel(cwd: string, options: RustExecutorOptions): Promise<RustKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	try {
		return await RustKernel.start({
			cwd,
			env: buildManagedKernelEnv(options),
			signal: options.signal,
			cacheMiB: options.cacheMiB,
			deadlineMs: options.deadlineMs,
			interpreter: options.interpreter,
		});
	} catch (err) {
		// A caller deadline that expires DURING startup surfaces as a plain
		// startup Error; convert it to a timed-out cancellation so executeRust's
		// catch returns a cancelled result instead of throwing. The built-in
		// STARTUP_TIMEOUT_MS failure (no caller deadline) stays a real error.
		if (!isCancellationError(err, RustExecutionCancelledError)) {
			const remaining = getRemainingTimeoutMs(options.deadlineMs);
			if (remaining !== undefined && remaining <= 0) {
				throw new RustExecutionCancelledError(true);
			}
		}
		throw err;
	}
}

export class RustRegistry extends KernelSessionRegistry<RustKernel, RustExecutorOptions, RustResult> {
	readonly languageLabel = "Rust";
	readonly cancelledErrorClass = RustExecutionCancelledError;

	buildSessionKey(sessionId: string, cwd: string, options: RustExecutorOptions): string {
		// evcxr's process env is fixed at spawn with no per-cell reapplication channel,
		// so managed env is part of kernel identity — a caller with a different session
		// file/artifacts dir gets its own kernel instead of reusing one primed with stale PI_* values.
		return `${super.buildSessionKey(sessionId, cwd, options)}\0${Bun.hash(JSON.stringify(buildManagedKernelEnvPatch(options))).toString(36)}`;
	}

	async startKernel(cwd: string, options: RustExecutorOptions): Promise<RustKernel> {
		return await startKernel(cwd, options);
	}

	async runOnKernel(kernel: RustKernel, code: string, options: RustExecutorOptions): Promise<RustResult> {
		return await executeRustWithKernel(kernel, code, options);
	}
}

const registry = new RustRegistry();

export async function disposeAllRustKernelSessions(): Promise<void> {
	await registry.disposeAll();
}

export async function disposeRustKernelSessionsByOwner(ownerId: string): Promise<void> {
	await registry.disposeByOwner(ownerId);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

import type { RustKernelExecuteOptions, RustKernelExecuteResult } from "./kernel";

export interface RustKernelExecutor {
	execute(code: string, options: RustKernelExecuteOptions): Promise<RustKernelExecuteResult>;
	readonly id: string;
}

const kernelLocks = new WeakSet<RustKernelExecutor>();

export async function executeRustWithKernel(
	kernel: RustKernelExecutor,
	code: string,
	options: RustExecutorOptions | undefined,
): Promise<RustResult> {
	if (options?.signal?.aborted) {
		return createCancelledRustResult(
			isTimedOutCancellation(options.signal.reason, RustExecutionCancelledError, options.signal),
		);
	}
	if (kernelLocks.has(kernel)) {
		throw new Error("concurrent execution on the same Rust kernel is not allowed");
	}
	kernelLocks.add(kernel);
	try {
		return await executeWithKernelBase<RustExecutorOptions>({
			kernel,
			code,
			options,
			runIdPrefix: "rs",
			errorLogLabel: "Rust",
			cancelledErrorClass: RustExecutionCancelledError,
			buildKernelEnvPatch: buildManagedKernelEnvPatch,
			formatKernelTimeoutAnnotation,
			formatTimeoutAnnotation,
		});
	} finally {
		kernelLocks.delete(kernel);
	}
}

async function ensureKernelAvailable(cwd: string, options: RustExecutorOptions): Promise<void> {
	const availability: RustKernelAvailability = await waitForPromiseWithCancellation(
		checkRustKernelAvailability(cwd, options.interpreter),
		options,
		RustExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Rust kernel unavailable");
	}
}

export async function executeRust(code: string, options?: RustExecutorOptions): Promise<RustResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: RustExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new RustExecutionCancelledError(
				isTimedOutCancellation(
					executionOptions.signal.reason,
					RustExecutionCancelledError,
					executionOptions.signal,
				),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		return await registry.executeOnSession(code, executionOptions);
	} catch (err) {
		if (isCancellationError(err, RustExecutionCancelledError) || executionOptions.signal?.aborted) {
			return createCancelledRustResult(
				isTimedOutCancellation(err, RustExecutionCancelledError, executionOptions.signal),
			);
		}
		throw err;
	}
}
