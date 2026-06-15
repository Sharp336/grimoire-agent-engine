import { describe, expect, it } from "bun:test";
import { resolveModelOverlay } from "./index";

describe("resolveModelOverlay", () => {
	it("detects GPT-5 family models in auto mode", () => {
		expect(resolveModelOverlay("openai/gpt-5.5", "auto")).toContain("## Model overlay: GPT-5");
		expect(resolveModelOverlay("openai/gpt-5.2", "auto")).toContain("## Model overlay: GPT-5");
		expect(resolveModelOverlay("OpenAI/GPT 5.5", "auto")).toContain("## Model overlay: GPT-5");
	});

	it("detects Claude Opus family models in auto mode", () => {
		expect(resolveModelOverlay("anthropic/claude-opus-4-6", "auto")).toContain("## Model overlay: Claude Opus");
	});

	it("detects Kimi K2 family models in auto mode", () => {
		expect(resolveModelOverlay("moonshotai/kimi-k2-7", "auto")).toContain("## Model overlay: Kimi K2");
	});

	it("does not match unrelated model families in auto mode", () => {
		expect(resolveModelOverlay("anthropic/claude-sonnet-4-6", "auto")).toBeUndefined();
	});

	it("returns undefined when overlay mode is off", () => {
		expect(resolveModelOverlay("openai/gpt-5.5", "off")).toBeUndefined();
	});

	it("forces a requested family regardless of model id", () => {
		expect(resolveModelOverlay("anthropic/claude-opus-4-6", "gpt-5")).toContain("## Model overlay: GPT-5");
	});

	it("returns undefined for missing auto-mode model ids", () => {
		expect(resolveModelOverlay(undefined, "auto")).toBeUndefined();
	});
});
