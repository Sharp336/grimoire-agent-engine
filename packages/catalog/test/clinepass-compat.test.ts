import { describe, expect, it } from "bun:test";
import { toClinepassPublicModelId, toClinepassWireModelId } from "../src/clinepass-model-id";
import { buildOpenAICompat } from "../src/compat/openai";
import { Effort } from "../src/effort";
import { getBundledModels } from "../src/models";
import { buildClinepassSeed, CLINEPASS_STATIC_MODELS } from "../src/provider-models/openai-compat";
import type { ModelSpec } from "../src/types";

const CLINEPASS_BASE_URL = "https://api.cline.bot/api/v1";

function clinepassSpec(
	id: string,
	overrides: Partial<ModelSpec<"openai-completions">> = {},
): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "clinepass",
		baseUrl: CLINEPASS_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		thinking: { mode: "effort", minLevel: "minimal", maxLevel: "xhigh" },
		...overrides,
	} as ModelSpec<"openai-completions">;
}

describe("clinepass wire model id helpers", () => {
	it("prepends the cline-pass/ wire prefix to the bare public id", () => {
		expect(toClinepassWireModelId("glm-5.2")).toBe("cline-pass/glm-5.2");
		expect(toClinepassWireModelId("deepseek-v4-pro")).toBe("cline-pass/deepseek-v4-pro");
		expect(toClinepassWireModelId("qwen3.7-max")).toBe("cline-pass/qwen3.7-max");
	});

	it("is idempotent on ids that already carry the prefix", () => {
		expect(toClinepassWireModelId("cline-pass/glm-5.2")).toBe("cline-pass/glm-5.2");
	});

	it("recovers the bare public id and is idempotent on unprefixed ids", () => {
		expect(toClinepassPublicModelId("cline-pass/glm-5.2")).toBe("glm-5.2");
		expect(toClinepassPublicModelId("glm-5.2")).toBe("glm-5.2");
	});
});

describe("clinepass compat resolution", () => {
	it("routes the bare id to the cline-pass/ namespace via wireModelIdMode", () => {
		const compat = buildOpenAICompat(clinepassSpec("glm-5.2"));
		expect(compat.wireModelIdMode).toBe("clinepass");
	});

	it("streams chain-of-thought via delta.reasoning, not reasoning_content", () => {
		const compat = buildOpenAICompat(clinepassSpec("deepseek-v4-pro"));
		expect(compat.reasoningContentField).toBe("reasoning");
	});

	it("keeps max_completion_tokens (reasoning budget is separate from content)", () => {
		const compat = buildOpenAICompat(clinepassSpec("kimi-k2.7-code"));
		expect(compat.maxTokensField).toBe("max_completion_tokens");
	});

	it("gates on the clinepass provider id, not the api.cline.bot host", () => {
		// A custom OpenAI-compat provider pointed at the same host serves generic
		// passthrough ids (e.g. `anthropic/claude-sonnet-4-6`). Those must NOT get
		// the `cline-pass/` wire prefix, the `reasoning` field, or the effort
		// passthrough — only the `clinepass` provider does.
		const custom = clinepassSpec("anthropic/claude-sonnet-4-6", { provider: "my-openai-compat" });
		const compat = buildOpenAICompat(custom);
		expect(compat.wireModelIdMode).not.toBe("clinepass");
		expect(compat.reasoningContentField).toBe("reasoning_content");
	});

	it("passes the full effort ladder through verbatim — never rewrites xhigh to max", () => {
		// The gateway 400s on `reasoning_effort: "max"` (verified live); the id-based
		// GLM-5.2 / DeepSeek family remaps would otherwise inject `max`.
		for (const id of ["glm-5.2", "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3"]) {
			const compat = buildOpenAICompat(clinepassSpec(id));
			expect(compat.reasoningEffortMap).toEqual({
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
			});
			expect(Object.values(compat.reasoningEffortMap ?? {})).not.toContain("max");
		}
	});

	it("pins the openai thinking format for the Qwen SKUs so they keep the xhigh ladder", () => {
		// Bare id `qwen3.7-max` matches the id-based Qwen classifier, which would
		// otherwise select the `qwen` dialect and drop `xhigh`. ClinePass tolerates
		// plain reasoning_effort, so pin `openai`.
		const compat = buildOpenAICompat(clinepassSpec("qwen3.7-max"));
		expect(compat.thinkingFormat).toBe("openai");
		expect(compat.reasoningEffortMap?.xhigh).toBe("xhigh");
	});

	it("keeps the MiMo effort clamp instead of the identity passthrough", () => {
		// MiMo SKUs support only low/medium/high. The identity ClinePass map would
		// let an API caller send an unsupported `minimal`/`xhigh` on the wire; the
		// MiMo map must win so those clamp to low/high.
		for (const id of ["mimo-v2.5", "mimo-v2.5-pro"]) {
			const compat = buildOpenAICompat(
				clinepassSpec(id, { thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] } }),
			);
			expect(compat.reasoningEffortMap).toEqual({ minimal: "low", xhigh: "high" });
		}
	});
});

describe("clinepass generator seed (source of truth)", () => {
	it("seeds all ten models — ClinePass has no /v1/models, so the seed is canonical", () => {
		const seed = buildClinepassSeed();
		expect(seed).toHaveLength(10);
		expect(seed.map(m => m.id).sort()).toEqual(CLINEPASS_STATIC_MODELS.map(m => m.id).sort());
		for (const model of seed) {
			expect(model.provider).toBe("clinepass");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.cline.bot/api/v1");
			expect(model.reasoning).toBe(true);
		}
	});

	it("returns fresh copies so callers cannot mutate the shared seed", () => {
		const a = buildClinepassSeed();
		const b = buildClinepassSeed();
		expect(a[0]).not.toBe(b[0]);
	});

	it("keeps the bundled catalog in sync with the seed ids", () => {
		const bundledIds = getBundledModels("clinepass")
			.map(m => m.id)
			.sort();
		expect(bundledIds).toEqual(
			buildClinepassSeed()
				.map(m => m.id)
				.sort(),
		);
	});
});

describe("clinepass bundled catalog", () => {
	const models = getBundledModels("clinepass");
	const byId = new Map(models.map(model => [model.id, model]));

	it("bundles all ten ClinePass models with bare public ids", () => {
		expect([...byId.keys()].sort()).toEqual(
			[
				"deepseek-v4-flash",
				"deepseek-v4-pro",
				"glm-5.2",
				"kimi-k2.6",
				"kimi-k2.7-code",
				"mimo-v2.5",
				"mimo-v2.5-pro",
				"minimax-m3",
				"qwen3.7-max",
				"qwen3.7-plus",
			].sort(),
		);
	});

	it("advertises xhigh on the models that accept it and caps MiMo at high", () => {
		for (const id of ["glm-5.2", "deepseek-v4-pro", "minimax-m3", "qwen3.7-max"]) {
			expect(byId.get(id)?.thinking?.efforts).toContain(Effort.XHigh);
		}
		// MiMo's family map has no genuine xhigh tier; the catalog caps it at high.
		for (const id of ["mimo-v2.5", "mimo-v2.5-pro"]) {
			expect(byId.get(id)?.thinking?.efforts).not.toContain(Effort.XHigh);
			expect(byId.get(id)?.thinking?.efforts).toContain(Effort.High);
		}
	});

	it("points every model at the ClinePass gateway", () => {
		for (const model of models) {
			expect(model.baseUrl).toBe(CLINEPASS_BASE_URL);
			expect(model.provider).toBe("clinepass");
			expect(model.reasoning).toBe(true);
		}
	});

	it("keeps the curated vision capability — only kimi-k2.7-code accepts images", () => {
		// The global models.dev fallback matches bare ids against same-id models
		// from other providers and would otherwise overwrite `input`, wrongly
		// advertising `image` support on text-only ClinePass models. `clinepass`
		// is excluded from that fallback, so the seed's capabilities survive.
		expect(byId.get("kimi-k2.7-code")?.input).toEqual(["text", "image"]);
		for (const id of ["glm-5.2", "kimi-k2.6", "deepseek-v4-pro", "mimo-v2.5", "minimax-m3", "qwen3.7-plus"]) {
			expect(byId.get(id)?.input).toEqual(["text"]);
		}
	});

	it("keeps the curated (ClinePass) display names — fallback does not strip the suffix", () => {
		expect(byId.get("kimi-k2.6")?.name).toBe("Kimi K2.6 (ClinePass)");
		expect(byId.get("minimax-m3")?.name).toBe("MiniMax M3 (ClinePass)");
	});
});
