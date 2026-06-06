import { describe, expect, it } from "bun:test";
import { transformMessages } from "../src/providers/transform-messages";
import type { Api, AssistantMessage, Message, Model } from "../src/types";

// Minimal model factory — only the fields transformMessages actually reads.
function makeModel<TApi extends Api>(overrides: Partial<Model<TApi>> = {}): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		provider: "test-provider",
		api: "openai-completions" as TApi,
		...overrides,
	} as Model<TApi>;
}

const dummyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantWithThinking(thinking: string, signature?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking, thinkingSignature: signature },
			{ type: "text", text: "hello" },
		],
		provider: "other-provider",
		api: "openai-completions",
		model: "other-model",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: dummyUsage,
	};
}

function assistantWithRedactedThinking(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "redactedThinking", data: "encrypted-blob" },
			{ type: "text", text: "hello" },
		],
		provider: "other-provider",
		api: "anthropic-messages",
		model: "other-model",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: dummyUsage,
	};
}

describe("transformMessages — cross-model thinking preservation", () => {
	it("converts thinking to text for non-reasoning model", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({ api: "openai-completions" });

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Should be converted to text — no thinking block
		expect(content.some(b => b.type === "thinking")).toBe(false);
		expect(content.some(b => b.type === "text" && b.text === "my reasoning")).toBe(true);
	});

	it("preserves thinking blocks for anthropic-messages target", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"anthropic-messages">({ api: "anthropic-messages" });

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Should preserve thinking block
		const thinking = content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect((thinking as any).thinking).toBe("my reasoning");
		expect((thinking as any).thinkingSignature).toBe("sig1");
	});

	it("preserves thinking blocks for reasoning model with reasoning: true", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: true,
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Should preserve thinking block for reasoning model
		const thinking = content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect((thinking as any).thinking).toBe("my reasoning");
		expect((thinking as any).thinkingSignature).toBe("sig1");
	});

	it("preserves redactedThinking for anthropic-messages target", () => {
		const messages: Message[] = [assistantWithRedactedThinking()];
		const model = makeModel<"anthropic-messages">({ api: "anthropic-messages" });

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Should preserve redactedThinking
		expect(content.some(b => b.type === "redactedThinking")).toBe(true);
	});

	it("drops redactedThinking for non-anthropic target", () => {
		const messages: Message[] = [assistantWithRedactedThinking()];
		const model = makeModel<"openai-completions">({ api: "openai-completions" });

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Should drop redactedThinking
		expect(content.some(b => b.type === "redactedThinking")).toBe(false);
	});

	it("drops empty thinking blocks even for anthropic target", () => {
		const messages: Message[] = [assistantWithThinking("", "sig1")];
		const model = makeModel<"anthropic-messages">({ api: "anthropic-messages" });

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Empty thinking should be dropped
		expect(content.some(b => b.type === "thinking")).toBe(false);
	});

	it("preserves same-model thinking blocks regardless of compat", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			id: "other-model",
			provider: "other-provider",
			api: "openai-completions",
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Same model + signature → preserved
		const thinking = content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect((thinking as any).thinking).toBe("my reasoning");
	});

	it("strips signatures from aborted messages even for anthropic target", () => {
		const msg: AssistantMessage = {
			...assistantWithThinking("my reasoning", "sig1"),
			stopReason: "aborted",
		};
		const messages: Message[] = [msg];
		const model = makeModel<"anthropic-messages">({ api: "anthropic-messages" });

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;
		const thinking = content.find(b => b.type === "thinking");

		// Thinking should be preserved but signature stripped (aborted = invalid)
		expect(thinking).toBeDefined();
		expect((thinking as any).thinkingSignature).toBeUndefined();
	});
});

describe("transformMessages — official API detection", () => {
	it("converts thinking to text for Anthropic official API", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: true,
			baseUrl: "https://api.anthropic.com/v1",
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Official API should convert to text (old behavior)
		expect(content.some(b => b.type === "thinking")).toBe(false);
		expect(content.some(b => b.type === "text" && b.text === "my reasoning")).toBe(true);
	});

	it("converts thinking to text for OpenAI official API", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: true,
			baseUrl: "https://api.openai.com/v1",
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Official API should convert to text (old behavior)
		expect(content.some(b => b.type === "thinking")).toBe(false);
		expect(content.some(b => b.type === "text" && b.text === "my reasoning")).toBe(true);
	});

	it("preserves thinking for non-official API with reasoning: true", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: true,
			baseUrl: "https://api.minimax.chat/v1",
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Non-official API with reasoning should preserve
		const thinking = content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect((thinking as any).thinking).toBe("my reasoning");
	});
});

describe("transformMessages — interleaved: false opt-out", () => {
	it("converts thinking to text when interleaved: false on reasoning model", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: true,
			compat: { interleaved: false },
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// interleaved: false should convert to text
		expect(content.some(b => b.type === "thinking")).toBe(false);
		expect(content.some(b => b.type === "text" && b.text === "my reasoning")).toBe(true);
	});

	it("preserves thinking when interleaved is undefined (default for reasoning)", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: true,
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Default (undefined) should preserve for reasoning models
		const thinking = content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
	});

	it("interleaved: false has no effect on non-reasoning model", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: false,
			compat: { interleaved: false },
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// Non-reasoning model always converts to text regardless of interleaved
		expect(content.some(b => b.type === "thinking")).toBe(false);
		expect(content.some(b => b.type === "text" && b.text === "my reasoning")).toBe(true);
	});
});

describe("transformMessages — legacy_style safety valve", () => {
	it("converts thinking to text when legacy_style: true", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: true,
			compat: { legacy_style: true },
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// legacy_style should force old behavior
		expect(content.some(b => b.type === "thinking")).toBe(false);
		expect(content.some(b => b.type === "text" && b.text === "my reasoning")).toBe(true);
	});

	it("legacy_style overrides interleaved: true", () => {
		const messages: Message[] = [assistantWithThinking("my reasoning", "sig1")];
		const model = makeModel<"openai-completions">({
			api: "openai-completions",
			reasoning: true,
			compat: { interleaved: true, legacy_style: true },
		});

		const result = transformMessages(messages, model);
		const content = (result[0] as AssistantMessage).content;

		// legacy_style should take precedence
		expect(content.some(b => b.type === "thinking")).toBe(false);
		expect(content.some(b => b.type === "text" && b.text === "my reasoning")).toBe(true);
	});
});

describe("transformMessages — mid-session model switch", () => {});

describe("transformMessages — mid-session model switch", () => {
	function multiTurnHistory(): Message[] {
		return [
			{ role: "user", content: "What is the weather in SF?" } as Message,
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "I need to call the weather tool for SF.",
						thinkingSignature: "anthropic-sig-v1",
					},
					{
						type: "toolCall",
						id: "call_1",
						name: "get_weather",
						arguments: { location: "San Francisco" },
						customWireName: "get_weather",
						toolArguments: '{"location":"San Francisco"}',
						toolDefinition: { name: "get_weather" },
					},
				],
				provider: "anthropic-provider",
				api: "anthropic-messages",
				model: "claude-sonnet-4-20250514",
				stopReason: "toolUse",
				timestamp: 1000,
			} as AssistantMessage,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "get_weather",
				content: [{ type: "text", text: "24°C, sunny" }],
				isError: false,
				timestamp: 1000,
			} as Message,
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "The tool returned 24°C sunny. I should present this clearly.",
						thinkingSignature: "anthropic-sig-v2",
					},
					{ type: "text", text: "The weather in SF is 24°C and sunny." },
				],
				provider: "anthropic-provider",
				api: "anthropic-messages",
				model: "claude-sonnet-4-20250514",
				stopReason: "stop",
				timestamp: 2000,
				usage: dummyUsage,
			} as AssistantMessage,
			{ role: "user", content: "What about tomorrow?" } as Message,
		];
	}
	it("preserves all thinking blocks when switching to MiniMax (reasoning: true)", () => {
		const messages = multiTurnHistory();
		const minimaxModel = makeModel<"openai-completions">({
			id: "MiniMax-M3",
			provider: "minimax-china",
			api: "openai-completions",
			reasoning: true,
		});
		const result = transformMessages(messages, minimaxModel);
		const assistant1 = result[1] as AssistantMessage;
		const assistant2 = result[3] as AssistantMessage;
		const thinking1 = assistant1.content.find(b => b.type === "thinking");
		const thinking2 = assistant2.content.find(b => b.type === "thinking");
		expect(thinking1).toBeDefined();
		expect((thinking1 as any).thinking).toBe("I need to call the weather tool for SF.");
		expect((thinking1 as any).thinkingSignature).toBe("anthropic-sig-v1");
		expect(thinking2).toBeDefined();
		expect((thinking2 as any).thinking).toBe("The tool returned 24°C sunny. I should present this clearly.");
		expect((thinking2 as any).thinkingSignature).toBe("anthropic-sig-v2");
	});
	it("preserves all thinking blocks when switching to another Anthropic model", () => {
		const messages = multiTurnHistory();
		const geminiModel = makeModel<"anthropic-messages">({
			id: "gemini-2.5-pro",
			provider: "google",
			api: "anthropic-messages",
		});
		const result = transformMessages(messages, geminiModel);
		const assistant1 = result[1] as AssistantMessage;
		const assistant2 = result[3] as AssistantMessage;
		const thinking1 = assistant1.content.find(b => b.type === "thinking");
		const thinking2 = assistant2.content.find(b => b.type === "thinking");
		expect(thinking1).toBeDefined();
		expect((thinking1 as any).thinkingSignature).toBe("anthropic-sig-v1");
		expect(thinking2).toBeDefined();
		expect((thinking2 as any).thinkingSignature).toBe("anthropic-sig-v2");
	});
	it("converts all thinking to text when switching to plain OpenAI-compat model", () => {
		const messages = multiTurnHistory();
		const plainModel = makeModel<"openai-completions">({
			id: "gpt-4o",
			provider: "openai",
			api: "openai-completions",
		});
		const result = transformMessages(messages, plainModel);
		const assistant1 = result[1] as AssistantMessage;
		const assistant2 = result[3] as AssistantMessage;
		expect(assistant1.content.some(b => b.type === "thinking")).toBe(false);
		expect(
			assistant1.content.some(b => b.type === "text" && b.text.includes("I need to call the weather tool")),
		).toBe(true);
		expect(assistant2.content.some(b => b.type === "thinking")).toBe(false);
		expect(assistant2.content.some(b => b.type === "text" && b.text.includes("The tool returned 24°C"))).toBe(true);
	});
	it("preserves tool calls alongside thinking blocks for MiniMax target", () => {
		const messages = multiTurnHistory();
		const minimaxModel = makeModel<"openai-completions">({
			id: "MiniMax-M3",
			provider: "minimax-china",
			api: "openai-completions",
			reasoning: true,
		});
		const result = transformMessages(messages, minimaxModel);
		const assistant1 = result[1] as AssistantMessage;
		expect(assistant1.content.find(b => b.type === "toolCall")?.name).toBe("get_weather");
		expect(assistant1.content.some(b => b.type === "toolCall")).toBe(true);
		expect(assistant1.content.some(b => b.type === "thinking")).toBe(true);
	});
	it("handles mixed provider history (Anthropic → MiniMax → Anthropic)", () => {
		const messages: Message[] = [
			{ role: "user", content: "Hello" } as Message,
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Claude thinking v1", thinkingSignature: "claude-sig" },
					{ type: "text", text: "Hi!" },
				],
				provider: "anthropic-provider",
				api: "anthropic-messages",
				model: "claude-sonnet-4-20250514",
				stopReason: "stop",
				timestamp: 1000,
				usage: dummyUsage,
			} as AssistantMessage,
			{ role: "user", content: "Follow up" } as Message,
			{
				role: "assistant",
				content: [{ type: "text", text: "<think>\nMiniMax thinking\n</think>\nMiniMax response" }],
				provider: "minimax-china",
				api: "openai-completions",
				model: "MiniMax-M3",
				stopReason: "stop",
				timestamp: 2000,
				usage: dummyUsage,
			} as AssistantMessage,
			{ role: "user", content: "Another follow up" } as Message,
		];
		const claudeModel = makeModel<"anthropic-messages">({
			id: "claude-sonnet-4-20250514",
			provider: "anthropic-provider",
			api: "anthropic-messages",
		});
		const result = transformMessages(messages, claudeModel);
		const assistant1 = result[1] as AssistantMessage;
		const thinking = assistant1.content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect((thinking as any).thinking).toBe("Claude thinking v1");
		expect((thinking as any).thinkingSignature).toBe("claude-sig");
	});
});
describe("transformMessages — mixed reasoning providers", () => {
	function minimaxAssistant(thinking: string): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking, thinkingSignature: "reasoning_content" },
				{ type: "text", text: "response from minimax" },
			],
			provider: "minimax-china",
			api: "openai-completions",
			model: "MiniMax-M3",
			stopReason: "stop",
			timestamp: 1000,
			usage: dummyUsage,
		};
	}
	function deepseekAssistant(thinking: string): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking, thinkingSignature: "reasoning_content" },
				{ type: "text", text: "response from deepseek" },
			],
			provider: "deepseek",
			api: "openai-completions",
			model: "deepseek-r1",
			stopReason: "stop",
			timestamp: 1000,
			usage: dummyUsage,
		};
	}
	function anthropicAssistant(thinking: string): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking, thinkingSignature: "claude-sig" },
				{ type: "text", text: "response from claude" },
			],
			provider: "anthropic-provider",
			api: "anthropic-messages",
			model: "claude-sonnet-4-20250514",
			stopReason: "stop",
			timestamp: 1000,
			usage: dummyUsage,
		};
	}
	it("MiniMax thinking preserved when switching to Anthropic", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello" } as Message,
			minimaxAssistant("MiniMax reasoned about this"),
			{ role: "user", content: "follow up" } as Message,
		];
		const result = transformMessages(
			messages,
			makeModel<"anthropic-messages">({
				id: "claude-sonnet-4-20250514",
				api: "anthropic-messages",
			}),
		);
		const assistant = result[1] as AssistantMessage;
		const thinking = assistant.content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect((thinking as any).thinking).toBe("MiniMax reasoned about this");
		expect((thinking as any).thinkingSignature).toBe("reasoning_content");
	});
	it("DeepSeek thinking preserved when switching to MiniMax (reasoning: true)", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello" } as Message,
			deepseekAssistant("DeepSeek chain of thought"),
			{ role: "user", content: "follow up" } as Message,
		];
		const result = transformMessages(
			messages,
			makeModel<"openai-completions">({
				id: "MiniMax-M3",
				api: "openai-completions",
				reasoning: true,
			}),
		);
		const assistant = result[1] as AssistantMessage;
		const thinking = assistant.content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect((thinking as any).thinking).toBe("DeepSeek chain of thought");
	});
	it("Anthropic thinking preserved when switching to DeepSeek (reasoning: true)", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello" } as Message,
			anthropicAssistant("Claude reasoned about this"),
			{ role: "user", content: "follow up" } as Message,
		];
		const result = transformMessages(
			messages,
			makeModel<"openai-completions">({
				id: "deepseek-r1",
				api: "openai-completions",
				reasoning: true,
			}),
		);
		const assistant = result[1] as AssistantMessage;
		const thinking = assistant.content.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect((thinking as any).thinking).toBe("Claude reasoned about this");
		expect((thinking as any).thinkingSignature).toBe("claude-sig");
	});
	it("Anthropic → DeepSeek → MiniMax: all thinking blocks preserved", () => {
		const messages: Message[] = [
			{ role: "user", content: "q1" } as Message,
			anthropicAssistant("Claude thought v1"),
			{ role: "user", content: "q2" } as Message,
			deepseekAssistant("DeepSeek thought"),
			{ role: "user", content: "q3" } as Message,
		];
		// Now switching to MiniMax — all thinking blocks should be preserved
		const result = transformMessages(
			messages,
			makeModel<"openai-completions">({
				id: "MiniMax-M3",
				api: "openai-completions",
				reasoning: true,
			}),
		);
		const a1 = result[1] as AssistantMessage;
		const a2 = result[3] as AssistantMessage;
		expect(a1.content.find(b => b.type === "thinking")).toBeDefined();
		expect((a1.content.find(b => b.type === "thinking") as any).thinking).toBe("Claude thought v1");
		expect(a2.content.find(b => b.type === "thinking")).toBeDefined();
		expect((a2.content.find(b => b.type === "thinking") as any).thinking).toBe("DeepSeek thought");
	});
	it("MiniMax → Claude → DeepSeek: all thinking blocks preserved", () => {
		const messages: Message[] = [
			{ role: "user", content: "q1" } as Message,
			minimaxAssistant("MiniMax thought"),
			{ role: "user", content: "q2" } as Message,
			anthropicAssistant("Claude thought"),
			{ role: "user", content: "q3" } as Message,
		];
		// Switching to DeepSeek with reasoning: true
		const result = transformMessages(
			messages,
			makeModel<"openai-completions">({
				id: "deepseek-r1",
				api: "openai-completions",
				reasoning: true,
			}),
		);
		const a1 = result[1] as AssistantMessage;
		const a2 = result[3] as AssistantMessage;
		expect(a1.content.find(b => b.type === "thinking")).toBeDefined();
		expect((a1.content.find(b => b.type === "thinking") as any).thinking).toBe("MiniMax thought");
		expect(a2.content.find(b => b.type === "thinking")).toBeDefined();
		expect((a2.content.find(b => b.type === "thinking") as any).thinking).toBe("Claude thought");
	});
	it("MiniMax thinking converted to text when switching to plain model", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello" } as Message,
			minimaxAssistant("MiniMax reasoning"),
			{ role: "user", content: "follow up" } as Message,
		];
		const result = transformMessages(
			messages,
			makeModel<"openai-completions">({
				id: "gpt-4o",
				api: "openai-completions",
				// no reasoning: true
			}),
		);
		const assistant = result[1] as AssistantMessage;
		expect(assistant.content.some(b => b.type === "thinking")).toBe(false);
		expect(assistant.content.some(b => b.type === "text" && b.text.includes("MiniMax reasoning"))).toBe(true);
	});
	it("DeepSeek thinking converted to text when switching to plain model", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello" } as Message,
			deepseekAssistant("DeepSeek chain of thought"),
			{ role: "user", content: "follow up" } as Message,
		];
		const result = transformMessages(
			messages,
			makeModel<"openai-completions">({
				id: "gpt-4o",
				api: "openai-completions",
			}),
		);
		const assistant = result[1] as AssistantMessage;
		expect(assistant.content.some(b => b.type === "thinking")).toBe(false);
		expect(assistant.content.some(b => b.type === "text" && b.text.includes("DeepSeek chain of thought"))).toBe(true);
	});
});
