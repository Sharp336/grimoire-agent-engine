import { describe, expect, it } from "bun:test";
import { buildUsageModelCoverage } from "@oh-my-pi/pi-coding-agent/session/usage-model-coverage";

describe("buildUsageModelCoverage", () => {
	it("maps full and partial coverage per provider and omits non-reporting providers", () => {
		const models = [
			{ provider: "anthropic", id: "claude-a" },
			{ provider: "anthropic", id: "claude-b" },
			{ provider: "antigravity", id: "claude-x" },
			{ provider: "antigravity", id: "gemini-y" },
			{ provider: "keyless", id: "local-model" },
		];
		const coverage = buildUsageModelCoverage(models, (provider, modelIds) => {
			if (provider === "anthropic") return modelIds; // account-wide quota: every model reports
			if (provider === "antigravity") return modelIds.filter(id => id.startsWith("claude-"));
			return []; // no usage endpoint
		});

		// Full coverage: reporting length equals availableCount, so renderers collapse.
		expect(coverage.get("anthropic")).toEqual({
			reporting: ["anthropic/claude-a", "anthropic/claude-b"],
			availableCount: 2,
		});
		// Partial coverage: the uncovered model keeps the provider below full coverage.
		expect(coverage.get("antigravity")).toEqual({
			reporting: ["antigravity/claude-x"],
			availableCount: 2,
		});
		// A provider with no quantitative mapping is omitted, not reported as empty.
		expect(coverage.has("keyless")).toBe(false);
	});

	it("counts duplicate registry entries once and dedupes/sorts duplicate reporting ids", () => {
		// A duplicate registry row must not inflate availableCount past the
		// reporting set — that would misrender a fully-covered provider as
		// partial and resurrect the model-list dump.
		const models = [
			{ provider: "openai-codex", id: "gpt-a" },
			{ provider: "openai-codex", id: "gpt-a" },
			{ provider: "openai-codex", id: "gpt-b" },
		];
		const coverage = buildUsageModelCoverage(models, (_provider, modelIds) => [
			...[...modelIds].reverse(),
			...modelIds,
		]);

		expect(coverage.get("openai-codex")).toEqual({
			reporting: ["openai-codex/gpt-a", "openai-codex/gpt-b"],
			availableCount: 2,
		});
	});
});
