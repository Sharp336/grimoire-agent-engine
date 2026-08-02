/**
 * Friendli serves GLM-5.2 reasoning models via the same
 * `chat_template_kwargs.enable_thinking` toggle NVIDIA NIM Qwen uses (so
 * `buildOpenAICompat` resolves them to `thinkingFormat: "qwen-chat-template"`),
 * but unlike NIM it ALSO accepts top-level `reasoning_effort` for the `high`/`max`
 * ladder `getModelDefinedEfforts` exposes for GLM-5.2. The
 * `friendliTemplateReasoningEffort` compat flag tells the encoder to emit
 * `reasoning_effort` alongside the template kwarg; without it, selecting high vs
 * max collapses to identical wire bodies and silently drops the user's effort.
 * NIM's strict `additionalProperties: false` schema 400s on top-level
 * `reasoning_effort`, so the flag must stay Friendli GLM-5.2-specific.
 */
import { describe, expect, it } from "bun:test";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function friendliSpec(id: string, reasoning: boolean): ModelSpec<"openai-completions"> {
	return {
		api: "openai-completions",
		id,
		name: id,
		provider: "friendli",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8192,
		contextWindow: 131072,
		reasoning,
	};
}

describe("Friendli template reasoning effort flag", () => {
	it("enables friendliTemplateReasoningEffort for the Friendli GLM-5.2 reasoning model", () => {
		const compat = buildOpenAICompat(friendliSpec("zai-org/GLM-5.2", true));
		expect(compat.thinkingFormat).toBe("qwen-chat-template");
		expect(compat.friendliTemplateReasoningEffort).toBe(true);
	});

	it("keeps the flag off for Friendli reasoning models that are not GLM-5.2+ effort-capable", () => {
		// GLM-4.5 is reasoning-capable but does NOT accept `reasoning_effort`
		// (`isGlm52ReasoningEffortModelId` gates on version >= 5.2). The template
		// toggle stays on, the extra `reasoning_effort` field must not leak.
		const compat = buildOpenAICompat(friendliSpec("zai-org/GLM-4.5", true));
		expect(compat.thinkingFormat).toBe("qwen-chat-template");
		expect(compat.friendliTemplateReasoningEffort).toBe(false);
	});

	it("keeps the flag off when the Friendli model is not marked reasoning", () => {
		const compat = buildOpenAICompat(friendliSpec("zai-org/GLM-5.2", false));
		expect(compat.friendliTemplateReasoningEffort).toBe(false);
	});

	it("leaves the flag off for the other qwen-chat-template host (NVIDIA NIM)", () => {
		// NIM is the precedent for routing to `qwen-chat-template`; its strict
		// schema rejects top-level `reasoning_effort`, so the flag must NOT flip
		// for it even on a GLM-5.2-shaped id.
		const nim: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "zai-org/GLM-5.2",
			name: "GLM-5.2",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 262144,
			reasoning: true,
		};
		expect(buildOpenAICompat(nim).friendliTemplateReasoningEffort).toBe(false);
	});
});
