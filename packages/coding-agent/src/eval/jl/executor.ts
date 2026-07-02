import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import {
	createCancelledKernelResult,
	executeWithKernelBase,
	KernelSessionRegistry,
	type RegistrySession,
} from "../executor-base";
import { ensurePyToolBridge, type PyToolBridgeInfo } from "../py/tool-bridge";
import type { EvalDisplayOutput, EvalStatusEvent } from "../types";
import {
	checkJuliaKernelAvailability,
	JuliaKernel,
	type KernelExecuteOptions,
	type KernelExecuteResult,
} from "./kernel";
import { resolveExplicitJuliaRuntime } from "./runtime";

const SHUTDOWN_GRACE_MS = 1_000;

export interface JuliaExecutorOptions {
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	artifactsDir?: string;
	localRoots?: Record<string, string>;
	interpreter?: string;
	onChunk?: (text: string) => void | Promise<void>;
	onStatus?: (event: EvalStatusEvent) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	kernelOwnerId?: string;
	reset?: boolean;
	toolSession?: ToolSession;
	bridge?: PyToolBridgeInfo;
	bridgeSessionId?: string;
	artifactId?: string;
}

export interface JuliaKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface JuliaResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
	stdinRequested: boolean;
}


class JuliaExecutionCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "Julia execution timed out" : "Julia execution cancelled");
		this.name = "JuliaExecutionCancelledError";
	}
}


function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitJuliaRuntime(interpreter, cwd, {}).juliaPath;
	try {
		return path.resolve(resolved);
	} catch {
		return resolved;
	}
}

function buildSessionKey(sessionId: string, cwd: string, interpreter: string | undefined): string {
	const normalizedCwd = normalizeSessionCwd(cwd);
	const normalizedInterpreter = normalizeExplicitInterpreter(normalizedCwd, interpreter);
	return `${sessionId}::${normalizedCwd}::${normalizedInterpreter}`;
}

function isCancellationError(error: unknown): boolean {
	if (error instanceof JuliaExecutionCancelledError) return true;
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	if (
		error &&
		typeof error === "object" &&
		"name" in error &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	)
		return true;
	return false;
}

function isTimedOutCancellation(error: unknown, signal?: AbortSignal): boolean {
	if (error instanceof JuliaExecutionCancelledError) return error.timedOut;
	if (error instanceof Error && error.name === "TimeoutError") return true;
	if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError") return true;
	if (signal?.reason instanceof Error && signal.reason.name === "TimeoutError") return true;
	return false;
}

function getExecutionDeadlineMs(options?: Pick<JuliaExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs !== undefined && options.timeoutMs > 0) return Date.now() + options.timeoutMs;
	return undefined;
}

function getRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return Math.max(0, deadlineMs - Date.now());
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	const remaining = getRemainingTimeoutMs(deadlineMs);
	if (remaining !== undefined && remaining <= 0) {
		throw new JuliaExecutionCancelledError(true);
	}
	return remaining;
}

async function waitForPromiseWithCancellation<T>(
	promise: Promise<T>,
	options: Pick<JuliaExecutorOptions, "signal" | "deadlineMs">,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new JuliaExecutionCancelledError(isTimedOutCancellation(options.signal.reason, options.signal));
	}
	const cleanups: Array<() => void> = [];
	const { promise: cancelPromise, reject } = Promise.withResolvers<never>();

	if (options.signal) {
		const onAbort = () => {
			reject(new JuliaExecutionCancelledError(isTimedOutCancellation(options.signal?.reason, options.signal)));
		};
		options.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
	}

	const deadlineMs = options.deadlineMs;
	if (typeof deadlineMs === "number" && deadlineMs > Date.now()) {
		const timeout = setTimeout(() => {
			reject(new JuliaExecutionCancelledError(true));
		}, deadlineMs - Date.now());
		timeout.unref?.();
		cleanups.push(() => clearTimeout(timeout));
	}

	try {
		return await Promise.race([promise, cancelPromise]);
	} finally {
		for (const cleanup of cleanups) cleanup();
	}
}

function formatTimeoutAnnotation(timeoutMs?: number): string | undefined {
	if (timeoutMs === undefined) return undefined;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[cell timed out after ${rounded}s]`;
}

function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const explanation = kernelKilled ? "; active subprocess terminated to recover" : "; kernel is still running";
	if (timeoutMs === undefined) return `[execution timed out${explanation}]`;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[execution timed out after ${rounded}s${explanation}]`;
}

function createCancelledJuliaResult(_timedOut: boolean, timeoutMs?: number): JuliaResult {
	const output = formatTimeoutAnnotation(timeoutMs) ?? "[execution cancelled]\n";
	return createCancelledKernelResult(output);
}

function buildKernelEnvPatch(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridge?: PyToolBridgeInfo;
	bridgeSessionId?: string;
	localRoots?: Record<string, string>;
}): Record<string, string | undefined> {
	const patch: Record<string, string | undefined> = {};
	if (options.sessionFile) patch.PI_SESSION_FILE = options.sessionFile;
	if (options.artifactsDir) patch.PI_ARTIFACTS_DIR = options.artifactsDir;
	if (options.bridge) {
		patch.PI_TOOL_BRIDGE_URL = options.bridge.url;
		patch.PI_TOOL_BRIDGE_TOKEN = options.bridge.token;
		patch.PI_TOOL_BRIDGE_SESSION = options.bridgeSessionId ?? "";
	}
	if (options.localRoots) {
		patch.PI_EVAL_LOCAL_ROOTS = JSON.stringify(options.localRoots);
	}
	return patch;
}

function buildKernelEnv(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridge?: PyToolBridgeInfo;
	bridgeSessionId?: string;
	localRoots?: Record<string, string>;
}): Record<string, string> | undefined {
	const patch = buildKernelEnvPatch(options);
	const keys = Object.keys(patch);
	if (keys.length === 0) return undefined;
	const realEnv: Record<string, string> = {};
	for (const key in patch) {
		const val = patch[key];
		if (typeof val === "string") realEnv[key] = val;
	}
	return realEnv;
}

async function startKernel(cwd: string, options: JuliaExecutorOptions): Promise<JuliaKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	const env: Record<string, string | undefined> = {};
	const patch = buildKernelEnv(options);
	if (patch) {
		for (const key in patch) {
			const value = patch[key];
			if (typeof value === "string") env[key] = value;
		}
	}
	return await JuliaKernel.start({
		cwd,
		interpreter: options.interpreter,
		env,
		signal: options.signal,
		deadlineMs: options.deadlineMs,
	});
}

class JuliaRegistry extends KernelSessionRegistry<JuliaKernel, JuliaExecutorOptions, JuliaResult> {
	protected readonly languageLabel = "Julia";
	protected readonly cancelledErrorClass = JuliaExecutionCancelledError;

	protected buildSessionKey(sessionId: string, cwd: string, options: JuliaExecutorOptions): string {
		return buildSessionKey(sessionId, cwd, options.interpreter);
	}

	protected resetShutdownTimeoutMs(): number {
		return SHUTDOWN_GRACE_MS;
	}

	protected beforeKernelReplacement(session: RegistrySession<JuliaKernel>): void {
		logger.warn("Julia subprocess died or is unresponsive; spawning fresh process", {
			sessionKey: session.sessionKey,
		});
	}

	protected async beforeExecution(sessionId: string, options: JuliaExecutorOptions): Promise<void> {
		await ensureToolBridge(options);
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = sessionId;
		}
	}

	protected clearResettingOnDisposeAll(): boolean {
		return true;
	}

	protected isSessionCancellationError(error: unknown): boolean {
		return isCancellationError(error);
	}

	protected isSessionTimedOutCancellation(error: unknown, signal?: AbortSignal): boolean {
		return isTimedOutCancellation(error, signal);
	}

	protected async waitForStartingSession(
		promise: Promise<RegistrySession<JuliaKernel>>,
		options: JuliaExecutorOptions,
	): Promise<RegistrySession<JuliaKernel>> {
		return await waitForPromiseWithCancellation(promise, options);
	}

	protected async startKernel(cwd: string, options: JuliaExecutorOptions): Promise<JuliaKernel> {
		return await startKernel(cwd, options);
	}

	protected async runOnKernel(kernel: JuliaKernel, code: string, options: JuliaExecutorOptions): Promise<JuliaResult> {
		return await executeJuliaWithKernel(kernel, code, options);
	}
}

const registry = new JuliaRegistry();

export async function disposeAllJuliaKernelSessions(): Promise<void> {
	await registry.disposeAll();
}

export async function disposeJuliaKernelSessionsByOwner(ownerId: string): Promise<void> {
	await registry.disposeByOwner(ownerId);
}

async function executeWithKernel(
	kernel: JuliaKernel,
	code: string,
	options: JuliaExecutorOptions | undefined,
): Promise<JuliaResult> {
	return executeWithKernelBase<JuliaExecutorOptions, Record<string, string | undefined>>({
		kernel,
		code,
		options,
		runIdPrefix: "jl",
		errorLogLabel: "Julia",
		isJulia: true,
		cancelledErrorClass: JuliaExecutionCancelledError,
		buildKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
		resolveDeadlineMs: opts => opts?.deadlineMs,
	});
}

async function ensureKernelAvailable(cwd: string, options: JuliaExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkJuliaKernelAvailability(cwd, options.interpreter),
		options,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Julia kernel unavailable");
	}
}

async function ensureToolBridge(options: JuliaExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("Failed to start Julia tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}


export async function executeJuliaWithKernel(
	kernel: JuliaKernel,
	code: string,
	options?: JuliaExecutorOptions,
): Promise<JuliaResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executeJulia(code: string, options?: JuliaExecutorOptions): Promise<JuliaResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: JuliaExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new JuliaExecutionCancelledError(
				isTimedOutCancellation(executionOptions.signal.reason, executionOptions.signal),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		return await registry.executeOnSession(code, executionOptions);
	} catch (err) {
		if (isCancellationError(err) || executionOptions.signal?.aborted) {
			return createCancelledJuliaResult(isTimedOutCancellation(err, executionOptions.signal));
		}
		throw err;
	}
}
