import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";

// Pins the artifact invariant for the zai bundle: glm-5.2's base row must
// keep the 1M context window and the bundle must never carry the `[1m]`
// context-tier ids that `dropUnusableZaiContextTierIds` strips at generation
// time (the inference endpoint rejects them with `Unknown Model`). Same
// pattern as minimax-bundled-catalog.test.ts: a failure here means an
// upstream stencil shift or a regen regression changed the shipped bundle —
// run `bun run gen:models`, inspect the diff, and commit it (or fix the
// generator). The curated glm-5.3-flash row's full metadata is asserted at
// the resolver level in zai-provider.test.ts (discovery merge against the
// real bundled reference), so it is deliberately not re-pinned here.
interface BundledModel {
	provider: string;
	api: string;
	baseUrl: string;
	contextWindow: number | null;
	maxTokens: number | null;
}

describe("zai bundled catalog", () => {
	it("pins glm-5.2 base entry to 1M context with no context-tier ids", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.2"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zai");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(Object.keys(zaiModels)).not.toContain("glm-5.2[1m]");
	});
});
