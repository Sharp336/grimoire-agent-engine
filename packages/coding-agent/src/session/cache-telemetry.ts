import type { Model, Usage } from "@oh-my-pi/pi-ai";
import {
	EPHEMERAL_MODEL_CHANGE_ROLE,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "./session-entries";

const MIN_CACHE_FOOTPRINT = 2048;

export interface CacheInvalidation {
	/** Prompt tokens the cold turn had to (re)process instead of reading from cache. */
	reprocessedTokens: number;
}

export type PromptCacheRequestStatus =
	| "RECREATED"
	| "REUSED + CREATED"
	| "WARM"
	| "CACHE CREATED"
	| "NO CACHE REPORTED";

export type PromptCacheObservation =
	| { kind: "thinking-level"; text: string }
	| { kind: "compaction"; text: "Compaction before request" }
	| { kind: "plan-mode"; text: "Plan mode entered before request" | "Plan mode exited before request" };

export type PromptCacheRouteStartDescription =
	| "model selected"
	| "fallback route selected"
	| "temporary model selected"
	| "provider route observed"
	| "session route observed";

export interface PromptCacheRouteStart {
	description: PromptCacheRouteStartDescription;
	timestamp?: number;
}

export interface PromptCacheAuditRequest {
	usage: Usage;
	timestamp?: number;
	promptInput: number;
	status: PromptCacheRequestStatus;
	cacheReadDelta?: number;
	recreation?: CacheInvalidation;
	observations: readonly PromptCacheObservation[];
	endAnnotation?: "Request ended with error" | "Request aborted";
}

export interface PromptCacheRouteMetrics {
	cachedRequests: number;
	cumulativeCachedInput: number;
	largestCachedInput: number;
	reuseMultiplier?: number;
	explicitRecreations: number;
}

export interface PromptCacheSessionMetrics {
	requests: number;
	cumulativeCachedInput: number;
	cacheCreation: number;
	explicitRecreations: number;
}

export interface PromptCacheAudit {
	routeLabel: string;
	upstreamProvider?: string;
	routeStart: PromptCacheRouteStart;
	currentRoute: PromptCacheRouteMetrics;
	requests: readonly PromptCacheAuditRequest[];
	sessionVolume: PromptCacheSessionMetrics;
}

interface RouteIdentity {
	provider: string;
	api: string;
	model: string;
	upstreamProvider?: string;
}

interface RouteSegment {
	identity?: RouteIdentity;
	start: PromptCacheRouteStart;
	requests: PromptCacheAuditRequest[];
}

function finitePositiveTimestamp(value: number): number | undefined {
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isMainModelChange(entry: ModelChangeEntry): boolean {
	return (
		entry.role === undefined ||
		entry.role === "default" ||
		entry.role === EPHEMERAL_MODEL_CHANGE_ROLE ||
		entry.role === "temporary"
	);
}

function modelChangeDescription(entry: ModelChangeEntry): PromptCacheRouteStartDescription {
	if (entry.role === EPHEMERAL_MODEL_CHANGE_ROLE) return "fallback route selected";
	if (entry.role === "temporary") return "temporary model selected";
	return "model selected";
}

function routeIdentity(entry: SessionMessageEntry): RouteIdentity | undefined {
	if (entry.message.role !== "assistant") return undefined;
	const { api, model, provider, upstreamProvider } = entry.message;
	return {
		provider,
		api,
		model,
		...(upstreamProvider ? { upstreamProvider } : {}),
	};
}

function sameRoute(left: RouteIdentity, right: RouteIdentity): boolean {
	return (
		left.provider === right.provider &&
		left.api === right.api &&
		left.model === right.model &&
		left.upstreamProvider === right.upstreamProvider
	);
}

function classifyRequest(usage: Usage, recreation: CacheInvalidation | undefined): PromptCacheRequestStatus {
	if (recreation) return "RECREATED";
	if (usage.cacheRead > 0 && usage.cacheWrite > 0) return "REUSED + CREATED";
	if (usage.cacheRead > 0) return "WARM";
	if (usage.cacheWrite > 0) return "CACHE CREATED";
	return "NO CACHE REPORTED";
}

function requestEndAnnotation(stopReason: string): PromptCacheAuditRequest["endAnnotation"] {
	if (stopReason === "error") return "Request ended with error";
	if (stopReason === "aborted") return "Request aborted";
	return undefined;
}

function routeMetrics(requests: readonly PromptCacheAuditRequest[]): PromptCacheRouteMetrics {
	let cachedRequests = 0;
	let cumulativeCachedInput = 0;
	let largestCachedInput = 0;
	let explicitRecreations = 0;
	for (const request of requests) {
		const cachedInput = request.usage.cacheRead;
		if (cachedInput > 0) cachedRequests++;
		cumulativeCachedInput += cachedInput;
		largestCachedInput = Math.max(largestCachedInput, cachedInput);
		if (request.recreation) explicitRecreations++;
	}
	return {
		cachedRequests,
		cumulativeCachedInput,
		largestCachedInput,
		...(largestCachedInput > 0 ? { reuseMultiplier: cumulativeCachedInput / largestCachedInput } : {}),
		explicitRecreations,
	};
}

function sessionMetrics(requests: readonly PromptCacheAuditRequest[]): PromptCacheSessionMetrics {
	let cumulativeCachedInput = 0;
	let cacheCreation = 0;
	let explicitRecreations = 0;
	for (const request of requests) {
		cumulativeCachedInput += request.usage.cacheRead;
		cacheCreation += request.usage.cacheWrite;
		if (request.recreation) explicitRecreations++;
	}
	return {
		requests: requests.length,
		cumulativeCachedInput,
		cacheCreation,
		explicitRecreations,
	};
}

/**
 * Decide whether `current` lost a working explicit prompt cache that `previous`
 * was reusing. This predicate reports only the observed warm-read to
 * zero-read-plus-write transition; it does not identify a provider cause.
 */
export function detectCacheInvalidation(previous: Usage | undefined, current: Usage): CacheInvalidation | undefined {
	if (!previous) return undefined;
	if (previous.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	if (current.cacheRead !== 0) return undefined;
	if (current.cacheWrite <= 0) return undefined;
	const reprocessedTokens = current.cacheWrite + current.input;
	if (reprocessedTokens < MIN_CACHE_FOOTPRINT) return undefined;
	return { reprocessedTokens };
}

export function buildPromptCacheAudit(
	entries: readonly SessionEntry[],
	model: Model | undefined,
): PromptCacheAudit | undefined {
	if (!model) return undefined;

	const sessionRequests: PromptCacheAuditRequest[] = [];
	let currentRoute: RouteSegment | undefined;
	let pendingObservations: PromptCacheObservation[] = [];
	let currentMode = "none";

	for (const entry of entries) {
		if (entry.type === "thinking_level_change") {
			const level = entry.configured ?? entry.thinkingLevel ?? "off";
			pendingObservations.push({
				kind: "thinking-level",
				text: `Thinking level changed before request: ${level}`,
			});
			continue;
		}
		if (entry.type === "compaction") {
			pendingObservations.push({ kind: "compaction", text: "Compaction before request" });
			continue;
		}
		if (entry.type === "mode_change") {
			const wasPlanMode = currentMode === "plan";
			const isPlanMode = entry.mode === "plan";
			if (wasPlanMode !== isPlanMode) {
				pendingObservations.push({
					kind: "plan-mode",
					text: isPlanMode ? "Plan mode entered before request" : "Plan mode exited before request",
				});
			}
			currentMode = entry.mode;
			continue;
		}
		if (entry.type === "model_change" && isMainModelChange(entry)) {
			const timestamp = finitePositiveTimestamp(Date.parse(entry.timestamp));
			currentRoute = {
				start: {
					description: modelChangeDescription(entry),
					...(timestamp !== undefined ? { timestamp } : {}),
				},
				requests: [],
			};
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const usage = entry.message.usage;
		const promptInput = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptInput <= 0) continue;
		const identity = routeIdentity(entry);
		if (!identity) continue;
		const timestamp = finitePositiveTimestamp(entry.message.timestamp);

		if (!currentRoute) {
			currentRoute = {
				identity,
				start: {
					description: "session route observed",
					...(timestamp !== undefined ? { timestamp } : {}),
				},
				requests: [],
			};
		} else if (!currentRoute.identity) {
			currentRoute.identity = identity;
		} else if (!sameRoute(currentRoute.identity, identity)) {
			currentRoute = {
				identity,
				start: {
					description: "provider route observed",
					...(timestamp !== undefined ? { timestamp } : {}),
				},
				requests: [],
			};
		}

		const previousUsage = currentRoute.requests.at(-1)?.usage;
		const recreation = detectCacheInvalidation(previousUsage, usage);
		const previousCacheRead = previousUsage?.cacheRead;
		const cacheReadDelta = previousCacheRead === undefined ? 0 : usage.cacheRead - previousCacheRead;
		const endAnnotation = requestEndAnnotation(entry.message.stopReason);
		const request: PromptCacheAuditRequest = {
			usage,
			...(timestamp !== undefined ? { timestamp } : {}),
			promptInput,
			status: classifyRequest(usage, recreation),
			...(cacheReadDelta > 0 ? { cacheReadDelta } : {}),
			...(recreation ? { recreation } : {}),
			observations: pendingObservations,
			...(endAnnotation ? { endAnnotation } : {}),
		};
		pendingObservations = [];
		currentRoute.requests.push(request);
		sessionRequests.push(request);
	}

	currentRoute ??= { start: { description: "model selected" }, requests: [] };
	const routeIdentityValue = currentRoute.identity;
	return {
		routeLabel: routeIdentityValue
			? `${routeIdentityValue.provider}/${routeIdentityValue.model}`
			: `${model.provider}/${model.id}`,
		...(routeIdentityValue?.upstreamProvider ? { upstreamProvider: routeIdentityValue.upstreamProvider } : {}),
		routeStart: currentRoute.start,
		currentRoute: routeMetrics(currentRoute.requests),
		requests: currentRoute.requests,
		sessionVolume: sessionMetrics(sessionRequests),
	};
}
