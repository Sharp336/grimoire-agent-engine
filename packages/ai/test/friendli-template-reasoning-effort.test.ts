/**
 * Friendli serves GLM-5.2 reasoning via the same `chat_template_kwargs.enable_thinking`
 * toggle NVIDIA NIM Qwen uses (so `buildOpenAICompat` resolves it to
 * `thinkingFormat: "qwen-chat-template"`, `reasoningDisableMode: "qwen-template-false"`).
 * Unlike NIM, Friendli additionally accepts top-level `reasoning_effort` for the
 * `high`/`max` ladder `getModelDefinedEfforts` exposes. The
 * `supportsReasoningEffort` flag tells `applyChatCompletionsCompatPolicy`
 * to emit `reasoning_effort` ALONGSIDE the template kwarg. Without it, the
 * `qwen-template-false` branch would write only `chat_template_kwargs.enable_thinking`
 * and collapse `high` vs `max` effort tiers to identical wire bodies — silently
 * dropping the user's selected effort. NIM's strict `additionalProperties: false`
 * schema 400s on top-level `reasoning_effort`, so `supportsReasoningEffort` is
 * false for NIM (and `omitReasoningEffort` is true).
 *
 * Tests target `applyChatCompletionsReasoningParams` directly so they don't
 * depend on the native text-wrapping addon the streaming path pulls in.
 */
import { describe, expect, it } from "bun:test";
import {
	applyChatCompletionsReasoningParams,
	type OpenAICompletionsParams,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function friendliModel(reasoning: boolean): Model<"openai-completions"> {
	return buildModel({
		id: "zai-org/GLM-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider: "friendli",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 8_192,
		thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
	} satisfies ModelSpec<"openai-completions">);
}

function apply(model: Model<"openai-completions">, reasoning: "high" | "max"): OpenAICompletionsParams {
	const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
	applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning });
	return params;
}

describe("Friendli GLM-5.2 template + reasoning_effort wire shape", () => {
	it("emits chat_template_kwargs.enable_thinking AND reasoning_effort (high)", () => {
		const params = apply(friendliModel(true), "high");
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(params.reasoning_effort).toBe("high");
	});

	it("emits chat_template_kwargs.enable_thinking AND reasoning_effort (max) — distinct from high", () => {
		// Contract: distinct effort tiers MUST produce distinct wire bodies.
		// Collapsing to the same body is exactly the regression the
		// `supportsReasoningEffort` flag prevents.
		const high = apply(friendliModel(true), "high");
		const max = apply(friendliModel(true), "max");
		expect(max.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(max.reasoning_effort).toBe("max");
		expect(high.reasoning_effort).toBe("high");
		expect(high.reasoning_effort).not.toBe(max.reasoning_effort);
	});

	it("explicitly disables thinking when no effort is requested and drops reasoning_effort", () => {
		// Friendli's default is thinking-off; with no `reasoning` requested the
		// qwen-template-false dialect auto-disables via the kwarg. The Friendli
		// effort passthrough stays out of the disabled path.
		const model = friendliModel(true);
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, undefined);
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("does NOT emit reasoning_effort for the other qwen-chat-template host (NVIDIA NIM)", () => {
		// NIM's strict request schema 400s on top-level `reasoning_effort`. The
		// opt-in must not bleed there. Use a Qwen NIM model so the dialect
		// genuinely resolves to `qwen-chat-template`.
		const model = buildModel({
			id: "qwen/qwen3.5-397b-a17b",
			name: "Qwen3.5-397B-A17B",
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 8_192,
		} satisfies ModelSpec<"openai-completions">);
		expect(model.compat.thinkingFormat).toBe("qwen-chat-template");
		expect(model.compat.supportsReasoningEffort).toBe(false);

		const params = apply(model, "high");
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(params.reasoning_effort).toBeUndefined();
	});
});
