import { describe, expect, it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	type ReadArgs,
	ReadArgsSchema,
	ReadResultSchema,
	ReadSuccessSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { type BlockState, handleServerMessage, type UsageState } from "../src/providers/cursor";
import type { AssistantMessage, CursorExecHandlers } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

describe("Cursor attempt task group & settlement", () => {
	it("passes attempt signal to handleExecServerMessage and exec handlers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const delay = Promise.withResolvers<void>();

		const execHandlers: CursorExecHandlers = {
			async read(_args: ReadArgs, signal?: AbortSignal) {
				receivedSignal = signal;
				await delay.promise;
				return create(ReadResultSchema, {
					result: {
						case: "success",
						value: create(ReadSuccessSchema, {
							path: "test.txt",
							output: { case: "content", value: "content" },
						}),
					},
				});
			},
		};
		const output = {
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
			timestamp: Date.now(),
		} as AssistantMessage;

		const stream = new AssistantMessageEventStream();
		let textBlock = null;
		let thinkingBlock = null;
		let toolCall = null;
		const state: BlockState = {
			currentTextBlock: textBlock,
			currentThinkingBlock: thinkingBlock,
			currentToolCall: toolCall,
			resolvedMcpToolCallIds: new Set<string>(),
			firstTokenTime: undefined,
			setTextBlock: b => {
				textBlock = b;
			},
			setThinkingBlock: b => {
				thinkingBlock = b;
			},
			setToolCall: t => {
				toolCall = t;
			},
			setFirstTokenTime: () => {},
		};

		const execMsg = create(ExecServerMessageSchema, {
			id: 1,
			execId: "exec-1",
			message: {
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "test.txt", toolCallId: "call-1" }),
			},
		});

		const serverMsg = create(AgentServerMessageSchema, {
			message: { case: "execServerMessage", value: execMsg },
		});

		const channel = {
			sendClientBytes: () => {},
		};

		const usageState: UsageState = { sawTokenDelta: false };
		const controller = new AbortController();
		const handlePromise = handleServerMessage(
			serverMsg,
			output,
			stream,
			state,
			new Map(),
			channel,
			execHandlers,
			undefined,
			usageState,
			[],
			undefined,
			controller.signal,
		);

		// Resolve the delay so handler completes
		delay.resolve();
		await handlePromise;

		expect(receivedSignal).toBe(controller.signal);
	});
});
