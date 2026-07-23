/**
 * Settings-aware stream wrapper shared by the main agent (sdk.ts) and the
 * advisor agent (AgentSession.#buildAdvisorRuntime).
 *
 * verbosity, stream watchdog budgets, per-provider in-flight caps, and the loop
 * guard out of `Settings`
 * per request, layering them onto whatever options the caller passed. Before
 * this helper existed, advisor turns called bare `streamSimple` while the main
 * turn went through an inline closure that read these settings — so an advisor on
 * OpenRouter never saw `providers.openrouterVariant`, breaking sticky routing
 * and OpenRouter response-cache hits across advisor calls.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	type AuthStorage,
	isApiKeyResolver,
	type RateLimitRotationOptions,
	type SimpleStreamOptions,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import { isAnthropicFableOrMythosModel } from "@oh-my-pi/pi-catalog/identity";
import { getDefault, type Settings, validateProviderMaxInFlightRequests } from "../config/settings";

/**
 * Per-session binding for the rate-limit rotation seam. `authStorage` answers
 * sibling availability; the provider is taken from the per-call resolved model
 * so mid-run model switches (context promotion, retry fallback) re-bind it.
 */
export interface StreamRotationBinding {
	authStorage: Pick<AuthStorage, "hasUsableSibling">;
	getSessionId: () => string | undefined;
	onRotated?: (info: { provider: string; modelId?: string }) => void;
}

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/**
 * Sanitize the configured `retry.rotateMinSleepMs` surface threshold. The
 * setting is a bare schema number with no runtime validation, so a corrupt or
 * negative value (NaN, -1) would drop the "only rotate after a long wait"
 * threshold below zero and make every transient 429 rotation-eligible — the
 * opposite of the intent. Non-finite or negative values fall back to the schema
 * default, read programmatically so it never drifts from `SETTINGS_SCHEMA`.
 */
function sanitizeRotateMinSleepMs(value: number): number {
	if (!Number.isFinite(value) || value < 0) return getDefault("retry.rotateMinSleepMs");
	return value;
}

/**
 * THE single constructor for a request's `rateLimitRotation` options — the
 * settings-aware stream wrapper and the direct `completeSimple` oneshots
 * (compaction, title generation) all build through here so the enabled-flag
 * gate, `minSleepMs` sanitization, and sibling-probe binding cannot drift.
 *
 * `getSessionId` must return the SAME session id the request's apiKey resolver
 * was built with (main session vs. advisor provider session) — the sibling
 * probe reads that session's sticky credential, so a mismatched id probes the
 * wrong pool. It is a getter, not a value, because the probe fires mid-request
 * and the main session id can be assigned after request setup.
 *
 * Callers must only attach the result to resolver-form `apiKey` requests — a
 * surfaced marker error is terminal for a static key.
 *
 * Rotation off (or no binding) → `undefined`, leaving the request options
 * identical to the pre-rotation shape.
 */
export function buildRateLimitRotationOptions(
	settings: Settings,
	rotation: StreamRotationBinding | undefined,
	provider: string,
	getSessionId: () => string | undefined,
): RateLimitRotationOptions | undefined {
	if (!rotation || !settings.get("retry.rotateOnRateLimit")) return undefined;
	return {
		enabled: true,
		provider,
		minSleepMs: sanitizeRotateMinSleepMs(settings.get("retry.rotateMinSleepMs")),
		hasUsableSibling: () => rotation.authStorage.hasUsableSibling(provider, getSessionId()),
		onRotated: rotation.onRotated,
	};
}

/**
 * Build a {@link StreamFn} that reads provider routing/guard settings from
 * `settings` per call and forwards to `base` (defaults to `streamSimple`).
 *
 * Caller-supplied `streamOptions` always win — the helper only fills holes.
 */
export function createSettingsAwareStreamFn(
	settings: Settings,
	base: StreamFn = streamSimple,
	rotation?: StreamRotationBinding,
): StreamFn {
	return (model, context, streamOptions) => {
		const openrouterRoutingPreset = settings.get("providers.openrouterVariant");
		const openrouterVariant =
			openrouterRoutingPreset && openrouterRoutingPreset !== "default" ? openrouterRoutingPreset : undefined;
		const antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
		const textVerbosity =
			model.api === "openai-codex-responses" || model.api === "openai-responses"
				? settings.get("textVerbosity")
				: undefined;
		const streamFirstEventTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamFirstEventTimeoutSeconds"));
		const streamIdleTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamIdleTimeoutSeconds"));
		// Server-side fallback (opt-in): when the user enables it AND the
		// resolved model is a Claude Fable/Mythos on Anthropic's messages
		// API, inject the `fallbacks: [{ model: "claude-opus-4-8" }]` chain.
		// The provider layer picks it up, sends the beta header, and honors
		// the response signals. Every other model / API is untouched.
		const serverSideFallbackEnabled =
			settings.get("providers.anthropic.serverSideFallback") &&
			model.api === "anthropic-messages" &&
			model.provider === "anthropic" &&
			isAnthropicFableOrMythosModel(model.id);
		const fallbacks =
			streamOptions?.fallbacks ?? (serverSideFallbackEnabled ? [{ model: "claude-opus-4-8" }] : undefined);
		// Rate-limit rotation (opt-in): only for resolver-form apiKey requests —
		// a surfaced marker error is terminal for a static key. `hasUsableSibling`
		// closes over THIS call's resolved model.provider (mirrors the
		// serverSideFallbackEnabled per-request gating above). The probe's session
		// id prefers the one the resolver itself was built with: this wrapper is
		// shared by the main agent, the advisor, and the autolearn capture agent,
		// whose resolvers sticky under different sessions — the binding's
		// getSessionId only covers resolvers that don't carry their own id.
		const requestApiKey = streamOptions?.apiKey;
		const rateLimitRotation =
			streamOptions?.rateLimitRotation ??
			(rotation && isApiKeyResolver(requestApiKey)
				? buildRateLimitRotationOptions(
						settings,
						rotation,
						model.provider,
						() => requestApiKey.sessionId ?? rotation.getSessionId(),
					)
				: undefined);
		const merged: SimpleStreamOptions = {
			...streamOptions,
			openrouterVariant: streamOptions?.openrouterVariant ?? openrouterVariant,
			antigravityEndpointMode: streamOptions?.antigravityEndpointMode ?? antigravityEndpointMode,
			textVerbosity: streamOptions?.textVerbosity ?? textVerbosity,
			streamFirstEventTimeoutMs: streamOptions?.streamFirstEventTimeoutMs ?? streamFirstEventTimeoutMs,
			streamIdleTimeoutMs: streamOptions?.streamIdleTimeoutMs ?? streamIdleTimeoutMs,
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				streamOptions?.maxInFlightRequests ?? settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: settings.get("model.loopGuard.enabled"),
				checkAssistantContent: settings.get("model.loopGuard.checkAssistantContent"),
				...streamOptions?.loopGuard,
			},
			hideThinkingSummary: streamOptions?.hideThinkingSummary ?? settings.get("omitThinking"),
			...(fallbacks !== undefined ? { fallbacks } : {}),
			...(rateLimitRotation !== undefined ? { rateLimitRotation } : {}),
		};
		return base(model, context, merged);
	};
}
