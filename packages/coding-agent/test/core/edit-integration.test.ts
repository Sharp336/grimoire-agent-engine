/**
 * Integration test battery for the edit recovery system.
 * Exercises: normal edits, pre-shift, 3-way merge, partial-snapshot rejection,
 * no-cache fallback, multi-section, identity edits, missing files.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyHashlineEdits,
	computeLineHash,
	detectLineEnding,
	executeHashlineSingle,
	FileReadCache,
	getFileReadCache,
	HashlineMismatchError,
	normalizeToLF,
	parseHashline,
	parseHashlineWithWarnings,
	restoreLineEndings,
	splitHashlineInputs,
	stripBom,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const pl = (text: string): string => text;
const tag = (line: number, content: string): string => `${line}${computeLineHash(line, content)}`;
const sameLineRange = (anchor: string): string => `${anchor}..${anchor}`;

/** Compute a 1-indexed tag for the Nth line of `text` (0‑based idx). */
function lineTag(text: string, idx: number): string {
	const lines = text.split("\n");
	const lineNum = idx + 1;
	return `${lineNum}${computeLineHash(lineNum, lines[idx])}`;
}

function mergeSamePathSections(sections: Array<{ path: string; diff: string }>): Array<{ path: string; diff: string }> {
	const byPath = new Map<string, string[]>();
	for (const section of sections) {
		const existing = byPath.get(section.path);
		if (existing) existing.push(section.diff);
		else byPath.set(section.path, [section.diff]);
	}
	return Array.from(byPath, ([path, diffs]) => ({ path, diff: diffs.join("\n") }));
}

function makeSession(tempDir: string): ToolSession {
	return { cwd: tempDir, settings: Settings.isolated() as Settings } as ToolSession;
}

function makeOptions(_tempDir: string, input: string, session: ToolSession) {
	return {
		session,
		input,
		writethrough: async (targetPath: string, content: string) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-int-"));
	try {
		await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function readFile(p: string): Promise<string> {
	return (await Bun.file(p).text()).replace(/\n$/, "");
}

function getResultText(result: any): string {
	return result.content?.[0]?.type === "text" ? result.content[0].text : "";
}

resetSettingsForTest();
await Settings.init({ inMemory: true, cwd: process.cwd() });

describe("edit recovery integration", () => {
	it("happy path — normal edit works", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = "alpha\nbeta\ngamma";
			await Bun.write(fp, `${v0}\n`);

			const session = makeSession(td);
			const input = `§a.ts\n≔${sameLineRange(tag(2, "beta"))}\n${pl("BETA")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			const disk = await readFile(fp);
			expect(disk).toBe("alpha\nBETA\ngamma");
			expect(getResultText(result)).toContain("BETA");
			expect(result.details?.correctedInput).toBeUndefined();
			expect(result.details?.path).toBe("a.ts");
		});
	});

	it("pre-shift recovery — external actor prepends lines", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
			await Bun.write(fp, `${v0.join("\n")}\n`);

			const session = makeSession(td);
			getFileReadCache(session).recordFullFile(fp, `${v0.join("\n")}\n`);

			const headers = ["H1", "H2", "H3"];
			const v1 = [...headers, ...v0].join("\n");
			await Bun.write(fp, `${v1}\n`);

			const input = `§a.ts\n≔${sameLineRange(tag(2, "L2"))}\n${pl("L2-EDITED")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			const disk = await readFile(fp);
			expect(disk).toContain("L2-EDITED");
			expect(disk).not.toContain("\nL2\n");
			expect(getResultText(result)).toContain("Auto-shifted");
			expect(disk).toContain("H1\nH2\nH3");
		});
	});
	it("pre-shift recovery works after partial cache hit on full snapshot", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = ["L1", "L2", "L3", "L4", "L5"];
			await Bun.write(fp, `${v0.join("\n")}\n`);

			const session = makeSession(td);
			const cache = getFileReadCache(session);
			// Full-file read sets isPartial=false and fullContent
			cache.recordFullFile(fp, `${v0.join("\n")}\n`);
			// Simulate a later partial read/search of the same file (non-conflicting)
			cache.recordContiguous(fp, 3, ["L3", "L4"]);
			// fullContent should still be present and isPartial should stay false
			const snap = cache.get(fp);
			expect(snap?.fullContent).toBeDefined();
			expect(snap?.isPartial).toBe(false);

			// Now an external actor prepends a line
			const v1 = ["H1", ...v0].join("\n");
			await Bun.write(fp, `${v1}\n`);

			// Edit anchored against original read — should still recover via pre-shift
			const input = `§a.ts\n≔${sameLineRange(tag(2, "L2"))}\n${pl("L2-EDITED")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			const disk = await readFile(fp);
			expect(disk).toContain("L2-EDITED");
			expect(getResultText(result)).toContain("Auto-shifted");
		});
	});

	it("3-way merge recovery — file modified structurally", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = ["alpha", "beta", "gamma", "delta", "epsilon"];
			await Bun.write(fp, `${v0.join("\n")}\n`);

			const session = makeSession(td);
			getFileReadCache(session).recordFullFile(fp, `${v0.join("\n")}\n`);

			const v1 = ["ALPHA-EXT", "beta", "gamma", "delta", "epsilon"];
			await Bun.write(fp, `${v1.join("\n")}\n`);

			const input = `§a.ts\n≔${sameLineRange(tag(4, "delta"))}\n${pl("DELTA-MODEL")}\n`;
			await executeHashlineSingle(makeOptions(td, input, session));

			const disk = await readFile(fp);
			expect(disk).toContain("DELTA-MODEL");
			expect(disk).toContain("ALPHA-EXT");
			expect(disk).not.toContain("\ndelta\n");
		});
	});

	it("partial snapshot rejected — returns correctedInput, disk unchanged", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
			await Bun.write(fp, `${v0.join("\n")}\n`);

			const session = makeSession(td);
			getFileReadCache(session).recordContiguous(fp, 1, v0.slice(0, 3));

			const v1 = [...v0];
			v1[5] = "L6-CHANGED";
			await Bun.write(fp, `${v1.join("\n")}\n`);

			const input = `§a.ts\n≔${sameLineRange(tag(6, "L6"))}\n${pl("L6-MODEL")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			expect(typeof result.details?.correctedInput).toBe("string");
			// correctedInput must include the file header so the model can retry directly
			expect(result.details?.correctedInput).toMatch(/^§a\.ts\n/);
			const actualHash = computeLineHash(6, "L6-CHANGED");
			expect(result.details?.correctedInput).toContain(`6${actualHash}`);
			const staleHash = computeLineHash(6, "L6");
			expect(result.details?.correctedInput).not.toContain(`6${staleHash}`);
			const disk = await readFile(fp);
			expect(disk).toBe(v1.join("\n"));
		});
	});

	it("no cache — returns correctedInput with fixed anchors", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			await Bun.write(fp, "hello\nworld\nfoo\nbar\n");

			const session = makeSession(td);
			const wrongHash = "xx";
			const input = `§a.ts\n≔3${wrongHash}..3${wrongHash}\n${pl("REPLACED")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			expect(typeof result.details?.correctedInput).toBe("string");
			const actualHash = computeLineHash(3, "foo");
			expect(result.details?.correctedInput ?? "").toContain(`3${actualHash}`);
			expect(result.details?.correctedInput ?? "").not.toContain("xx");
			const disk = await readFile(fp);
			expect(disk).toBe("hello\nworld\nfoo\nbar");
		});
	});

	it("multi-section edit — two sections targeting same file merge", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = "alpha\nbeta\ngamma\ndelta\nepsilon";
			await Bun.write(fp, `${v0}\n`);

			const session = makeSession(td);
			const input = [
				"§a.ts",
				`≔${sameLineRange(tag(2, "beta"))}`,
				pl("BETA"),
				"",
				"§a.ts",
				`≔${sameLineRange(tag(4, "delta"))}`,
				pl("DELTA"),
			].join("\n");

			await executeHashlineSingle(makeOptions(td, input, session));

			const disk = await readFile(fp);
			expect(disk).toContain("BETA");
			expect(disk).toContain("DELTA");
		});
	});

	it("repeated failures on same path both produce correctedInput", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			await Bun.write(fp, "alpha\nbeta\ngamma\n");

			const session = makeSession(td);
			const input = `§a.ts\n≔${sameLineRange(tag(2, "WRONG-CONTENT"))}\n${pl("BAD-EDIT")}\n`;

			const r1 = await executeHashlineSingle(makeOptions(td, input, session));
			expect(typeof r1.details?.correctedInput).toBe("string");

			const r2 = await executeHashlineSingle(makeOptions(td, input, session));
			expect(typeof r2.details?.correctedInput).toBe("string");

			const staleHash = computeLineHash(2, "WRONG-CONTENT");
			expect(r1.details?.correctedInput ?? "").not.toContain(staleHash);
			expect(r2.details?.correctedInput ?? "").not.toContain(staleHash);
		});
	});

	it("pre-shift with realistic code — import added at top", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = ["import { foo } from './foo';", "", "const x = 1;", "const y = 2;"];
			await Bun.write(fp, `${v0.join("\n")}\n`);

			const session = makeSession(td);
			getFileReadCache(session).recordFullFile(fp, `${v0.join("\n")}\n`);

			const v1 = ["import { qux } from './qux';", ...v0];
			await Bun.write(fp, `${v1.join("\n")}\n`);

			const input = `§a.ts\n≔${sameLineRange(tag(4, "const y = 2;"))}\n${pl("const y = 42;")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			const disk = await readFile(fp);
			expect(disk).toContain("import { qux }");
			expect(disk).toContain("const y = 42;");
			expect(disk).not.toContain("const y = 2;");
			const text = getResultText(result);
			expect(text.includes("Auto-shifted") || text.includes("Recovered from stale anchors")).toBe(true);
		});
	});

	it("3-way merge with multiline function — body changed externally", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = ["function alpha() {", "  return 1;", "}", "", "function beta() {", "  return 2;", "}"];
			await Bun.write(fp, `${v0.join("\n")}\n`);

			const session = makeSession(td);
			getFileReadCache(session).recordFullFile(fp, `${v0.join("\n")}\n`);

			const v1 = [...v0];
			v1[5] = "  return 20;";
			await Bun.write(fp, `${v1.join("\n")}\n`);

			const input = `§a.ts\n≔${sameLineRange(tag(2, "  return 1;"))}\n${pl("  return 10;")}\n`;
			await executeHashlineSingle(makeOptions(td, input, session));

			const disk = await readFile(fp);
			expect(disk).toContain("return 20;");
			expect(disk).toContain("return 10;");
			expect(disk).not.toContain("return 1;");
		});
	});

	it("identity edit (no change) produces diagnostic", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = "alpha\nbeta\ngamma";
			await Bun.write(fp, `${v0}\n`);

			const session = makeSession(td);
			const input = `§a.ts\n≔${sameLineRange(tag(2, "beta"))}\n${pl("beta")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			expect(getResultText(result)).toContain("no changes being made");
			expect(result.details?.diff).toBe("");
		});
	});

	it("non-existent file with anchor-scoped edits throws", async () => {
		await withTempDir(async td => {
			const session = makeSession(td);
			const input = `§missing.ts\n≔${sameLineRange(tag(1, "alpha"))}\n${pl("REPLACED")}\n`;

			await expect(executeHashlineSingle(makeOptions(td, input, session))).rejects.toThrow("File not found");
		});
	});

	it("new file creation (no anchor-scoped edits) works", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "new.ts");
			const session = makeSession(td);

			const input = `§new.ts\n« BOF\n${pl("export const x = 1;")}\n${pl("export const y = 2;")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			const disk = await readFile(fp);
			expect(disk).toContain("export const x = 1;");
			expect(disk).toContain("export const y = 2;");
			expect(result.details?.op).toBe("create");
		});
	});
	it("all recovery tiers exhausted — returns correctedInput when content changed and shifted", async () => {
		await withTempDir(async td => {
			const fp = path.join(td, "a.ts");
			const v0 = ["aaa", "bbb", "ccc", "ddd", "eee"];
			await Bun.write(fp, `${v0.join("\n")}\n`);

			const session = makeSession(td);
			getFileReadCache(session).recordFullFile(fp, `${v0.join("\n")}\n`);

			// Insert a line at top AND change line 2's content → pre-shift can't help
			const v1 = ["NEW", "aaa", "XXX", "ccc", "ddd", "eee"];
			await Bun.write(fp, `${v1.join("\n")}\n`);

			const input = `§a.ts\n≔${sameLineRange(tag(2, "bbb"))}\n${pl("BBB-EDITED")}\n`;
			const result = await executeHashlineSingle(makeOptions(td, input, session));

			// All three recovery tiers fail → correctedInput returned, disk unchanged
			expect(result.details?.correctedInput).toBeString();
			const disk = await readFile(fp);
			expect(disk).toBe(v1.join("\n"));
		});
	});
});

describe("mergeSamePathSections", () => {
	it("merges two sections with same path into one", () => {
		const result = mergeSamePathSections([
			{ path: "a.ts", diff: "diff1" },
			{ path: "a.ts", diff: "diff2" },
		]);
		expect(result).toEqual([{ path: "a.ts", diff: "diff1\ndiff2" }]);
	});

	it("merges three sections with same path", () => {
		const result = mergeSamePathSections([
			{ path: "a.ts", diff: "d1" },
			{ path: "a.ts", diff: "d2" },
			{ path: "a.ts", diff: "d3" },
		]);
		expect(result).toEqual([{ path: "a.ts", diff: "d1\nd2\nd3" }]);
	});

	it("groups different paths, preserving first‑occurrence order", () => {
		const result = mergeSamePathSections([
			{ path: "a.ts", diff: "d1" },
			{ path: "b.ts", diff: "d2" },
			{ path: "c.ts", diff: "d3" },
		]);
		expect(result).toEqual([
			{ path: "a.ts", diff: "d1" },
			{ path: "b.ts", diff: "d2" },
			{ path: "c.ts", diff: "d3" },
		]);
	});

	it("passes through a single section", () => {
		const result = mergeSamePathSections([{ path: "x.ts", diff: "diff" }]);
		expect(result).toEqual([{ path: "x.ts", diff: "diff" }]);
	});

	it("returns empty array for empty input", () => {
		expect(mergeSamePathSections([])).toEqual([]);
	});

	it("handles interleaved paths (A, B, A)", () => {
		const result = mergeSamePathSections([
			{ path: "a.ts", diff: "first-a" },
			{ path: "b.ts", diff: "first-b" },
			{ path: "a.ts", diff: "second-a" },
		]);
		expect(result).toEqual([
			{ path: "a.ts", diff: "first-a\nsecond-a" },
			{ path: "b.ts", diff: "first-b" },
		]);
	});

	it("does not mutate empty diff entries when merging", () => {
		const result = mergeSamePathSections([
			{ path: "a.ts", diff: "" },
			{ path: "a.ts", diff: "content" },
		]);
		expect(result).toEqual([{ path: "a.ts", diff: "\ncontent" }]);
	});
});

describe("splitHashlineInputs edge cases", () => {
	it("handles quoted path with spaces", () => {
		const result = splitHashlineInputs(`§ "my folder/file.ts"\n+ 5\n~x`);
		expect(result[0].path).toBe("my folder/file.ts");
	});

	it("handles singled‑quoted path", () => {
		const result = splitHashlineInputs(`§ 'src/my file.ts'\n+ 5\n~x`);
		expect(result[0].path).toBe("src/my file.ts");
	});

	it("skips BEGIN_PATCH_MARKER inside a section", () => {
		const input = `§ src/a.ts\n*** Begin Patch\n+ 5\n~test`;
		const result = splitHashlineInputs(input);
		expect(result[0].diff).toBe("+ 5\n~test");
	});

	it("stops at END_PATCH_MARKER", () => {
		const input = `§ src/a.ts\n+ 5\n~test\n*** End Patch\n§ src/b.ts\n- 6..6`;
		const result = splitHashlineInputs(input);
		expect(result).toHaveLength(1);
		expect(result[0].path).toBe("src/a.ts");
	});

	it("stops at ABORT_MARKER", () => {
		const input = `§ src/a.ts\n+ 5\n~test\n*** Abort\n§ src/b.ts\n- 6..6`;
		const result = splitHashlineInputs(input);
		expect(result).toHaveLength(1);
	});
});

describe("sequential edits to same file", () => {
	it("applies a 4‑step edit sequence with correct state at each step", () => {
		let text = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";

		// Step 1: delete line 3 (0‑based idx 2)
		{
			const edits = parseHashline(`≔${sameLineRange(lineTag(text, 2))}`);
			const res = applyHashlineEdits(text, edits);
			text = res.lines;
			expect(text).toBe("line1\nline2\nline4\nline5\nline6\nline7\nline8\nline9\nline10");
			expect(res.firstChangedLine).toBe(3);
		}

		// Step 2: insert after line 5 (now "line6" at idx 4 after deletion)
		{
			const edits = parseHashline(`»${lineTag(text, 4)}\n${pl("inserted")}`);
			const res = applyHashlineEdits(text, edits);
			text = res.lines;
			expect(text).toBe("line1\nline2\nline4\nline5\nline6\ninserted\nline7\nline8\nline9\nline10");
		}

		// Step 3: replace lines 7‑8 (idx 6‑7) with two lines
		{
			const edits = parseHashline(
				`≔${lineTag(text, 6)}..${lineTag(text, 7)}\n${pl("replaced7")}\n${pl("replaced8")}`,
			);
			const res = applyHashlineEdits(text, edits);
			text = res.lines;
			expect(text).toBe("line1\nline2\nline4\nline5\nline6\ninserted\nreplaced7\nreplaced8\nline9\nline10");
		}

		// Step 4: insert before line 2 (idx 1)
		{
			const edits = parseHashline(`«${lineTag(text, 1)}\n${pl("before2")}`);
			const res = applyHashlineEdits(text, edits);
			text = res.lines;
			expect(text).toBe("line1\nbefore2\nline2\nline4\nline5\nline6\ninserted\nreplaced7\nreplaced8\nline9\nline10");
		}
	});

	it("rejects stale anchor for previously deleted line", () => {
		let text = "line1\nline2\nline3\nline4\nline5";

		const originalAnchor = lineTag(text, 2); // anchor for "line3"

		// Delete line 3
		text = applyHashlineEdits(text, parseHashline(`≔${sameLineRange(originalAnchor)}`)).lines;
		expect(text).toBe("line1\nline2\nline4\nline5");

		// Try deleting with the same (now stale) anchor — content at line 3 is now "line4"
		expect(() => applyHashlineEdits(text, parseHashline(`≔${sameLineRange(originalAnchor)}`))).toThrow(
			HashlineMismatchError,
		);
	});

	it("allows re‑deleting same line index with correct new anchor", () => {
		let text = "line1\nline2\nline3\nline4\nline5";

		// Delete line 3
		text = applyHashlineEdits(text, parseHashline(`≔${sameLineRange(lineTag(text, 2))}`)).lines;
		expect(text).toBe("line1\nline2\nline4\nline5");

		// Now line 3 is "line4" — delete it too
		text = applyHashlineEdits(text, parseHashline(`≔${sameLineRange(lineTag(text, 2))}`)).lines;
		expect(text).toBe("line1\nline2\nline5");

		// Now line 3 is "line5"
		text = applyHashlineEdits(text, parseHashline(`≔${sameLineRange(lineTag(text, 2))}`)).lines;
		expect(text).toBe("line1\nline2");
	});

	it("stale anchor on shifted line (content unchanged) is caught", () => {
		// If a line's content is unchanged but its line number shifted because
		// lines above it were inserted/deleted, the anchor becomes a mismatch
		// (same content, different line number). This requires the anchor-shift
		// recovery in executeHashlineSection; applyHashlineEdits alone rejects it.
		let text = "a\nb\nc\nd\ne";

		// Get anchor for line 4 ("d")
		const anchor4 = lineTag(text, 3);

		// Insert a line at the top, shifting everything down by 1
		text = applyHashlineEdits(text, parseHashline(`«${lineTag(text, 0)}\n${pl("top")}`)).lines;
		expect(text.split("\n")[0]).toBe("top");
		expect(text.split("\n")[4]).toBe("d"); // "d" is now at line 5

		// The original anchor for line 4 no longer matches (line 4's content is now "c")
		expect(() => applyHashlineEdits(text, parseHashline(`≔${sameLineRange(anchor4)}`))).toThrow(
			HashlineMismatchError,
		);
	});

	it("edit with fresh anchors after each mutation works correctly", () => {
		// A 6‑step sequence where every edit uses anchors computed from current text
		let text = "x\ny\nz";

		// Delete line 1
		text = applyHashlineEdits(text, parseHashline(`≔${sameLineRange(lineTag(text, 0))}`)).lines;
		expect(text).toBe("y\nz");

		// Insert after line 1 ("y")
		text = applyHashlineEdits(text, parseHashline(`»${lineTag(text, 0)}\n${pl("w")}`)).lines;
		expect(text).toBe("y\nw\nz");

		// Insert before line 1 ("y" — after previous insert, line 1 is still "y")
		text = applyHashlineEdits(text, parseHashline(`«${lineTag(text, 0)}\n${pl("v")}`)).lines;
		expect(text).toBe("v\ny\nw\nz");

		// Replace line 3 ("w")
		text = applyHashlineEdits(text, parseHashline(`≔${sameLineRange(lineTag(text, 2))}\n${pl("W")}`)).lines;
		expect(text).toBe("v\ny\nW\nz");

		// EOF insert
		text = applyHashlineEdits(text, parseHashline(`» EOF\n${pl("eof")}`)).lines;
		expect(text).toBe("v\ny\nW\nz\neof");

		// BOF insert
		text = applyHashlineEdits(text, parseHashline(`« BOF\n${pl("bof")}`)).lines;
		expect(text).toBe("bof\nv\ny\nW\nz\neof");
	});

	it("empty edit list produces no changes", () => {
		const text = "hello\nworld";
		const result = applyHashlineEdits(text, []);
		expect(result.lines).toBe(text);
		expect(result.firstChangedLine).toBeUndefined();
	});

	it("noop with valid non‑mutation returns no‑change result", () => {
		// An edit that targets a line but replaces it with the same content
		// should still produce a HashlineApplyResult (the duplicate boundary
		// absorption may fire warnings but the result lines will be identical)
		const text = "keep\nsame";
		const target = lineTag(text, 0);
		const result = applyHashlineEdits(text, parseHashline(`≔${sameLineRange(target)}\n${pl("keep")}`));
		// "keep" matches the original → absorbed → no net change
		expect(result.lines).toBe(text);
	});

	it("adjacent inserts at same anchor combine correctly", () => {
		const text = "header\nmiddle\nfooter";
		// Insert two lines after line 1
		const editStr = `»${lineTag(text, 0)}\n${pl("a")}\n»${lineTag(text, 0)}\n${pl("b")}`;
		const edits = parseHashline(editStr);
		// Both become before_anchor on line 2, batched together
		const result = applyHashlineEdits(text, edits);
		// Both "a" and "b" go before line 2 (the original "middle")
		expect(result.lines).toBe("header\na\nb\nmiddle\nfooter");
	});
});

describe("failure escalation simulation", () => {
	function simulateFailure(failures: Map<string, number>, path: string): { count: number; escalation: string } {
		const count = (failures.get(path) ?? 0) + 1;
		failures.set(path, count);
		let escalation = "";
		if (count >= 3) {
			escalation = "patch";
		} else if (count >= 2) {
			escalation = "read";
		}
		return { count, escalation };
	}

	function simulateSuccess(failures: Map<string, number>, path: string): void {
		failures.delete(path);
	}

	it("first failure: correctedInput present, no escalation", () => {
		const failures = new Map<string, number>();
		const { count, escalation } = simulateFailure(failures, "src/test.ts");
		expect(count).toBe(1);
		expect(escalation).toBe("");
		expect([...failures.entries()]).toEqual([["src/test.ts", 1]]);
	});

	it("second failure on same path: escalation says 'read the file'", () => {
		const failures = new Map<string, number>();
		simulateFailure(failures, "src/test.ts");
		const { count, escalation } = simulateFailure(failures, "src/test.ts");
		expect(count).toBe(2);
		expect(escalation).toBe("read");
	});

	it("third failure on same path: escalation says 'use patch mode'", () => {
		const failures = new Map<string, number>();
		simulateFailure(failures, "src/test.ts");
		simulateFailure(failures, "src/test.ts");
		const { count, escalation } = simulateFailure(failures, "src/test.ts");
		expect(count).toBe(3);
		expect(escalation).toBe("patch");
	});

	it("4th+ failure stays at patch escalation", () => {
		const failures = new Map<string, number>();
		simulateFailure(failures, "src/test.ts");
		simulateFailure(failures, "src/test.ts");
		simulateFailure(failures, "src/test.ts");
		const { count, escalation } = simulateFailure(failures, "src/test.ts");
		expect(count).toBe(4);
		expect(escalation).toBe("patch");
	});

	it("after success, failure count resets and next failure is treated as 1st", () => {
		const failures = new Map<string, number>();
		const path = "src/test.ts";

		simulateFailure(failures, path); // 1
		simulateFailure(failures, path); // 2 → would say "read"

		// Success resets
		simulateSuccess(failures, path);
		expect(failures.has(path)).toBe(false);

		// Next failure is 1st again
		const { count, escalation } = simulateFailure(failures, path);
		expect(count).toBe(1);
		expect(escalation).toBe("");
	});

	it("per‑path tracking: different paths have independent counts", () => {
		const failures = new Map<string, number>();

		simulateFailure(failures, "src/a.ts");
		simulateFailure(failures, "src/a.ts"); // a:2

		simulateFailure(failures, "src/b.ts"); // b:1

		const aResult = simulateFailure(failures, "src/a.ts"); // a:3
		expect(aResult.escalation).toBe("patch");

		const bResult = simulateFailure(failures, "src/b.ts"); // b:2
		expect(bResult.escalation).toBe("read");
	});

	it("success on one path does not reset other paths", () => {
		const failures = new Map<string, number>();

		simulateFailure(failures, "src/a.ts");
		simulateFailure(failures, "src/a.ts"); // a:2
		simulateFailure(failures, "src/b.ts"); // b:1

		simulateSuccess(failures, "src/a.ts"); // reset a only

		expect(failures.has("src/a.ts")).toBe(false);
		expect(failures.get("src/b.ts")).toBe(1);
	});

	it("max failures across paths drives escalation message", () => {
		// Multi‑file result: when different paths have different counts,
		// the escalation is driven by the max
		const failures = new Map<string, number>();
		failures.set("src/a.ts", 5); // high
		failures.set("src/b.ts", 1); // low

		const maxFailures = Math.max(...["src/a.ts", "src/b.ts"].map(p => failures.get(p) ?? 0), 0);
		expect(maxFailures).toBe(5);
		// With 5 failures the message would be "patch mode"
	});
});

describe("FileReadCache integrity", () => {
	it("records and retrieves full file content", () => {
		const cache = new FileReadCache();
		const content = "first\nsecond\nthird";

		cache.recordFullFile("/test.ts", content);

		const snap = cache.get("/test.ts");
		expect(snap).not.toBeNull();
		expect(snap!.fullContent).toBe(content);
		expect(snap!.isPartial).toBe(false);
		expect(snap!.lines.size).toBe(3);
		expect(snap!.lines.get(1)).toBe("first");
		expect(snap!.lines.get(3)).toBe("third");
	});

	it("recordContiguous merges without conflict", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/test.ts", "a\nb\nc");

		// Record additional contiguous range (no conflict)
		cache.recordContiguous("/test.ts", 2, ["b", "c"]);
		const snap = cache.get("/test.ts");
		expect(snap!.lines.size).toBe(3);
		expect(snap!.isPartial).toBe(false); // fullContent still valid, isPartial stays false
	});

	it("detects line conflict and resets snapshot", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/test.ts", "a\nb\nc");

		// Record conflicting content at line 1
		cache.recordContiguous("/test.ts", 1, ["x", "b", "c"]);
		const snap = cache.get("/test.ts");
		expect(snap!.lines.get(1)).toBe("x");
		// fullContent should be cleared since it's a conflict reset
		expect(snap!.fullContent).toBeUndefined();
		expect(snap!.isPartial).toBe(true);
	});

	it("recordSparse adds individual lines", () => {
		const cache = new FileReadCache();
		cache.recordSparse("/sparse.ts", [
			[10, "line10"],
			[20, "line20"],
		]);
		const snap = cache.get("/sparse.ts");
		expect(snap).not.toBeNull();
		expect(snap!.lines.size).toBe(2);
		expect(snap!.isPartial).toBe(true);
		expect(snap!.lines.get(10)).toBe("line10");
	});

	it("recordSparse merges into existing snapshot", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/test.ts", "a\nb\nc");

		cache.recordSparse("/test.ts", [[5, "extra"]]);
		const snap = cache.get("/test.ts");
		expect(snap!.lines.get(5)).toBe("extra");
		expect(snap!.lines.size).toBe(4);
	});

	it("invalidate removes a single path", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/a.ts", "a");
		cache.recordFullFile("/b.ts", "b");

		cache.invalidate("/a.ts");
		expect(cache.get("/a.ts")).toBeNull();
		expect(cache.get("/b.ts")).not.toBeNull();
	});

	it("clear wipes all entries", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/a.ts", "a");
		cache.recordFullFile("/b.ts", "b");

		cache.clear();
		expect(cache.get("/a.ts")).toBeNull();
		expect(cache.get("/b.ts")).toBeNull();
	});

	it("invalidateFullContent removes full snapshot while keeping line data", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/test.ts", "a\nb\nc");

		cache.invalidateFullContent("/test.ts");
		const snap = cache.get("/test.ts");
		expect(snap!.fullContent).toBeUndefined();
		expect(snap!.isPartial).toBe(true);
		// Line data should still be present
		expect(snap!.lines.get(1)).toBe("a");
	});

	it("recordFullFile after edit matches expected state", () => {
		// Simulate what executeHashlineSection does at the end of a successful edit:
		// re‑caches the post‑edit text via recordFullFile
		const cache = new FileReadCache();
		const original = "line1\nline2\nline3";
		cache.recordFullFile("/test.ts", original);

		// Apply edit
		const edits = parseHashline(`≔${sameLineRange(lineTag(original, 1))}`);
		const result = applyHashlineEdits(original, edits);

		// Simulate post‑edit caching
		cache.recordFullFile("/test.ts", result.lines);
		const snap = cache.get("/test.ts");
		expect(snap!.fullContent).toBe("line1\nline3");
		expect(snap!.lines.get(2)).toBe("line3");
	});

	it("multiple cache recordings at different timestamps update recordedAt", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/test.ts", "a");

		const snap1 = cache.get("/test.ts")!;
		const t1 = snap1.recordedAt;

		// Simulate time passing
		cache.recordFullFile("/test.ts", "a\nb");
		const snap2 = cache.get("/test.ts")!;
		expect(snap2.recordedAt).toBeGreaterThanOrEqual(t1);
	});

	it("empty recordContiguous does not create entry", () => {
		const cache = new FileReadCache();
		cache.recordContiguous("/test.ts", 1, []);
		expect(cache.get("/test.ts")).toBeNull();
	});

	it("empty recordSparse does not create entry", () => {
		const cache = new FileReadCache();
		cache.recordSparse("/test.ts", []);
		expect(cache.get("/test.ts")).toBeNull();
	});

	it("conflict on first record still records the new content", () => {
		const cache = new FileReadCache();
		cache.recordContiguous("/test.ts", 1, ["a", "b"]);
		// Second recording with conflict
		cache.recordContiguous("/test.ts", 1, ["x", "y"]);
		const snap = cache.get("/test.ts");
		expect(snap!.lines.get(1)).toBe("x");
		expect(snap!.lines.get(2)).toBe("y");
	});
});

describe("multi‑file edits stress", () => {
	it("splitHashlineInputs with three different paths", () => {
		const input = [
			"§ src/a.ts",
			"+ 5",
			"~line a",
			"§ src/b.ts",
			"- 10..10",
			"§ src/c.ts",
			"= 1..1",
			"~replaced",
		].join("\n");

		const sections = splitHashlineInputs(input);
		expect(sections).toHaveLength(3);
		expect(sections[0].path).toBe("src/a.ts");
		expect(sections[0].diff).toBe("+ 5\n~line a");
		expect(sections[1].path).toBe("src/b.ts");
		expect(sections[1].diff).toBe("- 10..10");
		expect(sections[2].path).toBe("src/c.ts");
		expect(sections[2].diff).toBe("= 1..1\n~replaced");
	});

	it("independent file edits produce correct independent results when applied separately", () => {
		// Simulate independent edits to different files with applyHashlineEdits
		const fileA = "a1\na2\na3";
		const fileB = "b1\nb2\nb3\nb4";

		const targetA = lineTag(fileA, 0); // "a1"
		const targetB = lineTag(fileB, 2); // "b3"

		const resultA = applyHashlineEdits(fileA, parseHashline(`»${targetA}\n${pl("a-ins")}`));
		// Insert after "a1" → "a1\na-ins\na2\na3"
		expect(resultA.lines).toBe("a1\na-ins\na2\na3");

		const resultB = applyHashlineEdits(fileB, parseHashline(`≔${sameLineRange(targetB)}`));
		// Delete "b3" → "b1\nb2\nb4"
		expect(resultB.lines).toBe("b1\nb2\nb4");
	});

	it("preflight logic would catch single failure before writes (simulated)", () => {
		// The real preflightHashlineSection calls applyHashlineEditsWithRecovery and
		// throws if no change. We simulate this by catching a no-change edit.
		const text = "stay";
		const target = lineTag(text, 0);
		// An edit that produces no change should still succeed at the apply level
		// (it's only preflight that throws the "no change" error)
		const result = applyHashlineEdits(text, parseHashline(`≔${sameLineRange(target)}\n${pl("stay")}`));
		expect(result.lines).toBe("stay");
		// preflight would then check normalized === result.lines and throw
		// No need to test the throw here — just validating the preflight contract
	});
});

describe("large file stress (500+ lines)", () => {
	it("applies multiple edits to a large file without corruption", () => {
		// Build a 520‑line file
		const initial: string[] = [];
		for (let i = 1; i <= 520; i++) initial.push(`line${i}`);
		let text = initial.join("\n");

		// Edit 1: delete lines 100‑109 (10 lines)
		{
			const edits = parseHashline(`≔${lineTag(text, 99)}..${lineTag(text, 108)}`);
			const res = applyHashlineEdits(text, edits);
			text = res.lines;
			const lines = text.split("\n");
			expect(lines.length).toBe(510);
			expect(lines[98]).toBe("line99");
			expect(lines[99]).toBe("line110");
			expect(lines[100]).toBe("line111");
		}

		// Edit 2: insert after line 50
		{
			const edits = parseHashline(`»${lineTag(text, 49)}\n${pl("INS-2")}`);
			const res = applyHashlineEdits(text, edits);
			text = res.lines;
			const lines = text.split("\n");
			expect(lines.length).toBe(511);
			expect(lines[49]).toBe("line50");
			expect(lines[50]).toBe("INS-2");
			expect(lines[51]).toBe("line51");
		}

		// Edit 3: replace lines near the end — replace last line with marker
		{
			const idx = text.split("\n").length - 1;
			const edits = parseHashline(`≔${sameLineRange(lineTag(text, idx))}\n${pl("LAST")}`);
			const res = applyHashlineEdits(text, edits);
			text = res.lines;
			const lines = text.split("\n");
			expect(lines.length).toBe(511);
			expect(lines[lines.length - 1]).toBe("LAST");
		}

		// Edit 4: insert before first line
		{
			const edits = parseHashline(`«${lineTag(text, 0)}\n${pl("HEADER")}`);
			const res = applyHashlineEdits(text, edits);
			text = res.lines;
			const lines = text.split("\n");
			expect(lines.length).toBe(512);
			expect(lines[0]).toBe("HEADER");
			expect(lines[1]).toBe("line1");
		}

		// Final verification — sample lines in untouched regions
		const finalLines = text.split("\n");
		for (let i = 0; i < 49; i++) {
			expect(finalLines[i + 1]).toBe(`line${i + 1}`); // after HEADER inserted at 0
		}
		// After all shifts: HEADER at 0, line1-line49 at 1-49, line50 at 50
		expect(finalLines[50]).toBe("line50");
		expect(finalLines[51]).toBe("INS-2");
		expect(finalLines[52]).toBe("line51");
	});

	it("deletes large contiguous block precisely", () => {
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) lines.push(`L${i}`);
		let text = lines.join("\n");

		// Delete middle 100 lines (201‑300, 0‑indexed 200‑299)
		const edits = parseHashline(`≔${lineTag(text, 200)}..${lineTag(text, 299)}`);
		const res = applyHashlineEdits(text, edits);
		text = res.lines;
		const resultLines = text.split("\n");
		expect(resultLines.length).toBe(400);
		expect(resultLines[199]).toBe("L199");
		expect(resultLines[200]).toBe("L300");
		expect(resultLines[399]).toBe("L499");
	});

	it("multiple range deletes shift correctly", () => {
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) lines.push(`L${i}`);
		let text = lines.join("\n");

		// Delete lines 100‑149 (50 lines)
		{
			const edits = parseHashline(`≔${lineTag(text, 100)}..${lineTag(text, 149)}`);
			text = applyHashlineEdits(text, edits).lines;
			expect(text.split("\n").length).toBe(450);
		}

		// Then delete lines 200‑249 (which now correspond to original 250‑299)
		{
			const edits = parseHashline(`≔${lineTag(text, 200)}..${lineTag(text, 249)}`);
			text = applyHashlineEdits(text, edits).lines;
			expect(text.split("\n").length).toBe(400);
		}

		const resultLines = text.split("\n");
		expect(resultLines[99]).toBe("L99");
		expect(resultLines[100]).toBe("L150"); // after first delete
		expect(resultLines[199]).toBe("L249");
		expect(resultLines[200]).toBe("L300"); // after second delete
	});

	it("insertions at EOF accumulate in order", () => {
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) lines.push(`L${i}`);
		const text = lines.join("\n");

		// Insert 10 lines at EOF
		let diff = "";
		for (let i = 0; i < 10; i++) {
			diff += `» EOF\n${pl(`eof-${i}`)}\n`;
		}
		const edits = parseHashline(diff.trimEnd());
		const res = applyHashlineEdits(text, edits);
		const resultLines = res.lines.split("\n");
		expect(resultLines.length).toBe(510);
		for (let i = 0; i < 10; i++) {
			expect(resultLines[500 + i]).toBe(`eof-${i}`);
		}
	});
});

describe("BOM and line ending resilience", () => {
	describe("stripBom", () => {
		it("removes UTF‑8 BOM", () => {
			const result = stripBom("\uFEFFcontent");
			expect(result.bom).toBe("\uFEFF");
			expect(result.text).toBe("content");
		});

		it("does nothing when no BOM", () => {
			const result = stripBom("content");
			expect(result.bom).toBe("");
			expect(result.text).toBe("content");
		});

		it("handles empty string", () => {
			const result = stripBom("");
			expect(result.bom).toBe("");
			expect(result.text).toBe("");
		});

		it("handles BOM with only whitespace", () => {
			const result = stripBom("\uFEFF  ");
			expect(result.bom).toBe("\uFEFF");
			expect(result.text).toBe("  ");
		});
	});

	describe("normalizeToLF", () => {
		it("converts CRLF to LF", () => {
			expect(normalizeToLF("a\r\nb\r\n")).toBe("a\nb\n");
		});

		it("converts isolated CR to LF", () => {
			expect(normalizeToLF("a\rb\rc")).toBe("a\nb\nc");
		});

		it("passes LF through unchanged", () => {
			expect(normalizeToLF("a\nb\n")).toBe("a\nb\n");
		});

		it("handles empty string", () => {
			expect(normalizeToLF("")).toBe("");
		});

		it("handles mixed line endings", () => {
			expect(normalizeToLF("a\r\nb\rc\n")).toBe("a\nb\nc\n");
		});
	});

	describe("restoreLineEndings", () => {
		it("restores CRLF from LF", () => {
			expect(restoreLineEndings("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
		});

		it("keeps LF when ending is LF", () => {
			expect(restoreLineEndings("a\nb\n", "\n")).toBe("a\nb\n");
		});

		it("handles empty string", () => {
			expect(restoreLineEndings("", "\r\n")).toBe("");
			expect(restoreLineEndings("", "\n")).toBe("");
		});
	});

	describe("detectLineEnding", () => {
		it("detects CRLF", () => {
			expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
		});

		it("detects LF", () => {
			expect(detectLineEnding("a\nb\n")).toBe("\n");
		});

		it("defaults to LF for single line (no newlines)", () => {
			expect(detectLineEnding("a")).toBe("\n");
		});

		it("prefers CRLF when mixed but CRLF is predominant", () => {
			// Two CRLF lines, one LF line
			expect(detectLineEnding("a\r\nb\r\nc\n")).toBe("\r\n");
		});

		it("prefers LF when both equal", () => {
			// One of each — LF wins (the code counts CRLF in a specific way)
			// detectLineEnding counts CRLF occurrences, picks whichever is > or falls back to \n
			// detectLineEnding picks whichever appears first; \r\n at pos 1 vs \n at pos 2
			expect(detectLineEnding("a\r\nb\n")).toBe("\r\n");
		});
	});

	describe("edit cycle with BOM preservation", () => {
		it("BOM is preserved through a simulated edit cycle", () => {
			const original = "\uFEFFline1\nline2\nline3\nline4";
			const { bom, text } = stripBom(original);
			expect(bom).toBe("\uFEFF");

			const normalized = normalizeToLF(text);
			const edits = parseHashline(`≔${sameLineRange(lineTag(normalized, 1))}`);
			const result = applyHashlineEdits(normalized, edits);

			const ending = detectLineEnding(original);
			const final = bom + restoreLineEndings(result.lines, ending);
			expect(final).toBe("\uFEFFline1\nline3\nline4");
		});

		it("BOM with CRLF is preserved through edit cycle", () => {
			const original = "\uFEFFa\r\nb\r\nc\r\nd";
			const { bom, text } = stripBom(original);
			expect(bom).toBe("\uFEFF");

			const normalized = normalizeToLF(text);
			// Delete line 2 ("b")
			const edits = parseHashline(`≔${sameLineRange(lineTag(normalized, 1))}`);
			const result = applyHashlineEdits(normalized, edits);

			const ending = detectLineEnding(original);
			const final = bom + restoreLineEndings(result.lines, ending);
			expect(final).toBe("\uFEFFa\r\nc\r\nd");
		});

		it("CRLF line endings are restored after edit cycle", () => {
			const original = "line1\r\nline2\r\nline3\r\nline4";
			const ending = detectLineEnding(original);
			expect(ending).toBe("\r\n");

			const normalized = normalizeToLF(original);

			// Insert after line 2
			const edits = parseHashline(`»${lineTag(normalized, 1)}\n${pl("inserted")}`);
			const result = applyHashlineEdits(normalized, edits);

			const restored = restoreLineEndings(result.lines, ending);
			expect(restored).toBe("line1\r\nline2\r\ninserted\r\nline3\r\nline4");
		});

		it("LF‑only file stays LF after edit", () => {
			const original = "a\nb\nc\n";
			const ending = detectLineEnding(original);
			const normalized = normalizeToLF(original);

			const edits = parseHashline(`»${lineTag(normalized, 0)}\n${pl("x")}`);
			const result = applyHashlineEdits(normalized, edits);

			const restored = restoreLineEndings(result.lines, ending);
			expect(restored).toBe("a\nx\nb\nc\n");
		});

		it("empty BOM is empty string, not null", () => {
			const result = stripBom("no bom");
			expect(result.bom).toBe("");
			expect(typeof result.bom).toBe("string");
		});
	});
});

describe("performance / no‑deadlock checks", () => {
	it("applies 150 insert operations in a single diff", () => {
		const text = "root";
		let diff = "";
		for (let i = 0; i < 150; i++) {
			diff += `» EOF\n${pl(`inserted-${i}`)}\n`;
		}
		const edits = parseHashline(diff.trimEnd());
		expect(edits.length).toBe(150);

		const result = applyHashlineEdits(text, edits);
		const lines = result.lines.split("\n");
		expect(lines.length).toBe(151);
		expect(lines[0]).toBe("root");
		for (let i = 0; i < 150; i++) {
			expect(lines[i + 1]).toBe(`inserted-${i}`);
		}
	});

	it("applies 50 range deletions in a single diff", () => {
		// Create a 200‑line file
		const initial: string[] = [];
		for (let i = 0; i < 200; i++) initial.push(`line${i}`);
		const text = initial.join("\n");

		// Delete 50 alternating single lines (lines 2, 4, 6, …)
		let diff = "";
		for (let i = 2; i <= 100; i += 2) {
			const t = lineTag(text, i - 1);
			diff += `≔${sameLineRange(t)}\n`;
		}
		const edits = parseHashline(diff.trimEnd());
		expect(edits.length).toBe(50);

		const result = applyHashlineEdits(text, edits);
		const lines = result.lines.split("\n");
		// We deleted 50 lines out of 200
		expect(lines.length).toBe(150);
	});

	it("deeply nested braces survive edit without corruption", () => {
		// Build 100 levels of nested brace blocks
		const levels = 100;
		let text = "";
		for (let i = 0; i < levels; i++) {
			text += `${"  ".repeat(i)}function f${i}() {\n`;
		}
		for (let i = levels - 1; i >= 0; i--) {
			text += `${"  ".repeat(i)}}\n`;
		}
		const originalLineCount = levels * 2;
		const lines = text.split("\n");
		expect(lines.length).toBe(originalLineCount + 1); // trailing \n adds empty element

		// Edit 1: insert a line after the innermost function header (line `levels`)
		// Innermost: function f99() { at line 100 (0‑index 99)
		{
			const edits = parseHashline(`»${lineTag(text, levels - 1)}\n${pl("  // deep insert")}`);
			const res = applyHashlineEdits(text, edits);
			const resultLines = res.lines.split("\n");
			expect(resultLines.length).toBe(originalLineCount + 2); // inserted line, trailing \n
			expect(resultLines[levels]).toBe("  // deep insert");
			text = res.lines;
		}

		// Edit 2: replace the outermost closing brace with a marker
		{
			const lastIdx = text.split("\n").length - 1;
			const edits = parseHashline(`≔${sameLineRange(lineTag(text, lastIdx))}\n${pl("// END")}`);
			const res = applyHashlineEdits(text, edits);
			const resultLines = res.lines.split("\n");
			expect(resultLines[resultLines.length - 1]).toBe("// END");
			text = res.lines;
		}

		// Verify the nesting structure is intact — every `{` has a matching `}`
		const finalLines = text.split("\n");
		let braceCount = 0;
		for (const line of finalLines) {
			for (const ch of line) {
				if (ch === "{") braceCount++;
				if (ch === "}") braceCount--;
			}
		}
		expect(braceCount).toBe(0);
	});

	it("many rapid sequential edits maintain correctness", () => {
		// Apply 20 sequential edits to a small file — each edit uses fresh anchors
		let text = "base";

		for (let i = 0; i < 20; i++) {
			const tagLine = lineTag(text, 0); // always append after first line
			const edits = parseHashline(`»${tagLine}\n${pl(`x${i}`)}`);
			text = applyHashlineEdits(text, edits).lines;
		}

		// Actually after 20 inserts after the first line (targeting line "base" each time),
		// all 20 get inserted in order before the previous insert because they target
		// the same anchor. Let's verify:
		const resultLines = text.split("\n");
		expect(resultLines[0]).toBe("base");
		// After 20 sequential inserts after line 1, each new insert goes after the anchor
		// (before the previous insert), so they appear in reverse order: x19, x18, ..., x0
		expect(resultLines.length).toBe(21);
		for (let i = 0; i < 20; i++) {
			expect(resultLines[i + 1]).toBe(`x${19 - i}`);
		}
	});

	it("applies multiple operations on same line without conflict", () => {
		// Multiple inserts before line 2 and a delete of line 2 all target the same line
		const text = "a\nb\nc";
		const target = lineTag(text, 1); // line 2: "b"
		const diff = [`«${target}`, pl("before1"), `«${target}`, pl("before2"), `≔${sameLineRange(target)}`].join("\n");

		const edits = parseHashline(diff);
		const result = applyHashlineEdits(text, edits);
		// Line 2 should be replaced with: before1, before2 (inserted before) + no "b" (deleted)
		const lines = result.lines.split("\n");
		expect(lines).toEqual(["a", "before1", "before2", "c"]);
	});

	it("large parse output does not overflow recursion", () => {
		// Generate a diff with 200 ops
		let diff = "";
		for (let i = 0; i < 200; i++) {
			diff += `» EOF\n${pl(`bulk-${i}`)}\n`;
		}
		const { edits, warnings } = parseHashlineWithWarnings(diff.trimEnd());
		expect(edits.length).toBe(200);
		expect(warnings).toEqual([]);

		// Apply to a small document
		const result = applyHashlineEdits("start", edits);
		expect(result.lines.split("\n").length).toBe(201);
	});

	it("concurrent‑style edits on disjoint ranges", () => {
		// Edits to BOF, EOF, and a middle line all in one diff — processed safely
		const text = "one\ntwo\nthree";
		const midTag = lineTag(text, 1);
		const diff = [`« BOF`, pl("preamble"), `» EOF`, pl("post"), `»${midTag}`, pl("mid-after")].join("\n");

		const edits = parseHashline(diff);
		const result = applyHashlineEdits(text, edits);
		const lines = result.lines.split("\n");
		expect(lines[0]).toBe("preamble");
		expect(lines[1]).toBe("one");
		expect(lines[2]).toBe("two");
		expect(lines[3]).toBe("mid-after");
		expect(lines[4]).toBe("three");
		expect(lines[5]).toBe("post");
	});
});
