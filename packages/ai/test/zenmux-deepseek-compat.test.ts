import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { convertMessages, detectCompat } from "../src/providers/openai-completions";
import type { AssistantMessage, Model, ThinkingContent, ToolCall } from "../src/types";

function zenmuxDeepseekModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		provider: "zenmux",
		baseUrl: "https://zenmux.ai/api/v1",
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek: V4 Pro",
		reasoning: true,
		...overrides,
	};
}

describe("ZenMux DeepSeek V4 compatibility", () => {
	it("treats DeepSeek family as non-standard (no store, no developer role) on ZenMux", () => {
		const compat = detectCompat(zenmuxDeepseekModel());
		expect(compat.supportsStore).toBe(false);
		expect(compat.supportsDeveloperRole).toBe(false);
	});

	it("uses max_tokens (not max_completion_tokens) for DeepSeek family on ZenMux", () => {
		const compat = detectCompat(zenmuxDeepseekModel());
		expect(compat.maxTokensField).toBe("max_tokens");
	});

	it("requires reasoning_content replay on tool-call turns for DeepSeek V4 via ZenMux", () => {
		const compat = detectCompat(zenmuxDeepseekModel());
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	});

	it("requires non-null assistant content for tool-call turns on DeepSeek V4 via ZenMux", () => {
		const compat = detectCompat(zenmuxDeepseekModel());
		expect(compat.requiresAssistantContentForToolCalls).toBe(true);
	});

	it("maps xhigh effort to DeepSeek's 'max' level via ZenMux", () => {
		const compat = detectCompat(zenmuxDeepseekModel());
		expect(compat.reasoningEffortMap.xhigh).toBe("max");
	});

	it("disables reasoning when tool_choice is sent (DeepSeek V4 thinking-mode invariant)", () => {
		const compat = detectCompat(zenmuxDeepseekModel());
		expect(compat.disableReasoningOnToolChoice).toBe(true);
	});

	it("keeps non-reasoning DeepSeek models on ZenMux at chat-completions defaults for content", () => {
		const compat = detectCompat(zenmuxDeepseekModel({ id: "deepseek/deepseek-v3-chat", reasoning: false }));
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		expect(compat.requiresAssistantContentForToolCalls).toBe(false);
		expect(compat.maxTokensField).toBe("max_tokens");
		expect(compat.supportsStore).toBe(false);
	});

	it("forces reasoning_content field name even when upstream streamed under `reasoning`", () => {
		// Reproduces the observed 400: ZenMux proxies DeepSeek and surfaces reasoning under
		// the OpenRouter-style `reasoning` field name. On replay, the bug previously kept that
		// alias and DeepSeek rejected the message because it expects the literal `reasoning_content`.
		const model = zenmuxDeepseekModel();
		const compat = detectCompat(model);
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "The user wants me to compile a LaTeX document.",
					thinkingSignature: "reasoning",
				} as ThinkingContent,
				{
					type: "toolCall",
					id: "call_test",
					name: "read",
					arguments: { path: "." },
				} as ToolCall,
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [msg] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		const obj = assistant as object;
		expect(Reflect.get(obj, "reasoning_content")).toBe("The user wants me to compile a LaTeX document.");
		expect(Reflect.get(obj, "reasoning")).toBeUndefined();
		expect(Reflect.get(obj, "reasoning_text")).toBeUndefined();
	});

	it("strips a stale `reasoning` alias even when no thinking blocks exist on a tool-call turn", () => {
		// Edge case: a prior turn stored a `reasoning` field (from streamed alias), the assistant
		// message has tool calls but no thinking blocks, and DeepSeek requires a clean wire payload.
		const model = zenmuxDeepseekModel();
		const compat = detectCompat(model);
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_no_thinking",
					name: "read",
					arguments: { path: "." },
				} as ToolCall,
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [msg] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		const obj = assistant as object;
		expect(Reflect.get(obj, "reasoning_content")).toBe("");
		expect(Reflect.get(obj, "reasoning")).toBeUndefined();
		expect(Reflect.get(obj, "reasoning_text")).toBeUndefined();
	});
});
