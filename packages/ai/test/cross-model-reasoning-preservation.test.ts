import { describe, expect, it } from "bun:test";
import { convertMessages } from "../src/providers/openai-completions";
import { transformMessages } from "../src/providers/transform-messages";
import type { AssistantMessage, Model } from "../src/types";

// Helper to create a model config
const createModel = (overrides: Partial<Model<"openai-completions">>): Model<"openai-completions"> => ({
	id: "test-model",
	name: "Test Model",
	provider: "test-provider",
	api: "openai-completions",
	reasoning: true,
	contextWindow: 128000,
	maxTokens: 4096,
	...overrides,
});

// Helper to create an assistant message with thinking
const createAssistantWithThinking = (
	thinking: string,
	content: string,
	signature?: string,
): AssistantMessage => ({
	role: "assistant",
	content: [
		{
			type: "thinking",
			thinking,
			thinkingSignature: signature,
		},
		{ type: "text", text: content },
	],
	provider: "test",
	api: "openai-completions",
	model: "test-model",
	timestamp: Date.now(),
	usage: { input: 0, output: 0, total: 0, cost: { input: 0, output: 0, total: 0 } },
	stopReason: "stop",
	responseId: undefined,
	providerPayload: undefined,
});

describe("Cross-model reasoning preservation", () => {
	describe("OpenAI-compatible → OpenAI-compatible", () => {
		it("DeepSeek → MiniMax: preserves reasoning as reasoning_details array", () => {
			const minimaxModel = createModel({
				id: "minimax-m3",
				provider: "minimax",
				compat: {
					reasoningContentField: "reasoning_details",
					requiresReasoningContentForToolCalls: true,
				},
			});

			const assistant = createAssistantWithThinking(
				"I need to solve this step by step",
				"The answer is 42",
				"reasoning_content", // DeepSeek uses this field name
			);

			// Transform for MiniMax
			const transformed = transformMessages([assistant], minimaxModel);
			
			// Convert to wire format
			const messages = convertMessages(minimaxModel, { messages: transformed }, minimaxModel.compat!);
			const assistantMsg = messages.find(m => m.role === "assistant");

			// Should have reasoning_details array
			expect((assistantMsg as any).reasoning_details).toBeDefined();
			expect(Array.isArray((assistantMsg as any).reasoning_details)).toBe(true);
			expect((assistantMsg as any).reasoning_details[0].type).toBe("reasoning.text");
			expect((assistantMsg as any).reasoning_details[0].text).toBe("I need to solve this step by step");
		});

		it("MiniMax → DeepSeek: preserves reasoning as reasoning_content string", () => {
			const deepseekModel = createModel({
				id: "deepseek-v3",
				provider: "deepseek",
				compat: {
					reasoningContentField: "reasoning_content",
					requiresReasoningContentForToolCalls: true,
				},
			});

			const assistant = createAssistantWithThinking(
				"Let me think about this",
				"The answer is 42",
				// MiniMax doesn't set thinkingSignature for plaintext reasoning
			);

			// Transform for DeepSeek
			const transformed = transformMessages([assistant], deepseekModel);
			
			// Convert to wire format
			const messages = convertMessages(deepseekModel, { messages: transformed }, deepseekModel.compat!);
			const assistantMsg = messages.find(m => m.role === "assistant");

			// Should have reasoning_content string
			expect((assistantMsg as any).reasoning_content).toBe("Let me think about this");
		});

		it("Kimi → DeepSeek: preserves reasoning without signature", () => {
			const deepseekModel = createModel({
				id: "deepseek-v3",
				provider: "deepseek",
				compat: {
					reasoningContentField: "reasoning_content",
					requiresReasoningContentForToolCalls: true,
				},
			});

			const assistant = createAssistantWithThinking(
				"Analyzing the problem",
				"The solution is clear",
				// Kimi doesn't set thinkingSignature for plaintext reasoning
			);

			const transformed = transformMessages([assistant], deepseekModel);
			const messages = convertMessages(deepseekModel, { messages: transformed }, deepseekModel.compat!);
			const assistantMsg = messages.find(m => m.role === "assistant");

			expect((assistantMsg as any).reasoning_content).toBe("Analyzing the problem");
		});
	});

	describe("Official APIs (should convert to text)", () => {
		it("api.openai.com: converts thinking to text", () => {
			const model = createModel({
				id: "gpt-4",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
			});

			const assistant = createAssistantWithThinking(
				"This is my reasoning",
				"The answer",
			);

			const transformed = transformMessages([assistant], model);
			
			// Should convert thinking to text for official APIs
			const content = transformed[0].content;
			if (Array.isArray(content)) {
				const textBlock = content.find(b => b.type === "text");
				expect(textBlock).toBeDefined();
				expect((textBlock as any).text).toContain("This is my reasoning");
			}
		});

		it("api.anthropic.com: converts thinking to text", () => {
			const model = createModel({
				id: "claude-3",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				api: "anthropic-messages",
				reasoning: true,
			});

			const assistant = createAssistantWithThinking(
				"My thinking process",
				"The response",
			);

			const transformed = transformMessages([assistant], model);
			
			// Should convert thinking to text for official APIs
			const content = transformed[0].content;
			if (Array.isArray(content)) {
				const textBlock = content.find(b => b.type === "text");
				expect(textBlock).toBeDefined();
				expect((textBlock as any).text).toContain("My thinking process");
			}
		});
	});

	describe("Legacy style and interleaved flags", () => {
		it("legacy_style: true: converts thinking to text", () => {
			const model = createModel({
				id: "old-model",
				compat: {
					legacy_style: true,
					reasoningContentField: "reasoning_content",
				},
			});

			const assistant = createAssistantWithThinking(
				"Old style reasoning",
				"Answer",
			);

			const transformed = transformMessages([assistant], model);
			
			const content = transformed[0].content;
			if (Array.isArray(content)) {
				const textBlock = content.find(b => b.type === "text");
				expect(textBlock).toBeDefined();
				expect((textBlock as any).text).toContain("Old style reasoning");
			}
		});

		it("interleaved: false: converts thinking to text", () => {
			const model = createModel({
				id: "non-interleaved",
				reasoning: true,
				compat: {
					interleaved: false,
					reasoningContentField: "reasoning_content",
				},
			});

			const assistant = createAssistantWithThinking(
				"Non-interleaved reasoning",
				"Answer",
			);

			const transformed = transformMessages([assistant], model);
			
			const content = transformed[0].content;
			if (Array.isArray(content)) {
				const textBlock = content.find(b => b.type === "text");
				expect(textBlock).toBeDefined();
				expect((textBlock as any).text).toContain("Non-interleaved reasoning");
			}
		});
	});

	describe("Edge cases", () => {
		it("Multiple thinking blocks: concatenates all thinking", () => {
			const model = createModel({
				id: "test",
				compat: {
					reasoningContentField: "reasoning_content",
					requiresReasoningContentForToolCalls: true,
				},
			});

			const assistant: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "First thought" },
					{ type: "thinking", thinking: "Second thought" },
					{ type: "text", text: "Answer" },
				],
				provider: "test",
				api: "openai-completions",
				model: "test",
				timestamp: Date.now(),
				usage: { input: 0, output: 0, total: 0, cost: { input: 0, output: 0, total: 0 } },
				stopReason: "stop",
				responseId: undefined,
				providerPayload: undefined,
			};

			const transformed = transformMessages([assistant], model);
			const messages = convertMessages(model, { messages: transformed }, model.compat!);
			const assistantMsg = messages.find(m => m.role === "assistant");

			// Thinking blocks are concatenated with newline separator
			expect((assistantMsg as any).reasoning_content).toBe("First thought\nSecond thought");
		});

		it("Empty thinking block: skips it", () => {
			const model = createModel({
				id: "test",
				compat: {
					reasoningContentField: "reasoning_content",
					requiresReasoningContentForToolCalls: true,
				},
			});

			const assistant: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "" },
					{ type: "thinking", thinking: "Valid thought" },
					{ type: "text", text: "Answer" },
				],
				provider: "test",
				api: "openai-completions",
				model: "test",
				timestamp: Date.now(),
				usage: { input: 0, output: 0, total: 0, cost: { input: 0, output: 0, total: 0 } },
				stopReason: "stop",
				responseId: undefined,
				providerPayload: undefined,
			};

			const transformed = transformMessages([assistant], model);
			const messages = convertMessages(model, { messages: transformed }, model.compat!);
			const assistantMsg = messages.find(m => m.role === "assistant");

			expect((assistantMsg as any).reasoning_content).toBe("Valid thought");
		});
	});
});
