/**
 * Contract: for OpenAI-wire providers, `rateLimitRotation` makes the
 * `fetchWithRetry` transport surface a long transient 429 (RATE_LIMIT_EXCEEDED
 * body) before sleeping, rewritten through the marker formatter, so the
 * `streamSimple` auth-retry driver rotates to a sibling key. Without the seam
 * (flag off) and for opaque bodies the transport backoff is behavior-identical
 * to baseline (the equivalence test below pins the full event sequence).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ApiKeyResolveContext, FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 1_000 }] };

// Real OpenAI rate-limit wire shape (not Anthropic's envelope): `type: "tokens"`,
// `code: "rate_limit_exceeded"`, and the verbose TPM message. The classifier keys
// on the "rate limit" substring, so this still resolves to RATE_LIMIT_EXCEEDED.
const RATE_LIMIT_BODY = JSON.stringify({
	error: {
		message:
			"Rate limit reached for gpt-4o in organization org-XXX on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2s.",
		type: "tokens",
		param: null,
		code: "rate_limit_exceeded",
	},
});

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function successResponse(): Response {
	const chunk = (extra: Record<string, unknown>) => ({
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		...extra,
	});
	return createSseResponse([
		chunk({ choices: [{ index: 0, delta: { content: "Hi" } }] }),
		chunk({
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
	]);
}

function bearerOf(init: RequestInit | undefined): string {
	const value = new Headers(init?.headers).get("authorization") ?? "";
	return value.replace(/^Bearer /, "");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-completions rate-limit rotation", () => {
	it("surfaces the 429 before sleeping and completes on the sibling key", async () => {
		const attemptsByKey = new Map<string, number>();
		const retryContexts: ApiKeyResolveContext[] = [];
		const onRotated = vi.fn();
		const fetchMock: FetchImpl = async (_input, init) => {
			const key = bearerOf(init);
			attemptsByKey.set(key, (attemptsByKey.get(key) ?? 0) + 1);
			if (key === "key-A") {
				return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "retry-after": "30" } });
			}
			return successResponse();
		};

		const stream = streamSimple(model, context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryContexts.push(ctx);
				return ctx.error === undefined ? "key-A" : "key-B";
			},
			fetch: fetchMock,
			rateLimitRotation: {
				enabled: true,
				provider: "openai",
				minSleepMs: 2_000,
				hasUsableSibling: () => true,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
		// Exactly ONE 429 on key A: the transport surfaced instead of retrying.
		expect(attemptsByKey.get("key-A")).toBe(1);
		expect(attemptsByKey.get("key-B")).toBe(1);
		// Direct rotation with the marker + hint visible to the resolver.
		expect(retryContexts.map(ctx => ctx.lastChance)).toEqual([true]);
		expect((retryContexts[0]!.error as Error).message).toContain(
			"; rate limit surfaced for rotation; retry-after-ms: 30000ms",
		);
		expect(onRotated).toHaveBeenCalledTimes(1);
	});

	it("surfaces a header-less 429 using the body-embedded retry hint and rotates", async () => {
		// No retry-after header at all: the only delay signal is the body's
		// "Please try again in 2s", parsed by extractRetryHint. The gate must
		// surface with THAT value, the marker must carry it to the resolver, and
		// rotation must proceed to the sibling.
		const attemptsByKey = new Map<string, number>();
		const retryContexts: ApiKeyResolveContext[] = [];
		const onRotated = vi.fn();
		const fetchMock: FetchImpl = async (_input, init) => {
			const key = bearerOf(init);
			attemptsByKey.set(key, (attemptsByKey.get(key) ?? 0) + 1);
			if (key === "key-A") {
				return new Response(RATE_LIMIT_BODY, { status: 429 });
			}
			return successResponse();
		};

		const stream = streamSimple(model, context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryContexts.push(ctx);
				return ctx.error === undefined ? "key-A" : "key-B";
			},
			fetch: fetchMock,
			rateLimitRotation: {
				enabled: true,
				provider: "openai",
				minSleepMs: 1_000,
				hasUsableSibling: () => true,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
		// One 429 on key A, surfaced instead of slept; success on the sibling.
		expect(attemptsByKey.get("key-A")).toBe(1);
		expect(attemptsByKey.get("key-B")).toBe(1);
		expect(retryContexts.map(ctx => ctx.lastChance)).toEqual([true]);
		// The marker's hint is the body-parsed 2s, not a header value or default.
		expect((retryContexts[0]!.error as Error).message).toContain(
			"; rate limit surfaced for rotation; retry-after-ms: 2000ms",
		);
		expect(onRotated).toHaveBeenCalledTimes(1);
	});

	it("surfaces a qualifying 429 that only lands on the final transport attempt", async () => {
		// Regression for the final-attempt gate skip: earlier attempts return a
		// short-hint 429 (below minSleepMs → the gate sleeps and retries), and only
		// the LAST of the 6 postOpenAIStream attempts carries a long hint. Before the
		// fix, fetchWithRetry's `attempt + 1 >= maxAttempts` early-return fired before
		// the gate, degrading this to a plain terminal 429 with no marker and no
		// rotation. Now the gate is consulted on the final attempt so the marker
		// appears and the driver rotates to the sibling.
		let attemptsA = 0;
		const retryContexts: ApiKeyResolveContext[] = [];
		const onRotated = vi.fn();
		const fetchMock: FetchImpl = async (_input, init) => {
			if (bearerOf(init) !== "key-A") return successResponse();
			attemptsA += 1;
			// DEFAULT_MAX_ATTEMPTS is 6: the 6th attempt is the final one.
			const retryAfter = attemptsA >= 6 ? "30" : "0";
			return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "retry-after": retryAfter } });
		};

		const stream = streamSimple(model, context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryContexts.push(ctx);
				return ctx.error === undefined ? "key-A" : "key-B";
			},
			fetch: fetchMock,
			rateLimitRotation: {
				enabled: true,
				provider: "openai",
				minSleepMs: 2_000,
				hasUsableSibling: () => true,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
		// All 6 attempts burned on key A; the 6th surfaced instead of returning plain.
		expect(attemptsA).toBe(6);
		expect(retryContexts.map(ctx => ctx.lastChance)).toEqual([true]);
		expect((retryContexts[0]!.error as Error).message).toContain(
			"; rate limit surfaced for rotation; retry-after-ms: 30000ms",
		);
		expect(onRotated).toHaveBeenCalledTimes(1);
	});

	it("keeps the transport backoff when rotation is off (behavior-identical baseline)", async () => {
		let attempts = 0;
		const retryResolves: ApiKeyResolveContext[] = [];
		const fetchMock: FetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "retry-after": "0" } });
			}
			return successResponse();
		};

		const stream = streamSimple(model, context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryResolves.push(ctx);
				return "key-A";
			},
			fetch: fetchMock,
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		// fetchWithRetry slept the hint and recovered on the SAME key — no rotation.
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
		expect(attempts).toBe(2);
		expect(retryResolves).toEqual([]);
	});

	it("strips rotation for a static apiKey so the transport never surfaces (precondition enforcement)", async () => {
		// A static apiKey has no resolver-form auth-retry driver to parse the marker
		// and rotate. `rateLimitRotation` is dropped on the non-resolver dispatch, so
		// the surface gate is never built: the transport backoff sleeps the hint and
		// recovers on the SAME key — behavior-identical to rotation-off, no marker.
		let attempts = 0;
		const hasUsableSibling = vi.fn(() => true);
		const onRotated = vi.fn();
		const fetchMock: FetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "retry-after": "0" } });
			}
			return successResponse();
		};

		const stream = streamSimple(model, context, {
			apiKey: "static-key",
			fetch: fetchMock,
			rateLimitRotation: {
				enabled: true,
				provider: "openai",
				minSleepMs: 0,
				hasUsableSibling,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
		// Same-key retry, not a surfaced-then-terminal 429: the marker never appears.
		expect(attempts).toBe(2);
		expect(result.errorMessage ?? "").not.toContain("; rate limit surfaced for rotation");
		// Rotation never armed: no sibling probe, no rotate callback.
		expect(hasUsableSibling).not.toHaveBeenCalled();
		expect(onRotated).not.toHaveBeenCalled();
	});

	it("emits an event sequence deep-equal to the no-rotation baseline when rotation is stripped for a static key", async () => {
		// The genuine off-path equivalence contract: the SAME mocked 429-then-success
		// scenario, once without the rotation option and once with rotation armed on
		// a static key (which the non-resolver dispatch strips). Every emitted event
		// must match deep-equal — timestamps normalized, everything else exact.
		const run = async (withStrippedRotation: boolean): Promise<unknown[]> => {
			let attempts = 0;
			const fetchMock: FetchImpl = async () => {
				attempts += 1;
				if (attempts === 1) {
					return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "retry-after": "0" } });
				}
				return successResponse();
			};
			const stream = streamSimple(model, context, {
				apiKey: "static-key",
				fetch: fetchMock,
				...(withStrippedRotation
					? {
							rateLimitRotation: {
								enabled: true,
								provider: "openai",
								minSleepMs: 0,
								hasUsableSibling: () => true,
							},
						}
					: {}),
			});
			const events: unknown[] = [];
			for await (const event of stream) {
				// Snapshot at receipt (`partial` mutates as the stream progresses) and
				// zero the wall-clock fields — the only nondeterministic values.
				events.push(
					JSON.parse(
						JSON.stringify(event, (key, value) =>
							key === "timestamp" || key === "duration" || key === "ttft" ? 0 : value,
						),
					),
				);
			}
			expect((await stream.result()).stopReason).toBe("stop");
			expect(attempts).toBe(2);
			return events;
		};

		const baseline = await run(false);
		const stripped = await run(true);
		expect(baseline.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(stripped).toEqual(baseline);
	});

	it("emits an event sequence deep-equal to the no-rotation baseline when rotation is armed but the gate declines", async () => {
		// The meaningful ON-path equivalence contract: resolver-form apiKey with
		// rotation ARMED, but the surface gate declines (no usable sibling) — the
		// transport must sleep-and-retry exactly like a run with rotation absent.
		// The static-key variant above is near-tautological (rotation is stripped
		// before the transport sees it); this one drives the gate to its decline
		// branch and pins that an armed-but-non-firing seam leaves the normalized
		// event stream identical.
		const run = async (armed: boolean): Promise<unknown[]> => {
			let attempts = 0;
			const retryResolves: ApiKeyResolveContext[] = [];
			const hasUsableSibling = vi.fn(() => false);
			const fetchMock: FetchImpl = async () => {
				attempts += 1;
				if (attempts === 1) {
					return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "retry-after": "0" } });
				}
				return successResponse();
			};
			const stream = streamSimple(model, context, {
				apiKey: async ctx => {
					if (ctx.error !== undefined) retryResolves.push(ctx);
					return "key-A";
				},
				fetch: fetchMock,
				...(armed
					? {
							rateLimitRotation: {
								enabled: true,
								provider: "openai",
								minSleepMs: 0,
								hasUsableSibling,
							},
						}
					: {}),
			});
			const events: unknown[] = [];
			for await (const event of stream) {
				events.push(
					JSON.parse(
						JSON.stringify(event, (key, value) =>
							key === "timestamp" || key === "duration" || key === "ttft" ? 0 : value,
						),
					),
				);
			}
			expect((await stream.result()).stopReason).toBe("stop");
			// Same-key transport retry in both runs; the resolver never rotates.
			expect(attempts).toBe(2);
			expect(retryResolves).toEqual([]);
			// The armed run must actually consult the gate's sibling probe — that is
			// what distinguishes "armed but declined" from "never armed".
			if (armed) expect(hasUsableSibling).toHaveBeenCalled();
			return events;
		};

		const baseline = await run(false);
		const armed = await run(true);
		expect(baseline.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(armed).toEqual(baseline);
	});

	it("keeps opaque-body 429s in the transport backoff even with rotation on", async () => {
		let attempts = 0;
		const retryResolves: ApiKeyResolveContext[] = [];
		const onRotated = vi.fn();
		const hasUsableSibling = vi.fn(() => true);
		const fetchMock: FetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) {
				// Opaque body: nothing beyond the status → not a RATE_LIMIT_EXCEEDED
				// classification, so the surface gate must keep sleeping.
				return new Response("429", { status: 429, headers: { "retry-after": "0" } });
			}
			return successResponse();
		};

		const stream = streamSimple(model, context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryResolves.push(ctx);
				return "key-A";
			},
			fetch: fetchMock,
			rateLimitRotation: {
				enabled: true,
				provider: "openai",
				minSleepMs: 0,
				hasUsableSibling,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(attempts).toBe(2);
		expect(retryResolves).toEqual([]);
		expect(onRotated).not.toHaveBeenCalled();
		// Classification gates before the sibling probe.
		expect(hasUsableSibling).not.toHaveBeenCalled();
	});
});
