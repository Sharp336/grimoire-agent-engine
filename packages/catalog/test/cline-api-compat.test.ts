import { describe, expect, it } from "bun:test";
import { buildOpenAICompat } from "../src/compat/openai";
import { getBundledModels } from "../src/models";
import { buildClineApiSeed, CLINE_API_STATIC_MODELS } from "../src/provider-models/openai-compat";
import type { ModelSpec } from "../src/types";

/**
 * Cline API (usage-credit gateway at `api.cline.bot`) re-hosts open coding
 * models behind one OpenAI-compatible endpoint. Requests preserve the upstream
 * `provider/model` wire id (wireModelIdMode `"raw"`) while streaming
 * chain-of-thought through the Cline-specific `reasoning` field.
 */

const CLINE_API_BASE_URL = "https://api.cline.bot/api/v1";

const baseModel: Omit<ModelSpec<"openai-completions">, "provider" | "baseUrl"> = {
	api: "openai-completions",
	id: "zai/glm-5.2",
	name: "GLM 5.2",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 32_000,
	contextWindow: 200_000,
	reasoning: true,
};

function clineApiSpec(): ModelSpec<"openai-completions"> {
	return { ...baseModel, provider: "cline-api", baseUrl: CLINE_API_BASE_URL };
}

describe("cline-api openai-compat", () => {
	it("preserves provider/model ids on the wire (wireModelIdMode raw)", () => {
		const compat = buildOpenAICompat(clineApiSpec());
		expect(compat.wireModelIdMode).toBe("raw");
	});

	it("uses Cline reasoning fields (reasoningContentField reasoning)", () => {
		const compat = buildOpenAICompat(clineApiSpec());
		expect(compat.reasoningContentField).toBe("reasoning");
	});

	it("uses openai thinkingFormat", () => {
		const compat = buildOpenAICompat(clineApiSpec());
		expect(compat.thinkingFormat).toBe("openai");
	});

	it("buildClineApiSeed matches CLINE_API_STATIC_MODELS", () => {
		const seed = buildClineApiSeed();
		expect(seed).toHaveLength(CLINE_API_STATIC_MODELS.length);
		expect(seed.map(m => m.id)).toEqual(CLINE_API_STATIC_MODELS.map(m => m.id));
	});

	it("keeps the curated seed synchronized with the bundled catalog", () => {
		const bundled = getBundledModels("cline-api");
		const seed = buildClineApiSeed();
		expect(bundled.map(m => m.id).sort()).toEqual(seed.map(m => m.id).sort());
	});
});
