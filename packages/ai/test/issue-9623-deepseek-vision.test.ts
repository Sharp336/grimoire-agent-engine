import { describe, expect, it } from "bun:test";
import { isOpenAICompletionsVisionSupported, isTextOnlyDeepSeek } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog";

function bundled(provider: "deepseek" | "opencode-go", id: string): Model<"openai-completions"> {
	const model = getBundledModel<"openai-completions">(provider, id);
	if (!model) throw new Error(`bundled model not found: ${provider}/${id}`);
	if (model.api !== "openai-completions") throw new Error(`expected openai-completions, got ${model.api}`);
	return model;
}

describe("issue #9623 DeepSeek vision guard", () => {
	it("keeps images for bundled DeepSeek vision SKUs that declare image input", () => {
		for (const provider of ["deepseek", "opencode-go"] as const) {
			const model = bundled(provider, "deepseek-v4-flash-vision-exp");
			expect(model.input).toContain("image");
			expect(isTextOnlyDeepSeek(model)).toBe(false);
			expect(isOpenAICompletionsVisionSupported(model)).toBe(true);
		}
	});

	it("still strips images from text-only DeepSeek SKUs claiming image input", () => {
		const textOnly = bundled("deepseek", "deepseek-v4-pro");
		expect(textOnly.input).not.toContain("image");
		expect(isTextOnlyDeepSeek(textOnly)).toBe(true);
		expect(isOpenAICompletionsVisionSupported({ ...textOnly, input: ["text", "image"] })).toBe(false);
	});
});
