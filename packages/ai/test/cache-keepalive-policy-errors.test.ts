// Regression suite: a caller-supplied cache-keepalive policy that THROWS must not damage
// the request it was attached to, and must not wedge the lease.
//
// Two distinct failure modes, both reachable from ordinary SDK use (`CacheKeepalivePolicy`
// is supplied by the caller, and a session that reads a persisted TTL profile or resolves a
// fingerprint can fail at any moment):
//
// 1. TIMER-TIME THROW (`prefixTokens`, `resumeProbability`). `#schedule` clears `#timer`
//    *before* invoking `void this.#touch(generation)`, and the policy is consulted at the
//    top of `#touch`, outside the touch request's own `try`. A throw there escaped as a
//    rejected promise nobody handled — an unhandled rejection — and left the lease armed
//    with a plan, unspent budget, and no pending timer: it never touched again and never
//    released its state.
// 2. ARM-TIME THROW (`fingerprint`, `ttlSeconds`, `maxTouches`). `arm` runs inline on the
//    priming turn's `done` event inside the stream pump, whose `catch` calls
//    `outer.fail(error)`. A throw there failed the REAL response — the one thing a
//    keepalive, which exists purely to save money, must never do.
//
// Timing note, and why fake timers are not used here. Every test whose assertion is the
// PRESENCE of a touch awaits the implementation's own `onDecision` callback, never a delay.
// The tests whose assertion is the ABSENCE of a further touch cannot do that — there is no
// event to await — and they cannot advance a fake clock either: the chain reschedules itself
// from inside the async completion of a real streaming request, so a frozen clock would
// simply stall the I/O those completions wait on. They therefore hold open a real window,
// with the interval compressed to ~20ms by a TTL just above the scheduler's 15s round-trip
// margin — the same trick, for the same reason, as the sibling
// `cache-keepalive-bedrock.test.ts` suite.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { CacheKeepalivePolicy, CacheKeepaliveRecord } from "@oh-my-pi/pi-ai/cache/keepalive";
import type { Api, AssistantMessage, Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Round-trip margin the scheduler reserves (`CACHE_KEEPALIVE_MARGIN_S` in `src/stream.ts`). */
const KEEPALIVE_MARGIN_S = 15;
/** Makes the scheduler's own `min(ttl * 0.95, ttl - margin)` resolve to `TOUCH_INTERVAL_MS`. */
const FAST_TTL_SECONDS = KEEPALIVE_MARGIN_S + 0.02;
/** What `FAST_TTL_SECONDS` resolves to. */
const TOUCH_INTERVAL_MS = 20;
/**
 * Idle window held open after a throw. Five intervals: a chain that survived the throw had
 * room for five further touches, so an empty window is real evidence it ended.
 */
const IDLE_WINDOW_MS = TOUCH_INTERVAL_MS * 5;
const PREFIX_TOKENS = 120_000;

const context: Context = { messages: [{ role: "user", content: "keep warm", timestamp: 1 }] };

const stateMaps: Array<Map<string, ProviderSessionState>> = [];
const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => {
	unhandled.push(reason);
};

beforeEach(() => {
	unhandled.length = 0;
	process.on("unhandledRejection", recordUnhandled);
});

afterEach(() => {
	process.off("unhandledRejection", recordUnhandled);
	for (const states of stateMaps.splice(0)) {
		for (const state of states.values()) state.close();
		states.clear();
	}
	vi.restoreAllMocks();
});

function probeModel(): Model<Api> {
	return buildModel({
		id: "probe-openai-completions",
		name: "probe openai-completions",
		api: "openai-completions",
		provider: "probe-provider",
		baseUrl: "https://probe.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	}) as Model<Api>;
}

/**
 * An OpenAI-completions turn reporting a cache read.
 *
 * Every request in this file gets one, priming and touch alike: a healthy chain therefore
 * keeps touching forever, so "no further body reached the wire" can only mean the policy
 * failure ended the chain — never that the provider declined to verify a touch.
 */
function cacheHitResponse(): Response {
	const chunks: Array<Record<string, unknown>> = [
		{ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
		{
			id: "c1",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: PREFIX_TOKENS,
				completion_tokens: 1,
				total_tokens: PREFIX_TOKENS + 1,
				prompt_tokens_details: { cached_tokens: PREFIX_TOKENS },
			},
		},
	];
	const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Run one real turn through `streamSimple`, recording every body that reaches the wire. */
async function turn(
	policy: CacheKeepalivePolicy,
	states: Map<string, ProviderSessionState>,
	bodies: Array<Record<string, unknown>>,
): Promise<AssistantMessage> {
	const fetchMock: FetchImpl = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
		return cacheHitResponse();
	};
	const stream = streamSimple(probeModel(), context, {
		fetch: fetchMock,
		apiKey: "probe-key",
		maxTokens: 4096,
		cacheRetention: "short",
		anthropicCacheRefresh: true,
		providerSessionState: states,
		sessionId: "policy-error-session",
		cacheKeepalivePolicy: policy,
	});
	for await (const _event of stream) {
		// Drain the response before the idle gap begins.
	}
	return await stream.result();
}

function freshStates(): Map<string, ProviderSessionState> {
	const states = new Map<string, ProviderSessionState>();
	stateMaps.push(states);
	return states;
}

describe("the harness itself touches, so an absent touch is evidence", () => {
	it("keeps touching while the policy is healthy", async () => {
		// Non-vacuity for every test below. Without this, "only one body reached the wire"
		// could just mean this fixture never arms a chain at all, and the whole file would
		// pass against an implementation that had silently stopped keeping caches warm.
		// Two touches, not one: an implementation that armed and then died on its first tick
		// would satisfy a `> 1` bound while keeping nothing warm.
		const bodies: Array<Record<string, unknown>> = [];
		const { promise: twoTouches, resolve: sawTwoTouches } = Promise.withResolvers<void>();
		let reports = 0;
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				maxTouches: 8,
				onDecision: () => {
					reports++;
					if (reports === 2) sawTwoTouches();
				},
			},
			freshStates(),
			bodies,
		);
		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		// Awaited on the chain's own second decision, so the passing path adds no fixed delay;
		// the race bound only makes a regression fail on the count below, not as a timeout.
		await Promise.race([twoTouches, Bun.sleep(IDLE_WINDOW_MS)]);
		expect(bodies.length).toBeGreaterThan(2);
	});
});

describe("a policy that throws at decision time ends the chain instead of wedging it", () => {
	it("contains a throwing prefixTokens()", async () => {
		// Failure mode: `#decide` runs outside the touch's `try`, so this throw escaped
		// `void this.#touch(generation)` as an unhandled rejection and left the lease armed
		// with no pending timer — permanently silent, never released.
		const bodies: Array<Record<string, unknown>> = [];
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => {
					throw new Error("prefix accounting exploded");
				},
				ttlSeconds: FAST_TTL_SECONDS,
				maxTouches: 8,
			},
			freshStates(),
			bodies,
		);

		// The priming turn is the caller's actual request; a broken keepalive may not touch it.
		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		expect(result.stopReason).toBe("stop");
		await Bun.sleep(IDLE_WINDOW_MS);
		// The throw happens before the touch request is issued, so the priming body is the
		// only one that ever reached the wire.
		expect(bodies).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});

	it("contains a throwing resumeProbability()", async () => {
		// Same path as above, via the other half of the economic gate: the chain must end,
		// not retry, because a policy that cannot price this touch cannot price the next.
		const bodies: Array<Record<string, unknown>> = [];
		const result = await turn(
			{
				resumeProbability: () => {
					throw new Error("resume estimate exploded");
				},
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				maxTouches: 8,
			},
			freshStates(),
			bodies,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});
});

describe("a policy that throws at arm time cannot fail the real response", () => {
	it("contains a throwing fingerprint()", async () => {
		// Failure mode: `arm` -> `#schedule` reads the fingerprint for the jitter key while
		// still inside the stream pump's `try`, so this throw reached `outer.fail(error)` and
		// the caller's own turn died of a keepalive bookkeeping error.
		const bodies: Array<Record<string, unknown>> = [];
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				maxTouches: 8,
				fingerprint: () => {
					throw new Error("fingerprint resolution exploded");
				},
			},
			freshStates(),
			bodies,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		expect(result.stopReason).toBe("stop");
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});

	it("contains a throwing ttlSeconds getter", async () => {
		// `ttlSeconds` is a synchronous getter over a persisted TTL profile, so a failed
		// prefetch surfaces here rather than as a rejected promise.
		const bodies: Array<Record<string, unknown>> = [];
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				get ttlSeconds(): number {
					throw new Error("ttl profile read exploded");
				},
				maxTouches: 8,
			},
			freshStates(),
			bodies,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});

	it("contains a throwing maxTouches accessor", async () => {
		// The budget read is the first policy access `arm` makes, before any scheduling.
		const bodies: Array<Record<string, unknown>> = [];
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				get maxTouches(): number {
					throw new Error("budget read exploded");
				},
			},
			freshStates(),
			bodies,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});

	it("contains a throwing ttlReady getter", async () => {
		// Regression for the async surface itself. The deferred-arm support reads
		// `policy.ttlReady` to decide whether to wait for a learned TTL; that read is
		// caller-supplied code like every other, and it was briefly OUTSIDE arm's containment
		// try — so a throwing getter escaped straight through the priming `done` pump and
		// failed the caller's real response, reopening the exact hole this suite closes.
		const bodies: Array<Record<string, unknown>> = [];
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				get ttlReady(): Promise<unknown> | undefined {
					throw new Error("ttlReady read exploded");
				},
			},
			freshStates(),
			bodies,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		expect(result.stopReason).toBe("stop");
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});

	it("contains a hostile thenable whose then() throws", async () => {
		// `ttlReady` is typed as a promise but is only structurally a thenable at runtime, and
		// `then` may itself be an accessor. Calling it directly would throw synchronously
		// inside `arm`; assimilating through `Promise.resolve` turns that into a rejection the
		// lease owns.
		const bodies: Array<Record<string, unknown>> = [];
		// Defined dynamically rather than as a literal `then` member: the shape under test is
		// a thenable whose `then` is a throwing accessor, which is precisely what static
		// lint rules exist to stop anyone writing on purpose.
		// biome-ignore lint/suspicious/noThenProperty: the throwing accessor is the subject under test
		const hostile = Object.defineProperty({}, "then", {
			get(): never {
				throw new Error("then accessor exploded");
			},
		}) as Promise<unknown>;
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				ttlReady: hostile,
			},
			freshStates(),
			bodies,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		expect(result.stopReason).toBe("stop");
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});
});

describe("a throwing onDecision stays advisory", () => {
	it("keeps the chain alive and raises no unhandled rejection", async () => {
		// `onDecision` is pure telemetry, and the interface documents a throw as swallowed —
		// so unlike the pricing callbacks it must NOT end the chain. Pinned here because the
		// containment added for the others is easy to over-apply to this one, which would
		// silently disable the keepalive for any session whose telemetry sink is broken.
		const bodies: Array<Record<string, unknown>> = [];
		const { promise: twoTouches, resolve: sawTwoTouches } = Promise.withResolvers<void>();
		let reports = 0;
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				maxTouches: 8,
				onDecision: () => {
					reports++;
					if (reports === 2) sawTwoTouches();
					throw new Error("telemetry sink exploded");
				},
			},
			freshStates(),
			bodies,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		// Resolves on the SECOND decision, i.e. the chain touched again after the first
		// throwing report. Awaiting one decision would be satisfied by a chain that died right
		// after its first touch, which is what over-applying the pricing-callback containment
		// to telemetry produces. Raced against the idle window purely so that regression fails
		// on the body count below rather than as an opaque suite timeout; the passing path
		// never waits for it.
		await Promise.race([twoTouches, Bun.sleep(IDLE_WINDOW_MS)]);
		expect(bodies.length).toBeGreaterThan(2);
		expect(unhandled).toEqual([]);
	});
});

describe("a failed policy releases the lease", () => {
	it("does not block the next request on the same provider session state", async () => {
		// The wedge left state in the session map that was armed but timer-less. This proves
		// the recovery path end to end: the next turn on the SAME state arms a fresh chain
		// and its touch reaches the wire.
		const states = freshStates();
		const bodies: Array<Record<string, unknown>> = [];
		await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => {
					throw new Error("prefix accounting exploded");
				},
				ttlSeconds: FAST_TTL_SECONDS,
				maxTouches: 8,
			},
			states,
			bodies,
		);
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);

		const { promise, resolve } = Promise.withResolvers<void>();
		const healthy = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				maxTouches: 1,
				onDecision: () => resolve(),
			},
			states,
			bodies,
		);
		expect(healthy.content[0]).toMatchObject({ type: "text", text: "ok" });
		// Awaited on the implementation's own decision callback rather than a guessed delay.
		await promise;
		expect(bodies).toHaveLength(3);
		expect(unhandled).toEqual([]);
	});
});

describe("arming waits for a policy still loading its learned TTL", () => {
	it("schedules the first lease from the learned TTL even when the response lands first", async () => {
		// Regression. The coding-agent reads its learned per-route TTL off disk and starts
		// that read on the request path, fire-and-forget. Nothing made arming wait for it, so
		// a response that arrived before the read resolved armed from the nominal 300s
		// lifetime — and on a route whose real retention is shorter, the first touch then
		// fires after the entry has already expired, rebuilds the cache, and ends the chain.
		// The learned value could only ever help a later chain that may never happen.
		//
		// This drives exactly that ordering: the profile promise is UNRESOLVED when the turn
		// completes, so `arm` runs while the TTL is still unknown.
		const bodies: Array<Record<string, unknown>> = [];
		const decisions: CacheKeepaliveRecord[] = [];
		const { promise: touched, resolve: onTouch } = Promise.withResolvers<void>();
		const profile = Promise.withResolvers<void>();
		let learnedTtlS: number | undefined;

		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				get ttlSeconds() {
					return learnedTtlS;
				},
				get ttlReady() {
					return profile.promise;
				},
				maxTouches: 1,
				onDecision: record => {
					decisions.push(record);
					onTouch();
				},
			},
			freshStates(),
			bodies,
		);
		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });

		// The turn is over and the profile has still not landed. Nothing may have been
		// scheduled yet: had it been, it would have used the nominal lifetime.
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);
		expect(decisions).toEqual([]);

		// The read lands with a retention far shorter than nominal, then resolves.
		learnedTtlS = FAST_TTL_SECONDS;
		profile.resolve();
		await touched;

		// A touch fired on the compressed schedule, which is only reachable from the learned
		// value — the nominal 300s lifetime would not have come due inside this test at all.
		expect(decisions).toHaveLength(1);
		expect(bodies).toHaveLength(2);
		expect(unhandled).toEqual([]);
	});

	it("does not let a rejected TTL read fail the real response", async () => {
		// `arm` runs inline on the priming turn's `done` event, inside the pump whose catch
		// fails the caller's stream. An awaited profile read must therefore be contained at
		// that boundary, exactly like the arm-time policy reads above.
		const bodies: Array<Record<string, unknown>> = [];
		const result = await turn(
			{
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: FAST_TTL_SECONDS,
				ttlReady: Promise.reject(new Error("journal unreadable")),
				onDecision: () => {},
			},
			freshStates(),
			bodies,
		);

		// The response survives intact, and the chain ends rather than scheduling against a
		// TTL nobody managed to load.
		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
		expect(result.stopReason).toBe("stop");
		await Bun.sleep(IDLE_WINDOW_MS);
		expect(bodies).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});
});
