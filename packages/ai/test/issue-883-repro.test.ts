import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { convertMessages, detectCompat } from "../src/providers/openai-completions";
import type { AssistantMessage, Model } from "../src/types";

function deepseekModel(overrides: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		reasoning: true,
		...overrides,
	};
}

function assistantWithToolCall(model: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Calling a tool." },
			{
				type: "toolCall",
				id: "call_repro_1",
				name: "list_files",
				arguments: { path: "." },
			},
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
}

describe("issue #883 / #810 — DeepSeek V4 reasoning_content tool-call replay", () => {
	it("flags requiresReasoningContentForToolCalls for deepseek-v4-pro on the official endpoint", () => {
		const compat = detectCompat(
			deepseekModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				id: "deepseek-v4-pro",
			}),
		);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	});

	it("flags requiresReasoningContentForToolCalls for deepseek-v4 served by a non-deepseek host (e.g. Deepinfra)", () => {
		const compat = detectCompat(
			deepseekModel({
				provider: "deepinfra",
				baseUrl: "https://api.deepinfra.com/v1/openai",
				id: "deepseek-ai/DeepSeek-V4-Flash",
			}),
		);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	});

	it("does not inject a reasoning_content placeholder for deepseek-v4-pro without captured reasoning", () => {
		const model = deepseekModel({
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			id: "deepseek-v4-pro",
		});
		const compat = detectCompat(model);
		const messages = convertMessages(model, { messages: [assistantWithToolCall(model)] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBeUndefined();
	});

	it("replays exact captured reasoning_content on assistant tool-call turns for DeepSeek", () => {
		const model = deepseekModel({
			provider: "deepinfra",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			id: "deepseek-ai/DeepSeek-V4-Pro",
		});
		const compat = detectCompat(model);
		// Assistant turn whose only replayable content is actual provider reasoning plus a tool call.
		// The provider requires content to be "" (not null) whenever reasoning_content is present.
		const toolOnly: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Inspect the directory before answering.",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "toolCall",
					id: "call_repro_2",
					name: "list_files",
					arguments: { path: "." },
				},
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
		const messages = convertMessages(model, { messages: [toolOnly] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBe("Inspect the directory before answering.");
		expect((assistant as { content: unknown }).content).toBe("");
	});
});
