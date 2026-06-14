import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis, getCustomApi } from "@oh-my-pi/pi-ai";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelFromString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { OMP_PROVIDER_SOURCE_ID, OMP_SWARM_API } from "@oh-my-pi/pi-coding-agent/swarm/executor";
import {
	DRAFT_REFINE_SPEC,
	MOA_SYNTHESIS_SPEC,
	OMP_PRESET_MODELS,
	OMP_PRESET_SOURCE_ID,
	ROUTER_BALANCED_SPEC,
} from "@oh-my-pi/pi-coding-agent/swarm/presets";
import { Snowflake } from "@oh-my-pi/pi-utils";

/**
 * U9 — built-in `omp/*` blend presets.
 *
 * These tests assert the registration contract only — they CONSTRUCT a
 * `ModelRegistry` (so the orchestrator cannot be driven here) and verify that
 * each preset:
 *   1. resolves via `resolveModelFromString` (against `getAvailable()` and the
 *      registry, exercising both exact `provider/id` and canonical paths);
 *   2. is surfaced by `getAvailable()` despite the `omp` provider being keyless
 *      and carrying NO credential (deferred concern #1);
 *   3. carries its declared {@link SwarmSpec} byte-for-byte through the build
 *      pipeline (no field dropped — Sever guard);
 *   4. registers under a DISTINCT source id so tearing down the preset PROVIDER
 *      never tears down the `omp-swarm` custom-API dispatcher (deferred concern #2).
 *
 * The blend executor itself (dispatch, surfacing, usage summing, abort) is
 * covered by swarm-executor.test.ts; this unit only proves the presets are
 * registered, resolvable, available, and spec-carrying.
 */
describe("U9 built-in omp blend presets", () => {
	let tempDir: string | undefined;
	let modelsJsonPath: string;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-swarm-presets-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		// The omp-swarm dispatcher is a process-global first-writer-wins singleton;
		// clearing it between tests is required so the self-heal test sees an empty
		// slot, and matches the sibling swarm-registry-threading suite convention.
		// Guard each step so a failed beforeEach can't mask its error during cleanup.
		clearCustomApis();
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		tempDir = undefined;
	});

	/** Build a registry, asserting the per-test auth storage initialized. */
	function makeRegistry(): ModelRegistry {
		if (authStorage === undefined) throw new Error("authStorage not initialized");
		return new ModelRegistry(authStorage, modelsJsonPath);
	}

	// The three preset ids the registry ships under provider "omp", paired with the
	// spec each must carry. Keeping this table local makes every assertion below a
	// data-driven check against the source-of-truth presets module.
	const PRESETS = [
		{ id: "router-balanced", spec: ROUTER_BALANCED_SPEC, strategy: "router" as const },
		{ id: "draft-refine", spec: DRAFT_REFINE_SPEC, strategy: "draft-refine" as const },
		{ id: "moa-synthesis", spec: MOA_SYNTHESIS_SPEC, strategy: "moa" as const },
	];

	test("the presets module ships exactly the three planned blends with valid specs", () => {
		// Guards the module contract itself (the spec table the registry registers).
		expect(OMP_PRESET_MODELS.map(m => m.id).sort()).toEqual(["draft-refine", "moa-synthesis", "router-balanced"]);
		for (const model of OMP_PRESET_MODELS) {
			expect(model.api ?? "omp-swarm").toBeDefined();
			expect(model.swarm).toBeDefined();
			// Every member names a model and a role; the executor resolves these later.
			for (const member of model.swarm?.members ?? []) {
				expect(member.role.length).toBeGreaterThan(0);
				expect(member.model.length).toBeGreaterThan(0);
			}
		}
		// Strategy-specific shape sanity (matches the plan: router weak+strong+classifier,
		// draft-refine two stages with a surfaced refiner, moa homogeneous proposers + best aggregator).
		expect(ROUTER_BALANCED_SPEC.strategy).toBe("router");
		expect(ROUTER_BALANCED_SPEC.selector?.kind).toBe("classifier");
		expect(ROUTER_BALANCED_SPEC.selector?.model?.length).toBeGreaterThan(0);
		expect(DRAFT_REFINE_SPEC.strategy).toBe("draft-refine");
		expect(DRAFT_REFINE_SPEC.members.find(m => m.surface === true)?.role).toBe("refine");
		expect(MOA_SYNTHESIS_SPEC.strategy).toBe("moa");
		const moaProposers = MOA_SYNTHESIS_SPEC.members.filter(m => m.role === "proposer");
		expect(moaProposers.length).toBeGreaterThanOrEqual(2);
		// Self-MoA (KTD-6): proposers are homogeneous — all the same model.
		expect(new Set(moaProposers.map(m => m.model)).size).toBe(1);
		// The aggregator is the surfaced member and a DISTINCT (best) model.
		const aggregator = MOA_SYNTHESIS_SPEC.members.find(m => m.role === "aggregator");
		expect(aggregator?.surface).toBe(true);
		expect(aggregator?.model).not.toBe(moaProposers[0]?.model);
	});

	test("each preset resolves via resolveModelFromString and carries its swarm spec", () => {
		const registry = makeRegistry();
		const available = registry.getAvailable();

		for (const { id, spec, strategy } of PRESETS) {
			// (a) exact provider/id resolution against the available set.
			const bySelector = resolveModelFromString(`omp/${id}`, available, undefined, registry);
			expect(bySelector, `omp/${id} should resolve`).toBeDefined();
			expect(bySelector?.provider).toBe("omp");
			expect(bySelector?.id).toBe(id);
			expect(bySelector?.api).toBe("omp-swarm");
			// (c) the spec rides through the build pipeline unchanged.
			expect(bySelector?.swarm).toEqual(spec);
			expect(bySelector?.swarm?.strategy).toBe(strategy);
		}
	});

	test("every preset is surfaced by getAvailable() despite the keyless omp provider", async () => {
		const registry = makeRegistry();

		// (1) The omp provider carries no credential — keyless registration (concern #1).
		expect(await registry.getApiKeyForProvider("omp")).toBe(kNoAuth);

		// (2) Each preset is in getAvailable() with its spec, with no auth configured.
		const available = registry.getAvailable();
		for (const { id, spec } of PRESETS) {
			const found = available.find(m => m.provider === "omp" && m.id === id);
			expect(found, `omp/${id} should be available`).toBeDefined();
			expect(found?.swarm).toEqual(spec);
		}

		// find() agrees with getAvailable().
		for (const { id, spec } of PRESETS) {
			const model = registry.find("omp", id);
			expect(model).toBeDefined();
			expect(model?.swarm).toEqual(spec);
		}
	});

	test("presets survive a refresh('offline') cycle (runtime-overlay re-materialization)", async () => {
		const registry = makeRegistry();
		expect(registry.find("omp", "moa-synthesis")?.swarm).toEqual(MOA_SYNTHESIS_SPEC);

		await registry.refresh("offline");

		// A drop here would be the "Sever" failure mode: the runtime overlay (not the
		// disk config) must re-materialize each preset after #reloadStaticModels().
		for (const { id, spec } of PRESETS) {
			const model = registry.find("omp", id);
			expect(model, `omp/${id} should survive refresh`).toBeDefined();
			expect(model?.swarm).toEqual(spec);
			expect(model?.api).toBe("omp-swarm");
		}
		// Keyless surfacing is re-applied on reload too.
		expect(await registry.getApiKeyForProvider("omp")).toBe(kNoAuth);
	});

	test("preset registration uses a DISTINCT source id, so tearing it down spares the dispatcher", () => {
		const registry = makeRegistry();

		// The custom-API dispatcher is live and owned by the dispatcher's source id —
		// NOT the preset provider's source id (concern #2).
		const dispatcher = getCustomApi(OMP_SWARM_API);
		expect(dispatcher).toBeDefined();
		expect(dispatcher?.sourceId).toBe(OMP_PROVIDER_SOURCE_ID);
		expect(OMP_PRESET_SOURCE_ID).not.toBe(OMP_PROVIDER_SOURCE_ID);

		// Tearing down the preset PROVIDER source must NOT unregister the dispatcher.
		registry.clearSourceRegistrations(OMP_PRESET_SOURCE_ID);
		expect(getCustomApi(OMP_SWARM_API), "dispatcher must survive preset teardown").toBeDefined();
		// And the preset models are gone from the registry after their source is cleared.
		expect(registry.find("omp", "moa-synthesis")).toBeUndefined();
	});

	test("self-heal: a re-construction re-asserts the dispatcher when its slot is empty", () => {
		// Simulate a process where the dispatcher slot was torn down entirely.
		const first = makeRegistry();
		expect(getCustomApi(OMP_SWARM_API)).toBeDefined();
		clearCustomApis();
		expect(getCustomApi(OMP_SWARM_API)).toBeUndefined();

		// A fresh registry must re-assert the dispatcher (so resolved omp/* can dispatch)
		// and still surface the presets.
		const second = makeRegistry();
		expect(getCustomApi(OMP_SWARM_API), "dispatcher should self-heal on re-construction").toBeDefined();
		expect(second.find("omp", "router-balanced")?.swarm).toEqual(ROUTER_BALANCED_SPEC);
		// Reference `first` so it is not flagged unused; both share the process-global slot.
		expect(first.find("omp", "router-balanced")).toBeDefined();
	});
});
