import { describe, expect, it } from "bun:test";
import { convertMessages } from "../src/providers/openai-completions";
import type { AssistantMessage, Context, Message } from "../src/types";
import type { ResolvedOpenAICompat } from "../src/providers/openai-completions-compat";
const compat: ResolvedOpenAICompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsMultipleSystemMessages: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	supportsToolChoice: true,
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	maxTokensField: "max_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	thinkingKeep: undefined,
	reasoningContentField: "reasoning_details",
	requiresReasoningContentForToolCalls: true,
	allowsSyntheticReasoningContentForToolCalls: true,
	requiresAssistantContentForToolCalls: false,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	extraBody: {},
	interleaved: true,
	legacy_style: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	toolStrictMode: "none",
};

const emptyContext: Context = {
	messages: [],
};

const assistantMessage = (blocks: AssistantMessage["content"] | string): AssistantMessage => ({
	role: "assistant",
	content: Array.isArray(blocks) ? blocks : [{ type: "text", text: blocks }],
	provider: "test-provider",
	api: "openai-completions",
	model: "test-model",
	stopReason: "stop",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	timestamp: 0,
	responseId: undefined,
	providerPayload: undefined,
});

function makeCtx(messages: AssistantMessage[]) {
	return {
		...emptyContext,
		messages: messages as unknown as Message[],
	};
}

const model = {
	id: "test-model",
	name: "Test Model",
	provider: "test-provider",
	api: "openai-completions",
	reasoning: true,
} as any;

describe("convertMessages — wire format for reasoning_details", () => {
	it("converts thinking blocks into reasoning_details array", () => {
		const messages = [
			assistantMessage([
				{ type: "thinking", thinking: "First reasoning step", thinkingSignature: "reasoning_content" },
				{ type: "thinking", thinking: "Second reasoning step", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "final answer" },
			]),
		];
		const result = convertMessages(model, makeCtx(messages), compat);
		const assistant = result[0] as any;
		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.reasoning_details).toBeInstanceOf(Array);
		expect(assistant.reasoning_details).toHaveLength(2);
		expect(assistant.reasoning_details[0]).toMatchObject({
			type: "reasoning.text",
			id: "reasoning-text-1",
			format: "MiniMax-response-v1",
			index: 0,
			text: "First reasoning step",
		});
		expect(assistant.reasoning_details[1]).toMatchObject({
			type: "reasoning.text",
			id: "reasoning-text-2",
			format: "MiniMax-response-v1",
			index: 1,
			text: "Second reasoning step",
		});
	});

	it("does not include reasoning_details when there are no thinking blocks", () => {
		const messages = [assistantMessage("Just plain text")];
		const result = convertMessages(model, makeCtx(messages), compat);
		const assistant = result[0] as any;
		expect(assistant.reasoning_details).toBeUndefined();
		expect(assistant.content).toBe("Just plain text");
	});

	it("filters out empty thinking blocks before building reasoning_details", () => {
		const messages = [
			assistantMessage([
				{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" },
				{ type: "thinking", thinking: "Real reasoning", thinkingSignature: "reasoning_content" },
			]),
		];
		const result = convertMessages(model, makeCtx(messages), compat);
		const assistant = result[0] as any;
		expect(assistant.reasoning_details).toHaveLength(1);
		expect(assistant.reasoning_details[0].text).toBe("Real reasoning");
	});

	it("skips synthetic placeholder for reasoning_details array", () => {
		const compatWithSynthetic = { ...compat, allowsSyntheticReasoningContentForToolCalls: true };
		const messages = [
			assistantMessage([
				{ type: "text", text: "result" },
			]),
		];
		const result = convertMessages(model, makeCtx(messages), compatWithSynthetic);
		const assistant = result[0] as any;
		expect(assistant.reasoning_details).toBeUndefined();
	});
});

describe("convertMessages — wire format for reasoning_content string", () => {
	const stringCompat = {
		...compat,
		reasoningContentField: "reasoning_content" as const,
	};

	it("concatenates thinking blocks into reasoning_content string", () => {
		const messages = [
			assistantMessage([
				{ type: "thinking", thinking: "Step 1", thinkingSignature: "reasoning_content" },
				{ type: "thinking", thinking: "Step 2", thinkingSignature: "reasoning_content" },
			]),
		];
		const result = convertMessages(model, makeCtx(messages), stringCompat);
		const assistant = result[0] as any;
		expect(assistant.reasoning_content).toBe("Step 1\nStep 2");
		expect(assistant.reasoning_details).toBeUndefined();
	});
});

describe("convertMessages — onConverted callback", () => {
	it("fires onConverted with converted messages", () => {
		const messages = [
			assistantMessage([
				{ type: "thinking", thinking: "Step 1", thinkingSignature: "reasoning_content" },
			]),
		];
		let captured: any[] | undefined;
		convertMessages(model, makeCtx(messages), compat, converted => {
			captured = converted;
		});
		expect(captured).toBeDefined();
		expect(captured!.length).toBe(1);
		expect((captured![0] as any).reasoning_details).toHaveLength(1);
	});
});
