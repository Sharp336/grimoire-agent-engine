import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import {
	applySupercompactRegions,
	collectSupercompactRegions,
	type SupercompactRegion,
} from "@oh-my-pi/pi-agent-core/compaction/supercompact";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage, Usage, UserMessage } from "@oh-my-pi/pi-ai";

const tokenizer = new Tokenizer();

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function messageEntry(id: string, message: AssistantMessage | ToolResultMessage | UserMessage): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-08-26T00:00:00.000Z", message };
}

function userTurn(id: string, text: string): SessionMessageEntry {
	return messageEntry(id, { role: "user", content: text, timestamp: 0 });
}

function assistantTurn(id: string, content: AssistantMessage["content"]): SessionMessageEntry {
	return messageEntry(id, {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
	});
}

function toolOutcome(toolCallId: string, toolName: string, text: string): SessionMessageEntry {
	const content: TextContent[] = [{ type: "text", text }];
	return messageEntry(`result-${toolCallId}`, {
		role: "toolResult",
		toolCallId,
		toolName,
		content,
		isError: false,
		timestamp: 0,
	});
}

/** Attach the caller's own placeholder to each region, the way the session layer does. */
function supercompact(entries: SessionMessageEntry[], keepRecentTurns = 0) {
	const regions = collectSupercompactRegions(entries, tokenizer, keepRecentTurns);
	const items = regions.map((region: SupercompactRegion) => ({
		region,
		replacement: region.kind === "toolResult" ? "[removed · recover: artifact://7]" : "",
	}));
	return { regions, tally: applySupercompactRegions(items) };
}

describe("supercompact", () => {
	it("keeps the dialogue verbatim and drops results, arguments, and reasoning", () => {
		const fileBody = "export const answer = 42;\n".repeat(400);
		const question = "Why does the build fail on arm64 but pass on x86?";
		const answer = "The native addon is only prebuilt for x86; arm64 falls through to the loader error.";
		const entries = [
			userTurn("u1", question),
			assistantTurn("a1", [
				{ type: "thinking", thinking: "Long private reasoning ".repeat(200) },
				{ type: "text", text: answer },
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "src/answer.ts", content: fileBody } },
			]),
			toolOutcome("c1", "write", "Wrote 400 lines to src/answer.ts"),
		];

		const { tally } = supercompact(entries);

		expect(tally.toolResults).toBe(1);
		expect(tally.toolCalls).toBe(1);
		expect(tally.thinkingBlocks).toBe(1);

		// Dialogue, both directions, untouched.
		expect((entries[0].message as UserMessage).content).toBe(question);
		const assistant = entries[1].message as AssistantMessage;
		const texts = assistant.content.filter((block): block is TextContent => block.type === "text");
		expect(texts).toHaveLength(1);
		expect(texts[0].text).toBe(answer);

		// Reasoning gone, the tool call itself still present.
		expect(assistant.content.some(block => block.type === "thinking")).toBe(false);
		const call = assistant.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(call).toBeDefined();
		expect(call?.id).toBe("c1");
		expect(call?.name).toBe("write");
		// Keys survive so the trace stays readable; the file body does not. A
		// Nothing fabricated is added: arguments stay schema-shaped.
		expect(Object.keys(call?.arguments ?? {})).toEqual(["path", "content"]);
		expect(call?.arguments.path).toBe("src/answer.ts");
		expect(String(call?.arguments.content)).toBe(`<elided ${fileBody.length} chars>`);

		const result = entries[2].message as ToolResultMessage;
		expect((result.content[0] as TextContent).text).toBe("[removed · recover: artifact://7]");
		expect(result.prunedAt).toBeGreaterThan(0);
	});

	it("drops the native replay payload and rawBlock so originals cannot come back", () => {
		const secret = "x".repeat(5000);
		const entries = [
			assistantTurn("a1", [
				{
					type: "toolCall",
					id: "c1",
					name: "bash",
					arguments: { command: secret },
					rawBlock: `<bash>${secret}</bash>`,
				},
			]),
		];
		(entries[0].message as AssistantMessage).providerPayload = {
			type: "openaiResponsesHistory",
			items: [{ type: "function_call", arguments: secret }],
		};

		supercompact(entries);

		const assistant = entries[0].message as AssistantMessage;
		const call = assistant.content[0] as ToolCall;
		expect(call.rawBlock).toBeUndefined();
		expect(assistant.providerPayload).toBeUndefined();
		expect(JSON.stringify(call.arguments)).not.toContain(secret);
	});

	it("holds the argument budget when no single value is oversized", () => {
		// Per-value capping cannot bound these: 400 short keys and a long numeric
		// array are already under the string budget.
		const manyKeys: Record<string, unknown> = { coords: Array.from({ length: 500 }, (_, i) => i) };
		for (let i = 0; i < 400; i++) manyKeys[`k${i}`] = i;
		const entries = [assistantTurn("a1", [{ type: "toolCall", id: "c1", name: "plot", arguments: manyKeys }])];

		supercompact(entries);

		const call = (entries[0].message as AssistantMessage).content[0] as ToolCall;
		expect(JSON.stringify(call.arguments).length).toBeLessThanOrEqual(800);
		expect(Object.keys(call.arguments)).toContain("<elided>");
	});

	it("leaves the last N rounds whole when keepRecentTurns is set", () => {
		const round = (n: number) => [
			userTurn(`u${n}`, `round ${n}`),
			assistantTurn(`a${n}`, [
				{ type: "thinking", thinking: `reasoning ${n} `.repeat(50) },
				{ type: "toolCall", id: `c${n}`, name: "read", arguments: { path: `f${n}.ts`, body: "x".repeat(4000) } },
			]),
			toolOutcome(`c${n}`, "read", `contents ${n} `.repeat(200)),
		];
		const entries = [...round(1), ...round(2), ...round(3)];

		const { tally } = supercompact(entries, 1);

		// Rounds 1 and 2 reduced, round 3 untouched.
		expect(tally.toolResults).toBe(2);
		expect(tally.toolCalls).toBe(2);
		expect(tally.thinkingBlocks).toBe(2);

		const lastAssistant = entries[7].message as AssistantMessage;
		expect(lastAssistant.content.some(block => block.type === "thinking")).toBe(true);
		const lastCall = lastAssistant.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(String(lastCall?.arguments.body)).toHaveLength(4000);
		expect((entries[8].message as ToolResultMessage).prunedAt).toBeUndefined();
	});

	it("removes nothing when keepRecentTurns covers every round", () => {
		const entries = [
			userTurn("u1", "only round"),
			assistantTurn("a1", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }]),
			toolOutcome("c1", "read", "contents ".repeat(200)),
		];

		const { tally } = supercompact(entries, 5);

		expect(tally.toolResults).toBe(0);
		expect((entries[2].message as ToolResultMessage).prunedAt).toBeUndefined();
	});
});
