import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkStaleness, computeFileHash } from "../staleness";

describe("codemap staleness", () => {
	it("returns empty hash for a missing file (no throw)", async () => {
		const hash = await computeFileHash("/nonexistent/path/to/missing-file.ts");
		expect(hash).toBe("");
	});

	it("returns a non-empty hex hash for an existing file", async () => {
		const tmp = path.join(os.tmpdir(), `codemap-test-${Date.now()}.ts`);
		await fs.writeFile(tmp, "export const x = 1;");
		const hash = await computeFileHash(tmp);
		expect(hash).toBeTruthy();
		expect(hash).toMatch(/^[0-9a-f]+$/);
		await fs.unlink(tmp);
	});

	it("returns the same hash for unchanged content", async () => {
		const tmp = path.join(os.tmpdir(), `codemap-test-stable-${Date.now()}.ts`);
		await fs.writeFile(tmp, "export const y = 2;");
		const hash1 = await computeFileHash(tmp);
		const hash2 = await computeFileHash(tmp);
		expect(hash1).toBe(hash2);
		await fs.unlink(tmp);
	});

	it("returns a different hash after file content changes", async () => {
		const tmp = path.join(os.tmpdir(), `codemap-test-change-${Date.now()}.ts`);
		await fs.writeFile(tmp, "export const original = 1;");
		const hash1 = await computeFileHash(tmp);
		await fs.writeFile(tmp, "export const modified = 2;");
		const hash2 = await computeFileHash(tmp);
		expect(hash1).not.toBe(hash2);
		await fs.unlink(tmp);
	});

	it("marks stale=true when stored hash differs from current", async () => {
		const tmp = path.join(os.tmpdir(), `codemap-test-stale-${Date.now()}.ts`);
		await fs.writeFile(tmp, "original content");
		const result = await checkStaleness(tmp, "deadbeef");
		expect(result.stale).toBe(true);
		expect(result.missing).toBe(false);
		await fs.unlink(tmp);
	});

	it("marks stale=false when stored hash matches current", async () => {
		const tmp = path.join(os.tmpdir(), `codemap-test-fresh-${Date.now()}.ts`);
		await fs.writeFile(tmp, "stable content");
		const hash = await computeFileHash(tmp);
		const result = await checkStaleness(tmp, hash);
		expect(result.stale).toBe(false);
		expect(result.missing).toBe(false);
		await fs.unlink(tmp);
	});

	it("marks missing=true when file does not exist", async () => {
		const result = await checkStaleness("/nonexistent/file.ts", "somehash");
		expect(result.stale).toBe(true);
		expect(result.missing).toBe(true);
		expect(result.contentHash).toBe("");
	});

	it("marks missing=true when file was deleted after summary was written", async () => {
		const tmp = path.join(os.tmpdir(), `codemap-test-deleted-${Date.now()}.ts`);
		await fs.writeFile(tmp, "content that will disappear");
		const hash = await computeFileHash(tmp);
		await fs.unlink(tmp);
		const result = await checkStaleness(tmp, hash);
		expect(result.stale).toBe(true);
		expect(result.missing).toBe(true);
	});
});
