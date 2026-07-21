import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function sseResponse(): Response {
	return new Response(
		[
			'data: {"choices"',
			':[{"delta":{"content":"ok"},"index":0}]}',
			"",
			'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
			": keepalive",
			"",
			'data: {"choices":[],"raw_usage":{"model_context":{"t',
			'ask_mode":"unknown"}},"usage":{"completion_tokens":1,"prompt_tokens":1,"total_tokens":2}}',
			"",
			"data: [DONE]",
			"",
		].join("\n"),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

describe("Qoder request headers", () => {
	it("sends bearer auth and Qoder client attribution on chat completions", async () => {
		const model = getBundledModel<"openai-completions">("qoder", "auto");
		let requestHeaders: Headers | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse();
		};
		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "qoder-test-token",
			fetch: fetchMock,
		});
		let text = "";
		for await (const event of stream) {
			if (event.type === "text_delta") text += event.delta;
		}
		const result = await stream.result();
		expect(text).toBe("ok");
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(1);
		expect(result.usage.output).toBe(1);
		expect(result.usage.totalTokens).toBe(2);

		expect(requestHeaders).toBeDefined();
		expect(requestHeaders?.get("Authorization")).toBe("Bearer qoder-test-token");
		expect(requestHeaders?.get("Cosy-ClientType")).toBe("5");
		expect(requestHeaders?.get("Cosy-Version")).toBe("1.1.2");
		const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
		expect(requestHeaders?.get("Cosy-MachineOS")).toBe(`${arch}_${process.platform}`);
		expect(requestBody).toBeDefined();
		expect(requestBody?.store).toBeUndefined();
		expect(requestBody?.metadata).toBeUndefined();
		expect(requestBody?.privacy_mode).toBeUndefined();
		expect(requestBody?.data_policy_agreed).toBeUndefined();
		expect(requestBody?.user).toBeUndefined();
		expect(requestBody?.session_id).toBeUndefined();
	});

	it("routes context aliases to the base model with an explicit context length", async () => {
		const model = getBundledModel<"openai-completions">("qoder", "ultimate-1m");
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse();
		};
		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const result = await streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "qoder-test-token",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requestBody?.model).toBe("ultimate");
		expect(requestBody?.context_length).toBe(1_000_000);
	});

	it("ignores /fast priority for qoder/auto without highspeed metadata", async () => {
		const model = getBundledModel<"openai-completions">("qoder", "auto");
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse();
		};
		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const result = await streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "qoder-test-token",
			fetch: fetchMock,
			serviceTier: "priority",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requestBody?.model).toBe("auto");
		expect(requestBody?.service_tier).toBeUndefined();
		expect(requestBody?.metadata).toBeUndefined();
	});

	it("maps /fast priority to Qoder highspeed only for Kimi-K2.7-Code", async () => {
		const base = getBundledModel<"openai-completions">("qoder", "kmodel");
		const model = {
			...base,
			compat: {
				...base.compat,
				extraBody: {
					metadata: {
						trace: "keep",
						business: { mode: "keep", feature_switches: { existing: "true" } },
					},
				},
			},
		};
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse();
		};
		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const result = await streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "qoder-test-token",
			fetch: fetchMock,
			serviceTier: "priority",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requestBody?.service_tier).toBeUndefined();
		expect(requestBody?.metadata).toEqual({
			trace: "keep",
			business: {
				mode: "keep",
				feature_switches: { existing: "true", highspeed: "true" },
			},
		});
	});
});
