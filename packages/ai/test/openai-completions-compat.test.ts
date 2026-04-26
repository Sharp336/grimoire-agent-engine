import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { convertMessages, detectCompat, streamOpenAICompletions } from "../src/providers/openai-completions";
import type { AssistantMessage, Context, Model, OpenAICompat } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function toObject(value: unknown): object | null {
	return typeof value === "object" && value !== null ? value : null;
}

function getNestedObject(value: unknown, key: string): object | null {
	const obj = toObject(value);
	if (!obj) return null;
	return toObject(Reflect.get(obj, key));
}

function getNestedBoolean(value: unknown, key: string): boolean | undefined {
	const obj = toObject(value);
	if (!obj) return undefined;
	const property = Reflect.get(obj, key);
	return typeof property === "boolean" ? property : undefined;
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): typeof fetch {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}

	return Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

describe("openai-completions compatibility", () => {
	it("serializes assistant text content as a plain string", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const compat = {
			supportsStore: true,
			supportsDeveloperRole: true,
			supportsReasoningEffort: true,
			reasoningEffortMap: {},
			supportsUsageInStreaming: true,
			supportsToolChoice: true,
			maxTokensField: "max_completion_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			requiresThinkingAsText: false,
			requiresMistralToolIds: false,
			thinkingFormat: "openai",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: false,
			requiresAssistantContentForToolCalls: false,
			openRouterRouting: {},
			vercelGatewayRouting: {},
			extraBody: {},
			supportsStrictMode: true,
			toolStrictMode: "none",
		} satisfies Required<OpenAICompat>;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: " world" },
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [assistantMessage] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		if (!assistant || assistant.role !== "assistant") {
			throw new Error("assistant message missing");
		}
		expect(typeof assistant.content).toBe("string");
		expect(assistant.content).toBe("hello world");
	});

	it("reads usage from choice usage fallback", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Hello" },
						usage: {
							prompt_tokens: 12,
							completion_tokens: 3,
							prompt_tokens_details: { cached_tokens: 2 },
						},
					},
				],
			},
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(3);
		expect(result.usage.cacheRead).toBe(2);
		expect(result.usage.totalTokens).toBe(15);
	});

	it("maps qwen chat template reasoning into chat_template_kwargs", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			reasoning: true,
			compat: {
				thinkingFormat: "qwen-chat-template",
			},
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			reasoning: "high",
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		const chatTemplateArgs = getNestedObject(payload, "chat_template_kwargs");
		expect(getNestedBoolean(chatTemplateArgs, "enable_thinking")).toBe(true);
	});

	it("treats finish_reason end as stop", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "done" } }],
			},
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "end" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "done" });
	});

	it("injects compat.extraBody into OpenAI payload", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			compat: {
				extraBody: {
					gateway: "m1-01",
					controller: "mlx",
				},
			},
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		global.fetch = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});

		const payload = await promise;
		expect(payload).toEqual(
			expect.objectContaining({
				gateway: "m1-01",
				controller: "mlx",
			}),
		);
	});

	it("preserves the streamed reasoning field name for follow-up requests", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { reasoning_text: "inspect tool output" },
					},
				],
			},
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		expect(result.content).toContainEqual({
			type: "thinking",
			thinking: "inspect tool output",
			thinkingSignature: "reasoning_text",
		});

		const messages = convertMessages(model, { messages: [result] }, detectCompat(model));
		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		const assistantObject = toObject(assistant);
		expect(assistantObject).toBeDefined();
		expect(assistantObject ? Reflect.get(assistantObject, "reasoning_text") : undefined).toBe("inspect tool output");
		expect(assistantObject ? Reflect.get(assistantObject, "reasoning_content") : undefined).toBeUndefined();
	});
});

describe("opencode reasoning-content compatibility via detectCompat", () => {
	type OpenCodeProvider = "opencode-go" | "opencode-zen";

	function openCodeModel(provider: OpenCodeProvider, id: string, reasoning = true): Model<"openai-completions"> {
		const baseUrl = provider === "opencode-go" ? "https://opencode.ai/zen/go/v1" : "https://opencode.ai/zen/v1";
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider,
			baseUrl,
			id,
			reasoning,
		};
	}

	it.each(["opencode-go", "opencode-zen"] as const)(
		"requires reasoning_content for tool calls on kimi-k2.5 via %s",
		provider => {
			const compat = detectCompat(openCodeModel(provider, "kimi-k2.5", true));
			expect(compat.requiresReasoningContentForToolCalls).toBe(true);
			expect(compat.requiresAssistantContentForToolCalls).toBe(true);
		},
	);

	it.each(["opencode-go", "opencode-zen"] as const)(
		"requires reasoning_content for tool calls on reasoning DeepSeek models via %s",
		provider => {
			const compat = detectCompat(openCodeModel(provider, "deepseek-v4-pro", true));
			expect(compat.requiresReasoningContentForToolCalls).toBe(true);
			expect(compat.requiresAssistantContentForToolCalls).toBe(false);
		},
	);

	it("requires reasoning_content when custom openai provider targets opencode zen baseUrl", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://opencode.ai/zen/v1",
			id: "deepseek-v4-pro",
			reasoning: true,
		};
		const compat = detectCompat(model);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it.each(["opencode-go", "opencode-zen"] as const)(
		"injects reasoning_content placeholder for reasoning DeepSeek tool-call turns via %s",
		provider => {
			const model = openCodeModel(provider, "deepseek-v4-pro", true);
			const compat = detectCompat(model);
			const toolCallMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: `call_ds_${provider}`, name: "web_search", arguments: { query: "hi" } }],
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
			const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
			const assistant = messages.find(m => m.role === "assistant");
			expect(assistant).toBeDefined();
			expect(Reflect.get(assistant as object, "reasoning_content")).toBe(".");
		},
	);

	it.each(["opencode-go", "opencode-zen"] as const)(
		"does not require reasoning_content when %s model is not reasoning-capable",
		provider => {
			const compat = detectCompat(openCodeModel(provider, "some-other-model", false));
			expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		},
	);

	it.each(["kimi-k2.5", "kimi-k1.5", "kimi-k2-5"])("matches kimi model id pattern via opencode-zen: %s", id => {
		const compat = detectCompat(openCodeModel("opencode-zen", id, true));
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("still matches moonshotai/kimi via openrouter", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "moonshotai/kimi-k2-5",
			reasoning: true,
		};
		const compat = detectCompat(model);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});
});

describe("NVIDIA NIM DeepSeek special-token stripping", () => {
	function nvidiaDeepseekModel(): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "deepseek-ai/deepseek-v4-flash",
			reasoning: true,
		};
	}

	it("strips leaked <\uff5cDSML\uff5c...\uff5c> markers from visible content", async () => {
		const model = nvidiaDeepseekModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Sure thing.<\uff5cDSML\uff5ctool_calls\uff5c>I'll help." },
					},
				],
			},
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Sure thing.I'll help.");
		expect(text).not.toContain("DSML");
		expect(text).not.toContain("\uff5c");
	});

	it("holds back partial token split across chunks", async () => {
		const model = nvidiaDeepseekModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "Hello <\uff5ctool_calls" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "_begin\uff5c>world" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Hello world");
	});

	it("flushes a dangling partial open delimiter at end of stream", async () => {
		const model = nvidiaDeepseekModel();
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "trailing <\uff5c" } }],
			},
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		// At end-of-stream we have no way to know whether the partial is a real token,
		// so we emit it verbatim rather than swallow legitimate text forever.
		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("trailing <\uff5c");
	});

	it("leaves visible content alone for non-deepseek nvidia models", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "meta/llama-3.3-70b-instruct",
		};
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "keep <\uff5cas-is\uff5c> please" } }],
			},
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("keep <\uff5cas-is\uff5c> please");
	});
});
