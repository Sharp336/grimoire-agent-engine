import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function sseResponse(): Response {
	return new Response(
		'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n',
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

describe("Qoder request headers", () => {
	it("sends bearer auth and Qoder client attribution on chat completions", async () => {
		const model = getBundledModel<"openai-completions">("qoder", "auto");
		let requestHeaders: Headers | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
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
		for await (const _event of stream) {
			// Drain the response so request setup and stream parsing complete.
		}

		expect(requestHeaders).toBeDefined();
		expect(requestHeaders?.get("Authorization")).toBe("Bearer qoder-test-token");
		expect(requestHeaders?.get("Cosy-ClientType")).toBe("5");
		expect(requestHeaders?.get("Cosy-Version")).toBe("1.1.1");
		const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
		expect(requestHeaders?.get("Cosy-MachineOS")).toBe(`${arch}_${process.platform}`);
	});
});
