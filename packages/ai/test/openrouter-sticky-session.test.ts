/**
 * OpenRouter sticky-session wiring for the Chat Completions transport.
 *
 * Contract: when the host is OpenRouter, chat completions must send the same
 * normalized `session_id` the Responses transport derives via
 * `getOpenRouterResponsesSessionId`, and a manual `provider.order` must warn
 * (once per process) that upstream skips session-affinity endpoint
 * prioritization while the order is active.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	applyOpenAIGatewayRouting,
	getOpenRouterResponsesSessionId,
	normalizeOpenRouterResponsesSessionId,
	type OpenAIGatewayRoutingCompat,
	type OpenAIGatewayRoutingParams,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function makeCompletionsModel(overrides: Partial<ModelSpec<"openai-completions">> = {}): Model<"openai-completions"> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.5",
		name: "Claude Sonnet 4.5 (OpenRouter)",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		...overrides,
	} as ModelSpec<"openai-completions">);
}

async function captureChatBody(
	model: Model<"openai-completions">,
	options: { sessionId?: string } = {},
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return sseResponse([
			{ choices: [{ delta: { content: "ok" }, index: 0 }] },
			{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
			"[DONE]",
		]);
	};
	const context: Context = {
		systemPrompt: [],
		messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
	};
	for await (const _event of streamOpenAICompletions(model, context, {
		apiKey: "test",
		fetch: fetchMock,
		...options,
	})) {
		break;
	}
	if (!body) throw new Error("expected a captured chat-completions request body");
	return body;
}

describe("OpenRouter completions sticky sessions", () => {
	it("sends the normalized session_id the Responses transport would send", async () => {
		const sessionId = "0190fb1e-0000-7000-8000-000000000001";
		const body = await captureChatBody(makeCompletionsModel(), { sessionId });

		// Same value the Responses path emits (openai-responses.ts uses
		// getOpenRouterResponsesSessionId), i.e. the shared stable-id normalization.
		expect(body.session_id).toBe(normalizeOpenRouterResponsesSessionId(sessionId));
		expect(body.session_id).toBe(getOpenRouterResponsesSessionId({ sessionId }));
	});

	it("omits session_id for non-OpenRouter hosts even when a session id is supplied", async () => {
		const plain = makeCompletionsModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
		const body = await captureChatBody(plain, { sessionId: "0190fb1e-0000-7000-8000-000000000001" });

		expect("session_id" in body).toBe(false);
	});
});

describe("applyOpenAIGatewayRouting order/session-affinity warning", () => {
	it("warns exactly once per process even when routing runs twice", () => {
		const warnSpy = spyOn(logger, "warn");
		try {
			const params: OpenAIGatewayRoutingParams = {};
			const compat: OpenAIGatewayRoutingCompat = {
				isOpenRouterHost: true,
				openRouterRouting: { order: ["anthropic", "openai"] },
			};

			applyOpenAIGatewayRouting(params, compat, true, "openrouter");
			applyOpenAIGatewayRouting(params, compat, true, "openrouter");

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(String(warnSpy.mock.calls[0]?.[0])).toContain("provider.order");
		} finally {
			warnSpy.mockRestore();
		}
	});
});
