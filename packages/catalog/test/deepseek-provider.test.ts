import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
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

	test("vision seed resolves image input, binary limits, and the V4 flash thinking ladder", () => {
		// buildModel is the same constructor the generator runs over the seed
		// when bundling models.json, so this pins the authored contract at the
		// source level without coupling to generated catalog output.
		const model = buildModel(DEEPSEEK_VISION_STATIC_MODELS[0]);

		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(393_216);
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking && "efforts" in model.thinking ? model.thinking.efforts : undefined).toEqual([
			Effort.Low,
			Effort.High,
			Effort.Max,
		]);
	});
});
