/**
 * ElectronHub Coding Plan (DevPass) provider wiring.
 *
 * DevPass `ek-dev-…` keys are scoped to exactly the six `:dev`-suffixed
 * models surfaced by `/v1/models`. Plain ids return 404 "not included in
 * the Electron Hub Coding Plan". These tests defend:
 *
 *  1. The static seed ships all six DevPass ids (the original PR #4858
 *     only seeded two and missed `glm-5.2:dev`), all with `maxTokens: null`
 *     because ElectronHub's `/v1/models` metadata does not publish an
 *     output-token cap — keeping it null avoids inventing a limit.
 *  2. Dynamic discovery filters out non-`:dev` models — without this filter
 *     every one of the 582 ElectronHub ids would be imported as a chat model.
 *  3. The discovery mapper folds live `/v1/models` metadata (vision,
 *     reasoning) into the resolved spec.
 *
 * Per https://docs.electronhub.ai/billing/coding-plan all DevPass models
 * support function calling and reasoning on every endpoint.
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import {
	ELECTRONHUB_DEVPASS_STATIC_MODELS,
	electronHubModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import ELECTRONHUB_LIVE_DEVPASS from "./fixtures/electronhub-devpass-models.json" with { type: "json" };

const EXPECTED_DEVPASS_IDS = [
	"kimi-k2.6:dev",
	"minimax-m2.7:dev",
	"glm-5.2:dev",
	"gpt-oss-120b:dev",
	"gemma-4-31b-it:dev",
	"qwen3.6-27b:dev",
] as const;

describe("ElectronHub DevPass static seed", () => {
	it("ships all six DevPass model ids including glm-5.2:dev", () => {
		const ids = ELECTRONHUB_DEVPASS_STATIC_MODELS.map(m => m.id).sort();
		expect(ids).toEqual([...EXPECTED_DEVPASS_IDS].sort());
	});

	it("keeps maxTokens null and marks all models reasoning+tool-capable", () => {
		for (const model of ELECTRONHUB_DEVPASS_STATIC_MODELS) {
			expect(model.maxTokens).toBeNull();
			expect(model.provider).toBe("electronhub");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.electronhub.ai/v1");
			// Per docs.electronhub.ai/billing/coding-plan all DevPass models support
			// reasoning and function calling — guard against offline regression.
			expect(model.reasoning).toBe(true);
			expect(model.supportsTools).not.toBe(false);
		}
	});
});

function mockElectronHubModelsResponse(entries: Array<Record<string, unknown>>): FetchImpl {
	return async () =>
		new Response(JSON.stringify({ object: "list", data: entries }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
}

function makeEntry(
	id: string,
	opts: {
		vision?: boolean;
		reasoning?: boolean;
		functionCall?: boolean;
		devpassOnly?: boolean;
		devpassPlan?: boolean;
		tokens?: number;
	} = {},
) {
	return {
		id,
		object: "model",
		context_length: 100000,
		...(opts.tokens !== undefined && { tokens: opts.tokens }),
		metadata: {
			vision: opts.vision ?? false,
			reasoning: opts.reasoning ?? false,
			function_call: opts.functionCall ?? true,
			web_search: false,
			...(opts.devpassOnly !== undefined && { devpass_only: opts.devpassOnly }),
		},
		...(opts.devpassPlan && { pricing: { type: "per_million_tokens", plan: "devpass" } }),
	};
}

describe("ElectronHub dynamic discovery", () => {
	it("filters out non-:dev models, keeping only DevPass entries", async () => {
		const fetchMock = mockElectronHubModelsResponse([
			makeEntry("glm-5.2:dev", { reasoning: true, devpassOnly: true }),
			makeEntry("kimi-k2.6:dev", { reasoning: true, devpassOnly: true }),
			// Non-DevPass models that must be rejected:
			makeEntry("gpt-5.1", { reasoning: true }),
			makeEntry("claude-opus-5", { reasoning: true }),
			makeEntry("gemini-3-pro", { vision: true, reasoning: true }),
			// Edge: a devpass_only model WITHOUT the :dev suffix should still pass.
			makeEntry("special-devpass-model", { reasoning: true, devpassOnly: true }),
			// Edge: a model with pricing.plan=devpass but no :dev suffix and no
			// metadata.devpass_only should still pass (two live DevPass records
			// omit devpass_only — pricing.plan is the reliable secondary signal).
			makeEntry("plan-only-devpass-model", { reasoning: true, devpassPlan: true }),
		]);

		const manager = createModelManager(electronHubModelManagerOptions({ apiKey: "ek-dev_test", fetch: fetchMock }));
		const { models } = await manager.refresh("online");
		const ids = models.map(m => m.id).sort();

		expect(ids).toEqual(["glm-5.2:dev", "kimi-k2.6:dev", "plan-only-devpass-model", "special-devpass-model"].sort());
	});

	it("maps live metadata: vision → image input, reasoning always true for DevPass", async () => {
		const fetchMock = mockElectronHubModelsResponse([
			makeEntry("glm-5.2:dev", { reasoning: true, functionCall: true, vision: false, tokens: 200000 }),
			makeEntry("gemma-4-31b-it:dev", { reasoning: true, functionCall: true, vision: true, tokens: 200000 }),
			makeEntry("qwen3.6-27b:dev", { reasoning: false, functionCall: true, vision: true, tokens: 262000 }),
		]);

		const manager = createModelManager(electronHubModelManagerOptions({ apiKey: "ek-dev_test", fetch: fetchMock }));
		const { models } = await manager.refresh("online");
		const byId = new Map(models.map(m => [m.id, m as Model<"openai-completions">]));

		const glm = byId.get("glm-5.2:dev");
		expect(glm).toBeDefined();
		expect(glm!.reasoning).toBe(true);
		expect(glm!.input).toEqual(["text"]);
		// Resolver reads entry.tokens (not context_length) — guard against
		// the stale 400k that was in the fixture and static seed.
		expect(glm!.contextWindow).toBe(200000);

		const gemma = byId.get("gemma-4-31b-it:dev");
		expect(gemma).toBeDefined();
		expect(gemma!.reasoning).toBe(true);
		expect(gemma!.input).toEqual(["text", "image"]);
		expect(gemma!.contextWindow).toBe(200000);

		const qwen = byId.get("qwen3.6-27b:dev");
		expect(qwen).toBeDefined();
		expect(qwen!.reasoning).toBe(true);
		expect(qwen!.input).toEqual(["text", "image"]);
		expect(qwen!.contextWindow).toBe(262000);
	});
});

describe("ElectronHub DevPass static seed mirrors live /v1/models", () => {
	// Source evidence for the three IDs the public Coding Plan docs omit
	// (gpt-oss-120b:dev, gemma-4-31b-it:dev, qwen3.6-27b:dev). The fixture is
	// a sanitized snapshot of the live `/v1/models` DevPass entries — no API
	// key, only the fields the resolver relies on. Asserts the review
	// contract: every static-seed id appears in the live data with a `:dev`
	// suffix and `pricing.plan === "devpass"`.
	const liveEntries = ELECTRONHUB_LIVE_DEVPASS.data as Array<Record<string, unknown>>;

	it("every static-seed id is present in the live fixture", () => {
		const liveIds = new Set(liveEntries.map(e => e.id));
		for (const seed of ELECTRONHUB_DEVPASS_STATIC_MODELS) {
			expect(liveIds.has(seed.id)).toBe(true);
		}
	});

	it("every live DevPass entry has :dev suffix and pricing.plan devpass", () => {
		for (const entry of liveEntries) {
			const id = entry.id;
			expect(typeof id === "string" && id.endsWith(":dev")).toBe(true);
			const pricing = entry.pricing;
			expect(
				typeof pricing === "object" && pricing !== null && "plan" in pricing && pricing.plan === "devpass",
			).toBe(true);
		}
	});

	it("static seed contextWindow matches live fixture tokens for every model", () => {
		const liveTokens = new Map(liveEntries.map(e => [e.id as string, e.tokens as number | undefined]));
		for (const seed of ELECTRONHUB_DEVPASS_STATIC_MODELS) {
			const live = liveTokens.get(seed.id);
			expect(live).toBeDefined();
			expect(seed.contextWindow).toBe(live ?? null);
		}
	});
});
