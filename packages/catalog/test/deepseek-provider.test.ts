import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	DEEPSEEK_VISION_STATIC_MODELS,
	deepseekModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

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
		// authored verbatim and covered by the shipped-catalog test below.
		const model = buildModel(DEEPSEEK_VISION_STATIC_MODELS[0]);

		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking && "efforts" in model.thinking ? model.thinking.efforts : undefined).toEqual([
			Effort.Low,
			Effort.High,
			Effort.Max,
		]);
	});

	test("shipped catalog resolves the vision SKU with curated seed metadata", () => {
		// Seed inclusion and precedence: the unshifted seed must reach the
		// shipped bundle (a sparse discovery row would carry cost 0 / null
		// limits) and the vision gate consumers check — input containing
		// "image" — must hold. Asserted semantically so a deliberate seed
		// deletion in favor of a catalogued upstream row stays green.
		const model = getBundledModel("deepseek", "deepseek-v4-flash-vision-exp");

		expect(model).toBeDefined();
		expect(model?.input).toContain("text");
		expect(model?.input).toContain("image");
		expect(model?.contextWindow).toBeGreaterThan(0);
		expect(model?.maxTokens).toBeGreaterThan(0);
		expect(model?.cost.input).toBeGreaterThan(0);
	});
});
