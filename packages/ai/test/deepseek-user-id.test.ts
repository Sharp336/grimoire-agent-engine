import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const directModel = getBundledModel("deepseek", "deepseek-v4-pro") as Model<"openai-completions">;
const proxyModel = {
	...directModel,
	baseUrl: "https://proxy.example/v1",
} satisfies Model<"openai-completions">;
const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

async function captureRequestBody(
	model: Model<"openai-completions">,
	sessionId?: string,
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetch: FetchImpl = async (_input, init) => {
		const parsed = JSON.parse(String(init?.body));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected an object request body");
		}
		body = parsed;
		const chunk = {
			id: "chatcmpl-user-id",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};

	const result = await streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch,
		...(sessionId === undefined ? {} : { sessionId }),
	}).result();
	expect(result.stopReason).toBe("stop");
	if (!body) throw new Error("request body was not captured");
	return body;
}

describe("DeepSeek user_id isolation", () => {
	it("derives a stable opaque identifier without leaking the raw session", async () => {
		const rawSession = "customer@example.com/tenant 42/😀";
		const first = await captureRequestBody(directModel, rawSession);
		const repeated = await captureRequestBody(directModel, rawSession);
		const different = await captureRequestBody(directModel, `${rawSession}-different`);

		expect(first.user_id).toBe(repeated.user_id);
		expect(first.user_id).not.toBe(different.user_id);
		expect(first.user_id).toMatch(/^omp_[a-zA-Z0-9_-]+$/);
		expect(String(first.user_id).length).toBeLessThanOrEqual(512);
		expect(first.user_id).not.toContain("customer");
		expect(first.user_id).not.toContain("tenant");
	});

	it("omits user_id when no session identity exists", async () => {
		const body = await captureRequestBody(directModel);
		expect(body.user_id).toBeUndefined();
	});

	it("omits user_id for DeepSeek-labelled third-party endpoints", async () => {
		const body = await captureRequestBody(proxyModel, "session-private");
		expect(body.user_id).toBeUndefined();
	});
});
