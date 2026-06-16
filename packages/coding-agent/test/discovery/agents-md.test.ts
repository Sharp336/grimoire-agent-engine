/**
 * Tests for the agents-md discovery provider.
 *
 * Verifies that AGENTS.md and CLAUDE.md are both discovered during the
 * ancestor-path walk, including ordering, multi-depth scenarios, and hidden
 * directory suppression.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { ContextFile } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import "@oh-my-pi/pi-coding-agent/capability/context-file";
import "@oh-my-pi/pi-coding-agent/discovery/agents-md";

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("agents-md discovery", () => {
	let tempDir!: string;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-md-"));
	});

	afterEach(() => {
		clearCache();
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("CLAUDE.md alone is discovered", async () => {
		const project = path.join(tempDir, "project");
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		write(path.join(project, "CLAUDE.md"), "claude instructions");

		const result = await loadCapability<ContextFile>("context-files", {
			cwd: project,
			providers: ["agents-md"],
		});

		const found = result.all.find(f => path.basename(f.path) === "CLAUDE.md");
		expect(found).toBeDefined();
		expect(found?.content).toBe("claude instructions");
		expect(found?.level).toBe("project");
		expect(found?._source.provider).toBe("agents-md");
	});

	test("both AGENTS.md and CLAUDE.md at same level are loaded, AGENTS.md first", async () => {
		const project = path.join(tempDir, "project");
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		write(path.join(project, "AGENTS.md"), "agents instructions");
		write(path.join(project, "CLAUDE.md"), "claude instructions");

		const result = await loadCapability<ContextFile>("context-files", {
			cwd: project,
			providers: ["agents-md"],
		});

		const paths = result.items.map(f => path.basename(f.path));
		expect(paths).toContain("AGENTS.md");
		expect(paths).toContain("CLAUDE.md");

		const agentsIdx = paths.indexOf("AGENTS.md");
		const claudeIdx = paths.indexOf("CLAUDE.md");
		expect(agentsIdx).toBeLessThan(claudeIdx);

		expect(result.items.find(f => path.basename(f.path) === "AGENTS.md")?.content).toBe("agents instructions");
		expect(result.items.find(f => path.basename(f.path) === "CLAUDE.md")?.content).toBe("claude instructions");
	});

	test("CLAUDE.md at parent depth and AGENTS.md at cwd depth are both discovered", async () => {
		const parent = path.join(tempDir, "workspace");
		const cwd = path.join(parent, "project");
		fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		write(path.join(cwd, "AGENTS.md"), "inner agents");
		write(path.join(parent, "CLAUDE.md"), "outer claude");

		const result = await loadCapability<ContextFile>("context-files", {
			cwd,
			providers: ["agents-md"],
		});

		const agents = result.all.find(f => path.basename(f.path) === "AGENTS.md");
		const claude = result.all.find(f => path.basename(f.path) === "CLAUDE.md");

		expect(agents).toBeDefined();
		expect(agents?.content).toBe("inner agents");
		expect(agents?.depth).toBe(0);

		expect(claude).toBeDefined();
		expect(claude?.content).toBe("outer claude");
		expect(claude?.depth).toBeGreaterThan(0);
	});

	test("CLAUDE.md inside a hidden directory is not discovered", async () => {
		// Walk: cwd (.hidden/subdir) -> .hidden (SKIPPED) -> project (scanned)
		const project = path.join(tempDir, "project");
		const hiddenDir = path.join(project, ".hidden");
		const subdir = path.join(hiddenDir, "subdir");
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		fs.mkdirSync(subdir, { recursive: true });
		// CLAUDE.md in the hidden dir — must NOT be discovered
		write(path.join(hiddenDir, "CLAUDE.md"), "hidden claude");
		// AGENTS.md at the non-hidden project level — must be discovered
		write(path.join(project, "AGENTS.md"), "visible agents");

		const result = await loadCapability<ContextFile>("context-files", {
			cwd: subdir,
			providers: ["agents-md"],
		});

		const hiddenClaude = result.all.find(f => path.basename(f.path) === "CLAUDE.md" && f.path.includes(".hidden"));
		expect(hiddenClaude).toBeUndefined();

		const visibleAgents = result.all.find(f => path.basename(f.path) === "AGENTS.md");
		expect(visibleAgents).toBeDefined();
		expect(visibleAgents?.content).toBe("visible agents");
	});
});
