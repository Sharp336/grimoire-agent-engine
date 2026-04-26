import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("createAgentSession orchestrator mode", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const createTempDir = (name: string): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-orchestrator-${name}-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	const createSession = async (cwd: string, settings: Settings, toolNames?: string[]) => {
		return await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames,
		});
	};

	it("starts with orchestrator mode off by default inside a git repo", async () => {
		const tempDir = createTempDir("git-default-off");
		fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });

		const { session } = await createSession(tempDir, Settings.isolated());

		try {
			expect(session.orchestratorMode).toBe(false);
			expect(session.getAllToolNames()).toEqual(expect.arrayContaining(["write", "edit", "ast_edit", "task"]));
			expect(session.systemPrompt).not.toContain("task orchestrator mode");
		} finally {
			await session.dispose();
		}
	});

	it("fails to enable orchestrator mode outside a git repo", async () => {
		const tempDir = createTempDir("nogit-enable");
		const { session } = await createSession(tempDir, Settings.isolated(), ["read", "write", "task"]);

		try {
			expect(session.orchestratorMode).toBe(false);
			await expect(session.setOrchestratorMode(true)).rejects.toThrow(/^git repository not found$/);
			expect(session.orchestratorMode).toBe(false);
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write", "task"]));
			await expect(session.setOrchestratorMode(false)).resolves.toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("updates active tools and system prompt when orchestrator mode changes at runtime inside a git repo", async () => {
		const tempDir = createTempDir("toggle");
		fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });
		const { session } = await createSession(tempDir, Settings.isolated(), ["read", "write", "task"]);

		try {
			expect(session.orchestratorMode).toBe(false);
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write", "task"]));
			expect(session.systemPrompt).not.toContain("task orchestrator mode");

			await session.setOrchestratorMode(true);
			expect(session.orchestratorMode).toBe(true);
			expect(session.getAllToolNames()).not.toContain("write");
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "task"]));
			expect(session.getActiveToolNames()).not.toContain("write");
			expect(session.systemPrompt).toContain("task orchestrator mode");

			fs.rmSync(path.join(tempDir, ".git"), { recursive: true, force: true });
			const toggledMode = await session.toggleOrchestratorMode();
			expect(toggledMode).toBe(false);
			expect(session.orchestratorMode).toBe(false);
			expect(session.getAllToolNames()).toContain("write");
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write", "task"]));
			expect(session.systemPrompt).not.toContain("task orchestrator mode");
		} finally {
			await session.dispose();
		}
	});
});
