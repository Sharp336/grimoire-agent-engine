// Regression: a keepalive touch must not advance Antigravity's conversation bookkeeping.
//
// `google-antigravity` keeps `stepIndex` and `lastExecutionId` in the provider session
// state, and BUILDING a request mutates them: `buildAntigravityRequestEnvelope` does
// `state.stepIndex = (state.stepIndex ?? 1) + 1`, and a fully successful response commits
// `state.lastExecutionId = lastResponseId`.
//
// A touch replays a captured body, so the envelope it builds is discarded before it ever
// reaches the wire — the mutation buys nothing at all. But when the touch shared the
// session's state map it still paid for it twice over: the next real turn reported a step
// index with a gap in it, and named a hidden one-token reply as its `last_execution_id`,
// even though that reply is absent from the conversation the server is tracking.
//
// The assertions here read the EMITTED envelope of the second real turn rather than the
// private state object, because that is what the server sees.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { CacheKeepaliveRecord } from "@oh-my-pi/pi-ai/cache/keepalive";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Round-trip margin the keepalive scheduler reserves (`CACHE_KEEPALIVE_MARGIN_S`). */
const KEEPALIVE_MARGIN_S = 15;
/** Interval the TTL below produces: `ttl - margin` = 20ms. */
const TOUCH_INTERVAL_MS = 20;
const PREFIX_TOKENS = 120_000;

const stateMaps: Array<Map<string, ProviderSessionState>> = [];

afterEach(() => {
	for (const states of stateMaps.splice(0)) {
		for (const state of states.values()) state.close();
		states.clear();
	}
	vi.restoreAllMocks();
});

function antigravityModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3-pro-preview",
		name: "Antigravity Gemini 3 Pro",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

/**
 * One Cloud Code Assist chunk reporting a cache read, so the keepalive arms, plus the
 * `responseId` that becomes the NEXT request's `last_execution_id`.
 */
function antigravityResponse(responseId: string, cachedTokens: number): Response {
	const chunk = {
		response: {
			responseId,
			candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
			usageMetadata: {
				promptTokenCount: PREFIX_TOKENS,
				candidatesTokenCount: 1,
				totalTokenCount: PREFIX_TOKENS + 1,
				cachedContentTokenCount: cachedTokens,
			},
		},
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface Envelope {
	requestId?: string;
	request?: { labels?: Record<string, string> };
}

describe("Antigravity conversation bookkeeping across a keepalive touch", () => {
	it("does not let a touch consume a step index or become the next turn's predecessor", async () => {
		const bodies: Envelope[] = [];
		const decisions: CacheKeepaliveRecord[] = [];
		const { promise: touched, resolve: onTouch } = Promise.withResolvers<void>();
		const fetchMock: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body ?? "{}")) as Envelope);
			// Every response carries a cache read so the chain keeps arming, and a distinct
			// id so `last_execution_id` identifies exactly which request it came from.
			return antigravityResponse(`resp-${bodies.length}`, PREFIX_TOKENS);
		};
		const states = new Map<string, ProviderSessionState>();
		stateMaps.push(states);

		const context: Context = { messages: [{ role: "user", content: "first", timestamp: 1 }] };
		const options = {
			fetch: fetchMock,
			apiKey: JSON.stringify({ token: "probe-token", projectId: "probe-project" }),
			maxTokens: 4096,
			cacheRetention: "short" as const,
			anthropicCacheRefresh: true,
			providerSessionState: states,
			sessionId: "antigravity-keepalive-session",
			cacheKeepalivePolicy: {
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: KEEPALIVE_MARGIN_S + 0.02,
				maxTouches: 1,
				onDecision: (record: CacheKeepaliveRecord) => {
					decisions.push(record);
					onTouch();
				},
			},
		};

		const first = streamSimple(antigravityModel(), context, options);
		for await (const _event of first) {
			// Drain the priming response before the idle gap begins.
		}
		const firstReply = await first.result();

		// The chain armed and issued its touch — without this the test proves nothing.
		await touched;
		expect(decisions).toHaveLength(1);
		expect(bodies).toHaveLength(2);

		const firstStep = bodies[0]?.request?.labels?.last_step_index;
		expect(firstStep).toBe("1");

		const second = streamSimple(
			antigravityModel(),
			{
				messages: [...context.messages, firstReply, { role: "user", content: "second", timestamp: 3 }],
			},
			options,
		);
		for await (const _event of second) {
			// Drain.
		}
		await second.result();
		expect(bodies).toHaveLength(3);

		const secondLabels = bodies[2]?.request?.labels;
		// The second real turn is step 3, so it reports the FIRST turn's step as its
		// predecessor. A shared state map made the touch consume step 3, pushing this to "3".
		expect(secondLabels?.last_step_index).toBe("2");
		// And it chains from the first turn's response, not from the invisible touch's.
		// `resp-2` is the touch: naming it would point the server at a reply that is not in
		// the conversation.
		expect(secondLabels?.last_execution_id).toBe("resp-1");
	});

	it("keeps the session's Antigravity state alive after a touch", async () => {
		// The other half of the isolation contract: the touch's throwaway state map is
		// closed and cleared when it finishes, and that cleanup must not reach the session's
		// own entry.
		const bodies: Envelope[] = [];
		const { promise: touched, resolve: onTouch } = Promise.withResolvers<void>();
		const fetchMock: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body ?? "{}")) as Envelope);
			return antigravityResponse(`resp-${bodies.length}`, PREFIX_TOKENS);
		};
		const states = new Map<string, ProviderSessionState>();
		stateMaps.push(states);

		const stream = streamSimple(
			antigravityModel(),
			{ messages: [{ role: "user", content: "warm", timestamp: 1 }] },
			{
				fetch: fetchMock,
				apiKey: JSON.stringify({ token: "probe-token", projectId: "probe-project" }),
				maxTokens: 4096,
				cacheRetention: "short" as const,
				anthropicCacheRefresh: true,
				providerSessionState: states,
				sessionId: "antigravity-isolation-session",
				cacheKeepalivePolicy: {
					resumeProbability: () => 0.95,
					prefixTokens: () => PREFIX_TOKENS,
					ttlSeconds: KEEPALIVE_MARGIN_S + 0.02,
					maxTouches: 1,
					onDecision: () => onTouch(),
				},
			},
		);
		for await (const _event of stream) {
			// Drain.
		}
		await stream.result();

		const keysAfterPriming = [...states.keys()].sort();
		expect(keysAfterPriming.length).toBeGreaterThan(0);

		await touched;
		await Bun.sleep(TOUCH_INTERVAL_MS);

		// Same keys, same instances: nothing the touch did swept the live map.
		expect([...states.keys()].sort()).toEqual(keysAfterPriming);
	});
});
