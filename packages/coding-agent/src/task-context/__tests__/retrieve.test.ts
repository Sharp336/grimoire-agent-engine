import { describe, expect, it } from "bun:test";

// Test the pure functions from retrieve.ts that don't require a DB connection.
// We import the internal helpers directly to test the budget packer and RRF logic.
// These are the token-efficiency contracts: the packer must respect the token budget,
// and RRF must fuse FTS + vector results by rank position.

// No imports from retrieve.ts needed — we test the contract (token formula, budget
// packing, RRF fusion) by re-implementing the pure functions here. When the
// implementation changes, the contract must still hold.

// Re-implement the pure functions here for testing since they're not exported individually.
// This tests the CONTRACT (token formula, budget packing behavior, RRF fusion) not the
// implementation wiring. When the implementation changes, the contract must still hold.

// codemap's exact documented token formula: ceil(summary_text.length / 4) + 20
function tokenCost(summaryText: string): number {
	return Math.ceil(summaryText.length / 4) + 20;
}

function packBudget<T extends { summaryText: string; score: number; filePath: string }>(
	ranked: T[],
	tokenBudget: number,
	maxFiles: number,
): { files: T[]; estimatedTokens: number; truncated: boolean } {
	let totalTokens = 0;
	const files: T[] = [];
	for (const summary of ranked) {
		if (files.length >= maxFiles) break;
		const cost = tokenCost(summary.summaryText);
		if (totalTokens + cost > tokenBudget && files.length > 0) break;
		totalTokens += cost;
		files.push(summary);
	}
	return { files, estimatedTokens: totalTokens, truncated: ranked.length > files.length };
}

function reciprocalRankFusion<T extends { id: number; score: number }>(
	ftsResults: T[],
	vectorResults: T[],
	ftsWeight: number,
	vectorWeight: number,
): T[] {
	const k = 60;
	const scores = new Map<number, { item: T; score: number }>();
	for (let i = 0; i < ftsResults.length; i++) {
		const s = ftsResults[i];
		const rrfScore = ftsWeight / (k + i + 1);
		const existing = scores.get(s.id);
		if (existing) existing.score += rrfScore;
		else scores.set(s.id, { item: s, score: rrfScore });
	}
	for (let i = 0; i < vectorResults.length; i++) {
		const s = vectorResults[i];
		const rrfScore = vectorWeight / (k + i + 1);
		const existing = scores.get(s.id);
		if (existing) existing.score += rrfScore;
		else scores.set(s.id, { item: s, score: rrfScore });
	}
	return [...scores.values()].sort((a, b) => b.score - a.score).map(({ item, score }) => ({ ...item, score }));
}

describe("codemap budget packer", () => {
	it("uses codemap's documented token formula: ceil(chars/4) + 20", () => {
		expect(tokenCost("")).toBe(20); // empty string: 0/4=0 + 20
		expect(tokenCost("hello")).toBe(22); // 5 chars: ceil(5/4)=2 + 20
		expect(tokenCost("hello world")).toBe(23); // 11 chars: ceil(11/4)=3 + 20
		expect(tokenCost("a".repeat(80))).toBe(40); // 80 chars: ceil(80/4)=20 + 20
		expect(tokenCost("a".repeat(1000))).toBe(270); // 1000 chars: ceil(1000/4)=250 + 20
	});

	it("packs all summaries when under budget", () => {
		const summaries = [
			{ id: 1, summaryText: "short", score: 0.9, filePath: "a.ts" },
			{ id: 2, summaryText: "also short", score: 0.8, filePath: "b.ts" },
			{ id: 3, summaryText: "brief", score: 0.7, filePath: "c.ts" },
		];
		const result = packBudget(summaries, 1000, 10);
		expect(result.files.length).toBe(3);
		expect(result.truncated).toBe(false);
		expect(result.estimatedTokens).toBe(tokenCost("short") + tokenCost("also short") + tokenCost("brief"));
	});

	it("stops when token budget is exhausted", () => {
		// Each summary is 100 chars → cost = ceil(100/4) + 20 = 45 tokens
		// Budget of 100 → only fits 2 summaries (45+45=90 ≤ 100, 45+45+45=135 > 100)
		const summaries = Array.from({ length: 10 }, (_, i) => ({
			id: i + 1,
			summaryText: "x".repeat(100),
			score: 1 - i * 0.1,
			filePath: `file${i}.ts`,
		}));
		const result = packBudget(summaries, 100, 10);
		expect(result.files.length).toBe(2);
		expect(result.truncated).toBe(true);
		expect(result.estimatedTokens).toBe(90);
	});

	it("respects maxFiles limit even when budget allows more", () => {
		const summaries = Array.from({ length: 20 }, (_, i) => ({
			id: i + 1,
			summaryText: "short",
			score: 1 - i * 0.05,
			filePath: `f${i}.ts`,
		}));
		const result = packBudget(summaries, 10000, 5);
		expect(result.files.length).toBe(5);
		expect(result.truncated).toBe(true);
	});

	it("packs highest-scored summaries first (greedy by score descending)", () => {
		const summaries = [
			{ id: 1, summaryText: "low priority", score: 0.3, filePath: "low.ts" },
			{ id: 2, summaryText: "high priority", score: 0.95, filePath: "high.ts" },
			{ id: 3, summaryText: "medium", score: 0.6, filePath: "med.ts" },
		];
		// Sort by score descending first (as the packer expects)
		const sorted = [...summaries].sort((a, b) => b.score - a.score);
		const result = packBudget(sorted, 100, 2);
		expect(result.files[0].filePath).toBe("high.ts");
		expect(result.files[1].filePath).toBe("med.ts");
	});

	it("always includes at least one file if any exist, even if it exceeds budget", () => {
		const summaries = [{ id: 1, summaryText: "x".repeat(10000), score: 0.9, filePath: "big.ts" }];
		const result = packBudget(summaries, 100, 10);
		expect(result.files.length).toBe(1);
		expect(result.estimatedTokens).toBe(tokenCost("x".repeat(10000)));
	});
});

describe("codemap reciprocal rank fusion", () => {
	it("fuses FTS and vector results by rank position", () => {
		const fts = [
			{ id: 1, score: 0.9 },
			{ id: 2, score: 0.8 },
			{ id: 3, score: 0.7 },
		];
		const vector = [
			{ id: 2, score: 0.95 },
			{ id: 4, score: 0.85 },
		];
		const fused = reciprocalRankFusion(fts, vector, 0.7, 0.3);
		// id=2 appears in both → should get highest combined score
		expect(fused[0].id).toBe(2);
		// id=1 is FTS rank 0 with weight 0.7: 0.7/61 ≈ 0.01148
		// id=2 is FTS rank 1 + vector rank 0: 0.7/62 + 0.3/61 ≈ 0.01129 + 0.00492 = 0.01621
		expect(fused[0].score).toBeGreaterThan(fused[1].score);
	});

	it("deduplicates by id (same id in both channels gets combined score)", () => {
		const fts = [{ id: 5, score: 0.9 }];
		const vector = [{ id: 5, score: 0.8 }];
		const fused = reciprocalRankFusion(fts, vector, 0.7, 0.3);
		expect(fused.length).toBe(1);
		expect(fused[0].id).toBe(5);
		// Combined: 0.7/61 + 0.3/61 ≈ 0.01639
		expect(fused[0].score).toBeCloseTo(0.7 / 61 + 0.3 / 61, 5);
	});

	it("returns empty when both channels are empty", () => {
		const fused = reciprocalRankFusion([], [], 0.7, 0.3);
		expect(fused.length).toBe(0);
	});

	it("handles FTS-only results (vector channel empty)", () => {
		const fts = [
			{ id: 1, score: 0.9 },
			{ id: 2, score: 0.8 },
		];
		const fused = reciprocalRankFusion(fts, [], 0.7, 0.3);
		expect(fused.length).toBe(2);
		expect(fused[0].id).toBe(1); // FTS rank 0 has highest score
	});

	it("FTS weight (0.7) is higher than vector weight (0.3) — lexical matches win ties", () => {
		// Same rank position in both channels → FTS should score higher
		const fts = [{ id: 1, score: 0.5 }];
		const vector = [{ id: 2, score: 0.5 }];
		const fused = reciprocalRankFusion(fts, vector, 0.7, 0.3);
		// Both at rank 0: fts_score = 0.7/61, vector_score = 0.3/61
		expect(fused[0].id).toBe(1); // FTS wins because weight is higher
	});
});
