/**
 * Persona session restore: `#reconcileModeFromSession` re-applies a persisted
 * `mode_change` (`mode: "agent"`, `data: { name }`) persona from its CURRENT
 * agent definition on resume, and falls back to a warning (leaving the launch
 * baseline tools/prompt untouched) when the agent is gone, subagent-only, or
 * disabled. Model + thinking are restored by the existing
 * `model_change`/`thinking_level_change` flow in `createAgentSession` and must
 * not be touched by the fallback path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import * as discovery from "../src/task/discovery";

function agentMd(name: string, extraFrontmatter: string[] = []): string {
	return ["---", `name: ${name}`, `description: ${name}`, ...extraFrontmatter, "---", `You are ${name}.`].join("\n");
}

/** Session file carrying a restored model/thinking plus an `agent` mode_change. */
async function writePersonaSession(
	sessionFile: string,
	cwd: string,
	data: Record<string, unknown> | undefined,
): Promise<void> {
	const timestamp = "2026-06-01T00:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id: "persona-session", timestamp, cwd },
		{
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp,
			model: "anthropic/claude-sonnet-4-5",
			role: "default",
		},
		{
			type: "thinking_level_change",
			id: "t1",
			parentId: "m1",
			timestamp,
			thinkingLevel: "medium",
			configured: "medium",
		},
		{ type: "mode_change", id: "mc1", parentId: "t1", timestamp, mode: "agent", data },
	];
	await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("InteractiveMode persona session restore", () => {
	let tempHome: string;
	let projectDir: string;
	let agentsDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-restore-"));
		projectDir = path.join(tempHome, "project");
		agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.mkdir(path.join(tempHome, "startup"), { recursive: true });
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		mode = undefined;
		session = undefined;
		resetSettingsForTest();
	});

	/** Resume a persisted persona session through the real startup path. */
	async function resumePersonaSession(
		settings: Settings,
		sessionFile: string,
	): Promise<{ mode: InteractiveMode; session: AgentSession }> {
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempHome, "startup"));
		const result = await createAgentSession({
			cwd: projectDir,
			agentDir: tempHome,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read", "write"],
		});
		const created = new InteractiveMode(result.session, "test");
		return { mode: created, session: result.session };
	}

	function collectNotices(target: AgentSession): Array<Extract<AgentSessionEvent, { type: "notice" }>> {
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		target.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});
		return notices;
	}

	it(
		"re-applies the persona from its current definition on resume",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });

			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it(
		"applies the edited agent definition (not the old snapshot) on resume",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);

			// Edit the agent file: tools change from [read, write] to [read].
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);

			// Re-resume the same session file: the persona must be re-discovered
			// fresh and the CURRENT definition applied.
			await expect(session.switchSession(sessionFile)).resolves.toBe(true);

			expect(session.getEnabledToolNames()).toEqual(["read"]);
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it(
		"emits a warning and keeps the launch baseline when the agent is gone",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			// Delete the agent file before resume.
			await fs.rm(path.join(agentsDir, "persona-test.md"));

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			expect(
				notices.some(
					notice =>
						notice.level === "warning" && notice.message.includes('Agent "persona-test" is no longer available'),
				),
			).toBe(true);
			// Launch baseline tools/prompt untouched.
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
			expect(session.getSessionSpawns()).toBeNull();
			// Model + thinking restored from the session log.
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
		},
		{ timeout: 30_000 },
	);

	it(
		"returns silently when the mode data has no agent name",
		async () => {
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, undefined);

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			expect(notices.some(notice => notice.message.includes("no longer available"))).toBe(false);
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
		},
		{ timeout: 30_000 },
	);

	it(
		"warns and keeps the baseline when the agent became subagent-only",
		async () => {
			await fs.writeFile(path.join(agentsDir, "persona-test.md"), agentMd("persona-test", ["mode: subagent"]));
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			expect(
				notices.some(
					notice =>
						notice.level === "warning" && notice.message.includes('Agent "persona-test" is no longer available'),
				),
			).toBe(true);
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
		},
		{ timeout: 30_000 },
	);

	it(
		"warns and keeps the baseline when the agent is disabled in settings",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false, "task.disabledAgents": ["persona-test"] }),
				sessionFile,
			);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			expect(
				notices.some(
					notice =>
						notice.level === "warning" && notice.message.includes('Agent "persona-test" is no longer available'),
				),
			).toBe(true);
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
		},
		{ timeout: 30_000 },
	);

	it(
		"keeps the restored model when the persona model pattern does not resolve",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: nonexistent/model",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			// Model stays the restored one; no warning on restore.
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(notices.some(notice => notice.level === "warning")).toBe(false);
			// The rest of the persona still applies.
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it("swallows discovery failures and keeps the baseline", async () => {
		await fs.writeFile(path.join(agentsDir, "persona-test.md"), agentMd("persona-test", ["tools: [read, write]"]));
		const sessionFile = path.join(tempHome, "persona.jsonl");
		await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

		const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
		mode = created.mode;
		session = created.session;
		const notices = collectNotices(session);

		const spy = vi.spyOn(discovery, "discoverAgents").mockRejectedValue(new Error("boom"));
		await created.mode.init({ suppressWelcomeIntro: true });
		spy.mockRestore();

		expect(notices).toEqual([]);
		expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session.getPersonaAppendPrompt()).toBeUndefined();
	});
});
