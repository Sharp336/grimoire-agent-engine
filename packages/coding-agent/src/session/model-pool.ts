import type { ModelUsageHealth, ModelUsageHealthOptions, ModelUsageHealthState } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, parseModelPattern, resolveConfiguredModelPatterns } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	isKnownProvider,
	isRetryFallbackModelKey,
	isRetryFallbackWildcardKey,
	parseRetryFallbackSelector,
	parseRetryFallbackWildcard,
} from "./retry-fallback-chains";

/**
 * Weighted spread over the candidates a model role already lists.
 *
 * `modelRoles.task: anthropic/claude-opus-5,openai-codex/gpt-5.5-codex` is the
 * pool. Ordered selection (the default) always starts on the first candidate,
 * so four subagents spawned at once all land on the same subscription. Weighted
 * selection draws one candidate per session/spawn from a seed derived from the
 * session or spawn id, so the picks spread out and stay reproducible on resume.
 *
 * This layer only reorders an existing candidate list. Everything downstream
 * (first-with-auth resolution, the usage preflight, retry fallback chains) sees
 * the same shape it sees today.
 */

/** How to pick among a role's configured candidates. */
export type PoolSelectionMode = "ordered" | "weighted";

/** One resolved model in a role's candidate pool. */
export interface PoolCandidate {
	selector: string;
	provider: string;
	id: string;
	baseUrl?: string;
}

/** Predicate excluding candidates that are unusable before health is consulted. */
export type PoolEligibilityCheck = (candidate: PoolCandidate, index: number) => boolean;

/** Per-candidate usage health, aligned to the candidate list order. */
export type PoolHealthLookup = (candidate: PoolCandidate, index: number) => ModelUsageHealthState | undefined;

/** The subset of `AuthStorage` the pool health fan-out needs. */
export interface PoolUsageHealthSource {
	getModelUsageHealth(provider: string, options: ModelUsageHealthOptions): Promise<ModelUsageHealth>;
}

/** Inputs for a single deterministic draw. */
export interface PoolDrawOptions {
	seed: number;
	weightFor: (candidate: PoolCandidate, index: number) => number;
	healthFor?: PoolHealthLookup;
	eligible?: PoolEligibilityCheck;
}

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const UINT32_SPAN = 2 ** 32;
const DEFAULT_POOL_WEIGHT = 1;

const poolSeedEncoder = new TextEncoder();

/**
 * FNV-1a 32-bit over the UTF-8 bytes of `value`, followed by a 32-bit avalanche
 * finalizer. Seeds come from stable ids (session id, spawn id) rather than the
 * clock so a resumed session or a revived subagent redraws the same candidate.
 *
 * The finalizer is required, not decorative. The draw reads the high bits of the
 * seed, and FNV-1a's last step multiplies by 16777619, so changing only the last
 * byte moves the top bits by about 0.4%. Seed strings differ in their last few
 * bytes all the time (Worker-2 vs Worker-3), so without the finalizer those
 * inputs would all draw the same candidate.
 *
 * Dispersion still depends on the seed string varying. Spawn seeds mix in the
 * parent task call id for that reason: agent names are model-supplied and a
 * project that always spawns Explorer/Analyzer/Writer/Checker would otherwise
 * draw one fixed split forever.
 */
export function hashPoolSeed(value: string): number {
	let hash = FNV_OFFSET_BASIS;
	for (const byte of poolSeedEncoder.encode(value)) {
		hash ^= byte;
		hash = Math.imul(hash, FNV_PRIME);
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 2246822507);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 3266489909);
	hash ^= hash >>> 16;
	return hash >>> 0;
}

/**
 * Coerce a configured weight, or undefined when the entry is missing or
 * malformed so the lookup below keeps falling through.
 *
 * The parameter is `unknown` because it really is: `retry.poolWeights` reaches
 * here as the raw settings record, so `{"anthropic/claude-opus-5": "2"}` from a
 * YAML config arrives as a string. Without this narrowing a string weight makes
 * the total NaN and the draw silently stops picking anything.
 *
 * A malformed value has to read as "no entry", not as an entry weighing 1.
 * `{"a/b": "2", "a/*": 5}` means the wildcard weighs a/b at 5; short-circuiting
 * to the default would shadow the wildcard the user did write. The bad value is
 * already reported by validateModelPools. An explicit 0 is a real weight and is
 * kept.
 */
function normalizePoolWeight(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

/**
 * Weight for one candidate: exact `provider/model-id` key, then the
 * `provider/*` wildcard, then 1.
 */
export function getPoolWeight(
	selector: string,
	provider: string,
	weights: Record<string, unknown> | undefined,
): number {
	if (!weights) return DEFAULT_POOL_WEIGHT;
	return (
		normalizePoolWeight(weights[selector]) ?? normalizePoolWeight(weights[`${provider}/*`]) ?? DEFAULT_POOL_WEIGHT
	);
}

/**
 * Whether a candidate's quota is spent: out of budget, or inside the reserve
 * margin. These are the states that keep a candidate out of a proactive draw
 * and that a fail-closed reserve policy refuses to start on.
 *
 * "unknown" fails open and participates at full weight, matching the
 * getModelUsageHealth contract. Static API keys and providers without a usage
 * endpoint are unmeasurable, and excluding them would make them unusable in a
 * pool. Give them an explicit poolWeights entry (0 to keep them fallback-only)
 * when that share is not wanted.
 */
export function isPoolUsageSpent(state: ModelUsageHealthState | undefined): boolean {
	return state === "depleted" || state === "reserve";
}

interface EligiblePoolEntry {
	index: number;
	weight: number;
	state: ModelUsageHealthState | undefined;
}

function collectEligiblePoolEntries(
	candidates: readonly PoolCandidate[],
	options: Pick<PoolDrawOptions, "healthFor" | "eligible"> & { weightFor?: PoolDrawOptions["weightFor"] },
): EligiblePoolEntry[] {
	const entries: EligiblePoolEntry[] = [];
	// Two role patterns can resolve to the same model, which is a normal ordered
	// idiom: `a/m,a/m:max,b/n` lists one model at two thinking levels. Only the
	// first occurrence carries weight, otherwise a/m would take a 2:1 share of a
	// nominally even pool. The duplicate stays in the candidate array and so still
	// shows up in the ordered fallback tail.
	const weighted = new Set<string>();
	for (const [index, candidate] of candidates.entries()) {
		if (weighted.has(candidate.selector)) continue;
		if (options.eligible?.(candidate, index) === false) continue;
		const state = options.healthFor?.(candidate, index);
		if (isPoolUsageSpent(state)) continue;
		const weight = options.weightFor?.(candidate, index) ?? DEFAULT_POOL_WEIGHT;
		if (!(weight > 0)) continue;
		weighted.add(candidate.selector);
		entries.push({ index, weight, state });
	}
	return entries;
}

/**
 * Draw one candidate index. Returns undefined when the caller should keep the
 * configured order: fewer than two candidates, or nothing left after filtering
 * (the shipped preflight/confirm/fail-closed machinery owns that case).
 */
export function selectPoolCandidate(
	candidates: readonly PoolCandidate[],
	options: PoolDrawOptions,
): number | undefined {
	// Fast path: one candidate has nothing to spread, so no health lookup runs
	// and the caller stays byte-identical to ordered selection.
	if (candidates.length < 2) return undefined;
	const entries = collectEligiblePoolEntries(candidates, options);
	if (entries.length === 0) return undefined;
	let totalWeight = 0;
	for (const entry of entries) totalWeight += entry.weight;
	// Two weights of 1e308 each pass the per-value finite check but sum to
	// Infinity, which puts the cut point at Infinity (or NaN) so `cumulative >
	// point` never holds and the last entry wins every draw. No draw means the
	// configured order stands, which is what ordered selection would have done.
	if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) return undefined;
	const point = (options.seed / UINT32_SPAN) * totalWeight;
	let cumulative = 0;
	let picked = entries[entries.length - 1];
	for (const entry of entries) {
		cumulative += entry.weight;
		if (cumulative > point) {
			picked = entry;
			break;
		}
	}
	if (picked.state === "unknown") {
		logger.debug("Model pool drew a candidate with unknown usage health", {
			selector: candidates[picked.index].selector,
		});
	}
	return picked.index;
}

/**
 * Move the picked candidate to the front, keeping the rest in configured order.
 *
 * `spentAt` demotes candidates whose quota is already spent to the tail. The
 * remainder of this list becomes a retry fallback chain, and the chain walk in
 * turn-recovery does not consult usage health, so leaving a measured-depleted
 * candidate ahead of a healthy one burns a retry attempt on a model the caller
 * already knew was out of quota. Pass it only when health was actually fetched.
 *
 * An undefined `pickedIndex` means no draw happened, and then the configured
 * order stands untouched: no promotion and no demotion. Weighted selection
 * degrades to exactly what ordered selection does, so the shipped preflight and
 * `retry.usageReservePolicy` read the same first candidate in both modes.
 * Without that, a healthy zero-weight candidate could be hoisted to index 0 and
 * a fail-closed policy would see "healthy" and start a session it was
 * configured to refuse.
 *
 * Returns the input array itself when the order does not change.
 */
export function reorderPoolCandidates<T>(
	candidates: T[],
	pickedIndex: number | undefined,
	spentAt?: (index: number) => boolean,
): T[] {
	if (pickedIndex === undefined) return candidates;
	const picked = pickedIndex > 0 && pickedIndex < candidates.length ? pickedIndex : undefined;
	const rest = candidates.map((_, index) => index).filter(index => index !== picked);
	const order =
		picked === undefined
			? [...rest.filter(index => !spentAt?.(index)), ...rest.filter(index => spentAt?.(index) === true)]
			: [picked, ...rest.filter(index => !spentAt?.(index)), ...rest.filter(index => spentAt?.(index) === true)];
	if (order.every((index, position) => index === position)) return candidates;
	return order.map(index => candidates[index]);
}

/**
 * Query usage health for every candidate at once. The auth-storage usage cache
 * and its in-flight coalescing keep a burst to roughly one request per
 * provider. Any failure maps to "unknown" so the draw fails open.
 */
export async function fetchPoolCandidateHealth(
	candidates: readonly PoolCandidate[],
	source: PoolUsageHealthSource,
	options: {
		reserveFraction: number;
		sessionId?: string;
		signal?: AbortSignal;
		eligible?: PoolEligibilityCheck;
	},
): Promise<ModelUsageHealthState[]> {
	return await Promise.all(
		candidates.map(async (candidate, index): Promise<ModelUsageHealthState> => {
			if (options.eligible?.(candidate, index) === false) return "unknown";
			try {
				const health = await source.getModelUsageHealth(candidate.provider, {
					modelId: candidate.id,
					baseUrl: candidate.baseUrl,
					reserveFraction: options.reserveFraction,
					sessionId: options.sessionId,
					signal: options.signal,
				});
				return health.state;
			} catch (error) {
				logger.debug("Model pool usage health lookup failed open", {
					provider: candidate.provider,
					model: candidate.id,
					error: String(error),
				});
				return "unknown";
			}
		}),
	);
}

/** Configured pool selection mode. */
export function getPoolSelectionMode(settings: Settings): PoolSelectionMode {
	return settings.get("retry.poolSelection") === "weighted" ? "weighted" : "ordered";
}

/**
 * Configured draw weights, or an empty map when unset or malformed. Values stay
 * `unknown`: the schema says number, but a user's YAML can put anything there,
 * and getPoolWeight is the one place that narrows.
 */
export function getPoolWeights(settings: Settings): Record<string, unknown> {
	const weights: unknown = settings.get("retry.poolWeights");
	if (!weights || typeof weights !== "object" || Array.isArray(weights)) return {};
	return weights as Record<string, unknown>;
}

/**
 * Whether pool selection may consult usage health. Reuses the settings shipped
 * with usage-aware fallback instead of adding a second health configuration.
 */
export function isPoolHealthGateEnabled(settings: Settings): boolean {
	return settings.get("retry.modelFallback") === true && settings.get("retry.usageAwareFallback") === true;
}

/** Reserve margin as a fraction, from `retry.usageReservePct`. */
export function getPoolReserveFraction(settings: Settings): number {
	return settings.get("retry.usageReservePct") / 100;
}

/**
 * Validates pool configuration and reports each warning, mirroring
 * validateRetryFallbackChains. A candidate the registry cannot resolve would
 * otherwise skew every draw silently.
 */
export function validateModelPools(
	settings: Settings,
	modelRegistry: ModelRegistry,
	warn: (message: string) => void,
): void {
	const configuredWeights = settings.get("retry.poolWeights");
	const mode = settings.get("retry.poolSelection");
	const report = (message: string) => {
		logger.warn(message);
		warn(message);
	};

	if (configuredWeights !== undefined) {
		if (!configuredWeights || typeof configuredWeights !== "object" || Array.isArray(configuredWeights)) {
			report(
				"retry.poolWeights must be a mapping of model selectors or provider wildcards to non-negative numbers.",
			);
		} else {
			let weightTotal = 0;
			for (const key in configuredWeights) {
				// getPoolWeight probes exactly two keys, the bare `provider/model-id`
				// selector and `provider/*`. Anything else a parser would accept, such
				// as a `:max` thinking suffix copied out of a modelRoles entry or an
				// id-prefix wildcard borrowed from retry.fallbackChains, would never
				// match and would silently weigh 1, so it is reported here.
				if (isRetryFallbackWildcardKey(key)) {
					const { provider, idPrefix } = parseRetryFallbackWildcard(key, candidate =>
						isKnownProvider(modelRegistry, candidate),
					);
					if (idPrefix !== undefined) {
						report(
							`retry.poolWeights wildcard key must be provider/*, id-prefix wildcards are not matched: ${key}`,
						);
					} else if (!isKnownProvider(modelRegistry, provider)) {
						report(`retry.poolWeights wildcard key references unknown provider: ${key}`);
					}
				} else {
					const parsedKey = parseRetryFallbackSelector(key, modelRegistry);
					if (!parsedKey) {
						report(`Invalid model selector key in retry.poolWeights: ${key}`);
					} else if (!modelRegistry.find(parsedKey.provider, parsedKey.id)) {
						report(`retry.poolWeights key references unknown model: ${key}`);
					} else if (parsedKey.raw !== `${parsedKey.provider}/${parsedKey.id}`) {
						report(
							`retry.poolWeights key must be a bare model selector like ${parsedKey.provider}/${parsedKey.id}: ${key}`,
						);
					}
				}
				const weight = configuredWeights[key];
				if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
					report(`retry.poolWeights value for '${key}' must be a non-negative finite number.`);
				} else {
					weightTotal += weight;
				}
			}
			// Each of `1e308` and `1e308` is finite on its own but their sum is not,
			// and a draw with an infinite total cannot pick anything, so the pool
			// silently degrades to the configured order.
			if (!Number.isFinite(weightTotal)) {
				report("retry.poolWeights values are too large to sum; keep them well below 1e308.");
			}
		}
	}

	if (mode !== "weighted") return;
	const modelRoles = settings.getModelRoles();
	// Role members are checked with the resolution the draw itself uses, which is
	// fuzzy: `anthropic/opus` resolves to anthropic/claude-opus-4-0 at runtime even
	// though the registry has no model literally named `opus`. Using the exact
	// retry.fallbackChains lookup here would warn about working configurations on
	// every session start and every subagent spawn.
	//
	// Fuzzy matching is not free: parseModelPattern builds a preference context
	// over the whole catalog (~3800 models) per call, and this validator runs once
	// per AgentSession, so once per subagent spawn too. Exact `provider/model-id`
	// selectors are the common case and are settled by a registry lookup, so the
	// catalog is only touched when a genuinely fuzzy pattern shows up.
	let fuzzyMatcher: ((pattern: string) => boolean) | undefined;
	const resolvesFuzzily = (pattern: string): boolean => {
		if (!fuzzyMatcher) {
			const allModels = modelRegistry.getAll();
			const matchPreferences = getModelMatchPreferences(settings);
			fuzzyMatcher = candidate => parseModelPattern(candidate, allModels, matchPreferences).model !== undefined;
		}
		return fuzzyMatcher(pattern);
	};
	for (const role in modelRoles) {
		const roleValue = modelRoles[role];
		if (!roleValue) continue;
		const patterns = resolveConfiguredModelPatterns(roleValue, settings);
		// Single-candidate roles never draw, so an unresolvable entry there is
		// already handled by ordinary role resolution.
		if (patterns.length < 2) continue;
		for (const pattern of patterns) {
			// Same rule as a retry.fallbackChains entry: only patterns that name a
			// provider are checked, and they are checked against the full registry
			// rather than the authenticated subset. A model that exists but whose
			// provider has no credentials is normal (the draw drops it through
			// hasConfiguredAuth) and must not warn on every session start.
			if (!isRetryFallbackModelKey(pattern) || isRetryFallbackWildcardKey(pattern)) continue;
			const parsed = parseRetryFallbackSelector(pattern, modelRegistry);
			if (!parsed) {
				report(`modelRoles.${role} has an invalid model selector: ${pattern} (skipped by pool draws and fallback)`);
				continue;
			}
			// Exact hit, no fuzzy resolution needed.
			if (modelRegistry.find(parsed.provider, parsed.id)) continue;
			// Discovery-backed providers (ollama, lm-studio, llama.cpp) contribute
			// zero models while the local server is down and the 24h discovery cache
			// has expired. `ollama/qwen3` is not misconfigured then, it is
			// temporarily unusable, same bucket as a provider without credentials.
			// Warning here would fire on every session start and every subagent
			// spawn, and the model resolves again as soon as the server is back.
			if (modelRegistry.getProviderDiscoveryState(parsed.provider) !== undefined) continue;
			if (!resolvesFuzzily(pattern)) {
				report(
					`modelRoles.${role} lists a model the registry cannot resolve: ${pattern} (skipped by pool draws and fallback)`,
				);
			}
		}
	}
}
