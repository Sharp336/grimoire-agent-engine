import { beforeEach, describe, expect, it } from "bun:test";
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Context, Model, Tool } from "@oh-my-pi/pi-ai";
import type { ChatGptWebOrchestration, ChatGptWebTurnIssue } from "../../src/provider/orchestration";
import { providerSessionState } from "../../src/provider/session";
import { type ChatGptWebTurnRunner, createChatGptWebStream } from "../../src/provider/stream";
import type { ChatGptWebEvent, ChatGptWebRuntimeAdmission, ChatGptWebRuntimeGate } from "../../src/provider/types";
import type { BrowserHost } from "../../src/runtime/host";
import { ABORT_EVENTS, REASONING_TEXT_EVENTS, TOOL_CALL_EVENTS } from "../fixtures/chatgpt-events";

function model(id = "high"): Model<Api> {
	return {
		id,
		name: id,
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
}

const readTool: Tool = {
	name: "local_read",
	customWireName: "read_wire",
	description: "Read one path",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		additionalProperties: false,
	},
};

function context(tools: readonly Tool[] = []): Context {
	return { messages: [{ role: "user", content: "Question", timestamp: 1 }], tools: [...tools] };
}

interface RuntimeFixture {
	host: BrowserHost;
	gate: ChatGptWebRuntimeGate;
	orchestration: ChatGptWebOrchestration;
	calls: {
		admit: number;
		release: number;
		issue: number;
		next: number;
		resolve: number;
		orchestrationRelease: number;
	};
}

function runtimeFixture(): RuntimeFixture {
	const calls = { admit: 0, release: 0, issue: 0, next: 0, resolve: 0, orchestrationRelease: 0 };
	const admission = {} as ChatGptWebRuntimeAdmission;
	const issue = {
		turnToken: "turn_abcdefghijklmnopqrstuvwxyz012345",
		binding: {},
		connector: {},
		expiresAt: Number.MAX_SAFE_INTEGER,
	} as ChatGptWebTurnIssue;
	return {
		host: {} as BrowserHost,
		gate: {
			async admit() {
				calls.admit += 1;
				return admission;
			},
			retain() {
				return {} as never;
			},
			release() {
				calls.release += 1;
			},
			async drain() {},
			async resume() {
				return { runtimeEpoch: "epoch", lifecycleGeneration: 1 };
			},
		},
		orchestration: {
			async issue() {
				calls.issue += 1;
				return issue;
			},
			nextInvocationBatch(_issue, signal) {
				calls.next += 1;
				const pending = Promise.withResolvers<readonly never[]>();
				signal?.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
				return pending.promise;
			},
			async resolveBatch() {
				calls.resolve += 1;
			},
			async release() {
				calls.orchestrationRelease += 1;
			},
		},
		calls,
	};
}

function eventRunner(events: readonly ChatGptWebEvent[]): ChatGptWebTurnRunner {
	return async (_turn, _host, _admission, emit) => {
		for (const event of events) emit(event);
	};
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

beforeEach(() => providerSessionState.clear());

describe("createChatGptWebStream event projection", () => {
	it("emits exact reasoning/text order and updates usage without a usage event", async () => {
		const runtime = runtimeFixture();
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			config: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false },
			turnRunner: eventRunner(REASONING_TEXT_EVENTS),
			now: () => 100,
		})(model(), context(), { sessionId: "session-events", apiKey: "N/A" });
		const events = await collect(stream);
		expect(events.map(event => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.message.usage).toMatchObject({ input: 11, output: 7, totalTokens: 18 });
			expect(done.message.content).toEqual([
				{ type: "thinking", thinking: "Checking context" },
				{ type: "text", text: "Working answer" },
			]);
		}
		expect(runtime.calls.issue).toBe(0);
		expect(runtime.calls.next).toBe(0);
	});

	it("maps exact tool IDs, names, and JSON delta after schema validation", async () => {
		const runtime = runtimeFixture();
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			orchestration: runtime.orchestration,
			config: { mode: "full", tunnelId: "tunnel", runtimeKeyConfigured: true },
			turnRunner: eventRunner(TOOL_CALL_EVENTS),
		})(model(), context([readTool]), { sessionId: "session-tool" });
		const events = await collect(stream);
		expect(events.map(event => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const delta = events.find(event => event.type === "toolcall_delta");
		expect(delta?.type === "toolcall_delta" ? delta.delta : undefined).toBe('{"path":"src/index.ts"}');
		const end = events.find(event => event.type === "toolcall_end");
		if (end?.type === "toolcall_end") {
			expect(end.toolCall).toMatchObject({ id: "call-fixture", name: "local_read", customWireName: "read_wire" });
		}
		expect(runtime.calls.issue).toBe(1);
	});

	it("rejects malformed or schema-invalid tool output", async () => {
		const runtime = runtimeFixture();
		const invalid: readonly ChatGptWebEvent[] = [
			{ type: "start", responseId: "invalid" },
			{ type: "tool_call", callId: "bad", name: "read_wire", argumentsJson: '{"path":7}', freeform: false },
		];
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			orchestration: runtime.orchestration,
			config: { mode: "full", tunnelId: "tunnel", runtimeKeyConfigured: true },
			turnRunner: eventRunner(invalid),
		})(model(), context([readTool]), { sessionId: "session-invalid-tool" });
		const events = await collect(stream);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("rejects every local tool event in browser-only and Pro modes", async () => {
		for (const [id, mode] of [
			["high", "browser-only"],
			["pro", "full"],
		] as const) {
			providerSessionState.clear();
			const runtime = runtimeFixture();
			const stream = createChatGptWebStream({
				host: runtime.host,
				gate: runtime.gate,
				orchestration: runtime.orchestration,
				config: { mode, tunnelId: mode === "full" ? "tunnel" : null, runtimeKeyConfigured: mode === "full" },
				turnRunner: eventRunner(TOOL_CALL_EVENTS),
			})(model(id), context([readTool]), { sessionId: `session-${id}` });
			const events = await collect(stream);
			expect(events.at(-1)?.type).toBe("error");
			expect(runtime.calls.issue).toBe(0);
			expect(runtime.calls.next).toBe(0);
		}
	});

	it("maps provider aborts to an aborted OMP error", async () => {
		const runtime = runtimeFixture();
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			turnRunner: eventRunner(ABORT_EVENTS),
		})(model(), context(), { sessionId: "session-abort" });
		const events = await collect(stream);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type === "error") expect(terminal.reason).toBe("aborted");
	});

	it("rejects a pre-aborted request before runtime admission", async () => {
		const runtime = runtimeFixture();
		const controller = new AbortController();
		controller.abort();
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			turnRunner: eventRunner(REASONING_TEXT_EVENTS),
		})(model(), context(), { sessionId: "session-pre-abort", signal: controller.signal });
		const events = await collect(stream);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type === "error") expect(terminal.reason).toBe("aborted");
		expect(runtime.calls.admit).toBe(0);
	});

	it("fails closed on malformed browser events", async () => {
		const runtime = runtimeFixture();
		const malformed = [
			{ type: "unknown", url: "https://secret.invalid", headers: { Cookie: "private" } },
		] as unknown as ChatGptWebEvent[];
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			turnRunner: eventRunner(malformed),
		})(model(), context(), { sessionId: "session-malformed" });
		const events = await collect(stream);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type === "error") expect(terminal.error.errorMessage).not.toContain("secret.invalid");
	});
});

describe("ChatGPT Web auth and context admission", () => {
	it("requires session identity", async () => {
		const runtime = runtimeFixture();
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			turnRunner: eventRunner(REASONING_TEXT_EVENTS),
		})(model(), context(), {});
		const events = await collect(stream);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("accepts and ignores N/A but rejects credential material", async () => {
		const acceptedRuntime = runtimeFixture();
		const accepted = createChatGptWebStream({
			host: acceptedRuntime.host,
			gate: acceptedRuntime.gate,
			turnRunner: eventRunner(REASONING_TEXT_EVENTS),
		})(model(), context(), { sessionId: "session-keyless", apiKey: "N/A" });
		expect((await collect(accepted)).at(-1)?.type).toBe("done");
		const rejectedRuntime = runtimeFixture();
		let runtimeResolutions = 0;
		const rejected = createChatGptWebStream({
			resolveRuntime: async () => {
				runtimeResolutions += 1;
				return { host: rejectedRuntime.host, gate: rejectedRuntime.gate };
			},
			turnRunner: eventRunner(REASONING_TEXT_EVENTS),
		})(model(), context(), { sessionId: "session-secret", apiKey: "secret-key" });
		expect((await collect(rejected)).at(-1)?.type).toBe("error");
		expect(runtimeResolutions).toBe(0);
		expect(rejectedRuntime.calls.admit).toBe(0);
	});

	it("rejects unsupported compaction before browser admission", async () => {
		const runtime = runtimeFixture();
		const compact = { ...context(), _compactionRequest: true } as Context;
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			turnRunner: eventRunner(REASONING_TEXT_EVENTS),
		})(model(), compact, { sessionId: "session-compact" });
		expect((await collect(stream)).at(-1)?.type).toBe("error");
		expect(runtime.calls.admit).toBe(0);
	});

	it("releases full-mode issue and admission when prompt compilation is over budget", async () => {
		const runtime = runtimeFixture();
		let browserRuns = 0;
		const stream = createChatGptWebStream({
			host: runtime.host,
			gate: runtime.gate,
			orchestration: runtime.orchestration,
			config: { mode: "full", tunnelId: "tunnel", runtimeKeyConfigured: true },
			turnRunner: async () => {
				browserRuns += 1;
			},
		})({ ...model(), contextWindow: 1 }, context([readTool]), { sessionId: "session-over-budget" });
		const events = await collect(stream);
		expect(events.at(-1)?.type).toBe("error");
		expect(browserRuns).toBe(0);
		expect(runtime.calls).toMatchObject({ admit: 1, issue: 1, orchestrationRelease: 1, release: 1 });
	});
});
