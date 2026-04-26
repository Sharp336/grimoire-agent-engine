import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("TaskTool description", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stays generic in orchestrator mode", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-task-description-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		await session.setOrchestratorMode(true);

		try {
			const tool = session.getToolByName("task");
			expect(tool).toBeDefined();
			const description = tool?.description ?? "";

			expect(description).toContain("Launches subagents to parallelize workflows.");
			// In orchestrator mode the user doesn't pass `isolated` — the parameter is
			// auto-resolved from agent capabilities. The description should NOT
			// document `isolated` as a user-facing parameter in this mode, and it
			// should NOT reference the old patch-oriented wording.
			expect(description).not.toContain("`isolated`: Run in isolated environment");
			expect(description).not.toContain("returns patches");
		} finally {
			await session.dispose();
		}
	});
});
