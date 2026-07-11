import { describe, expect, it } from "bun:test";
import { buildOpenAICompat } from "../src/compat/openai";
import { Effort } from "../src/effort";
import { getBundledModels } from "../src/models";
import { buildClineApiSeed, CLINE_API_STATIC_MODELS } from "../src/provider-models/openai-compat";
import type { ModelSpec } from "../src/types";

function clineApiSpec(id = "zai/glm-5.2"): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "cline-api",
		baseUrl: "https://api.cline.bot/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131072,
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
	};
}

describe("Cline API compatibility", () => {
	it("preserves provider/model ids on the wire", () => {
		expect(buildOpenAICompat(clineApiSpec()).wireModelIdMode).toBe("raw");
	});

	it("uses Cline reasoning fields and preserves xhigh", () => {
		const compat = buildOpenAICompat(clineApiSpec());
		expect(compat.reasoningContentField).toBe("reasoning");
		expect(compat.reasoningEffortMap?.xhigh).toBe("xhigh");
		expect(compat.thinkingFormat).toBe("openai");
	});

	it("keeps the curated seed synchronized with the bundled catalog", () => {
		expect(buildClineApiSeed()).toEqual([...CLINE_API_STATIC_MODELS]);
		const bundled = getBundledModels("cline-api");
		expect(bundled.map(model => model.id).sort()).toEqual(CLINE_API_STATIC_MODELS.map(model => model.id).sort());
	});
});
