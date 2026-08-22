import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import {
	DEEPSEEK_VISION_STATIC_MODELS,
	deepseekModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

describe("DeepSeek built-in provider", () => {
	test("maps vision ids to image input in /models discovery", async () => {
		const requests: string[] = [];
		const fetchMock = async (input: string | URL | Request): Promise<Response> => {
			requests.push(input.toString());
			return Response.json({
				data: [
					{ id: "deepseek-v4-flash-vision-exp" },
					{ id: "deepseek-v4-flash" },
					// Not in the bundled references: proves the bare-id heuristic
					// keeps future vision SKUs image-capable too.
					{ id: "deepseek-v5-vision" },
				],
			});
		};

		const options = deepseekModelManagerOptions({ apiKey: "sk-test", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requests).toEqual(["https://api.deepseek.com/models"]);
		expect(models?.map(item => item.id)).toEqual([
			"deepseek-v4-flash",
			"deepseek-v4-flash-vision-exp",
			"deepseek-v5-vision",
		]);
		expect(models?.find(item => item.id === "deepseek-v4-flash-vision-exp")?.input).toEqual(["text", "image"]);
		expect(models?.find(item => item.id === "deepseek-v4-flash")?.input).toEqual(["text"]);
		expect(models?.find(item => item.id === "deepseek-v5-vision")?.input).toEqual(["text", "image"]);
	});

	test("vision seed derives the V4 flash thinking ladder from its identity", () => {
		// buildModel computes thinking from the id's identity classifiers —
		// the one derived field worth pinning; everything else on the seed is
		// authored verbatim and covered by the bundled-parity tests below.
		const model = buildModel(DEEPSEEK_VISION_STATIC_MODELS[0]);

		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking && "efforts" in model.thinking ? model.thinking.efforts : undefined).toEqual([
			Effort.Low,
			Effort.High,
			Effort.Max,
		]);
	});
});

// Pins the invariant: bundled `models.json` carries every entry the curated
// vision seed emits, with the seed's authored metadata intact. This mirrors
// the merged `xai-oauth-bundle.test.ts` precedent for authored seeds: the
// runtime boot path (`ModelRegistry.#loadModels`) reads only `models.json`,
// so a seed that never reaches the bundle is invisible until `refresh()`.
// Without the parity check, editing or dropping `DEEPSEEK_VISION_STATIC_MODELS`
// (or its generator `unshift`) without regenerating silently regresses the
// boot-time resolver. The AGENTS.md "test the resolver, not bundled JSON"
// rule targets upstream-derived rows, which shift on refresh; this seed is
// prepended ahead of every upstream source and wins the generator's
// earlier-rows-wins dedup, so unrelated refreshes cannot alter it — the only
// failure modes are exactly the regressions this suite is meant to catch.
// Failure here means: run `bun run gen:models` and commit the diff.
describe("deepseek vision bundled catalog (regression)", () => {
	const bundled =
		(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"openai-completions">>>).deepseek ?? {};
	const seed = DEEPSEEK_VISION_STATIC_MODELS;

	test("bundles every curated vision seed id", () => {
		for (const model of seed) {
			const entry = bundled[model.id];
			expect(entry, `deepseek/${model.id} missing from models.json`).toBeDefined();
			expect(entry.id).toBe(model.id);
			expect(entry.provider).toBe("deepseek");
			// The vision gate consumers check (input containing "image") must
			// survive both the seed and the bundle.
			expect(entry.input).toEqual(["text", "image"]);
			expect(entry.contextWindow).toBe(model.contextWindow);
			expect(entry.maxTokens).toBe(model.maxTokens);
		}
	});

	// A sparse credentialed discovery row (cost 0, null limits) must never
	// shadow the curated seed: the generator's unshift places the seed ahead
	// of every upstream source, and dedup keeps earlier rows.
	test("keeps non-sparse curated cost in the bundle", () => {
		const entry = bundled["deepseek-v4-flash-vision-exp"];
		expect(entry?.cost.input).toBeGreaterThan(0);
		expect(entry?.cost.output).toBeGreaterThan(0);
	});
});
