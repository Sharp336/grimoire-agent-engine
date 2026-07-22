import { afterEach, describe, expect, it } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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

const ORIGINAL_QODER_ENV = {
	QODER_OAUTH_TOKEN: Bun.env.QODER_OAUTH_TOKEN,
	QODER_PERSONAL_ACCESS_TOKEN: Bun.env.QODER_PERSONAL_ACCESS_TOKEN,
} as const;

function restoreQoderEnvVar(name: keyof typeof ORIGINAL_QODER_ENV): void {
	const value = ORIGINAL_QODER_ENV[name];
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

afterEach(() => {
	restoreQoderEnvVar("QODER_OAUTH_TOKEN");
	restoreQoderEnvVar("QODER_PERSONAL_ACCESS_TOKEN");
});

describe("Qoder curated seed", () => {
	it("has 15 base rows, 22 context aliases, and 37 unique ids", () => {
		expect(QODER_CURATED_MODELS).toHaveLength(15);
		const aliases = seed.filter(model => !QODER_CURATED_MODELS.some(base => base.id === model.id));
		expect(aliases).toHaveLength(22);
		expect(new Set(seed.map(model => model.id)).size).toBe(37);
	});

	it("marks exactly the six api3-only families and their aliases with compat.api3", () => {
		const api3Bases = ["cmodel", "qmodel_preview", "qmodel_latest", "kmodel_latest", "gm51model", "dfmodel"];
		const api3Ids = new Set(api3Bases.flatMap(id => [id, `${id}-400k`, `${id}-1m`]));
		expect(api3Ids.size).toBe(18);
		for (const model of seed) {
			expect(model.compat?.api3 === true, `qoder/${model.id} api3 flag`).toBe(api3Ids.has(model.id));
		}
		for (const id of api3Bases) {
			expect(QODER_CURATED_MODELS.find(base => base.id === id)?.api3, `qoder/${id} curated api3 flag`).toBe(true);
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

	it("matches the six api3-only base metadata and pinned ladders", () => {
		const cmodel = expectModel("cmodel");
		expect(cmodel.name).toBe("Cantus");
		expect(cmodel.contextWindow).toBe(200_000);
		expect(cmodel.reasoning).toBe(true);
		expect(cmodel.input).toEqual(["text", "image"]);
		expect(cmodel.thinking?.mode).toBe("effort");
		expect(cmodel.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(cmodel.thinking?.defaultLevel).toBe(Effort.High);

		const preview = expectModel("qmodel_preview");
		expect(preview.name).toBe("Qwen3.8-Max-Preview");
		expect(preview.reasoning).toBe(true);
		expect(preview.thinking?.efforts).toEqual([Effort.High]);
		expect(preview.thinking?.defaultLevel).toBe(Effort.High);
		expect(preview.thinking?.requiresEffort).toBe(true);

		const qLatest = expectModel("qmodel_latest");
		expect(qLatest.name).toBe("Qwen3.7-Max");
		expect(qLatest.reasoning).toBe(false);
		expect(qLatest.thinking).toBeUndefined();

		const kLatest = expectModel("kmodel_latest");
		expect(kLatest.name).toBe("Kimi-K3");
		expect(kLatest.reasoning).toBe(false);
		expect(kLatest.thinking).toBeUndefined();

		for (const id of ["gm51model", "dfmodel"] as const) {
			const model = expectModel(id);
			expect(model.contextWindow).toBe(200_000);
			expect(model.reasoning).toBe(true);
			expect(model.thinking?.mode).toBe("effort");
			expect(model.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
			expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		}
		expect(expectModel("gm51model").name).toBe("GLM-5.2");
		expect(expectModel("dfmodel").name).toBe("DeepSeek-V4-Flash");
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
		const configurableReasoningIds = ["ultimate", "dmodel", "cmodel", "qmodel_preview", "gm51model", "dfmodel"];
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
		expect(alias.compat.api3).toBe(false);
	});

	it("bundles api3 rows with the resolved flag and alias wire metadata", () => {
		const base = getBundledModel<"openai-completions">("qoder", "dfmodel");
		expect(base.compat.api3).toBe(true);
		expect(base.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		const alias = getBundledModel<"openai-completions">("qoder", "dfmodel-1m");
		expect(alias.requestModelId).toBe("dfmodel");
		expect(alias.contextWindow).toBe(1_000_000);
		expect(alias.compat.extraBody).toEqual({ context_length: 1_000_000 });
		expect(alias.compat.api3).toBe(true);
	});

	// The plugin carried an explicit QODER_OPENAI_COMPAT_OVERRIDES entry for
	// dfmodel because extension-registered models bypass buildModel detection.
	// In core the DeepSeek-family defaults auto-detect from the display name
	// ("DeepSeek-V4-Flash"), exactly as they do for the legacy dmodel row
	// ("DeepSeek-V4-Pro"), so the seed needs no sparse compat override. Lock
	// the detected values the plugin had to pin by hand.
	it("auto-detects DeepSeek-family compat for dfmodel without an override", () => {
		for (const id of ["dmodel", "dfmodel"] as const) {
			const spec = expectModel(id);
			const model = buildModel(spec);
			expect(model.compat.api3, `${id} api3 flag`).toBe(id === "dfmodel");
			expect(model.compat.supportsMultipleSystemMessages, id).toBe(true);
			expect(model.compat.disableReasoningOnToolChoice, id).toBe(true);
			expect(model.compat.requiresReasoningContentForToolCalls, id).toBe(true);
			expect(model.compat.requiresReasoningContentForAllAssistantTurns, id).toBe(true);
			expect(model.compat.allowsSyntheticReasoningContentForToolCalls, id).toBe(false);
		}
	});

	it("registers the qoder catalog descriptor with oauth discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "qoder");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("auto");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["QODER_OAUTH_TOKEN", "QODER_PERSONAL_ACCESS_TOKEN"]);
		expect(descriptor?.catalogDiscovery?.oauthProvider).toBe("qoder");
		expect(DEFAULT_MODEL_PER_PROVIDER.qoder).toBe("auto");
	});

	it("resolves Qoder OAuth and documented PAT env fallbacks", () => {
		delete Bun.env.QODER_OAUTH_TOKEN;
		Bun.env.QODER_PERSONAL_ACCESS_TOKEN = "qoder-pat-test-key";
		expect(getEnvApiKey("qoder")).toBe("qoder-pat-test-key");

		Bun.env.QODER_OAUTH_TOKEN = "qoder-oauth-test-key";
		expect(getEnvApiKey("qoder")).toBe("qoder-oauth-test-key");
	});

	it("exposes the offline seed without dynamic discovery", () => {
		const options = qoderModelManagerOptions();
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels).toEqual(seed);
	});
});
