import type { Api, Model } from "@oh-my-pi/pi-catalog";
import { filterAvailableModelsByEnabledPatterns, parseModelString } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import MODEL_PRIORITY from "../../priority.json" with { type: "json" };
import type { ToolSession } from "../../tools";
import type { TaskRoutingOptions } from "../types";
import { resolveResourcePool } from "./pool";
import type { ResourcePoolIdentity, RoutingCandidateInput, RoutingPolicy, RoutingUsageState } from "./types";

/** Intentional worker pattern: must be a concrete provider-qualified selector. Bare aliases like `flash`, `mini`, `pro` are not intentional. */
function isConcreteWorkerPattern(pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed.length || trimmed.startsWith("@")) return false;
	// Must contain a slash to be provider-qualified; glob `cursor/*` is intentional (provider-scoped), bare `flash` is not.
	return trimmed.includes("/");
}

/** Curated intentional fallback roster: only concrete selectors from priority.json, never bare aliases. */
const CONCRETE_PRIORITY_ROSTER: readonly string[] = [
	...MODEL_PRIORITY.slow.filter(isConcreteWorkerPattern),
	...MODEL_PRIORITY.designer.filter(isConcreteWorkerPattern),
	...MODEL_PRIORITY.smol.filter(isConcreteWorkerPattern),
];

/**
 * Resource pool for one provider as this session would reach it: provider +
 * configured base URL + the active account identity. Used for the parent pool
 * and for reporting the pool an explicit model pin lands in.
 */
export function resolveProviderPool(session: ToolSession, provider: string): ResourcePoolIdentity | undefined {
	if (!provider) return undefined;
	const modelRegistry = session.modelRegistry;
	const authStorage = session.authStorage ?? modelRegistry?.authStorage;
	if (!modelRegistry || !authStorage) return undefined;
	const sessionId = session.getSessionId?.() ?? undefined;
	const identity = authStorage.getOAuthAccountIdentity(provider, sessionId);
	return resolveResourcePool({
		provider,
		baseUrl: modelRegistry.getProviderBaseUrl(provider),
		accountId: identity?.accountId,
		email: identity?.email,
		credentialKind: authStorage.getCredentialOrigin(provider)?.kind,
	});
}

/** Provider slug of a model selector (`provider/id[:thinking]`). */
export function selectorProvider(selector: string): string | undefined {
	const parsed = parseModelString(selector);
	if (parsed?.provider) return parsed.provider;
	const slash = selector.indexOf("/");
	if (slash === -1) return undefined;
	return selector.slice(0, slash).trim() || undefined;
}

export function resolveParentPoolIdentity(session: ToolSession): ResourcePoolIdentity | undefined {
	const active = session.getActiveModelString?.() ?? session.getModelString?.();
	if (!active) return undefined;
	const provider = selectorProvider(active);
	return provider === undefined ? undefined : resolveProviderPool(session, provider);
}

/**
 * Build routing candidate inputs from the live model registry.
 * Uses only existing helpers: getAvailable, hasConfiguredAuth, getProviderBaseUrl,
 * authStorage.getOAuthAccountIdentity / getCredentialOrigin / getModelUsageHealth,
 * and the parent's active model string. Maps Model capability fields onto the
 * candidate shape. Usage health is resolved via cached/last-good reports only;
 * when nothing is known, emits "unknown" — never triggers network fetches
 * beyond what the cached health already holds (caller should mock health in tests).
 */
export async function buildRoutingSnapshot(session: ToolSession): Promise<{
	candidates: RoutingCandidateInput[];
	parentPool?: ResourcePoolIdentity;
}> {
	const modelRegistry = session.modelRegistry;
	const authStorage = session.authStorage ?? modelRegistry?.authStorage;
	if (!modelRegistry || !authStorage) {
		return { candidates: [], parentPool: resolveParentPoolIdentity(session) };
	}
	const sessionId = session.getSessionId?.() ?? undefined;
	const authorized = modelRegistry.getAvailable().filter(model => {
		try {
			return modelRegistry.hasConfiguredAuth(model);
		} catch {
			return false;
		}
	});
	// Eligibility comes only from intentional worker sources: the explicit roster
	// and concrete provider-qualified selectors. Broad aliases like `flash`,
	// `mini`, `pro` are never globally eligible — they would admit stale catalog
	// models such as `google/gemini-1.5-flash` which no longer exists (404).
	const intentionalWorkerModels = session.settings.get("task.routing.workerModels").filter(isConcreteWorkerPattern);
	const concreteModelRoles = Object.values(session.settings.get("modelRoles")).filter(
		(pattern): pattern is string => typeof pattern === "string" && isConcreteWorkerPattern(pattern),
	);
	const concreteAgentOverrides = Object.values(session.settings.get("task.agentModelOverrides"))
		.flat()
		.filter((pattern): pattern is string => typeof pattern === "string" && isConcreteWorkerPattern(pattern));
	const intentionalPatterns = [...intentionalWorkerModels, ...concreteModelRoles, ...concreteAgentOverrides];
	// When no intentional roster is configured, fall back to the curated concrete
	// priority roster (still provider-qualified, never bare aliases).
	const eligiblePatterns =
		intentionalPatterns.length > 0 ? intentionalPatterns : ([...CONCRETE_PRIORITY_ROSTER] as string[]);
	// Chain order is intentional ranking, so the position of the first match becomes preferredRank.
	const filtered: Model<Api>[] = [];
	const rankBySelector = new Map<string, number>();
	for (const model of filterAvailableModelsByEnabledPatterns(authorized, eligiblePatterns, session.settings)) {
		const selector = `${model.provider}/${model.id}`;
		if (rankBySelector.has(selector)) continue;
		rankBySelector.set(selector, rankBySelector.size);
		filtered.push(model);
	}

	const reservePct = session.settings.get("retry.usageReservePct");
	const reserveFraction = Number.isFinite(reservePct) ? reservePct / 100 : 0.1;

	const candidates: RoutingCandidateInput[] = [];
	// Build candidates with health in parallel, but bounded – available is typically < few hundred
	const healthResults = await Promise.all(
		filtered.map(async model => {
			const baseUrl = modelRegistry.getProviderBaseUrl(model.provider) ?? (model.baseUrl as string | undefined);
			let usage: RoutingUsageState = "unknown";
			try {
				const health = await authStorage.getModelUsageHealth(model.provider, {
					modelId: model.id,
					sessionId,
					baseUrl,
					reserveFraction,
				});
				const state = (health as { state: string }).state;
				if (state === "healthy" || state === "reserve" || state === "depleted" || state === "unknown") {
					usage = state as RoutingUsageState;
				}
			} catch {
				usage = "unknown";
			}
			return { model, baseUrl, usage };
		}),
	);

	for (const { model, baseUrl, usage } of healthResults) {
		const identity = authStorage.getOAuthAccountIdentity(model.provider, sessionId);
		const origin = authStorage.getCredentialOrigin(model.provider);
		const pool = resolveResourcePool({
			provider: model.provider,
			baseUrl,
			accountId: identity?.accountId,
			email: identity?.email,
			credentialKind: origin?.kind,
		});
		const selector = `${model.provider}/${model.id}`;
		candidates.push({
			selector,
			pool,
			vision: Array.isArray(model.input) && model.input.includes("image"),
			supportsTools: model.supportsTools !== false,
			contextWindow: model.contextWindow ?? null,
			costPerMTokenTotal: model.cost ? (model.cost.input ?? 0) + (model.cost.output ?? 0) : 0,
			reasoning: Boolean(model.reasoning),
			usage,
			preferredRank: rankBySelector.get(selector),
		});
	}

	return { candidates, parentPool: resolveParentPoolIdentity(session) };
}

export function getRoutingPolicyFromSettings(session: ToolSession): RoutingPolicy {
	return {
		enabled: session.settings.get("task.routing.enabled"),
		avoidParentPool: session.settings.get("task.routing.avoidParentPool"),
		parentPoolFallback: session.settings.get("task.routing.parentPoolFallback") === "deny" ? "deny" : "allow",
		excludePools: session.settings.get("task.routing.excludePools"),
		preferPools: session.settings.get("task.routing.preferPools"),
	};
}

/**
 * Apply a run-level routing policy for the rest of this session. Runtime
 * overrides only: a sticky policy must never rewrite persisted global config.
 */
export function applyStickyRoutingPolicy(settings: Settings, routing: TaskRoutingOptions): void {
	if (routing.excludePools !== undefined) settings.override("task.routing.excludePools", routing.excludePools);
	if (routing.preferPools !== undefined) settings.override("task.routing.preferPools", routing.preferPools);
	if (routing.allowParentPool !== undefined) {
		settings.override("task.routing.avoidParentPool", !routing.allowParentPool);
		settings.override("task.routing.parentPoolFallback", routing.allowParentPool ? "allow" : "deny");
	}
}
