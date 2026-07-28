/**
 * Contracts: the text-mode (ACP/RPC) `/vibe` builtin handle exposed via
 * `executeAcpBuiltinSlashCommand`.
 *
 * Mirrors the real-AgentSession harness from `interactive-mode-vibe-toggle.test.ts`
 * (real SessionManager + temp-dir storage + `VibeSessionRegistry.resetGlobalForTests`
 * in setup/teardown) so the process-global registry is exercised safely.
 *
 * 1. `/vibe` on an idle session with vibe off returns `{ consumed: true }` (not
 *    `false`, i.e. not forwarded to the model), enables vibe, and restricts the
 *    toolset to `read` plus the vibe tools.
 * 2. `/vibe <directive>` returns the residual-prompt `{ prompt }` shape this PR
 *    adds, while still enabling vibe.
 * 3. A second `/vibe` disables vibe, restores the pre-vibe toolset, and kills
 *    the registry's workers.
 * 4. While plan mode is active, `/vibe` is consumed with a usage message and
 *    vibe stays disabled (the guard works).
 * 5. Disposing a vibe-active session tears down its workers and clears vibe
 *    state — no runtime (TUI quit, ACP close, RPC shutdown) leaks background
 *    workers.
 * 6. A headless `switchSession()`/`branch()` during vibe detaches the previous
 *    scope's workers only after the switch commits (commit-phase reconciler),
 *    clearing vibe state without clobbering the target's tools.
 * 7. A headless switch that fails and rolls back leaves the original session's
 *    vibe mode, workers, and restricted toolset untouched.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

describe("ACP /vibe handle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let output: string[];

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		VibeSessionRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-acp-vibe-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		const registryTools = [stubTool("read")];
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		output = [];
	});

	afterEach(async () => {
		await session?.dispose();
		VibeSessionRegistry.resetGlobalForTests();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function buildRuntime() {
		return {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
			notifyTitleChanged: undefined as (() => Promise<void> | void) | undefined,
			notifyConfigChanged: undefined as (() => Promise<void> | void) | undefined,
		};
	}

	it("enables vibe and restricts the toolset when toggled on an idle session", async () => {
		expect(session.getVibeModeState()).toBeUndefined();
		// Not forwarded to the model: returns { consumed: true }, not false.
		const result = await executeAcpBuiltinSlashCommand("/vibe", buildRuntime());
		expect(result).toEqual({ consumed: true });

		expect(session.getVibeModeState()?.enabled).toBe(true);
		const active = session.getActiveToolNames();
		expect(active).toContain("read");
		for (const name of VIBE_TOOL_NAMES) {
			expect(active).toContain(name);
		}
	});

	it("returns the residual prompt for /vibe <directive>", async () => {
		const result = await executeAcpBuiltinSlashCommand("/vibe focus on test coverage", buildRuntime());
		expect(result).toEqual({ prompt: "focus on test coverage" });
		expect(session.getVibeModeState()?.enabled).toBe(true);
	});

	it("disables vibe, restores the pre-vibe toolset, and kills workers on a second toggle", async () => {
		await session.setActiveToolsByName(["read"]);
		const preVibe = session.getActiveToolNames();
		expect(preVibe).toEqual(["read"]);

		await executeAcpBuiltinSlashCommand("/vibe", buildRuntime());
		expect(session.getVibeModeState()?.enabled).toBe(true);
		// Vibe tools are now mounted alongside read.
		expect(session.getActiveToolNames().length).toBeGreaterThan(preVibe.length);

		const killAll = vi.spyOn(VibeSessionRegistry.global(), "killAll");
		const result = await executeAcpBuiltinSlashCommand("/vibe", buildRuntime());
		expect(result).toEqual({ consumed: true });
		expect(session.getVibeModeState()).toBeUndefined();
		// The pre-vibe active set is restored exactly; vibe tools are gone.
		expect(session.getActiveToolNames()).toEqual(preVibe);
		expect(killAll).toHaveBeenCalledTimes(1);
	});

	it("blocks vibe entry with a usage message while plan mode is active", async () => {
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		const result = await executeAcpBuiltinSlashCommand("/vibe", buildRuntime());
		// Consumed (not forwarded to the model), but vibe must stay off.
		expect(result).toEqual({ consumed: true });
		expect(output.some(line => line.includes("Exit plan mode first"))).toBe(true);
		expect(session.getVibeModeState()).toBeUndefined();
	});
	it("kills active vibe workers and clears vibe state when the session is disposed", async () => {
		await executeAcpBuiltinSlashCommand("/vibe", buildRuntime());
		expect(session.getVibeModeState()?.enabled).toBe(true);
		const killAll = vi.spyOn(VibeSessionRegistry.global(), "killAll");

		await session.dispose();

		// Disposing a vibe-active session must tear down its workers so no runtime
		// (TUI quit, ACP close, RPC shutdown) leaves background workers running.
		expect(killAll).toHaveBeenCalledTimes(1);
		expect(session.getVibeModeState()).toBeUndefined();
	});

	it("reconciles vibe on a headless session switch instead of leaking workers", async () => {
		await executeAcpBuiltinSlashCommand("/vibe", buildRuntime());
		expect(session.getVibeModeState()?.enabled).toBe(true);
		await session.sessionManager.ensureOnDisk();
		const sourceSessionId = session.sessionManager.getSessionId();
		// Headless runtimes (ACP/RPC) install the commit-phase reconciler; the TUI
		// installs its own suspend/rehydrate variant. Mirrors runRpcMode /
		// #registerPreparedSession — teardown runs AFTER the switch commits.
		session.setSessionAfterSwitchReconciler(vibeScope => session.detachVibeAfterSessionSwitch(vibeScope));

		const target = SessionManager.create(tempDir.path(), tempDir.path());
		target.appendModeChange("none");
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await target.close();

		const killAll = vi.spyOn(VibeSessionRegistry.global(), "killAll");
		const suspend = vi.spyOn(VibeSessionRegistry.global(), "suspendScope");

		expect(await session.switchSession(targetFile)).toBe(true);

		// The commit-phase reconciler detaches the SOURCE scope (frozen before the
		// switch, so it is NOT the target's id) and clears vibe state — without
		// persisting tombstones (suspend, not kill) or clobbering the target tools.
		expect(suspend).toHaveBeenCalledTimes(1);
		expect(suspend.mock.calls[0]?.[0]).toMatchObject({ parentSessionId: sourceSessionId });
		expect(killAll).not.toHaveBeenCalled();
		expect(session.getVibeModeState()).toBeUndefined();
	});

	it("leaves vibe mode intact when a headless session switch fails and rolls back", async () => {
		await executeAcpBuiltinSlashCommand("/vibe", buildRuntime());
		expect(session.getVibeModeState()?.enabled).toBe(true);
		await session.sessionManager.ensureOnDisk();
		const sourceSessionId = session.sessionManager.getSessionId();
		const vibeToolCount = session.getActiveToolNames().length;
		session.setSessionAfterSwitchReconciler(vibeScope => session.detachVibeAfterSessionSwitch(vibeScope));

		// A directory path throws EISDIR (not ENOENT) inside setSessionFile,
		// forcing the switch to fail inside the try and roll back.
		const dirPath = path.join(tempDir.path(), "not-a-file.jsonl");
		await fs.mkdir(dirPath);
		const suspend = vi.spyOn(VibeSessionRegistry.global(), "suspendScope");
		const killAll = vi.spyOn(VibeSessionRegistry.global(), "killAll");

		await expect(session.switchSession(dirPath)).rejects.toThrow();

		// The commit-phase reconciler must NOT have run: vibe mode, the worker
		// scope, and the restricted toolset survive the rollback exactly as before.
		expect(session.getVibeModeState()?.enabled).toBe(true);
		expect(session.sessionManager.getSessionId()).toBe(sourceSessionId);
		expect(session.getActiveToolNames().length).toBe(vibeToolCount);
		expect(suspend).not.toHaveBeenCalled();
		expect(killAll).not.toHaveBeenCalled();
	});
});
