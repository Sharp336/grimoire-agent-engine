import * as fs from "node:fs";
import * as path from "node:path";

import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import {
	attachSessionOwner,
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	waitForPromiseWithCancellation,
} from "../executor-base";
import type { KernelDisplayOutput } from "../py/display";
import { checkRustKernelAvailability, RustKernel, type RustKernelAvailability } from "./kernel";
import { resolveExplicitRustRuntime } from "./runtime";

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

// ---------------------------------------------------------------------------
// Session bookkeeping
//
// One RustKernel subprocess per (session id, cwd, interpreter) tuple. The
// runner mutates process-global cwd/ENV during execution, so cross-directory
// work must never share a live kernel. Multiple agent owners can register
// against the same tuple; the kernel stays alive until the last owner detaches.
// ---------------------------------------------------------------------------

interface RustSessionOwners {
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

interface RustSession extends RustSessionOwners {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: RustKernel;
}

interface StartingRustSession extends RustSessionOwners {
	promise: Promise<RustSession>;
}

const sessions = new Map<string, RustSession>();
const startingSessions = new Map<string, StartingRustSession>();
const resettingSessions = new Map<string, Promise<void>>();

function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitRustRuntime(interpreter, cwd, {}).evcxrPath;
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function buildSessionKey(sessionId: string, cwd: string, interpreter: string | undefined): string {
	const normalizedCwd = normalizeSessionCwd(cwd);
	return `${sessionId}\0${normalizedCwd}\0${normalizeExplicitInterpreter(normalizedCwd, interpreter)}`;
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
	return await RustKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
	});
}

async function acquireSession(
	sessionKey: string,
	sessionId: string,
	cwd: string,
	options: RustExecutorOptions,
): Promise<RustSession> {
	const existing = sessions.get(sessionKey);
	if (existing) {
		attachSessionOwner(existing, sessionId, options.kernelOwnerId);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		attachSessionOwner(starting, sessionId, options.kernelOwnerId);
		return await starting.promise;
	}
	let startingSession: StartingRustSession | undefined;
	const startup = (async () => {
		const kernel = await startKernel(cwd, options);
		const current = startingSession;
		if (!current) throw new RustExecutionCancelledError(false);
		const session: RustSession = {
			sessionKey,
			sessionId,
			cwd,
			kernel,
			ownerIds: new Set(current.ownerIds),
			hasFallbackOwner: current.hasFallbackOwner,
		};
		if (startingSessions.get(sessionKey) === current) {
			sessions.set(sessionKey, session);
		}
		return session;
	})();
	startingSession = {
		ownerIds: new Set(),
		hasFallbackOwner: false,
		promise: startup,
	};
	attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
	startingSessions.set(sessionKey, startingSession);
	try {
		return await startup;
	} finally {
		if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
	}
}

async function replaceSessionKernel(session: RustSession, cwd: string, options: RustExecutorOptions): Promise<void> {
	const old = session.kernel;
	const remaining = getRemainingTimeoutMs(options.deadlineMs);
	await old
		.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
		.catch(() => undefined);
	if (sessions.get(session.sessionKey) !== session) {
		throw new RustExecutionCancelledError(false);
	}
	requireRemainingTimeoutMs(options.deadlineMs);
	const next = await startKernel(cwd, options);
	if (sessions.get(session.sessionKey) !== session) {
		await next.shutdown().catch(() => undefined);
		throw new RustExecutionCancelledError(false);
	}
	session.kernel = next;
}

async function resetSession(sessionKey: string): Promise<void> {
	const existing =
		sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!existing) return;
	sessions.delete(sessionKey);
	await existing.kernel.shutdown().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Public dispose entry points
// ---------------------------------------------------------------------------

export async function disposeAllRustKernelSessions(): Promise<void> {
	const pending = [...startingSessions.values()].map(starting => starting.promise);
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = [...sessions.entries()];
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.some(([, session]) => session === result.value)) {
			all.push([result.value.sessionKey, result.value]);
		}
	}
	for (const [id, session] of all) {
		if (sessions.get(id) === session) sessions.delete(id);
	}
	const results = await Promise.allSettled(all.map(([, session]) => session.kernel.shutdown()));
	for (let i = 0; i < all.length; i += 1) {
		const [id, session] = all[i];
		const result = results[i];
		if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
		const reason = result.status === "rejected" ? result.reason : "not confirmed";
		logger.warn("Rust kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: id,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(id)) sessions.set(id, session);
	}
}

export async function disposeRustKernelSessionsByOwner(ownerId: string): Promise<void> {
	const toShutdown: RustSession[] = [];
	const startingToShutdown: StartingRustSession[] = [];
	for (const session of [...sessions.values()]) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toShutdown.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	for (const [sessionKey, starting] of [...startingSessions.entries()]) {
		if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
		if (starting.ownerIds.size === 1) {
			startingSessions.delete(sessionKey);
			startingToShutdown.push(starting);
			continue;
		}
		starting.ownerIds.delete(ownerId);
	}
	for (const session of toShutdown) {
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		const session = result.value;
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		toShutdown.push(session);
	}
	const results = await Promise.allSettled(toShutdown.map(session => session.kernel.shutdown()));
	for (let i = 0; i < toShutdown.length; i += 1) {
		const session = toShutdown[i];
		const result = results[i];
		if (result.status === "fulfilled" && result.value?.confirmed !== false) {
			session.ownerIds.delete(ownerId);
			continue;
		}
		const reason = result.status === "rejected" ? result.reason : "not confirmed";
		logger.warn("Rust kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: session.sessionKey,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
	}
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
		return createCancelledRustResult(false);
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

async function executeOnSession(code: string, cwd: string, options: RustExecutorOptions): Promise<RustResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = buildSessionKey(sessionId, cwd, options.interpreter);
	if (options.reset) {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetSession(sessionKey);
			resettingSessions.set(
				sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(sessionKey);
			}
		}
	} else {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const session = await acquireSession(sessionKey, sessionId, cwd, options);
	if (options.signal?.aborted) {
		throw new RustExecutionCancelledError(
			isTimedOutCancellation(options.signal.reason, RustExecutionCancelledError, options.signal),
		);
	}
	if (sessions.get(session.sessionKey) !== session) {
		throw new RustExecutionCancelledError(false);
	}
	if (!session.kernel.isAlive()) {
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new RustExecutionCancelledError(false);
		}
	}
	const runOptions = { ...options, cwd };
	try {
		return await executeRustWithKernel(session.kernel, code, runOptions);
	} catch (err) {
		if (isCancellationError(err, RustExecutionCancelledError) || options.signal?.aborted) throw err;
		if (session.kernel.isAlive()) throw err;
		if (sessions.get(session.sessionKey) !== session) {
			throw new RustExecutionCancelledError(false);
		}
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new RustExecutionCancelledError(false);
		}
		return await executeRustWithKernel(session.kernel, code, runOptions);
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
		return await executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err, RustExecutionCancelledError) || executionOptions.signal?.aborted) {
			return createCancelledRustResult(
				isTimedOutCancellation(err, RustExecutionCancelledError, executionOptions.signal),
			);
		}
		throw err;
	}
}
