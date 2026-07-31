import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { BEDROCK_MANTLE_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { dropBedrockConverseOnlyOpenAIIds } from "../scripts/generated-policies";

// AWS serves these three OpenAI models on the `bedrock-mantle` endpoint over the
// OpenAI Responses API. Asserted against the seed/policy source rather than the
// bundled `models.json`, so the test survives upstream metadata shifts.
// https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html
const DOCUMENTED_IDS = ["openai.gpt-5.6-sol", "openai.gpt-5.6-terra", "openai.gpt-5.6-luna"];

// Per 1M tokens, us-east-1/us-east-2, from AWS's Bedrock pricing page — not
// OpenAI's first-party rates. `cacheWrite` is the 30-minute retention rate.
// Reflects the 2026-07-30 cut: Luna -80%, Terra -20%, Sol unchanged.
// https://aws.amazon.com/bedrock/pricing/
const DOCUMENTED_COST: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"openai.gpt-5.6-sol": { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88 },
	"openai.gpt-5.6-terra": { input: 2.2, output: 13.2, cacheRead: 0.22, cacheWrite: 2.75 },
	"openai.gpt-5.6-luna": { input: 0.22, output: 1.32, cacheRead: 0.022, cacheWrite: 0.275 },
};

describe("Bedrock Mantle GPT-5.6", () => {
	test("seeds exactly the three documented models on the openai-responses transport", () => {
		expect(BEDROCK_MANTLE_STATIC_MODELS.map(model => model.id)).toEqual(DOCUMENTED_IDS);
		for (const model of BEDROCK_MANTLE_STATIC_MODELS) {
			expect(model.provider).toBe("bedrock-mantle");
			// Converse/Invoke are unsupported for these models; only Responses works.
			expect(model.api).toBe("openai-responses");
			// The `/openai/v1` path is specific to these models — the `/v1` path other
			// Responses-API models on this endpoint use is a silent 404 here. `{region}`
			// is substituted at request time by pi-ai.
			expect(model.baseUrl).toBe("https://bedrock-mantle.{region}.api.aws/openai/v1");
			expect(model.contextWindow).toBe(272_000);
			expect(model.maxTokens).toBe(128_000);
			expect(model.reasoning).toBe(true);
			expect(model.input).toEqual(["text", "image"]);
			expect(model.cost).toEqual(DOCUMENTED_COST[model.id]);
			// `Effort` has no `none` member; the ladder matches the sibling `openai` rows.
			expect(model.thinking).toEqual({
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			});
		}
	});

	test("names carry no provider-attribution suffix, which generation would strip anyway", () => {
		expect(BEDROCK_MANTLE_STATIC_MODELS.map(model => model.name)).toEqual([
			"GPT-5.6 Sol",
			"GPT-5.6 Terra",
			"GPT-5.6 Luna",
		]);
	});

	test("dropBedrockConverseOnlyOpenAIIds removes only the dead amazon-bedrock GPT-5.6 rows", () => {
		const bareSpec = (provider: string, id: string): ModelSpec<"bedrock-converse-stream"> => ({
			id,
			name: id,
			api: "bedrock-converse-stream",
			provider,
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const input = [
			bareSpec("amazon-bedrock", "openai.gpt-5.6-sol"),
			// Other Bedrock rows — including other OpenAI ones that really do speak
			// Converse — must survive, and order must be preserved.
			bareSpec("amazon-bedrock", "us.anthropic.claude-opus-5"),
			bareSpec("amazon-bedrock", "openai.gpt-5.6-terra"),
			bareSpec("amazon-bedrock", "openai.gpt-oss-120b"),
			bareSpec("amazon-bedrock", "openai.gpt-5.6-luna"),
			bareSpec("amazon-bedrock", "openai.gpt-5.5"),
			// The same ids under any other provider are served over a working
			// transport and must not be touched.
			bareSpec("bedrock-mantle", "openai.gpt-5.6-terra"),
			bareSpec("openai", "gpt-5.6-terra"),
		];

		expect(dropBedrockConverseOnlyOpenAIIds(input).map(model => `${model.provider}/${model.id}`)).toEqual([
			"amazon-bedrock/us.anthropic.claude-opus-5",
			"amazon-bedrock/openai.gpt-oss-120b",
			"amazon-bedrock/openai.gpt-5.5",
			"bedrock-mantle/openai.gpt-5.6-terra",
			"openai/gpt-5.6-terra",
		]);
	});

	test("defaults the provider to Terra", () => {
		// Terra is AWS's positioning for general production work and is available in
		// one more region than Sol (us-west-2 in addition to us-east-1/us-east-2).
		expect(DEFAULT_MODEL_PER_PROVIDER["bedrock-mantle"]).toBe("openai.gpt-5.6-terra");
		expect(BEDROCK_MANTLE_STATIC_MODELS.some(model => model.id === "openai.gpt-5.6-terra")).toBe(true);
	});
});
