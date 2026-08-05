/**
 * Standalone CLAUDE.md discovery in the `agents-md` ancestor walk (#2612).
 *
 * The provider walks up from cwd collecting standalone AGENTS.md files. A root-level
 * CLAUDE.md was never a candidate, so projects that keep their context in CLAUDE.md got
 * no project context at all. `context.loadClaudeMd` opts that filename into the same walk.
 *
 * These assertions go through `result.items` (post-dedup) and `loadProjectContextFiles()`
 * rather than `result.all`: `result.all` retains shadowed entries, so a file can appear
 * there while still being absent from the runtime prompt.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { ContextFile } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadProjectContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";
import "@oh-my-pi/pi-coding-agent/capability/context-file";
import "@oh-my-pi/pi-coding-agent/discovery/agents-md";

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** Load context files from the `agents-md` provider only. */
async function loadAgentsMdFiles(cwd: string) {
	return await loadCapability<ContextFile>("context-files", { cwd, providers: ["agents-md"] });
}

async function initSettings(loadClaudeMd: boolean): Promise<void> {
	await Settings.init({ inMemory: true });
	Settings.instance.set("context.loadClaudeMd", loadClaudeMd);
}

describe("agents-md discovery — standalone CLAUDE.md", () => {
	let tempDir!: string;
	let project!: string;

	beforeEach(() => {
		clearCache();
		resetSettingsForTest();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agents-md-claude-"));
		project = path.join(tempDir, "project");
		// A .git directory bounds the ancestor walk at `project`.
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	});

	afterEach(() => {
		clearCache();
		resetSettingsForTest();
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("is not discovered by default", async () => {
		await initSettings(false);
		write(path.join(project, "CLAUDE.md"), "claude instructions");

		const result = await loadAgentsMdFiles(project);

		expect(result.all.find(f => path.basename(f.path) === "CLAUDE.md")).toBeUndefined();
	});

	test("is discovered when context.loadClaudeMd is enabled", async () => {
		await initSettings(true);
		write(path.join(project, "CLAUDE.md"), "claude instructions");

		const result = await loadAgentsMdFiles(project);

		const found = result.items.find(f => path.basename(f.path) === "CLAUDE.md");
		expect(found).toBeDefined();
		expect(found?.content).toBe("claude instructions");
		expect(found?.level).toBe("project");
		expect(found?._source.provider).toBe("agents-md");
	});

	test("survives dedup alongside a same-directory AGENTS.md, AGENTS.md first", async () => {
		await initSettings(true);
		write(path.join(project, "AGENTS.md"), "agents instructions");
		write(path.join(project, "CLAUDE.md"), "claude instructions");

		// result.items is what loadProjectContextFiles() consumes — the shared
		// `project:<depth>` key used to drop whichever file was pushed second.
		const names = (await loadAgentsMdFiles(project)).items.map(f => path.basename(f.path));

		expect(names).toContain("AGENTS.md");
		expect(names).toContain("CLAUDE.md");
		expect(names.indexOf("AGENTS.md")).toBeLessThan(names.indexOf("CLAUDE.md"));
	});

	test("reaches the runtime prompt through loadProjectContextFiles", async () => {
		await initSettings(true);
		write(path.join(project, "AGENTS.md"), "agents via runtime");
		write(path.join(project, "CLAUDE.md"), "claude via runtime");

		const files = await loadProjectContextFiles({ cwd: project });

		const agents = files.find(f => path.basename(f.path) === "AGENTS.md");
		const claude = files.find(f => path.basename(f.path) === "CLAUDE.md");
		expect(agents?.content).toBe("agents via runtime");
		expect(claude?.content).toBe("claude via runtime");
		// Same directory, so both land at the same depth.
		expect(agents?.depth).toBe(claude?.depth);
	});

	test("is discovered in an ancestor when cwd is a subdirectory", async () => {
		await initSettings(true);
		const nested = path.join(project, "packages", "api");
		fs.mkdirSync(nested, { recursive: true });
		write(path.join(project, "CLAUDE.md"), "root claude");

		const result = await loadAgentsMdFiles(nested);

		const claude = result.items.find(f => path.basename(f.path) === "CLAUDE.md");
		expect(claude?.content).toBe("root claude");
		expect(claude?.depth).toBeGreaterThan(0);
	});

	test("is skipped inside a config directory", async () => {
		await initSettings(true);
		// `.claude/CLAUDE.md` belongs to the `claude` provider, not the standalone walk.
		write(path.join(project, ".claude", "CLAUDE.md"), "config-dir claude");

		const result = await loadAgentsMdFiles(path.join(project, ".claude"));

		expect(result.all.find(f => f.path.includes(`.claude${path.sep}CLAUDE.md`))).toBeUndefined();
	});
});
