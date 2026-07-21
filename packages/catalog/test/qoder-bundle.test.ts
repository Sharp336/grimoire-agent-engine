import { describe, expect, it } from "bun:test";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import { buildQoderStaticSeed, qoderModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const bundled = isRecord(MODELS_JSON) && isRecord(MODELS_JSON.qoder) ? MODELS_JSON.qoder : {};
const seed = buildQoderStaticSeed();

// Qoder has no unauthenticated /models discovery. This parity guard makes the
// generator's explicit offline seed required for synchronous boot before OAuth
// credentials are available. After changing the seed, regenerate models.json.
describe("Qoder bundled catalog", () => {
	it("bundles every curated id", () => {
		expect(Object.keys(bundled).sort()).toEqual(seed.map(model => model.id).sort());
	});

	it("uses the offline seed without dynamic discovery", () => {
		const options = qoderModelManagerOptions();
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels).toEqual(seed);
	});

	for (const seededModel of seed) {
		it(`matches the seed contract for ${seededModel.id}`, () => {
			const bundledEntry = bundled[seededModel.id];
			expect(bundledEntry, `qoder/${seededModel.id} missing from models.json`).toBeDefined();
			if (!isRecord(bundledEntry)) {
				throw new Error(`qoder/${seededModel.id} must be a model record`);
			}

			expect(bundledEntry.id).toBe(seededModel.id);
			expect(bundledEntry.name).toBe(seededModel.name);
			expect(bundledEntry.provider).toBe("qoder");
			expect(bundledEntry.api).toBe("openai-completions");
			expect(bundledEntry.baseUrl).toBe(seededModel.baseUrl);
			expect(bundledEntry.contextWindow).toBe(seededModel.contextWindow);
			expect(bundledEntry.maxTokens).toBe(seededModel.maxTokens);
			expect(bundledEntry.reasoning).toBe(seededModel.reasoning);
			expect(bundledEntry.input).toEqual(seededModel.input);
			expect(bundledEntry.cost).toEqual(seededModel.cost);
			expect(seededModel.compat?.supportsStore).toBe(false);
			expect(bundledEntry.compat).toEqual(seededModel.compat);
		});
	}
});
