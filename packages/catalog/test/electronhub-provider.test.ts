import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl as AiFetchImpl } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import ELECTRONHUB_LIVE_DEVPASS from "./fixtures/electronhub-devpass-models.json" with { type: "json" };

const DEVPASS_IDS = [
	"kimi-k2.6:dev",
	"minimax-m2.7:dev",
	"gpt-oss-120b:dev",
	"glm-5.2:dev",
	"gemma-4-31b-it:dev",
	"qwen3.6-27b:dev",
] as const;

function getElectronHubOptions(fetch: FetchImpl) {
	const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === "electronhub");
	if (!descriptor) throw new Error("ElectronHub descriptor missing");
	const options = descriptor.createModelManagerOptions({ apiKey: "ek-dev-test", fetch });
	expect(options.providerId).toBe("electronhub");
	return options;
}

describe("ElectronHub provider catalog", () => {
	it("bundles all six DevPass models offline with zero token cost, reasoning=true, supportsStore=false", () => {
		for (const id of DEVPASS_IDS) {
			const model = getBundledModel<"openai-completions">("electronhub", id);
			expect(model).toBeDefined();
			expect(model.provider).toBe("electronhub");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.electronhub.ai/v1");
			expect(model.maxTokens).toBeNull();
			// Per docs.electronhub.ai/billing/coding-plan, every DevPass model supports reasoning.
			expect(model.reasoning).toBe(true);
			// Flat-rate DevPass plan — zero marginal token cost.
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			// ElectronHub is OpenAI-compatible but does not support the OpenAI `store` flag.
			expect(model.compat.supportsStore).toBe(false);
			// ElectronHub's /v1/chat/completions documents `max_tokens` as the output
			// cap field, not the newer `max_completion_tokens` the generic OpenAI
			// dialect defaults to outside buildOpenAICompat's useMaxTokens allowlist.
			expect(model.compat.maxTokensField).toBe("max_tokens");
		}
	});

	it("sends max_tokens (not max_completion_tokens) on the wire for kimi-k2.6:dev, honoring the caller's cap", async () => {
		// kimi-k2.6:dev also carries alwaysSendMaxTokens (isKimiModel in
		// compat/openai.ts), so it sends a max-tokens field on EVERY request, even
		// when the caller set no cap. Live-probed against the real ElectronHub
		// endpoint: a max_completion_tokens:5 cap was silently ignored (the model
		// produced a full ~100-line response), while max_tokens:5 correctly capped
		// it (finish_reason "length", completion_tokens 5) -- confirming
		// ElectronHub only honors max_tokens, and the previously-unset
		// maxTokensField default would have made this model's runaway-reasoning
		// protection a silent no-op on this provider.
		const model = getBundledModel<"openai-completions">("electronhub", "kimi-k2.6:dev");
		let capturedBody: Record<string, unknown> = {};
		const fetchMock: AiFetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const raw = typeof init?.body === "string" ? init.body : "{}";
				capturedBody = JSON.parse(raw) as Record<string, unknown>;
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
			{ preconnect: fetch.preconnect },
		);
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		const stream = streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchMock, maxTokens: 5 });
		for await (const _ of stream) {
			// drain until terminal event
		}

		expect(capturedBody.max_tokens).toBe(5);
		expect(capturedBody.max_completion_tokens).toBeUndefined();
	});

	it("keeps glm-5.2:dev on ElectronHub's OpenAI-shaped reasoning_effort surface, remapping max to xhigh", () => {
		// ElectronHub's /v1/chat/completions documents a flat reasoning_effort enum
		// (none/minimal/low/medium/high/xhigh) for every proxied model, not Z.ai's native
		// two-tier high/max scale. thinkingFormat "zai" would restrict the exposed ladder
		// to high/max (getModelDefinedEfforts in model-thinking.ts) and let the unsupported
		// "max" value reach the wire — so glm-5.2:dev must stay off it.
		const glm = getBundledModel<"openai-completions">("electronhub", "glm-5.2:dev");
		expect(glm.compat.thinkingFormat).toBe("openai");
		expect(glm.compat.thinkingFormat).not.toBe("zai");
		// reasoningDisableMode is not uniform across all six DevPass models (see
		// the dedicated minimax-m2.7:dev and gpt-oss-120b:dev tests below); the
		// four models sharing reasoning-effort-none are asserted together in
		// "opts kimi/glm/gemma/qwen into ElectronHub's explicit reasoning_effort:none".
		expect(glm.compat.reasoningContentField).toBe("reasoning_content");
		// Leaving thinkingFormat "zai" also drops its reasoning_content continuation
		// replay (openai-completions.ts only fires that branch for thinkingFormat ===
		// "zai"); glm-5.2:dev opts back in explicitly so cross-turn behavior is
		// unchanged by the dialect switch.
		expect(glm.compat.replayReasoningContent).toBe(true);
		// The resolved effort ladder still exposes a top "max" tier (from the generic
		// openai-compat GLM-5.2 policy), but it must be remapped to ElectronHub's actual
		// top tier "xhigh" before it reaches the wire — both on the raw compat override
		// and on the model's resolved thinking.effortMap.
		expect(glm.compat.reasoningEffortMap?.max).toBe("xhigh");
		expect(glm.thinking?.effortMap?.max).toBe("xhigh");
	});

	it("overrides qwen3.6-27b:dev onto ElectronHub's OpenAI-shaped reasoning dialect, not native Qwen enable_thinking", () => {
		// Without an explicit override, buildOpenAICompat's id-based detection classifies
		// any "qwen"-named id into the native Qwen dialect (top-level `enable_thinking`
		// boolean), which ElectronHub's gateway does not honour — it expects the generic
		// OpenAI-shaped reasoning_effort surface for every proxied model
		// (docs.electronhub.ai/api-reference/chat/completions).
		const qwen = getBundledModel<"openai-completions">("electronhub", "qwen3.6-27b:dev");
		expect(qwen.compat.thinkingFormat).toBe("openai");
		expect(qwen.compat.thinkingFormat).not.toBe("qwen");
	});

	it("keeps minimax-m2.7:dev on the mandatory-reasoning floor instead of reasoning-effort-none", () => {
		// MiniMax M2 is a reasoning-first architecture: isMinimaxM2FamilyModelId
		// backfills thinking.requiresEffort for every host (Fireworks, native,
		// ElectronHub alike — see model-thinking.test.ts), so Thinking Off
		// requests never reach this model's reasoningDisableMode at all;
		// normalizeMandatoryReasoningOptions (packages/ai/src/stream.ts) clamps
		// disableReasoning to the ladder's lowest effort ("low") first. Confirmed
		// live against ElectronHub's /v1/chat/completions that "none", "minimal",
		// "low", and an omitted field all produce comparable non-trivial
		// reasoning content for this model — the gateway does not make this
		// architecturally mandatory-reasoning model honor "off" either, so it's
		// deliberately NOT exempted via thinking.suppressWhenOff.
		const minimax = getBundledModel<"openai-completions">("electronhub", "minimax-m2.7:dev");
		expect(minimax.thinking?.requiresEffort).toBe(true);
		expect(minimax.thinking?.suppressWhenOff).not.toBe(true);
		// The shared reasoning-effort-none disable mode is still configured (and
		// harmless) here — it's just structurally unreachable for this model.
		expect(minimax.compat.reasoningDisableMode).toBe("reasoning-effort-none");
	});

	it("opts kimi/glm/gemma/qwen into ElectronHub's explicit reasoning_effort:none, unlike minimax/gpt-oss", () => {
		// kimi-k2.6:dev, glm-5.2:dev, gemma-4-31b-it:dev, and qwen3.6-27b:dev have no
		// mandatory-reasoning floor and no narrower Harmony-style effort vocabulary,
		// so they inherit the shared ElectronHub base's reasoning-effort-none disable
		// mode uncontested — minimax-m2.7:dev and gpt-oss-120b:dev are the two
		// deliberate exceptions, covered by their own dedicated tests.
		for (const id of ["kimi-k2.6:dev", "glm-5.2:dev", "gemma-4-31b-it:dev", "qwen3.6-27b:dev"] as const) {
			const model = getBundledModel<"openai-completions">("electronhub", id);
			expect(model.compat.reasoningDisableMode).toBe("reasoning-effort-none");
		}
	});

	it("keeps gpt-oss-120b:dev on the tested-safe lowest-effort disable path instead of reasoning-effort-none", () => {
		// GPT-OSS's Harmony reasoning format only accepts low/medium/high for
		// reasoning_effort and rejects minimal/xhigh/none on its native hosts (see
		// isOpenAIGptOssModelId in identity/family.ts, and the issue #2315
		// regression coverage in packages/ai/test/issue-2315-repro.test.ts, which
		// locks every other GPT-OSS host onto the "low" floor instead of "none" —
		// built from a real prior production failure). ElectronHub's gateway did
		// not reject reasoning_effort:"none" when live-probed directly, but that's
		// weaker evidence than an established cross-provider regression test, so
		// this model deliberately stays off the shared reasoning-effort-none mode.
		const gptOss = getBundledModel<"openai-completions">("electronhub", "gpt-oss-120b:dev");
		expect(gptOss.compat.reasoningDisableMode).toBe("lowest-effort");
		expect(gptOss.compat.reasoningDisableMode).not.toBe("reasoning-effort-none");
		expect(gptOss.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
	});

	it("applies the same OpenAI-shaped dialect override to qwen3.6-27b:dev via dynamic discovery", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "qwen3.6-27b:dev",
							name: "ElectronHub: Qwen3.6 27B (DevPass)",
							tokens: 262_000,
							metadata: { devpass_only: false, reasoning: false, vision: true, function_call: true },
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = getElectronHubOptions(fetchImpl);
		const models = (await options.fetchDynamicModels?.()) as ModelSpec<"openai-completions">[] | null | undefined;
		const qwen = models?.find(candidate => candidate.id === "qwen3.6-27b:dev");
		expect(qwen).toBeDefined();
		expect(qwen?.compat?.thinkingFormat).toBe("openai");
	});

	it("applies the same lowest-effort disable override to gpt-oss-120b:dev via dynamic discovery", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "gpt-oss-120b:dev",
							name: "ElectronHub: GPT OSS 120B (DevPass)",
							tokens: 128_000,
							metadata: { devpass_only: false, reasoning: true, vision: false, function_call: true },
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = getElectronHubOptions(fetchImpl);
		const models = (await options.fetchDynamicModels?.()) as ModelSpec<"openai-completions">[] | null | undefined;
		const gptOss = models?.find(candidate => candidate.id === "gpt-oss-120b:dev");
		expect(gptOss).toBeDefined();
		expect(gptOss?.compat?.reasoningDisableMode).toBe("lowest-effort");
		expect(gptOss?.compat?.reasoningDisableMode).not.toBe("reasoning-effort-none");
	});

	it("keeps DevPass models from /v1/models discovery via :dev suffix, devpass_only, or pricing.plan=devpass", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(
				JSON.stringify({
					data: [
						{ id: "kimi-k2.6:dev", name: "ElectronHub: Kimi K2.6 (DevPass)", tokens: 240_000 },
						// Keep via metadata.devpass_only even without :dev suffix.
						{
							id: "rollout-preview",
							name: "ElectronHub: Preview",
							metadata: { devpass_only: true },
							tokens: 9_999,
						},
						// Keep via pricing.plan="devpass" even without :dev suffix or devpass_only metadata
						// (two of the six live DevPass records omit metadata.devpass_only entirely).
						{
							id: "plan-only-devpass",
							name: "ElectronHub: Plan Only",
							pricing: { input: "0", output: "0", plan: "devpass" },
							tokens: 100_000,
						},
						// Must be dropped: plain model, no DevPass signal at all.
						{ id: "kimi-k2.6", name: "Kimi K2.6", tokens: 240_000 },
						{ id: "random-model", name: "Random", metadata: { devpass_only: false }, tokens: 1 },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = getElectronHubOptions(fetchImpl);
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();

		// Uses the OpenAI-compatible discovery endpoint.
		expect(requestedUrls).toEqual(["https://api.electronhub.ai/v1/models"]);

		const ids = (models ?? []).map(model => model.id).sort();
		expect(ids).toEqual(["kimi-k2.6:dev", "plan-only-devpass", "rollout-preview"].sort());
	});

	it("forces reasoning=true on discovery even when upstream metadata reports reasoning=false", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						// Models the real qwen3.6-27b:dev case: ElectronHub reports reasoning:false,
						// but the model has been observed returning non-zero reasoning_tokens in usage.
						{
							id: "qwen3.6-27b:dev",
							name: "ElectronHub: Qwen3.6 27B (DevPass)",
							tokens: 262_000,
							metadata: { devpass_only: false, reasoning: false, vision: true, function_call: true },
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = getElectronHubOptions(fetchImpl);
		const models = (await options.fetchDynamicModels?.()) as ModelSpec<"openai-completions">[] | null | undefined;
		const qwen = models?.find(candidate => candidate.id === "qwen3.6-27b:dev");
		expect(qwen).toBeDefined();
		expect(qwen?.reasoning).toBe(true);
	});

	it("maps ElectronHub discovery metadata into ModelSpec (name cleanup, tokens->contextWindow, vision->input)", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "thirdparty:dev",
							name: "ElectronHub: Custom DevPass Name",
							tokens: 123_456,
							metadata: { devpass_only: true, reasoning: true, vision: true, function_call: false },
							pricing: { input: "0", output: "0", cache_read: "0", cache_write: "0" },
						},
						{
							id: "minimax-m2.7:dev",
							name: "ElectronHub: MiniMax M2.7 (DevPass)",
							tokens: 180_000,
							metadata: { devpass_only: true, reasoning: true, vision: false, function_call: true },
							pricing: { input: "0", output: "0", cache_read: "0", cache_write: "0" },
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = getElectronHubOptions(fetchImpl);
		const models = (await options.fetchDynamicModels?.()) as ModelSpec<"openai-completions">[] | null | undefined;

		const thirdparty = models?.find(candidate => candidate.id === "thirdparty:dev");
		expect(thirdparty).toBeDefined();
		expect(thirdparty?.name).toBe("Custom DevPass Name");
		expect(thirdparty?.contextWindow).toBe(123_456);
		expect(thirdparty?.input).toEqual(["text", "image"]);
		// All DevPass models support function calling per docs — a stale/false
		// function_call metadata flag must not disable tools.
		expect(thirdparty?.supportsTools).not.toBe(false);
		expect(thirdparty?.compat?.supportsStore).toBe(false);

		const minimax = models?.find(candidate => candidate.id === "minimax-m2.7:dev");
		expect(minimax).toBeDefined();
		expect(minimax?.name).toBe("MiniMax M2.7 (DevPass)");
		expect(minimax?.contextWindow).toBe(180_000);
		expect(minimax?.input).toEqual(["text"]);
		expect(minimax?.supportsTools).not.toBe(false);
	});
});

describe("ElectronHub DevPass static seed mirrors a live /v1/models snapshot", () => {
	// Source evidence for the static seed: a sanitized snapshot of the live
	// `/v1/models` DevPass entries (no API key, only the fields the resolver
	// relies on). Guards against the seed silently drifting from reality.
	const liveEntries = ELECTRONHUB_LIVE_DEVPASS.data as Array<Record<string, unknown>>;

	it("every DevPass id has a live fixture entry with :dev suffix or pricing.plan=devpass", () => {
		const liveById = new Map(liveEntries.map(entry => [entry.id as string, entry]));
		for (const id of DEVPASS_IDS) {
			const entry = liveById.get(id);
			expect(entry).toBeDefined();
			const pricing = entry?.pricing as { plan?: string } | undefined;
			expect(id.endsWith(":dev") || pricing?.plan === "devpass").toBe(true);
		}
	});

	it("static seed contextWindow matches the live fixture's tokens for every DevPass model", () => {
		const liveTokens = new Map(liveEntries.map(entry => [entry.id as string, entry.tokens as number | undefined]));
		const seeds: Record<string, number | null> = {
			"kimi-k2.6:dev": getBundledModel<"openai-completions">("electronhub", "kimi-k2.6:dev").contextWindow,
			"minimax-m2.7:dev": getBundledModel<"openai-completions">("electronhub", "minimax-m2.7:dev").contextWindow,
			"gpt-oss-120b:dev": getBundledModel<"openai-completions">("electronhub", "gpt-oss-120b:dev").contextWindow,
			"glm-5.2:dev": getBundledModel<"openai-completions">("electronhub", "glm-5.2:dev").contextWindow,
			"gemma-4-31b-it:dev": getBundledModel<"openai-completions">("electronhub", "gemma-4-31b-it:dev").contextWindow,
			"qwen3.6-27b:dev": getBundledModel<"openai-completions">("electronhub", "qwen3.6-27b:dev").contextWindow,
		};
		for (const [id, seedContextWindow] of Object.entries(seeds)) {
			expect(seedContextWindow).toBe(liveTokens.get(id) ?? null);
		}
	});
});
