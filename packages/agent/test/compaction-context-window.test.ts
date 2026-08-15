import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { effectiveContextWindow, fallbackContextWindowForModel } from "../src/compaction/compaction";

const MUSE_WINDOW = 1_048_576;

function makeModel(overrides: Partial<Model> & { id: string; provider: string }): Model {
	return {
		name: overrides.id,
		api: "openai-responses",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...overrides,
	} as unknown as Model;
}

describe("effectiveContextWindow", () => {
	it("returns the declared window when the catalog provides one", () => {
		const model = makeModel({ id: "muse-spark-1.1", provider: "meta", contextWindow: 128_000 });
		// A declared window always wins; the fallback must never override real metadata.
		expect(effectiveContextWindow(model)).toBe(128_000);
	});

	it("reports 0 (compaction disabled) for an unknown model with no declared window", () => {
		const model = makeModel({ id: "some-future-model", provider: "custom" });
		expect(effectiveContextWindow(model)).toBe(0);
	});

	it("reports 0 when there is no model at all", () => {
		expect(effectiveContextWindow(undefined)).toBe(0);
		expect(fallbackContextWindowForModel(undefined)).toBe(0);
	});
});

describe("fallbackContextWindowForModel", () => {
	it.each(["muse-spark-1.1", "muse-spark-1.2", "muse-spark-1.2-contributor"])(
		"grants the published 1M window to Meta %s when metadata is missing",
		id => {
			const model = makeModel({ id, provider: "meta" });
			expect(fallbackContextWindowForModel(model)).toBe(MUSE_WINDOW);
			expect(effectiveContextWindow(model)).toBe(MUSE_WINDOW);
		},
	);

	// The fallback previously matched `id.includes("muse-spark")`, which handed a
	// fabricated 1M window to any third-party model with a Muse-like id and
	// silently postponed compaction until that threshold.
	it.each([
		["a lookalike id on another provider", "not-muse-spark", "custom"],
		["an exact Muse id on another provider", "muse-spark-1.2", "custom"],
		["a Muse-prefixed id on another provider", "muse-spark-1.2-turbo", "openrouter"],
	])("refuses the Meta fallback for %s", (_label, id, provider) => {
		const model = makeModel({ id, provider });
		expect(fallbackContextWindowForModel(model)).toBe(0);
		expect(effectiveContextWindow(model)).toBe(0);
	});

	it.each(["muse-spark-9.9", "muse-spark", "muse-spark-1.2-contributor-preview"])(
		"refuses the fallback for unrecognized Meta id %s",
		id => {
			// Only the exact catalog-declared ids are eligible; a new Muse SKU must be
			// added to the catalog rather than inheriting a guessed 1M window here.
			const model = makeModel({ id, provider: "meta" });
			expect(fallbackContextWindowForModel(model)).toBe(0);
		},
	);

	it("refuses the fallback for inherited object keys", () => {
		// Guards the lookup table against prototype keys such as `constructor`,
		// which a truthiness check on a plain object map would accept.
		for (const id of ["constructor", "toString", "__proto__"]) {
			expect(fallbackContextWindowForModel(makeModel({ id, provider: "meta" }))).toBe(0);
		}
	});
});
