import * as path from "node:path";

import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
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
import type { JsStatusEvent } from "../js/shared/types";
import { ensurePyToolBridge } from "../py/tool-bridge";
import {
	checkRubyKernelAvailability,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	RubyKernel,
} from "./kernel";

export interface RubyExecutorOptions {
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
	/** Explicit interpreter path (`ruby.interpreter`). Skips discovery when set. */
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
	/**
	 * ToolSession used to resolve host-side `tool.<name>(args)` calls. When
	 * omitted, the bridge env vars are not injected and `tool.foo(...)` raises.
	 */
	toolSession?: ToolSession;
	/** Callback for status events emitted by tool bridge invocations. */
	emitStatus?: (event: JsStatusEvent) => void;
	/** Live status events streamed as they are emitted. */
	onStatus?: (event: JsStatusEvent) => void;
	/** @internal Bridge session id, set by `executeRuby` before delegating. */
	bridgeSessionId?: string;
	/** @internal Bridge endpoint info, set by `executeRuby` before delegating. */
	bridge?: { url: string; token: string };
}

export interface RubyKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface RubyResult {
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

class RubyExecutionCancelledError extends Error {
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
		throw new RubyExecutionCancelledError(true);
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

function createCancelledRubyResult(timedOut: boolean, timeoutMs?: number): RubyResult {
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "Command timed out") : "";
	return createCancelledKernelResult(output);
}

// ---------------------------------------------------------------------------
// Kernel start helpers
// ---------------------------------------------------------------------------

async function startKernel(cwd: string, options: RubyExecutorOptions): Promise<RubyKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await RubyKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
	});
}

class RubyRegistry extends KernelSessionRegistry<RubyKernel, RubyExecutorOptions, RubyResult> {
	protected readonly languageLabel = "Ruby";
	protected readonly cancelledErrorClass = RubyExecutionCancelledError;

	protected async startKernel(cwd: string, options: RubyExecutorOptions): Promise<RubyKernel> {
		return await startKernel(cwd, options);
	}

	protected async runOnKernel(kernel: RubyKernel, code: string, options: RubyExecutorOptions): Promise<RubyResult> {
		return await executeRubyWithKernel(kernel, code, options);
	}

	protected async beforeExecution(sessionId: string, options: RubyExecutorOptions): Promise<void> {
		await ensureToolBridge(options);
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = sessionId;
		}
	}
}

const registry = new RubyRegistry();

export async function disposeAllRubyKernelSessions(): Promise<void> {
	await registry.disposeAll();
}

export async function disposeRubyKernelSessionsByOwner(ownerId: string): Promise<void> {
	await registry.disposeByOwner(ownerId);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executeWithKernel(
	kernel: RubyKernelExecutor,
	code: string,
	options: RubyExecutorOptions | undefined,
): Promise<RubyResult> {
	return executeWithKernelBase<RubyExecutorOptions>({
		kernel,
		code,
		options,
		runIdPrefix: "rb",
		errorLogLabel: "Ruby",
		cancelledErrorClass: RubyExecutionCancelledError,
		buildKernelEnvPatch: buildManagedKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
	});
}

async function ensureKernelAvailable(cwd: string, options: RubyExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkRubyKernelAvailability(cwd, options.interpreter),
		options,
		RubyExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Ruby kernel unavailable");
	}
}

async function ensureToolBridge(options: RubyExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("Failed to start Ruby tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}


export async function executeRubyWithKernel(
	kernel: RubyKernelExecutor,
	code: string,
	options?: RubyExecutorOptions,
): Promise<RubyResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executeRuby(code: string, options?: RubyExecutorOptions): Promise<RubyResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: RubyExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new RubyExecutionCancelledError(
				isTimedOutCancellation(
					executionOptions.signal.reason,
					RubyExecutionCancelledError,
					executionOptions.signal,
				),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		return await registry.executeOnSession(code, executionOptions);
	} catch (err) {
		if (isCancellationError(err, RubyExecutionCancelledError) || executionOptions.signal?.aborted) {
			return createCancelledRubyResult(
				isTimedOutCancellation(err, RubyExecutionCancelledError, executionOptions.signal),
			);
		}
		throw err;
	}
}
