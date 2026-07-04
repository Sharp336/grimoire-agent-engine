import { describe, expect, it } from "bun:test";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { longcatModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * LongCat (Meituan) speaks the z.ai-style binary `thinking:{type}` protocol
 * with `reasoning_content`. Classified under the `zai` host (hosts.ts), so
 * omp derives thinkingFormat:"zai" + supportsReasoningEffort:false and never
 * emits `reasoning_effort` (LongCat ignores it and 400s on minimal/xhigh).
 * The model id is case-sensitive (`LongCat-2.0`).
 */

const baseModel: Omit<ModelSpec<"openai-completions">, "provider" | "baseUrl"> = {
	api: "openai-completions",
	id: "LongCat-2.0",
	name: "LongCat 2.0",
	input: ["text"],
	cost: { input: 0.75, output: 2.95, cacheRead: 0.015, cacheWrite: 0 },
	maxTokens: 131_072,
	contextWindow: 1_000_000,
	reasoning: true,
};

function longcatModel(): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		provider: "longcat",
		baseUrl: "https://api.longcat.chat/openai/v1",
	};
}

describe("longcat descriptor", () => {
	it("defaults to the case-sensitive LongCat-2.0 id served by the API", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.longcat).toBe("LongCat-2.0");
	});
});

describe("openai-completions compat — longcat branch", () => {
	it("derives zai thinking format and disables reasoning_effort", () => {
		const compat = buildOpenAICompat(longcatModel());

		// Binary `thinking:{type:"enabled"|"disabled"}` only — never reasoning_effort.
		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.reasoningContentField).toBe("reasoning_content");
		// `longcat` participates in the zai/non-standard set.
		expect(compat.supportsDeveloperRole).toBe(false);
		expect(compat.supportsMultipleSystemMessages).toBe(true);
		expect(compat.supportsStore).toBe(false);
	});

	it("detects longcat by baseUrl when the provider id is custom", () => {
		const compat = buildOpenAICompat({
			...baseModel,
			provider: "custom",
			baseUrl: "https://api.longcat.chat/openai/v1",
		});

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
	});
});

describe("longcat model discovery", () => {
	function mockFetch(data: { id: string }[]): FetchImpl {
		return Object.assign(
			async (input: string | Request | URL): Promise<Response> => {
				const url = input instanceof Request ? input.url : String(input);
				if (url.endsWith("/models")) {
					return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: fetch.preconnect },
		);
	}

	it("stamps documented metadata onto LongCat-2.0 and leaves unknown ids untouched", async () => {
		const fetchImpl = mockFetch([{ id: "LongCat-2.0" }, { id: "LongCat-3.0" }]);
		const options = longcatModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl });
		expect(typeof options.fetchDynamicModels).toBe("function");
		const models = (await options.fetchDynamicModels?.()) ?? [];

		// Request hit the OpenAI-compatible models endpoint.
		expect(models.length).toBe(2);

		const known = models.find(m => m.id === "LongCat-2.0");
		expect(known?.reasoning).toBe(true);
		expect(known?.cost).toEqual({ input: 0.75, output: 2.95, cacheRead: 0.015, cacheWrite: 0 });
		expect(known?.contextWindow).toBe(1_000_000);
		expect(known?.compat?.thinkingFormat).toBe("zai");

		// A future sibling must NOT inherit LongCat-2.0's pricing/context — the
		// mapper falls through to discovery defaults for unknown ids.
		const unknown = models.find(m => m.id === "LongCat-3.0");
		expect(unknown?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(unknown?.contextWindow).not.toBe(1_000_000);
	});
});
