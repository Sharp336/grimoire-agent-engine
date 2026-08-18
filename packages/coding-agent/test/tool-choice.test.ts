import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";

describe("buildNamedToolChoice", () => {
	it("returns a named Anthropic tool choice", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		expect(buildNamedToolChoice("todo", model)).toEqual({ type: "tool", name: "todo" });
	});

	it("names todo for Google/Gemini instead of a generic required choice", () => {
		const base = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!base) throw new Error("Expected bundled anthropic model");
		const google = { ...base, api: "google-generative-ai", provider: "google", id: "gemini-2.5-flash" } as Model;
		expect(buildNamedToolChoice("todo", google)).toEqual({ type: "tool", name: "todo" });
	});
});
