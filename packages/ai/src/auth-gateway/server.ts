/**
 * omp auth-gateway HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses) and dispatches through pi-ai's `streamSimple()`
 * — which handles credential injection, anthropic-beta headers, codex
 * websocket transport, and all the per-provider intricacies. The gateway is
 * pure protocol translation: foreign wire → omp Context → pi-ai stream() →
 * omp events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/responses                     → OpenAI Responses in/out
 */

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { extractHttpStatusFromError, extractRetryHint, logger } from "@oh-my-pi/pi-utils";
import type { ApiKeyResolver } from "../auth-retry";
import type { AuthStorage } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError } from "../error/gateway";
import { isUsageLimitOutcome } from "../error/rate-limit";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { completeSimple, streamSimple } from "../stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { parseBind } from "../utils/parse-bind";
import {
	captureRequestHeaders,
	corsHeaders,
	gatewayResponseHeaders,
	isAuthorized,
	json,
	readBoundedJson,
	resolvePeer,
	withCors,
} from "./http";
import type {
	AuthGatewayAuthorizationDecision,
	AuthGatewayAuthorizationGrant,
	AuthGatewayObservation,
	AuthGatewayPolicyObservationBase,
	AuthGatewayServerHandle,
	AuthGatewayServerOptions,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER, DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// ParsedFormatRequest / ParsedFormatOptions / FormatModule come from ./types.

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	/** Source of credentials. Caller wires this to a broker-backed AuthStorage. */
	storage: AuthStorage;
	/**
	 * Resolve a client-requested model id to a pi-ai Model. Caller supplies
	 * this from a ModelRegistry (lives in `coding-agent` to avoid an inverse
	 * dependency in `pi-ai`).
	 */
	resolveModel: ModelResolver;
	/** Optional supplier for `/v1/models` listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
}

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

const FORMAT_ROUTES: Record<string, { module: FormatModule; label: string }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
};

const MAX_POLICY_MODEL_SELECTOR_LENGTH = 512;
const MAX_POLICY_SESSION_ID_LENGTH = 1024;
const MAX_POLICY_AUTHORIZATION_ID_LENGTH = 512;
const MAX_POLICY_CREDENTIAL_IDS = 256;
const MAX_POLICY_AUTHORIZATION_INPUT_LENGTH = 4096;
const MAX_POLICY_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

const AUTHORIZATION_DENIAL_FIELDS: Record<string, true> = {
	authorized: true,
	reasonCode: true,
};
const AUTHORIZATION_GRANT_FIELDS: Record<string, true> = {
	authorized: true,
	authorizationId: true,
	requestedModelId: true,
	resolvedModelId: true,
	sessionId: true,
	allowedOAuthCredentialIds: true,
};

class AuthGatewayObserverDeliveryError extends Error {
	constructor() {
		super("Gateway observer is unavailable");
		this.name = "AuthGatewayObserverDeliveryError";
	}
}

interface GatewayPolicy {
	requestId: string;
	format: string;
	authorizationId: string;
	requestedModelId: string;
	resolvedModelId: string;
	sessionId: string;
	allowedOAuthCredentialIds: ReadonlySet<number>;
}

type GatewayAuthorizationResult = { ok: true; policy?: GatewayPolicy } | { ok: false; response: Response };
type GatewayFormatError = (status: number, type: string, message: string) => Response;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedPolicyText(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		value.trim() === value &&
		!/\p{Cc}/u.test(value)
	);
}

function hasOnlyDecisionFields(value: Record<string, unknown>, allowed: Record<string, true>): boolean {
	return Object.keys(value).every(key => Object.hasOwn(allowed, key));
}

function validateAuthorizationGrant(
	decision: unknown,
	requestedModelId: string,
): AuthGatewayAuthorizationGrant | undefined {
	if (!isUnknownRecord(decision) || decision.authorized !== true) return undefined;
	if (!hasOnlyDecisionFields(decision, AUTHORIZATION_GRANT_FIELDS)) return undefined;
	if (
		!isBoundedPolicyText(decision.authorizationId, MAX_POLICY_AUTHORIZATION_ID_LENGTH) ||
		!isBoundedPolicyText(decision.requestedModelId, MAX_POLICY_MODEL_SELECTOR_LENGTH) ||
		decision.requestedModelId !== requestedModelId ||
		!isBoundedPolicyText(decision.resolvedModelId, MAX_POLICY_MODEL_SELECTOR_LENGTH) ||
		!isBoundedPolicyText(decision.sessionId, MAX_POLICY_SESSION_ID_LENGTH)
	) {
		return undefined;
	}
	const namespaceSeparator = decision.sessionId.indexOf(":");
	if (namespaceSeparator <= 0 || namespaceSeparator === decision.sessionId.length - 1) return undefined;
	if (
		!Array.isArray(decision.allowedOAuthCredentialIds) ||
		decision.allowedOAuthCredentialIds.length === 0 ||
		decision.allowedOAuthCredentialIds.length > MAX_POLICY_CREDENTIAL_IDS
	) {
		return undefined;
	}
	const seen = new Set<number>();
	for (const credentialId of decision.allowedOAuthCredentialIds) {
		if (!Number.isSafeInteger(credentialId) || credentialId <= 0 || seen.has(credentialId)) return undefined;
		seen.add(credentialId);
	}
	return decision as unknown as AuthGatewayAuthorizationGrant;
}

function validateAuthorizationDenial(decision: unknown): { reasonCode?: string } | undefined {
	if (!isUnknownRecord(decision) || decision.authorized !== false) return undefined;
	if (!hasOnlyDecisionFields(decision, AUTHORIZATION_DENIAL_FIELDS)) return undefined;
	if (decision.reasonCode === undefined) return {};
	if (
		typeof decision.reasonCode !== "string" ||
		decision.reasonCode.length === 0 ||
		decision.reasonCode.length > 128 ||
		!/^[a-z0-9][a-z0-9._-]*$/i.test(decision.reasonCode)
	) {
		return undefined;
	}
	return { reasonCode: decision.reasonCode };
}

async function emitGatewayObservation(
	bootOpts: AuthGatewayBootOptions,
	observation: AuthGatewayObservation,
): Promise<void> {
	if (!bootOpts.observer) return;
	try {
		await bootOpts.observer(observation);
	} catch {
		throw new AuthGatewayObserverDeliveryError();
	}
}

function policyObservationBase(policy: GatewayPolicy): AuthGatewayPolicyObservationBase {
	return {
		requestId: policy.requestId,
		format: policy.format,
		authorizationId: policy.authorizationId,
		requestedModelId: policy.requestedModelId,
		resolvedModelId: policy.resolvedModelId,
		sessionId: policy.sessionId,
	};
}

function observerFailureResponse(formatError: GatewayFormatError): Response {
	return formatError(503, "authorization_error", "Gateway policy observer is unavailable");
}

class GatewayPolicyRequest {
	#terminal = false;
	#observerError: AuthGatewayObserverDeliveryError | undefined;
	readonly #bootOpts: AuthGatewayBootOptions;

	constructor(
		readonly policy: GatewayPolicy,
		bootOpts: AuthGatewayBootOptions,
	) {
		this.#bootOpts = bootOpts;
	}

	get observerError(): AuthGatewayObserverDeliveryError | undefined {
		return this.#observerError;
	}

	async observe(observation: AuthGatewayObservation): Promise<void> {
		if (this.#observerError) throw this.#observerError;
		try {
			await emitGatewayObservation(this.#bootOpts, observation);
		} catch (error) {
			if (error instanceof AuthGatewayObserverDeliveryError) this.#observerError = error;
			throw error;
		}
	}

	async fail(
		stage: "model_resolution" | "credential_selection" | "upstream",
		code: "model_unavailable" | "credential_unavailable" | "credential_rotation_unavailable" | "upstream_error",
	): Promise<void> {
		if (this.#terminal) return;
		await this.observe({
			type: "error",
			...policyObservationBase(this.policy),
			stage,
			code,
		});
		await this.#settle("error", false);
	}

	async settleAbortedBestEffort(): Promise<void> {
		await this.#settle("aborted", true);
	}

	async settleSuccessBestEffort(): Promise<void> {
		await this.#settle("success", true);
	}

	async #settle(outcome: "success" | "error" | "aborted", bestEffort: boolean): Promise<void> {
		if (this.#terminal) return;
		this.#terminal = true;
		try {
			await this.observe({
				type: "terminal",
				...policyObservationBase(this.policy),
				outcome,
			});
		} catch (error) {
			if (!bestEffort || !(error instanceof AuthGatewayObserverDeliveryError)) throw error;
			logger.warn("auth-gateway policy terminal observation failed after request completion", {
				requestId: this.policy.requestId,
				format: this.policy.format,
				outcome,
			});
		}
	}
}

async function authorizeGatewayRequest(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	input: {
		requestId: string;
		format: string;
		requestedModelId: string;
		requestedSessionId?: string;
		payloadByteLength: number;
		payloadSha256: string;
	},
	formatError: GatewayFormatError,
): Promise<GatewayAuthorizationResult> {
	const authorizer = bootOpts.authorizeRequest;
	if (!authorizer) return { ok: true };
	if (
		!isBoundedPolicyText(input.requestedModelId, MAX_POLICY_MODEL_SELECTOR_LENGTH) ||
		(input.requestedSessionId !== undefined &&
			!isBoundedPolicyText(input.requestedSessionId, MAX_POLICY_SESSION_ID_LENGTH))
	) {
		return {
			ok: false,
			response: formatError(400, "invalid_request_error", "Policy request identifiers exceed gateway limits"),
		};
	}
	const authorization = req.headers.get(AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER);
	if (!isBoundedPolicyText(authorization, MAX_POLICY_AUTHORIZATION_INPUT_LENGTH)) {
		return {
			ok: false,
			response: formatError(401, "authorization_error", "Missing or invalid gateway policy authorization"),
		};
	}

	let decision: AuthGatewayAuthorizationDecision;
	try {
		decision = await authorizer({
			requestId: input.requestId,
			format: input.format,
			requestedModelId: input.requestedModelId,
			requestedSessionId: input.requestedSessionId,
			payloadByteLength: input.payloadByteLength,
			payloadSha256: input.payloadSha256,
			method: req.method,
			path: new URL(req.url).pathname,
			authorization,
			signal: req.signal,
		});
	} catch {
		return {
			ok: false,
			response: formatError(503, "authorization_error", "Gateway authorization policy is unavailable"),
		};
	}

	const denial = validateAuthorizationDenial(decision);
	if (denial) {
		try {
			await emitGatewayObservation(bootOpts, {
				type: "authorization",
				requestId: input.requestId,
				format: input.format,
				requestedModelId: input.requestedModelId,
				outcome: "denied",
				reasonCode: denial.reasonCode,
			});
		} catch (error) {
			if (error instanceof AuthGatewayObserverDeliveryError) {
				return { ok: false, response: observerFailureResponse(formatError) };
			}
			throw error;
		}
		return {
			ok: false,
			response: formatError(403, "authorization_error", "Request denied by gateway policy"),
		};
	}

	const grant = validateAuthorizationGrant(decision, input.requestedModelId);
	if (!grant) {
		try {
			await emitGatewayObservation(bootOpts, {
				type: "authorization",
				requestId: input.requestId,
				format: input.format,
				requestedModelId: input.requestedModelId,
				outcome: "error",
			});
		} catch (error) {
			if (error instanceof AuthGatewayObserverDeliveryError) {
				return { ok: false, response: observerFailureResponse(formatError) };
			}
			throw error;
		}
		return {
			ok: false,
			response: formatError(500, "authorization_error", "Gateway authorization policy returned an invalid decision"),
		};
	}

	const policy: GatewayPolicy = {
		requestId: input.requestId,
		format: input.format,
		authorizationId: grant.authorizationId,
		requestedModelId: grant.requestedModelId,
		resolvedModelId: grant.resolvedModelId,
		sessionId: grant.sessionId,
		allowedOAuthCredentialIds: new Set(grant.allowedOAuthCredentialIds),
	};
	try {
		await emitGatewayObservation(bootOpts, {
			type: "authorization",
			...policyObservationBase(policy),
			outcome: "authorized",
		});
	} catch (error) {
		if (error instanceof AuthGatewayObserverDeliveryError) {
			return { ok: false, response: observerFailureResponse(formatError) };
		}
		throw error;
	}
	return { ok: true, policy };
}

// (passthrough fast-path removed — it bypassed pi-ai provider logic, in
// particular the Anthropic Claude-Code OAuth system-prompt prefix injection.
// Every request now takes the translate path so credential-specific request
// shaping always applies.)

// Options the caller's wire format may carry but the resolved provider can't
// honour are dropped silently in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for openai-codex-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Failing loudly
// just turned that into per-call config hell. Silent strip is what the
// upstream provider would do anyway when it ignores extra fields.

/**
 * Derive a stable cache identity from the parts of the request that don't
 * change turn-to-turn within a logical conversation: model id, system prompt,
 * tool definitions, and the first message (the conversation seed). Codex-class
 * backends only cache prefixes when an explicit `prompt_cache_key` is set;
 * without one, two requests with the same prefix but different trailing
 * messages don't coalesce. This bridges Anthropic-style clients (which signal
 * caching via `cache_control` markers rather than an opaque key) to Codex's
 * keyed model so cross-protocol caching "just works".
 *
 * Including the first message scopes the key to one logical conversation:
 * two different chats with the same system prompt no longer share a cache
 * bucket and can't trample each other's prefix-tree entries.
 *
 * Anthropic-backed requests ignore `sessionId`; the key is harmless there.
 */
function deriveSessionId(modelId: string, context: Context): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (context.tools && context.tools.length > 0) {
		parts.push(JSON.stringify(context.tools));
	}
	const first = context.messages?.[0];
	if (first) {
		// Strip timestamp / provider metadata so the hash is stable across turns
		// of the same conversation (omp re-stamps every parsed Message). role +
		// content is what's actually on the wire.
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	// The 36-char UUID flows through unchanged:
	// `normalizeOpenAIPromptCacheKey` accepts ≤64 chars verbatim.
	return deterministicUuid(seed);
}

function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal };
	const { options } = parsed;
	// Codex backend rejects every sampling control with
	// `Unsupported parameter: …` (#3117). Strip the full set for that one
	// provider; everything else is harmless to forward — `streamSimple` ignores
	// what the underlying provider doesn't honour.
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined && !isCodex) opts.topK = options.topK;
	if (options.minP !== undefined && !isCodex) opts.minP = options.minP;
	if (options.stopSequences !== undefined && !isCodex) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined && !isCodex) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined && !isCodex) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined && !isCodex) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.headers !== undefined) opts.headers = { ...(opts.headers ?? {}), ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice !== "object"
				? options.toolChoice
				: "type" in options.toolChoice
					? options.toolChoice
					: { type: "tool", name: options.toolChoice.name };
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.taskBudget !== undefined) opts.taskBudget = options.taskBudget;
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	if (options.include !== undefined) opts.include = options.include;
	// Client-supplied `prompt_cache_key` wins; otherwise derive a stable
	// key from the model + system + tools so prefix caching engages on
	// Codex-class backends across turns of the same logical conversation.
	const promptCacheKey = options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	opts.promptCacheKey = promptCacheKey;
	opts.sessionId = promptCacheKey;
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = { ...(opts.thinkingBudgets ?? {}), ...options.thinkingBudgets };
	}
	if (options.explicitThinkingBudgetTokens !== undefined) {
		// Mirror Rust's `resolve_thinking_budget`: explicit budget pins onto
		// whichever effort the client requested (or High when unspecified) and
		// ALSO sets the effort so providers that gate on `reasoning` actually
		// surface the budget.
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...(opts.thinkingBudgets ?? {}),
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
	// Fields that don't yet have a matching pi-ai `SimpleStreamOptions` slot.
	// Surfaced once in debug logs so they show up when wiring a new provider,
	// but NEVER widened into `options.extra` — every consumer would have to
	// re-implement the typed parse to read them back out.
	// TODO(pi-ai): land first-class fields and replace these blocks.
	if (
		options.parallelToolCalls !== undefined ||
		options.previousResponseId !== undefined ||
		options.seed !== undefined ||
		options.logitBias !== undefined ||
		options.user !== undefined ||
		options.responseFormat !== undefined
	) {
		logger.debug("auth-gateway dropped unsupported typed options", {
			api,
			parallelToolCalls: options.parallelToolCalls,
			previousResponseId: options.previousResponseId,
			seed: options.seed,
			hasLogitBias: options.logitBias !== undefined,
			user: options.user,
			hasResponseFormat: options.responseFormat !== undefined,
		});
	}
	return opts;
}

/**
 * Hook fired by {@link streamSimple} when the upstream request fails in a
 * way that's rotatable — today that's HTTP 401 (credential is bad) and
 * usage-limit phrasing matched by {@link isUsageLimitError} (Codex's
 * `usage_limit_reached`, Anthropic's `usage_limit_reached`, Google's
 * `resource_exhausted`, …). The two cases need different storage actions:
 *
 * - **usage-limit** → {@link AuthStorage.markUsageLimitReached}. Marks just
 *   the current session's credential as temporarily blocked (honouring
 *   `retry-after` / `resets_at` hints when present) and returns `true` only
 *   when a sibling credential is still available. Burning the credential
 *   with `invalidateCredentialMatching` here would orphan accounts whose
 *   reset window is several hours away — exactly the bug this helper exists
 *   to avoid.
 * - **auth-failure** → {@link AuthStorage.invalidateCredentialMatching}.
 *   Suspect/delete the row so it doesn't get re-picked next request.
 *
 * In both branches we return the next `getApiKey` result (sticky on the
 * same `sessionId`) so streamSimple can transparently retry the pre-emit
 * failure with a fresh credential. Returning `undefined` aborts the retry
 * and surfaces the original error to the caller.
 */
interface GatewayResolvedCredential {
	apiKey: string;
	credentialId?: number;
}

async function refreshGatewayApiKeyAfterAuthError(
	bootOpts: AuthGatewayBootOptions,
	model: Model<Api>,
	sessionId: string,
	oldCredential: GatewayResolvedCredential,
	error: unknown,
	signal: AbortSignal,
	format: string,
	peer: string,
	policyRequest?: GatewayPolicyRequest,
): Promise<GatewayResolvedCredential | undefined> {
	const message = error instanceof Error ? error.message : String(error);
	const status = extractHttpStatusFromError(error);
	const usageLimit = AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message);
	const policy = policyRequest?.policy;
	if (policyRequest && policy) {
		if (oldCredential.credentialId === undefined) return undefined;
		// AuthStorage must apply the provider error before it can identify the
		// actual next eligible row. Any later observer rejection is latched on
		// this request, so the retry cannot turn that mutation into a success.
		const switched = await bootOpts.storage.rotateSessionCredential(model.provider, sessionId, {
			error,
			modelId: model.id,
			credentialId: oldCredential.credentialId,
			signal,
			allowedOAuthCredentialIds: policy.allowedOAuthCredentialIds,
			redactOAuthErrors: true,
		});
		if (!switched) {
			await policyRequest.observe({
				type: "error",
				...policyObservationBase(policy),
				stage: "credential_selection",
				code: "credential_rotation_unavailable",
			});
			return undefined;
		}
		const access = await bootOpts.storage.getOAuthApiKeyFromCredentialIds(
			model.provider,
			sessionId,
			policy.allowedOAuthCredentialIds,
			{ modelId: model.id, signal },
		);
		if (
			!access ||
			access.credentialId === oldCredential.credentialId ||
			!policy.allowedOAuthCredentialIds.has(access.credentialId)
		) {
			await policyRequest.observe({
				type: "error",
				...policyObservationBase(policy),
				stage: "credential_selection",
				code: "credential_rotation_unavailable",
			});
			return undefined;
		}
		await policyRequest.observe({
			type: "credential_rotation",
			...policyObservationBase(policy),
			previousCredentialId: oldCredential.credentialId,
			credentialId: access.credentialId,
			reason: usageLimit ? "usage_limit" : "authentication_failure",
		});
		return access;
	}

	if (usageLimit) {
		const retryAfterMs = extractRetryHint(undefined, message);
		const { switched, retryAtMs } = await bootOpts.storage.markUsageLimitReached(model.provider, sessionId, {
			retryAfterMs,
			baseUrl: model.baseUrl,
			modelId: model.id,
			apiKey: oldCredential.apiKey,
			signal,
		});
		logger.debug("auth-gateway retrying provider request after usage-limit block", {
			format,
			provider: model.provider,
			peer,
			switched,
			retryAfterMs,
			retryAtMs,
			error: message,
		});
		if (!switched) return undefined;
		const apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, { modelId: model.id, signal });
		return apiKey ? { apiKey } : undefined;
	}
	await bootOpts.storage.invalidateCredentialMatching(model.provider, oldCredential.apiKey, { sessionId, signal });
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format,
		provider: model.provider,
		peer,
		error: message,
	});
	const apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, { modelId: model.id, signal });
	return apiKey ? { apiKey } : undefined;
}

/**
 * Build the {@link ApiKeyResolver} handed to `streamSimple` for a gateway
 * request. Drives the central a/b/c auth-retry policy server-side:
 *
 * - initial resolve → the credential already resolved for this request.
 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential
 *   (a peer/broker may have rotated its token out from under our cached copy).
 * - step (c) `lastChance` → {@link refreshGatewayApiKeyAfterAuthError} switches
 *   to a sibling (usage-limit block vs credential invalidation by error class).
 *
 * `lastKey` tracks the most recent bearer so the switch step invalidates the
 * credential that actually failed.
 */
function buildGatewayApiKeyResolver(
	bootOpts: AuthGatewayBootOptions,
	model: Model<Api>,
	sessionId: string,
	initialCredential: GatewayResolvedCredential,
	requestSignal: AbortSignal,
	format: string,
	peer: string,
	policyRequest?: GatewayPolicyRequest,
): ApiKeyResolver {
	const policy = policyRequest?.policy;
	let currentCredential = initialCredential;
	return async ({ lastChance, error, signal }) => {
		if (policyRequest?.observerError) throw policyRequest.observerError;
		const sig = signal ?? requestSignal;
		if (error === undefined) {
			currentCredential = initialCredential;
			return initialCredential.apiKey;
		}
		if (!lastChance) {
			if (policyRequest && policy) {
				const credentialId = currentCredential.credentialId;
				if (credentialId === undefined || !policy.allowedOAuthCredentialIds.has(credentialId)) return undefined;
				const resolved = await bootOpts.storage.getOAuthApiKeyByCredentialId(model.provider, credentialId, {
					modelId: model.id,
					signal: sig,
					forceRefresh: true,
				});
				if (!resolved || !policy.allowedOAuthCredentialIds.has(resolved.credentialId)) {
					await policyRequest.observe({
						type: "error",
						...policyObservationBase(policy),
						stage: "credential_selection",
						code: "credential_rotation_unavailable",
					});
					return undefined;
				}
				await policyRequest.observe({
					type: "credential_selection",
					...policyObservationBase(policy),
					credentialId: resolved.credentialId,
					phase: "force_refresh",
				});
				currentCredential = resolved;
				return resolved.apiKey;
			}
			const refreshed = await bootOpts.storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: sig,
				forceRefresh: true,
			});
			if (refreshed) currentCredential = { apiKey: refreshed };
			return refreshed;
		}
		const next = await refreshGatewayApiKeyAfterAuthError(
			bootOpts,
			model,
			sessionId,
			currentCredential,
			error,
			sig,
			format,
			peer,
			policyRequest,
		);
		if (next) currentCredential = next;
		return next?.apiKey;
	};
}

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}

function genericPolicyErrorMessage(message: AssistantMessage, reason: "error" | "aborted"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: message.api,
		provider: message.provider,
		model: message.model,
		timestamp: message.timestamp,
		usage: message.usage,
		stopReason: reason,
		errorMessage: reason === "aborted" ? "Request was aborted" : "Upstream request failed",
		errorStatus: message.errorStatus,
		errorId: message.errorId,
	};
}

function withPolicyEventObservations(
	events: AssistantMessageEventStream,
	policyRequest: GatewayPolicyRequest,
	abortUpstream: (reason: Error) => void,
): AssistantMessageEventStream {
	const observed = new AssistantMessageEventStream();
	const pump = async (): Promise<void> => {
		try {
			for await (const event of events) {
				if (policyRequest.observerError) {
					abortUpstream(policyRequest.observerError);
					observed.fail(policyRequest.observerError);
					return;
				}
				if (event.type === "done") {
					await policyRequest.settleSuccessBestEffort();
					observed.push(event);
					return;
				}
				if (event.type === "error") {
					if (event.reason === "aborted") {
						await policyRequest.settleAbortedBestEffort();
					} else {
						await policyRequest.fail("upstream", "upstream_error");
					}
					observed.push({
						type: "error",
						reason: event.reason,
						error: genericPolicyErrorMessage(event.error, event.reason),
					});
					return;
				}
				observed.push(event);
			}
			abortUpstream(new Error("Gateway upstream stream ended before a terminal event"));
			await policyRequest.fail("upstream", "upstream_error");
			observed.fail(new Error("Gateway upstream stream failed"));
		} catch (error) {
			if (policyRequest.observerError) {
				abortUpstream(policyRequest.observerError);
				observed.fail(policyRequest.observerError);
				return;
			}
			try {
				await policyRequest.fail("upstream", "upstream_error");
			} catch (observationError) {
				observed.fail(observationError);
				return;
			}
			observed.fail(
				error instanceof AuthGatewayObserverDeliveryError ? error : new Error("Gateway upstream stream failed"),
			);
		}
	};
	void pump();
	return observed;
}

// (handlePassthrough removed — see note above.)

async function handleFormatEndpoint(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);
	if (
		bootOpts.authorizeRequest &&
		!isBoundedPolicyText(
			req.headers.get(AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER),
			MAX_POLICY_AUTHORIZATION_INPUT_LENGTH,
		)
	) {
		return route.module.formatError(401, "authorization_error", "Missing or invalid gateway policy authorization");
	}

	let body: unknown;
	let payloadByteLength = 0;
	let payloadSha256 = "";
	try {
		if (bootOpts.authorizeRequest) {
			const bounded = await readBoundedJson(req, MAX_POLICY_REQUEST_BODY_BYTES);
			body = bounded.value;
			payloadByteLength = bounded.byteLength;
			payloadSha256 = bounded.sha256;
		} else {
			body = await req.json();
		}
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = bootOpts.authorizeRequest ? "Invalid JSON request body" : `Invalid JSON body: ${String(error)}`;
		return route.module.formatError(400, "invalid_request_error", message);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	// All three supported wire formats put the model id on a top-level `model`
	// field. Read it without running the full strict schema so the route can
	// produce a coherent error envelope when the model id is missing.
	let modelId: string | undefined;
	if (typeof body === "object" && body !== null && "model" in body && typeof body.model === "string") {
		modelId = body.model;
	}
	if (!modelId) {
		return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	}

	const nativeModel = bootOpts.authorizeRequest ? undefined : bootOpts.resolveModel(modelId);
	if (!bootOpts.authorizeRequest && !nativeModel) {
		return route.module.formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
	}

	// Parse the wire-format request BEFORE resolving the credential so we
	// have a stable per-conversation `sessionId` to thread into AuthStorage.
	// Sticky-credential tracking and `markUsageLimitReached` both key off
	// this id; without it `getApiKey` would re-roundrobin every request
	// and `markUsageLimitReached` would no-op (it can only mark the
	// credential it last handed out to that session).
	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = bootOpts.authorizeRequest
			? "Invalid provider-format request body"
			: error instanceof Error
				? error.message
				: String(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	const authorization = await authorizeGatewayRequest(
		bootOpts,
		req,
		{
			requestId,
			format: route.label,
			requestedModelId: parsed.modelId,
			requestedSessionId: parsed.options.promptCacheKey,
			payloadByteLength,
			payloadSha256,
		},
		route.module.formatError,
	);
	if (!authorization.ok) return authorization.response;
	const policy = authorization.policy;
	const policyRequest = policy ? new GatewayPolicyRequest(policy, bootOpts) : undefined;
	const abortedAfterGrant = async (): Promise<Response> => {
		await policyRequest?.settleAbortedBestEffort();
		return clientClosedResponse(route);
	};
	if (controller.signal.aborted) return abortedAfterGrant();

	const resolvedModelId = policy?.resolvedModelId ?? parsed.modelId;
	const model = policy ? bootOpts.resolveModel(resolvedModelId) : nativeModel;
	if (!model) {
		if (policyRequest) {
			try {
				await policyRequest.fail("model_resolution", "model_unavailable");
			} catch (error) {
				if (error instanceof AuthGatewayObserverDeliveryError) {
					return observerFailureResponse(route.module.formatError);
				}
				throw error;
			}
			return route.module.formatError(404, "invalid_request_error", "Authorized model is unavailable");
		}
		return route.module.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}

	// In policy mode parser-captured account, organization, project, client,
	// and credential headers are discarded before provider options are built.
	const captured = captureRequestHeaders(req.headers, { stripPolicyIdentity: policy !== undefined });
	const parsedHeaders = policy ? {} : (parsed.options.headers ?? {});
	parsed.options.headers = { ...captured, ...parsedHeaders };

	const sessionId =
		policy?.sessionId ?? parsed.options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	if (policy) {
		parsed.options.promptCacheKey = sessionId;
		delete parsed.options.user;
		delete parsed.options.metadata;
		delete parsed.options.previousResponseId;
	} else {
		parsed.options.promptCacheKey ??= sessionId;
	}
	if (controller.signal.aborted) return abortedAfterGrant();

	let credential: GatewayResolvedCredential | undefined;
	try {
		if (policy) {
			const access = await bootOpts.storage.getOAuthApiKeyFromCredentialIds(
				model.provider,
				sessionId,
				policy.allowedOAuthCredentialIds,
				{ modelId: model.id, signal: controller.signal },
			);
			if (controller.signal.aborted) return abortedAfterGrant();
			if (access && policy.allowedOAuthCredentialIds.has(access.credentialId)) {
				await policyRequest?.observe({
					type: "credential_selection",
					...policyObservationBase(policy),
					credentialId: access.credentialId,
					phase: "initial",
				});
				credential = access;
			}
		} else {
			const apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: controller.signal,
			});
			if (apiKey) credential = { apiKey };
		}
	} catch (error) {
		if (error instanceof AuthGatewayObserverDeliveryError || policyRequest?.observerError) {
			return observerFailureResponse(route.module.formatError);
		}
		if (controller.signal.aborted) return abortedAfterGrant();
		if (policyRequest) {
			try {
				await policyRequest.fail("credential_selection", "credential_unavailable");
			} catch (observationError) {
				if (observationError instanceof AuthGatewayObserverDeliveryError) {
					return observerFailureResponse(route.module.formatError);
				}
				throw observationError;
			}
			return route.module.formatError(503, "authentication_error", "Authorized OAuth credential selection failed");
		}
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return route.module.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return abortedAfterGrant();
	if (!credential) {
		if (policyRequest) {
			try {
				await policyRequest.fail("credential_selection", "credential_unavailable");
			} catch (error) {
				if (error instanceof AuthGatewayObserverDeliveryError) {
					return observerFailureResponse(route.module.formatError);
				}
				throw error;
			}
			return route.module.formatError(401, "authentication_error", "No authorized OAuth credential is available");
		}
		return route.module.formatError(
			401,
			"authentication_error",
			`No credential available for provider ${model.provider}`,
		);
	}

	const streamOpts = buildStreamOptions(parsed, model.api, controller.signal);
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		bootOpts,
		model,
		sessionId,
		credential,
		controller.signal,
		route.label,
		peer,
		policyRequest,
	);

	logger.info("auth-gateway request", {
		requestId,
		format: route.label,
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return abortedAfterGrant();
			const message = await completeSimple(model, parsed.context, streamOpts);
			if (policyRequest?.observerError) return observerFailureResponse(route.module.formatError);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				if (policyRequest) {
					if (message.stopReason === "aborted") {
						await policyRequest.settleAbortedBestEffort();
						return route.module.formatError(499, "request_aborted", "Request was aborted");
					}
					await policyRequest.fail("upstream", "upstream_error");
					return route.module.formatError(502, "upstream_error", "Upstream request failed");
				}
				logger.warn("auth-gateway non-streaming failed", {
					format: route.label,
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					return route.module.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(errorMessage);
				return route.module.formatError(classified.status, classified.type, errorMessage);
			}
			if (policyRequest?.observerError) return observerFailureResponse(route.module.formatError);
			await policyRequest?.settleSuccessBestEffort();
			return json(
				200,
				route.module.encodeResponse(message, parsed.modelId),
				gatewayResponseHeaders(model, { requestId, message, startedAt }),
			);
		} catch (error) {
			if (error instanceof AuthGatewayObserverDeliveryError || policyRequest?.observerError) {
				return observerFailureResponse(route.module.formatError);
			}
			if (controller.signal.aborted) return abortedAfterGrant();
			if (policyRequest) {
				try {
					await policyRequest.fail("upstream", "upstream_error");
				} catch (observationError) {
					if (observationError instanceof AuthGatewayObserverDeliveryError) {
						return observerFailureResponse(route.module.formatError);
					}
					throw observationError;
				}
				return route.module.formatError(502, "upstream_error", "Upstream request failed");
			}
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", {
				format: route.label,
				error: classified.message,
				peer,
			});
			return route.module.formatError(classified.status, classified.type, classified.message);
		}
	}

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return abortedAfterGrant();
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		if (error instanceof AuthGatewayObserverDeliveryError || policyRequest?.observerError) {
			return observerFailureResponse(route.module.formatError);
		}
		if (policyRequest) {
			try {
				await policyRequest.fail("upstream", "upstream_error");
			} catch (observationError) {
				if (observationError instanceof AuthGatewayObserverDeliveryError) {
					return observerFailureResponse(route.module.formatError);
				}
				throw observationError;
			}
			return route.module.formatError(502, "upstream_error", "Upstream request failed");
		}
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", { format: route.label, error: classified.message, peer });
		return route.module.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return abortedAfterGrant();

	if (policyRequest) {
		events = withPolicyEventObservations(events, policyRequest, reason => {
			if (!controller.signal.aborted) controller.abort(reason);
		});
	}
	const sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options, {
		signal: controller.signal,
		onCancel: reason => {
			if (!controller.signal.aborted) {
				controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
			}
			void policyRequest?.settleAbortedBestEffort();
		},
	});
	return new Response(sseStream, {
		status: 200,
		headers: {
			...gatewayResponseHeaders(model, { requestId }),
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			// Disable proxy buffering (nginx and ingress controllers honor this).
			// Without it the SSE stream gets held until the buffer flushes, which
			// stalls the long-thinking-budget calls we exist to support.
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Pi-native fast path: `POST /v1/pi/stream`. Accepts the canonical pi-ai
 * `Context` directly (no wire-format round-trip) and emits a bandwidth-shrunk
 * event stream matching `pi-agent`'s `streamProxy`. Skips the OpenAI /
 * Anthropic / Responses translation layers — those exist to bridge foreign
 * SDKs (llm-git, anthropic-sdk, openai-sdk), and bridging back to pi-native
 * just to bridge forward again is wasted work.
 *
 * Every other gateway concern (bearer auth, model resolve, credential fetch,
 * abort mirroring, codex temperature/topP strip, prefix-cache key derivation,
 * Claude-Code OAuth shaping inside `streamSimple`) still applies — only
 * `parseRequest`/`encodeResponse`/`encodeStream` differ from the format-endpoint
 * path.
 */
async function handlePiNative(bootOpts: AuthGatewayBootOptions, req: Request, peer: string): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => piNative.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();
	if (
		bootOpts.authorizeRequest &&
		!isBoundedPolicyText(
			req.headers.get(AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER),
			MAX_POLICY_AUTHORIZATION_INPUT_LENGTH,
		)
	) {
		return piNative.formatError(401, "authorization_error", "Missing or invalid gateway policy authorization");
	}

	let body: unknown;
	let payloadByteLength = 0;
	let payloadSha256 = "";
	try {
		if (bootOpts.authorizeRequest) {
			const bounded = await readBoundedJson(req, MAX_POLICY_REQUEST_BODY_BYTES);
			body = bounded.value;
			payloadByteLength = bounded.byteLength;
			payloadSha256 = bounded.sha256;
		} else {
			body = await req.json();
		}
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = bootOpts.authorizeRequest ? "Invalid JSON request body" : `Invalid JSON body: ${String(error)}`;
		return piNative.formatError(400, "invalid_request_error", message);
	}
	if (controller.signal.aborted) return aborted();

	let nativeModel: Model<Api> | undefined;
	if (!bootOpts.authorizeRequest && typeof body === "object" && body !== null) {
		let requestedModelId: string | undefined;
		if ("modelId" in body && typeof body.modelId === "string" && body.modelId.length > 0) {
			requestedModelId = body.modelId;
		} else if ("model" in body && typeof body.model === "string" && body.model.length > 0) {
			requestedModelId = body.model;
		} else if (
			"model" in body &&
			typeof body.model === "object" &&
			body.model !== null &&
			"id" in body.model &&
			typeof body.model.id === "string" &&
			body.model.id.length > 0
		) {
			requestedModelId = body.model.id;
		}
		if (requestedModelId) {
			nativeModel = bootOpts.resolveModel(requestedModelId);
			if (!nativeModel) {
				return piNative.formatError(404, "invalid_request_error", `Unknown model: ${requestedModelId}`);
			}
		}
	}

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = bootOpts.authorizeRequest
			? "Invalid pi-native request body"
			: error instanceof Error
				? error.message
				: String(error);
		return piNative.formatError(400, "invalid_request_error", message);
	}

	const authorization = await authorizeGatewayRequest(
		bootOpts,
		req,
		{
			requestId,
			format: "pi-native",
			requestedModelId: parsed.modelId,
			requestedSessionId: parsed.options.sessionId ?? parsed.options.promptCacheKey,
			payloadByteLength,
			payloadSha256,
		},
		piNative.formatError,
	);
	if (!authorization.ok) return authorization.response;
	const policy = authorization.policy;
	const policyRequest = policy ? new GatewayPolicyRequest(policy, bootOpts) : undefined;
	const abortedAfterGrant = async (): Promise<Response> => {
		await policyRequest?.settleAbortedBestEffort();
		return aborted();
	};
	if (controller.signal.aborted) return abortedAfterGrant();

	const resolvedModelId = policy?.resolvedModelId ?? parsed.modelId;
	const model = policy ? bootOpts.resolveModel(resolvedModelId) : nativeModel;
	if (!model) {
		if (policyRequest) {
			try {
				await policyRequest.fail("model_resolution", "model_unavailable");
			} catch (error) {
				if (error instanceof AuthGatewayObserverDeliveryError) {
					return observerFailureResponse(piNative.formatError);
				}
				throw error;
			}
			return piNative.formatError(404, "invalid_request_error", "Authorized model is unavailable");
		}
		return piNative.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}

	const sessionId = policy?.sessionId ?? parsed.options.sessionId ?? deriveSessionId(parsed.modelId, parsed.context);
	if (policy) {
		parsed.options.sessionId = sessionId;
		parsed.options.promptCacheKey = sessionId;
		parsed.options.headers = {};
		delete parsed.options.metadata;
		delete parsed.options.initiatorOverride;
		delete parsed.options.cachedContent;
		delete parsed.options.openrouterVariant;
		delete parsed.options.statefulResponses;
	} else {
		parsed.options.sessionId ??= sessionId;
	}
	if (controller.signal.aborted) return abortedAfterGrant();

	let credential: GatewayResolvedCredential | undefined;
	try {
		if (policy) {
			const access = await bootOpts.storage.getOAuthApiKeyFromCredentialIds(
				model.provider,
				sessionId,
				policy.allowedOAuthCredentialIds,
				{ modelId: model.id, signal: controller.signal },
			);
			if (controller.signal.aborted) return abortedAfterGrant();
			if (access && policy.allowedOAuthCredentialIds.has(access.credentialId)) {
				await policyRequest?.observe({
					type: "credential_selection",
					...policyObservationBase(policy),
					credentialId: access.credentialId,
					phase: "initial",
				});
				credential = access;
			}
		} else {
			const apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: controller.signal,
			});
			if (apiKey) credential = { apiKey };
		}
	} catch (error) {
		if (error instanceof AuthGatewayObserverDeliveryError || policyRequest?.observerError) {
			return observerFailureResponse(piNative.formatError);
		}
		if (controller.signal.aborted) return abortedAfterGrant();
		if (policyRequest) {
			try {
				await policyRequest.fail("credential_selection", "credential_unavailable");
			} catch (observationError) {
				if (observationError instanceof AuthGatewayObserverDeliveryError) {
					return observerFailureResponse(piNative.formatError);
				}
				throw observationError;
			}
			return piNative.formatError(503, "authentication_error", "Authorized OAuth credential selection failed");
		}
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return piNative.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return abortedAfterGrant();
	if (!credential) {
		if (policyRequest) {
			try {
				await policyRequest.fail("credential_selection", "credential_unavailable");
			} catch (error) {
				if (error instanceof AuthGatewayObserverDeliveryError) {
					return observerFailureResponse(piNative.formatError);
				}
				throw error;
			}
			return piNative.formatError(401, "authentication_error", "No authorized OAuth credential is available");
		}
		return piNative.formatError(
			401,
			"authentication_error",
			`No credential available for provider ${model.provider}`,
		);
	}

	// Build the SimpleStreamOptions actually handed to `streamSimple`. We
	// trust the client's options (already allow-listed by `parseRequest`) and
	// only inject server-controlled fields. The codex sampling strip mirrors
	// `buildStreamOptions` — Codex rejects every one with a 400 (#3117).
	const streamOpts: SimpleStreamOptions = { ...parsed.options, signal: controller.signal };
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		bootOpts,
		model,
		sessionId,
		credential,
		controller.signal,
		"pi-native",
		peer,
		policyRequest,
	);
	if (model.api === "openai-codex-responses") {
		delete streamOpts.temperature;
		delete streamOpts.topP;
		delete streamOpts.topK;
		delete streamOpts.minP;
		delete streamOpts.stopSequences;
		delete streamOpts.presencePenalty;
		delete streamOpts.frequencyPenalty;
		delete streamOpts.repetitionPenalty;
	}
	// Merge gateway-captured passthrough headers under the client's own
	// headers. Policy mode strips caller-controlled identity and auth values
	// from both sources, and the authorized session always wins.
	const captured = captureRequestHeaders(req.headers, { stripPolicyIdentity: policy !== undefined });
	const optionHeaders = policy ? {} : (streamOpts.headers ?? {});
	streamOpts.headers = { ...captured, ...optionHeaders };
	if (policy) {
		streamOpts.sessionId = sessionId;
		streamOpts.promptCacheKey = sessionId;
	} else {
		streamOpts.sessionId ??= sessionId;
	}

	logger.info("auth-gateway request", {
		requestId,
		format: "pi-native",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return abortedAfterGrant();
			const message = await completeSimple(model, parsed.context, streamOpts);
			if (policyRequest?.observerError) return observerFailureResponse(piNative.formatError);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				if (policyRequest) {
					if (message.stopReason === "aborted") {
						await policyRequest.settleAbortedBestEffort();
						return piNative.formatError(499, "request_aborted", "Request was aborted");
					}
					await policyRequest.fail("upstream", "upstream_error");
					return piNative.formatError(502, "upstream_error", "Upstream request failed");
				}
				logger.warn("auth-gateway non-streaming failed", {
					format: "pi-native",
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					return piNative.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(errorMessage);
				return piNative.formatError(classified.status, classified.type, errorMessage);
			}
			if (policyRequest?.observerError) return observerFailureResponse(piNative.formatError);
			await policyRequest?.settleSuccessBestEffort();
			return json(200, { message }, gatewayResponseHeaders(model, { requestId, message, startedAt }));
		} catch (error) {
			if (error instanceof AuthGatewayObserverDeliveryError || policyRequest?.observerError) {
				return observerFailureResponse(piNative.formatError);
			}
			if (controller.signal.aborted) return abortedAfterGrant();
			if (policyRequest) {
				try {
					await policyRequest.fail("upstream", "upstream_error");
				} catch (observationError) {
					if (observationError instanceof AuthGatewayObserverDeliveryError) {
						return observerFailureResponse(piNative.formatError);
					}
					throw observationError;
				}
				return piNative.formatError(502, "upstream_error", "Upstream request failed");
			}
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", { format: "pi-native", error: classified.message, peer });
			return piNative.formatError(classified.status, classified.type, classified.message);
		}
	}

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return abortedAfterGrant();
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		if (error instanceof AuthGatewayObserverDeliveryError || policyRequest?.observerError) {
			return observerFailureResponse(piNative.formatError);
		}
		if (policyRequest) {
			try {
				await policyRequest.fail("upstream", "upstream_error");
			} catch (observationError) {
				if (observationError instanceof AuthGatewayObserverDeliveryError) {
					return observerFailureResponse(piNative.formatError);
				}
				throw observationError;
			}
			return piNative.formatError(502, "upstream_error", "Upstream request failed");
		}
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", { format: "pi-native", error: classified.message, peer });
		return piNative.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return abortedAfterGrant();

	if (policyRequest) {
		events = withPolicyEventObservations(events, policyRequest, reason => {
			if (!controller.signal.aborted) controller.abort(reason);
		});
	}
	const sseStream = piNative.encodeStream(events, parsed.modelId, parsed.options, {
		signal: controller.signal,
		onCancel: reason => {
			if (!controller.signal.aborted) {
				controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
			}
			void policyRequest?.settleAbortedBestEffort();
		},
	});
	return new Response(sseStream, {
		status: 200,
		headers: {
			...gatewayResponseHeaders(model, { requestId }),
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const reports = (await storage.fetchUsageReports?.({ signal })) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

/**
 * Per-credential health probe surfaced on `GET /v1/credentials/check`. Tells
 * the caller exactly which row in their broker is producing 401s — the
 * aggregate `/v1/usage` endpoint silently drops failed credentials, which is
 * the wrong shape when you're diagnosing auth.
 *
 * The probe is sequential (one credential at a time) to avoid synchronized
 * N-account fan-out tripping per-IP rate limits on provider `/usage`
 * endpoints. For multi-account pools that's the difference between getting
 * a clean diagnosis and getting a 429 storm.
 */
async function handleCredentialsCheck(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const credentials = await storage.checkCredentials({ signal });
	return json(200, { generatedAt: Date.now(), credentials });
}

function handleModelsList(opts: AuthGatewayBootOptions): Response {
	const seen = new Set<string>();
	const data: Array<{ id: string; object: "model"; owned_by: string; api: Api }> = [];
	for (const model of opts.listModels?.() ?? []) {
		const id = `${model.provider}/${model.id}`;
		if (seen.has(id)) continue;
		seen.add(id);
		data.push({
			id,
			object: "model",
			owned_by: model.provider,
			api: model.api,
		});
	}
	return json(200, { object: "list", data });
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	if (opts.authorizeRequest && (!opts.observer || !opts.readinessProbe)) {
		throw new Error("Auth gateway policy mode requires both observer and readinessProbe");
	}
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version;

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = resolvePeer(req);
			// CORS preflight is always answered without auth — browsers send
			// preflights pre-authentication and a 401 here breaks the actual
			// request before the bearer is ever attached.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					if (opts.readinessProbe) {
						try {
							if (!(await opts.readinessProbe(req.signal))) {
								return withCors(json(503, { ok: false, version }), req);
							}
						} catch {
							return withCors(json(503, { ok: false, version }), req);
						}
					}
					return withCors(json(200, { ok: true, version }), req);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-gateway request unauthorized", { method: req.method, path: pathname, peer });
					return withCors(json(401, { error: "unauthorized" }), req);
				}

				// Aggregated usage — backed by AuthStorage's 5-min per-credential cache.
				// Same shape as the broker's `/v1/usage`, so widget/llm-git speak to either with the
				// same client struct.
				if (req.method === "GET" && pathname === "/v1/usage") {
					if (opts.authorizeRequest) {
						return withCors(json(403, { error: "route unavailable in gateway policy mode" }), req);
					}
					return withCors(await handleUsage(opts.storage, req.signal), req);
				}

				// Per-credential auth probe — diagnoses which row in a multi-account
				// pool is producing 401s. Aggregated `/v1/usage` silently drops failed
				// credentials, so we need a separate endpoint that captures errors.
				if (req.method === "GET" && pathname === "/v1/credentials/check") {
					if (opts.authorizeRequest) {
						return withCors(json(403, { error: "route unavailable in gateway policy mode" }), req);
					}
					return withCors(await handleCredentialsCheck(opts.storage, req.signal), req);
				}

				// Provider-format dispatch.
				const formatRoute = FORMAT_ROUTES[pathname];
				if (formatRoute && req.method === "POST") {
					return withCors(await handleFormatEndpoint(formatRoute, opts, req, peer), req);
				}

				// Pi-native fast path. Same auth + provider plumbing as the
				// foreign-wire routes, just without the wire-format translation.
				if (req.method === "POST" && pathname === "/v1/pi/stream") {
					return withCors(await handlePiNative(opts, req, peer), req);
				}

				// Model catalog.
				if (req.method === "GET" && pathname === "/v1/models") {
					if (opts.authorizeRequest) {
						return withCors(json(403, { error: "route unavailable in gateway policy mode" }), req);
					}
					return withCors(handleModelsList(opts), req);
				}

				// Route-table miss: no format module to defer to, so we emit a
				// plain JSON 404 rather than guessing at a protocol-specific envelope.
				return withCors(json(404, { error: `No route: ${req.method} ${pathname}` }), req);
			} catch (error) {
				logger.error("auth-gateway handler crashed", {
					method: req.method,
					path: pathname,
					peer,
					error: String(error),
				});
				return withCors(json(500, { error: "internal error" }), req);
			}
		},
		// Max-out Bun's idle timeout. Long thinking-budget calls can sit idle
		// for minutes before the first token arrives; the default kills them.
		idleTimeout: 255,
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			server.stop(true);
		},
	};
}
