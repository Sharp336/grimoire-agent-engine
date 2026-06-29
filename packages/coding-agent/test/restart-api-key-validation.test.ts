import { describe, expect, test } from "bun:test";
import { requiresLaunchModelForRuntimeApiKey } from "@oh-my-pi/pi-coding-agent/main";

describe("restart runtime API key validation", () => {
	test("requires a launch model only for fresh CLI API-key runs", () => {
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime" }, {})).toBe(true);
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime", resume: "sess-1" }, {})).toBe(false);
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime", continue: true }, {})).toBe(false);
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime", fork: "sess-1" }, {})).toBe(false);
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime" }, { modelPattern: "openai/gpt-5" })).toBe(
			false,
		);
		expect(requiresLaunchModelForRuntimeApiKey({}, {})).toBe(false);
	});
});
