import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const OVERSIZED_REQUEST = "Request payload size exceeds the limit of 30 MiB.";

const model: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3.6-flash",
	name: "Gemini 3.6 Flash (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: DAILY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 32_000,
});

const context: Context = { messages: [{ role: "user", content: "too much history", timestamp: 1 }] };

function endpointFromInput(input: Parameters<FetchImpl>[0]): string {
	const url = input instanceof Request ? input.url : input.toString();
	return url.startsWith(SANDBOX_ENDPOINT) ? SANDBOX_ENDPOINT : DAILY_ENDPOINT;
}

function sseError(code: number, message: string): Response {
	return new Response(`data: ${JSON.stringify({ error: { code, status: "INVALID_ARGUMENT", message } })}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function streamOptions(fetch: FetchImpl) {
	return {
		apiKey: JSON.stringify({ token: "token", projectId: "project" }),
		antigravityEndpointMode: "auto" as const,
		fetch,
	};
}

describe("Antigravity Cloud Code Assist oversized-request compaction signals", () => {
	it("maps the daily endpoint's non-2xx JSON oversized-request error without empty-stream retry or sandbox fallback", async () => {
		const endpoints: string[] = [];
		const fetch: FetchImpl = async input => {
			endpoints.push(endpointFromInput(input));
			return new Response(
				JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: OVERSIZED_REQUEST } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		};

		const stream = streamGoogleGeminiCli(model, context, streamOptions(fetch));
		const result = await stream.result();

		expect(endpoints).toEqual([DAILY_ENDPOINT]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(OVERSIZED_REQUEST);
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(true);
		expect(result.errorId).toBe(AIError.create(AIError.Flag.ContextOverflow));
		expect(AIError.isContextOverflow(result, model.contextWindow)).toBe(true);
	});

	it("maps the daily endpoint's SSE oversized-request error without empty-stream retry or sandbox fallback", async () => {
		const endpoints: string[] = [];
		const fetch: FetchImpl = async input => {
			endpoints.push(endpointFromInput(input));
			return sseError(400, OVERSIZED_REQUEST);
		};

		const stream = streamGoogleGeminiCli(model, context, streamOptions(fetch));
		const result = await stream.result();

		expect(endpoints).toEqual([DAILY_ENDPOINT]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(OVERSIZED_REQUEST);
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(true);
		expect(result.errorId).toBe(AIError.create(AIError.Flag.ContextOverflow));
		expect(AIError.isContextOverflow(result, model.contextWindow)).toBe(true);
	});

	it("fails over for a transient SSE error without misclassifying it as an overflow", async () => {
		const endpoints: string[] = [];
		const fetch: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			endpoints.push(endpoint);
			return sseError(503, "Cloud Code Assist backend temporarily unavailable.");
		};

		const stream = streamGoogleGeminiCli(model, context, streamOptions(fetch));
		const result = await stream.result();

		expect(endpoints).toEqual([DAILY_ENDPOINT, SANDBOX_ENDPOINT]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("temporarily unavailable");
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.isContextOverflow(result, model.contextWindow)).toBe(false);
	});
});
