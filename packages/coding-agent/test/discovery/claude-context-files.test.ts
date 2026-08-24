import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { loadClaudeContextFiles } from "@oh-my-pi/pi-coding-agent/discovery/claude";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

describe("Claude context file discovery", () => {
	let tempDir!: string;
	let home!: string;
	let repo!: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-context-"));
		home = path.join(tempDir, "home");
		repo = path.join(tempDir, "repo");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(repo, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	function makeContext(cwd: string, repoRoot: string | null = repo): LoadContext {
		return { cwd, home, repoRoot };
	}

	test("loads a bare CLAUDE.md at cwd", async () => {
		const cwd = path.join(repo, "packages", "api");
		const claudeMd = path.join(cwd, "CLAUDE.md");
		writeFile(claudeMd, "api context");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.path).toBe(claudeMd);
		expect(result.items[0]?.content).toBe("api context");
		expect(result.items[0]?.level).toBe("project");
		expect(result.items[0]?.depth).toBe(0);
	});

	test("walks ancestors up to the repository root", async () => {
		const cwd = path.join(repo, "packages", "api");
		const rootMd = path.join(repo, "CLAUDE.md");
		const apiMd = path.join(cwd, "CLAUDE.md");
		writeFile(rootMd, "root context");
		writeFile(apiMd, "api context");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items.map(file => file.path)).toEqual([apiMd, rootMd]);
		expect(result.items.map(file => file.depth)).toEqual([0, 2]);
	});

	test("merges CLAUDE.local.md after CLAUDE.md in the same directory", async () => {
		const cwd = repo;
		const claudeMd = path.join(cwd, "CLAUDE.md");
		const localMd = path.join(cwd, "CLAUDE.local.md");
		writeFile(claudeMd, "shared notes");
		writeFile(localMd, "personal notes");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.path).toBe(claudeMd);
		expect(result.items[0]?.content).toBe("shared notes\n\npersonal notes");
	});

	test("loads a standalone CLAUDE.local.md", async () => {
		const cwd = repo;
		const localMd = path.join(cwd, "CLAUDE.local.md");
		writeFile(localMd, "personal notes");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.path).toBe(localMd);
		expect(result.items[0]?.content).toBe("personal notes");
	});

	test("loads an ancestor .claude/CLAUDE.md from a monorepo root", async () => {
		const cwd = path.join(repo, "packages", "api");
		const rootConfigMd = path.join(repo, ".claude", "CLAUDE.md");
		writeFile(rootConfigMd, "monorepo context");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.path).toBe(rootConfigMd);
		expect(result.items[0]?.depth).toBe(2);
	});

	test("merges bare and config-dir CLAUDE.md in the same directory", async () => {
		const cwd = repo;
		const claudeMd = path.join(cwd, "CLAUDE.md");
		const configMd = path.join(cwd, ".claude", "CLAUDE.md");
		writeFile(claudeMd, "bare notes");
		writeFile(configMd, "config notes");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.path).toBe(claudeMd);
		expect(result.items[0]?.content).toBe("bare notes\n\nconfig notes");
	});

	test("stops at the repository root boundary", async () => {
		const cwd = path.join(repo, "src");
		const aboveRepoMd = path.join(tempDir, "CLAUDE.md");
		const rootMd = path.join(repo, "CLAUDE.md");
		writeFile(aboveRepoMd, "outside context");
		writeFile(rootMd, "root context");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items.map(file => file.path)).toEqual([rootMd]);
	});

	test("walks past the repository level when there is no repository root", async () => {
		const cwd = path.join(tempDir, "a", "b", "c");
		const cMd = path.join(cwd, "CLAUDE.md");
		const bMd = path.join(tempDir, "a", "b", "CLAUDE.md");
		const aMd = path.join(tempDir, "a", "CLAUDE.md");
		const topMd = path.join(tempDir, "CLAUDE.md");
		writeFile(cMd, "c context");
		writeFile(bMd, "b context");
		writeFile(aMd, "a context");
		writeFile(topMd, "top context");

		const result = await loadClaudeContextFiles(makeContext(cwd, null));

		expect(result.items.find(file => file.path === cMd)?.depth).toBe(0);
		expect(result.items.find(file => file.path === bMd)?.depth).toBe(1);
		expect(result.items.find(file => file.path === aMd)?.depth).toBe(2);
		expect(result.items.find(file => file.path === topMd)?.depth).toBe(3);
	});

	test("does not re-emit the user file as a project entry when the walk passes through home", async () => {
		const cwd = path.join(home, "proj", "src");
		const userMd = path.join(home, ".claude", "CLAUDE.md");
		const projectMd = path.join(home, "proj", "CLAUDE.md");
		writeFile(userMd, "user context");
		writeFile(projectMd, "project context");

		const result = await loadClaudeContextFiles(makeContext(cwd, null));

		expect(result.items.map(file => file.path)).toEqual([userMd, projectMd]);
		expect(result.items.map(file => file.level)).toEqual(["user", "project"]);
	});

	test("loads the user-level file alongside project files", async () => {
		const cwd = repo;
		const userMd = path.join(home, ".claude", "CLAUDE.md");
		const projectMd = path.join(cwd, "CLAUDE.md");
		writeFile(userMd, "user context");
		writeFile(projectMd, "project context");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items.map(file => file.path)).toEqual([userMd, projectMd]);
		expect(result.items[0]?.level).toBe("user");
		expect(result.items[1]?.level).toBe("project");
	});

	test("skips empty files", async () => {
		const cwd = path.join(repo, "src");
		const userMd = path.join(home, ".claude", "CLAUDE.md");
		const emptyMd = path.join(cwd, "CLAUDE.md");
		const rootMd = path.join(repo, "CLAUDE.md");
		writeFile(userMd, "");
		writeFile(emptyMd, "");
		writeFile(rootMd, "root context");

		const result = await loadClaudeContextFiles(makeContext(cwd));

		expect(result.items.map(file => file.path)).toEqual([rootMd]);
	});
});
