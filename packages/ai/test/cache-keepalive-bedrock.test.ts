// Regression suite for the generalized prompt-cache keepalive on Amazon Bedrock.
//
// Before this, `supportsAnthropicCacheRefresh` required `provider === "anthropic"` on an
// official endpoint, so a Bedrock session — which reports `cacheReadInputTokens` /
// `cacheWriteInputTokens` and prices a cache read at 1/12.5 of a write — got no keepalive
// at all and paid a full cache write on every resume after a >5-minute idle gap.
//
// Two contracts are load-bearing and each has a named failure mode:
//
// 1. DRAIN, NEVER ABORT. Bedrock fills `usage.cacheRead`/`cacheWrite` only from the
//    trailing `metadata` event (`providers/amazon-bedrock.ts:735-744`). A touch that
//    aborted at content start — the trick the Anthropic thinking path uses — would see
//    zero cache tokens, classify unverified, and kill the chain on its first tick.
// 2. VERIFIED TOUCH ONLY. A touch re-anchors the chain only on `cacheRead > 0 &&
//    cacheWrite === 0`. A write means the entry was rebuilt at full price, which must end
//    the chain rather than silently keep paying.
//
// Timing note: these tests never sleep. The keepalive re-schedules itself from inside the
// async completion of the previous touch, so the observable signal is the policy's own
// `onDecision` callback; every wait below is a promise resolved by that callback. The
// interval itself is compressed by `FAST_TTL_SECONDS`.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { CacheKeepaliveRecord } from "@oh-my-pi/pi-ai/cache/keepalive";
import { CACHE_KEEPALIVE_STATE_KEY, resolveCacheKeepaliveShape } from "@oh-my-pi/pi-ai/cache/keepalive";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const PREFIX_TOKENS = 120_000;
/**
 * Round-trip margin the keepalive scheduler applies (`CACHE_KEEPALIVE_MARGIN_S` in
 * `src/stream.ts`); duplicated here because the interval below is derived from it.
 */
const KEEPALIVE_MARGIN_S = 15;
/**
 * TTL chosen so the scheduler's own arithmetic — `min(ttl * 0.95, ttl - margin)` — yields
 * a 20ms interval, exercising the real timer path without a perceptible wait.
 *
 * The compression comes from putting the TTL just *above* the margin rather than below
 * it: a TTL the margin swallows now yields no deadline at all (the anti-spin contract on
 * `nextWarmDeadlineMs`), so it can no longer be abused to make a suite fast.
 */
const FAST_TTL_SECONDS = KEEPALIVE_MARGIN_S + 0.02;
/** What `FAST_TTL_SECONDS` resolves to: `min(14.269, 0.02)` seconds. */
const TOUCH_INTERVAL_MS = 20;

const context: Context = { messages: [{ role: "user", content: "keep this prefix warm", timestamp: 1 }] };

function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = utf8(name);
	const valueBytes = utf8(value);
	const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(header.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	header.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	header.set(valueBytes, offset);
	return header;
}

function encodeEventFrame(eventType: string, payload: unknown): Uint8Array {
	const headerChunks = [encodeStringHeader(":message-type", "event"), encodeStringHeader(":event-type", eventType)];
	const headerLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const headers = new Uint8Array(headerLength);
	let headerOffset = 0;
	for (const chunk of headerChunks) {
		headers.set(chunk, headerOffset);
		headerOffset += chunk.length;
	}
	const body = utf8(JSON.stringify(payload));
	const totalLength = 4 + 4 + 4 + headerLength + body.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headers, 12);
	frame.set(body, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

/**
 * A Converse stream whose cache counters arrive ONLY in the trailing `metadata` event,
 * exactly as Bedrock behaves. Content is emitted first, so an implementation that aborted
 * at content start would stop before the counters ever landed.
 */
function converseFrames(cacheRead: number, cacheWrite: number): readonly Uint8Array[] {
	return [
		encodeEventFrame("messageStart", { role: "assistant" }),
		encodeEventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x" } }),
		encodeEventFrame("contentBlockStop", { contentBlockIndex: 0 }),
		encodeEventFrame("messageStop", { stopReason: "end_turn" }),
		encodeEventFrame("metadata", {
			usage: {
				inputTokens: 10,
				outputTokens: 1,
				cacheReadInputTokens: cacheRead,
				cacheWriteInputTokens: cacheWrite,
				totalTokens: 11 + cacheRead + cacheWrite,
			},
		}),
	];
}

function eventStreamResponse(frames: readonly Uint8Array[]): Response {
	let index = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= frames.length) {
				controller.close();
				return;
			}
			controller.enqueue(frames[index]!);
			index += 1;
		},
	});
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "application/vnd.amazon.eventstream",
			"x-amzn-requestid": "req-keepalive",
		},
	});
}

function bedrockModel(promptCacheMode: "explicit" | "automatic" = "explicit"): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-opus-5",
		name: "Claude Opus 5",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		// Real published Opus-5-on-Bedrock rates, USD per 1e6 tokens.
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		// `resolvePromptCachePolicy` emits no `cachePoint` without a checkpoint budget, and
		// without one there is no entry to keep warm. Mirrors the real catalog entry.
		compat: { promptCacheMode, promptCacheMaximumCheckpoints: 4, promptCacheMinimumTokens: 512 },
	});
}

/**
 * The real `us.anthropic.claude-opus-5` shape: adaptive thinking, which the provider
 * turns into `additionalModelRequestFields.thinking`.
 */
function thinkingBedrockModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		...bedrockModel(),
		reasoning: true,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
			supportsDisplay: true,
		},
	});
}

interface Harness {
	bodies: Record<string, unknown>[];
	decisions: CacheKeepaliveRecord[];
	/** Resolves once `count` decisions have been reported. */
	awaitDecisions(count: number): Promise<void>;
	/**
	 * Resolves after several compressed touch intervals with no decision reported.
	 *
	 * Absence is the contract in a couple of tests — "no chain was armed", "no touch was
	 * schedulable" — and it has no signal to await by construction, so this is the one
	 * place a real delay is warranted (the rule against wall-clock waits in tests allows
	 * it when deterministic control cannot express the assertion). The interval is 20ms,
	 * so this costs ~100ms and would observe a touch several times over if one had been
	 * scheduled.
	 */
	awaitNoDecision(): Promise<void>;
	states: Map<string, ProviderSessionState>;
	record: (record: CacheKeepaliveRecord) => void;
	fetch: FetchImpl;
}

const harnesses: Harness[] = [];

/**
 * Bedrock builds its own request body, so touches are observed by capturing what reaches
 * `fetch`. Progress is awaited through `onDecision`, the signal the implementation already
 * emits for every touch and every skip.
 */
function harness(frames: (callIndex: number) => readonly Uint8Array[]): Harness {
	const pending: Array<{ count: number; resolve: () => void }> = [];
	const bodies: Record<string, unknown>[] = [];
	const decisions: CacheKeepaliveRecord[] = [];
	const instance: Harness = {
		bodies,
		decisions,
		states: new Map<string, ProviderSessionState>(),
		awaitDecisions(count) {
			if (decisions.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			pending.push({ count, resolve });
			return promise;
		},
		async awaitNoDecision() {
			await Bun.sleep(TOUCH_INTERVAL_MS * 5);
		},
		record(record) {
			decisions.push(record);
			for (const waiter of pending.splice(0)) {
				if (decisions.length >= waiter.count) waiter.resolve();
				else pending.push(waiter);
			}
		},
		async fetch(_input, init) {
			const callIndex = bodies.length;
			bodies.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>);
			return eventStreamResponse(frames(callIndex));
		},
	};
	harnesses.push(instance);
	return instance;
}

interface DriveOverrides {
	resumeProbability?: number;
	prefixTokens?: number;
	maxTouches?: number;
	model?: Model<"bedrock-converse-stream">;
	reasoning?: Effort;
	/** Overrides the compressed TTL; used to drive the un-schedulable case. */
	ttlSeconds?: number;
	/** Stands in for the session's physical cache fingerprint. */
	fingerprint?: () => string | undefined;
	/** Omitted by default, so the routing-key fallback is what the other tests exercise. */
	promptCacheKey?: string;
	/** Drives the pre-policy caller: `anthropicCacheRefresh` on, no `cacheKeepalivePolicy`. */
	withoutPolicy?: boolean;
}

async function drive(instance: Harness, overrides: DriveOverrides = {}): Promise<void> {
	const stream = streamSimple(
		overrides.model ?? bedrockModel(),
		{ ...context, systemPrompt: ["you are a helpful assistant"] },
		{
			reasoning: overrides.reasoning,
			fetch: instance.fetch,
			// Bedrock resolves its bearer token from `apiKey`, so no SigV4 signing runs.
			apiKey: "test-token",
			anthropicCacheRefresh: true,
			providerSessionState: instance.states,
			sessionId: "bedrock-keepalive-session",
			promptCacheKey: overrides.promptCacheKey,
			...(overrides.withoutPolicy
				? {}
				: {
						cacheKeepalivePolicy: {
							resumeProbability: () => overrides.resumeProbability ?? 0.95,
							prefixTokens: () => overrides.prefixTokens ?? PREFIX_TOKENS,
							maxTouches: overrides.maxTouches ?? 8,
							ttlSeconds: overrides.ttlSeconds ?? FAST_TTL_SECONDS,
							onDecision: instance.record,
							...(overrides.fingerprint === undefined ? {} : { fingerprint: overrides.fingerprint }),
						},
					}),
		},
	);
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
	vi.restoreAllMocks();
});

describe("resolveCacheKeepaliveShape", () => {
	/** A policy-bearing caller, i.e. one that opted into cost-aware keepalive. */
	const optedIn = { officialAnthropicEndpoint: false, economicPolicySupplied: true };

	it("offers a bounded-stream touch for an explicit-cache Bedrock model", () => {
		// Bedrock has no non-streaming route and rejects maxTokens 0 (AWS documents
		// InferenceConfiguration.maxTokens as "Minimum value of 1").
		expect(resolveCacheKeepaliveShape(bedrockModel(), optedIn)).toEqual({
			kind: "bounded-stream",
			maxTokens: 1,
		});
	});

	it("declines Bedrock entirely when no policy opted into the expansion", () => {
		// Bedrock support is new. A caller with no policy is asking for the behavior that
		// shipped before, and that behavior was Anthropic-only — so answering with a shape
		// here would newly bill LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES touches per turn on the
		// configuration that opted out.
		expect(
			resolveCacheKeepaliveShape(bedrockModel(), {
				officialAnthropicEndpoint: false,
				economicPolicySupplied: false,
			}),
		).toBeUndefined();
	});

	it("declines a Bedrock model that never emits cache checkpoints", () => {
		// `automatic` writes no cachePoint, so there is no entry to keep warm and a touch
		// would be pure spend.
		expect(resolveCacheKeepaliveShape(bedrockModel("automatic"), optedIn)).toBeUndefined();
	});

	it("declines a provider with no verifiable cache telemetry", () => {
		const openai = buildModel({
			id: "gpt-5.6",
			name: "gpt",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		expect(
			resolveCacheKeepaliveShape(openai, { officialAnthropicEndpoint: true, economicPolicySupplied: true }),
		).toBeUndefined();
	});
});

describe("Bedrock prompt-cache keepalive", () => {
	it("re-anchors from trailing metadata usage, proving the touch is drained not aborted", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		await drive(instance);

		// A third touch can only happen if the first two read their counters, which live
		// after the content blocks. An implementation that aborted at contentBlockDelta
		// would see cacheRead 0, classify unverified, and stop after one.
		await instance.awaitDecisions(3);

		expect(instance.decisions).toHaveLength(3);
		for (const record of instance.decisions) {
			expect(record.outcome).toBe("confirmed-hit");
			expect(record.decision.action).toBe("warm");
			expect(record.cacheRead).toBe(PREFIX_TOKENS);
		}
		// One real request plus one per touch; each touch bounds output to Bedrock's minimum.
		expect(instance.bodies.length).toBeGreaterThanOrEqual(4);
		for (const body of instance.bodies.slice(1)) {
			expect((body.inferenceConfig as { maxTokens?: number }).maxTokens).toBe(1);
		}
	});

	it("stops the chain when a touch rebuilt the cache instead of reading it", async () => {
		// The priming request reads; the touch reports a WRITE, meaning the entry was gone
		// and got rebuilt at full price. Continuing would keep paying for that.
		const instance = harness(callIndex =>
			callIndex === 0 ? converseFrames(PREFIX_TOKENS, 0) : converseFrames(0, PREFIX_TOKENS),
		);
		await drive(instance);
		await instance.awaitDecisions(1);

		expect(instance.decisions).toHaveLength(1);
		expect(instance.decisions[0]?.outcome).toBe("miss-rebuilt");
		// Exactly the priming request plus the single unverified touch: no re-anchor.
		expect(instance.bodies).toHaveLength(2);
	});

	it("reports a skip instead of touching when nothing will resume the session", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		// resumeProbability 0 is the "turn is genuinely over" signal. The previous blind
		// watchdog spent three replays here regardless. The scheduler still runs, so the
		// skip decision itself is the observable signal — no absence-waiting needed.
		await drive(instance, { resumeProbability: 0 });
		await instance.awaitDecisions(1);

		expect(instance.decisions[0]?.decision.action).toBe("skip-no-continuation");
		expect(instance.decisions[0]?.outcome).toBeUndefined();
		expect(instance.bodies).toHaveLength(1);
	});

	it("reports a skip when the prefix is too small to be worth a touch", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		// Solve the gate: expected = 0.95*p*(6.25-0.5)/1e6 must exceed
		// nextWarm = p*0.5/1e6 + 25/1e6, i.e. p*4.9625 > 25, so p > ~5.04 tokens. At 4
		// tokens the single output token the touch is billed for costs more than the whole
		// avoided rebuild, and the gate refuses rather than burning a request.
		await drive(instance, { prefixTokens: 4 });
		await instance.awaitDecisions(1);

		expect(instance.decisions[0]?.decision.action).toBe("skip-not-economic");
		expect(instance.bodies).toHaveLength(1);
	});

	it("outlives the legacy three-touch ceiling when the prefix is genuinely expensive", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		// The old hard limit was 3 touches (~19 minutes of coverage). A multi-subagent
		// fan-out routinely idles longer, and at these rates a touch costs $0.06 to avoid a
		// $0.75 rebuild, so the budget comfortably funds more.
		await drive(instance, { maxTouches: 6 });
		await instance.awaitDecisions(5);

		expect(instance.decisions.length).toBeGreaterThan(3);
		expect(instance.decisions.every(record => record.outcome === "confirmed-hit")).toBe(true);
	});

	it("halts on the economic budget rather than running forever", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		// maxTouches is only a safety net; the real bound is the budget. Each touch costs
		// ~$0.0601 against a $0.4589 ceiling, so the chain must reach `economic-stop` on its
		// own well before 200 touches.
		await drive(instance, { maxTouches: 200 });
		await instance.awaitDecisions(8);

		const stop = instance.decisions.find(record => record.decision.action === "economic-stop");
		expect(stop?.outcome).toBeUndefined();
		expect(instance.decisions.filter(record => record.outcome === "confirmed-hit").length).toBeLessThan(200);
	});

	it("arms nothing when thinking is active, because the touch cannot be bounded", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		// Regression for a wrong bound. Bedrock puts Anthropic's `thinking` block in
		// `additionalModelRequestFields`. Budget mode carries `budget_tokens`, and Anthropic
		// requires `max_tokens > budget_tokens`, so forcing `maxTokens: 1` would be rejected
		// outright; adaptive mode carries no budget, so honoring it means draining a whole
		// thinking response, which Bedrock cannot be cut short from because its cache
		// counters only arrive in the trailing `metadata` event. Stripping `thinking` would
		// make the replay differ by more than output bounding. So: decline.
		await drive(instance, { model: thinkingBedrockModel(), reasoning: Effort.Low });

		// The priming request really did ask for thinking and really did create an entry,
		// so the decline is about bounding, not about a missing cache.
		const primed = instance.bodies[0] as { additionalModelRequestFields?: { thinking?: { type?: string } } };
		expect(primed.additionalModelRequestFields?.thinking?.type).toBe("adaptive");
		expect(instance.states.get(CACHE_KEEPALIVE_STATE_KEY)).toBeDefined();

		// No chain was armed, so no decision is ever reported and no touch is issued.
		await instance.awaitNoDecision();
		expect(instance.decisions).toHaveLength(0);
		expect(instance.bodies).toHaveLength(1);
	});

	it("issues no touch at all when the believed ttl cannot clear the round-trip margin", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		// Regression for a zero-delay timer spin. A learned profile that observed early
		// eviction (or any caller-supplied short TTL) puts `ttlSeconds` under the
		// scheduler's 15s round-trip margin. The deadline arithmetic used to clamp to 0 and
		// return the last touch instant, so the state re-armed a 0ms timer after every
		// verified touch: a hot loop that spends the entire keepalive budget on touches
		// that cannot land inside the entry's remaining life. Refusing to schedule is the
		// only terminating answer.
		await drive(instance, { ttlSeconds: 1 });

		await instance.awaitNoDecision();
		expect(instance.decisions).toHaveLength(0);
		// The priming request only: no touch, and above all not an unbounded run of them.
		expect(instance.bodies).toHaveLength(1);
	});

	it("files decisions under the physical fingerprint the policy supplies", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		// Regression for keying the chain on the routing key. `promptCacheKey`/`sessionId`
		// identify where a request is routed, not the entry it reads, so touches keyed on
		// them file evidence under a different clock than the ordinary observations for the
		// same physical entry — and a later hit or miss can no longer measure its idle age
		// against the preceding touch. A supplied fingerprint must win over both.
		await drive(instance, {
			fingerprint: () => "sha256:physical-entry",
			promptCacheKey: "routing-key-that-must-not-win",
		});
		await instance.awaitDecisions(2);

		expect(instance.decisions.map(record => record.fingerprint)).toEqual([
			"sha256:physical-entry",
			"sha256:physical-entry",
		]);
	});

	it("falls back to the routing key while the session has no fingerprint yet", async () => {
		const instance = harness(() => converseFrames(PREFIX_TOKENS, 0));
		// The fingerprint is only known once the arming turn's message is complete, which is
		// after the chain arms, so `undefined` is a real state and must not blank the record.
		await drive(instance, { fingerprint: () => undefined, promptCacheKey: "route-42" });
		await instance.awaitDecisions(1);

		expect(instance.decisions[0]?.fingerprint).toBe("route-42");
	});

	it("arms nothing for a Bedrock caller that supplied no policy, and still arms for one that did", async () => {
		// Failure mode: an opt-out that keeps billing a provider which previously had no
		// keepalive at all. Bedrock coverage is new; before it, the keepalive gated on
		// Anthropic-only support, so a Bedrock session issued zero touches. Resolving a
		// bounded-stream shape regardless of the policy made the no-policy path fall through
		// to LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES — three NEW billed requests per turn for the
		// caller that explicitly asked for the old behavior. The opt-in has to cover provider
		// expansion, not only touch cadence.
		const withoutPolicy = harness(() => converseFrames(PREFIX_TOKENS, 0));
		await drive(withoutPolicy, { withoutPolicy: true });

		// The state is installed only once a shape resolved, so its absence proves no chain
		// exists and therefore that no touch can ever fire — not merely that none has yet.
		expect(withoutPolicy.states.get(CACHE_KEEPALIVE_STATE_KEY)).toBeUndefined();
		expect(withoutPolicy.bodies).toHaveLength(1);

		// Positive control: the same model with a policy still arms and touches, so the gate
		// is about the opt-in rather than about Bedrock support regressing.
		const withPolicy = harness(() => converseFrames(PREFIX_TOKENS, 0));
		await drive(withPolicy);
		await withPolicy.awaitDecisions(1);

		expect(withPolicy.states.get(CACHE_KEEPALIVE_STATE_KEY)).toBeDefined();
		expect(withPolicy.decisions[0]?.decision.action).toBe("warm");
		expect(withPolicy.bodies.length).toBeGreaterThanOrEqual(2);
	});
});
