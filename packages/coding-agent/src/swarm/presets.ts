/**
 * Built-in `omp-swarm` blend presets (U9).
 *
 * Three curated, selectable synthetic models shipped under the keyless `omp`
 * provider. Each is a {@link SwarmSpec} carried on a custom-model definition and
 * registered programmatically via `ModelRegistry.registerProvider`, so it appears
 * in `getAvailable()` and resolves through `resolveModelFromString` exactly like
 * any other model:
 *
 *   - `omp/router-balanced` — `router`: a classifier picks one of a weak/strong
 *     pair by request difficulty (cheap model for easy turns, frontier model for
 *     hard ones), so most turns cost ~1× + a tiny classifier call.
 *   - `omp/draft-refine` — `draft-refine`: a cheap model drafts, a frontier model
 *     refines; the refiner is surfaced.
 *   - `omp/moa-synthesis` — `moa`: homogeneous proposers (Self-MoA, KTD-6) fan out
 *     and a best/frontier aggregator synthesizes the surfaced answer.
 *
 * Member model ids are explicit `provider/id` selectors that exist in the bundled
 * catalog. They are resolved at dispatch time by the registry's `resolveModel`
 * (canonical-equivalence + `modelProviderOrder`), so each member fails over
 * independently — Phase-1 many-providers fallback composes for free without any
 * per-member wiring here.
 *
 * Lifecycle (KTD / U9 deferred concern #2): these presets register under a
 * DISTINCT source id ({@link OMP_PRESET_SOURCE_ID}, `"omp-presets"`) — NOT the
 * dispatcher's `"omp-builtin"`. The `omp-swarm` custom-API dispatcher is a
 * process-global, instance-free, first-writer-wins singleton registered under
 * `"omp-builtin"`; if these preset models shared that source id, a
 * `clearSourceRegistrations("omp-builtin")` would call `unregisterCustomApis` and
 * tear the live dispatcher down. Keeping the per-registry preset PROVIDER lifecycle
 * (`"omp-presets"`) separate from the dispatcher API lifecycle (`"omp-builtin"`)
 * decouples the two cleanly.
 */

import type { SwarmSpec } from "@oh-my-pi/pi-catalog/types";
import type { ProviderConfigInput } from "../config/model-registry";

/** One preset model definition (matches `ProviderConfigInput.models[number]`). */
type PresetModel = NonNullable<ProviderConfigInput["models"]>[number];

/**
 * Source id for the built-in preset PROVIDER registration. Deliberately distinct
 * from `OMP_PROVIDER_SOURCE_ID` (`"omp-builtin"`, which owns the process-global
 * `omp-swarm` custom-API dispatcher slot): tearing down preset provider state via
 * `clearSourceRegistrations("omp-presets")` must NEVER unregister the dispatcher.
 */
export const OMP_PRESET_SOURCE_ID = "omp-presets";

// Catalog member selectors (bundled `anthropic/*` ids). A weak/cheap tier, a mid
// tier, and a frontier tier — each an explicit `provider/id` so exact resolution
// hits before any canonical/pattern fallback, while still failing over per member.
const WEAK_MODEL = "anthropic/claude-haiku-4-5";
const MID_MODEL = "anthropic/claude-sonnet-4-5";
const STRONG_MODEL = "anthropic/claude-opus-4-5";

/** `router`: classify request difficulty → pick weak OR strong (cheap by default). */
export const ROUTER_BALANCED_SPEC: SwarmSpec = {
	strategy: "router",
	members: [
		{ role: "weak", model: WEAK_MODEL, kind: "model" },
		{ role: "strong", model: STRONG_MODEL, kind: "model" },
	],
	selector: { kind: "classifier", model: WEAK_MODEL },
	maxMembers: 2,
};

/** `draft-refine`: weak model drafts, strong model refines; the refiner surfaces. */
export const DRAFT_REFINE_SPEC: SwarmSpec = {
	strategy: "draft-refine",
	members: [
		{ role: "draft", model: WEAK_MODEL, kind: "model" },
		{ role: "refine", model: STRONG_MODEL, kind: "model", surface: true },
	],
	surface: "refine",
	maxMembers: 2,
};

/** `moa`: homogeneous proposers (Self-MoA, KTD-6) + best aggregator (surfaced). */
export const MOA_SYNTHESIS_SPEC: SwarmSpec = {
	strategy: "moa",
	members: [
		{ role: "proposer", model: MID_MODEL, kind: "model" },
		{ role: "proposer", model: MID_MODEL, kind: "model" },
		{ role: "proposer", model: MID_MODEL, kind: "model" },
		{ role: "aggregator", model: STRONG_MODEL, kind: "model", surface: true },
	],
	surface: "aggregator",
	maxMembers: 4,
};

/**
 * Shared model-definition skeleton. The synthetic shell itself bills nothing —
 * cost is the per-member spend, summed across members by the executor (KTD-7).
 */
function presetModel(id: string, name: string, swarm: SwarmSpec): PresetModel {
	return {
		id,
		name,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		swarm,
	};
}

/**
 * The three built-in preset model definitions, registered under the `omp`
 * provider with `api: "omp-swarm"`. Order is stable for deterministic surfacing
 * in the picker.
 */
export const OMP_PRESET_MODELS: PresetModel[] = [
	presetModel("router-balanced", "OMP Router (balanced)", ROUTER_BALANCED_SPEC),
	presetModel("draft-refine", "OMP Draft → Refine", DRAFT_REFINE_SPEC),
	presetModel("moa-synthesis", "OMP Mixture-of-Agents", MOA_SYNTHESIS_SPEC),
];
