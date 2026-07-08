import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createTestSession(cwd = "/tmp/test", overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("fuzzy_find", () => {
	it("finds subsequence matches across files", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fuzzy-content-"));
		try {
			await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
			await Bun.write(path.join(tempDir, "src", "migrate.ts"), "export function runDbMigration() {}\n");
			await Bun.write(path.join(tempDir, "src", "utils.ts"), "export const helper = 1;\n");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "fuzzy_find");
			expect(tool).toBeDefined();

			const result = await tool!.execute("fuzzy-content-subseq", {
				query: "dbmig",
				path: path.join(tempDir, "src"),
				maxResults: 10,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as
				| { matchCount?: number; totalMatches?: number; filesSearched?: number }
				| undefined;

			expect(details?.matchCount).toBe(1);
			expect(details?.totalMatches).toBe(1);
			expect(details?.filesSearched).toBe(2);
			expect(text).toContain("runDbMigration");
			expect(text).toContain("migrate.ts");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("ranks exact matches above substring and subsequence matches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fuzzy-content-rank-"));
		try {
			await Bun.write(path.join(tempDir, "a.ts"), "const dbMigrate = 1;\n");
			await Bun.write(path.join(tempDir, "b.ts"), "const dbMigrateRunner = 2;\n");
			await Bun.write(path.join(tempDir, "c.ts"), "const runDbMigrateTool = 3;\n");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "fuzzy_find");
			expect(tool).toBeDefined();

			const result = await tool!.execute("fuzzy-content-rank", {
				query: "dbMigrate",
				path: tempDir,
				maxResults: 3,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const lines = text.split("\n").filter(line => line.includes(".ts:"));
			expect(lines.length).toBeGreaterThanOrEqual(3);
			expect(lines[0]).toContain("a.ts");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("searches a single file path", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fuzzy-content-file-"));
		try {
			await Bun.write(path.join(tempDir, "a.ts"), "const dbMigrate = 1;\n");
			await Bun.write(path.join(tempDir, "b.ts"), "const dbMigrationRunner = 2;\n");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "fuzzy_find");
			expect(tool).toBeDefined();

			const result = await tool!.execute("fuzzy-content-file", {
				query: "dbMigrate",
				path: path.join(tempDir, "a.ts"),
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as { matchCount?: number; filesSearched?: number } | undefined;

			expect(details?.matchCount).toBe(1);
			expect(details?.filesSearched).toBe(1);
			expect(text).toContain("a.ts");
			expect(text).not.toContain("b.ts");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("returns empty results when nothing matches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fuzzy-content-empty-"));
		try {
			await Bun.write(path.join(tempDir, "a.ts"), "const unrelated = 1;\n");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "fuzzy_find");
			expect(tool).toBeDefined();

			const result = await tool!.execute("fuzzy-content-empty", {
				query: "dbmig",
				path: tempDir,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as { matchCount?: number; totalMatches?: number } | undefined;

			expect(details?.matchCount).toBe(0);
			expect(details?.totalMatches).toBe(0);
			expect(text).toContain("No fuzzy content matches");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
