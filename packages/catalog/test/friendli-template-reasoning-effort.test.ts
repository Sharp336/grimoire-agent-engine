/**
 * Friendli serves GLM-5.2 reasoning models via the same
 * `chat_template_kwargs.enable_thinking` toggle NVIDIA NIM Qwen uses (so
 * `buildOpenAICompat` resolves them to `thinkingFormat: "qwen-chat-template"`),
 * but unlike NIM it ALSO accepts top-level `reasoning_effort` for the effort
 * ladder `getModelDefinedEfforts` exposes. The `supportsReasoningEffort` flag
 * tells the encoder to emit `reasoning_effort` alongside the template kwarg;
 * without it, every effort tier collapses to identical wire bodies and silently
 * drops the user's effort. NIM's strict `additionalProperties: false` schema
 * 400s on top-level `reasoning_effort`, so `supportsReasoningEffort` is false
 * for NIM. The flag is gated on `spec.thinking?.efforts` — resolved at discovery
 * time from `/v1/models` `reasoning_options` (`type: "effort"`) or the static
 * seed — plus identity-known GLM-5.2 (for custom Friendli-pointed providers
 * that lack a `thinking` block).
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

describe("Friendli reasoning effort compat", () => {
	it("enables supportsReasoningEffort when thinking.efforts is declared", () => {
		const compat = buildOpenAICompat(friendliSpec("zai-org/GLM-5.2", true, HIGH_MAX));
		expect(compat.thinkingFormat).toBe("qwen-chat-template");
		expect(compat.supportsReasoningEffort).toBe(true);
		expect(compat.omitReasoningEffort).toBe(false);
	});

	it("keeps supportsReasoningEffort off for Friendli reasoning models without thinking.efforts", () => {
		// Pre-rollout: reasoning: true but no `type: "effort"` in reasoning_options
		// and no static seed → thinking is undefined → no effort surface.
		const compat = buildOpenAICompat(friendliSpec("deepseek-ai/DeepSeek-V3.2", true));
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.omitReasoningEffort).toBe(true);
	});

	it("keeps supportsReasoningEffort off when the Friendli model is not marked reasoning", () => {
		const compat = buildOpenAICompat(friendliSpec("zai-org/GLM-5.2", false, HIGH_MAX));
		expect(compat.supportsReasoningEffort).toBe(false);
	});

	it("enables supportsReasoningEffort for GLM-5.2 on a custom Friendli-pointed provider without spec.thinking", () => {
		// A custom provider pointing at api.friendli.ai serves GLM-5.2 but
		// without an explicit thinking block. Identity detection must recognize
		// GLM-5.2 and enable supportsReasoningEffort — otherwise the resolved
		// thinking metadata (HIGH_MAX from getModelDefinedEfforts) and the wire
		// flag disagree, collapsing every effort tier to the same request.
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
		expect(buildOpenAICompat(custom).supportsReasoningEffort).toBe(true);
	});

	it("suppresses supportsReasoningEffort when the model config sets supportsReasoningEffort: false", () => {
		// A Friendli GLM-5.2 model with an explicit compat override that
		// suppresses reasoning_effort must NOT emit the field.
		const suppressed: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "zai-org/GLM-5.2",
			name: "GLM-5.2",
			provider: "friendli",
			baseUrl: "https://api.friendli.ai/serverless/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 131072,
			reasoning: true,
			thinking: HIGH_MAX,
			compat: { supportsReasoningEffort: false } as never,
		};
		const compat = buildOpenAICompat(suppressed);
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.omitReasoningEffort).toBe(true);
		// The model is identity-known to have an effort surface (GLM-5.2), so
		// the disable mode must stay `qwen-template-false` — NOT collapse to
		// "omit". With "omit" the enabled request path emits neither
		// `reasoning_effort` (suppressed by omitReasoningEffort) nor
		// `chat_template_kwargs.enable_thinking` (omitted by the default branch),
		// so the user could never turn thinking on. The override only suppresses
		// the top-level effort field; the template toggle must survive.
		expect(compat.reasoningDisableMode).toBe("qwen-template-false");
	});

	it("uses qwen-template-false for toggle-only Friendli reasoning models", () => {
		// GLM-4.5 reasons but has no effort control — only a toggle +
		// budget_tokens. The model's single-tier thinking config from
		// `mapFriendliThinking` lets the binary-collapse path expose an
		// on/off control. `qwen-template-false` sends `enable_thinking: false`
		// on the not-requested default AND on an explicit `disableReasoning`,
		// and `enable_thinking: true` when the binary tier is selected —
		// callers can turn the model off, which `"omit"` couldn't do.
		const toggleOnly: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "zai-org/GLM-4.5",
			name: "GLM-4.5",
			provider: "friendli",
			baseUrl: "https://api.friendli.ai/serverless/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 131072,
			reasoning: true,
		};
		const compat = buildOpenAICompat(toggleOnly);
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.thinkingFormat).toBe("qwen-chat-template");
		expect(compat.reasoningDisableMode).toBe("qwen-template-false");
	});

	it("keeps qwen-template-false for Friendli reasoning models with effort", () => {
		// GLM-5.2 with thinking.efforts should keep the normal disable mode
		// so the user can toggle thinking off via enable_thinking:false.
		const withEffort: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "zai-org/GLM-5.2",
			name: "GLM-5.2",
			provider: "friendli",
			baseUrl: "https://api.friendli.ai/serverless/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 131072,
			reasoning: true,
			thinking: HIGH_MAX,
		};
		const compat = buildOpenAICompat(withEffort);
		expect(compat.reasoningDisableMode).toBe("qwen-template-false");
		expect(compat.supportsReasoningEffort).toBe(true);
	});

	it("leaves supportsReasoningEffort off for the other qwen-chat-template host (NVIDIA NIM)", () => {
		// NIM is the precedent for routing to `qwen-chat-template`; its strict
		// schema rejects top-level `reasoning_effort`, so supportsReasoningEffort
		// must be false for qwen-chat-template models that aren't Friendli.
		// Use a Qwen id so the format genuinely resolves to qwen-chat-template.
		const nim: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "qwen/qwen3.5-397b-a17b",
			name: "Qwen3.5-397B-A17B",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 262144,
			reasoning: true,
			thinking: HIGH_MAX,
		};
		const compat = buildOpenAICompat(nim);
		expect(compat.thinkingFormat).toBe("qwen-chat-template");
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.omitReasoningEffort).toBe(true);
	});
});
