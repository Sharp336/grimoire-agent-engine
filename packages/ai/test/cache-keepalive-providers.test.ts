// Coverage matrix for the widened prompt-cache keepalive.
//
// The keepalive originally covered two providers: Anthropic's first-party endpoint and
// Bedrock. It now attempts every api with a replayable JSON body and an output-limit
// field to overwrite. That widening is only defensible because the attempt is
// self-limiting, and the last test in this file is what proves it: a provider that
// reports no cache telemetry costs exactly ONE bounded request, because the
// verified-touch rule (`cacheRead > 0 && cacheWrite === 0`) ends the chain on the first
// unverified touch. Without that property, attempting an unknown provider would be an
// unfalsifiable money burn rather than a cheap probe.
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
		// The provider picks per model, so both spellings are candidates and the
		// first-present rule resolves it against the captured body.
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

	it("bounds Ollama on num_predict", () => {
		expect(boundedPaths(shapeWithPolicy(modelFor("ollama-chat")))).toEqual([["options", "num_predict"]]);
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
			"ollama-chat",
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
		expect(bounded("ollama-chat", { options: { num_predict: 256, temperature: 0.2 } })).toEqual({
			options: { num_predict: 1, temperature: 0.2 },
		});
	});

	it("picks whichever candidate spelling the body actually used", () => {
		expect(bounded("openai-completions", { max_completion_tokens: 900 })).toEqual({ max_completion_tokens: 1 });
		// OpenRouter's order prefers the Responses spelling, but a Completions body has
		// only the other one.
		expect(bounded("openrouter", { max_tokens: 900 })).toEqual({ max_tokens: 1 });
	});

	it("never invents a limit the request did not send", () => {
		// Failure mode: a replay carrying a field the original lacked is answering a
		// question the provider was never asked, and whatever it cached was cached for the
		// body without it.
		expect(bounded("openai-responses", { model: "m", input: [] })).toBeUndefined();
		expect(bounded("ollama-chat", { model: "m", options: { temperature: 0.2 } })).toBeUndefined();
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
// The property the whole widening rests on.
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

describe("attempting an unverifiable provider is self-limiting", () => {
	it("issues exactly one touch when the provider cannot confirm the entry was read", async () => {
		// THE load-bearing test for the widening. An implicit-cache provider reports no
		// cache-write counter, so a touch classifies `success-unverified` and the chain
		// must end there. If it did not, attempting an unknown provider would be an
		// unfalsifiable money burn instead of a one-request probe — which is the entire
		// argument for covering providers this repo has never verified.
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
