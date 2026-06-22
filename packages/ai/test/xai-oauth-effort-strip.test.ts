import { describe, expect, test } from "bun:test";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("effort-dial-less reasoner encoding (regression)", () => {
	test("xai-oauth/grok-build-0.1 reasons but carries no thinking config", () => {
		const grokBuild = getBundledModel("xai-oauth", "grok-build-0.1");
		if (!grokBuild) throw new Error("xai-oauth/grok-build-0.1 must be in bundled models.json");
		expect(grokBuild.reasoning).toBe(true);
		expect(grokBuild.thinking).toBeUndefined();
		expect(getSupportedEfforts(grokBuild)).toEqual([]);
	});

	test("xai-oauth/grok-4.3 keeps its effort dial", () => {
		const grok43 = getBundledModel("xai-oauth", "grok-4.3");
		if (!grok43) throw new Error("xai-oauth/grok-4.3 must be in bundled models.json");
		expect(grok43.thinking).toBeDefined();
		expect(getSupportedEfforts(grok43).length).toBeGreaterThan(0);
	});

	test("non-Grok reasoners keep their effort dial", () => {
		const claude = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!claude) throw new Error("anthropic/claude-sonnet-4-6 must be in bundled models.json");
		expect(claude.thinking).toBeDefined();
	});
});
