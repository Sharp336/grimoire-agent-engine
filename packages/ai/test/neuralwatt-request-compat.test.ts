import { describe, expect, it } from "bun:test";
import { convertMessages, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function toObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function minimalSseEvents(modelId: string): unknown[] {
	return [
		{
			id: "chatcmpl-neuralwatt",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "chatcmpl-neuralwatt",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
}

async function capturePayload(
	model: Model<"openai-completions">,
	context: Context = testContext,
	options?: {
		reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		disableReasoning?: boolean;
		maxTokens?: number;
	},
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
			return createSseResponse(minimalSseEvents(model.id));
		},
		{ preconnect: fetch.preconnect },
	);

	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchMock,
		onPayload: payload => resolve(payload),
		...options,
	});

	const payload = await promise;
	const obj = toObject(payload);
	if (!obj) throw new Error("Expected OpenAI completions request payload");
	return obj;
}

const harmlessTool: Tool = {
	name: "get_time",
	description: "Returns the current time.",
	parameters: { type: "object", properties: {} },
};

describe("neuralwatt GLM-5.2 OpenAI request contract", () => {
	it("emits reasoning_effort high, tool_stream true, max_tokens 131072, and no top-level thinking", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2");

		const payload = await capturePayload(
			model,
			{ messages: testContext.messages, tools: [harmlessTool] },
			{ reasoning: "high", maxTokens: 131_072 },
		);

		expect(payload.reasoning_effort).toBe("high");
		expect(payload.tool_stream).toBe(true);
		expect(payload.max_tokens).toBe(131_072);
		expect(payload.thinking).toBeUndefined();
	});

	it("sends reasoning_effort minimal and omits thinking when disableReasoning is true", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2");

		const payload = await capturePayload(model, testContext, {
			disableReasoning: true,
		});

		expect(payload.reasoning_effort).toBe("minimal");
		expect(payload.thinking).toBeUndefined();
	});

	it("emits reasoning_effort max and omits thinking for the upper effort tier", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2");

		const payload = await capturePayload(model, testContext, {
			reasoning: "max",
			maxTokens: 64,
		});

		expect(payload.reasoning_effort).toBe("max");
		expect(payload.thinking).toBeUndefined();
	});
});

describe("neuralwatt Kimi-K2.6 OpenAI request contract", () => {
	it("omits both thinking and reasoning_effort when reasoning high is requested", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "kimi-k2.6");

		// The bundled Kimi model still advertises reasoning but must expose no
		// effort surface: Neuralwatt reports no supported reasoning_effort field.
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toBeUndefined();

		const payload = await capturePayload(model, testContext, {
			reasoning: "high",
			maxTokens: 64,
		});

		expect(payload.thinking).toBeUndefined();
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("omits both thinking and reasoning_effort when unsupported reasoning controls are omitted (effort omitted) and stream succeeds", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "kimi-k2.6");

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
				createSseResponse(minimalSseEvents(model.id)),
			{ preconnect: fetch.preconnect },
		);

		const stream = streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			onPayload: payload => resolve(payload),
			disableReasoning: true,
		});

		const [payloadRaw, result] = await Promise.all([promise, stream.result()]);
		const payload = toObject(payloadRaw);
		expect(payload).toBeDefined();
		expect(payload?.thinking).toBeUndefined();
		expect(payload?.reasoning_effort).toBeUndefined();
		expect(result.stopReason).toBe("stop");
	});
});

describe("neuralwatt extraBody request contract", () => {
	it("sends chat_template_kwargs.preserve_thinking true for Kimi K2.6", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "kimi-k2.6");

		const payload = await capturePayload(model, testContext, {
			reasoning: "high",
			maxTokens: 64,
		});

		expect(payload.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("omits chat_template_kwargs for GLM-5.2 (non-Kimi models get no preserve_thinking)", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2");

		const payload = await capturePayload(model, testContext, {
			reasoning: "high",
			maxTokens: 64,
		});

		expect(payload.chat_template_kwargs).toBeUndefined();
	});

	it("sends service_tier flex and base model id for glm-5.2-flex", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2-flex");

		const payload = await capturePayload(model, testContext, {
			reasoning: "high",
			maxTokens: 64,
		});

		expect(payload.service_tier).toBe("flex");
		expect(payload.model).toBe("glm-5.2");
	});
});

describe("neuralwatt GLM-5.2-fast non-reasoning request contract", () => {
	it("omits reasoning_effort and tool_stream when a reasoning effort is requested with tools", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2-fast");

		// A non-reasoning fast alias must not inherit the GLM reasoning-effort
		// dialect: supportsReasoningEffort resolves false, so neither the
		// effort field nor the tool_stream flag is emitted.
		expect(model.reasoning).toBe(false);
		expect(model.compat.supportsReasoningEffort).toBe(false);

		const payload = await capturePayload(
			model,
			{ messages: testContext.messages, tools: [harmlessTool] },
			{ reasoning: "high", maxTokens: 64 },
		);

		expect(payload.reasoning_effort).toBeUndefined();
		expect(payload.tool_stream).toBeUndefined();
	});

	it("clamps max_tokens to the default output ceiling, not the inflated reasoning clamp", async () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2-fast");

		// A non-reasoning fast alias must not receive the GLM reasoning-specific
		// output clamp (128000, the inflated reasoning max). The default 64000
		// clamp applies, so requesting 200000 must be capped at 64000.
		const payload = await capturePayload(model, testContext, {
			maxTokens: 200_000,
		});

		expect(payload.max_tokens).toBeLessThanOrEqual(64000);
	});
});

describe("neuralwatt reasoning_content tool-call replay", () => {
	it("carries reasoning_content on the assistant wire message for a reasoning tool-call turn", () => {
		const model = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2");
		const compat = model.compat;

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Plan before acting.",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "toolCall",
					id: "call_neuralwatt_1",
					name: "get_time",
					arguments: {},
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

		const messages = convertMessages(model, { messages: [assistantMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();

		const assistantObject = toObject(assistant);
		expect(assistantObject).toBeDefined();
		expect(assistantObject?.reasoning_content).toBe("Plan before acting.");
		// The stale streamed `reasoning` key must never land in the wire body.
		expect(assistantObject?.reasoning).toBeUndefined();
	});
});
