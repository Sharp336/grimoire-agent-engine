import { beforeEach, describe, expect, it } from "bun:test";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	Tool,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import type {
	ChatGptWebInvocationRequest,
	ChatGptWebOrchestration,
	ChatGptWebTurnIssue,
} from "../../src/provider/orchestration";
import {
	type ChatGptWebSessionState,
	consumeContinuationResults,
	markContinuationConsumed,
	providerSessionState,
} from "../../src/provider/session";
import { type ChatGptWebTurnRunner, createChatGptWebStream } from "../../src/provider/stream";
import type { ChatGptWebRuntimeAdmission, ChatGptWebRuntimeGate } from "../../src/provider/types";
import type { BrowserHost } from "../../src/runtime/host";

const tool: Tool = {
	name: "local_read",
	customWireName: "read_wire",
	description: "Read a file",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		additionalProperties: false,
	},
};

const selectedModel = {
	id: "high",
	name: "high",
	api: "chatgpt-web",
	provider: "chatgpt-web",
	baseUrl: "chatgpt-web://local",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 256_000,
	maxTokens: 64_000,
	compat: {},
} as Model<Api>;

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Read it", timestamp: 1 }], tools: [tool] };
}

function result(callId = "batch-call"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "local_read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 2,
	};
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

beforeEach(() => providerSessionState.clear());

describe("full-mode continuation", () => {
	it("cancels the losing feed waiter when the broker wins, then resumes the same browser turn", async () => {
		const admission = {} as ChatGptWebRuntimeAdmission;
		const gateCalls = { admit: 0, release: 0 };
		const gate: ChatGptWebRuntimeGate = {
			async admit() {
				gateCalls.admit += 1;
				return admission;
			},
			retain() {
				return {} as never;
			},
			release() {
				gateCalls.release += 1;
			},
			async drain() {},
			async resume() {
				return { runtimeEpoch: "epoch", lifecycleGeneration: 1 };
			},
		};
		const issue = {
			turnToken: "turn_abcdefghijklmnopqrstuvwxyz012345",
			binding: {},
			connector: {},
			expiresAt: Number.MAX_SAFE_INTEGER,
		} as ChatGptWebTurnIssue;
		const batch: readonly ChatGptWebInvocationRequest[] = [
			{ callId: "batch-call", wireName: "read_wire", freeform: false, arguments: { path: "src/index.ts" } },
		];
		const resume = Promise.withResolvers<void>();
		const calls = { issue: 0, next: 0, resolve: 0, release: 0 };
		const orchestration: ChatGptWebOrchestration = {
			async issue(_request, receivedAdmission) {
				expect(receivedAdmission).toBe(admission);
				calls.issue += 1;
				return issue;
			},
			async nextInvocationBatch(_issue, signal) {
				calls.next += 1;
				if (calls.next === 1) return batch;
				const pending = Promise.withResolvers<readonly ChatGptWebInvocationRequest[]>();
				signal?.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
				return pending.promise;
			},
			async resolveBatch(_issue, results) {
				calls.resolve += 1;
				expect(results.map(entry => entry.callId)).toEqual(["batch-call"]);
				resume.resolve();
			},
			async release() {
				calls.release += 1;
			},
		};
		const runner: ChatGptWebTurnRunner = async (_turn, _host, receivedAdmission, emit) => {
			expect(receivedAdmission).toBe(admission);
			emit({ type: "start", responseId: "continued-response" });
			await resume.promise;
			emit({ type: "text", text: "Finished after tool result" });
			emit({ type: "done", reason: "stop" });
		};
		const provider = createChatGptWebStream({
			host: {} as BrowserHost,
			gate,
			orchestration,
			config: { mode: "full", tunnelId: "tunnel", runtimeKeyConfigured: true },
			turnRunner: runner,
			turnId: () => "turn-fixture",
		});
		const first = await collect(provider(selectedModel, baseContext(), { sessionId: "session-continuation" }));
		expect(first.map(event => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const firstTerminal = first.at(-1);
		expect(firstTerminal?.type === "done" ? firstTerminal.reason : undefined).toBe("toolUse");
		expect(calls).toMatchObject({ issue: 1, resolve: 0 });

		const continued: Context = { ...baseContext(), messages: [...baseContext().messages, result()] };
		const second = await collect(provider(selectedModel, continued, { sessionId: "session-continuation" }));
		expect(second.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(calls).toEqual({ issue: 1, next: 2, resolve: 1, release: 1 });
		expect(gateCalls).toEqual({ admit: 1, release: 1 });
	});

	it("does not resolve a partial batch", async () => {
		const admission = {} as ChatGptWebRuntimeAdmission;
		const gate: ChatGptWebRuntimeGate = {
			async admit() {
				return admission;
			},
			retain() {
				return {} as never;
			},
			release() {},
			async drain() {},
			async resume() {
				return { runtimeEpoch: "epoch", lifecycleGeneration: 1 };
			},
		};
		const issue = {
			turnToken: "turn_abcdefghijklmnopqrstuvwxyz012345",
			binding: {},
			connector: {},
			expiresAt: 9e15,
		} as ChatGptWebTurnIssue;
		const batch = [
			{ callId: "call-a", wireName: "read_wire", freeform: false, arguments: { path: "a" } },
			{ callId: "call-b", wireName: "read_wire", freeform: false, arguments: { path: "b" } },
		] as const;
		let resolves = 0;
		const orchestration: ChatGptWebOrchestration = {
			async issue() {
				return issue;
			},
			async nextInvocationBatch() {
				return batch;
			},
			async resolveBatch() {
				resolves += 1;
			},
			async release() {},
		};
		const hold = Promise.withResolvers<void>();
		const runner: ChatGptWebTurnRunner = async (_turn, _host, _admission, emit) => {
			emit({ type: "start", responseId: "batch-response" });
			await hold.promise;
		};
		const provider = createChatGptWebStream({
			host: {} as BrowserHost,
			gate,
			orchestration,
			config: { mode: "full", tunnelId: "tunnel", runtimeKeyConfigured: true },
			turnRunner: runner,
		});
		await collect(provider(selectedModel, baseContext(), { sessionId: "session-cardinality" }));

		const partial: Context = { ...baseContext(), messages: [...baseContext().messages, result("call-a")] };
		const partialEvents = await collect(provider(selectedModel, partial, { sessionId: "session-cardinality" }));
		expect(partialEvents.at(-1)?.type).toBe("error");
		expect(resolves).toBe(0);
		hold.resolve();
	});

	it("matches exact IDs and names once and rejects duplicate or cross-session results", () => {
		const request: ChatGptWebInvocationRequest = {
			callId: "exact-call",
			wireName: "read_wire",
			freeform: false,
			arguments: { path: "a" },
		};
		const state = {
			pendingBatch: {
				requests: [request],
				toolNamesByCallId: { "exact-call": "local_read" },
				deliveredAt: 1,
			},
			consumedToolResultIds: new Set<string>(),
		} as unknown as ChatGptWebSessionState;
		expect(consumeContinuationResults(state, [result("other-session-call")])).toBeUndefined();
		expect(() => consumeContinuationResults(state, [result("exact-call"), result("exact-call")])).toThrow(
			"duplicate",
		);
		expect(() =>
			consumeContinuationResults(state, [{ ...result("exact-call"), toolName: "different_tool" }]),
		).toThrow("does not match");
		const exact = consumeContinuationResults(state, [result("exact-call")]);
		expect(exact?.map(entry => entry.callId)).toEqual(["exact-call"]);
		markContinuationConsumed(state, exact!);
		state.pendingBatch = {
			requests: [request],
			toolNamesByCallId: { "exact-call": "local_read" },
			deliveredAt: 2,
		};
		expect(() => consumeContinuationResults(state, [result("exact-call")])).toThrow("already consumed");
	});
});
