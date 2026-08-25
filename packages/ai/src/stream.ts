import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { isVertexExpressOpenAIUrl, isVertexRawPredictUrl, resolveVertexEndpointHost } from "@oh-my-pi/pi-catalog/hosts";
import {
	defaultSupportedEffort,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	requireSupportedEffort,
	resolveWireModelId,
} from "@oh-my-pi/pi-catalog/model-thinking";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@oh-my-pi/pi-catalog/provider-models";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";
import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";
import {
	$env,
	$pickenv,
	getProviderInFlightRoot,
	isEnoent,
	isRecord,
	logger,
	withExtraCaFetch,
} from "@oh-my-pi/pi-utils";
import { getCustomApi } from "./api-registry";
import { createAuthRetryKeyState, isApiKeyResolver, resolveNextAuthRetryKey } from "./auth-retry";
import {
	boundCacheKeepalivePayload,
	CACHE_KEEPALIVE_STATE_KEY,
	type CacheKeepalivePolicy,
	type CacheKeepaliveShape,
	classifyCacheOutcome,
	DEFAULT_CACHE_KEEPALIVE_MAX_TOUCHES,
	evaluateWarm,
	LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES,
	nextWarmDeadlineMs,
	resolveCacheKeepaliveShape,
	type WarmDecision,
	warmRatesForPrefix,
} from "./cache";
import * as AIError from "./error";
import { ProviderHttpError } from "./error";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./error/rate-limit";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { MessageCreateParamsStreaming } from "./providers/anthropic-wire";
import { coworkFetch } from "./providers/cowork-fetch";
import type { CursorOptions } from "./providers/cursor";
import type { DevinOptions } from "./providers/devin";
import { isGitLabDuoModel, streamGitLabDuo } from "./providers/gitlab-duo";
import { type GitLabDuoWorkflowOptions, streamGitLabDuoWorkflow } from "./providers/gitlab-duo-workflow";
import type { GoogleOptions } from "./providers/google";
import { getVertexAccessToken } from "./providers/google-auth";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import { isKimiModel, streamKimi } from "./providers/kimi";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import { streamPiNative } from "./providers/pi-native-client";
// Heavy provider stream functions are imported lazily via register-builtins,
// which wraps each provider module in a dynamic import. This keeps the
// AWS SDK, google-auth-library, @google/genai, and
// other provider SDKs out of the CLI startup parse graph. The
// gitlab-duo / kimi / synthetic providers stay eager because their modules
// export routing predicates (isGitLabDuoModel, isKimiModel, isSyntheticModel)
// that must be callable synchronously before streaming begins, and their
// modules are thin wrappers with no heavy SDK dependencies.
import {
	streamAnthropic,
	streamAzureOpenAIResponses,
	streamBedrock,
	streamCursor,
	streamDevin,
	streamGoogle,
	streamGoogleGeminiCli,
	streamGoogleVertex,
	streamOllama,
	streamOpenAICodexResponses,
	streamOpenAICompletions,
	streamOpenAIResponses,
} from "./providers/register-builtins";
import { isSyntheticModel, streamSynthetic } from "./providers/synthetic";
import { getProviderDefinition, PROVIDER_REGISTRY } from "./registry";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	OptionsForApi,
	ProviderSessionState,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ToolChoice,
} from "./types";
import { resolveCacheRetention } from "./utils";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { isFoundryEnabled } from "./utils/foundry";
import { applyGlyphCodec } from "./utils/glyph-codec";
import { wrapLeakedThinkingStream } from "./utils/leaked-thinking-stream";
import { wrapFetchForProxy } from "./utils/proxy";
import { withRequestDebugFetch } from "./utils/request-debug";
import { withThinkingLoopGuard } from "./utils/thinking-loop";

function defaultFetchForModel(model: Model<Api>): FetchImpl {
	if (model.provider === "anthropic" && model.api === "anthropic-messages") return coworkFetch;
	return globalThis.fetch;
}

function isGoogleVertexAuthenticatedModel(model: Model<Api>): boolean {
	return (
		model.provider === "google-vertex" &&
		((model.api === "openai-completions" && isVertexExpressOpenAIUrl(model.baseUrl)) ||
			(model.api === "anthropic-messages" && isVertexRawPredictUrl(model.baseUrl)))
	);
}

/**
 * Whether {@link model} is an official first-party endpoint whose stream needs
 * no leaked-thinking healing — the official Anthropic API and the official
 * OpenAI / OpenAI-Codex endpoints return structured thinking blocks and never
 * leak reasoning idioms into the visible text channel.
 *
 * The gate is provider id **and** official endpoint URL: pointing
 * `provider: "anthropic"` (or `openai`) at a custom proxy via `models.yml`
 * still routes through {@link wrapLeakedThinkingStream}, since a third-party
 * gateway may well leak. URL checks are strict (exact origin / path boundary
 * or parsed hostname) — a substring match would accept lookalikes like
 * `https://api.openai.com.evil/`. Anthropic Foundry (`CLAUDE_CODE_USE_FOUNDRY`)
 * redirects an empty `baseUrl` to `FOUNDRY_BASE_URL`, so the check runs against
 * that effective endpoint — exempt only when it resolves to the official host.
 */
function isLeakedThinkingHealExempt(model: Model<Api>): boolean {
	switch (model.provider) {
		case "anthropic": {
			// Mirror resolveAnthropicBaseUrl's effective endpoint: Foundry redirects
			// an empty baseUrl to FOUNDRY_BASE_URL; otherwise an explicit non-official
			// model.baseUrl wins, then the ANTHROPIC_BASE_URL gateway fallback, then
			// the official default. Exempt only when the effective endpoint is official.
			if (isFoundryEnabled()) {
				const foundry = $env.FOUNDRY_BASE_URL?.trim();
				if (foundry) return isOfficialAnthropicApiUrl(foundry);
			}
			if (model.baseUrl && !isOfficialAnthropicApiUrl(model.baseUrl)) return false;
			return isOfficialAnthropicApiUrl($env.ANTHROPIC_BASE_URL?.trim() || model.baseUrl);
		}
		case "openai":
			return isOfficialOpenAIApiUrl(model.baseUrl);
		case "openai-codex":
			return isOfficialCodexApiUrl(model.baseUrl);
		default:
			return false;
	}
}

/** Strict official-OpenAI endpoint check; missing baseUrl defaults to `api.openai.com`. */
function isOfficialOpenAIApiUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

/** Strict official-Codex endpoint check; exact origin or a path boundary after {@link CODEX_BASE_URL}. */
export function isOfficialCodexApiUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	const lower = baseUrl.toLowerCase().replace(/\/+$/, "");
	return lower === CODEX_BASE_URL || lower.startsWith(`${CODEX_BASE_URL}/`);
}

/**
 * Apply live leaked-thinking healing unless {@link model} is an official
 * first-party endpoint ({@link isLeakedThinkingHealExempt}), which emits
 * structured thinking and needs no healing.
 */
function healLeakedThinking(model: Model<Api>, inner: AssistantMessageEventStream): AssistantMessageEventStream {
	return isLeakedThinkingHealExempt(model) ? inner : wrapLeakedThinkingStream(inner);
}

type ProviderInFlightLease = {
	path: string;
	stopHeartbeat: () => Promise<void>;
};

type ProviderInFlightLeaseInfo = {
	pid: number;
	timestamp: number;
	token: string;
};
type ProviderInFlightStaleLock = { token: string } | { mtimeMs: number };
type ProviderInFlightLockIdentity = { dev: number; ino: number; birthtimeMs: number };

const PROVIDER_INFLIGHT_LOCK_STALE_MS = 10_000;
const PROVIDER_INFLIGHT_LEASE_STALE_MS = 30_000;
const PROVIDER_INFLIGHT_HEARTBEAT_MS = 5_000;
const PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS = 250;
const PROVIDER_INFLIGHT_HEARTBEAT_FLUSH_TIMEOUT_MS = 1_000;
const PROVIDER_INFLIGHT_RELEASE_TIMEOUT_MS = 5_000;

let configuredProviderMaxInFlightRequests: Record<string, number> = {};
let providerInFlightRootOverride: string | undefined;
let providerInFlightHeartbeatMsOverride: number | undefined;
let providerInFlightHeartbeatFlushTimeoutMsOverride: number | undefined;
let providerInFlightHeartbeatWriterOverride:
	| ((writeProviderInFlightInfo: () => Promise<void>) => Promise<void>)
	| undefined;
let providerInFlightLeaseRemoverOverride: ((leasePath: string) => Promise<void>) | undefined;
let providerInFlightWaitObserverOverride: ((provider: string) => void) | undefined;

export function configureProviderMaxInFlightRequests(limits: Record<string, number> | undefined): void {
	configuredProviderMaxInFlightRequests = limits ?? {};
}

function resolveProviderInFlightLimit(
	provider: string,
	options?: Pick<StreamOptions, "maxInFlightRequests">,
): number | undefined {
	const limits = options?.maxInFlightRequests ?? configuredProviderMaxInFlightRequests;
	const value = limits[provider];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.max(1, Math.floor(value));
}

function providerInFlightRoot(): string {
	if (providerInFlightRootOverride) return providerInFlightRootOverride;
	return getProviderInFlightRoot();
}

function providerInFlightSegment(provider: string): string {
	return crypto.createHash("sha256").update(provider).digest("base64url");
}

function providerInFlightDir(provider: string): string {
	return path.join(providerInFlightRoot(), providerInFlightSegment(provider));
}

function providerInFlightSignalPath(provider: string): string {
	return path.join(providerInFlightDir(provider), ".wakeup");
}

function providerInFlightLockDir(provider: string): string {
	return `${providerInFlightDir(provider)}.lock`;
}

// `process.kill(pid, 0)` may throw for permission/sandbox reasons even when a
// process exists. Treat non-ESRCH failures as alive; timestamp expiry still
// reaps leases whose heartbeat stopped.
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function readProviderInFlightInfo(infoPath: string): Promise<ProviderInFlightLeaseInfo | null> {
	try {
		const content = await fs.readFile(infoPath, "utf-8");
		const parsed = JSON.parse(content) as Partial<ProviderInFlightLeaseInfo>;
		if (typeof parsed.pid !== "number" || typeof parsed.timestamp !== "number" || typeof parsed.token !== "string") {
			return null;
		}
		return { pid: parsed.pid, timestamp: parsed.timestamp, token: parsed.token };
	} catch {
		return null;
	}
}

async function writeProviderInFlightInfo(dir: string, token: string): Promise<void> {
	const info: ProviderInFlightLeaseInfo = { pid: process.pid, timestamp: Date.now(), token };
	const infoPath = path.join(dir, "info.json");
	const tempPath = path.join(dir, `.info-${process.pid}-${crypto.randomUUID()}.tmp`);
	try {
		// Unlike Bun.write, fs.writeFile does not recreate a lease directory that
		// was removed while a timed-out heartbeat was still pending.
		await fs.writeFile(tempPath, JSON.stringify(info), "utf8");
		await fs.rename(tempPath, infoPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function isProviderInFlightDirStale(dir: string, staleMs: number): Promise<boolean> {
	const info = await readProviderInFlightInfo(path.join(dir, "info.json"));
	if (info) {
		if (!isProcessAlive(info.pid)) return true;
		return Date.now() - info.timestamp > staleMs;
	}

	try {
		const stat = await fs.stat(path.join(dir, "info.json"));
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	try {
		const stat = await fs.stat(dir);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readProviderInFlightStaleLock(lockDir: string): Promise<ProviderInFlightStaleLock | null> {
	const infoPath = path.join(lockDir, "info.json");
	const info = await readProviderInFlightInfo(infoPath);
	if (info) return isProcessAlive(info.pid) ? null : { token: info.token };

	try {
		const stat = await fs.stat(lockDir);
		return Date.now() - stat.mtimeMs > PROVIDER_INFLIGHT_LOCK_STALE_MS ? { mtimeMs: stat.mtimeMs } : null;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function readProviderInFlightLockIdentity(lockDir: string): Promise<ProviderInFlightLockIdentity> {
	const stat = await fs.stat(lockDir);
	return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function isSameProviderInFlightLock(
	current: ProviderInFlightLockIdentity,
	expected: ProviderInFlightLockIdentity,
): boolean {
	if (current.dev !== expected.dev) return false;
	if (current.ino !== 0 || expected.ino !== 0) return current.ino === expected.ino;
	return current.birthtimeMs === expected.birthtimeMs;
}

async function releaseProviderInFlightStaleLock(lockDir: string, stale: ProviderInFlightStaleLock): Promise<void> {
	if ("token" in stale) {
		await releaseProviderInFlightLock(lockDir, stale.token);
		return;
	}

	const infoPath = path.join(lockDir, "info.json");
	if (await readProviderInFlightInfo(infoPath)) return;
	try {
		const stat = await fs.stat(lockDir);
		if (stat.mtimeMs !== stale.mtimeMs || Date.now() - stat.mtimeMs <= PROVIDER_INFLIGHT_LOCK_STALE_MS) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

// Best-effort token-checked release. A token mismatch means another process has
// already replaced the lock, so the fresh lock must be left intact.
async function releaseProviderInFlightLock(lockDir: string, token: string): Promise<void> {
	try {
		const info = await readProviderInFlightInfo(path.join(lockDir, "info.json"));
		if (!info || info.token !== token) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

async function releaseProviderInFlightLockDirIfSame(
	lockDir: string,
	identity: ProviderInFlightLockIdentity,
): Promise<void> {
	try {
		if (await readProviderInFlightInfo(path.join(lockDir, "info.json"))) return;
		const current = await readProviderInFlightLockIdentity(lockDir);
		if (!isSameProviderInFlightLock(current, identity)) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

async function acquireProviderInFlightLock(provider: string, signal?: AbortSignal): Promise<() => Promise<void>> {
	const lockDir = providerInFlightLockDir(provider);
	await fs.mkdir(path.dirname(lockDir), { recursive: true });

	while (true) {
		if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
		try {
			await fs.mkdir(lockDir);
			const lockIdentity = await readProviderInFlightLockIdentity(lockDir);
			const token = crypto.randomUUID();
			try {
				await writeProviderInFlightInfo(lockDir, token);
			} catch (error) {
				await releaseProviderInFlightLockDirIfSame(lockDir, lockIdentity);
				throw error;
			}
			return async () => {
				await releaseProviderInFlightLock(lockDir, token);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		const staleLock = await readProviderInFlightStaleLock(lockDir);
		if (staleLock) {
			await releaseProviderInFlightStaleLock(lockDir, staleLock);
			await signalProviderInFlightWaiters(provider);
			continue;
		}

		await waitForProviderInFlightSignal(provider, signal);
	}
}

async function cleanupProviderInFlightLeases(providerDir: string): Promise<number> {
	let active = 0;
	let entries: string[];
	try {
		entries = await fs.readdir(providerDir);
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}

	for (const entry of entries) {
		const leaseDir = path.join(providerDir, entry);
		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(leaseDir)).isDirectory();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!isDirectory) continue;
		if (await isProviderInFlightDirStale(leaseDir, PROVIDER_INFLIGHT_LEASE_STALE_MS)) {
			await fs.rm(leaseDir, { recursive: true, force: true });
			continue;
		}
		active++;
	}
	return active;
}

async function tryAcquireProviderInFlightLease(
	provider: string,
	limit: number,
	signal?: AbortSignal,
): Promise<ProviderInFlightLease | null> {
	const releaseLock = await acquireProviderInFlightLock(provider, signal);
	try {
		const dir = providerInFlightDir(provider);
		await fs.mkdir(dir, { recursive: true });
		const active = await cleanupProviderInFlightLeases(dir);
		if (active >= limit) return null;

		const leaseDir = path.join(dir, `${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
		const token = crypto.randomUUID();
		try {
			await fs.mkdir(leaseDir);
			await writeProviderInFlightInfo(leaseDir, token);
		} catch (error) {
			await removeProviderInFlightLeaseDir(leaseDir).catch(() => {});
			throw error;
		}
		let heartbeatActive = true;
		let heartbeatFlush = Promise.resolve();
		const touchHeartbeat = () => {
			if (!heartbeatActive) return;
			heartbeatFlush = heartbeatFlush
				.then(async () => {
					if (!heartbeatActive) return;
					const write = () => {
						if (!heartbeatActive) return Promise.resolve();
						return writeProviderInFlightInfo(leaseDir, token);
					};
					if (providerInFlightHeartbeatWriterOverride) {
						await providerInFlightHeartbeatWriterOverride(write);
					} else {
						await write();
					}
				})
				.catch(() => {});
		};
		const heartbeat = setInterval(
			touchHeartbeat,
			providerInFlightHeartbeatMsOverride ?? PROVIDER_INFLIGHT_HEARTBEAT_MS,
		);
		heartbeat.unref?.();
		return {
			path: leaseDir,
			stopHeartbeat: () => {
				heartbeatActive = false;
				clearInterval(heartbeat);
				return heartbeatFlush;
			},
		};
	} finally {
		await releaseLock();
	}
}

async function signalProviderInFlightWaitersInDir(dir: string): Promise<void> {
	try {
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, ".wakeup"), String(Date.now()));
	} catch {}
}

async function signalProviderInFlightWaiters(provider: string): Promise<void> {
	await signalProviderInFlightWaitersInDir(providerInFlightDir(provider));
}

function waitForProviderInFlightSignal(provider: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch"));
	const signalPath = providerInFlightSignalPath(provider);
	providerInFlightWaitObserverOverride?.(provider);
	const waitStarted = Date.now();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let watcher: fsSync.FSWatcher | undefined;
	const timer = setTimeout(() => finish(resolve), PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS);
	const finish = (settle: () => void) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		watcher?.close();
		signal?.removeEventListener("abort", onAbort);
		settle();
	};
	const onAbort = () => {
		finish(() => reject(signal?.reason ?? new AIError.AbortError("Provider request aborted before dispatch")));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		watcher = fsSync.watch(providerInFlightDir(provider), (_event, filename) => {
			if (filename === ".wakeup" || filename === null) {
				finish(resolve);
			}
		});
		void fs.stat(signalPath).then(
			stat => {
				if (stat.mtimeMs >= waitStarted) finish(resolve);
			},
			error => {
				if (!isEnoent(error)) finish(resolve);
			},
		);
	} catch {
		// Filesystem notifications are best-effort across platforms; the fallback
		// timer keeps stale-lock/lease cleanup progressing if an event is dropped.
	}
	return promise;
}

async function removeProviderInFlightLeaseDir(leasePath: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rm(leasePath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (isEnoent(error)) return;
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt < 2 && (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM")) {
				await Bun.sleep(25);
				continue;
			}
			throw error;
		}
	}
}

// Signal into the lease's OWN provider directory (derived from `lease.path`)
// rather than recomputing it from the current root. A release that lands after
// the in-flight root has been repointed (only the test seam does that) must not
// write `.wakeup` into an unrelated provider directory.
async function releaseProviderInFlightLease(lease: ProviderInFlightLease): Promise<void> {
	const heartbeatFlush = lease.stopHeartbeat();
	const flushTimeout = Promise.withResolvers<"timeout">();
	const flushTimer = setTimeout(
		() => flushTimeout.resolve("timeout"),
		providerInFlightHeartbeatFlushTimeoutMsOverride ?? PROVIDER_INFLIGHT_HEARTBEAT_FLUSH_TIMEOUT_MS,
	);
	flushTimer.unref?.();
	try {
		const outcome = await Promise.race([heartbeatFlush.then(() => "flushed" as const), flushTimeout.promise]);
		if (outcome === "timeout") {
			logger.warn("Provider in-flight heartbeat flush timed out; forcing lease cleanup", { path: lease.path });
		}
	} finally {
		clearTimeout(flushTimer);
	}

	const releaseTimeout = Promise.withResolvers<never>();
	const releaseTimer = setTimeout(
		() => releaseTimeout.reject(new Error("Provider in-flight lease cleanup timed out")),
		PROVIDER_INFLIGHT_RELEASE_TIMEOUT_MS,
	);
	releaseTimer.unref?.();
	try {
		const removeLease = providerInFlightLeaseRemoverOverride ?? removeProviderInFlightLeaseDir;
		await Promise.race([removeLease(lease.path), releaseTimeout.promise]);
	} finally {
		clearTimeout(releaseTimer);
	}
	// Wake-up is an optimization: waiters also poll every 250 ms. Do not let a
	// notification-file stall keep a completed provider request open.
	void signalProviderInFlightWaitersInDir(path.dirname(lease.path));
}

async function acquireProviderInFlightSlot(
	provider: string,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	if (limit === undefined) return async () => {};
	let loggedWait = false;
	while (true) {
		if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
		const lease = await tryAcquireProviderInFlightLease(provider, limit, signal);
		if (lease) return () => releaseProviderInFlightLease(lease);
		if (!loggedWait) {
			loggedWait = true;
			logger.debug("Provider in-flight limit blocked request", { provider, limit });
		}
		await waitForProviderInFlightSignal(provider, signal);
	}
}

export const __providerInFlightForTesting = {
	setRoot(root: string | undefined): void {
		providerInFlightRootOverride = root;
	},
	setHeartbeatTimings(timings: { heartbeatMs?: number; heartbeatFlushTimeoutMs?: number } | undefined): void {
		providerInFlightHeartbeatMsOverride = timings?.heartbeatMs;
		providerInFlightHeartbeatFlushTimeoutMsOverride = timings?.heartbeatFlushTimeoutMs;
	},
	setHeartbeatWriter(writer: ((writeProviderInFlightInfo: () => Promise<void>) => Promise<void>) | undefined): void {
		providerInFlightHeartbeatWriterOverride = writer;
	},
	setLeaseRemover(remover: ((leasePath: string) => Promise<void>) | undefined): void {
		providerInFlightLeaseRemoverOverride = remover;
	},
	setWaitObserver(observer: ((provider: string) => void) | undefined): void {
		providerInFlightWaitObserverOverride = observer;
	},
	providerDir(provider: string): string {
		return providerInFlightDir(provider);
	},
	lockDir(provider: string): string {
		return providerInFlightLockDir(provider);
	},
	async captureStaleLockRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		const stale = await readProviderInFlightStaleLock(lockDir);
		if (!stale) return null;
		return () => releaseProviderInFlightStaleLock(lockDir, stale);
	},
	async captureLockDirRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		try {
			const identity = await readProviderInFlightLockIdentity(lockDir);
			return () => releaseProviderInFlightLockDirIfSame(lockDir, identity);
		} catch {
			return null;
		}
	},
};

function withProviderInFlightLimit<TOptions extends Pick<StreamOptions, "signal" | "maxInFlightRequests">>(
	model: Model<Api>,
	options: TOptions | undefined,
	dispatch: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
	// Leaked-thinking healing folds in here — the one shared provider-dispatch
	// chokepoint — so the loop guard (which wraps this) sees healed events and all
	// provider exits are covered by one wrap. Official first-party providers are
	// exempt (see `healLeakedThinking`); healing is otherwise idempotent.
	const limit = resolveProviderInFlightLimit(model.provider, options);
	if (limit === undefined) return healLeakedThinking(model, dispatch());

	const outer = new AssistantMessageEventStream();
	void (async () => {
		let release: (() => Promise<void>) | undefined;
		let releasePromise: Promise<void> | undefined;
		const releaseOnce = () => {
			if (!release) return Promise.resolve();
			releasePromise ??= release();
			return releasePromise;
		};
		const releaseBestEffort = async () => {
			try {
				await releaseOnce();
			} catch (releaseError) {
				// The lease has stopped heartbeating and stale cleanup will reap it
				// within PROVIDER_INFLIGHT_LEASE_STALE_MS. Until then, its slot may
				// remain unavailable and waiters rely on the fallback poll.
				// Never replace a completed response or the provider's original error
				// with a coordination-directory cleanup failure.
				logger.warn("Provider in-flight permit release failed", {
					provider: model.provider,
					error: String(releaseError),
				});
			}
		};
		try {
			const startedWaitingAt = Date.now();
			release = await acquireProviderInFlightSlot(model.provider, limit, options?.signal);
			if (Date.now() - startedWaitingAt >= PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS) {
				logger.debug("Provider in-flight limit wait completed", { provider: model.provider, limit });
			}
			if (options?.signal?.aborted) {
				throw options.signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
			}
			const inner = healLeakedThinking(model, dispatch());
			let terminalEvent: AssistantMessageEvent | undefined;
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") {
					terminalEvent = event;
					break;
				}
				outer.push(event);
				if (outer.done) {
					await releaseBestEffort();
					return;
				}
			}
			const result = await inner.result();
			// Releasing the permit is part of request completion. Publishing the
			// result first lets an immediate follow-up turn contend with its own
			// still-live lease, which is particularly costly on Windows.
			await releaseBestEffort();
			if (!outer.done) {
				if (terminalEvent) outer.push(terminalEvent);
				else outer.end(result);
			}
		} catch (error) {
			await releaseBestEffort();
			if (!outer.done) outer.fail(error);
		}
	})();
	return outer;
}

function createVertexAuthenticatedFetch(options: StreamOptions | undefined): FetchImpl {
	const baseFetch = options?.fetch ?? fetch;
	const vertexFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const token = await getVertexAccessToken({ signal: options?.signal, fetch: baseFetch });
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		const rewritten = resolveVertexRequest(input);
		const url = rewritten instanceof Request ? rewritten.url : rewritten.toString();
		if (isVertexRawPredictUrl(url)) {
			const bodyText = await readVertexRequestBody(rewritten, init);
			const transformed = transformVertexAnthropicBody(bodyText);
			return baseFetch(url, {
				...init,
				method: init?.method ?? (rewritten instanceof Request ? rewritten.method : "POST"),
				headers,
				body: transformed,
			});
		}
		return baseFetch(rewritten, { ...init, headers });
	};
	return Object.assign(vertexFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

async function readVertexRequestBody(input: string | URL | Request, init: RequestInit | undefined): Promise<string> {
	if (input instanceof Request) return input.clone().text();
	const body = init?.body;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return "";
}

// Vertex Claude rejects the standard Anthropic body shape: the `model` field
// is encoded in the URL path and `anthropic_version: "vertex-2023-10-16"` is
// required in the JSON body instead of the `anthropic-version` HTTP header.
function transformVertexAnthropicBody(bodyText: string): string {
	if (!bodyText) return bodyText;
	try {
		const payload = JSON.parse(bodyText) as Record<string, unknown>;
		delete payload.model;
		payload.anthropic_version = "vertex-2023-10-16";
		return JSON.stringify(payload);
	} catch {
		return bodyText;
	}
}

function resolveVertexRequest(input: string | URL | Request): string | URL | Request {
	const project = $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	const location = $env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION;
	if (!project || !location) return input;

	const rewriteUrl = (url: string): string => {
		const hasPlaceholder =
			url.includes("{project}") ||
			url.includes("{location}") ||
			url.includes("%7Bproject%7D") ||
			url.includes("%7Blocation%7D");
		const host = resolveVertexEndpointHost(location);
		const rewritten = hasPlaceholder
			? url
					.replace("https://{location}-aiplatform.googleapis.com", `https://${host}`)
					.replace("https://%7Blocation%7D-aiplatform.googleapis.com", `https://${host}`)
					.replaceAll("{project}", encodeURIComponent(project))
					.replaceAll("%7Bproject%7D", encodeURIComponent(project))
					.replaceAll("{location}", encodeURIComponent(location))
					.replaceAll("%7Blocation%7D", encodeURIComponent(location))
			: url;
		return rewritten.replace(":streamRawPredict/v1/messages", ":streamRawPredict");
	};

	if (input instanceof Request) {
		const rewrittenUrl = rewriteUrl(input.url);
		return rewrittenUrl === input.url ? input : new Request(rewrittenUrl, input);
	}
	if (input instanceof URL) {
		const rewrittenUrl = rewriteUrl(input.toString());
		return rewrittenUrl === input.toString() ? input : new URL(rewrittenUrl);
	}
	return rewriteUrl(input);
}

type KeyResolver = string | (() => string | undefined);

const LEGACY_ENV_KEYS: Record<string, KeyResolver> = {
	// Non-provider / search-tool keys and API-name keys not modeled as registry provider defs.
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	jina: "JINA_API_KEY",
	brave: "BRAVE_API_KEY",
	tinyfish: "TINYFISH_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
};

/**
 * Env fallbacks derived from the catalog table — the single source for plain
 * provider env-var names. Registry defs override with computed resolvers
 * (Foundry/ADC/Bedrock probes); legacy non-provider keys merge last.
 */
const CATALOG_ENTRY_ENV_KEYS = (CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).flatMap(provider => {
	const envVars = provider.envVars;
	if (!envVars || envVars.length === 0) return [];
	const resolver: KeyResolver = envVars.length === 1 ? envVars[0] : () => $pickenv(...envVars);
	return [[provider.id, resolver] as [string, KeyResolver]];
});

const serviceProviderMap: Record<string, KeyResolver> = {
	...Object.fromEntries(CATALOG_ENTRY_ENV_KEYS),
	...Object.fromEntries(
		PROVIDER_REGISTRY.flatMap(provider =>
			provider.envKeys != null ? [[provider.id, provider.envKeys] as [string, KeyResolver]] : [],
		),
	),
	...LEGACY_ENV_KEYS,
};

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 * Checks Bun.env, then cwd/.env, then ~/.env.
 */
export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	if (typeof resolver === "string") {
		return $env[resolver];
	}
	return resolver?.();
}

/**
 * Name of the environment variable that backs `getEnvApiKey` for a provider,
 * when that provider maps to a single named variable (e.g. `github-copilot` →
 * `COPILOT_GITHUB_TOKEN`). Returns undefined for providers whose env fallback
 * is computed (multi-var pickers, Vertex ADC / Bedrock probes, …) since no
 * single variable name describes the source.
 */
export function getEnvApiKeyName(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	return typeof resolver === "string" ? resolver : undefined;
}

/**
 * Enumerate every provider that has an env-var fallback for `getEnvApiKey`.
 * Used by `omp auth-broker migrate --include-env` to discover env-sourced keys
 * that should be uploaded to the broker.
 */
export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	if (!model.requiresGlyphTokenization) {
		return withThinkingLoopGuard(model, options, opts =>
			withProviderInFlightLimit(model, opts, () => streamDispatch(model, context, opts)),
		);
	}
	const codec = applyGlyphCodec(context);
	const execHandlers = options?.execHandlers;
	const wireOptions: OptionsForApi<TApi> | undefined =
		execHandlers === undefined ? options : { ...options, execHandlers: codec.wrapCursorExecHandlers(execHandlers) };
	return codec.wrap(
		withThinkingLoopGuard(model, wireOptions, opts =>
			withProviderInFlightLimit(model, opts, () => streamDispatch(model, codec.context, opts)),
		),
	);
}

function streamDispatch<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	const inputOptions = (options || {}) as StreamOptions;
	const baseOptions = { ...inputOptions, fetch: inputOptions.fetch ?? defaultFetchForModel(model) };
	const debugOptions = withExtraCaFetch(withRequestDebugFetch(baseOptions));
	const requestOptions = {
		...debugOptions,
		fetch: wrapFetchForProxy(debugOptions.fetch, model.provider),
	} as OptionsForApi<TApi>;
	assertExplicitOpenAIResponsesPromptCacheSupport(model, requestOptions);

	// Check custom API registry first (extension-provided APIs like "vertex-claude-api")
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.stream(model, context, requestOptions as StreamOptions);
	}

	if (isGitLabDuoModel(model)) {
		const apiKey = requestOptions.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new AIError.MissingApiKeyError(model.provider);
		}
		return streamGitLabDuo(model, context, {
			...(requestOptions as SimpleStreamOptions),
			apiKey,
		});
	}

	if (model.api === "gitlab-duo-agent") {
		const apiKey = (requestOptions as StreamOptions | undefined)?.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new AIError.MissingApiKeyError(model.provider);
		}
		return streamGitLabDuoWorkflow(model as Model<"gitlab-duo-agent">, context, {
			...(requestOptions as StreamOptions | undefined),
			apiKey,
		} as GitLabDuoWorkflowOptions);
	}

	// Vertex AI and Bedrock Converse authenticate outside the generic API-key path.
	if (model.api === "google-vertex") {
		return streamGoogleVertex(model as Model<"google-vertex">, context, requestOptions as GoogleVertexOptions);
	}
	if (model.api === "bedrock-converse-stream") {
		return streamBedrock(model as Model<"bedrock-converse-stream">, context, requestOptions as BedrockOptions);
	}

	const prepareRequest = getProviderDefinition(model.provider)?.prepareRequest;
	const prepared = prepareRequest?.(model as Model<Api>, requestOptions as StreamOptions);
	const providerModel = prepared?.model ?? (model as Model<Api>);
	const preparedOptions = prepared?.options ?? (requestOptions as StreamOptions);
	const apiKey = preparedOptions.apiKey || getEnvApiKey(providerModel.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(providerModel.provider);
	}
	const providerOptions = isGoogleVertexAuthenticatedModel(providerModel)
		? {
				...preparedOptions,
				apiKey: "vertex-adc",
				fetch: createVertexAuthenticatedFetch(preparedOptions),
			}
		: { ...preparedOptions, apiKey };

	const api: Api = providerModel.api;
	switch (api) {
		case "anthropic-messages": {
			const anthropicOptions = providerOptions as AnthropicOptions;
			return streamAnthropic(providerModel as Model<"anthropic-messages">, context, {
				...anthropicOptions,
				isOAuth: anthropicOptions.isOAuth ?? providerModel.isOAuth,
			});
		}

		case "openrouter": {
			const useResponses = $env.PI_OPENROUTER_RESPONSES !== "0";
			if (useResponses) {
				return streamOpenAIResponses(
					providerModel as Model<"openai-responses">,
					context,
					providerOptions as OptionsForApi<"openai-responses">,
				);
			}
			return streamOpenAICompletions(
				providerModel as Model<"openai-completions">,
				context,
				providerOptions as OptionsForApi<"openai-completions">,
			);
		}

		case "openai-completions":
			return streamOpenAICompletions(
				providerModel as Model<"openai-completions">,
				context,
				providerOptions as OptionsForApi<"openai-completions">,
			);

		case "openai-responses":
			return streamOpenAIResponses(
				providerModel as Model<"openai-responses">,
				context,
				providerOptions as OptionsForApi<"openai-responses">,
			);

		case "azure-openai-responses":
			return streamAzureOpenAIResponses(
				providerModel as Model<"azure-openai-responses">,
				context,
				providerOptions as OptionsForApi<"azure-openai-responses">,
			);

		case "openai-codex-responses":
			return streamOpenAICodexResponses(
				providerModel as Model<"openai-codex-responses">,
				context,
				providerOptions as OptionsForApi<"openai-codex-responses">,
			);

		case "google-generative-ai":
			return streamGoogle(providerModel as Model<"google-generative-ai">, context, providerOptions);

		case "google-gemini-cli":
			return streamGoogleGeminiCli(
				providerModel as Model<"google-gemini-cli">,
				context,
				providerOptions as GoogleGeminiCliOptions,
			);

		case "ollama-chat":
			return streamOllama(providerModel as Model<"ollama-chat">, context, providerOptions as OllamaChatOptions);

		case "cursor-agent":
			return streamCursor(providerModel as Model<"cursor-agent">, context, providerOptions as CursorOptions);

		case "devin-agent":
			return streamDevin(providerModel as Model<"devin-agent">, context, providerOptions as DevinOptions);

		default:
			throw new AIError.ConfigurationError(`Unhandled API: ${api}`);
	}
}

/** Maximum guarded attempts for a detected thinking loop. */
const THINKING_LOOP_MAX_ATTEMPTS = 3;
const THINKING_LOOP_RETRY_BASE_DELAY_MS = 500;
const THINKING_LOOP_RETRY_MAX_DELAY_MS = 8_000;

function isRetryableThinkingLoop(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		message.content.length === 0 &&
		AIError.is(message.errorId, AIError.Flag.ThinkingLoop)
	);
}

/**
 * Resolve a completion, re-sampling a thinking-loop stall for at most
 * {@link THINKING_LOOP_MAX_ATTEMPTS} guarded attempts. The loop guard raises an
 * empty `stopReason: "error"` stall; after the budget is spent that error is
 * returned unchanged. Detection is never disabled as a fallback, because an
 * unguarded retry can consume the remaining output budget and persist runaway
 * content. Non-stall results, including genuine errors, return immediately. A
 * caller abort during backoff propagates so cancellation surfaces as an abort,
 * never a stale stall result.
 */
async function resolveWithThinkingLoopRetries(
	signal: AbortSignal | undefined,
	dispatch: () => AssistantMessageEventStream,
): Promise<AssistantMessage> {
	let message = await dispatch().result();
	let thinkingLoopRetry = isRetryableThinkingLoop(message);
	for (let attempt = 1; thinkingLoopRetry && attempt < THINKING_LOOP_MAX_ATTEMPTS; attempt += 1) {
		// A caller abort surfaces as a thrown abort (never the stall, which would
		// misclassify as a 502): throwIfAborted before backoff, and scheduler.wait
		// rejects if the abort lands mid-delay.
		signal?.throwIfAborted();
		const delay = Math.min(THINKING_LOOP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), THINKING_LOOP_RETRY_MAX_DELAY_MS);
		await scheduler.wait(delay, { signal });
		message = await dispatch().result();
		thinkingLoopRetry = isRetryableThinkingLoop(message);
	}
	if (thinkingLoopRetry) signal?.throwIfAborted();
	return message;
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	return resolveWithThinkingLoopRetries(options?.signal, () => stream(model, context, options));
}

type AuthRetryFailure = {
	error: unknown;
	bufferedEvents: AssistantMessageEvent[];
	terminalEvent?: Extract<AssistantMessageEvent, { type: "error" }>;
};

function extractStatusFromAssistantError(message: AssistantMessage): number | undefined {
	if (message.errorStatus !== undefined) return message.errorStatus;
	if (!message.errorMessage) return undefined;
	return AIError.status({ message: message.errorMessage });
}

function isRetryableUpstreamError(
	model: Model<Api>,
	error: unknown,
	status: number | undefined,
	message: string | undefined,
): boolean {
	if (AIError.isAuthRetryableError(error)) return true;
	// 401 means the credential is bad; 403 is its valid-token twin (access
	// denied by plan, model policy, or org restriction — a sibling account may
	// not share it). Explicit account-scoped policy errors such as Codex
	// `cyber_policy` are likewise rotatable. The exact ChatGPT-account model
	// denial is rotatable only when its provider and requested model match.
	// Usage-limit phrasing (Codex's
	// "You have hit your ChatGPT usage limit", Anthropic's "usage_limit_reached",
	// Google's "resource_exhausted", OpenAI's "insufficient_quota") and 429s
	// without transient rate-limit wording mean this account is parked but a
	// sibling credential can usually pick the request up. Both are rotatable
	// via `onAuthError` — the auth-gateway maps hard auth failures to
	// `invalidateCredentialMatching` and temporary account constraints to a
	// credential block. Transient 429s ("Too many requests", per-minute caps)
	// classify as RATE_LIMIT_EXCEEDED in `parseRateLimitReason` and stay in the
	// provider's own backoff layer instead of burning siblings.
	if (AIError.isCodexChatGPTAccountPolicyError(error, model.provider, model.id)) return true;
	if (status === 401 || (status === 403 && !isConcurrencyCapExclusion(status, message))) return true;
	return isUsageLimitOutcome(status, message);
}

function createAssistantAuthError(message: AssistantMessage): Error {
	const text = message.errorMessage ?? "Provider authentication failed";
	const status = extractStatusFromAssistantError(message);
	const error =
		status === undefined
			? new AIError.ProviderResponseError(text, { kind: "runtime" })
			: new ProviderHttpError(text, status);
	return typeof message.errorId === "number" ? AIError.attach(error, message.errorId) : error;
}

function contextualizeAuthRetryError(model: Model<Api>, error: unknown): unknown {
	if (
		!error ||
		typeof error !== "object" ||
		!AIError.isCodexChatGPTAccountPolicyError(error, model.provider, model.id)
	) {
		return error;
	}
	return AIError.attach(error, AIError.create(AIError.Flag.AccountPolicy | AIError.Flag.ContentBlocked));
}

function emitBufferedEvents(stream: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
	for (const event of events) {
		stream.push(event);
	}
}

/** Nominal short-cache lifetime assumed when no learned TTL is supplied. */
const CACHE_KEEPALIVE_NOMINAL_TTL_S = 300;
/**
 * Network margin reserved before nominal expiry. With `CACHE_KEEPALIVE_NOMINAL_TTL_S`
 * and `CACHE_KEEPALIVE_WARM_FRACTION` this reproduces the historical 285s schedule
 * exactly: `min(300 * 0.95, 300 - 15) = 285`.
 */
const CACHE_KEEPALIVE_MARGIN_S = 15;
const CACHE_KEEPALIVE_WARM_FRACTION = 0.95;

interface CacheKeepalivePlan {
	/**
	 * Issue one bounded touch. Resolves to what the provider reported, or `undefined`
	 * only when the request never produced a response at all (transport error, abort).
	 *
	 * A touch that ran but did NOT verify still resolves, so telemetry can record the
	 * outcome that matters most — `miss-rebuilt` means the entry was gone and we just
	 * paid full write price to rebuild it. Reporting that as "no result" would hide the
	 * single most expensive thing the keepalive can do.
	 */
	touch(controller: AbortController): Promise<CacheKeepaliveTouchResult | undefined>;
}

interface CacheKeepaliveTouchResult {
	touchedAtMs: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	/**
	 * True only for `cacheRead > 0 && cacheWrite === 0` — the entry was present and
	 * reused. The chain continues only on a verified touch; anything else means we can
	 * no longer claim the cache is warm.
	 */
	verified: boolean;
}

/**
 * {@link CacheKeepaliveState.decide} answer meaning caller-supplied policy code threw.
 *
 * Deliberately distinct from `undefined`, which means "no policy, just go": conflating the
 * two would make a throwing `prefixTokens()` issue the very touch nobody could price.
 */
const CACHE_KEEPALIVE_POLICY_FAILED = Symbol("cache-keepalive-policy-failed");

/**
 * Keeps one physical provider cache entry warm across an idle gap.
 *
 * Two modes:
 * - **legacy** (no {@link CacheKeepalivePolicy}): a fixed budget of
 *   {@link LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES} touches, no cost reasoning. Byte-for-byte
 *   the behavior that shipped before, and it stays that way because
 *   {@link resolveCacheKeepaliveShape} answers with a shape for the providers added since
 *   *only* when a policy is supplied — so this mode is still reachable by exactly one
 *   thing, the Anthropic zero-output replay that already shipped.
 * - **policy**: every touch must first clear {@link evaluateWarm}. The chain then lives
 *   as long as it is worth more than it costs, which is both longer than 3 touches when
 *   the prefix is expensive and background work is alive, and *zero* touches when the
 *   turn is genuinely over.
 */
class CacheKeepaliveState implements ProviderSessionState {
	#controller: AbortController | undefined;
	#generation = 0;
	#plan: CacheKeepalivePlan | undefined;
	#touchesRemaining = 0;
	#touchIndex = 0;
	#cumulativeCostUsd = 0;
	#lastTouchAtMs = 0;
	#timer: NodeJS.Timeout | undefined;
	#policy: CacheKeepalivePolicy | undefined;
	#cost: ModelCost | undefined;
	#warmOutputTokens = 0;
	/**
	 * The fingerprint of the entry this chain protects, resolved per use.
	 *
	 * Never resolved at arm time: a session that supplies the physical cache fingerprint
	 * records it when the turn's message completes, which happens after the stream that
	 * arms this chain hands over its `done` event — so an arm-time read would file every
	 * touch under the *previous* turn's entry.
	 */
	#fingerprint: () => string = () => "";

	cancel(): void {
		this.#generation++;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#controller?.abort();
		this.#controller = undefined;
		this.#plan = undefined;
		this.#touchesRemaining = 0;
		this.#touchIndex = 0;
		this.#cumulativeCostUsd = 0;
	}

	arm(plan: CacheKeepalivePlan, cacheTouchedAtMs: number, config: CacheKeepaliveArmConfig): void {
		this.cancel();
		this.#plan = plan;
		this.#policy = config.policy;
		this.#cost = config.cost;
		this.#warmOutputTokens = config.warmOutputTokens;
		this.#fingerprint = config.fingerprint;
		// Every caller-supplied read in this method sits inside one try. `arm` runs inline on
		// the priming turn's `done` event, so an escaping throw would fail the real response
		// — the one thing a keepalive must never do. Both `maxTouches` and `ttlReady` may be
		// accessors, so reading them is running caller code.
		let ttlReady: Promise<unknown> | undefined;
		try {
			this.#touchesRemaining = config.policy
				? (config.policy.maxTouches ?? DEFAULT_CACHE_KEEPALIVE_MAX_TOUCHES)
				: LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES;
			ttlReady = config.policy?.ttlReady;
		} catch (error) {
			this.#abandon("armConfig", error);
			return;
		}
		// `#schedule` reads the policy too, and contains its own failures the same way.
		//
		// A policy may still be loading the learned TTL it wants this lease scheduled from
		// (the coding-agent reads it off disk). Scheduling now would silently use the
		// nominal lifetime and, on a route whose real retention is shorter, place the touch
		// after the entry has already expired — rebuilding the cache and ending the chain,
		// which is exactly the outcome the learned value exists to avoid. So wait for it.
		//
		// Deferring costs no coverage: the deadline is computed from `cacheTouchedAtMs`,
		// captured when the response arrived, so it is absolute and does not slide with the
		// time spent waiting here.
		if (ttlReady === undefined) {
			this.#schedule(cacheTouchedAtMs, this.#generation);
			return;
		}
		const generation = this.#generation;
		// `Promise.resolve` rather than `ttlReady.then(...)`: the value is caller-supplied and
		// may be a thenable whose `then` is itself an accessor. Assimilation reads it inside a
		// microtask, so a throw there becomes a rejection this handler owns instead of a
		// synchronous throw escaping into the pump.
		void Promise.resolve(ttlReady).then(
			() => {
				if (generation !== this.#generation) return;
				this.#schedule(cacheTouchedAtMs, generation);
			},
			(error: unknown) => {
				// A lease whose TTL evidence failed to load could still be scheduled from the
				// nominal value, but the policy that owns the value is the one that broke, so
				// the same termination rule as any other policy failure applies.
				if (generation !== this.#generation) return;
				this.#abandon("ttlReady", error);
			},
		);
	}

	close(): void {
		this.cancel();
	}

	/**
	 * End the chain because caller-supplied policy code threw, answering the sentinel so a
	 * caller in the middle of a decision can bail.
	 *
	 * Terminating beats retrying: a policy that cannot price this touch cannot be trusted
	 * to price the next one either, and rescheduling would spend real money on a decision
	 * nobody computed. The release is exactly the one a `should-not-warm` decision performs
	 * — plan cleared, budget zeroed, no timer pending — because the alternative is the
	 * wedge this guards against: a lease left armed with no pending timer, which never
	 * touches again and never releases its state.
	 */
	#abandon(stage: string, error: unknown): typeof CACHE_KEEPALIVE_POLICY_FAILED {
		logger.debug("cache keepalive policy callback threw; ending chain", { stage, error: String(error) });
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#plan = undefined;
		this.#touchesRemaining = 0;
		return CACHE_KEEPALIVE_POLICY_FAILED;
	}

	#schedule(cacheTouchedAtMs: number, generation: number): void {
		this.#lastTouchAtMs = cacheTouchedAtMs;
		let ttlS: number;
		let jitterKey: string;
		try {
			// Both reads reach caller-supplied code: `ttlSeconds` is a policy getter, and the
			// fingerprint resolver closes over the policy's own `fingerprint()`.
			ttlS = this.#policy?.ttlSeconds ?? CACHE_KEEPALIVE_NOMINAL_TTL_S;
			jitterKey = this.#fingerprint();
		} catch (error) {
			this.#abandon("schedule", error);
			return;
		}
		// Jitter is intentionally 0 here: the deadline must stay deterministic for a
		// single session. Spreading concurrent sessions is a fleet concern and belongs
		// with whoever supplies a policy.
		const touchAtMs = nextWarmDeadlineMs({
			lastTouchAtMs: cacheTouchedAtMs,
			ttlS,
			latencyP95S: 0,
			warmFraction: CACHE_KEEPALIVE_WARM_FRACTION,
			minimumMarginS: CACHE_KEEPALIVE_MARGIN_S,
			jitterFraction: 0,
			jitterKey,
		});
		if (touchAtMs === undefined) {
			// The believed retention cannot clear the round-trip margin, so no touch issued
			// from here could arrive while the entry is still alive. End the chain: the
			// alternative is a deadline of `cacheTouchedAtMs` — permanently due — which
			// re-fires a zero-delay timer after every verified touch and spends the whole
			// budget on coverage it can never buy.
			this.#plan = undefined;
			this.#touchesRemaining = 0;
			return;
		}
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				// Every policy-supplied call inside `#touch` is contained, so a rejection here
				// means an internal invariant broke — but a bare `void` would still surface it
				// as an unhandled rejection AND leave the lease armed with no pending timer.
				void this.#touch(generation).catch(error => this.#abandon("touch", error));
			},
			Math.max(0, touchAtMs - Date.now()),
		);
		this.#timer.unref?.();
	}

	/**
	 * Decide whether the next touch is worth issuing.
	 *
	 * `undefined` means "no policy, just go"; {@link CACHE_KEEPALIVE_POLICY_FAILED} means
	 * caller-supplied code threw and the lease is already released.
	 */
	#decide(): WarmDecision | typeof CACHE_KEEPALIVE_POLICY_FAILED | undefined {
		const policy = this.#policy;
		const cost = this.#cost;
		if (!policy || !cost) return undefined;
		try {
			const prefixTokens = policy.prefixTokens();
			return evaluateWarm({
				prefixTokens,
				// Resolve the context-length tier against the actual prefix: on a
				// long-context model, pricing a 400k-token prefix at the short-context rate
				// understates both the avoided loss and the touch cost.
				rates: warmRatesForPrefix(cost, prefixTokens),
				// Read fresh: background work finishing is what should end the chain.
				resumeProbability: policy.resumeProbability(),
				cumulativeWarmCostUsd: this.#cumulativeCostUsd,
				warmOutputTokens: this.#warmOutputTokens,
			});
		} catch (error) {
			return this.#abandon("decide", error);
		}
	}

	#report(decision: WarmDecision | undefined, result: CacheKeepaliveTouchResult | undefined): void {
		const policy = this.#policy;
		if (!policy?.onDecision || !decision) return;
		try {
			policy.onDecision({
				fingerprint: this.#fingerprint(),
				decision,
				outcome: result
					? classifyCacheOutcome({
							ok: true,
							cacheRead: result.cacheRead,
							cacheWrite: result.cacheWrite,
							inputTokens: 0,
						})
					: undefined,
				idleSeconds: Math.max(0, (Date.now() - this.#lastTouchAtMs) / 1000),
				cacheRead: result?.cacheRead ?? 0,
				cacheWrite: result?.cacheWrite ?? 0,
				costUsd: result?.costUsd ?? 0,
				touchIndex: this.#touchIndex,
				at: Date.now(),
			});
		} catch (error) {
			// Telemetry is advisory, so a throwing `onDecision` — or a throwing `fingerprint`
			// reached through it — does not end the chain here. A broken fingerprint still
			// terminates it at the next `#schedule`, which needs the same value and treats a
			// throw there as fatal.
			logger.debug("cache keepalive telemetry callback threw", { error: String(error) });
		}
	}

	async #touch(generation: number): Promise<void> {
		const plan = this.#plan;
		if (generation !== this.#generation || !plan || this.#touchesRemaining <= 0) return;

		this.#touchIndex++;
		const decision = this.#decide();
		// A policy failure has already released the lease; falling through would issue the
		// touch its own decision could not price.
		if (decision === CACHE_KEEPALIVE_POLICY_FAILED) return;
		if (decision && !decision.shouldWarm) {
			// Economically pointless: report why and let the entry expire.
			this.#report(decision, undefined);
			this.#plan = undefined;
			this.#touchesRemaining = 0;
			return;
		}

		const controller = new AbortController();
		this.#controller = controller;
		let result: CacheKeepaliveTouchResult | undefined;
		try {
			result = await plan.touch(controller);
		} catch (error) {
			if (generation === this.#generation && !controller.signal.aborted) {
				logger.debug("prompt-cache keepalive touch failed", { error: String(error) });
			}
		}
		if (generation !== this.#generation) return;

		this.#controller = undefined;
		this.#report(decision, result);
		// A touch that ran still costs money, verified or not — bill it before deciding.
		if (result) this.#cumulativeCostUsd += result.costUsd;
		if (!result?.verified) {
			// Either nothing came back, or the provider rebuilt the entry rather than
			// reading it. Never pretend the cache is still warm.
			this.#plan = undefined;
			this.#touchesRemaining = 0;
			return;
		}

		this.#touchesRemaining--;
		if (this.#touchesRemaining <= 0) {
			this.#plan = undefined;
			return;
		}
		this.#schedule(result.touchedAtMs, generation);
	}
}

interface CacheKeepaliveArmConfig {
	policy: CacheKeepalivePolicy | undefined;
	/** Rate card source; the context tier is resolved per decision against the prefix. */
	cost: ModelCost | undefined;
	warmOutputTokens: number;
	/**
	 * Resolves the identity of the entry being kept warm, called per use rather than
	 * once: the physical fingerprint is only known after the arming turn's message is
	 * complete.
	 */
	fingerprint: () => string;
}

function isAnthropicRefreshPayload(payload: unknown): payload is MessageCreateParamsStreaming {
	return (
		typeof payload === "object" &&
		payload !== null &&
		"messages" in payload &&
		Array.isArray(payload.messages) &&
		"max_tokens" in payload &&
		typeof payload.max_tokens === "number"
	);
}

function isShortAnthropicCacheControl(cacheControl: unknown): boolean {
	return (
		typeof cacheControl === "object" &&
		cacheControl !== null &&
		"type" in cacheControl &&
		cacheControl.type === "ephemeral" &&
		(!("ttl" in cacheControl) || cacheControl.ttl !== "1h")
	);
}

function hasShortAnthropicMessageBreakpoint(payload: MessageCreateParamsStreaming): boolean {
	for (const message of payload.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if ("cache_control" in block && isShortAnthropicCacheControl(block.cache_control)) return true;
		}
	}
	return false;
}

function isAnthropicGenerationEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "image_end":
			return true;
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		default:
			return false;
	}
}

function isAnthropicThinkingActive(model: Model<Api>, payload: MessageCreateParamsStreaming): boolean {
	if (payload.thinking) return payload.thinking.type !== "disabled";
	return model.thinking?.mode === "anthropic-adaptive" && payload.output_config?.effort != null;
}

/** Bedrock Converse bodies carry their output budget under `inferenceConfig`. */
interface BedrockKeepalivePayload {
	inferenceConfig?: { maxTokens?: number };
	system?: unknown;
	messages?: unknown;
	/** Where Bedrock carries Anthropic's `thinking` block. */
	additionalModelRequestFields?: unknown;
}

/** Everything a touch needs, resolved once at arm time from the captured wire body. */
interface CacheKeepaliveTouchSpec {
	/** The captured body with its output budget bounded; replayed verbatim otherwise. */
	boundedPayload: unknown;
	/** Anthropic non-streaming `max_tokens: 0` replay. */
	zeroOutput: boolean;
	/** Output budget for the touch request. */
	maxTokens: number;
	/** Whether the touch may abort at the first generated block. */
	mayAbortAtGeneration: boolean;
	/** Output tokens the touch is billed for; fed to the economic gate. */
	warmOutputTokens: number;
}

/** True when any block in a Bedrock Converse body carries a `cachePoint` marker. */
function hasBedrockCachePoint(payload: BedrockKeepalivePayload): boolean {
	if (Array.isArray(payload.system) && payload.system.some(block => isRecord(block) && "cachePoint" in block)) {
		return true;
	}
	if (!Array.isArray(payload.messages)) return false;
	return payload.messages.some(
		message =>
			isRecord(message) &&
			Array.isArray(message.content) &&
			message.content.some(block => isRecord(block) && "cachePoint" in block),
	);
}

/**
 * Output tokens a thinking-active Anthropic touch is *priced* at.
 *
 * That touch cannot ask for `max_tokens: 0` — Anthropic rejects a zero budget while
 * thinking is on — so it streams and aborts at the FIRST generation event. What it
 * actually emits is the handful of tokens Anthropic already reports on `message_start`,
 * which is why this is a small constant and not the request's `max_tokens`: that number
 * is the ceiling the request *permits* (64k-128k on current Claude models), not output
 * the touch ever buys. Pricing the ceiling added ~$1-$3 of imaginary output to every
 * decision, so {@link evaluateWarm} refused cache reads that cost cents and the
 * keepalive was effectively disabled for reasoning-enabled sessions — the default.
 *
 * Rounded up rather than down: under-pricing a touch would let the gate approve one
 * that does not pay for itself, which is the failure the gate exists to prevent.
 */
const ANTHROPIC_THINKING_TOUCH_OUTPUT_TOKENS = 8;

/**
 * Resolve how to bound a touch for `shape`, or `undefined` when the captured body is
 * not a recognizable cacheable request for it.
 *
 * `undefined` is the fail-closed path: better to never keep an entry warm than to
 * replay a body we do not understand.
 *
 * Only two providers publish a request-side "this created a cache entry" marker, and
 * both are checked here because they catch the no-entry case before a touch is armed at
 * all. Everywhere else caching is implicit and no such marker exists — so nothing is
 * invented for it. The arming precondition for those providers is the response's own
 * `usage.cacheRead + usage.cacheWrite > 0`, checked by
 * {@link streamSimpleWithCacheKeepalive} before this runs: the provider stating it
 * cached something is stronger evidence than any wire heuristic, which is why attempting
 * an implicit-cache provider is not speculative.
 */
function prepareCacheKeepaliveTouch(
	model: Model<Api>,
	shape: CacheKeepaliveShape,
	payload: unknown,
): CacheKeepaliveTouchSpec | undefined {
	if (shape.kind === "zero-output") {
		if (!isAnthropicRefreshPayload(payload) || !hasShortAnthropicMessageBreakpoint(payload)) return undefined;
		// `max_tokens: 0` is rejected while thinking is active, so that variant streams
		// and bails at the first generated block instead. Anthropic reports usage on
		// `message_start`, so aborting still yields the cache counters.
		if (isAnthropicThinkingActive(model, payload)) {
			return {
				boundedPayload: payload,
				zeroOutput: false,
				maxTokens: payload.max_tokens,
				mayAbortAtGeneration: true,
				// Priced by what the abort actually buys, never by `payload.max_tokens`.
				warmOutputTokens: ANTHROPIC_THINKING_TOUCH_OUTPUT_TOKENS,
			};
		}
		return {
			boundedPayload: { ...payload, max_tokens: 0 },
			zeroOutput: true,
			maxTokens: 0,
			mayAbortAtGeneration: false,
			warmOutputTokens: 0,
		};
	}

	if (!isRecord(payload)) return undefined;
	// Bedrock's explicit marker: no `cachePoint` in the body means this request created no
	// entry to keep warm. Cheap, and it fails before the economic gate ever prices a touch.
	if (model.api === "bedrock-converse-stream" && !hasBedrockCachePoint(payload as BedrockKeepalivePayload)) {
		return undefined;
	}
	// Anthropic's explicit marker, on the reseller/gateway endpoints that get a bounded
	// replay rather than the first-party `zero-output` one.
	if (
		model.api === "anthropic-messages" &&
		!hasShortAnthropicMessageBreakpoint(payload as MessageCreateParamsStreaming)
	) {
		return undefined;
	}
	const boundedPayload = boundCacheKeepalivePayload(model.api, shape, payload);
	if (!boundedPayload) return undefined;
	return {
		boundedPayload,
		zeroOutput: false,
		maxTokens: shape.maxTokens,
		// Never abort — see the drain rule on `createCacheKeepalivePlan`.
		mayAbortAtGeneration: false,
		warmOutputTokens: shape.maxTokens,
	};
}

/**
 * Build the bounded touch for one armed chain.
 *
 * `spec.mayAbortAtGeneration` is the load-bearing difference between providers:
 *
 * - Anthropic reports usage on `message_start`, so a thinking-active touch may abort
 *   at the first generated block and still learn whether the entry was read.
 * - Bedrock must be **drained to `done`**. It fills `cacheRead`/`cacheWrite` only from
 *   the trailing `metadata` event (`providers/amazon-bedrock.ts:735-744`), so cutting
 *   the stream at content start would discard the only proof a hit occurred and every
 *   touch would read as unverified. `providers/amazon-bedrock.ts:575` also converts an
 *   aborted signal into a thrown `AbortError`, surfacing as an outright failure. The
 *   bounded `maxTokens` keeps the drained body to a single token.
 */
function createCacheKeepalivePlan<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	spec: CacheKeepaliveTouchSpec,
): CacheKeepalivePlan {
	return {
		async touch(controller) {
			let cacheRead = 0;
			let cacheWrite = 0;
			let costUsd = 0;
			let touchedAtMs: number | undefined;
			let canceledAfterGenerationStarted = false;
			const response = streamSimpleRequest(model, context, {
				...options,
				acceptEmptyResponse: true,
				anthropicCacheRefreshRequest: spec.zeroOutput,
				cacheRetention: "short",
				maxTokens: spec.maxTokens,
				onPayload: () => spec.boundedPayload,
				onResponse: () => {
					touchedAtMs = Date.now();
				},
				onSseEvent: undefined,
				// A touch is not a turn: never let it inherit the keepalive flags and
				// recurse into arming another chain.
				anthropicCacheRefresh: false,
				cacheKeepalivePolicy: undefined,
				// Nor may it join the OpenAI Responses server-side conversation. A touch
				// replays the priming request's own history, so the delta against the live
				// chain baseline is empty — which sends
				// `buildOpenAIResponsesChainedParams` down its reset branch and wipes
				// `lastResponseId`/`lastParams` (`providers/openai-responses.ts:325-328`).
				// The touch then succeeds and installs ITS response id as the chain head
				// (`:863`), so the next real turn would chain from a discarded 1-token reply
				// — server-side conversation and all. A keepalive must be invisible to
				// everything except the cache clock, so it opts out of chaining entirely.
				statefulResponses: false,
				signal: controller.signal,
			});

			for await (const event of response) {
				if ("partial" in event) {
					cacheRead = event.partial.usage.cacheRead;
					cacheWrite = event.partial.usage.cacheWrite;
					// Bill from partial usage too, not just from `done`. A thinking-active touch
					// aborts at the first generation event and never reaches `done`, but its
					// cache read is fully billed by then (Anthropic prices `message_start`
					// usage). Reading the cost only from `done` left `costUsd` at 0 on exactly
					// that path, so cumulative spend never accrued, `evaluateWarm` could never
					// reach `economic-stop`, and the advertised termination bound silently
					// degraded to the `maxTouches` safety net. `done` still overwrites this
					// below whenever the touch gets there, so it stays authoritative.
					costUsd = event.partial.usage.cost.total;
				}
				if (event.type === "error") return undefined;
				if (event.type === "done") {
					cacheRead = event.message.usage.cacheRead;
					cacheWrite = event.message.usage.cacheWrite;
					costUsd = event.message.usage.cost.total;
					break;
				}
				if (spec.mayAbortAtGeneration && isAnthropicGenerationEvent(event)) {
					canceledAfterGenerationStarted = true;
					controller.abort();
					break;
				}
			}

			if (canceledAfterGenerationStarted) {
				try {
					await response.result();
				} catch (error) {
					if (!controller.signal.aborted) throw error;
				}
			}
			// The verified-touch rule: a read with no write proves the entry was present
			// and reused. Anything else — including HTTP 200 with no telemetry at all —
			// ends the chain rather than pretending the cache is still warm.
			//
			// Report the counters even when unverified. `miss-rebuilt` means the entry was
			// gone and this touch just paid full write price to recreate it; that is the
			// single most expensive thing the keepalive can do, so it must reach telemetry
			// rather than vanish as "no result". Only a request that never produced a
			// response at all resolves to `undefined`.
			if (touchedAtMs === undefined) return undefined;
			const verified = cacheRead > 0 && cacheWrite === 0;
			return { touchedAtMs, cacheRead, cacheWrite, costUsd, verified };
		},
	};
}

function streamSimpleWithCacheKeepalive<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	const providerSessionState = options?.providerSessionState;
	if (!options?.anthropicCacheRefresh || !providerSessionState) {
		return streamSimpleRequest(model, context, options);
	}

	const existingState = providerSessionState.get(CACHE_KEEPALIVE_STATE_KEY);
	if (existingState instanceof CacheKeepaliveState) {
		existingState.cancel();
	} else if (existingState) {
		return streamSimpleRequest(model, context, options);
	}
	// A `long` (1h) entry outlives any plausible idle gap, and `none` never creates one.
	const shape = resolveCacheKeepaliveShape(model, {
		officialAnthropicEndpoint: isLeakedThinkingHealExempt(model),
		// Providers the keepalive gained after Anthropic are opt-in: a caller with no policy
		// is asking for the pre-policy behavior, which for those providers was no keepalive.
		economicPolicySupplied: options.cacheKeepalivePolicy !== undefined,
	});
	if (!shape || resolveCacheRetention(options.cacheRetention) !== "short") {
		return streamSimpleRequest(model, context, options);
	}

	const keepaliveState = existingState ?? new CacheKeepaliveState();
	if (!existingState) providerSessionState.set(CACHE_KEEPALIVE_STATE_KEY, keepaliveState);

	let cacheTouchedAtMs: number | undefined;
	let capturedPayload: unknown;
	const inner = streamSimpleRequest(model, context, {
		...options,
		onPayload: async (payload, payloadModel) => {
			const replacement = await options?.onPayload?.(payload, payloadModel);
			// Capture what actually goes on the wire, including any hook's replacement:
			// a touch must replay the same bytes the provider cached.
			capturedPayload = replacement ?? payload;
			return replacement;
		},
		onResponse: async (response, responseModel) => {
			cacheTouchedAtMs = Date.now();
			await options?.onResponse?.(response, responseModel);
		},
	});
	const outer = new AssistantMessageEventStream();
	const armKeepalive = (message: AssistantMessage): void => {
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			// No cache activity at all means there is no entry to keep warm.
			message.usage.cacheRead + message.usage.cacheWrite <= 0 ||
			cacheTouchedAtMs === undefined
		) {
			return;
		}
		const spec = prepareCacheKeepaliveTouch(model, shape, capturedPayload);
		if (!spec) return;
		keepaliveState.arm(createCacheKeepalivePlan(model, context, options, spec), cacheTouchedAtMs, {
			policy: options.cacheKeepalivePolicy,
			cost: model.cost,
			warmOutputTokens: spec.warmOutputTokens,
			// Prefer the physical cache entry over the routing key. `promptCacheKey` and
			// `sessionId` say where a request is *routed*, not which entry it reads, so
			// keying touches on them files evidence under a different clock than the
			// ordinary observations recorded for the same entry — and a later hit or miss
			// can then no longer measure its idle age against the preceding touch, which is
			// the whole point of the persisted TTL evidence. Lazily resolved: the session
			// only knows the fingerprint after this turn's message completes, which is
			// strictly after this callback runs.
			fingerprint: () =>
				options.cacheKeepalivePolicy?.fingerprint?.() ?? options.promptCacheKey ?? options.sessionId ?? model.id,
		});
	};

	void (async () => {
		try {
			for await (const event of inner) {
				if (event.type === "done") armKeepalive(event.message);
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) {
				const result = await inner.result();
				armKeepalive(result);
				outer.end(result);
			}
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (!model.requiresGlyphTokenization) {
		return streamSimpleWithCacheKeepalive(model, context, options);
	}
	const codec = applyGlyphCodec(context);
	const execHandlers = options?.cursorExecHandlers ?? options?.execHandlers;
	const wrappedExecHandlers = execHandlers === undefined ? undefined : codec.wrapCursorExecHandlers(execHandlers);
	const wireOptions =
		wrappedExecHandlers === undefined
			? options
			: {
					...options,
					execHandlers: wrappedExecHandlers,
					cursorExecHandlers: wrappedExecHandlers,
				};
	return codec.wrap(streamSimpleWithCacheKeepalive(model, codec.context, wireOptions));
}

function streamSimpleRequest<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const inputOptions = (options || {}) as SimpleStreamOptions;
	const baseOptions = { ...inputOptions, fetch: inputOptions.fetch ?? defaultFetchForModel(model) };
	const debugOptions = withExtraCaFetch(withRequestDebugFetch(baseOptions));
	const requestOptions = {
		...debugOptions,
		fetch: wrapFetchForProxy(debugOptions.fetch, model.provider),
	} as SimpleStreamOptions;

	const apiKeyResolver = isApiKeyResolver(requestOptions?.apiKey) ? requestOptions.apiKey : undefined;
	if (apiKeyResolver) {
		const outer = new AssistantMessageEventStream();
		const signal = requestOptions?.signal;
		// One inner attempt against a resolved key, or against the Bedrock AWS
		// credential chain when its optional resolver has no stored bearer key.
		// Retryable auth failures are buffered until replay is safe.
		const runAttempt = async (apiKey?: string): Promise<AuthRetryFailure | undefined> => {
			const bufferedEvents: AssistantMessageEvent[] = [];
			let emittedReplayUnsafeEvent = false;
			const flushBuffered = (): void => {
				emitBufferedEvents(outer, bufferedEvents);
				bufferedEvents.length = 0;
			};

			try {
				const attemptOptions = { ...requestOptions, apiKey };
				const inner = streamSimpleRequest(model, context, attemptOptions);
				for await (const event of inner) {
					if (!emittedReplayUnsafeEvent && event.type === "start") {
						bufferedEvents.push(event);
						continue;
					}
					if (
						!emittedReplayUnsafeEvent &&
						event.type === "error" &&
						isRetryableUpstreamError(
							model,
							event.error,
							extractStatusFromAssistantError(event.error),
							event.error.errorMessage,
						)
					) {
						return {
							error: contextualizeAuthRetryError(model, createAssistantAuthError(event.error)),
							bufferedEvents,
							terminalEvent: event,
						};
					}
					flushBuffered();
					emittedReplayUnsafeEvent = true;
					outer.push(event);
					if (outer.done) return undefined;
				}
				flushBuffered();
				if (!outer.done) outer.end(await inner.result());
			} catch (error) {
				if (
					!emittedReplayUnsafeEvent &&
					isRetryableUpstreamError(
						model,
						error,
						AIError.status(error),
						error instanceof Error ? error.message : undefined,
					)
				) {
					return { error: contextualizeAuthRetryError(model, error), bufferedEvents };
				}
				flushBuffered();
				outer.fail(error);
			}
			return undefined;
		};
		const emitFailure = (failure: AuthRetryFailure): void => {
			emitBufferedEvents(outer, failure.bufferedEvents);
			if (failure.terminalEvent) {
				outer.push(failure.terminalEvent);
			} else {
				outer.fail(failure.error);
			}
		};

		void (async () => {
			let lastKey: string | undefined;
			try {
				lastKey = (await apiKeyResolver({ lastChance: false, error: undefined, signal })) || undefined;
			} catch (error) {
				// A thrown resolver is a broker/OAuth/network failure, not a missing
				// key — surface the cause instead of masking it as "No API key".
				outer.fail(
					new AIError.ConfigurationError(
						`Failed to resolve API key for provider ${model.provider}: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					),
				);
				return;
			}
			if (lastKey === undefined) {
				if (getProviderDefinition(model.provider)?.allowsMissingApiKey) {
					const failure = await runAttempt();
					if (failure) emitFailure(failure);
					return;
				}
				outer.fail(new AIError.MissingApiKeyError(model.provider));
				return;
			}
			const retryState = createAuthRetryKeyState(lastKey);
			let failure = await runAttempt(lastKey);
			if (!failure) return;
			while (true) {
				// Caller aborted between attempts: don't mint a fresh token or fire
				// another doomed request — emit the captured failure instead.
				if (signal?.aborted) break;
				const nextKey = await resolveNextAuthRetryKey(retryState, apiKeyResolver, failure.error, signal);
				if (nextKey === undefined) break;
				const next = await runAttempt(nextKey);
				if (!next) return;
				failure = next;
			}
			emitFailure(failure);
		})();
		return outer;
	}

	// Pi-native transport short-circuits the per-provider dispatch entirely:
	// the gateway resolves provider + credential server-side, so we don't
	// need an `apiKey` from `getEnvApiKey` here — `options.apiKey` carries
	// the gateway bearer instead. Comes BEFORE the custom-API check so
	// extension-registered APIs can't accidentally override a configured
	// pi-native transport.
	if (model.transport === "pi-native") {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => {
				const nativeOptions =
					model.api === "bedrock-converse-stream"
						? {
								...(opts ?? {}),
								guardrailIdentifier: model.guardrailIdentifier ?? opts?.guardrailIdentifier,
								guardrailVersion: model.guardrailVersion ?? opts?.guardrailVersion,
								guardrailTrace: model.guardrailTrace ?? opts?.guardrailTrace,
							}
						: opts;
				return streamPiNative(model, context, nativeOptions);
			}),
		);
	}

	// Check custom API registry (extension-provided APIs)
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => customApiProvider.streamSimple(model, context, opts)),
		);
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	} else if (getProviderDefinition(model.provider)?.allowsMissingApiKey) {
		const providerOptions = mapOptionsForApi(
			model,
			requestOptions,
			typeof requestOptions.apiKey === "string" ? requestOptions.apiKey : getEnvApiKey(model.provider),
		);
		return stream(model, context, providerOptions);
	}

	// The resolver form is handled by the wrapper above; only a static string
	// key reaches this point.
	const apiKey =
		(typeof requestOptions?.apiKey === "string" ? requestOptions.apiKey : undefined) || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	// GitLab Duo - wraps Anthropic/OpenAI behind GitLab AI Gateway direct access tokens
	if (isGitLabDuoModel(model)) {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () =>
				streamGitLabDuo(model, context, {
					...opts,
					apiKey,
				}),
			),
		);
	}

	// GitLab Duo Workflow - IDE workflow protocol + WebSocket action bridge
	if (model.api === "gitlab-duo-agent") {
		// Does not route through withProviderInFlightLimit, so heal explicitly.
		return withThinkingLoopGuard(model, requestOptions, opts =>
			healLeakedThinking(
				model,
				streamGitLabDuoWorkflow(model as Model<"gitlab-duo-agent">, context, {
					...opts,
					apiKey,
				}),
			),
		);
	}

	// Kimi Code - route to dedicated handler that wraps OpenAI or Anthropic API
	if (isKimiModel(model)) {
		// streamKimi handles openai/anthropic format mapping internally, but the
		// mandatory-reasoning clamp is a request-shaping concern owned here: K3's
		// `supports_thinking_type: "only"` endpoint rejects disabled/omitted
		// thinking, so clamp disabled requests to the lowest supported effort
		// (mirrors the mapOptionsForApi path every other provider takes).
		const kimiOptions = normalizeMandatoryReasoningOptions(model, requestOptions);
		return withThinkingLoopGuard(model, kimiOptions, opts =>
			withProviderInFlightLimit(model, opts, () =>
				streamKimi(model as Model<"openai-completions">, context, {
					...opts,
					apiKey,
					format: opts?.kimiApiFormat,
				}),
			),
		);
	}

	// Synthetic - route to dedicated handler that wraps OpenAI or Anthropic API
	if (isSyntheticModel(model)) {
		// Pass raw SimpleStreamOptions - streamSynthetic handles mapping internally.
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () =>
				streamSynthetic(model as Model<"openai-completions">, context, {
					...opts,
					apiKey,
					format: opts?.syntheticApiFormat ?? "openai",
				}),
			),
		);
	}
	const providerOptions = mapOptionsForApi(model, requestOptions, apiKey);
	return stream(model, context, providerOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return resolveWithThinkingLoopRetries(options?.signal, () => streamSimple(model, context, options));
}

const MIN_OUTPUT_TOKENS = 1024;
// Fallback total output cap for models whose catalog entry has no maxTokens.
const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;
function maxTokensWithThinkingBudget(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number | null,
	thinkingBudget: number,
): number {
	const uncappedMaxTokens = baseMaxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : baseMaxTokens + thinkingBudget;
	return Math.min(uncappedMaxTokens, modelMaxTokens ?? Number.POSITIVE_INFINITY);
}
export const OUTPUT_FALLBACK_BUFFER = 4000;
const ANTHROPIC_USE_INTERLEAVED_THINKING = Bun.env.PI_NO_INTERLEAVED_THINKING !== "1";

export const ANTHROPIC_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 32768,
};

const GOOGLE_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 24575,
	max: 32768,
};

const BEDROCK_CLAUDE_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 32768,
};

function resolveBedrockThinkingBudget(
	model: Model<"bedrock-converse-stream">,
	options?: SimpleStreamOptions,
): { budget: number; level: Effort } | null {
	if (!options?.reasoning || !model.reasoning) return null;
	const level = requireSupportedEffort(model, options.reasoning);
	const budget = options.thinkingBudgets?.[level] ?? BEDROCK_CLAUDE_THINKING[level];
	return { budget, level };
}

export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "tool", name: choice.name } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}

export function mapGoogleToolChoice(
	choice?: ToolChoice,
): GoogleOptions["toolChoice"] | GoogleGeminiCliOptions["toolChoice"] | GoogleVertexOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	// Named-tool routing on Google: emit an `ANY`-mode allow-list of one entry,
	// mirroring the Anthropic mapper that returns `{type: "tool", name}`.
	if (choice.type === "tool") {
		return choice.name ? { mode: "ANY", allowedFunctionNames: [choice.name] } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { mode: "ANY", allowedFunctionNames: [name] } : undefined;
	}
	return undefined;
}

function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

type ReasoningEffortMapCompat = {
	reasoningEffortMap?: Partial<Record<Effort, string>>;
};

function getCompatReasoningEffortMap<TApi extends Api>(
	model: Model<TApi>,
): Partial<Record<Effort, string>> | undefined {
	const compat = model.compat;
	if (compat === undefined || typeof compat !== "object" || !("reasoningEffortMap" in compat)) {
		return undefined;
	}
	return (compat as ReasoningEffortMapCompat).reasoningEffortMap;
}

function resolveSupportedMappedReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	reasoning: Effort,
): Effort | undefined {
	const mapped = getCompatReasoningEffortMap(model)?.[reasoning];
	if (!mapped) return undefined;
	const mappedEffort = mapped as Effort;
	return model.thinking?.efforts.includes(mappedEffort) ? mappedEffort : undefined;
}

function resolveOpenAiReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): Effort | undefined {
	const reasoning = options?.reasoning;
	if (!reasoning || !model.reasoning) return undefined;
	// Models that reason natively but expose no effort dial carry
	// `thinking: undefined` (baked at build time from
	// `compat.supportsReasoningEffort: false` on openai-responses*). The
	// wire-side omitReasoningEffort gate (stream.ts) is the actual strip; returning
	// undefined here avoids a redundant requireSupportedEffort throw that would
	// defeat the gate and surface a confusing "Compaction failed: Thinking effort
	// high is not supported by..." to the user.
	if (!model.thinking) return undefined;
	if (model.thinking.efforts.includes(reasoning)) return reasoning;
	const mappedReasoning = resolveSupportedMappedReasoningEffort(model, reasoning);
	if (mappedReasoning) return mappedReasoning;
	if (getCompatReasoningEffortMap(model)?.[reasoning] !== undefined) return reasoning;
	if (model.thinking.effortMap?.[reasoning] !== undefined) return reasoning;
	return requireSupportedEffort(model, reasoning);
}

function resolveGoogleThinkingOff<TApi extends Api>(model: Model<TApi>): NonNullable<GoogleOptions["thinking"]> {
	const thinking: NonNullable<GoogleOptions["thinking"]> = { enabled: false };
	if (!model.reasoning || !model.thinking) return thinking;
	if (model.thinking.mode === "budget" && (!model.thinking.requiresEffort || model.thinking.suppressWhenOff)) {
		thinking.budgetTokens = 0;
	} else if (model.thinking.mode === "google-level" && model.thinking.suppressWhenOff) {
		thinking.level = "MINIMAL";
	}
	return thinking;
}

const castApi = <TApi extends Api>(api: OptionsForApi<TApi>): OptionsForApi<Api> => api as OptionsForApi<Api>;

/**
 * Mandatory-reasoning endpoints (`thinking.requiresEffort`) reject disabled
 * or omitted thinking ("Reasoning is mandatory for this endpoint and cannot
 * be disabled") — clamp to the lowest supported effort instead.
 * `suppressWhenOff` models handle off provider-side via explicit wire
 * suppression. Collapsed pairs interplay: pair derivation strips member
 * flags (off routes to a bare SKU that CAN disable), while identity backfill
 * re-flags pairs whose logical id is itself mandatory (Gemini 3.x) — there
 * the clamp wins and the floored effort routes to the thinking SKU.
 */
function normalizeMandatoryReasoningOptions<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
	if (
		!model.reasoning ||
		!model.thinking?.requiresEffort ||
		model.thinking.suppressWhenOff ||
		(options?.reasoning !== undefined && !options.disableReasoning && !options.forceReasoningOff)
	) {
		return options;
	}
	const floor = defaultSupportedEffort(model);
	if (floor === undefined) return options;
	return { ...options, reasoning: floor, disableReasoning: undefined, forceReasoningOff: undefined };
}

function supportsExplicitOpenAIResponsesPromptCache(compat: unknown): boolean {
	return (
		typeof compat === "object" &&
		compat !== null &&
		"supportsPromptCacheBreakpoints" in compat &&
		compat.supportsPromptCacheBreakpoints === true
	);
}

function isOpenAIResponsesPromptCacheSurface<TApi extends Api>(model: Model<TApi>): boolean {
	return (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		(model.api === "openrouter" && $env.PI_OPENROUTER_RESPONSES !== "0")
	);
}

function assertExplicitOpenAIResponsesPromptCacheSupport<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptions,
): void {
	if (
		model.transport === "pi-native" ||
		resolveCacheRetention(options?.cacheRetention) === "none" ||
		options?.promptCache?.mode !== "explicit" ||
		!isOpenAIResponsesPromptCacheSurface(model) ||
		supportsExplicitOpenAIResponsesPromptCache(model.compat)
	) {
		return;
	}
	throw new AIError.ConfigurationError(
		`OpenAI explicit prompt caching is unsupported for ${model.provider}/${model.id}; enable compat.supportsPromptCacheBreakpoints only for a compatible endpoint.`,
	);
}

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	rawOptions?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const options = normalizeMandatoryReasoningOptions(model, rawOptions);
	const simpleProviderOptions = getProviderDefinition(model.provider)?.mapSimpleOptions?.(options ?? {});
	const base = {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
		signal: options?.signal,
		apiKey: apiKey ?? (typeof options?.apiKey === "string" ? options.apiKey : undefined),
		cacheRetention: options?.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		taskBudget: options?.taskBudget,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
		codexSseMaxAttempts: options?.codexSseMaxAttempts,
		providerSessionState: options?.providerSessionState,
		maxInFlightRequests: options?.maxInFlightRequests,
		toolNamespacesInfo: options?.toolNamespacesInfo,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onSseEvent: options?.onSseEvent,
		execHandlers: options?.execHandlers,
		fetch: options?.fetch,
		fallbacks: options?.fallbacks,
		acceptEmptyResponse: options?.acceptEmptyResponse,
		anthropicCacheRefreshRequest: options?.anthropicCacheRefreshRequest,
		...simpleProviderOptions,
	};

	switch (model.api) {
		case "anthropic-messages": {
			// Explicitly disable thinking when reasoning is not specified, the caller
			// disabled it, an external scratchpad replaces it, or the model doesn't
			// support it. These SimpleStreamOptions flags never reach AnthropicOptions
			// on their own, so fold them into thinkingEnabled here (mandatory-reasoning
			// models already clamp them away in normalizeMandatoryReasoningOptions).
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning || options?.disableReasoning || options?.forceReasoningOff) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			let thinkingBudget = options.thinkingBudgets?.[reasoning] ?? ANTHROPIC_THINKING[reasoning];
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			const thinkingMode = model.thinking?.mode;
			const effort =
				thinkingMode === "anthropic-adaptive" || thinkingMode === "anthropic-budget-effort"
					? mapEffortToAnthropicAdaptiveEffort(model, reasoning)
					: undefined;

			// For Opus 4.6+ and Sonnet 4.6+: use adaptive thinking with effort level
			// For older models: use budget-based thinking
			if (thinkingMode === "anthropic-adaptive") {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			if (ANTHROPIC_USE_INTERLEAVED_THINKING) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			// Caller's maxTokens is desired output, so add thinking budget on top. With no caller/model cap, use a finite total fallback.
			const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

			// If not enough room for thinking + output, reduce thinking budget
			if (maxTokens <= thinkingBudget) {
				thinkingBudget = maxTokens - MIN_OUTPUT_TOKENS;
			}

			// If thinking budget is too low, disable thinking
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			} else {
				return castApi<"anthropic-messages">({
					...base,
					maxTokens,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}
		}

		case "bedrock-converse-stream": {
			const bedrockBase: BedrockOptions = {
				...base,
				reasoning: options?.reasoning,
				thinkingBudgets: options?.thinkingBudgets,
				toolChoice: mapAnthropicToolChoice(options?.toolChoice),
				thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
				guardrailIdentifier: model.guardrailIdentifier ?? options?.guardrailIdentifier,
				guardrailVersion: model.guardrailVersion ?? options?.guardrailVersion,
				guardrailTrace: model.guardrailTrace ?? options?.guardrailTrace,
			};
			// Adaptive mode sends effort directly, no budget_tokens — skip budget inflation.
			if (model.thinking?.mode === "anthropic-adaptive") {
				return castApi<"bedrock-converse-stream">(bedrockBase);
			}
			const budgetInfo = resolveBedrockThinkingBudget(model as Model<"bedrock-converse-stream">, options);
			if (!budgetInfo) return bedrockBase as OptionsForApi<TApi>;
			let maxTokens = bedrockBase.maxTokens ?? model.maxTokens ?? OUTPUT_CAP_WHEN_UNKNOWN;
			let thinkingBudgets = bedrockBase.thinkingBudgets;
			if (maxTokens <= budgetInfo.budget) {
				const desiredMaxTokens = Math.min(
					model.maxTokens ?? Number.POSITIVE_INFINITY,
					budgetInfo.budget + MIN_OUTPUT_TOKENS,
				);
				if (desiredMaxTokens > maxTokens) {
					maxTokens = desiredMaxTokens;
				}
			}
			if (maxTokens <= budgetInfo.budget) {
				const adjustedBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				thinkingBudgets = { ...(thinkingBudgets ?? {}), [budgetInfo.level]: adjustedBudget };
			}
			return castApi<"bedrock-converse-stream">({ ...bedrockBase, maxTokens, thinkingBudgets });
		}

		case "openrouter": {
			const useResponses = $env.PI_OPENROUTER_RESPONSES !== "0";
			if (useResponses) {
				return castApi<"openai-responses">({
					...base,
					reasoning: resolveOpenAiReasoningEffort(model, options),
					toolChoice: mapOpenAiToolChoice(options?.toolChoice),
					serviceTier: options?.serviceTier,
					reasoningSummary: options?.hideThinkingSummary ? null : undefined,
					openrouterVariant: options?.openrouterVariant,
					maxTokensExplicit: rawOptions?.maxTokens !== undefined,
					disableReasoning: options?.disableReasoning,
					textVerbosity: options?.textVerbosity,
					promptCache: options?.promptCache,
					statefulResponses: options?.statefulResponses,
				});
			}
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
				promptCache: options?.promptCache,
			});
		}

		case "openai-completions":
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
				promptCache: options?.promptCache,
			});

		case "openai-responses":
			return castApi<"openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
				disableReasoning: options?.disableReasoning,
				forceReasoningOff: options?.forceReasoningOff,
				textVerbosity: options?.textVerbosity,
				promptCache: options?.promptCache,
				statefulResponses: options?.statefulResponses,
			});

		case "azure-openai-responses":
			return castApi<"azure-openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				promptCache: options?.promptCache,
				statefulResponses: options?.statefulResponses,
				disableReasoning: options?.disableReasoning || options?.forceReasoningOff,
				forceReasoningOff: options?.forceReasoningOff,
			});

		case "openai-codex-responses":
			return castApi<"openai-codex-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				preferWebsockets: options?.preferWebsockets,
				codexCompaction: options?.codexCompaction,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				textVerbosity: options?.textVerbosity,
				forceReasoningOff: options?.forceReasoningOff,
			});

		case "google-generative-ai": {
			// Explicitly disable thinking when reasoning is absent, unsupported, or
			// replaced by the caller's external scratchpad. Gemini defaults thinking on.
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning || options?.disableReasoning || options?.forceReasoningOff) {
				return castApi<"google-generative-ai">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: resolveGoogleThinkingOff(model),
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
					cachedContent: options?.cachedContent,
				});
			}

			const googleModel = model as Model<"google-generative-ai">;
			const effort = requireSupportedEffort(googleModel, reasoning);

			// Gemini 3+ models use thinkingLevel exclusively instead of thinkingBudget.
			// https://ai.google.dev/gemini-api/docs/thinking#set-budget
			if (googleModel.thinking?.mode === "google-level") {
				return castApi<"google-generative-ai">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(effort, googleModel),
					},
					hideThinkingSummary: options?.hideThinkingSummary,
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
					cachedContent: options?.cachedContent,
				});
			}

			return castApi<"google-generative-ai">({
				...base,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(googleModel, effort, options?.thinkingBudgets),
				},
				hideThinkingSummary: options?.hideThinkingSummary,
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
				cachedContent: options?.cachedContent,
			});
		}

		case "google-gemini-cli": {
			const reasoning = options?.reasoning;
			const toolChoice = mapGoogleToolChoice(options?.toolChoice);
			if (reasoning && model.reasoning && !options?.disableReasoning && !options?.forceReasoningOff) {
				const effort = requireSupportedEffort(model, reasoning);

				// Gemini 3+ models use thinkingLevel instead of thinkingBudget
				if (model.thinking?.mode === "google-level") {
					return castApi<"google-gemini-cli">({
						...base,
						requestModelId: resolveWireModelId(model, effort),
						thinking: {
							enabled: true,
							level: mapEffortToGoogleThinkingLevel(effort, model),
						},
						hideThinkingSummary: options?.hideThinkingSummary,
						toolChoice,
						antigravityEndpointMode: options?.antigravityEndpointMode,
					});
				}

				let thinkingBudget =
					options.thinkingBudgets?.[effort] ?? model.thinking?.effortBudgets?.[effort] ?? GOOGLE_THINKING[effort];

				// Caller's maxTokens is desired output, so add thinking budget on top. With no caller/model cap, use a finite total fallback.
				const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

				// If not enough room for thinking + output, reduce thinking budget
				if (maxTokens <= thinkingBudget) {
					thinkingBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				}

				if (thinkingBudget > 0) {
					return castApi<"google-gemini-cli">({
						...base,
						maxTokens,
						requestModelId: resolveWireModelId(model, effort),
						thinking: { enabled: true, budgetTokens: thinkingBudget },
						hideThinkingSummary: options?.hideThinkingSummary,
						toolChoice,
						antigravityEndpointMode: options?.antigravityEndpointMode,
					});
				}
				// Budget clamped to zero — fall through to the thinking-off path.
			}

			const thinking: GoogleGeminiCliOptions["thinking"] = { enabled: false };
			if (model.reasoning && model.thinking?.suppressWhenOff) {
				// CCA re-applies the per-id baked server default when the config
				// is omitted; suppression must be explicit on the wire.
				thinking.suppress = model.thinking.mode === "google-level" ? { level: "MINIMAL" } : { budget: 0 };
			}
			return castApi<"google-gemini-cli">({
				...base,
				requestModelId: resolveWireModelId(model, undefined),
				thinking,
				toolChoice,
				antigravityEndpointMode: options?.antigravityEndpointMode,
			});
		}

		case "google-vertex": {
			// Explicitly disable thinking when reasoning is absent, unsupported, or
			// replaced by the caller's external scratchpad.
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning || options?.disableReasoning || options?.forceReasoningOff) {
				return castApi<"google-vertex">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: resolveGoogleThinkingOff(model),
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
					cachedContent: options?.cachedContent,
				});
			}

			const vertexModel = model as Model<"google-vertex">;
			const effort = requireSupportedEffort(vertexModel, reasoning);
			const geminiModel = vertexModel as unknown as Model<"google-generative-ai">;

			if (geminiModel.thinking?.mode === "google-level") {
				return castApi<"google-vertex">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(effort, model),
					},
					hideThinkingSummary: options?.hideThinkingSummary,
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
					cachedContent: options?.cachedContent,
				});
			}

			return castApi<"google-vertex">({
				...base,
				serviceTier: options?.serviceTier,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(geminiModel, effort, options?.thinkingBudgets),
				},
				hideThinkingSummary: options?.hideThinkingSummary,
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
				cachedContent: options?.cachedContent,
			});
		}

		case "ollama-chat":
			return castApi<"ollama-chat">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: options?.toolChoice,
			});

		case "cursor-agent": {
			const execHandlers = options?.cursorExecHandlers ?? options?.execHandlers;
			const onToolResult = options?.cursorOnToolResult ?? execHandlers?.onToolResult;
			const cursorModel = model as Model<"cursor-agent">;
			const effort =
				options?.reasoning && !options.disableReasoning && !options.forceReasoningOff && cursorModel.reasoning
					? requireSupportedEffort(cursorModel, options.reasoning)
					: undefined;
			return castApi<"cursor-agent">({
				...base,
				execHandlers,
				onToolResult,
				wireModelId: resolveWireModelId(cursorModel, effort),
			});
		}

		case "gitlab-duo-agent":
			return castApi<"gitlab-duo-agent">({
				...base,
				cwd: options?.cwd,
				toolChoice: options?.toolChoice,
			});
		case "devin-agent": {
			const devinModel = model as Model<"devin-agent">;
			const effort =
				options?.reasoning && !options.disableReasoning
					? requireSupportedEffort(devinModel, options.reasoning)
					: undefined;
			return castApi<"devin-agent">({
				...base,
				chatModelUid: resolveWireModelId(devinModel, effort),
			});
		}
		default:
			throw new AIError.ConfigurationError(`Unhandled API in mapOptionsForApi: ${model.api}`);
	}
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: Effort,
	customBudgets?: ThinkingBudgets,
): number {
	requireSupportedEffort(model, effort);

	// Custom budgets take precedence if provided for this level
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	// See https://ai.google.dev/gemini-api/docs/thinking#set-budget
	if (model.id.includes("2.5-")) {
		switch (effort) {
			case "minimal":
				return 128;
			case "low":
				return 2048;
			case "medium":
				return 8192;
			case "high":
			case "xhigh":
			case "max":
				return model.id.includes("2.5-flash") ? 24576 : 32768;
		}
	}

	// Unknown model - use dynamic
	return -1;
}
