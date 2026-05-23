/**
 * Verification tests for recent hashline edit tool fixes:
 *
 * 1. Bare line-number anchors resolve from read cache (option 2)
 * 2. `- A..B ~payload` silently treated as replacement
 * 3. Tier 3 (3-way merge) removed, tier 2b (hash auto-correct) in place
 * 4. Clean error on bare anchor with no cache entry
 */
import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyHashlineEdits,
	computeLineHash,
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	getFileReadCache,
	parseHashline,
	parseHashlineWithWarnings,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const pl = (text: string): string => text;

function tag(line: number, content: string): string {
	return `${line}${computeLineHash(line, content)}`;
}

function sameLineRange(anchor: string): string {
	return `${anchor}..${anchor}`;
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-fix-verif-"));
	try {
		await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function makeSession(tempDir: string, settings = Settings.isolated()): ToolSession {
	return { cwd: tempDir, settings } as ToolSession;
}

function execOptions(
	tempDir: string,
	input: string,
	settings = Settings.isolated(),
	session = makeSession(tempDir, settings),
): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
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

// ============================================================
// Fix 1: Bare line-number anchors resolve from read cache
// ============================================================
describe("bare line-number anchors", () => {
	it("resolves bare anchor from cache and validates normally", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			await Bun.write(filePath, "aaa\nbbb\nccc\n");
			const session = makeSession(tempDir);
			// Cache the content so bare anchor can resolve.
			getFileReadCache(session).recordContiguous(filePath, 1, ["aaa", "bbb", "ccc"]);

			// Use bare line number "2" instead of "2<hash>"
			const input = `§a.ts\n≔${tag(2, "bbb")}..${tag(2, "bbb")}\n${pl("BBB")}\n`;
			await executeHashlineSingle(execOptions(tempDir, input, undefined, session));
			const text = (await Bun.file(filePath).text()).replace(/\n$/, "");
			expect(text).toBe("aaa\nBBB\nccc");
		});
	});

	it("throws clear error on bare anchor with no cache entry", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			await Bun.write(filePath, "aaa\nbbb\nccc\n");
			const session = makeSession(tempDir);
			// No cache recorded — bare anchor will fail.

			// Bare line number "2" (no hash) — cannot be resolved without cache.
			const input = `§a.ts\n≔2..2\n${pl("BBB")}\n`;
			await expect(executeHashlineSingle(execOptions(tempDir, input, undefined, session))).rejects.toThrow(
				/no cached snapshot/,
			);
		});
	});

	it("preserves pre-shift recovery for bare anchors when cache has fullContent", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
			await Bun.write(filePath, `${v0Lines.join("\n")}\n`);
			const session = makeSession(tempDir);
			// Full-file cache (needed for pre-shift).
			getFileReadCache(session).recordFullFile(filePath, v0Lines.join("\n"));

			// External prepend — 2 lines added at top.
			const v1Lines = ["H1", "H2", ...v0Lines];
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			// Bare anchor targeting original line 2 ("L2"), which shifted to line 4.
			// Use the original tag so hash validation catches the mismatch.
			const input = `§a.ts\n≔${tag(2, "L2")}..${tag(2, "L2")}\n${pl("L2-EDITED")}\n`;
			const result = await executeHashlineSingle(execOptions(tempDir, input, undefined, session));
			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");
			expect(finalLines.slice(0, 2)).toEqual(["H1", "H2"]);
			expect(finalLines).toContain("L2-EDITED");
			expect(finalLines).not.toContain("L2");
			// Should use pre-shift recovery (line numbers shifted), not hash correction.
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/Auto-shifted \d+ anchor\(s\)/);
		});
	});
});

// ============================================================
// Fix 2: `- A..B ~payload` silently treated as replacement
// ============================================================
describe("- with payload treated as replacement", () => {
	it("accepts - A..B followed by ~payload, producing correct result", () => {
		const edits = parseHashline(`≔${sameLineRange(tag(2, "bbb"))}\n${pl("BBB")}`);
		const result = applyHashlineEdits("aaa\nbbb\nccc", edits).lines;
		expect(result).toBe("aaa\nBBB\nccc");
	});

	it("accepts - A..B with no payload as plain delete", () => {
		const edits = parseHashline(`≔${sameLineRange(tag(2, "bbb"))}`);
		const result = applyHashlineEdits("aaa\nbbb\nccc", edits).lines;
		expect(result).toBe("aaa\nccc");
	});

	it("accepts - A..B with multi-line payload", () => {
		const edits = parseHashline(`≔${tag(2, "bbb")}..${tag(3, "ccc")}\n${pl("BBB")}\n${pl("CCC")}`);
		const result = applyHashlineEdits("aaa\nbbb\nccc\nddd", edits).lines;
		expect(result).toBe("aaa\nBBB\nCCC\nddd");
	});

	it("works through executeHashlineSingle", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			await Bun.write(filePath, "aaa\nbbb\nccc\n");
			const session = makeSession(tempDir);
			getFileReadCache(session).recordContiguous(filePath, 1, ["aaa", "bbb", "ccc"]);

			// Delete with payload — should behave as replacement
			const input = `§a.ts\n≔${tag(2, "bbb")}..${tag(2, "bbb")}\n${pl("BBB")}\n`;
			await executeHashlineSingle(execOptions(tempDir, input, undefined, session));
			const text = (await Bun.file(filePath).text()).replace(/\n$/, "");
			expect(text).toBe("aaa\nBBB\nccc");
		});
	});

	it("stray ~ with no preceding op still throws", () => {
		expect(() => parseHashlineWithWarnings(`~stray`)).toThrow(/payload line has no preceding/);
	});
});

// ============================================================
// Fix 3: Stale hash returns corrected input
// ============================================================
describe("stale hash correction returns corrected input", () => {
	it("returns correctedInput when cache is full and content changed", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = Array.from({ length: 10 }, (_, idx) => `L${idx + 1}`);
			await Bun.write(filePath, `${v0Lines.join("\n")}\n`);
			const session = makeSession(tempDir);
			// Full cache — shiftMap will be available for accurate remapping.
			getFileReadCache(session).recordFullFile(filePath, v0Lines.join("\n"));

			// External change to line 6 content.
			const v1Lines = [...v0Lines];
			v1Lines[5] = "L6-CHANGED";
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			// Anchor targets original line 6 — hash won't match.
			const staleTag = tag(6, "L6");
			const input = `§a.ts\n≔${sameLineRange(staleTag)}\n${pl("L6-MODEL")}\n`;
			const result = await executeHashlineSingle(execOptions(tempDir, input, undefined, session));
			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");

			// Disk should be unchanged — still has "L6-CHANGED", NOT "L6-MODEL"
			expect(finalLines).toContain("L6-CHANGED");
			expect(finalLines).not.toContain("L6-MODEL");

			// correctedInput should be present (edit was NOT auto-applied)
			expect(result.details?.correctedInput).toBeString();

			// correctedInput should contain the correct hash for actual content
			const correctTag = tag(6, "L6-CHANGED");
			expect(result.details?.correctedInput).toContain(correctTag);

			// correctedInput should NOT contain the stale hash
			expect(result.details?.correctedInput).not.toContain(staleTag);
		});
	});
});
// ============================================================
// Fix 4: No tier 3 (function should not exist)
// ============================================================
describe("tier 3 removed", () => {
	it("tryRecoverHashlineWithCache is not exported", async () => {
		// Dynamic import to avoid compile error if module doesn't export it.
		const mod = await import("@oh-my-pi/pi-coding-agent/edit");
		expect((mod as Record<string, unknown>).tryRecoverHashlineWithCache).toBeUndefined();
	});
});

// ============================================================
// Fix 5: `-` with stale anchors still produces correct errors
// ============================================================
describe("- with stale anchors still validates", () => {
	it("rejects - with out-of-range line", () => {
		expect(() => parseHashline(`≔999xx..999xx`)).not.toThrow(); // parser accepts, but apply fails
	});

	it("apply rejects - with wrong hash", () => {
		const edits = parseHashline(`≔${sameLineRange(`2zz`)}`);
		expect(() => applyHashlineEdits("aaa\nbbb\nccc", edits)).toThrow();
	});

	it("rejects - with payload targeting non-existent line through execute", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			await Bun.write(filePath, "aaa\n");
			const session = makeSession(tempDir);
			getFileReadCache(session).recordContiguous(filePath, 1, ["aaa"]);

			const input = `§a.ts\n≔999xx..999xx\n${pl("nope")}\n`;
			await expect(executeHashlineSingle(execOptions(tempDir, input, undefined, session))).rejects.toThrow(
				/Line 999 does not exist/,
			);
		});
	});
});
