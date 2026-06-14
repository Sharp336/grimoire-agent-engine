import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessageEventStream, clearCustomApis } from "@oh-my-pi/pi-ai";
import type { SwarmSpec } from "@oh-my-pi/pi-catalog/types";
import { kNoAuth, ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelFromString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

/**
 * U4 — swarm spec threaded through the runtime custom-model pipeline + keyless `omp`.
 *
 * Verifies the five explicit threading sites in model-registry.ts carry
 * `Model.swarm` end to end (registerProvider → getAvailable/find → resolve),
 * that it survives a refresh() overlay-merge cycle, that a model WITHOUT swarm
 * stays clean (no silent injection / Sever), and that the synthetic `omp`
 * provider is keyless so `omp/*` models surface without configured auth.
 */
describe("ModelRegistry swarm threading + keyless omp", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-swarm-registry-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		clearCustomApis();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// A streamSimple stub: U4 only threads metadata; it never dispatches here.
	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	const blendSpec: SwarmSpec = {
		strategy: "moa",
		members: [
			{ role: "proposer", model: "anthropic/claude-sonnet-4-5" },
			{ role: "proposer", model: "anthropic/claude-sonnet-4-5" },
			{ role: "aggregator", model: "anthropic/claude-opus-4-5", surface: true },
		],
		surface: "aggregator",
		maxMembers: 5,
		firstEventTimeoutMs: 30_000,
	};

	function ompConfig(models: NonNullable<ProviderConfigInput["models"]>): ProviderConfigInput {
		return {
			// apiKey is required by validateProviderConfiguration in runtime-register
			// mode when models are defined; the keyless surfacing is independent of it.
			apiKey: "OMP_RUNTIME_KEY",
			api: "omp-swarm",
			baseUrl: "omp://",
			streamSimple,
			models,
		};
	}

	const swarmModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "moa-synthesis",
		name: "MoA Synthesis",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		swarm: blendSpec,
	};

	const plainModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "plain-model",
		name: "Plain Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	};

	test("swarm spec threads through registerProvider into find()/getAvailable()", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.registerProvider("omp", ompConfig([swarmModel]), "omp-builtin");

		const model = registry.find("omp", "moa-synthesis");
		expect(model).toBeDefined();
		expect(model?.api).toBe("omp-swarm");
		expect(model?.provider).toBe("omp");
		// Deep-equal proves every site (definition → overlay → buildModel) carried
		// the spec verbatim with no field dropped or mutated.
		expect(model?.swarm).toEqual(blendSpec);

		const available = registry.getAvailable();
		const surfaced = available.find(m => m.provider === "omp" && m.id === "moa-synthesis");
		expect(surfaced).toBeDefined();
		expect(surfaced?.swarm).toEqual(blendSpec);
	});

	test("omp/* resolves via resolveModelFromString", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.registerProvider("omp", ompConfig([swarmModel]), "omp-builtin");

		const resolved = resolveModelFromString("omp/moa-synthesis", registry.getAvailable());
		expect(resolved).toBeDefined();
		expect(resolved?.provider).toBe("omp");
		expect(resolved?.id).toBe("moa-synthesis");
		expect(resolved?.swarm).toEqual(blendSpec);
	});

	test("swarm spec survives refresh('offline') overlay-merge cycle", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.registerProvider("omp", ompConfig([swarmModel]), "omp-builtin");
		expect(registry.find("omp", "moa-synthesis")?.swarm).toEqual(blendSpec);

		await registry.refresh("offline");

		const model = registry.find("omp", "moa-synthesis");
		expect(model).toBeDefined();
		// The runtime overlay (not the disk config) must re-materialize swarm after
		// #reloadStaticModels(); a drop here would be the "Sever" failure mode.
		expect(model?.swarm).toEqual(blendSpec);
		expect(model?.api).toBe("omp-swarm");
	});

	test("a model without swarm stays clean (no silent injection)", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.registerProvider("omp", ompConfig([plainModel]), "omp-builtin");

		const before = registry.find("omp", "plain-model");
		expect(before).toBeDefined();
		expect(before?.swarm).toBeUndefined();

		await registry.refresh("offline");

		const after = registry.find("omp", "plain-model");
		expect(after).toBeDefined();
		expect(after?.swarm).toBeUndefined();
	});

	test("omp provider is keyless: surfaces omp/* and yields no-auth sentinel without credentials", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		// Keyless is established at construction (re-applied on every #loadModels)
		// and is independent of any configured key for the `omp` provider.
		expect(await registry.getApiKeyForProvider("omp")).toBe(kNoAuth);

		// A model object on the omp provider counts as configured purely via keyless.
		const probe = {
			id: "probe",
			name: "Probe",
			api: "omp-swarm",
			provider: "omp",
			baseUrl: "omp://",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		} as Parameters<ModelRegistry["hasConfiguredAuth"]>[0];
		expect(registry.hasConfiguredAuth(probe)).toBe(true);

		// Keyless survives a refresh cycle (re-added in #addImplicitDiscoverableProviders).
		await registry.refresh("offline");
		expect(await registry.getApiKeyForProvider("omp")).toBe(kNoAuth);
	});
});
