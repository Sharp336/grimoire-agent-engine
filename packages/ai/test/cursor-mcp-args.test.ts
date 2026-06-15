import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { accumulateArgsText, mergeCompletedMcpArgs, processInteractionUpdate } from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";

// Encode a value the way Cursor sends an MCP arg value: a protobuf Value wrapping a
// string. decodeMcpArgValue runs fromBinary -> toJson -> parseToolArgsJson(string).
const encodeArg = (s: string): Uint8Array =>
	toBinary(ValueSchema, create(ValueSchema, { kind: { case: "stringValue", value: s } }));

function makeState() {
	let toolCall: unknown = null;
	return {
		currentTextBlock: null,
		currentThinkingBlock: null,
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		setTextBlock() {},
		setThinkingBlock() {},
		setToolCall(t: unknown) {
			toolCall = t;
		},
		setFirstTokenTime() {},
	};
}

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("accumulateArgsText", () => {
	it("supersedes with cumulative snapshots", () => {
		expect(accumulateArgsText('{"a":', '{"a":1}')).toBe('{"a":1}');
	});

	it("appends true incremental fragments", () => {
		expect(accumulateArgsText('{"a"', ":1}")).toBe('{"a":1}');
	});

	it("ignores duplicate snapshots", () => {
		expect(accumulateArgsText('{"a":1}', '{"a":1}')).toBe('{"a":1}');
	});

	it("appends prefix-shaped incremental fragments", () => {
		expect(accumulateArgsText('{"tasks":[{"assignment":"A"},', '{"assignment":"B"}]}')).toBe(
			'{"tasks":[{"assignment":"A"},{"assignment":"B"}]}',
		);
	});
});

describe("mergeCompletedMcpArgs", () => {
	it("keeps streamed keys the completion map omits", () => {
		expect(mergeCompletedMcpArgs({ agent: "explore", tasks: [{ assignment: "x" }] }, { agent: "explore" })).toEqual({
			agent: "explore",
			tasks: [{ assignment: "x" }],
		});
	});

	it("does not downgrade a structured value to a string fallback", () => {
		expect(mergeCompletedMcpArgs({ tasks: [{ assignment: "x" }] }, { tasks: "[{trunc" })).toEqual({
			tasks: [{ assignment: "x" }],
		});
	});

	it("returns streamed when decoded is empty/undefined", () => {
		expect(mergeCompletedMcpArgs({ agent: "explore" }, undefined)).toEqual({ agent: "explore" });
		expect(mergeCompletedMcpArgs({ agent: "explore" }, {})).toEqual({ agent: "explore" });
	});

	it("does not pollute Object.prototype via a decoded __proto__ key", () => {
		// JSON.parse keeps `__proto__` as an own data property, mirroring how a decoded
		// provider map could carry the key; the merge must not route it through the setter.
		const hostile = JSON.parse('{"__proto__":{"polluted":true},"agent":"explore"}') as Record<string, unknown>;
		const merged = mergeCompletedMcpArgs({ tasks: [{ assignment: "x" }] }, hostile);
		expect((merged as Record<string, unknown>).polluted).toBeUndefined();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
		expect(merged).toEqual({ tasks: [{ assignment: "x" }], agent: "explore" });
	});
});

describe("processInteractionUpdate — large MCP (task) tool call", () => {
	it("preserves a streamed `tasks` array the completion frame omits", () => {
		const output = makeOutput();
		const state = makeState();
		const events: Array<{ type: string; delta?: string }> = [];
		const stream = {
			push(event: { type: string; delta?: string }) {
				events.push(event);
			},
			end() {},
		};
		const usageState = { sawTokenDelta: false };
		const run = (update: unknown) =>
			processInteractionUpdate(update as never, output, stream as never, state as never, usageState as never);

		run({
			message: {
				case: "toolCallStarted",
				value: {
					callId: "c1",
					toolCall: { mcpToolCall: { args: { toolCallId: "c1", name: "task" } } },
				},
			},
		});

		const full = '{"agent":"explore","context":"shared ctx","tasks":[{"assignment":"A"},{"assignment":"B"}]}';
		// Two cumulative snapshots (large call spanning frames).
		run({ message: { case: "partialToolCall", value: { argsTextDelta: full.slice(0, 30) } } });
		run({ message: { case: "partialToolCall", value: { argsTextDelta: full } } });

		// Completion frame carries only the scalars; `tasks` exceeded Cursor's structured-map budget.
		run({
			message: {
				case: "toolCallCompleted",
				value: {
					callId: "c1",
					toolCall: {
						mcpToolCall: {
							args: { args: { agent: encodeArg("explore"), context: encodeArg("shared ctx") } },
						},
					},
				},
			},
		});

		const call = output.content.find(b => b.type === "toolCall") as
			| { name: string; arguments: Record<string, unknown> }
			| undefined;
		expect(call).toBeDefined();
		expect(call?.name).toBe("task");
		expect(Array.isArray(call?.arguments.tasks)).toBe(true);
		expect(call?.arguments.tasks).toHaveLength(2);
		expect(call?.arguments.agent).toBe("explore");
		expect(call?.arguments.context).toBe("shared ctx");
		expect(events.filter(event => event.type === "toolcall_delta").map(event => event.delta)).toEqual([
			full.slice(0, 30),
			full.slice(30),
		]);
	});

	it("preserves the streamed `tasks` array when the completion frame downgrades it to a string", () => {
		const output = makeOutput();
		const state = makeState();
		const stream = { push() {}, end() {} };
		const usageState = { sawTokenDelta: false };
		const run = (update: unknown) =>
			processInteractionUpdate(update as never, output, stream as never, state as never, usageState as never);

		run({
			message: {
				case: "toolCallStarted",
				value: { callId: "c2", toolCall: { mcpToolCall: { args: { toolCallId: "c2", name: "task" } } } },
			},
		});
		const full = '{"agent":"explore","tasks":[{"assignment":"A"},{"assignment":"B"}]}';
		run({ message: { case: "partialToolCall", value: { argsTextDelta: full } } });
		// `tasks` decodes to a truncated raw string (decodeMcpArgValue's TextDecoder fallback);
		// the merge must keep the streamed array rather than downgrade it to that string.
		run({
			message: {
				case: "toolCallCompleted",
				value: {
					callId: "c2",
					toolCall: {
						mcpToolCall: { args: { args: { agent: encodeArg("explore"), tasks: encodeArg("[{trunc") } } },
					},
				},
			},
		});

		const call = output.content.find(b => b.type === "toolCall") as
			| { arguments: Record<string, unknown> }
			| undefined;
		expect(Array.isArray(call?.arguments.tasks)).toBe(true);
		expect(call?.arguments.tasks).toHaveLength(2);
		expect(call?.arguments.agent).toBe("explore");
	});
});
