import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildOpenAIResponsesCompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import {
	AZURE_CURATED_FALLBACK_MODELS,
	DEFAULT_MODEL_PER_PROVIDER,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// A models.dev "azure" payload: two OpenAI-family models (one reasoning), a
// non-tool-capable instruct model, and a Foundry-hosted third party served via
// a per-model `provider` override (claude over .services.ai.azure.com).
const AZURE_MODELS_DEV_FIXTURE = {
	azure: {
		models: {
			"gpt-4o": { name: "GPT-4o", tool_call: true, limit: { context: 128000, output: 16384 } },
			o3: { name: "o3", tool_call: true, reasoning: true, limit: { context: 200000, output: 100000 } },
			"gpt-3.5-turbo-instruct": { name: "GPT-3.5 Turbo Instruct", tool_call: false },
			"claude-opus-4-5": {
				name: "Claude Opus 4.5",
				tool_call: true,
				reasoning: true,
				provider: { npm: "@ai-sdk/anthropic", api: "https://x.services.ai.azure.com/anthropic/v1" },
			},
		},
	},
};

describe("azure catalog provider", () => {
	test("is catalog-only (no runtime discovery) with an env-var-backed default model", () => {
		// Mirrors Bedrock: bundled models + env auth, no model-manager factory, so
		// it must NOT appear in the runtime discovery descriptor list.
		expect(PROVIDER_DESCRIPTORS.some(d => d.providerId === "azure")).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER.azure).toBe("gpt-5.5");
	});

	test("models.dev descriptor keeps only OpenAI-family Responses models, baseUrl resolved at runtime", () => {
		const azure = mapModelsDevToModels(AZURE_MODELS_DEV_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "azure",
		);
		const ids = azure.map(model => model.id).sort();
		// gpt-4o + o3 survive; the instruct model (no tool_call) and the Foundry
		// Claude (non-Responses, per-model provider override) are dropped.
		expect(ids).toEqual(["gpt-4o", "o3"]);
		for (const model of azure) {
			expect(model.api).toBe("azure-openai-responses");
			// Empty baseUrl: the deployment host is per-resource, resolved at runtime.
			expect(model.baseUrl).toBe("");
		}
	});

	test("bundled-shape spec (provider id, empty baseUrl) resolves the Azure Responses compat flags", () => {
		// The deployment host is only known at request time, so detection MUST key
		// off the provider id, not the (empty) baseUrl.
		const compat = buildOpenAIResponsesCompat({ provider: "azure", name: "GPT-5", baseUrl: "" });
		expect(compat.strictResponsesPairing).toBe(true);
		expect(compat.supportsStrictMode).toBe(true);
		expect(compat.supportsDeveloperRole).toBe(true);
	});

	test("Azure reasoning models infer the OpenAI Responses effort vocabulary", () => {
		const spec: ModelSpec<"azure-openai-responses"> = {
			id: "o3",
			name: "o3",
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 100000,
		};
		const model = buildModel(spec);
		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking?.efforts).toContain(Effort.XHigh);
	});
});

// Pins the invariant: bundled `models.json` carries every entry the curated
// azure gpt-5.6 seed (AZURE_CURATED_FALLBACK_MODELS) emits. models.dev has not
// catalogued the gpt-5.6 generation for azure yet, so the bundle is the only
// source for these ids. Failure here means: run `bun run gen:models` and
// commit the diff.
describe("azure curated gpt-5.6 seed (regression)", () => {
	const bundled =
		(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"azure-openai-responses">>>).azure ?? {};

	test("seed covers the gpt-5.6 deployment generation", () => {
		expect(AZURE_CURATED_FALLBACK_MODELS.map(model => model.id).sort()).toEqual([
			"gpt-5.6",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
		]);
	});

	for (const seeded of AZURE_CURATED_FALLBACK_MODELS) {
		test(`bundles ${seeded.id} with the azure Responses shape`, () => {
			const entry = bundled[seeded.id];
			expect(entry, `azure/${seeded.id} missing from models.json`).toBeDefined();
			expect(entry.api).toBe("azure-openai-responses");
			expect(entry.provider).toBe("azure");
			// Empty baseUrl: the deployment host is per-resource, resolved at runtime.
			expect(entry.baseUrl).toBe("");
			expect(entry.reasoning).toBe(true);
			expect(entry.input).toEqual(["text", "image"]);
			expect(entry.contextWindow).toBe(seeded.contextWindow);
			expect(entry.maxTokens).toBe(seeded.maxTokens);
			// Azure does not bill cache writes; mirrors every other bundled azure row.
			expect(entry.cost).toEqual(seeded.cost);
			// Policy pass must bake the gpt-5.6 effort vocabulary (incl. max).
			expect(entry.thinking?.mode).toBe("effort");
			expect(entry.thinking?.efforts).toContain(Effort.XHigh);
		});
	}
});
