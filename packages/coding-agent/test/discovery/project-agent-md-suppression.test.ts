import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("user agent authority suppresses project AGENTS.md sources", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-authority-home-"));
		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-authority-project-"));
		await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
		await fs.mkdir(path.join(tempHomeDir, ".agent"), { recursive: true });
		await fs.mkdir(path.join(tempHomeDir, ".claude"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".agent"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".claude"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".omp"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });

		await Bun.write(path.join(tempHomeDir, ".agent", "AGENT.md"), "# User authority\n");
		await Bun.write(path.join(tempHomeDir, ".claude", "CLAUDE.md"), "# User Claude\n");
		await Bun.write(path.join(tempDir, "AGENTS.md"), "# Bare project AGENTS\n");
		await Bun.write(path.join(tempDir, ".agent", "AGENTS.md"), "# Project .agent AGENTS\n");
		await Bun.write(path.join(tempDir, ".claude", "CLAUDE.md"), "# Project Claude\n");
		await Bun.write(path.join(tempDir, ".omp", "AGENTS.md"), "# Project .omp AGENTS\n");
		await Bun.write(path.join(tempDir, "src", "AGENTS.md"), "# Project src AGENTS\n");

		const settings = await Settings.init({ inMemory: true, cwd: tempDir });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		clearCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fs.rm(tempHomeDir, { recursive: true, force: true });
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("runtime context loading excludes project behavioral context", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		const projectAgents = result.items.filter(
			item => item.level === "project" && path.basename(item.path) === "AGENTS.md",
		);
		expect(projectAgents).toHaveLength(0);
		expect(result.items.some(item => item.path === path.join(tempDir, ".claude", "CLAUDE.md"))).toBe(false);

		const userAgent = result.items.find(item => item.level === "user" && path.basename(item.path) === "AGENT.md");
		expect(userAgent?.path).toBe(path.join(tempHomeDir, ".agent", "AGENT.md"));
		expect(result.items.some(item => item.path === path.join(tempHomeDir, ".claude", "CLAUDE.md"))).toBe(false);
	});

	test("authority file is re-evaluated after filesystem cache reset", async () => {
		const authorityPath = path.join(tempHomeDir, ".agent", "AGENT.md");
		await fs.rm(authorityPath);
		clearCache();

		let result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });
		expect(result.items.some(item => item.level === "project" && path.basename(item.path) === "AGENTS.md")).toBe(
			true,
		);

		await Bun.write(authorityPath, "# User authority\n");
		clearCache();

		result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });
		expect(result.items.some(item => item.level === "project" && path.basename(item.path) === "AGENTS.md")).toBe(
			false,
		);
		expect(result.items.some(item => item.path === authorityPath)).toBe(true);
	});

	test("buildSystemPrompt omits AGENTS.md dir-context path hints under user authority", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			workspaceTree: {
				rootPath: tempDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: ["src/AGENTS.md"],
			},
		});
		const promptText = systemPrompt.join("\n\n");

		expect(promptText).not.toContain("<dir-context>");
		expect(promptText).not.toContain("src/AGENTS.md");
	});
});
