import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] };
}

// Build an SSE body where the named `event:` is `error` and `data:` carries the
// error envelope, mirroring how OMLX/LM Studio/vLLM stream mid-body failures
// over an HTTP 200 response.
function createStreamedErrorResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("openai-completions streamed error envelope", () => {
	// Contract: OpenAI-compatible servers (OMLX, LM Studio, vLLM) answer with
	// HTTP 200 and then emit `event: error` / `data: {"error": …}` mid-stream.
	// The SSE reader ignores the event name and hands us a choice-less "chunk",
	// so the failure must be surfaced rather than silently skipped.
	it("surfaces a nested {error:{message}} envelope as an error stop reason", async () => {
		const envelope = {
			error: { message: "The number of tokens to keep is greater than the context length" },
			message: "The number of tokens to keep is greater than the context length",
		};
		const fetchMock: FetchImpl = () =>
			Promise.resolve(createStreamedErrorResponse(`event: error\ndata: ${JSON.stringify(envelope)}\n\n`));

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("greater than the context length");
	});

	it("surfaces a flat {error:'string'} envelope", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				createStreamedErrorResponse(`event: error\ndata: ${JSON.stringify({ error: "model is loading" })}\n\n`),
			);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("model is loading");
	});
});
