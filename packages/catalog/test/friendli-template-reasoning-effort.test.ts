/**
 * Friendli serves GLM-5.2 reasoning models via the same
 * `chat_template_kwargs.enable_thinking` toggle NVIDIA NIM Qwen uses (so
 * `buildOpenAICompat` resolves them to `thinkingFormat: "qwen-chat-template"`),
 * but unlike NIM it ALSO accepts top-level `reasoning_effort` for the effort
 * ladder `getModelDefinedEfforts` exposes. The
 * `friendliTemplateReasoningEffort` compat flag tells the encoder to emit
 * `reasoning_effort` alongside the template kwarg; without it, every effort
 * tier collapses to identical wire bodies and silently drops the user's effort.
 * NIM's strict `additionalProperties: false` schema 400s on top-level
 * `reasoning_effort`, so the flag must stay Friendli-specific. The flag is
 * gated on `spec.thinking?.efforts?.length` — resolved at discovery time from
 * `/v1/models` `reasoning_options` (`type: "effort"`) or the static seed.
 */
import { describe, expect, it } from "bun:test";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function friendliSpec(
	id: string,
	reasoning: boolean,
	thinking?: { mode: "effort"; efforts: readonly Effort[] },
): ModelSpec<"openai-completions"> {
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
		...(thinking !== undefined ? { thinking } : {}),
	};
}

const HIGH_MAX = { mode: "effort" as const, efforts: [Effort.High, Effort.Max] };

describe("Friendli template reasoning effort flag", () => {
	it("enables friendliTemplateReasoningEffort when thinking.efforts is declared", () => {
		const compat = buildOpenAICompat(friendliSpec("zai-org/GLM-5.2", true, HIGH_MAX));
		expect(compat.thinkingFormat).toBe("qwen-chat-template");
		expect(compat.friendliTemplateReasoningEffort).toBe(true);
	});

	it("keeps the flag off for Friendli reasoning models without thinking.efforts", () => {
		// Pre-rollout: reasoning: true but no `type: "effort"` in reasoning_options
		// and no static seed → thinking is undefined → flag stays off.
		const compat = buildOpenAICompat(friendliSpec("deepseek-ai/DeepSeek-V3.2", true));
		expect(compat.friendliTemplateReasoningEffort).toBe(false);
	});

	it("keeps the flag off when the Friendli model is not marked reasoning", () => {
		const compat = buildOpenAICompat(friendliSpec("zai-org/GLM-5.2", false, HIGH_MAX));
		expect(compat.friendliTemplateReasoningEffort).toBe(false);
	});

	it("enables the flag for GLM-5.2 on a custom Friendli-pointed provider without spec.thinking", () => {
		// A custom provider pointing at api.friendli.ai serves GLM-5.2 but
		// without an explicit thinking block. `hasFriendliTemplateReasoningEffort`
		// must detect the GLM-5.2 identity and enable the flag — otherwise the
		// resolved thinking metadata (HIGH_MAX from getModelDefinedEfforts) and
		// the wire flag disagree, collapsing every effort tier to the same request.
		const custom: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "zai-org/GLM-5.2",
			name: "GLM-5.2",
			provider: "my-custom-friendli",
			baseUrl: "https://api.friendli.ai/serverless/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 131072,
			reasoning: true,
		};
		expect(buildOpenAICompat(custom).friendliTemplateReasoningEffort).toBe(true);
	});

	it("leaves the flag off for the other qwen-chat-template host (NVIDIA NIM)", () => {
		// NIM is the precedent for routing to `qwen-chat-template`; its strict
		// schema rejects top-level `reasoning_effort`, so the flag must NOT flip
		// for it even on a GLM-5.2-shaped id with thinking.efforts.
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
			thinking: HIGH_MAX,
		};
		expect(buildOpenAICompat(nim).friendliTemplateReasoningEffort).toBe(false);
	});
});
