import type { Model } from "../types";

/** Whether a model supports an extended context window (opt-in via suffix like `[1m]`). */
export function supportsExtendedContext(model: Model): boolean {
	return model.extendedContextWindow != null;
}

/** Whether a model is currently using its extended context window. */
export function isExtendedContext(model: Model): boolean {
	return model.extendedContextWindow != null && model.contextWindow >= model.extendedContextWindow;
}

/**
 * Compute the short suffix tag for a model's extended context window.
 * Returns e.g. `"[1m]"`, `"[500k]"`, or `""` if the model has no extended context.
 */
export function extendedContextSuffix(model: Model): string {
	if (!model.extendedContextWindow) return "";
	const mb = model.extendedContextWindow / 1_000_000;
	if (mb >= 1 && Number.isInteger(mb)) return `[${mb}m]`;
	return `[${Math.round(model.extendedContextWindow / 1_000)}k]`;
}

/** Beta header required to unlock 1M context window on Anthropic API. */
export const CONTEXT_1M_BETA = "context-1m-2025-08-07";

/** Clone a model with its extended context window active. */
export function applyExtendedContext(model: Model, extendedContext: boolean): Model {
	if (!extendedContext || !model.extendedContextWindow) return model;
	const baseName = model.name ?? model.id;
	const suffix = extendedContextSuffix(model);
	const tag = suffix.toUpperCase();
	return {
		...model,
		name: baseName.includes(tag) ? baseName : `${baseName} ${tag}`,
		contextWindow: model.extendedContextWindow,
	};
}

// ============================================================
// Extended context entitlement (Anthropic overage header)
// ============================================================
//
// Anthropic's API piggybacks an `anthropic-ratelimit-unified-overage-disabled-reason`
// header on every response. For OAuth/subscription users this gates whether 1M
// context is available. API key users are always allowed (the API enforces limits).
//
// The cached value is `undefined` (never checked), `null` (allowed), or a reason string.

/** Response header that carries the overage-disabled reason. */
export const OVERAGE_DISABLED_HEADER = "anthropic-ratelimit-unified-overage-disabled-reason";

/**
 * Reasons that disable extended context for OAuth/subscription users.
 * If the cached reason is one of these, the user cannot activate [1m].
 */
const BLOCKING_OVERAGE_REASONS = new Set([
	"overage_not_provisioned",
	"org_level_disabled",
	"org_level_disabled_until",
	"seat_tier_level_disabled",
	"member_level_disabled",
	"seat_tier_zero_credit_limit",
	"group_zero_credit_limit",
	"member_zero_credit_limit",
	"org_service_level_disabled",
	"org_service_zero_credit_limit",
	"no_limits_configured",
	"unknown",
]);

/** Cached overage-disabled reason: `undefined` = never checked, `null` = allowed, string = reason. */
let cachedOverageReason: string | null | undefined;

/**
 * Update the cached overage-disabled reason from API response headers.
 * Call this from the `onResponseHeaders` callback for Anthropic providers.
 */
export function updateOverageDisabledReason(headers: Record<string, string>): void {
	const reason = headers[OVERAGE_DISABLED_HEADER] ?? null;
	cachedOverageReason = reason;
}

/**
 * Whether the current user has access to extended context based on the
 * overage-disabled reason cached from Anthropic response headers.
 *
 * - `undefined` (never checked): conservative, disallow for OAuth users
 * - `null` (no restriction): allowed
 * - `"out_of_credits"`: still allowed (mirrors Claude Code behavior)
 * - Any blocking reason: disallowed
 */
export function hasExtendedContextAccess(isOAuth: boolean): boolean {
	// API key users are always allowed — the API enforces limits directly
	if (!isOAuth) return true;
	// OAuth user: check cached reason
	if (cachedOverageReason === undefined) return false; // never checked → conservative
	if (cachedOverageReason === null) return true; // no restriction
	if (cachedOverageReason === "out_of_credits") return true; // still allowed
	return !BLOCKING_OVERAGE_REASONS.has(cachedOverageReason);
}

/** Reset cached state (for testing). */
export function resetOverageCache(): void {
	cachedOverageReason = undefined;
}
