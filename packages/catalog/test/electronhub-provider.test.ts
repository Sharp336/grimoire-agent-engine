import { describe, expect, it } from "bun:test";
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
			// ElectronHub documents reasoning_effort: "none" as the explicit way to hide
			// reasoning output; the generic "openai" dialect default ("lowest-effort") would
			// still send the ladder's floor tier instead of actually turning reasoning off.
			expect(model.compat.reasoningDisableMode).toBe("reasoning-effort-none");
		}
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
		// reasoningDisableMode is asserted uniformly across all six DevPass models
		// (including glm-5.2:dev) in the "bundles all six DevPass models" test above.
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
