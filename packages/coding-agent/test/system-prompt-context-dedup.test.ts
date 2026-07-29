import { describe, expect, it } from "bun:test";
import { dedupeContainedContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";

interface ContextFile {
	path: string;
	content: string;
	depth?: number;
}

function file(path: string, content: string, depth?: number): ContextFile {
	return { path, content, depth };
}

function paths(files: ContextFile[]): string[] {
	return files.map(f => f.path);
}

describe("dedupeContainedContextFiles", () => {
	it("keeps only the more authoritative file when two are byte-identical", () => {
		const content = "Rule one.\n\nRule two.\n\nRule three.";
		const files = [file("/home/user/.config/AGENTS.md", content, 5), file("/project/AGENTS.md", content, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});

	it("drops a file whose paragraphs appear contiguously in a more authoritative file", () => {
		const lessAuthoritative = "Shared rule A.\n\nShared rule B.\n\nShared rule C.";
		const moreAuthoritative = "Shared rule A.\n\nShared rule B.\n\nShared rule C.\n\nProject-specific rule.";

		const files = [
			file("/home/user/.config/AGENTS.md", lessAuthoritative, 5),
			file("/project/AGENTS.md", moreAuthoritative, 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});

	it("keeps a file whose paragraphs appear non-contiguously (interleaved)", () => {
		// A's three paragraphs are all in B, but not as a contiguous run.
		const a = "First.\n\nSecond.\n\nThird.";
		const b = "First.\n\nInterleaved.\n\nSecond.\n\nThird.";

		const files = [file("/home/user/.config/AGENTS.md", a, 5), file("/project/AGENTS.md", b, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps a file whose paragraphs appear with wording changes (containment is exact, not fuzzy)", () => {
		const a = "Always use tabs.\n\nNever commit directly.";
		const b = "Always use spaces.\n\nNever commit directly to main.";

		const files = [file("/home/user/.config/AGENTS.md", a, 5), file("/project/AGENTS.md", b, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps all files when there is no containment", () => {
		const files = [
			file("/a/AGENTS.md", "Alpha rules.\n\nBeta rules.", 3),
			file("/b/AGENTS.md", "Gamma rules.\n\nDelta rules.", 2),
			file("/c/AGENTS.md", "Epsilon rules.\n\nZeta rules.", 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/a/AGENTS.md", "/b/AGENTS.md", "/c/AGENTS.md"]);
	});

	it("treats empty content as no blocks, never matched", () => {
		const files = [file("/empty/AGENTS.md", "", 5), file("/project/AGENTS.md", "Real content.", 0)];

		// Empty file produces zero blocks; promptBlocksContain returns false for
		// empty ruleBlocks, so the empty file is kept (it cannot be contained).
		// The non-empty file is also kept since the empty file has no blocks to
		// contain it.
		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/empty/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps only the most authoritative file in a transitive chain A⊂B⊂C", () => {
		const a = "Rule one.\n\nRule two.";
		const b = "Rule one.\n\nRule two.\n\nRule three.";
		const c = "Rule one.\n\nRule two.\n\nRule three.\n\nRule four.";

		const files = [
			file("/level0/AGENTS.md", a, 10),
			file("/level1/AGENTS.md", b, 5),
			file("/level2/AGENTS.md", c, 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/level2/AGENTS.md"]);
	});

	it("normalizes leading and trailing whitespace before comparing paragraphs", () => {
		// Same paragraphs, but A has leading/trailing whitespace on each line.
		// Normalization (trim per block) should still detect containment.
		const a = "  Rule one.  \n\n  Rule two.  ";
		const b = "Rule one.\n\nRule two.\n\nRule three.";

		const files = [file("/home/user/.config/AGENTS.md", a, 5), file("/project/AGENTS.md", b, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});
});
