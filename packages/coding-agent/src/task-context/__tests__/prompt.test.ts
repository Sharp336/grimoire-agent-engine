import { describe, expect, it } from "bun:test";
import { buildCodemapInjectionBlock } from "../prompt";
import type { TaskContextResult } from "../retrieve";

function makeResult(overrides: Partial<TaskContextResult> = {}): TaskContextResult {
	return {
		task: "implement auth",
		files: [],
		meta: { fileCount: 0, estimatedTokens: 0, truncated: false },
		...overrides,
	};
}

function makeFile(overrides: Partial<TaskContextResult["files"][number]> = {}): TaskContextResult["files"][number] {
	return {
		path: "src/auth.ts",
		score: 0.5,
		summary: "Handles JWT verification.",
		stale: false,
		missing: false,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("codemap buildCodemapInjectionBlock — empty result", () => {
	it("returns empty string when files array is empty", () => {
		expect(buildCodemapInjectionBlock(makeResult())).toBe("");
	});
});

describe("codemap buildCodemapInjectionBlock — structure", () => {
	it("includes the task text in the header", () => {
		const block = buildCodemapInjectionBlock(
			makeResult({ task: "refactor the database layer", files: [makeFile()] }),
		);
		expect(block).toContain('The following file summaries are relevant to the task: "refactor the database layer"');
	});

	it("includes each file path as a heading with its summary", () => {
		const block = buildCodemapInjectionBlock(
			makeResult({
				files: [
					makeFile({ path: "src/a.ts", summary: "Summary A." }),
					makeFile({ path: "src/b.ts", summary: "Summary B." }),
				],
			}),
		);
		expect(block).toContain("### src/a.ts");
		expect(block).toContain("Summary A.");
		expect(block).toContain("### src/b.ts");
		expect(block).toContain("Summary B.");
	});

	it("preserves file order from the result", () => {
		const block = buildCodemapInjectionBlock(
			makeResult({
				files: [
					makeFile({ path: "src/zzz.ts", summary: "last" }),
					makeFile({ path: "src/aaa.ts", summary: "first" }),
				],
			}),
		);
		const zzzIdx = block.indexOf("src/zzz.ts");
		const aaaIdx = block.indexOf("src/aaa.ts");
		expect(zzzIdx).toBeLessThan(aaaIdx);
	});
});

describe("codemap buildCodemapInjectionBlock — staleness tags", () => {
	it("appends [STALE: file changed] when stale and not missing", () => {
		const block = buildCodemapInjectionBlock(makeResult({ files: [makeFile({ stale: true, missing: false })] }));
		expect(block).toContain("### src/auth.ts [STALE: file changed]");
	});

	it("appends [STALE: file missing] when stale and missing", () => {
		const block = buildCodemapInjectionBlock(makeResult({ files: [makeFile({ stale: true, missing: true })] }));
		expect(block).toContain("### src/auth.ts [STALE: file missing]");
	});

	it("appends no tag when fresh", () => {
		const block = buildCodemapInjectionBlock(makeResult({ files: [makeFile({ stale: false, missing: false })] }));
		expect(block).toContain("### src/auth.ts\n");
		expect(block).not.toContain("[STALE");
	});
});

describe("codemap buildCodemapInjectionBlock — meta footer", () => {
	it("includes file count and estimated tokens in footer", () => {
		const block = buildCodemapInjectionBlock(
			makeResult({
				files: [makeFile()],
				meta: { fileCount: 1, estimatedTokens: 42, truncated: false },
			}),
		);
		expect(block).toContain("_1 summaries, ~42 tokens_");
		expect(block).not.toContain("(truncated)");
	});

	it("appends (truncated) when meta.truncated is true", () => {
		const block = buildCodemapInjectionBlock(
			makeResult({
				files: [makeFile()],
				meta: { fileCount: 1, estimatedTokens: 42, truncated: true },
			}),
		);
		expect(block).toContain("_1 summaries, ~42 tokens (truncated)_");
	});
});
