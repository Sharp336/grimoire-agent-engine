import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	buildQoderStaticSeed,
	QODER_CURATED_MODELS,
	qoderModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const seed = buildQoderStaticSeed();
const byId = new Map(seed.map(model => [model.id, model]));

function expectModel(id: string): ModelSpec<"openai-completions"> {
	const model = byId.get(id);
	expect(model, `qoder/${id} missing from seed`).toBeDefined();
	return model as ModelSpec<"openai-completions">;
}

describe("Qoder curated seed", () => {
	it("has 9 base rows, 10 context aliases, and 19 unique ids", () => {
		expect(QODER_CURATED_MODELS).toHaveLength(9);
		const aliases = seed.filter(model => !QODER_CURATED_MODELS.some(base => base.id === model.id));
		expect(aliases).toHaveLength(10);
		expect(new Set(seed.map(model => model.id)).size).toBe(19);
	});

	it("omits the six api3-only base ids that fail closed on api2-v2", () => {
		const dropped = ["cmodel", "qmodel_preview", "qmodel_latest", "kmodel_latest", "gm51model", "dfmodel"];
		const ids = new Set(seed.map(model => model.id));
		const wireIds = new Set(seed.map(model => model.requestModelId ?? model.id));
		for (const id of dropped) {
			expect(ids.has(id), `qoder/${id} must not be advertised`).toBe(false);
			expect(wireIds.has(id), `qoder/${id} must not be a wire target`).toBe(false);
			expect(
				[...ids].some(other => other.startsWith(`${id}-`)),
				`qoder/${id} aliases must be gone`,
			).toBe(false);
		}
	});

	it("uses qoder openai-completions with 32k output and no store support", () => {
		for (const model of seed) {
			expect(model.provider).toBe("qoder");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api2-v2.qoder.sh/model/v1");
			expect(model.maxTokens).toBe(32_768);
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(model.compat?.supportsStore).toBe(false);
		}
	});

	it("matches evidence base metadata", () => {
		const auto = expectModel("auto");
		expect(auto.name).toBe("Qoder (Auto)");
		expect(auto.contextWindow).toBe(180_000);
		expect(auto.reasoning).toBe(false);
		expect(auto.input).toEqual(["text", "image"]);
		expect(auto.thinking).toBeUndefined();
		expect(auto.requestModelId).toBeUndefined();
		expect(auto.compat?.extraBody).toBeUndefined();

		const ultimate = expectModel("ultimate");
		expect(ultimate.name).toBe("Ultimate");
		expect(ultimate.contextWindow).toBe(200_000);
		expect(ultimate.reasoning).toBe(true);
		expect(ultimate.input).toEqual(["text", "image"]);
		expect(ultimate.thinking?.mode).toBe("effort");
		expect(ultimate.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(ultimate.thinking?.defaultLevel).toBe(Effort.High);

		const performance = expectModel("performance");
		expect(performance.name).toBe("Performance");
		expect(performance.contextWindow).toBe(272_000);
		expect(performance.reasoning).toBe(false);

		const lite = expectModel("lite");
		expect(lite.input).toEqual(["text"]);

		const kmodel = expectModel("kmodel");
		expect(kmodel.name).toBe("Kimi-K2.7-Code");
		expect(kmodel.contextWindow).toBe(262_144);
		expect(QODER_CURATED_MODELS.find(base => base.id === "kmodel")?.aliasContexts).toBeUndefined();
	});

	it("routes aliases to the base wire id with context_length", () => {
		for (const base of QODER_CURATED_MODELS) {
			if (!base.aliasContexts) continue;
			for (const alias of base.aliasContexts) {
				const model = expectModel(`${base.id}${alias.suffix}`);
				expect(model.name).toBe(`${base.name}${alias.label}`);
				expect(model.contextWindow).toBe(alias.contextWindow);
				expect(model.requestModelId).toBe(base.id);
				expect(model.compat?.extraBody).toEqual({ context_length: alias.contextWindow });
				expect(model.reasoning).toBe(base.reasoning);
				expect(model.input).toEqual(base.input);
				expect(model.maxTokens).toBe(32_768);
			}
		}
	});

	it("preserves Qoder thinking contracts through generator policy application", () => {
		const configurableReasoningIds = ["ultimate", "dmodel"];
		for (const id of configurableReasoningIds) {
			const before = { ...expectModel(id) };
			expect(before.thinking, `expected ${id} to carry authored thinking`).toBeDefined();
			const clone: ModelSpec<"openai-completions"> = JSON.parse(JSON.stringify(before));
			applyGeneratedModelPolicies([clone]);
			expect(clone.thinking).toEqual(before.thinking);
		}
	});

	it("bundles every curated row with alias wire metadata intact", () => {
		const bundled = getBundledModels("qoder");
		expect(bundled.map(model => model.id).sort()).toEqual(seed.map(model => model.id).sort());
		const alias = getBundledModel<"openai-completions">("qoder", "ultimate-1m");
		expect(alias.requestModelId).toBe("ultimate");
		expect(alias.contextWindow).toBe(1_000_000);
		expect(alias.compat.extraBody).toEqual({ context_length: 1_000_000 });
		expect(alias.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	});

	it("registers the qoder catalog descriptor with oauth discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "qoder");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("auto");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["QODER_OAUTH_TOKEN"]);
		expect(descriptor?.catalogDiscovery?.oauthProvider).toBe("qoder");
		expect(DEFAULT_MODEL_PER_PROVIDER.qoder).toBe("auto");
	});

	it("exposes the offline seed without dynamic discovery", () => {
		const options = qoderModelManagerOptions();
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels).toEqual(seed);
	});
});
