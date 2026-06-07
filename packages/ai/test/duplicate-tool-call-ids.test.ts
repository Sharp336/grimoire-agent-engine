import { describe, expect, it } from "bun:test";
import { transformMessages } from "../src/providers/transform-messages";
import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../src/types";

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

function toolCall(id: string, name = "bash", args = "{}"): ToolCall {
	return {
		type: "toolCall",
		id,
		name,
		arguments: JSON.parse(args),
		partialArgs: args,
	};
}

function toolResult(id: string, text: string, toolName = "bash"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		usage: dummyUsage,
	};
}

function assistantWithToolCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }, toolCall(id)],
		provider: "test-provider",
		api: "openai-completions",
		model: "test-model",
		usage: dummyUsage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("transformMessages — duplicate tool_call_id handling", () => {
	it("rewrites the second occurrence of a duplicate tool_call_id and matches the tool_result", () => {
		// Reproduces the opencode-go / MiMo 2.5 Pro shape: the model emits the
		// same `functions.eval:301` id for two distinct tool calls. Without
		// dedup, the second call is unfulfilled and MiniMax returns HTTP 400
		// ("tool call result does not follow tool call").
		const messages: Message[] = [
			assistantWithToolCall("functions.eval:301"),
			toolResult("functions.eval:301", "first result"),
			assistantWithToolCall("functions.eval:301"), // duplicate
			toolResult("functions.eval:301", "second result"),
		];

		const out = transformMessages(messages, makeModel());

		// First assistant turn keeps the original id.
		const firstAssistant = out[0] as AssistantMessage;
		expect(firstAssistant.content[1]).toMatchObject({ id: "functions.eval:301" });

		// Second assistant turn is rewritten to a unique id.
		const secondAssistant = out[2] as AssistantMessage;
		const rewrittenId = (secondAssistant.content[1] as ToolCall).id;
		expect(rewrittenId).not.toBe("functions.eval:301");
		expect(rewrittenId).toMatch(/^functions\.eval:301_dup\d+$/);

		// Tool results are updated to match the rewritten id.
		const results = out.filter(m => m.role === "toolResult") as ToolResultMessage[];
		expect(results).toHaveLength(2);
		expect(results[0]!.toolCallId).toBe("functions.eval:301");
		expect(results[1]!.toolCallId).toBe(rewrittenId);
	});

	it("does not rewrite when all tool_call_ids are unique", () => {
		const messages: Message[] = [
			assistantWithToolCall("call_a"),
			toolResult("call_a", "a"),
			assistantWithToolCall("call_b"),
			toolResult("call_b", "b"),
		];

		const out = transformMessages(messages, makeModel());

		const calls = out
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter((b): b is ToolCall => b.type === "toolCall");

		expect(calls.map(c => c.id)).toEqual(["call_a", "call_b"]);
	});

	it("rewrites every duplicate occurrence past the first", () => {
		// Three uses of the same id: first is preserved, second and third each
		// get a distinct `_dupN` suffix.
		const messages: Message[] = [
			assistantWithToolCall("functions.x:1"),
			toolResult("functions.x:1", "r1"),
			assistantWithToolCall("functions.x:1"),
			toolResult("functions.x:1", "r2"),
			assistantWithToolCall("functions.x:1"),
			toolResult("functions.x:1", "r3"),
		];

		const out = transformMessages(messages, makeModel());

		const calls = out
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter((b): b is ToolCall => b.type === "toolCall");

		expect(calls).toHaveLength(3);
		expect(calls[0]!.id).toBe("functions.x:1");
		expect(calls[1]!.id).not.toBe("functions.x:1");
		expect(calls[2]!.id).not.toBe("functions.x:1");
		expect(calls[1]!.id).not.toBe(calls[2]!.id);

		// All three results should be unique ids now.
		const results = out.filter(m => m.role === "toolResult") as ToolResultMessage[];
		expect(new Set(results.map(r => r.toolCallId)).size).toBe(3);
	});

	it("leaves the input array untouched when no duplicates exist", () => {
		const messages: Message[] = [assistantWithToolCall("call_a"), toolResult("call_a", "a")];

		// Smoke check that the function does not mutate the input array.
		const beforeJson = JSON.stringify(messages);
		transformMessages(messages, makeModel());
		expect(JSON.stringify(messages)).toBe(beforeJson);
	});

	it("preserves the call→result pairing for every rewritten id", () => {
		// After dedup, every `tool_call` block must have a `tool_result` with
		// the same id appearing immediately after, otherwise the provider will
		// 400 the request.
		const messages: Message[] = [
			assistantWithToolCall("dup:9"),
			assistantWithToolCall("dup:9"),
			toolResult("dup:9", "second"),
		];

		const out = transformMessages(messages, makeModel());

		// Walk the result and verify every assistant tool_call has a
		// matching tool_result right after it.
		const seen: string[] = [];
		for (const msg of out) {
			if (msg.role === "assistant") {
				for (const block of msg.content) {
					if (block.type === "toolCall") seen.push(block.id);
				}
			}
		}
		expect(seen).toHaveLength(2);
		// First call is the original id; the second is rewritten.
		expect(seen[0]).toBe("dup:9");
		expect(seen[1]).toMatch(/^dup:9_dup\d+$/);
	});
});
