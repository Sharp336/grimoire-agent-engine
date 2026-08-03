import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type {
	AssistantMessage,
	Context,
	CursorExecHandlers,
	CursorToolResultHandler,
	Model,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	PiBashExecArgsSchema,
	PiEditExecArgsSchema,
	PiEditReplacementSchema,
	PiWriteExecArgsSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	TurnEndedUpdateSchema,
	UpdateTodosArgsSchema,
	UpdateTodosToolCallSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

const CONNECT_END_STREAM_FLAG = 0b00000010;

type Scenario =
	| { kind: "success" }
	| { kind: "connect-error-after-turn" }
	| { kind: "http-rejection" }
	| { kind: "grpc-trailer-after-turn" }
	| { kind: "end-before-turn" }
	| { kind: "hang-after-turn" }
	| { kind: "exec-in-final-chunk"; responseFinished: PromiseWithResolvers<void> }
	| { kind: "exec-then-transport-error"; responseFinished: PromiseWithResolvers<void> }
	| { kind: "exec-then-hang" }
	| { kind: "exec-and-turn" }
	| { kind: "stale-checkpoint-retry"; requests: number }
	| { kind: "pi-exec-retry"; requests: number; piExec: "write" | "bash" | "edit" }
	| {
			kind: "checkpoint-ownership-race";
			requests: number;
			firstStarted: PromiseWithResolvers<void>;
			releaseFirst: PromiseWithResolvers<void>;
			rootPromptMessagesJson?: Uint8Array[];
	  }
	| {
			kind: "checkpoint-overlap-invalidation";
			requests: number;
			olderStarted: PromiseWithResolvers<void>;
			releaseOlderMessage: PromiseWithResolvers<void>;
			releaseOlderEnd: PromiseWithResolvers<void>;
			newerStarted: PromiseWithResolvers<void>;
			releaseNewerEnd: PromiseWithResolvers<void>;
	  }
	| { kind: "todo-start-then-death" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let scenario: Scenario = { kind: "success" };

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "textDelta",
					value: create(TextDeltaUpdateSchema, { text }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function connectEndErrorFrame(code: string, message: string): Buffer {
	const payload = Buffer.from(JSON.stringify({ error: { code, message } }), "utf8");
	return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

/**
 * A `read` exec request. The provider parses every frame in a chunk
 * synchronously and dispatches each `handleServerMessage` fire-and-forget, so
 * pairing this with a terminal frame in ONE chunk leaves the exec handler
 * running while the transport settles.
 */
function execRequestFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-final",
				message: {
					case: "readArgs",
					value: create(ReadArgsSchema, { path: "/tmp/final", toolCallId: "call-final" }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function piExecRequestFrame(kind: "write" | "bash" | "edit"): Buffer {
	const execMessage =
		kind === "write"
			? {
					case: "piWriteArgs" as const,
					value: create(PiWriteExecArgsSchema, { path: "/tmp/replay.txt", content: "once" }),
				}
			: kind === "bash"
				? {
						case: "piBashArgs" as const,
						value: create(PiBashExecArgsSchema, { command: "echo once" }),
					}
				: {
						case: "piEditArgs" as const,
						value: create(PiEditExecArgsSchema, {
							path: "/tmp/replay.txt",
							edits: [create(PiEditReplacementSchema, { oldText: "before", newText: "after" })],
						}),
					};
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 73,
				execId: `stable-pi-${kind}`,
				message: execMessage,
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

/**
 * Exec request + `turnEnded` in one chunk: the clean-completion race. Without a
 * barrier before `done`, the Agent drains its Cursor result buffer first and
 * the call is never paired.
 */
function execAndTurnEndedFrame(): Buffer {
	return Buffer.concat([execRequestFrame(), turnEndedFrame()]);
}

function checkpointFrame(
	pendingToolCalls = [JSON.stringify({ toolCallId: "call-final", toolName: "read" })],
	rootPromptMessagesJson: Uint8Array[] = [],
): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "conversationCheckpointUpdate",
			value: create(ConversationStateStructureSchema, {
				pendingToolCalls,
				rootPromptMessagesJson,
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

/**
 * A native `update_todos` call announcement. Cursor runs these server-side, so
 * the block is stamped resolved at start and only its `toolCallCompleted`
 * frame pairs a result — nothing downstream synthesizes one.
 */
function todoStartFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "toolCallStarted",
					value: create(ToolCallStartedUpdateSchema, {
						callId: "todo-envelope",
						toolCall: create(ToolCallSchema, {
							tool: {
								case: "updateTodosToolCall",
								value: create(UpdateTodosToolCallSchema, {
									args: create(UpdateTodosArgsSchema, { todos: [] }),
								}),
							},
						}),
					}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});

		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}

		if (scenario.kind === "http-rejection") {
			stream.respond({ ":status": 429 });
			stream.end();
			return;
		}

		if (scenario.kind === "checkpoint-overlap-invalidation") {
			scenario.requests++;
			if (scenario.requests === 1) {
				const { olderStarted, releaseOlderMessage, releaseOlderEnd } = scenario;
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				olderStarted.resolve();
				void releaseOlderMessage.promise.then(() => {
					stream.write(textDeltaFrame("older advanced"));
					void releaseOlderEnd.promise.then(() => stream.end());
				});
				return;
			}
			const { newerStarted, releaseNewerEnd } = scenario;
			newerStarted.resolve();
			void releaseNewerEnd.promise.then(() => stream.end());
			return;
		}

		if (scenario.kind === "grpc-trailer-after-turn") {
			stream.respond(
				{
					":status": 200,
					"content-type": "application/connect+proto",
				},
				{ waitForTrailers: true },
			);
			stream.on("wantTrailers", () => {
				stream.sendTrailers({
					"grpc-status": "13",
					"grpc-message": encodeURIComponent("post-turn trailer failure"),
				});
			});
			stream.write(textDeltaFrame("hello"));
			stream.write(turnEndedFrame());
			stream.end();
			return;
		}

		stream.respond({
			":status": 200,
			"content-type": "application/connect+proto",
		});

		if (scenario.kind === "end-before-turn") {
			stream.write(textDeltaFrame("partial"));
			stream.end();
			return;
		}

		if (scenario.kind === "todo-start-then-death") {
			// The server announces a native todo call, then the stream dies
			// without `turnEnded` and without the call's completion frame. This
			// is the real interrupted-call shape: `settleH2` rejects, so the
			// success-path flush never runs.
			stream.write(todoStartFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "exec-in-final-chunk") {
			const { responseFinished } = scenario;
			// Resolves once the server has flushed the whole response, so the test
			// never guesses at timing.
			stream.on("finish", () => responseFinished.resolve());
			stream.write(execAndTurnEndedFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "exec-then-transport-error") {
			const { responseFinished } = scenario;
			stream.on("finish", () => responseFinished.resolve());
			// The exec request and the failure land in ONE chunk: the handler is
			// dispatched fire-and-forget and is still running when the transport
			// rejects. `turnEnded` is deliberately absent — this is the turn dying,
			// not ending.
			stream.write(
				Buffer.concat([execRequestFrame(), connectEndErrorFrame("unavailable", "mid-exec transport failure")]),
			);
			stream.end();
			return;
		}

		if (scenario.kind === "exec-then-hang") {
			// Exec request, then the stream stays open: the only way this turn
			// ends is the client aborting.
			stream.write(execRequestFrame());
			return;
		}

		if (scenario.kind === "exec-and-turn") {
			stream.write(execAndTurnEndedFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "stale-checkpoint-retry") {
			scenario.requests++;
			if (scenario.requests === 1) {
				stream.write(Buffer.concat([checkpointFrame(), execRequestFrame()]));
				stream.end();
				return;
			}
			stream.write(execAndTurnEndedFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "pi-exec-retry") {
			scenario.requests++;
			stream.write(piExecRequestFrame(scenario.piExec));
			if (scenario.requests > 1) stream.write(turnEndedFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "checkpoint-ownership-race") {
			scenario.requests++;
			if (scenario.requests === 1) {
				const { firstStarted, releaseFirst } = scenario;
				firstStarted.resolve();
				void releaseFirst.promise.then(() => stream.end());
				return;
			}
			if (scenario.requests === 2) {
				stream.write(
					checkpointFrame(
						[JSON.stringify({ toolCallId: "newer-call", toolName: "read" })],
						scenario.rootPromptMessagesJson,
					),
				);
			}
			stream.write(Buffer.concat([textDeltaFrame("newer"), turnEndedFrame()]));
			stream.end();
			return;
		}

		stream.write(Buffer.concat([textDeltaFrame("hello"), turnEndedFrame()]));

		if (scenario.kind === "connect-error-after-turn") {
			stream.write(connectEndErrorFrame("unavailable", "post-turn connect failure"));
			stream.end();
			return;
		}

		if (scenario.kind === "hang-after-turn") {
			return;
		}

		stream.end();
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	return `http://127.0.0.1:${address.port}`;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-terminal-fixture",
		name: "Cursor terminal fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "terminal lifecycle", timestamp: 1 }],
};

function completedCursorToolHistory(toolName: string, details?: unknown): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-final", name: toolName, arguments: {} }],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-terminal-fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: 2,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-final",
		toolName,
		content: [{ type: "text", text: "prior result" }],
		details,
		isError: false,
		timestamp: 3,
	};
	return { messages: [...context.messages, assistant, result] };
}

async function collectStream(
	model: Model<"cursor-agent">,
	options?: { signal?: AbortSignal; onToolResult?: CursorToolResultHandler },
) {
	const stream = streamCursor(model, context, {
		apiKey: "test-token",
		signal: options?.signal,
		onToolResult: options?.onToolResult,
	});
	const eventTypes: string[] = [];
	for await (const event of stream) {
		eventTypes.push(event.type);
	}
	const result = await stream.result();
	return { eventTypes, result };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) {
		session.destroy();
	}
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => {
		if (error) {
			closed.reject(error);
		} else {
			closed.resolve();
		}
	});
	await closed.promise;
}

afterEach(async () => {
	scenario = { kind: "success" };
	await stopServer();
});

describe("Cursor terminal lifecycle after turnEnded", () => {
	it("emits done only after turnEnded and a clean protocol end", async () => {
		scenario = { kind: "success" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("surfaces CONNECT end-stream errors that arrive after turnEnded", async () => {
		scenario = { kind: "connect-error-after-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connect error unavailable: post-turn connect failure");
	});

	it("surfaces nonzero gRPC trailers that arrive after turnEnded", async () => {
		scenario = { kind: "grpc-trailer-after-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("gRPC error 13: post-turn trailer failure");
	});

	it("rejects when the stream ends before turnEnded", async () => {
		scenario = { kind: "end-before-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cursor stream ended before turnEnded");
	});

	it("pairs and closes a server-owned call the dying stream left open", async () => {
		// The failure this guards: a native todo block is stamped resolved at
		// start, so `agent-loop.ts` synthesizes no placeholder for it and only
		// its completion frame pairs a result. When the transport dies first the
		// call went unpaired and its card stayed animating — and
		// `buildSessionContext` strips a dangling call, so the interaction
		// vanished from every rebuilt transcript.
		//
		// This must run against the real terminal-error path: `settleH2` rejects
		// on a stream that ends before `turnEnded`, so the success path's flush
		// is never reached.
		scenario = { kind: "todo-start-then-death" };
		const baseUrl = await startServer();
		const paired: ToolResultMessage[] = [];
		const { eventTypes, result } = await collectStream(makeModel(baseUrl), {
			onToolResult: toolResult => void paired.push(toolResult),
		});

		expect(eventTypes.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");

		const call = result.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("expected the announced todo call in the output");
		// Closed, so no live card is left animating.
		expect(eventTypes).toContain("toolcall_end");
		// Paired, so replay keeps the interaction.
		expect(paired).toHaveLength(1);
		expect(paired[0].toolCallId).toBe(call.id);
		expect(paired[0].isError).toBe(true);
	});

	it("aborts without emitting done when the signal fires", async () => {
		scenario = { kind: "hang-after-turn" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			signal: controller.signal,
		});
		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
			if (event.type === "text_delta") controller.abort();
		}
		const result = await stream.result();
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("aborted");
	});

	it("waits for an exec handler decoded from the final chunk before done", async () => {
		// The provider dispatches every decoded message fire-and-forget so the
		// socket keeps draining. When the exec request, `turnEnded` and the close
		// arrive in ONE chunk, the transport completes while the handler is still
		// running. `done` must not be pushed first: the Agent drains its Cursor
		// result buffer on the terminal event, so a result reserved afterwards
		// misses the drain and the synthesized (already resolved) toolCall block
		// is stripped from every rebuilt transcript as dangling.
		//
		// No wall-clock delay. The handler is released only after the server has
		// flushed its whole response AND the handler is known to be running, so
		// the transport has genuinely completed while the handler is in flight.
		const responseFinished = Promise.withResolvers<void>();
		scenario = { kind: "exec-in-final-chunk", responseFinished };
		const baseUrl = await startServer();
		const paired: string[] = [];
		const handlerStarted = Promise.withResolvers<void>();
		const handlerDone = Promise.withResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			execHandlers: {
				async read() {
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: result => {
				paired.push(result.toolCallId);
				return result;
			},
		});

		const gate = (async () => {
			await Promise.all([handlerStarted.promise, responseFinished.promise]);
			// `finish` means the server flushed its bytes, not that the client has
			// processed the end. Yield so the client's `end` handler and every
			// queued continuation run first: a provider that does not await the
			// handler settles the stream in exactly that window.
			await Bun.sleep(0);
			try {
				expect(stream.resultSettled).toBe(false);
				expect(paired).toEqual([]);
			} finally {
				// Always release: a failing assertion here must surface as that
				// failure, not as a hung `for await` that waits for a handler
				// nobody will ever unblock.
				handlerDone.resolve();
			}
		})();

		const eventTypes: string[] = [];
		for await (const event of stream) {
			// The result must already be paired by the time `done` is observed.
			if (event.type === "done") expect(paired).toEqual(["call-final"]);
			eventTypes.push(event.type);
		}
		await gate;

		expect(eventTypes).toContain("done");
		expect(paired).toEqual(["call-final"]);
	});

	it("waits for an in-flight exec handler before emitting the transport error", async () => {
		// Same race as above, but the turn DIES instead of ending: the exec request
		// and the transport failure arrive in one chunk. The Agent finalizes the
		// synthesized call from the terminal error and clears its Cursor result
		// buffer, so a handler still running would land its real result after
		// `agent_end` and have it discarded — even though the tool may already
		// have performed side effects. The error must not be pushed first.
		const responseFinished = Promise.withResolvers<void>();
		scenario = { kind: "exec-then-transport-error", responseFinished };
		const baseUrl = await startServer();
		const paired: string[] = [];
		const handlerStarted = Promise.withResolvers<void>();
		const handlerDone = Promise.withResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			execHandlers: {
				async read() {
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: result => {
				paired.push(result.toolCallId);
				return result;
			},
		});

		const gate = (async () => {
			await Promise.all([handlerStarted.promise, responseFinished.promise]);
			await Bun.sleep(0);
			try {
				expect(stream.resultSettled).toBe(false);
				expect(paired).toEqual([]);
			} finally {
				handlerDone.resolve();
			}
		})();

		const eventTypes: string[] = [];
		for await (const event of stream) {
			// The handler's result must already exist by the time the terminal
			// error is observed — that is the event the Agent drains on.
			if (event.type === "error") expect(paired).toEqual(["call-final"]);
			eventTypes.push(event.type);
		}
		await gate;
		const result = await stream.result();

		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.errorMessage).toContain("mid-exec transport failure");
		expect(paired).toEqual(["call-final"]);
	});

	it("drops stale pending calls and replays a completed result without executing the tool twice", async () => {
		scenario = { kind: "stale-checkpoint-retry", requests: 0 };
		const baseUrl = await startServer();
		const model = makeModel(baseUrl);
		const conversationId = "cursor-stale-checkpoint";
		const payloadPendingCalls: string[][] = [];
		const paired: ToolResultMessage[] = [];
		let executions = 0;
		const execHandlers = {
			async read() {
				executions++;
				return {
					role: "toolResult" as const,
					toolCallId: "call-final",
					toolName: "read",
					content: [{ type: "text" as const, text: "file body" }],
					isError: false,
					timestamp: 1,
				};
			},
		};
		const capturePayload = (payload: unknown) => {
			const request = payload as { conversationState?: { pendingToolCalls?: string[] } };
			payloadPendingCalls.push(request.conversationState?.pendingToolCalls ?? []);
		};

		const first = streamCursor(model, context, {
			apiKey: "test-token",
			conversationId,
			execHandlers,
			onPayload: capturePayload,
			onToolResult: result => {
				paired.push(result);
				return result;
			},
		});
		for await (const _event of first) {
			// Drain the terminal error.
		}
		const interrupted = await first.result();
		expect(interrupted.stopReason).toBe("error");
		expect(executions).toBe(1);
		expect(paired).toHaveLength(1);

		const retryContext: Context = {
			messages: [...context.messages, interrupted, paired[0]],
		};
		const replayedResults: ToolResultMessage[] = [];
		const retry = streamCursor(model, retryContext, {
			apiKey: "test-token",
			conversationId,
			execHandlers,
			onPayload: capturePayload,
			onToolResult: result => {
				replayedResults.push(result);
				return result;
			},
		});
		for await (const _event of retry) {
			// Drain the successful retry.
		}
		const recovered = await retry.result();

		expect(recovered.stopReason).toBe("stop");
		expect(payloadPendingCalls).toEqual([[], []]);
		expect(executions).toBe(1);
		expect(replayedResults).toEqual([]);
		expect(recovered.content.some(block => block.type === "toolCall" && block.id === "call-final")).toBe(false);
	});

	it("does not let an older failed request delete a newer checkpoint", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		scenario = { kind: "checkpoint-ownership-race", requests: 0, firstStarted, releaseFirst };
		const baseUrl = await startServer();
		const model = makeModel(baseUrl);
		const conversationId = "cursor-checkpoint-ownership";

		const first = streamCursor(model, context, { apiKey: "test-token", conversationId });
		const firstDone = (async () => {
			for await (const _event of first) {
				// Drain after the fixture releases this older request.
			}
			return await first.result();
		})();
		await firstStarted.promise;

		const second = streamCursor(model, context, {
			apiKey: "test-token",
			conversationId,
			onPayload: payload => {
				const request = payload as { conversationState?: { rootPromptMessagesJson?: Uint8Array[] } };
				if (scenario.kind === "checkpoint-ownership-race") {
					scenario.rootPromptMessagesJson = request.conversationState?.rootPromptMessagesJson;
				}
			},
		});
		for await (const _event of second) {
			// The newer request writes and owns its checkpoint.
		}
		expect((await second.result()).stopReason).toBe("stop");

		releaseFirst.resolve();
		expect((await firstDone).stopReason).toBe("error");

		let thirdPendingCalls: string[] | undefined;
		const third = streamCursor(model, context, {
			apiKey: "test-token",
			conversationId,
			onPayload: payload => {
				const request = payload as { conversationState?: { pendingToolCalls?: string[] } };
				thirdPendingCalls = request.conversationState?.pendingToolCalls;
			},
		});
		for await (const _event of third) {
			// Drain the verification request.
		}
		expect((await third.result()).stopReason).toBe("stop");
		expect(thirdPendingCalls).toEqual([JSON.stringify({ toolCallId: "newer-call", toolName: "read" })]);
	});

	it("preserves the previous checkpoint when a retry fails before a server response", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		scenario = { kind: "checkpoint-ownership-race", requests: 0, firstStarted, releaseFirst };
		const baseUrl = await startServer();
		const conversationId = "cursor-pre-response-checkpoint";
		const model = makeModel(baseUrl);

		const older = streamCursor(model, context, { apiKey: "test-token", conversationId });
		const olderDone = (async () => {
			for await (const _event of older) {
				// Drain after the fixture releases this older request.
			}
			return await older.result();
		})();
		await firstStarted.promise;

		const seed = streamCursor(model, context, {
			apiKey: "test-token",
			conversationId,
			onPayload: payload => {
				const request = payload as { conversationState?: { rootPromptMessagesJson?: Uint8Array[] } };
				if (scenario.kind === "checkpoint-ownership-race") {
					scenario.rootPromptMessagesJson = request.conversationState?.rootPromptMessagesJson;
				}
			},
		});
		for await (const _event of seed) {
			// Seed a valid server checkpoint owned by the newer request.
		}
		expect((await seed.result()).stopReason).toBe("stop");
		releaseFirst.resolve();
		expect((await olderDone).stopReason).toBe("error");

		await stopServer();
		let failedPendingToolCalls: string[] | undefined;
		const failed = streamCursor(model, context, {
			apiKey: "test-token",
			conversationId,
			onPayload: payload => {
				failedPendingToolCalls = (payload as { conversationState?: { pendingToolCalls?: string[] } })
					.conversationState?.pendingToolCalls;
			},
		});
		for await (const _event of failed) {
			// The closed listener fails before any response headers arrive.
		}
		expect((await failed.result()).stopReason).toBe("error");

		scenario = { kind: "http-rejection" };
		const rejectionBaseUrl = await startServer();
		let rejectedPendingToolCalls: string[] | undefined;
		const rejected = streamCursor(makeModel(rejectionBaseUrl), context, {
			apiKey: "test-token",
			conversationId,
			onPayload: payload => {
				rejectedPendingToolCalls = (payload as { conversationState?: { pendingToolCalls?: string[] } })
					.conversationState?.pendingToolCalls;
			},
		});
		for await (const _event of rejected) {
			// Rejected response headers are not evidence that Cursor mutated the conversation.
		}
		expect((await rejected.result()).stopReason).toBe("error");

		await stopServer();
		scenario = { kind: "success" };
		const recoveryBaseUrl = await startServer();
		let pendingToolCalls: string[] | undefined;
		const recovery = streamCursor(makeModel(recoveryBaseUrl), context, {
			apiKey: "test-token",
			conversationId,
			onPayload: payload => {
				pendingToolCalls = (payload as { conversationState?: { pendingToolCalls?: string[] } }).conversationState
					?.pendingToolCalls;
			},
		});
		for await (const _event of recovery) {
			// Drain the verification request.
		}
		expect((await recovery.result()).stopReason).toBe("stop");
		expect([failedPendingToolCalls, rejectedPendingToolCalls, pendingToolCalls]).toEqual([
			[JSON.stringify({ toolCallId: "newer-call", toolName: "read" })],
			[JSON.stringify({ toolCallId: "newer-call", toolName: "read" })],
			[JSON.stringify({ toolCallId: "newer-call", toolName: "read" })],
		]);
	});

	it("does not restore a checkpoint invalidated by an overlapping request", async () => {
		const seedStarted = Promise.withResolvers<void>();
		const releaseSeed = Promise.withResolvers<void>();
		scenario = {
			kind: "checkpoint-ownership-race",
			requests: 0,
			firstStarted: seedStarted,
			releaseFirst: releaseSeed,
		};
		const baseUrl = await startServer();
		const conversationId = "cursor-overlap-invalidation";
		const model = makeModel(baseUrl);

		const seedOlder = streamCursor(model, context, { apiKey: "test-token", conversationId });
		const seedOlderDone = (async () => {
			for await (const _event of seedOlder) {
				// Drain after the seed request is released.
			}
			return await seedOlder.result();
		})();
		await seedStarted.promise;
		const seed = streamCursor(model, context, {
			apiKey: "test-token",
			conversationId,
			onPayload: payload => {
				const request = payload as { conversationState?: { rootPromptMessagesJson?: Uint8Array[] } };
				if (scenario.kind === "checkpoint-ownership-race") {
					scenario.rootPromptMessagesJson = request.conversationState?.rootPromptMessagesJson;
				}
			},
		});
		for await (const _event of seed) {
			// Seed a checkpoint with one pending call.
		}
		expect((await seed.result()).stopReason).toBe("stop");
		releaseSeed.resolve();
		expect((await seedOlderDone).stopReason).toBe("error");

		const olderStarted = Promise.withResolvers<void>();
		const releaseOlderMessage = Promise.withResolvers<void>();
		const releaseOlderEnd = Promise.withResolvers<void>();
		const newerStarted = Promise.withResolvers<void>();
		const releaseNewerEnd = Promise.withResolvers<void>();
		scenario = {
			kind: "checkpoint-overlap-invalidation",
			requests: 0,
			olderStarted,
			releaseOlderMessage,
			releaseOlderEnd,
			newerStarted,
			releaseNewerEnd,
		};

		const older = streamCursor(model, context, { apiKey: "test-token", conversationId });
		const olderDone = (async () => {
			for await (const _event of older) {
				// Drain after the older overlapping request advances and fails.
			}
			return await older.result();
		})();
		await olderStarted.promise;
		const newer = streamCursor(model, context, { apiKey: "test-token", conversationId });
		const newerDone = (async () => {
			for await (const _event of newer) {
				// Drain after its pre-message failure is released.
			}
			return await newer.result();
		})();
		await newerStarted.promise;

		releaseOlderMessage.resolve();
		releaseOlderEnd.resolve();
		expect((await olderDone).stopReason).toBe("error");
		releaseNewerEnd.resolve();
		expect((await newerDone).stopReason).toBe("error");

		scenario = { kind: "success" };
		let pendingToolCalls: string[] | undefined;
		const verification = streamCursor(model, context, {
			apiKey: "test-token",
			conversationId,
			onPayload: payload => {
				pendingToolCalls = (payload as { conversationState?: { pendingToolCalls?: string[] } }).conversationState
					?.pendingToolCalls;
			},
		});
		for await (const _event of verification) {
			// Drain the verification request.
		}
		expect((await verification.result()).stopReason).toBe("stop");
		expect(pendingToolCalls).toEqual([]);
	});

	it.each(["write", "bash", "edit"] as const)(
		"reuses a stable ID when an interrupted stream repeats an ID-less Pi %s",
		async piExec => {
			scenario = { kind: "pi-exec-retry", requests: 0, piExec };
			const baseUrl = await startServer();
			const model = makeModel(baseUrl);
			const paired: ToolResultMessage[] = [];
			let executions = 0;
			const result = (toolCallId: string, toolName: "write" | "bash" | "edit"): ToolResultMessage => ({
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "executed once" }],
				isError: false,
				timestamp: 1,
			});
			const execHandlers: CursorExecHandlers = {};
			if (piExec === "write") {
				execHandlers.piWrite = async ({ toolCallId }) => {
					executions++;
					return result(toolCallId, "write");
				};
			} else if (piExec === "bash") {
				execHandlers.piBash = async ({ toolCallId }) => {
					executions++;
					return result(toolCallId, "bash");
				};
			} else {
				execHandlers.piEdit = async ({ toolCallId }) => {
					executions++;
					return result(toolCallId, "edit");
				};
			}

			const first = streamCursor(model, context, {
				apiKey: "test-token",
				execHandlers,
				onToolResult: result => {
					paired.push(result);
					return result;
				},
			});
			for await (const _event of first) {
				// Drain the interrupted execution.
			}
			const interrupted = await first.result();
			expect(interrupted.stopReason).toBe("error");
			expect(executions).toBe(1);
			expect(paired).toHaveLength(1);

			const replayedResults: ToolResultMessage[] = [];
			const retry = streamCursor(
				model,
				{ messages: [...context.messages, interrupted, paired[0]] },
				{
					apiKey: "test-token",
					execHandlers,
					onToolResult: result => {
						replayedResults.push(result);
						return result;
					},
				},
			);
			for await (const _event of retry) {
				// Drain the successful replay.
			}
			expect((await retry.result()).stopReason).toBe("stop");
			expect(executions).toBe(1);
			expect(replayedResults).toEqual([]);
		},
	);

	it("executes a repeated call when the prior result says the tool never ran", async () => {
		scenario = { kind: "exec-and-turn" };
		const baseUrl = await startServer();
		let executions = 0;
		const paired: ToolResultMessage[] = [];
		const stream = streamCursor(
			makeModel(baseUrl),
			completedCursorToolHistory("read", { __synthetic: true, executed: false }),
			{
				apiKey: "test-token",
				execHandlers: {
					async read() {
						executions++;
						return {
							role: "toolResult",
							toolCallId: "call-final",
							toolName: "read",
							content: [{ type: "text", text: "executed now" }],
							isError: false,
							timestamp: 4,
						};
					},
				},
				onToolResult: result => {
					paired.push(result);
					return result;
				},
			},
		);
		for await (const _event of stream) {
			// Drain the successful turn.
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(executions).toBe(1);
		expect(paired).toHaveLength(1);
		expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "call-final" }));
	});

	it("rejects a repeated tool-call ID whose tool name changed", async () => {
		scenario = { kind: "exec-and-turn" };
		const baseUrl = await startServer();
		let executions = 0;
		const stream = streamCursor(makeModel(baseUrl), completedCursorToolHistory("write"), {
			apiKey: "test-token",
			execHandlers: {
				async read() {
					executions++;
					throw new Error("must not execute");
				},
			},
		});
		for await (const _event of stream) {
			// Drain the successful protocol turn.
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(executions).toBe(0);
		expect(result.content.some(block => block.type === "toolCall" && block.id === "call-final")).toBe(false);
	});

	it("does not hold the abort hostage to a hung exec handler", async () => {
		// Exec handlers have no cancellation contract — the coding-agent bridge
		// invokes `tool.execute` with no signal — so a hung or long-running tool
		// cannot be interrupted. Once the user aborts, the drain must not wait
		// for it: the Agent finalizes from the abort error and discards late
		// results regardless, so waiting only delays the terminal event the
		// user asked for. Without the abort-bounded drain this test times out
		// with the stream never settling.
		scenario = { kind: "exec-then-hang" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const handlerStarted = Promise.withResolvers<void>();
		const handlerDone = Promise.withResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			signal: controller.signal,
			execHandlers: {
				async read() {
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "late result" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
		});

		const gate = (async () => {
			await handlerStarted.promise;
			controller.abort();
		})();

		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		await gate;
		const result = await stream.result();
		// Released only AFTER the stream settled: reaching this line at all
		// proves the terminal error did not wait for the handler.
		handlerDone.resolve();

		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("aborted");
	});
});
