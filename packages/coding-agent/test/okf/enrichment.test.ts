import { describe, expect, it } from "bun:test";
import { buildCodebaseEnrichmentPrompt } from "../../src/okf/enrichment/codebase";

describe("okf/enrichment.buildCodebaseEnrichmentPrompt", () => {
	it("renders a focused codebase-walking assignment", () => {
		const cwd = "C:\\repo\\project";
		const text = buildCodebaseEnrichmentPrompt({ cwd, focus: "auth", maxConcepts: 3 });

		expect(text).toContain("Focus on: auth.");
		expect(text).toContain("Aim for up to 3 high-quality concepts.");
		expect(text).toContain(`Working directory: ${cwd}`);
	});

	it("defaults to whole-codebase exploration and ten concepts", () => {
		const text = buildCodebaseEnrichmentPrompt({ cwd: "/repo/project" });

		expect(text).toContain("Explore the whole codebase.");
		expect(text).toContain("Aim for up to 10 high-quality concepts.");
	});
});
