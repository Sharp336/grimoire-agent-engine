/**
 * Contract: the `streamSimple` auth-retry driver treats transport-surfaced
 * rate-limit marker errors as direct credential rotations (skip refresh-same,
 * notify `rateLimitRotation.onRotated`), stays replay-safe, and — when the
 * resolver declines to rotate — degrades to a bounded in-place stall-sleep
 * plus same-key reattempt instead of surfacing a terminal 429 the transport
 * would have absorbed.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai";
import {
	formatSurfacedRateLimitMessage,
	RATE_LIMIT_STALL_MAX_RETRIES,
	registerCustomApi,
	unregisterCustomApis,
} from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { logger } from "@oh-my-pi/pi-utils";

const SOURCE_ID = "stream-rate-limit-rotation-test";
const API = "stream-rate-limit-rotation-test" as Api;

const SURFACED_MESSAGE = formatSurfacedRateLimitMessage("429 Too many requests", 12_000);

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "test-provider",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function surfacedErrorMessage(): AssistantMessage {
	return { ...assistant(), stopReason: "error", errorMessage: SURFACED_MESSAGE, errorStatus: 429 };
}

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: API,
		provider: "test-provider",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function ok(stream: AssistantMessageEventStream): void {
	const message = assistant(["ok"]);
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
}

function failSurfaced(stream: AssistantMessageEventStream): void {
	stream.push({ type: "start", partial: assistant() });
	stream.push({ type: "error", reason: "error", error: surfacedErrorMessage() });
}

describe("streamSimple surfaced rate-limit rotation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		unregisterCustomApis(SOURCE_ID);
	});

	it("rotates directly to a sibling and fires onRotated once", async () => {
		const keys: unknown[] = [];
		const retryContexts: ApiKeyResolveContext[] = [];
		const onRotated = vi.fn();
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (options?.apiKey === "key-B" ? ok(stream) : failSurfaced(stream)));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryContexts.push(ctx);
				return ctx.error === undefined ? "key-A" : "key-B";
			},
			rateLimitRotation: {
				enabled: true,
				provider: "test-provider",
				minSleepMs: 2_000,
				hasUsableSibling: () => true,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["key-A", "key-B"]);
		// Direct rotation: the single retry resolve is already the switch step.
		expect(retryContexts.map(ctx => ctx.lastChance)).toEqual([true]);
		expect((retryContexts[0]!.error as Error).message).toBe(SURFACED_MESSAGE);
		expect(onRotated).toHaveBeenCalledTimes(1);
		expect(onRotated).toHaveBeenCalledWith({ provider: "test-provider", modelId: "test-model" });
	});

	it("does not rotate once replay-unsafe content has been emitted", async () => {
		let retryResolves = 0;
		const failure = Object.assign(new Error(SURFACED_MESSAGE), { status: 429 });
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({ type: "text_start", contentIndex: 0, partial: assistant([""]) });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: assistant(["partial"]) });
					stream.fail(failure);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryResolves += 1;
				return ctx.error === undefined ? "key-A" : "key-B";
			},
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		// Same error instance surfaces (no rotation once replay-unsafe content is
		// out), but the internal rotation marker is stripped in place on this
		// direct terminal-fail path — the user sees a clean 429.
		expect(caught).toBe(failure);
		expect((caught as Error).message).not.toContain("; rate limit surfaced for rotation");
		expect((caught as Error).message).toContain("429 Too many requests");
		expect(retryResolves).toBe(0);
	});

	it("strips the marker from a terminal error EVENT after replay-unsafe content, without rotating", async () => {
		// Distinct from the thrown-failure path above: the transport emits a
		// terminal `error` EVENT (stopReason: "error" message) after content
		// already streamed. That event bypasses both the buffered-retry return and
		// the catch-path stripper, so the driver must strip the marker in place on
		// the direct event-forwarding branch.
		const keys: unknown[] = [];
		let retryResolves = 0;
		const onRotated = vi.fn();
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({ type: "text_start", contentIndex: 0, partial: assistant([""]) });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: assistant(["partial"]) });
					stream.push({ type: "error", reason: "error", error: surfacedErrorMessage() });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryResolves += 1;
				return ctx.error === undefined ? "key-A" : "key-B";
			},
			rateLimitRotation: {
				enabled: true,
				provider: "test-provider",
				minSleepMs: 2_000,
				hasUsableSibling: () => true,
				onRotated,
			},
		});
		const events: Array<{ type: string; errorMessage?: string }> = [];
		for await (const event of stream) {
			events.push({
				type: event.type,
				...(event.type === "error" ? { errorMessage: event.error.errorMessage } : {}),
			});
		}
		const result = await stream.result();

		// The error event is forwarded (content made replay unsafe) with the
		// internal marker stripped and the base 429 text intact.
		const errorEvent = events.find(event => event.type === "error");
		expect(errorEvent?.errorMessage).not.toContain("; rate limit surfaced for rotation");
		expect(errorEvent?.errorMessage).toContain("429 Too many requests");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("; rate limit surfaced for rotation");
		// No rotation once replay-unsafe content is out: single attempt, no
		// resolver retry, no rotation notification.
		expect(keys).toEqual(["key-A"]);
		expect(retryResolves).toBe(0);
		expect(onRotated).not.toHaveBeenCalled();
	});

	it("stalls in place and reattempts the SAME key when rotation declines", async () => {
		const keys: unknown[] = [];
		let initialResolves = 0;
		const onRotated = vi.fn();
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (keys.length === 1 ? failSurfaced(stream) : ok(stream)));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			// Rotation declined: the sibling raced away between surface and rotate.
			apiKey: async ctx => {
				if (ctx.error === undefined) initialResolves += 1;
				return ctx.error === undefined ? "key-A" : undefined;
			},
			rateLimitRotation: {
				enabled: true,
				provider: "test-provider",
				minSleepMs: 2_000,
				hasUsableSibling: () => false,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		// Same-key reattempt after sleeping the embedded hint — not a terminal 429.
		expect(keys).toEqual(["key-A", "key-A"]);
		expect(wait.mock.calls.map(call => call[0])).toContain(12_000);
		// The post-stall reattempt re-resolves (fresh token) instead of replaying
		// the captured bearer: one initial resolve plus one post-stall resolve.
		expect(initialResolves).toBe(2);
		// Re-resolving to the SAME key is not a rotation.
		expect(onRotated).not.toHaveBeenCalled();
	});

	it("picks up a sibling freed during the stall sleep via the post-stall re-resolve", async () => {
		const keys: unknown[] = [];
		let initialResolves = 0;
		const onRotated = vi.fn();
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (options?.apiKey === "key-B" ? ok(stream) : failSurfaced(stream)));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			// Rotation declines while the pool is saturated, but key-B frees during
			// the stall sleep: the post-stall initial resolve re-ranks onto it.
			apiKey: async ctx => {
				if (ctx.error !== undefined) return undefined;
				initialResolves += 1;
				return initialResolves === 1 ? "key-A" : "key-B";
			},
			rateLimitRotation: {
				enabled: true,
				provider: "test-provider",
				minSleepMs: 2_000,
				hasUsableSibling: () => false,
				onRotated,
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["key-A", "key-B"]);
		expect(wait.mock.calls.map(call => call[0])).toContain(12_000);
		// No credential_rotated on the stall path: rotation was DECLINED, and the
		// re-resolve's least-bad selection can return a still-blocked credential —
		// announcing a rotation right before a possible repeat 429 would be a
		// false UI event. The freed sibling surfaces through the success above.
		expect(onRotated).not.toHaveBeenCalled();
	});

	it("bounds the stall fallback and then surfaces the terminal failure", async () => {
		const keys: unknown[] = [];
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => failSurfaced(stream));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "key-A" : undefined),
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		// The internal rotation marker is stripped at the terminal emission point:
		// the user sees a clean 429, not the surfaced-for-rotation suffix.
		expect(result.errorMessage).not.toContain("; rate limit surfaced for rotation");
		expect(result.errorMessage).toContain("429 Too many requests");
		// Initial attempt + exactly RATE_LIMIT_STALL_MAX_RETRIES stall reattempts.
		expect(keys).toEqual(new Array(1 + RATE_LIMIT_STALL_MAX_RETRIES).fill("key-A"));
		expect(wait.mock.calls.filter(call => call[0] === 12_000)).toHaveLength(RATE_LIMIT_STALL_MAX_RETRIES);
		// One logical stall = one warn: the per-driver latch collapses all
		// RATE_LIMIT_STALL_MAX_RETRIES stall reattempts into a single log.
		expect(warn.mock.calls.filter(call => call[0] === "rate_limit_stall")).toHaveLength(1);
	});

	it("aborts during the in-place stall sleep and surfaces the clean terminal failure", async () => {
		const keys: unknown[] = [];
		const controller = new AbortController();
		// The abort lands inside the stall sleep: fire it and reject like the real
		// scheduler does when its signal aborts.
		const wait = vi.spyOn(scheduler, "wait").mockImplementation(async () => {
			controller.abort();
			throw new DOMException("The operation was aborted", "AbortError");
		});
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => failSurfaced(stream));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "key-A" : undefined),
			signal: controller.signal,
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		// Aborted stall still emits a clean 429 — marker stripped, base preserved.
		expect(result.errorMessage).not.toContain("; rate limit surfaced for rotation");
		expect(result.errorMessage).toContain("429 Too many requests");
		// The reject broke the loop before any same-key reattempt: initial run only.
		expect(keys).toEqual(["key-A"]);
		expect(wait).toHaveBeenCalledTimes(1);
	});

	it("keeps non-marker transient 429 failures terminal without stalling (baseline pin)", async () => {
		const keys: unknown[] = [];
		const retryResolves: ApiKeyResolveContext[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...assistant(),
							stopReason: "error",
							errorMessage: "Cloud Code Assist API error (429): Too many requests",
							errorStatus: 429,
						},
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryResolves.push(ctx);
				return ctx.error === undefined ? "key-A" : "key-B";
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		// Without the marker, the provider's own backoff owns transient 429s:
		// no rotation, no stall, single attempt.
		expect(result.stopReason).toBe("error");
		expect(retryResolves).toEqual([]);
		expect(keys).toEqual(["key-A"]);
	});
});
