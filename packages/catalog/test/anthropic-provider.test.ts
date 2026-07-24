import { describe, expect, test } from "bun:test";
import {
	ANTHROPIC_CURATED_FALLBACK_MODELS,
	anthropicModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Anthropic provider", () => {
	test("preserves curated Opus 5 metadata during first-party discovery", async () => {
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url === "https://models.dev/api.json") {
				return Promise.resolve(Response.json({ anthropic: { models: {} } }));
			}
			if (url === "https://api.anthropic.com/v1/models") {
				return Promise.resolve(Response.json({ data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }] }));
			}
			throw new Error(`Unexpected URL: ${url}`);
		};

		const options = anthropicModelManagerOptions({ apiKey: "sk-ant-test", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const opus = models?.find(model => model.id === "claude-opus-5");
		const curated = ANTHROPIC_CURATED_FALLBACK_MODELS.find(model => model.id === "claude-opus-5");

		expect(curated).toBeDefined();
		expect(opus).toMatchObject({
			reasoning: curated?.reasoning,
			input: curated?.input,
			cost: curated?.cost,
			contextWindow: curated?.contextWindow,
			maxTokens: curated?.maxTokens,
		});
	});
});
