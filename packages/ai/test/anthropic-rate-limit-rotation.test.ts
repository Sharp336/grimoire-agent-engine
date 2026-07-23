/**
 * Contract: under `rateLimitRotation`, the anthropic provider retry loop
 * surfaces a long transient-429 (RATE_LIMIT_EXCEEDED body) as a terminal
 * marker error instead of sleeping — but only when a sibling credential
 * exists. Non-RATE_LIMIT bodies and the no-rotation baseline keep the
 * provider's own `providerRetryWait` backoff, byte-identical.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type ApiKeyResolveContext, type FetchImpl, waitBeforeProviderRetry } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

const RATE_LIMIT_BODY =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your per-minute rate limit"}}';
const OVERLOADED_BODY = '429 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
// Real Anthropic overload is HTTP 529 (not 429). `waitBeforeProviderRetry` gates
// its rotation/stall block on `status === 429`, so a 529 must skip it by STATUS —
// independent of body classification.
const OVERLOADED_BODY_529 = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

type MockAnthropicEvent = Record<string, unknown>;

function successEvents(text: string): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_rotation_success",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

/** Client whose first `failCount` attempts reject with `error`, then stream success. */
function createClient(
	error: Error,
	failCount: number,
): { client: AnthropicMessagesClientLike; attempts: () => number } {
	let attempt = 0;
	const create = ((_body: unknown) => {
		attempt += 1;
		if (attempt <= failCount) {
			return {
				async withResponse() {
					throw error;
				},
			} as never;
		}
		return {
			async withResponse() {
				return {
					data: {
						async *[Symbol.asyncIterator]() {
							for (const event of successEvents("recovered")) yield event;
						},
					},
					response: new Response(null, { status: 200, headers: { "request-id": "req_mock" } }),
					request_id: "req_mock",
				};
			},
		} as never;
	}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
	return { client: { messages: { create } } as AnthropicMessagesClientLike, attempts: () => attempt };
}

function rateLimitApiError(body: string): AIError.AnthropicApiError {
	return new AIError.AnthropicApiError(429, body, new Headers({ "retry-after": "30" }));
}

function rotationOptions(overrides?: Partial<SimpleStreamOptions["rateLimitRotation"] & object>) {
	return {
		enabled: true,
		provider: "anthropic",
		minSleepMs: 2_000,
		hasUsableSibling: () => true,
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic rate-limit rotation surfacing", () => {
	it("surfaces a long transient 429 as a terminal marker error without sleeping or refetching", async () => {
		const { client, attempts } = createClient(rateLimitApiError(RATE_LIMIT_BODY), Number.POSITIVE_INFINITY);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			rateLimitRotation: rotationOptions(),
		}).result();

		// One request, no backoff sleep: the failure surfaced instead.
		expect(attempts()).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		// Marker bytes + the retry hint (retry-after 30s folded into the delay)
		// survive AIError.finalize — the auth-retry driver parses them.
		expect(result.errorMessage).toContain("; rate limit surfaced for rotation; retry-after-ms: 30000ms");
		expect(result.errorStatus).toBe(429);
	});

	it("surfaces the ORIGINAL AnthropicApiError instance — subclass identity and headers survive", async () => {
		// The surfaced terminal error must be the same object the attempt rejected
		// with, message rewritten in place to the marker form. Wrapping it in a
		// fresh ProviderHttpError would discard the AnthropicApiError subclass and
		// its headers (incl. retry-after) that downstream turn-retry/fallback
		// logic inspects.
		const failure = rateLimitApiError(RATE_LIMIT_BODY);
		let caught: unknown;
		try {
			await waitBeforeProviderRetry(30_000, { rateLimitRotation: rotationOptions() }, failure);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(failure);
		expect(caught).toBeInstanceOf(AIError.AnthropicApiError);
		expect((caught as AIError.AnthropicApiError).status).toBe(429);
		expect((caught as AIError.AnthropicApiError).headers.get("retry-after")).toBe("30");
		expect((caught as Error).message).toContain("; rate limit surfaced for rotation; retry-after-ms: 30000ms");
	});

	it("keeps the baseline backoff path recoverable; providerRetryWait now receives the failure as cause", async () => {
		const failure = rateLimitApiError(RATE_LIMIT_BODY);
		const { client, attempts } = createClient(failure, 1);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		expect(attempts()).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		// The cause is the actual 429 the attempt rejected with — the wait hook
		// classifies on it, so a placeholder here would let a wrong/rewrapped
		// error slip through.
		expect(providerRetryWait).toHaveBeenCalledWith(30_000, undefined, failure);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("does not surface non-RATE_LIMIT 429 bodies and does not label the sleep a stall", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { client, attempts } = createClient(rateLimitApiError(OVERLOADED_BODY), 1);
		const providerRetryWait = vi.fn(async () => {});
		const hasUsableSibling = vi.fn(() => true);

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			rateLimitRotation: rotationOptions({ hasUsableSibling }),
		}).result();

		// MODEL_CAPACITY-classified body stays in the transport backoff; the
		// sibling probe never fires and the sleep is NOT a rate-limit stall.
		expect(hasUsableSibling).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalledWith("rate_limit_stall", expect.anything());
		expect(attempts()).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("stop");
	});

	it("skips the rotation block entirely for a real-wire 529 overload (gated by status, not body)", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const overload529 = new AIError.AnthropicApiError(529, OVERLOADED_BODY_529, new Headers({ "retry-after": "30" }));
		const { client, attempts } = createClient(overload529, 1);
		const providerRetryWait = vi.fn(async () => {});
		const hasUsableSibling = vi.fn(() => true);

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			rateLimitRotation: rotationOptions({ hasUsableSibling }),
		}).result();

		// status !== 429 → the rotation/stall block never runs: no surface, no
		// sibling probe, no stall warning — just the plain delegated provider wait.
		expect(hasUsableSibling).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalledWith("rate_limit_stall", expect.anything());
		expect(attempts()).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(providerRetryWait).toHaveBeenCalledWith(30_000, undefined, expect.anything());
		expect(result.stopReason).toBe("stop");
	});

	it("sleeps with a stall warning when no sibling credential exists", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { client, attempts } = createClient(rateLimitApiError(RATE_LIMIT_BODY), 1);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			rateLimitRotation: rotationOptions({ hasUsableSibling: () => false }),
		}).result();

		expect(attempts()).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledWith(30_000, undefined, expect.anything());
		expect(result.stopReason).toBe("stop");
		expect(warn).toHaveBeenCalledWith(
			"rate_limit_stall",
			expect.objectContaining({ provider: "anthropic", delayMs: 30_000, source: "provider-retry" }),
		);
	});

	it("logs the no-sibling stall once across multiple provider retries", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { client, attempts } = createClient(rateLimitApiError(RATE_LIMIT_BODY), 2);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			rateLimitRotation: rotationOptions({ hasUsableSibling: () => false }),
		}).result();

		// Two failed attempts each stall on the missing sibling, but the per-stream
		// latch collapses them into a single `rate_limit_stall` log.
		expect(attempts()).toBe(3);
		expect(providerRetryWait).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(warn.mock.calls.filter(call => call[0] === "rate_limit_stall")).toHaveLength(1);
	});
});

describe("anthropic rate-limit rotation end-to-end (streamSimple)", () => {
	// `client` injection cannot thread through streamSimple (mapOptionsForApi
	// whitelists provider options and drops it), so this e2e mocks the transport
	// via `fetch` — the same seam the openai e2e uses — driving the REAL anthropic
	// client + provider retry loop end to end.
	const RATE_LIMIT_WIRE_BODY = JSON.stringify({
		type: "error",
		error: { type: "rate_limit_error", message: "Number of requests has exceeded your per-minute rate limit" },
	});

	function anthropicSseResponse(events: MockAnthropicEvent[]): Response {
		const payload = `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		return new Response(payload, {
			status: 200,
			headers: { "content-type": "text/event-stream", "request-id": "req_e2e" },
		});
	}

	it("rotates the auth-retry driver to a sibling key on a surfaced 429 and fires onRotated once", async () => {
		// End-to-end through streamSimple: key-A's request surfaces a rotatable 429
		// as the marker error, AIError.finalize carries the marker bytes + 429
		// status into the terminal error event, the driver's
		// isSurfacedRateLimitMessage check accepts it and rotates, and key-B
		// succeeds.
		const attemptsByKey = new Map<string, number>();
		const retryContexts: ApiKeyResolveContext[] = [];
		const onRotated = vi.fn();
		const fetchMock: FetchImpl = async (_input, init) => {
			const key = new Headers(init?.headers).get("x-api-key") ?? "";
			attemptsByKey.set(key, (attemptsByKey.get(key) ?? 0) + 1);
			if (key === "key-A") {
				return new Response(RATE_LIMIT_WIRE_BODY, {
					status: 429,
					headers: { "retry-after": "30", "content-type": "application/json" },
				});
			}
			return anthropicSseResponse(successEvents("recovered"));
		};

		const result = await streamSimple(model, context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryContexts.push(ctx);
				return ctx.error === undefined ? "key-A" : "key-B";
			},
			fetch: fetchMock,
			rateLimitRotation: {
				enabled: true,
				provider: "anthropic",
				minSleepMs: 2_000,
				hasUsableSibling: () => true,
				onRotated,
			},
		} as SimpleStreamOptions).result();

		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered" }]);
		// Exactly one 429 on key-A (surfaced, not retried in place) then one
		// success on key-B.
		expect(attemptsByKey.get("key-A")).toBe(1);
		expect(attemptsByKey.get("key-B")).toBe(1);
		// Direct rotation: the single retry resolve carried the surfaced marker.
		expect(retryContexts.map(ctx => ctx.lastChance)).toEqual([true]);
		expect((retryContexts[0]!.error as Error).message).toContain(
			"; rate limit surfaced for rotation; retry-after-ms: 30000ms",
		);
		expect(onRotated).toHaveBeenCalledTimes(1);
		expect(onRotated).toHaveBeenCalledWith({ provider: "anthropic", modelId: model.id });
	});
});
