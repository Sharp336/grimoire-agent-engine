import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	CacheRetention,
	Context,
	OpenAIResponseInclude,
	ServiceTier,
	TokenTaskBudget,
} from "../types";

/**
 * Wire types for the omp auth-gateway.
 *
 * The gateway sits between unauthenticated clients (containerized omp,
 * llm-git, …) and the broker. It accepts provider-format HTTP requests
 * (OpenAI chat-completions / Anthropic messages / OpenAI Responses),
 * dispatches them through pi-ai's `streamSimple()`, and translates the
 * canonical event stream back to the matching wire format. The gateway
 * injects `Authorization` server-side so clients never see access tokens.
 */

/** Default bind. Loopback-only — front with reverse proxy for remote access. */
export const DEFAULT_AUTH_GATEWAY_BIND = "127.0.0.1:4000";

/** Sensitive one-time policy input. Never forwarded upstream, observed, or logged. */
export const AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER = "x-omp-auth-gateway-authorization";

export type AuthGatewayToolChoice = "auto" | "none" | "required" | { name: string } | { type: "computer" };

export interface AuthGatewayParsedRequestOptions {
	// ── Sampling ──────────────────────────────────────────────────────────
	maxOutputTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	/** OpenAI nucleus-min sampling (`min_p`). */
	minP?: number;
	/** Anthropic `stop_sequences` / OpenAI `stop`. */
	stopSequences?: string[];
	/** OpenAI `presence_penalty`. */
	presencePenalty?: number;
	/** OpenAI `frequency_penalty`. */
	frequencyPenalty?: number;
	/** OpenRouter / vLLM `repetition_penalty`. */
	repetitionPenalty?: number;
	/** OpenAI deterministic-sampling `seed`. */
	seed?: number;
	/** OpenAI `logit_bias` map (token id → bias). */
	logitBias?: Record<string, number>;
	/** OpenAI `response_format` (text | json_object | json_schema). Opaque passthrough. */
	responseFormat?: unknown;

	// ── Tools ─────────────────────────────────────────────────────────────
	toolChoice?: AuthGatewayToolChoice;
	/** OpenAI `parallel_tool_calls`. */
	parallelToolCalls?: boolean;
	/** OpenAI Responses fields requested in the response payload. */
	include?: OpenAIResponseInclude[];
	// ── Reasoning ─────────────────────────────────────────────────────────
	/** Effort-level reasoning request (OpenAI Responses / Chat `reasoning_effort`). */
	reasoning?: Effort;
	/** Force-disable reasoning (Anthropic `thinking: { type: "disabled" }`). */
	disableReasoning?: boolean;
	/**
	 * Explicit Anthropic `thinking.budget_tokens`. Mirrors Rust's
	 * `resolve_thinking_budget`: pins onto whichever effort the client
	 * requested (defaulting to High when unspecified). Preferred over the
	 * removed legacy single-number `thinkingBudget` for new code.
	 */
	explicitThinkingBudgetTokens?: number;
	/** Per-effort thinking budget map. */
	thinkingBudgets?: Partial<Record<Effort, number>>;
	/** Suppress the provider's reasoning summary stream. */
	hideThinkingSummary?: boolean;
	/** Anthropic `output_config.task_budget` advisory loop budget. */
	taskBudget?: TokenTaskBudget;

	// ── Service / routing ─────────────────────────────────────────────────
	/** OpenAI service tier (auto|default|flex|scale|priority). */
	serviceTier?: ServiceTier;
	/** Cache retention hint derived from inbound `cache_control` markers. */
	cacheRetention?: CacheRetention;
	/** OpenAI Responses `prompt_cache_key`; also seeds provider routing when no separate session id exists. */
	promptCacheKey?: string;
	/** OpenAI Responses `previous_response_id` for response chaining. */
	previousResponseId?: string;
	/** OpenAI / abuse-tracking `user` field. */
	user?: string;

	// ── Passthrough ───────────────────────────────────────────────────────
	/**
	 * Provider-specific metadata. Anthropic uses `metadata.user_id`; OpenRouter
	 * carries routing hints; xAI uses `search_parameters`; OpenAI accepts a
	 * free-form bag. The gateway forwards as-is.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Captured allow-listed passthrough headers (anthropic-beta,
	 * anthropic-version, openai-organization, openai-project, openai-beta,
	 * x-stainless-*). Keys are lowercased.
	 */
	headers?: Record<string, string>;
	/**
	 * Escape hatch for provider-specific request controls that don't yet have a
	 * first-class field. Prefer adding a typed field over widening this.
	 */
	extra?: Record<string, unknown>;
}

export interface AuthGatewayParsedRequest {
	modelId: string;
	context: Context;
	stream: boolean;
	options: AuthGatewayParsedRequestOptions;
}

export interface AuthGatewayStreamControl {
	/** Gateway request signal. Encoders stop producing frames when it aborts. */
	signal?: AbortSignal;
	/** Called when the HTTP response body is cancelled by the client. */
	onCancel?: (reason?: unknown) => void;
}

export interface AuthGatewayFormatModule {
	parseRequest(body: unknown, headers?: Headers): AuthGatewayParsedRequest;
	encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown>;
	encodeStream(
		events: AssistantMessageEventStream,
		requestedModelId: string,
		options?: AuthGatewayParsedRequestOptions,
		control?: AuthGatewayStreamControl,
	): ReadableStream<Uint8Array>;
	/**
	 * Emit a protocol-specific error envelope. OpenAI returns
	 * `{ error: { message, type } }`; Anthropic returns
	 * `{ type: "error", error: { type, message } }`.
	 */
	formatError(status: number, type: string, message: string): Response;
}

/** Bounded, content-free request metadata handed to a gateway policy hook. */
export interface AuthGatewayAuthorizationRequest {
	/** Gateway-generated identity for this HTTP request. */
	requestId: string;
	/** Wire route being authorized (for example `openai-chat` or `pi-native`). */
	format: string;
	/** Exact model selector parsed from the caller's request. */
	requestedModelId: string;
	/** Optional caller-supplied conversation hint. A grant must replace this with its own namespaced session id. */
	requestedSessionId?: string;
	method: string;
	path: string;
	/** Exact received request-body length and SHA-256, bound by the one-time authorization. */
	payloadByteLength: number;
	payloadSha256: string;
	/**
	 * Sensitive bounded one-time gateway authorization input from
	 * {@link AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER}. Never forwarded,
	 * observed, or logged.
	 */
	authorization: string;
	signal: AbortSignal;
}

/** A fail-closed policy denial. `reasonCode` is observer metadata and is never reflected to the client. */
export interface AuthGatewayAuthorizationDenial {
	authorized: false;
	reasonCode?: string;
}

/**
 * A policy grant binding one request to an exact model, session, and ordered
 * OAuth credential allowlist. Every field is validated by the gateway before
 * model resolution or credential access.
 */
export interface AuthGatewayAuthorizationGrant {
	authorized: true;
	authorizationId: string;
	requestedModelId: string;
	resolvedModelId: string;
	/** Namespaced durable identity, for example `workspace:conversation`. */
	sessionId: string;
	/** Durable OAuth credential row ids, in policy preference order. */
	allowedOAuthCredentialIds: readonly number[];
}

export type AuthGatewayAuthorizationDecision = AuthGatewayAuthorizationDenial | AuthGatewayAuthorizationGrant;

export type AuthGatewayRequestAuthorizer = (
	request: AuthGatewayAuthorizationRequest,
) => AuthGatewayAuthorizationDecision | Promise<AuthGatewayAuthorizationDecision>;

export type AuthGatewayAuthorizationObservation = {
	type: "authorization";
	requestId: string;
	format: string;
	requestedModelId: string;
	outcome: "authorized" | "denied" | "error";
	authorizationId?: string;
	resolvedModelId?: string;
	sessionId?: string;
	reasonCode?: string;
};

export interface AuthGatewayPolicyObservationBase {
	requestId: string;
	format: string;
	authorizationId: string;
	requestedModelId: string;
	resolvedModelId: string;
	sessionId: string;
}

export type AuthGatewayCredentialSelectionObservation = AuthGatewayPolicyObservationBase & {
	type: "credential_selection";
	credentialId: number;
	phase: "initial" | "force_refresh";
};

export type AuthGatewayCredentialRotationObservation = AuthGatewayPolicyObservationBase & {
	type: "credential_rotation";
	previousCredentialId: number;
	credentialId: number;
	reason: "usage_limit" | "authentication_failure";
};

export type AuthGatewayErrorObservation = AuthGatewayPolicyObservationBase & {
	type: "error";
	stage: "model_resolution" | "credential_selection" | "upstream";
	code: "model_unavailable" | "credential_unavailable" | "credential_rotation_unavailable" | "upstream_error";
};

export type AuthGatewayTerminalObservation = AuthGatewayPolicyObservationBase & {
	type: "terminal";
	outcome: "success" | "error" | "aborted";
};

/**
 * Content-free gateway observation. Events contain durable identities and
 * outcomes only: never bearer bytes, request prompts, or provider responses.
 */
export type AuthGatewayObservation =
	| AuthGatewayAuthorizationObservation
	| AuthGatewayCredentialSelectionObservation
	| AuthGatewayCredentialRotationObservation
	| AuthGatewayErrorObservation
	| AuthGatewayTerminalObservation;

export type AuthGatewayObserver = (event: AuthGatewayObservation) => void | Promise<void>;

export interface AuthGatewayServerOptions {
	/** Listen address. Default `127.0.0.1:4000`. */
	bind?: string;
	/** Accept any of these bearer tokens. Empty allows unauthenticated calls. */
	bearerTokens: readonly string[];
	/**
	 * Enables fail-closed policy mode for inference routes. Construction also
	 * requires both `observer` and `readinessProbe`.
	 */
	authorizeRequest?: AuthGatewayRequestAuthorizer;
	/**
	 * Optional trusted sink for content-free policy observations. Rejection
	 * before provider completion fails the request closed. A failed terminal
	 * success observation is reported internally but cannot replace a provider
	 * response that already completed successfully.
	 */
	observer?: AuthGatewayObserver;
	/** Optional bounded dependency probe for `/healthz`; false or rejection returns 503. */
	readinessProbe?: (signal: AbortSignal) => boolean | Promise<boolean>;
	/** Version surfaced on `/healthz`. */
	version?: string;
}

export interface AuthGatewayServerHandle {
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}
