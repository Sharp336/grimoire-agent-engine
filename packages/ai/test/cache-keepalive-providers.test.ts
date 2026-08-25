// Coverage matrix for the widened prompt-cache keepalive.
//
// The keepalive originally covered two providers: Anthropic's first-party endpoint and
// Bedrock. It now attempts every api with a replayable JSON body and an output-limit
// field to overwrite. That widening is only defensible because the attempt is
// self-limiting, and the last test in this file is what proves it: a provider whose touch
// reports no cache read costs exactly ONE bounded request, because the verified-touch rule
// (`cacheRead > 0 && cacheWrite === 0`) ends the chain on the first unverified touch.
// Without that property, attempting an unknown provider would be an unfalsifiable money
// burn rather than a cheap probe.
//
// Note the rule is stricter than `classifyCacheOutcome`, deliberately. That helper calls
// any `cacheRead > 0` a `confirmed-hit`, treating a simultaneous write as the tail of the
// prefix being extended. For a *touch* a write is disqualifying: it means the entry had
// already expired and this request rebuilt it, so the touch proved nothing about the
// window it was supposed to measure.
//
// This file is deliberately explicit per api rather than looping a fixture: it is the
// document that says what the supported surface IS, so a reader must be able to see
// every row, and adding an api must force a decision here.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { CacheKeepaliveRecord, CacheKeepaliveShape } from "@oh-my-pi/pi-ai/cache/keepalive";
import { boundCacheKeepalivePayload, resolveCacheKeepaliveShape } from "@oh-my-pi/pi-ai/cache/keepalive";
import type { Api, Context, FetchImpl, KnownApi, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Round-trip margin the keepalive scheduler applies (`CACHE_KEEPALIVE_MARGIN_S` in
 * `src/stream.ts`), mirrored so a lease can be compressed to a real, tiny interval
 * instead of faking the clock.
 */
const KEEPALIVE_MARGIN_S = 15;

/** Interval the TTL above produces: `ttl - margin` = 20ms. */
const TOUCH_INTERVAL_MS = 20;
const PREFIX_TOKENS = 120_000;

interface ModelOverrides {
	provider?: string;
	baseUrl?: string;
	transport?: "pi-native";
	compat?: Record<string, unknown>;
}

function modelFor(api: Api, overrides: ModelOverrides = {}): Model<Api> {
	return buildModel({
		id: `probe-${api}`,
		name: `probe ${api}`,
		api,
		provider: overrides.provider ?? "probe-provider",
		baseUrl: overrides.baseUrl ?? "https://probe.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...(overrides.transport ? { transport: overrides.transport } : {}),
		...(overrides.compat ? { compat: overrides.compat } : {}),
	}) as Model<Api>;
}

/** With a policy supplied, i.e. `providers.cacheKeepalive: "economic"`. */
function shapeWithPolicy(model: Model<Api>, officialAnthropicEndpoint = false): CacheKeepaliveShape | undefined {
	return resolveCacheKeepaliveShape(model, { officialAnthropicEndpoint, economicPolicySupplied: true });
}

/** Without a policy, i.e. the default `"legacy"` mode. */
function shapeWithoutPolicy(model: Model<Api>, officialAnthropicEndpoint = false): CacheKeepaliveShape | undefined {
	return resolveCacheKeepaliveShape(model, { officialAnthropicEndpoint, economicPolicySupplied: false });
}

function boundedPaths(shape: CacheKeepaliveShape | undefined): readonly (readonly string[])[] | "discover" | undefined {
	if (shape?.kind !== "bounded-stream") return undefined;
	return shape.bound.kind === "candidates" ? shape.bound.paths : "discover";
}

describe("keepalive shape per api, with a policy supplied", () => {
	it("gives Anthropic's first-party endpoint the zero-output replay", () => {
		const model = modelFor("anthropic-messages", { provider: "anthropic", baseUrl: "https://api.anthropic.com" });
		expect(shapeWithPolicy(model, true)).toEqual({ kind: "zero-output" });
	});

	it("gives an Anthropic-compatible reseller a bounded replay instead", () => {
		// `max_tokens: 0` is only known to be accepted by the first-party endpoint, so a
		// gateway speaking the same wire format falls through to the bounded path.
		const model = modelFor("anthropic-messages", { provider: "openrouter" });
		expect(boundedPaths(shapeWithPolicy(model))).toEqual([["max_tokens"]]);
	});

	it("bounds Bedrock under inferenceConfig when the model writes cachePoints", () => {
		const model = modelFor("bedrock-converse-stream", { compat: { promptCacheMode: "explicit" } });
		expect(boundedPaths(shapeWithPolicy(model))).toEqual([["inferenceConfig", "maxTokens"]]);
	});

	it("declines Bedrock when the model writes no cachePoint", () => {
		// `automatic` prefix caching is not something a client can prolong, so a touch
		// would be spend against an entry it cannot extend.
		const model = modelFor("bedrock-converse-stream", { compat: { promptCacheMode: "automatic" } });
		expect(shapeWithPolicy(model)).toBeUndefined();
	});

	it("accepts either OpenAI completions spelling", () => {
		// The provider picks per model, so both spellings are accepted; a given body declares
		// exactly one of them, and one declaring both is ambiguous and declines.
		expect(boundedPaths(shapeWithPolicy(modelFor("openai-completions")))).toEqual([
			["max_tokens"],
			["max_completion_tokens"],
		]);
	});

	it("bounds the Responses family on max_output_tokens", () => {
		expect(boundedPaths(shapeWithPolicy(modelFor("openai-responses")))).toEqual([["max_output_tokens"]]);
		expect(boundedPaths(shapeWithPolicy(modelFor("azure-openai-responses")))).toEqual([["max_output_tokens"]]);
	});

	it("accepts every OpenRouter spelling, since its wire format is chosen per process", () => {
		expect(boundedPaths(shapeWithPolicy(modelFor("openrouter")))).toEqual([
			["max_output_tokens"],
			["max_tokens"],
			["max_completion_tokens"],
		]);
	});

	it("declines Codex, which strips caller output caps before sending", () => {
		// The request transformer deletes both output-limit fields, so there is nothing to
		// overwrite and an unbounded replay would be a whole completion.
		expect(shapeWithPolicy(modelFor("openai-codex-responses"))).toBeUndefined();
	});

	it("bounds the Google apis at their own nesting depth", () => {
		expect(boundedPaths(shapeWithPolicy(modelFor("google-generative-ai")))).toEqual([["config", "maxOutputTokens"]]);
		expect(boundedPaths(shapeWithPolicy(modelFor("google-vertex")))).toEqual([["config", "maxOutputTokens"]]);
		// Cloud Code Assist nests the whole GenerateContent request one level down.
		expect(boundedPaths(shapeWithPolicy(modelFor("google-gemini-cli")))).toEqual([
			["request", "generationConfig", "maxOutputTokens"],
		]);
	});

	it("declines Ollama, which reports no cache activity for a chain to arm on", () => {
		// The failure mode this pins is a table row that looks like coverage and is dead:
		// `stream.ts` only arms when a response reports `cacheRead + cacheWrite > 0`, and
		// this provider hardcodes both to zero. A bounded shape here would advertise a
		// keepalive that can never issue a single touch.
		expect(shapeWithPolicy(modelFor("ollama-chat"))).toBeUndefined();
	});

	it("declines the three transports with no replayable JSON body", () => {
		// cursor-agent hands the hook a protobuf message with no output-limit field;
		// gitlab-duo-agent delegates to a per-request upstream chosen server-side, so a
		// replay can land on a different one than cached; devin-agent never fires the
		// payload hook at all.
		expect(shapeWithPolicy(modelFor("cursor-agent"))).toBeUndefined();
		expect(shapeWithPolicy(modelFor("gitlab-duo-agent"))).toBeUndefined();
		expect(shapeWithPolicy(modelFor("devin-agent"))).toBeUndefined();
	});

	it("discovers the field for a custom api rather than guessing one", () => {
		// A `registerCustomApi` id has a wire format nothing in this repo has seen.
		expect(boundedPaths(shapeWithPolicy(modelFor("acme-custom-api")))).toBe("discover");
	});

	it("declines any model routed through another OMP harness", () => {
		// `pi-native` reports usage for an entry in a different process, so a touch from
		// here re-anchors nothing this session can observe.
		const model = modelFor("openai-responses", { transport: "pi-native" });
		expect(shapeWithPolicy(model)).toBeUndefined();
	});
});

describe("keepalive shape without a policy (the default legacy mode)", () => {
	it("still gives Anthropic's first-party endpoint its pre-existing replay", () => {
		// That zero-output replay predates the economic policy and is the behavior a
		// caller with no policy is asking for.
		const model = modelFor("anthropic-messages", { provider: "anthropic", baseUrl: "https://api.anthropic.com" });
		expect(shapeWithoutPolicy(model, true)).toEqual({ kind: "zero-output" });
	});

	it("arms nothing for every api the keepalive learned afterwards", () => {
		// Failure mode this pins: an opt-out that still bills providers which previously
		// had no keepalive at all. Before the policy existed, only Anthropic-official was
		// covered — so "legacy" must restore exactly that, not merely the old cadence.
		const learned: KnownApi[] = [
			"bedrock-converse-stream",
			"openai-completions",
			"openai-responses",
			"azure-openai-responses",
			"openrouter",
			"google-generative-ai",
			"google-vertex",
			"google-gemini-cli",
		];
		for (const api of learned) {
			const model = modelFor(api, { compat: { promptCacheMode: "explicit" } });
			expect(shapeWithoutPolicy(model)).toBeUndefined();
		}
		// Including a reseller speaking Anthropic's wire format, which is not the
		// first-party endpoint the legacy replay covered.
		expect(shapeWithoutPolicy(modelFor("anthropic-messages", { provider: "openrouter" }))).toBeUndefined();
		expect(shapeWithoutPolicy(modelFor("acme-custom-api"))).toBeUndefined();
	});
});

describe("bounding a captured payload", () => {
	const bounded = (api: Api, payload: Record<string, unknown>, model = modelFor(api)) => {
		const shape = shapeWithPolicy(model);
		if (shape?.kind !== "bounded-stream") throw new Error(`expected a bounded shape for ${api}`);
		return boundCacheKeepalivePayload(api, shape, payload);
	};

	it("overwrites the limit and leaves every sibling identical", () => {
		// A replay that differs from the cached request by more than its output limit is
		// not a keepalive — it is a different request that will miss.
		const payload = {
			model: "m",
			max_tokens: 4096,
			messages: [{ role: "user", content: "hi" }],
			temperature: 0.7,
			metadata: { user_id: "u" },
		};
		const result = bounded("openai-completions", payload);
		expect(result?.max_tokens).toBe(1);
		expect(result?.model).toBe("m");
		expect(result?.temperature).toBe(0.7);
		// Siblings are shared, not copied, so nothing can drift.
		expect(result?.messages).toBe(payload.messages);
		expect(result?.metadata).toBe(payload.metadata);
		// The captured body itself is never mutated; the chain replays it many times.
		expect(payload.max_tokens).toBe(4096);
	});

	it("bounds each api at its own nesting depth", () => {
		expect(
			bounded(
				"bedrock-converse-stream",
				{ inferenceConfig: { maxTokens: 8192, temperature: 1 } },
				modelFor("bedrock-converse-stream", { compat: { promptCacheMode: "explicit" } }),
			),
		).toEqual({
			inferenceConfig: { maxTokens: 1, temperature: 1 },
		});
		expect(bounded("openai-responses", { max_output_tokens: 2048 })).toEqual({ max_output_tokens: 1 });
		expect(bounded("google-generative-ai", { config: { maxOutputTokens: 2048 } })).toEqual({
			config: { maxOutputTokens: 1 },
		});
		expect(bounded("google-gemini-cli", { request: { generationConfig: { maxOutputTokens: 512 } } })).toEqual({
			request: { generationConfig: { maxOutputTokens: 1 } },
		});
		expect(bounded("openrouter", { max_output_tokens: 256 })).toEqual({ max_output_tokens: 1 });
	});

	it("bounds the one spelling the body declared, whichever of the accepted set it is", () => {
		// Not an ordering rule: the accepted paths are a set, and the body's single
		// declaration is what gets bounded regardless of where it sits in that set.
		expect(bounded("openai-completions", { max_completion_tokens: 900 })).toEqual({ max_completion_tokens: 1 });
		// `max_tokens` is listed second for OpenRouter and first for completions, and both
		// bodies bound correctly — so position genuinely carries no meaning.
		expect(bounded("openrouter", { max_tokens: 900 })).toEqual({ max_tokens: 1 });
	});

	it("declines a body declaring more than one output limit", () => {
		// Regression. Bounding the first alias and returning left the other one intact, and
		// the provider is free to honor whichever it prefers — so a touch that verified as a
		// cache hit could have generated a whole completion while the economic gate had
		// priced it at one token. These bodies are reachable from ordinary config: a
		// user-supplied `extraBody` is merged into the params with `Object.assign`.
		expect(bounded("openai-completions", { max_tokens: 4096, max_completion_tokens: 900 })).toBeUndefined();
		expect(
			bounded("openrouter", { max_output_tokens: 512, max_tokens: 4096, max_completion_tokens: 900 }),
		).toBeUndefined();
		// An explicit `null` is a declaration of "no cap", so it conflicts rather than being
		// treated as an absence next to a real number.
		expect(bounded("openrouter", { max_output_tokens: null, max_tokens: 4096 })).toBeUndefined();
		// A custom api gets the same rule across the discovered set.
		expect(bounded("acme-custom-api", { max_tokens: 4096, options: { num_predict: 64 } })).toBeUndefined();
		// Non-vacuity: an `undefined` leaf is not a declaration, since it never reaches the
		// wire — the body still has exactly one real limit and is bounded normally.
		expect(bounded("openai-completions", { max_tokens: undefined, max_completion_tokens: 900 })).toEqual({
			max_tokens: undefined,
			max_completion_tokens: 1,
		});
	});

	it("never invents a limit the request did not send", () => {
		// Failure mode: a replay carrying a field the original lacked is answering a
		// question the provider was never asked, and whatever it cached was cached for the
		// body without it.
		expect(bounded("openai-responses", { model: "m", input: [] })).toBeUndefined();
		// Parent object present, numeric leaf absent — the nested-path variant of the same
		// rule, which a flat-key check would miss.
		expect(bounded("google-generative-ai", { config: { temperature: 0.2 } })).toBeUndefined();
		// `null` is the wire spelling of "no cap" on the Responses family, so it is a
		// declaration too, not an absence to fill in.
		expect(bounded("openai-responses", { max_output_tokens: null })).toBeUndefined();
	});

	it("discovers a custom api's limit, and arms nothing when it recognizes none", () => {
		expect(bounded("acme-custom-api", { max_tokens: 64 })).toEqual({ max_tokens: 1 });
		expect(bounded("acme-custom-api", { options: { num_predict: 64 } })).toEqual({ options: { num_predict: 1 } });
		expect(bounded("acme-custom-api", { model: "m", widgetLimit: 5 })).toBeUndefined();
	});

	it("declines a body whose reasoning budget the bound cannot clear", () => {
		// Bounding output below a declared reasoning budget is rejected by the provider or
		// promoted into a full reasoning response, and stripping the declaration would
		// change the replay by more than its limit.
		const bedrock = modelFor("bedrock-converse-stream", { compat: { promptCacheMode: "explicit" } });
		expect(
			bounded(
				"bedrock-converse-stream",
				{
					inferenceConfig: { maxTokens: 8192 },
					additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 4096 } },
				},
				bedrock,
			),
		).toBeUndefined();
		expect(
			bounded("anthropic-messages", {
				max_tokens: 8192,
				thinking: { type: "enabled", budget_tokens: 4096 },
			}),
		).toBeUndefined();
		expect(
			bounded("google-generative-ai", {
				config: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 2048 } },
			}),
		).toBeUndefined();
	});

	it("allows a body whose reasoning is explicitly off", () => {
		// Non-vacuity for the decline above: the guard must key on an active budget, not on
		// the mere presence of a thinking field.
		expect(bounded("anthropic-messages", { max_tokens: 8192, thinking: { type: "disabled" } })).toEqual({
			max_tokens: 1,
			thinking: { type: "disabled" },
		});
		expect(
			bounded("google-generative-ai", { config: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } } }),
		).toEqual({ config: { maxOutputTokens: 1, thinkingConfig: { thinkingBudget: 0 } } });
	});
});

// ---------------------------------------------------------------------------
// End-to-end arming, and the property the whole widening rests on.
//
// Everything above resolves shapes and bounds bodies in isolation, which is not
// coverage on its own: `stream.ts` only arms a chain when the response reports
// `cacheRead + cacheWrite > 0`, so a provider that never populates those counters
// yields a perfectly-bounded body that nothing ever replays. That is exactly how
// `ollama-chat` sat in the table looking supported while being dead. These tests drive
// the real stream per wire family and assert a touch actually goes out.
// ---------------------------------------------------------------------------

const stateMaps: Array<Map<string, ProviderSessionState>> = [];

afterEach(() => {
	for (const states of stateMaps.splice(0)) {
		for (const state of states.values()) state.close();
		states.clear();
	}
	vi.restoreAllMocks();
});

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * An OpenAI-completions chunk stream reporting a cache read on the priming request and
 * nothing at all on the touch — the shape of a provider whose caching is implicit and
 * whose telemetry cannot confirm a touch landed.
 */
function completionsChunks(cachedTokens: number): Array<Record<string, unknown>> {
	return [
		{
			id: "c1",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		},
		{
			id: "c1",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: PREFIX_TOKENS,
				completion_tokens: 1,
				total_tokens: PREFIX_TOKENS + 1,
				prompt_tokens_details: { cached_tokens: cachedTokens },
			},
		},
	];
}

/** A Gemini SSE stop chunk reporting `cachedContentTokenCount`. */
function googleChunk(cachedTokens: number): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: {
			promptTokenCount: PREFIX_TOKENS,
			candidatesTokenCount: 1,
			totalTokenCount: PREFIX_TOKENS + 1,
			cachedContentTokenCount: cachedTokens,
		},
	};
}

/**
 * An Anthropic Messages SSE turn reporting `cache_read_input_tokens`.
 *
 * Framed with `event:` lines and no `[DONE]` sentinel, which is what this provider's
 * parser reads — the OpenAI/Gemini framing above is not interchangeable.
 */
function anthropicResponse(cacheRead: number): Response {
	const usage = (output: number) => ({
		input_tokens: 4,
		output_tokens: output,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: 0,
	});
	const events: Array<Record<string, unknown>> = [
		{ type: "message_start", message: { id: "msg_probe", usage: usage(0) } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usage(1) },
		{ type: "message_stop" },
	];
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Prime one turn with a cache-bearing response and return every body that reached the
 * wire, once the first keepalive decision has been reported.
 */
async function primeAndTouch(
	model: Model<Api>,
	respond: (callIndex: number) => Response,
): Promise<Record<string, unknown>[]> {
	const bodies: Record<string, unknown>[] = [];
	const { promise, resolve } = Promise.withResolvers<void>();
	const fetchMock: FetchImpl = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
		return respond(bodies.length);
	};
	const states = new Map<string, ProviderSessionState>();
	stateMaps.push(states);
	const stream = streamSimple(
		model,
		{ messages: [{ role: "user", content: "keep warm", timestamp: 1 }] },
		{
			fetch: fetchMock,
			apiKey: "probe-key",
			maxTokens: 4096,
			cacheRetention: "short",
			anthropicCacheRefresh: true,
			providerSessionState: states,
			sessionId: `arming-${model.api}`,
			cacheKeepalivePolicy: {
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				ttlSeconds: KEEPALIVE_MARGIN_S + 0.02,
				maxTouches: 1,
				onDecision: () => resolve(),
			},
		},
	);
	for await (const _event of stream) {
		// Drain the priming response before the idle gap begins.
	}
	await stream.result();
	await promise;
	return bodies;
}

describe("a touch actually reaches the wire, per counter implementation", () => {
	it("arms on Gemini's cachedContentTokenCount and bounds the wire body", async () => {
		// `google-shared.ts` is its own cache-counter implementation, and the bound is
		// resolved against the hook's `config.maxOutputTokens` while the wire body carries
		// `generationConfig.maxOutputTokens` — so this also proves the bound survives the
		// params-to-wire transformation rather than being lost in it.
		const model = modelFor("google-generative-ai", {
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
		});
		const bodies = await primeAndTouch(model, callIndex =>
			sseResponse([googleChunk(callIndex === 1 ? PREFIX_TOKENS : 0)]),
		);
		expect(bodies).toHaveLength(2);
		const generationConfig = bodies[1]?.generationConfig as Record<string, unknown> | undefined;
		expect(generationConfig?.maxOutputTokens).toBe(1);
	});

	it("arms an Anthropic-compatible gateway on the bounded path", async () => {
		// The first-party endpoint takes the `zero-output` replay; a reseller speaking the
		// same wire format is the only api that reaches `max_tokens: 1`, and it was never
		// exercised end to end.
		const model = modelFor("anthropic-messages", { provider: "openrouter", baseUrl: "https://gateway.example/v1" });
		const bodies = await primeAndTouch(model, callIndex => anthropicResponse(callIndex === 1 ? PREFIX_TOKENS : 0));
		expect(bodies).toHaveLength(2);
		expect(bodies[1]?.max_tokens).toBe(1);
	});
});

describe("attempting an unverifiable provider is self-limiting", () => {
	it("issues exactly one touch when the provider cannot confirm the entry was read", async () => {
		// THE load-bearing test for the widening. This provider reports a cache read on the
		// priming request but none on the touch, which is the shape of implicit caching whose
		// telemetry cannot confirm a touch landed — so the touch classifies
		// `success-unverified` and the chain must end there. (A missing *write* counter would
		// not do this: `cacheRead > 0 && cacheWrite === 0` is exactly the verified case, which
		// is what OpenAI and Google normally report.) If the chain did not end, attempting an
		// unknown provider would be an unfalsifiable money burn instead of a one-request
		// probe — which is the entire argument for covering providers this repo has never
		// verified.
		const decisions: CacheKeepaliveRecord[] = [];
		const { promise, resolve } = Promise.withResolvers<void>();
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			bodies.push(body);
			// The priming request reports a cache read so the chain arms; the touch reports
			// none, which is the unverifiable case.
			return sseResponse(completionsChunks(bodies.length === 1 ? PREFIX_TOKENS : 0));
		};
		const states = new Map<string, ProviderSessionState>();
		stateMaps.push(states);

		const context: Context = { messages: [{ role: "user", content: "keep warm", timestamp: 1 }] };
		const stream = streamSimple(modelFor("openai-completions"), context, {
			fetch: fetchMock,
			apiKey: "probe-key",
			maxTokens: 4096,
			anthropicCacheRefresh: true,
			providerSessionState: states,
			sessionId: "self-limiting-session",
			cacheKeepalivePolicy: {
				resumeProbability: () => 0.95,
				prefixTokens: () => PREFIX_TOKENS,
				// Just above the scheduler's round-trip margin, so its own
				// `min(ttl * 0.95, ttl - margin)` yields TOUCH_INTERVAL_MS without relying on
				// the unschedulable-lease path that a TTL below the margin takes.
				ttlSeconds: KEEPALIVE_MARGIN_S + 0.02,
				maxTouches: 8,
				onDecision: record => {
					decisions.push(record);
					resolve();
				},
			},
		});
		for await (const _event of stream) {
			// Drain the priming response before the idle gap begins.
		}
		await stream.result();

		// Await the touch's own decision rather than a guessed delay, then hold for several
		// more intervals: had the chain continued, it would have touched repeatedly in that
		// window. Absence is the assertion, so it needs the wait — the sibling Bedrock
		// suite's `awaitNoDecision` for the same reason.
		await promise;
		await Bun.sleep(TOUCH_INTERVAL_MS * 5);

		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.outcome).toBe("success-unverified");
		// One priming request plus exactly one probe, and no more even after the chain had
		// room to fire five further touches.
		expect(bodies).toHaveLength(2);
		// This model's provider chose `max_completion_tokens` over `max_tokens`, and the
		// bound picked the second candidate accordingly — the candidate list working end to
		// end, not just in the unit assertions above.
		expect(bodies[1]?.max_completion_tokens).toBe(1);
		expect(bodies[1]?.max_tokens).toBeUndefined();
	});
});
