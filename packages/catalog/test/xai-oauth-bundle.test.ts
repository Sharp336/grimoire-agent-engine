import { describe, expect, it } from "bun:test";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import {
	buildXaiOAuthStaticSeed,
	xaiOAuthModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Pins the invariant: bundled `models.json` carries every entry the runtime
// curated catalog (XAI_OAUTH_CURATED_MODELS, surfaced via
// buildXaiOAuthStaticSeed) emits. Without this, editing the curated list
// without regenerating `models.json` silently regresses the boot-time
// default-model resolver — the registry sees the runtime seed only after
// `refresh()`, but interactive boot resolves the persisted default
// synchronously from `#loadModels()`, which reads only `models.json`.
//
// Failure here means: run `bun run generate-models` and commit the diff.
describe("xai-oauth bundled catalog (regression)", () => {
	const bundled =
		(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"openai-responses">>>)["xai-oauth"] ?? {};
	const seed = buildXaiOAuthStaticSeed();

	it("bundles every curated id", () => {
		const seededIds = seed.map(model => model.id).sort();
		const bundledIds = Object.keys(bundled).sort();
		expect(bundledIds).toEqual(seededIds);
	});

	for (const seededModel of seed) {
		it(`matches contract for ${seededModel.id}`, () => {
			const bundledEntry = bundled[seededModel.id];
			expect(bundledEntry, `xai-oauth/${seededModel.id} missing from models.json`).toBeDefined();
			expect(bundledEntry.id).toBe(seededModel.id);
			expect(bundledEntry.name).toBe(seededModel.name);
			expect(bundledEntry.provider).toBe("xai-oauth");
			expect(bundledEntry.api).toBe("openai-responses");
			expect(bundledEntry.contextWindow).toBe(seededModel.contextWindow);
			expect(bundledEntry.reasoning).toBe(seededModel.reasoning);
			expect(bundledEntry.input).toEqual(seededModel.input);
			expect(bundledEntry.compat?.supportsReasoningEffort).toBe(seededModel.compat?.supportsReasoningEffort);
		});
	}

	it("exposes grok-build-0.1 as a 256K vision reasoner that omits the effort dial", () => {
		const build = seed.find(model => model.id === "grok-build-0.1");
		expect(build, "grok-build-0.1 must be in the SuperGrok curated seed").toBeDefined();
		expect(build!.reasoning).toBe(true);
		expect(build!.contextWindow).toBe(256_000);
		expect(build!.input).toEqual(["text", "image"]);
		expect(build!.compat?.supportsReasoningEffort).toBe(false);
		expect(build!.compat?.omitReasoningEffort).toBe(true);
		expect(bundled["grok-build-0.1"]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("sets maxTokens equal to contextWindow for every xai-oauth model", () => {
		for (const model of seed) {
			expect(model.maxTokens, `seed ${model.id} maxTokens`).toBe(model.contextWindow);
			expect(bundled[model.id]?.maxTokens, `bundled ${model.id} maxTokens`).toBe(model.contextWindow);
		}
	});

	for (const onlyDynamicId of ["grok-build-0.1", "grok-4.3"] as const) {
		it(`derives injected effort compat per curated id when discovery returns only ${onlyDynamicId}`, async () => {
			const fetchImpl: FetchImpl = async () =>
				new Response(JSON.stringify({ data: [{ id: onlyDynamicId, object: "model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			const options = xaiOAuthModelManagerOptions({ apiKey: "xai-oauth-test-token", fetch: fetchImpl });
			const models = await options.fetchDynamicModels?.();

			const build = models?.find(model => model.id === "grok-build-0.1");
			const grok43 = models?.find(model => model.id === "grok-4.3");

			expect(build?.compat?.supportsReasoningEffort).toBe(false);
			expect(build?.compat?.omitReasoningEffort).toBe(true);
			expect(grok43?.compat?.supportsReasoningEffort ?? true).toBe(true);
			expect(grok43?.compat?.omitReasoningEffort).toBe(false);
		});
	}
});
