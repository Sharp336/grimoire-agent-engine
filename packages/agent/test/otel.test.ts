/**
 * Tests for OTEL instrumentation in the agent loop.
 *
 * Uses InMemorySpanExporter to capture spans synchronously and assert on
 * span names, attributes, parent/child relationships, and status codes.
 *
 * The active-context test (`parents downstream spans created during tool
 * execution`) is the regression case for the runInActiveSpan wiring — without
 * it, child spans created inside a tool's execute() function attach to the
 * surrounding context rather than to agent.tool_execution.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream, type EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Type } from "@sinclair/typebox";
import { createAssistantMessage } from "./helpers";

class MockAssistantStream extends AssistantMessageEventStream {}

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeAll(() => {
	contextManager = new AsyncLocalStorageContextManager().enable();
	context.setGlobalContextManager(contextManager);
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
	exporter.reset();
});

afterAll(async () => {
	await provider.shutdown();
	context.disable();
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock-model",
		name: "mock",
		api: "openai-responses",
		provider: "mock-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

async function runAndDrain(stream: EventStream<AgentEvent, AgentMessage[]>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
	return spans.find(s => s.name === name);
}

describe("agent-loop OTEL instrumentation", () => {
	it("emits no spans when experimental.openTelemetry is unset (zero-cost path)", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				s.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text: "ok" }]) });
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("emits agent.llm_call with gen_ai.* attributes on a simple turn", async () => {
		const finalMsg = createAssistantMessage([{ type: "text", text: "hello" }]);
		finalMsg.usage = {
			input: 12,
			output: 34,
			cacheRead: 5,
			cacheWrite: 0,
			totalTokens: 51,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		finalMsg.stopReason = "stop";

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			experimental: { openTelemetry: true },
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => s.push({ type: "done", reason: "stop", message: finalMsg }));
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const llm = findSpan(exporter.getFinishedSpans(), "agent.llm_call");
		expect(llm).toBeDefined();
		expect(llm?.attributes["gen_ai.system"]).toBe("mock-provider");
		expect(llm?.attributes["gen_ai.request.model"]).toBe("mock-model");
		expect(llm?.attributes["gen_ai.usage.input_tokens"]).toBe(12);
		expect(llm?.attributes["gen_ai.usage.output_tokens"]).toBe(34);
		expect(llm?.attributes["gen_ai.usage.cached_input_tokens"]).toBe(5);
		expect(llm?.attributes["gen_ai.response.finish_reason"]).toBe("stop");
	});

	it("emits agent.tool_execution per tool call with tool.name + tool.call_id", async () => {
		let callIndex = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			experimental: { openTelemetry: true },
		};
		const alphaSchema = Type.Object({ value: Type.String() });
		const alphaTool: AgentTool<typeof alphaSchema> = {
			name: "alpha",
			label: "Alpha",
			description: "test tool",
			parameters: alphaSchema,
			execute: async () => ({ content: [{ type: "text", text: "alpha-result" }], details: {} }),
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const m = createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "alpha", arguments: { value: "x" } }],
						"toolUse",
					);
					s.push({ type: "done", reason: "toolUse", message: m });
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [alphaTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const tool = findSpan(exporter.getFinishedSpans(), "agent.tool_execution");
		expect(tool).toBeDefined();
		expect(tool?.attributes["tool.name"]).toBe("alpha");
		expect(tool?.attributes["tool.call_id"]).toBe("tc-1");
		expect(tool?.status.code).toBe(SpanStatusCode.UNSET);
	});

	it("parents downstream spans created during tool execution (active-context propagation)", async () => {
		let callIndex = 0;
		const userTracer = trace.getTracer("user-tool");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			experimental: { openTelemetry: true },
		};
		const probeSchema = Type.Object({ value: Type.String() });
		const probeTool: AgentTool<typeof probeSchema> = {
			name: "probe",
			label: "Probe",
			description: "creates a child span during execute",
			parameters: probeSchema,
			execute: async () => {
				const inner = userTracer.startSpan("user-work-inside-tool");
				inner.end();
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const m = createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "probe", arguments: { value: "x" } }],
						"toolUse",
					);
					s.push({ type: "done", reason: "toolUse", message: m });
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [probeTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const finished = exporter.getFinishedSpans();
		const tool = findSpan(finished, "agent.tool_execution");
		const userInner = findSpan(finished, "user-work-inside-tool");
		expect(tool).toBeDefined();
		expect(userInner).toBeDefined();
		// Without runInActiveSpan, parentSpanId would be undefined (the user
		// span would be a root span) or point at whatever was active before.
		expect(userInner?.parentSpanId).toBe(tool?.spanContext().spanId);
	});

	it("records ERROR status + exception when a tool throws", async () => {
		let callIndex = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			experimental: { openTelemetry: true },
		};
		const failSchema = Type.Object({ value: Type.String() });
		const failTool: AgentTool<typeof failSchema> = {
			name: "fail",
			label: "Fail",
			description: "throws",
			parameters: failSchema,
			execute: async () => {
				throw new Error("boom");
			},
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const m = createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "fail", arguments: { value: "x" } }],
						"toolUse",
					);
					s.push({ type: "done", reason: "toolUse", message: m });
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [failTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const tool = findSpan(exporter.getFinishedSpans(), "agent.tool_execution");
		expect(tool).toBeDefined();
		expect(tool?.status.code).toBe(SpanStatusCode.ERROR);
		expect(tool?.events.some(e => e.name === "exception")).toBe(true);
	});
});
