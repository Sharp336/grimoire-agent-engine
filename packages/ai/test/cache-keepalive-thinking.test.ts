// Regression suite for the Anthropic THINKING-ACTIVE prompt-cache keepalive touch: the
// default shape for a reasoning-enabled Claude session, and the one shape no test drove
// end to end before.
//
// Anthropic rejects `max_tokens: 0` while thinking is on, so this touch streams and
// aborts at the FIRST generation event instead. Two defects lived in exactly that gap,
// and each has a named failure mode below:
//
// 1. COST NEVER ACCRUED. `costUsd` was read only from the `done` event, which this touch
//    never reaches. Cumulative spend stayed 0 forever, so `evaluateWarm` could never
//    reach `economic-stop` and the advertised termination guarantee silently degraded to
//    the `maxTouches` safety net (24 touches of unbudgeted spend).
// 2. THE TOUCH WAS PRICED AT THE REQUEST'S CEILING. `warmOutputTokens` was
//    `payload.max_tokens` — 64k-128k on current Claude models — rather than the handful
//    of tokens the abort actually buys. That added dollars of imaginary output to every
//    decision, so the gate refused cache reads costing cents and the keepalive was
//    effectively off for the default configuration.
//
// Timing: no wall-clock sleeps. The policy's `onDecision` callback is the signal the
// implementation already emits for every touch and every skip, and `ttlSeconds` is
// compressed so the real scheduler runs at ~20ms intervals.
import { afterEach, describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { CacheKeepaliveRecord } from "@oh-my-pi/pi-ai/cache/keepalive";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

/** Round-trip margin the keepalive scheduler applies (`CACHE_KEEPALIVE_MARGIN_S`). */
const KEEPALIVE_MARGIN_S = 15;
/**
 * TTL chosen so the scheduler's own arithmetic — `min(ttl * 0.95, ttl - margin)` — yields
 * a 20ms interval, exercising the real timer path without a perceptible wait. The TTL sits
 * just *above* the margin: below it there is no schedulable deadline at all.
 */
const FAST_TTL_SECONDS = KEEPALIVE_MARGIN_S + 0.02;
/** Real published Opus-5 rates, USD per 1e6 tokens. */
const OPUS_RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const RATE_UNIT_TOKENS = 1e6;
/** Small enough that a couple of touches exhaust the economic budget. */
const BUDGET_PREFIX_TOKENS = 20_000;
/** A genuinely expensive prefix: exactly the case the keepalive exists to protect. */
const PRICING_PREFIX_TOKENS = 120_000;
/** What Anthropic already reports on `message_start`, before anything is generated. */
const TOUCH_OUTPUT_TOKENS = 2;

/**
 * Opus 5: adaptive thinking (version >= 4.6) and a 64k output ceiling, i.e. `max_tokens`
 * some four orders of magnitude above what an aborted touch emits.
 */
const thinkingModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: OPUS_RATES,
	contextWindow: 200_000,
	maxTokens: 64_000,
});

const context: Context = { messages: [{ role: "user", content: "Keep this prefix warm.", timestamp: 1 }] };

function usage(cacheRead: number, cacheWrite: number, output: number): Record<string, unknown> {
	return {
		input_tokens: 0,
		output_tokens: output,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: cacheWrite,
		cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 },
	};
}

function sseBody(events: Array<Record<string, unknown>>): string {
	return `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

/** The real turn that populates the cache: a write, which is what arms the chain. */
function primingResponse(prefixTokens: number): Response {
	return new Response(
		sseBody([
			{ type: "message_start", message: { id: "msg_priming", usage: usage(0, prefixTokens, 0) } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usage(0, prefixTokens, 1) },
			{ type: "message_stop" },
		]),
		{ status: 200, headers: { "Content-Type": "text/event-stream", "request-id": "req_priming" } },
	);
}

/**
 * A thinking touch as Anthropic really answers one: usage on `message_start`, then a
 * thinking block opens and the stream stays open. The keepalive aborts at that first
 * generation event, so `done` never arrives — which is precisely why cost had to be read
 * from partial usage.
 */
function thinkingTouchResponse(
	signal: AbortSignal | null | undefined,
	prefixTokens: number,
	onAbort: () => void,
): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encoder.encode(
					sseBody([
						{
							type: "message_start",
							message: {
								id: "msg_touch",
								usage: usage(prefixTokens, 0, TOUCH_OUTPUT_TOKENS),
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "thinking", thinking: "", signature: "" },
						},
					]),
				),
			);
			const closeOnAbort = () => {
				onAbort();
				controller.close();
			};
			if (signal?.aborted) closeOnAbort();
			else signal?.addEventListener("abort", closeOnAbort, { once: true });
		},
		cancel() {
			onAbort();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_thinking_touch" },
	});
}

interface Harness {
	bodies: MessageCreateParams[];
	decisions: CacheKeepaliveRecord[];
	/** Touches that were cut short at the first generation event, i.e. never reached `done`. */
	abortedTouches: number;
	/** Resolves once `count` decisions have been reported. */
	awaitDecisions(count: number): Promise<void>;
	states: Map<string, ProviderSessionState>;
	record: (entry: CacheKeepaliveRecord) => void;
	fetch: FetchImpl;
}

const harnesses: Harness[] = [];

function harness(prefixTokens: number): Harness {
	const pending: Array<{ count: number; resolve: () => void }> = [];
	const bodies: MessageCreateParams[] = [];
	const decisions: CacheKeepaliveRecord[] = [];
	const instance: Harness = {
		bodies,
		decisions,
		abortedTouches: 0,
		states: new Map<string, ProviderSessionState>(),
		awaitDecisions(count) {
			if (decisions.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			pending.push({ count, resolve });
			return promise;
		},
		record(entry) {
			decisions.push(entry);
			for (const waiter of pending.splice(0)) {
				if (decisions.length >= waiter.count) waiter.resolve();
				else pending.push(waiter);
			}
		},
		async fetch(input, init) {
			const isPriming = bodies.length === 0;
			bodies.push(JSON.parse(String(init?.body ?? "{}")) as MessageCreateParams);
			if (isPriming) return primingResponse(prefixTokens);
			const signal = input instanceof Request ? input.signal : init?.signal;
			return thinkingTouchResponse(signal, prefixTokens, () => {
				instance.abortedTouches += 1;
			});
		},
	};
	harnesses.push(instance);
	return instance;
}

interface DriveOverrides {
	prefixTokens: number;
	resumeProbability: number;
	maxTouches: number;
}

async function drive(instance: Harness, overrides: DriveOverrides): Promise<void> {
	const stream = streamSimple(thinkingModel, context, {
		fetch: instance.fetch,
		apiKey: "test-anthropic-key",
		anthropicCacheRefresh: true,
		providerSessionState: instance.states,
		sessionId: "thinking-keepalive-session",
		cacheKeepalivePolicy: {
			resumeProbability: () => overrides.resumeProbability,
			prefixTokens: () => overrides.prefixTokens,
			maxTouches: overrides.maxTouches,
			ttlSeconds: FAST_TTL_SECONDS,
			onDecision: instance.record,
		},
	});
	for await (const _event of stream) {
		// Drain the public response before the idle gap begins.
	}
	await stream.result();
}

afterEach(() => {
	for (const instance of harnesses.splice(0)) {
		for (const state of instance.states.values()) state.close();
		instance.states.clear();
	}
});

withOfficialAnthropicEndpoint();

describe("Anthropic thinking-active keepalive touch", () => {
	it("bills an aborted touch, so the chain halts on the budget instead of on maxTouches", async () => {
		const instance = harness(BUDGET_PREFIX_TOKENS);
		// THE regression. Every touch here aborts at the first generation event and never
		// reaches `done`, which is where `costUsd` used to be read. With cost stuck at 0,
		// `cumulativeWarmCostUsd` never grew, `remainingBudgetUsd` never shrank, and
		// `economic-stop` — the only branch that makes termination a guarantee rather than a
		// 24-touch cap — was unreachable on the default Anthropic path.
		//
		// Arithmetic at these rates: avoidable loss 20k*(6.25-0.5)/1e6 = $0.115, expected
		// value 0.3 * that = $0.0345, budget 0.7 * that = $0.02415. Each touch costs
		// ~$0.01005 (the 20k-token cache read plus two output tokens) and the gate needs
		// `nextWarmCost < remainingBudget`, so the third decision must stop: 0.0102 against
		// $0.00405 left. `maxTouches` is 8, far out of reach, so it cannot be the reason.
		await drive(instance, { prefixTokens: BUDGET_PREFIX_TOKENS, resumeProbability: 0.3, maxTouches: 8 });
		await instance.awaitDecisions(3);

		expect(instance.decisions.map(entry => entry.decision.action)).toEqual(["warm", "warm", "economic-stop"]);
		// Non-zero cost on a touch that never reached `done` is the fix itself.
		expect(instance.decisions[0]?.costUsd).toBeGreaterThan(0);
		expect(instance.decisions[1]?.costUsd).toBeGreaterThan(0);
		// Cumulative spend really did move the ceiling: the second decision saw less budget.
		const first = instance.decisions[0]?.decision;
		const second = instance.decisions[1]?.decision;
		expect(second?.remainingBudgetUsd).toBeLessThan(first?.remainingBudgetUsd ?? 0);
		// Both touches were cut short, so `done` was never the source of that cost.
		expect(instance.abortedTouches).toBe(2);
		// Priming request plus exactly two touches; the stop issued no request.
		expect(instance.bodies).toHaveLength(3);
		expect(instance.decisions[2]?.outcome).toBeUndefined();
	});

	it("prices the touch by what the abort emits, not by the request's output ceiling", async () => {
		const instance = harness(PRICING_PREFIX_TOKENS);
		// Regression for pricing `warmOutputTokens` at `payload.max_tokens`. At a 64k ceiling
		// and $25/1e6 output that is $1.60 of output the touch never produces, against a
		// $0.69 avoidable loss — so the gate returned `skip-not-economic` for a 120k-token
		// Opus prefix, the single most valuable entry it could possibly keep warm.
		await drive(instance, { prefixTokens: PRICING_PREFIX_TOKENS, resumeProbability: 0.95, maxTouches: 2 });
		await instance.awaitDecisions(1);

		const decision = instance.decisions[0]?.decision;
		expect(decision?.action).toBe("warm");
		// The cache read is irreducible; what must not appear is an output term sized by the
		// ceiling. Everything above the read must stay under a cent (it was $1.60).
		const cacheReadTermUsd = (PRICING_PREFIX_TOKENS * OPUS_RATES.cacheRead) / RATE_UNIT_TOKENS;
		expect((decision?.nextWarmCostUsd ?? 0) - cacheReadTermUsd).toBeLessThan(0.01);
		expect(decision?.nextWarmCostUsd ?? 0).toBeLessThan((decision?.avoidableLossUsd ?? 0) * 0.1);

		// Only the *pricing* changed: the replayed body still carries the request's own
		// `max_tokens`. Lowering it on the wire would make the touch differ from the cached
		// request by more than output bounding, and Anthropic rejects a `max_tokens` below
		// the thinking budget outright.
		const primingMaxTokens = instance.bodies[0]?.max_tokens ?? 0;
		expect(primingMaxTokens).toBeGreaterThan(10_000);
		expect(instance.bodies[1]?.max_tokens).toBe(primingMaxTokens);
		expect(instance.bodies[1]?.stream).toBe(true);
	});
});
