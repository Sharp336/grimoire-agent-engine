import { describe, expect, test } from "bun:test";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessageEvent, Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	XAI_GROK_BUILD_BASE_URL,
	XAI_GROK_BUILD_CLIENT_IDENTIFIER,
	XAI_GROK_BUILD_CLIENT_VERSION,
	XAI_GROK_BUILD_TOKEN_AUTH,
	XAI_GROK_BUILD_USER_AGENT,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const context: Context = {
	systemPrompt: ["Use tools when needed."],
	messages: [
		{ role: "user", content: "read marker.txt", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "prior_call", name: "read", arguments: { path: "marker.txt" } }],
			api: "openai-responses",
			provider: "xai-grok-build",
			model: "grok-4.5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "prior_call",
			toolName: "read",
			content: [{ type: "text", text: "BUILD_MARKER" }],
			isError: false,
			timestamp: 3,
		},
	],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	],
};

function makeModel(provider = "xai-grok-build"): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		provider,
		id: "grok-4.5",
		name: "Grok 4.5",
		baseUrl: provider === "xai-grok-build" ? XAI_GROK_BUILD_BASE_URL : "https://api.x.ai/v1",
		contextWindow: 500_000,
		maxTokens: 32_768,
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function sse(events: unknown[]): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function completedSse(): Response {
	const args = JSON.stringify({ path: "marker.txt" });
	return sse([
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" },
		},
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: args },
		{ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: args },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: args },
		},
		{
			type: "response.output_item.added",
			output_index: 1,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", output_index: 1, part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", output_index: 1, delta: "BUILD_DONE" },
		{
			type: "response.output_item.done",
			output_index: 1,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "BUILD_DONE" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]);
}

async function drain(
	model: Model<"openai-responses">,
	fetch: FetchImpl,
	providerSessionState?: Map<string, ProviderSessionState>,
	extra: Pick<
		OpenAIResponsesOptions,
		"sessionId" | "promptCacheKey" | "headers" | "reasoning" | "reasoningSummary"
	> = {},
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamOpenAIResponses(model, context, {
		apiKey: "oauth-token",
		fetch,
		providerSessionState,
		...extra,
	})) {
		events.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	return events;
}

function assertUuid(value: string | null): asserts value is string {
	expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

describe("xAI Grok Build Responses transport", () => {
	test("uses the existing Responses body and parser with invariant Build identity", async () => {
		let url = "";
		let headers = new Headers();
		let body: Record<string, unknown> = {};
		const fetch: FetchImpl = async (input, init) => {
			url = String(input);
			headers = new Headers(init?.headers);
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return completedSse();
		};
		const events = await drain(makeModel(), fetch, undefined, {
			sessionId: "conversation-from-session",
			reasoning: "high",
			reasoningSummary: "detailed",
			headers: {
				Authorization: "Bearer attacker",
				"X-Grok-Agent-Id": "attacker-agent",
				"X-Grok-Model-Override": "attacker-model",
				"X-Grok-Turn-Idx": "999",
				TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			},
		});

		expect(url).toBe(`${XAI_GROK_BUILD_BASE_URL}/responses`);
		expect(body.model).toBe("grok-4.5");
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.input).toBeArray();
		expect(body.reasoning).toEqual({ effort: "high" });
		const input = body.input as Array<Record<string, unknown>>;
		const replayedCall = input.find(item => item.type === "function_call");
		const replayedResult = input.find(item => item.type === "function_call_output");
		expect(replayedCall).toEqual(expect.objectContaining({ name: "read" }));
		expect(replayedResult).toEqual(
			expect.objectContaining({ call_id: replayedCall?.call_id, output: "BUILD_MARKER" }),
		);
		expect(headers.get("authorization")).toBe("Bearer oauth-token");
		expect(headers.get("user-agent")).toBe(XAI_GROK_BUILD_USER_AGENT);
		expect(headers.get("x-grok-client-identifier")).toBe(XAI_GROK_BUILD_CLIENT_IDENTIFIER);
		expect(headers.get("x-grok-client-version")).toBe(XAI_GROK_BUILD_CLIENT_VERSION);
		expect(headers.get("x-xai-token-auth")).toBe(XAI_GROK_BUILD_TOKEN_AUTH);
		expect(headers.get("x-grok-model-override")).toBe("grok-4.5");
		expect(headers.get("x-grok-conv-id")).toBe("conversation-from-session");
		assertUuid(headers.get("x-grok-agent-id"));
		assertUuid(headers.get("x-grok-session-id"));
		assertUuid(headers.get("x-grok-req-id"));
		expect(headers.get("x-grok-turn-idx")).toBeNull();
		expect(headers.get("traceparent")).toBeNull();
		const done = events.find(event => event.type === "done");
		expect(done?.type === "done" ? done.message.content : []).toContainEqual(
			expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "marker.txt" } }),
		);
		expect(done?.type === "done" ? done.message.content : []).toContainEqual(
			expect.objectContaining({ type: "text", text: "BUILD_DONE" }),
		);
	});

	test("rejects custom request origins before exposing the Build token", async () => {
		const token = "sentinel-response-token";
		const requests: Array<{ url: string; headers: Headers }> = [];
		const fetch: FetchImpl = async (input, init) => {
			requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
			return completedSse();
		};
		const model = { ...makeModel(), baseUrl: "https://attacker.example/v1" };
		const events: AssistantMessageEvent[] = [];

		for await (const event of streamOpenAIResponses(model, context, { apiKey: token, fetch })) {
			events.push(event);
			if (event.type === "done" || event.type === "error") break;
		}

		expect(requests).toEqual([]);
		const error = events.find(event => event.type === "error");
		expect(error?.type).toBe("error");
		expect(error?.type === "error" ? error.error.errorMessage : "").toContain(
			`canonical base URL ${XAI_GROK_BUILD_BASE_URL}`,
		);
		expect(JSON.stringify({ requests, events })).not.toContain(token);
	});

	test("reserves fresh monotonic identity for transport retries and parallel calls", async () => {
		const attempts: Headers[] = [];
		let first = true;
		const fetch: FetchImpl = async (_input, init) => {
			attempts.push(new Headers(init?.headers));
			if (first) {
				first = false;
				return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
			}
			return completedSse();
		};
		const state = new Map<string, ProviderSessionState>();
		await drain(makeModel(), fetch, state);
		await Promise.all([drain(makeModel(), fetch, state), drain(makeModel(), fetch, state)]);

		expect(attempts).toHaveLength(4);
		expect(attempts.map(headers => headers.get("x-grok-turn-idx"))).toEqual([null, "1", "2", "3"]);
		expect(attempts[0]?.get("traceparent")).toBeNull();
		for (const headers of attempts.slice(1)) {
			expect(headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		}
		expect(new Set(attempts.map(headers => headers.get("x-grok-req-id"))).size).toBe(4);
		expect(new Set(attempts.map(headers => headers.get("traceparent")).filter(Boolean)).size).toBe(3);
		expect(new Set(attempts.map(headers => headers.get("x-grok-agent-id"))).size).toBe(1);
		expect(new Set(attempts.map(headers => headers.get("x-grok-session-id"))).size).toBe(1);
		expect(new Set(attempts.map(headers => headers.get("x-grok-conv-id"))).size).toBe(1);
	});

	test("keeps identity monotonic across an outer strict-tools retry", async () => {
		const attempts: Headers[] = [];
		let rejectStrict = true;
		const fetch: FetchImpl = async (_input, init) => {
			attempts.push(new Headers(init?.headers));
			if (rejectStrict) {
				rejectStrict = false;
				return new Response(
					JSON.stringify({ error: { type: "invalid_request_error", message: "strict tools not supported" } }),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return completedSse();
		};
		const baseModel = makeModel();
		const strictModel: Model<"openai-responses"> = {
			...baseModel,
			compat: { ...baseModel.compat, supportsStrictMode: true },
		};
		await drain(strictModel, fetch, new Map<string, ProviderSessionState>());

		expect(attempts).toHaveLength(2);
		expect(attempts.map(headers => headers.get("x-grok-turn-idx"))).toEqual([null, "1"]);
		expect(attempts[0]?.get("x-grok-req-id")).not.toBe(attempts[1]?.get("x-grok-req-id"));
	});

	test("isolates ephemeral calls and applies conversation-id precedence", async () => {
		const attempts: Headers[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			attempts.push(new Headers(init?.headers));
			return completedSse();
		};
		await drain(makeModel(), fetch, undefined, { sessionId: "session", promptCacheKey: "cache" });
		await drain(makeModel(), fetch, undefined, { sessionId: "session-only" });
		await drain(makeModel(), fetch);

		expect(attempts.map(headers => headers.get("x-grok-turn-idx"))).toEqual([null, null, null]);
		expect(attempts[0]?.get("x-grok-conv-id")).toBe("cache");
		expect(attempts[1]?.get("x-grok-conv-id")).toBe("session-only");
		expect(attempts[2]?.get("x-grok-conv-id")).toBe(attempts[2]?.get("x-grok-session-id"));
		expect(new Set(attempts.map(headers => headers.get("x-grok-agent-id"))).size).toBe(3);
		expect(new Set(attempts.map(headers => headers.get("x-grok-session-id"))).size).toBe(3);
	});

	test("renews Build identity after provider session close", async () => {
		const attempts: Headers[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			attempts.push(new Headers(init?.headers));
			return completedSse();
		};
		const state = new Map<string, ProviderSessionState>();
		await drain(makeModel(), fetch, state);
		const providerState = state.values().next().value;
		if (!providerState) throw new Error("Expected Responses provider session state");
		providerState.close();
		await drain(makeModel(), fetch, state);

		expect(attempts.map(headers => headers.get("x-grok-turn-idx"))).toEqual([null, null]);
		expect(attempts[0]?.get("x-grok-agent-id")).not.toBe(attempts[1]?.get("x-grok-agent-id"));
		expect(attempts[0]?.get("x-grok-session-id")).not.toBe(attempts[1]?.get("x-grok-session-id"));
	});

	test("does not add Build identity or alter xai-oauth reasoning summary behavior", async () => {
		let headers = new Headers();
		let body: Record<string, unknown> = {};
		const fetch: FetchImpl = async (_input, init) => {
			headers = new Headers(init?.headers);
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return completedSse();
		};
		await drain(makeModel("xai-oauth"), fetch);
		expect(headers.get("x-grok-agent-id")).toBeNull();
		expect(headers.get("x-grok-req-id")).toBeNull();
		expect(body.reasoning).toBeUndefined();
	});
});
