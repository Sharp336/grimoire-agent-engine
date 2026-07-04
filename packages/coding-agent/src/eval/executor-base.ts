import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import type { ToolSession } from "../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { isEvalTimeoutControlEvent } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";
import type { KernelDisplayOutput } from "./py/display";
import { registerPyToolBridge } from "./py/tool-bridge-registry";
import { resolveExplicitPath } from "./runtime-env";

/**
 * Constructor for a language executor's cancellation error. Each backend
 * subclasses {@link Error} and carries a `timedOut` flag distinguishing a
 * deadline expiry from a plain abort.
 */
export type CancelledErrorClass = new (timedOut: boolean) => Error & { timedOut: boolean };

/** Managed-env values a kernel patch may carry (`null` clears, `undefined` skips). */
export type KernelEnvPatch = Record<string, string | null | undefined>;

/**
 * Options every kernel-backed language executor shares. Per-language option
 * interfaces structurally extend this; the base executor only reads these.
 */
export interface KernelExecutorBaseOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	signal?: AbortSignal;
	onStatus?: (event: JsStatusEvent) => void;
	emitStatus?: (event: JsStatusEvent) => void;
	toolSession?: ToolSession;
	bridgeSessionId?: string;
	artifactId?: string;
	artifactPath?: string;
}

/** Normalised execution result produced by {@link executeWithKernelBase}. */
export interface KernelExecutionResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: KernelDisplayOutput[];
	stdinRequested: boolean;
}

/** Minimal kernel surface the base executor drives, satisfied by every backend kernel. */
export interface GenericKernel<TEnv> {
	execute(
		code: string,
		options: {
			cwd?: string;
			env?: TEnv;
			id: string;
			signal?: AbortSignal;
			timeoutMs?: number;
			onChunk: (text: string) => Promise<void> | void;
			onDisplay: (output: KernelDisplayOutput) => Promise<void> | void;
		},
	): Promise<{
		status: "ok" | "error";
		cancelled: boolean;
		timedOut: boolean;
		kernelKilled?: boolean;
		stdinRequested?: boolean;
	}>;
}

// ---------------------------------------------------------------------------
// Cancellation helpers
// ---------------------------------------------------------------------------

export function getExecutionDeadlineMs(options?: { deadlineMs?: number; timeoutMs?: number }): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs === undefined) return undefined;
	return Date.now() + options.timeoutMs;
}

export function getRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return deadlineMs - Date.now();
}

export function isCancellationError(error: unknown, cancelledErrorClass: CancelledErrorClass): boolean {
	return (
		error instanceof cancelledErrorClass ||
		(typeof DOMException !== "undefined" &&
			error instanceof DOMException &&
			(error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

export function isTimedOutCancellation(
	error: unknown,
	cancelledErrorClass: CancelledErrorClass,
	signal?: AbortSignal,
): boolean {
	if (error instanceof cancelledErrorClass) return error.timedOut;
	if (typeof DOMException !== "undefined" && error instanceof DOMException) return error.name === "TimeoutError";
	if (error instanceof Error && error.name === "TimeoutError") return true;
	const reason = signal?.reason;
	if (typeof DOMException !== "undefined" && reason instanceof DOMException) return reason.name === "TimeoutError";
	return reason instanceof Error ? reason.name === "TimeoutError" : false;
}

export async function waitForPromiseWithCancellation<T>(
	promise: Promise<T>,
	options: { signal?: AbortSignal; deadlineMs?: number },
	cancelledErrorClass: CancelledErrorClass,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new cancelledErrorClass(isTimedOutCancellation(options.signal.reason, cancelledErrorClass, options.signal));
	}
	const remainingMs = getRemainingTimeoutMs(options.deadlineMs);
	if (remainingMs !== undefined && remainingMs <= 0) {
		throw new cancelledErrorClass(true);
	}
	if (!options.signal && remainingMs === undefined) {
		return await promise;
	}

	const { promise: resultPromise, resolve, reject } = Promise.withResolvers<T>();
	const cleanups: Array<() => void> = [];
	const finish = (cb: () => void): void => {
		while (cleanups.length > 0) cleanups.pop()?.();
		cb();
	};
	if (options.signal) {
		const onAbort = (): void =>
			finish(() =>
				reject(
					new cancelledErrorClass(
						isTimedOutCancellation(options.signal?.reason, cancelledErrorClass, options.signal),
					),
				),
			);
		options.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
	}
	if (remainingMs !== undefined) {
		const timer = setTimeout(() => finish(() => reject(new cancelledErrorClass(true))), remainingMs);
		timer.unref();
		cleanups.push(() => clearTimeout(timer));
	}
	promise.then(
		value => finish(() => resolve(value)),
		err => finish(() => reject(err)),
	);
	return await resultPromise;
}

export function createCancelledKernelResult(output: string): KernelExecutionResult {
	const outputBytes = Buffer.byteLength(output, "utf-8");
	const outputLines = output.length > 0 ? 1 : 0;
	return {
		output,
		exitCode: undefined,
		cancelled: true,
		truncated: false,
		artifactId: undefined,
		totalLines: outputLines,
		totalBytes: outputBytes,
		outputLines,
		outputBytes,
		displayOutputs: [],
		stdinRequested: false,
	};
}

// ---------------------------------------------------------------------------
// Managed environment helpers
// ---------------------------------------------------------------------------

export const MANAGED_KERNEL_ENV_KEYS = [
	"PI_SESSION_FILE",
	"PI_ARTIFACTS_DIR",
	"PI_TOOL_BRIDGE_URL",
	"PI_TOOL_BRIDGE_TOKEN",
	"PI_TOOL_BRIDGE_SESSION",
	"PI_EVAL_LOCAL_ROOTS",
] as const;

interface ManagedKernelEnvOptions {
	sessionFile?: string;
	artifactsDir?: string;
	bridgeSessionId?: string;
	bridge?: { url: string; token: string };
	localRoots?: Record<string, string>;
}

export function buildManagedKernelEnvPatch(options: ManagedKernelEnvOptions): Record<string, string | null> {
	const localRoots = options.localRoots;
	return {
		PI_SESSION_FILE: options.sessionFile ?? null,
		PI_ARTIFACTS_DIR: options.artifactsDir ?? null,
		PI_TOOL_BRIDGE_URL: options.bridge?.url ?? null,
		PI_TOOL_BRIDGE_TOKEN: options.bridge?.token ?? null,
		PI_TOOL_BRIDGE_SESSION: options.bridge && options.bridgeSessionId ? options.bridgeSessionId : null,
		PI_EVAL_LOCAL_ROOTS: localRoots && Object.keys(localRoots).length > 0 ? JSON.stringify(localRoots) : null,
	};
}

export function buildManagedKernelEnv(options: ManagedKernelEnvOptions): Record<string, string> | undefined {
	const patch = buildManagedKernelEnvPatch(options);
	const env: Record<string, string> = {};
	let hasKeys = false;
	for (const key of MANAGED_KERNEL_ENV_KEYS) {
		const value = patch[key];
		if (value !== null) {
			env[key] = value;
			hasKeys = true;
		}
	}
	return hasKeys ? env : undefined;
}

export function attachSessionOwner(
	session: { ownerIds: Set<string>; hasFallbackOwner: boolean },
	sessionId: string,
	ownerId: string | undefined,
): void {
	if (ownerId !== undefined) {
		if (session.hasFallbackOwner) {
			session.ownerIds.delete(sessionId);
			session.hasFallbackOwner = false;
		}
		session.ownerIds.add(ownerId);
		return;
	}
	if (session.hasFallbackOwner || session.ownerIds.size === 0) {
		session.ownerIds.add(sessionId);
		session.hasFallbackOwner = true;
	}
}

/** Minimal lifecycle surface driven by {@link KernelSessionRegistry}. */
export interface RegistryKernel {
	isAlive(): boolean;
	shutdown(options?: { timeoutMs?: number }): Promise<{ confirmed?: boolean }>;
}

/** Fields every retained-kernel executor option set structurally provides. */
export interface RegistryExecutorOptions {
	cwd?: string;
	sessionId?: string;
	signal?: AbortSignal;
	deadlineMs?: number;
	kernelOwnerId?: string;
	reset?: boolean;
	interpreter?: string;
}

export interface RegistrySession<TKernel> {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: TKernel;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

interface StartingRegistrySession<TKernel> {
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
	promise: Promise<RegistrySession<TKernel>>;
}

export abstract class KernelSessionRegistry<
	TKernel extends RegistryKernel,
	TOptions extends RegistryExecutorOptions,
	TResult,
> {
	#sessions = new Map<string, RegistrySession<TKernel>>();
	#startingSessions = new Map<string, StartingRegistrySession<TKernel>>();
	#resettingSessions = new Map<string, Promise<void>>();

	abstract readonly languageLabel: string;
	abstract readonly cancelledErrorClass: CancelledErrorClass;
	abstract startKernel(cwd: string, options: TOptions): Promise<TKernel>;
	abstract runOnKernel(kernel: TKernel, code: string, options: TOptions): Promise<TResult>;

	buildSessionKey(sessionId: string, cwd: string, options: TOptions): string {
		const normalizedCwd = path.resolve(cwd);
		return `${sessionId}\0${normalizedCwd}\0${this.normalizeInterpreter(normalizedCwd, options.interpreter)}`;
	}

	normalizeInterpreter(cwd: string, interpreter: string | undefined): string {
		if (interpreter === undefined) return "";
		const resolved = resolveExplicitPath(interpreter, cwd);
		try {
			return fs.realpathSync.native(resolved);
		} catch {
			return resolved;
		}
	}

	resetShutdownTimeoutMs(): number | undefined {
		return undefined;
	}

	beforeKernelReplacement(_session: RegistrySession<TKernel>): void {}

	async beforeExecution(_sessionId: string, _options: TOptions): Promise<void> {}

	clearResettingOnDisposeAll(): boolean {
		return false;
	}

	isSessionCancellationError(error: unknown): boolean {
		return isCancellationError(error, this.cancelledErrorClass);
	}

	isSessionTimedOutCancellation(error: unknown, signal?: AbortSignal): boolean {
		return isTimedOutCancellation(error, this.cancelledErrorClass, signal);
	}

	async waitForStartingSession(
		promise: Promise<RegistrySession<TKernel>>,
		options: TOptions,
	): Promise<RegistrySession<TKernel>> {
		return await waitForPromiseWithCancellation(promise, options, this.cancelledErrorClass);
	}

	async executeOnSession(code: string, options: TOptions): Promise<TResult> {
		const cwd = options.cwd;
		if (cwd === undefined) throw new Error(`${this.languageLabel} kernel session cwd is required`);
		const sessionId = options.sessionId ?? `session:${cwd}`;
		await this.beforeExecution(sessionId, options);
		const sessionKey = this.buildSessionKey(sessionId, cwd, options);
		if (options.reset) {
			const inFlight = this.#resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
			else {
				const resetPromise = this.#resetSession(sessionKey);
				this.#resettingSessions.set(
					sessionKey,
					resetPromise.then(() => undefined),
				);
				try {
					await resetPromise;
				} finally {
					this.#resettingSessions.delete(sessionKey);
				}
			}
		} else {
			const inFlight = this.#resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
		}
		const session = await this.#acquireSession(sessionKey, sessionId, cwd, options);
		if (options.signal?.aborted) {
			throw new this.cancelledErrorClass(this.isSessionTimedOutCancellation(options.signal.reason, options.signal));
		}
		if (this.#sessions.get(session.sessionKey) !== session) {
			throw new this.cancelledErrorClass(false);
		}
		if (!session.kernel.isAlive()) {
			await this.#replaceSessionKernel(session, cwd, options);
			if (this.#sessions.get(session.sessionKey) !== session) {
				throw new this.cancelledErrorClass(false);
			}
		}
		const runOptions = { ...options, cwd };
		try {
			return await this.runOnKernel(session.kernel, code, runOptions);
		} catch (err) {
			if (this.isSessionCancellationError(err) || options.signal?.aborted) throw err;
			if (session.kernel.isAlive()) throw err;
			if (this.#sessions.get(session.sessionKey) !== session) {
				throw new this.cancelledErrorClass(false);
			}
			await this.#replaceSessionKernel(session, cwd, options);
			if (this.#sessions.get(session.sessionKey) !== session) {
				throw new this.cancelledErrorClass(false);
			}
			return await this.runOnKernel(session.kernel, code, runOptions);
		}
	}

	async disposeAll(): Promise<void> {
		if (this.clearResettingOnDisposeAll()) this.#resettingSessions.clear();
		const pending = [...this.#startingSessions.values()].map(starting => starting.promise);
		this.#startingSessions.clear();
		const started = await Promise.allSettled(pending);
		const all = [...this.#sessions.entries()];
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			if (!all.some(([, session]) => session === result.value)) {
				all.push([result.value.sessionKey, result.value]);
			}
		}
		for (const [id, session] of all) {
			if (this.#sessions.get(id) === session) this.#sessions.delete(id);
		}
		const results = await Promise.allSettled(all.map(([, session]) => session.kernel.shutdown()));
		for (let i = 0; i < all.length; i += 1) {
			const [id, session] = all[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${this.languageLabel} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: id,
				cwd: session.cwd,
				reason,
			});
			if (!this.#sessions.has(id)) this.#sessions.set(id, session);
		}
	}

	async disposeByOwner(ownerId: string): Promise<void> {
		const toShutdown: RegistrySession<TKernel>[] = [];
		const startingToShutdown: StartingRegistrySession<TKernel>[] = [];
		for (const session of [...this.#sessions.values()]) {
			if (!session.ownerIds.has(ownerId)) continue;
			if (session.ownerIds.size === 1) {
				toShutdown.push(session);
				continue;
			}
			session.ownerIds.delete(ownerId);
		}
		for (const [sessionKey, starting] of [...this.#startingSessions.entries()]) {
			if (this.#sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
			if (starting.ownerIds.size === 1) {
				this.#startingSessions.delete(sessionKey);
				startingToShutdown.push(starting);
				continue;
			}
			starting.ownerIds.delete(ownerId);
		}
		for (const session of toShutdown) {
			if (this.#sessions.get(session.sessionKey) === session) this.#sessions.delete(session.sessionKey);
		}
		const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			const session = result.value;
			if (this.#sessions.get(session.sessionKey) === session) this.#sessions.delete(session.sessionKey);
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
			logger.warn(`${this.languageLabel} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: session.sessionKey,
				cwd: session.cwd,
				reason,
			});
			if (!this.#sessions.has(session.sessionKey)) this.#sessions.set(session.sessionKey, session);
		}
	}

	async #acquireSession(
		sessionKey: string,
		sessionId: string,
		cwd: string,
		options: TOptions,
	): Promise<RegistrySession<TKernel>> {
		const existing = this.#sessions.get(sessionKey);
		if (existing) {
			attachSessionOwner(existing, sessionId, options.kernelOwnerId);
			return existing;
		}
		const starting = this.#startingSessions.get(sessionKey);
		if (starting) {
			attachSessionOwner(starting, sessionId, options.kernelOwnerId);
			return await this.waitForStartingSession(starting.promise, options);
		}
		let startingSession: StartingRegistrySession<TKernel> | undefined;
		const startup = (async () => {
			const kernel = await this.startKernel(cwd, options);
			const current = startingSession;
			if (!current) throw new this.cancelledErrorClass(false);
			const session: RegistrySession<TKernel> = {
				sessionKey,
				sessionId,
				cwd,
				kernel,
				ownerIds: new Set(current.ownerIds),
				hasFallbackOwner: current.hasFallbackOwner,
			};
			if (this.#startingSessions.get(sessionKey) === current) {
				this.#sessions.set(sessionKey, session);
			} else {
				await session.kernel.shutdown().catch(() => undefined);
				throw new this.cancelledErrorClass(false);
			}
			return session;
		})();
		startingSession = {
			ownerIds: new Set(),
			hasFallbackOwner: false,
			promise: startup,
		};
		attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
		this.#startingSessions.set(sessionKey, startingSession);
		try {
			return await this.waitForStartingSession(startup, options);
		} finally {
			if (this.#startingSessions.get(sessionKey) === startingSession) this.#startingSessions.delete(sessionKey);
		}
	}

	async #replaceSessionKernel(session: RegistrySession<TKernel>, cwd: string, options: TOptions): Promise<void> {
		this.beforeKernelReplacement(session);
		const old = session.kernel;
		const remaining = getRemainingTimeoutMs(options.deadlineMs);
		await old
			.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
			.catch(() => undefined);
		if (this.#sessions.get(session.sessionKey) !== session) {
			throw new this.cancelledErrorClass(false);
		}
		this.#requireRemainingTimeoutMs(options.deadlineMs);
		const next = await this.startKernel(cwd, options);
		if (this.#sessions.get(session.sessionKey) !== session) {
			await next.shutdown().catch(() => undefined);
			throw new this.cancelledErrorClass(false);
		}
		session.kernel = next;
	}

	async #resetSession(sessionKey: string): Promise<void> {
		const existing =
			this.#sessions.get(sessionKey) ??
			(await this.#startingSessions.get(sessionKey)?.promise.catch(() => undefined));
		if (!existing) return;
		this.#sessions.delete(sessionKey);
		const timeoutMs = this.resetShutdownTimeoutMs();
		await existing.kernel.shutdown(timeoutMs !== undefined ? { timeoutMs } : undefined).catch(() => undefined);
	}

	#requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
		const remainingMs = getRemainingTimeoutMs(deadlineMs);
		if (remainingMs === undefined) return undefined;
		if (remainingMs <= 0) {
			throw new this.cancelledErrorClass(true);
		}
		return remainingMs;
	}
}

// ---------------------------------------------------------------------------
// Base executor implementation
// ---------------------------------------------------------------------------

export interface ExecuteWithKernelBaseParams<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
> {
	kernel: GenericKernel<TEnv>;
	code: string;
	options: TOptions | undefined;
	/** Prefix for the per-execution run id (e.g. `"py"`, `"rb"`, `"jl"`). */
	runIdPrefix: string;
	/** Human-readable language label used in the failure log line. */
	errorLogLabel: string;
	/**
	 * Julia surfaces eval-timeout control events through its normal status path,
	 * so they must NOT be filtered out the way the JS-status backends do.
	 */
	isJulia?: boolean;
	cancelledErrorClass: CancelledErrorClass;
	buildKernelEnvPatch: (options: TOptions) => TEnv;
	formatKernelTimeoutAnnotation: (executionTimeoutMs: number | undefined, kernelKilled: boolean) => string;
	formatTimeoutAnnotation: (executionTimeoutMs: number | undefined) => string | undefined;
	/**
	 * Override how the wall-clock deadline is derived from options. Defaults to
	 * {@link getExecutionDeadlineMs}; Julia passes the pre-computed `deadlineMs`
	 * straight through instead of re-deriving from `timeoutMs`.
	 */
	resolveDeadlineMs?: (options: TOptions | undefined) => number | undefined;
}

export async function executeWithKernelBase<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
>(params: ExecuteWithKernelBaseParams<TOptions, TEnv>): Promise<KernelExecutionResult> {
	const {
		kernel,
		code,
		options,
		runIdPrefix,
		errorLogLabel,
		isJulia,
		cancelledErrorClass,
		buildKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
		resolveDeadlineMs,
	} = params;

	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});

	const displayOutputs: KernelDisplayOutput[] = [];
	const deadlineMs = (resolveDeadlineMs ?? getExecutionDeadlineMs)(options);
	let executionTimeoutMs: number | undefined;

	const collectDisplay = (output: KernelDisplayOutput): void => {
		if (output.type === "status") {
			options?.onStatus?.(output.event);
			if (!isJulia && isEvalTimeoutControlEvent(output.event)) return;
		}
		displayOutputs.push(output);
	};

	const emitStatus: (event: JsStatusEvent) => void =
		options?.emitStatus ?? (event => collectDisplay({ type: "status", event }));
	const runId = `${runIdPrefix}-${crypto.randomUUID()}`;
	const unregisterBridge =
		options?.toolSession && options?.bridgeSessionId
			? registerPyToolBridge(options.bridgeSessionId, runId, {
					toolSession: options.toolSession,
					signal: options.signal,
					emitStatus,
				})
			: null;

	try {
		const remainingMs = getRemainingTimeoutMs(deadlineMs);
		if (remainingMs !== undefined) {
			if (remainingMs <= 0) {
				throw new cancelledErrorClass(true);
			}
			executionTimeoutMs = remainingMs;
		}

		const result = await kernel.execute(code, {
			cwd: options?.cwd,
			env: buildKernelEnvPatch(options ?? ({} as TOptions)),
			id: runId,
			signal: options?.signal,
			timeoutMs: executionTimeoutMs,
			onChunk: text => sink.push(text),
			onDisplay: output => collectDisplay(output),
		});

		if (result.cancelled) {
			const annotation = result.timedOut
				? formatKernelTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs, result.kernelKilled ?? false)
				: undefined;
			const dumped = await sink.dump(annotation);
			return {
				exitCode: undefined,
				cancelled: true,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: !!result.stdinRequested,
			};
		}

		if (result.stdinRequested) {
			const dumped = await sink.dump("Kernel requested stdin; interactive input is not supported.");
			return {
				exitCode: 1,
				cancelled: false,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: true,
			};
		}

		const exitCode = result.status === "ok" ? 0 : 1;
		const dumped = await sink.dump();
		return {
			exitCode,
			cancelled: false,
			truncated: dumped.truncated,
			output: dumped.output,
			artifactId: dumped.artifactId ?? undefined,
			totalLines: dumped.totalLines,
			totalBytes: dumped.totalBytes,
			outputLines: dumped.outputLines,
			outputBytes: dumped.outputBytes,
			displayOutputs,
			stdinRequested: false,
		};
	} catch (err) {
		if (isCancellationError(err, cancelledErrorClass) || options?.signal?.aborted) {
			const timedOut = isTimedOutCancellation(err, cancelledErrorClass, options?.signal);
			const dumped = await sink.dump(
				timedOut ? formatTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs) : undefined,
			);
			return {
				exitCode: undefined,
				cancelled: true,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: false,
			};
		}
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error(`${errorLogLabel} execution failed`, { error: error.message });
		throw error;
	} finally {
		unregisterBridge?.();
	}
}
