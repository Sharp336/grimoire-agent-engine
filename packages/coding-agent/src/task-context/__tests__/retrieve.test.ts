import { describe, expect, it } from "bun:test";
import { extractKeywords, packBudget, reciprocalRankFusion, splitTokens, tokenCost } from "../retrieve";
import type { RankedSummary } from "../store";

// These tests exercise the REAL exported functions from retrieve.ts.
// No re-implementation — if retrieve.ts drifts, these tests catch it.

function makeRankedSummary(id: number, filePath: string, summaryText: string, score: number): RankedSummary {
	return {
		id,
		projectLabel: "test",
		filePath,
		summaryText,
		contentHash: "h",
		symbolName: null,
		symbolKind: null,
		symbolLineRange: null,
		source: "agent",
		updatedAt: "2026-01-01",
		score,
	};
}

describe("codemap extractKeywords", () => {
	it("tokenizes on non-alphanumeric and lowercases", () => {
		expect(extractKeywords("Database Connection-Pool")).toEqual(["database", "connection", "pool"]);
	});

	it("drops tokens shorter than 3 chars", () => {
		expect(extractKeywords("ab cd ef gh ij")).toEqual([]);
	});

	it("drops stopwords", () => {
		expect(extractKeywords("how does the authentication work")).toEqual(["authentication"]);
	});

	it("returns empty for empty string", () => {
		expect(extractKeywords("")).toEqual([]);
	});

	it("returns empty for only-stopword input", () => {
		expect(extractKeywords("the and for with this that")).toEqual([]);
	});
});

describe("codemap splitTokens", () => {
	it("splits camelCase tokens", () => {
		const result = splitTokens(["buildSystemPrompt"]);
		expect(result).toContain("buildSystemPrompt");
		expect(result).toContain("build");
		expect(result).toContain("System");
		expect(result).toContain("Prompt");
	});

	it("splits snake_case tokens", () => {
		const result = splitTokens(["get_task_context"]);
		expect(result).toContain("get_task_context");
		expect(result).toContain("get");
		expect(result).toContain("task");
		expect(result).toContain("context");
	});

	it("deduplicates results", () => {
		const result = splitTokens(["token", "token"]);
		expect(result).toEqual(["token"]);
	});

	it("passes through simple tokens unchanged", () => {
		expect(splitTokens(["simple"])).toEqual(["simple"]);
	});
});

describe("codemap budget packer", () => {
	it("uses codemap's documented token formula: ceil(chars/4) + 20", () => {
		expect(tokenCost("")).toBe(20);
		expect(tokenCost("hello")).toBe(22);
		expect(tokenCost("hello world")).toBe(23);
		expect(tokenCost("a".repeat(80))).toBe(40);
		expect(tokenCost("a".repeat(1000))).toBe(270);
	});

	it("packs all summaries when under budget", () => {
		const summaries = [
			makeRankedSummary(1, "a.ts", "short", 0.9),
			makeRankedSummary(2, "b.ts", "also short", 0.8),
			makeRankedSummary(3, "c.ts", "brief", 0.7),
		];
		const result = packBudget(summaries, 1000, 10, "/tmp");
		expect(result.files.length).toBe(3);
		expect(result.truncated).toBe(false);
		expect(result.estimatedTokens).toBe(tokenCost("short") + tokenCost("also short") + tokenCost("brief"));
	});

	it("stops when token budget is exhausted", () => {
		const summaries = Array.from({ length: 10 }, (_, i) =>
			makeRankedSummary(i + 1, `file${i}.ts`, "x".repeat(100), 1 - i * 0.1),
		);
		const result = packBudget(summaries, 100, 10, "/tmp");
		expect(result.files.length).toBe(2);
		expect(result.truncated).toBe(true);
		expect(result.estimatedTokens).toBe(90);
	});

	it("respects maxFiles limit", () => {
		const summaries = Array.from({ length: 20 }, (_, i) =>
			makeRankedSummary(i + 1, `f${i}.ts`, "short", 1 - i * 0.05),
		);
		const result = packBudget(summaries, 10000, 5, "/tmp");
		expect(result.files.length).toBe(5);
		expect(result.truncated).toBe(true);
	});

	it("packs highest-scored summaries first", () => {
		const summaries = [
			makeRankedSummary(1, "low.ts", "low priority", 0.3),
			makeRankedSummary(2, "high.ts", "high priority", 0.95),
			makeRankedSummary(3, "med.ts", "medium", 0.6),
		];
		const sorted = [...summaries].sort((a, b) => b.score - a.score);
		const result = packBudget(sorted, 100, 2, "/tmp");
		expect(result.files[0].path).toBe("high.ts");
		expect(result.files[1].path).toBe("med.ts");
	});

	it("always includes at least one file if any exist", () => {
		const summaries = [makeRankedSummary(1, "big.ts", "x".repeat(10000), 0.9)];
		const result = packBudget(summaries, 100, 10, "/tmp");
		expect(result.files.length).toBe(1);
		expect(result.estimatedTokens).toBe(tokenCost("x".repeat(10000)));
	});
});

describe("codemap reciprocal rank fusion", () => {
	it("fuses FTS and vector results by rank position", () => {
		const fts = [
			makeRankedSummary(1, "a.ts", "s", 0.9),
			makeRankedSummary(2, "b.ts", "s", 0.8),
			makeRankedSummary(3, "c.ts", "s", 0.7),
		];
		const vector = [makeRankedSummary(2, "b.ts", "s", 0.95), makeRankedSummary(4, "d.ts", "s", 0.85)];
		const fused = reciprocalRankFusion(fts, vector, 0.7, 0.3);
		expect(fused[0].id).toBe(2);
		expect(fused[0].score).toBeGreaterThan(fused[1].score);
	});

	it("deduplicates by id", () => {
		const fts = [makeRankedSummary(5, "x.ts", "s", 0.9)];
		const vector = [makeRankedSummary(5, "x.ts", "s", 0.8)];
		const fused = reciprocalRankFusion(fts, vector, 0.7, 0.3);
		expect(fused.length).toBe(1);
		expect(fused[0].id).toBe(5);
	});

	it("returns empty when both channels are empty", () => {
		expect(reciprocalRankFusion([], [], 0.7, 0.3)).toHaveLength(0);
	});

	it("handles FTS-only results", () => {
		const fts = [makeRankedSummary(1, "a.ts", "s", 0.9), makeRankedSummary(2, "b.ts", "s", 0.8)];
		const fused = reciprocalRankFusion(fts, [], 0.7, 0.3);
		expect(fused.length).toBe(2);
		expect(fused[0].id).toBe(1);
	});

	it("FTS weight (0.7) is higher than vector weight (0.3)", () => {
		const fts = [makeRankedSummary(1, "a.ts", "s", 0.5)];
		const vector = [makeRankedSummary(2, "b.ts", "s", 0.5)];
		const fused = reciprocalRankFusion(fts, vector, 0.7, 0.3);
		expect(fused[0].id).toBe(1);
	});
});
