/**
 * Regressions for `/reload-plugins` runtime surfaces that must update without a
 * process restart: MCP reconnect/rebinding (#7189) and task-agent descriptions
 * published to existing tools (#7940).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { refreshRpcPluginState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-marketplace";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

function agentDefinition(description: string): string {
	return `---\nname: reload-agent\ndescription: ${description}\n---\nReload agent.\n`;
}

function createTaskSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function createFakeCtx(cwd: string, settingsValues: Record<string, unknown> = {}) {
	const mcpTools = [{ name: "mcp__srv_do" }];
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async (_options?: unknown) => ({ errors: new Map<string, string>() })),
		getTools: vi.fn(() => mcpTools),
	};
	const session = {
		refreshMCPTools: vi.fn(async (_tools: unknown) => {}),
		setMCPPromptCommands: vi.fn((_commands: unknown) => {}),
		applyAdvisorConfigs: vi.fn((_advisors: unknown[], _sharedInstructions: string | undefined) => 0),
	};
	const ctx = {
		mcpManager,
		session,
		sessionManager: { getCwd: () => cwd },
		settings: {
			get: (key: string): unknown => settingsValues[key],
			getAgentDir: () => path.join(cwd, ".agent"),
		},
		refreshSkillState: vi.fn(async () => {}),
		refreshSlashCommandState: vi.fn(async () => {}),
		showStatus: vi.fn(() => {}),
		ui: { requestRender: vi.fn(() => {}) },
		editor: { setText: vi.fn(() => {}) },
	} as never as InteractiveModeContext;
	return { ctx, mcpManager, session, mcpTools };
}

describe("/reload-plugins runtime refresh", () => {
	let projectDir = "";

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reload-plugins-mcp-"));
		setProjectDir(projectDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		await removeWithRetries(projectDir);
	});

	test("reconnects MCP servers, rebinds tools, and clears stale prompt commands", async () => {
		const { ctx, mcpManager, session, mcpTools } = createFakeCtx(projectDir);
		const runtime: TuiSlashCommandRuntime = { ctx };

		const result = await executeBuiltinSlashCommand("/reload-plugins", runtime);
		expect(result).toBe(true);
		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(session.refreshMCPTools).toHaveBeenCalledTimes(1);
		expect(session.refreshMCPTools).toHaveBeenCalledWith(mcpTools);
		expect(session.setMCPPromptCommands).toHaveBeenCalledTimes(1);
		expect(session.setMCPPromptCommands).toHaveBeenCalledWith([]);
	});

	test("rebuilds the live advisor roster when config files change", async () => {
		const watchdogPath = path.join(projectDir, "WATCHDOG.yml");
		await Bun.write(
			watchdogPath,
			["advisors:", "  - name: Live Reviewer", "    model: openai-codex/gpt-5.6-sol:max"].join("\n"),
		);
		const { ctx, session } = createFakeCtx(projectDir);
		const runtime: TuiSlashCommandRuntime = { ctx };

		await executeBuiltinSlashCommand("/reload-plugins", runtime);
		const [initialAdvisors] = session.applyAdvisorConfigs.mock.calls.at(-1) ?? [];
		expect(initialAdvisors).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Live Reviewer" })]));

		await fs.rm(watchdogPath);
		await executeBuiltinSlashCommand("/reload-plugins", runtime);
		const [reloadedAdvisors] = session.applyAdvisorConfigs.mock.calls.at(-1) ?? [];
		expect(reloadedAdvisors).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Live Reviewer" })]),
		);
	});

	test("rebuilds the RPC advisor roster when config files change", async () => {
		const watchdogPath = path.join(projectDir, "WATCHDOG.yml");
		await Bun.write(
			watchdogPath,
			["advisors:", "  - name: RPC Reviewer", "    model: openai-codex/gpt-5.6-sol:max"].join("\n"),
		);
		const applyAdvisorConfigs = vi.fn((_advisors: unknown[], _sharedInstructions: string | undefined) => 0);
		const session = {
			sessionManager: { getCwd: () => projectDir },
			settings: { getAgentDir: () => path.join(projectDir, ".agent") },
			refreshSkills: vi.fn(async () => {}),
			setSlashCommands: vi.fn((_commands: unknown[]) => {}),
			applyAdvisorConfigs,
		} as never;
		const emitAvailableCommandsUpdate = vi.fn(async () => {});

		await refreshRpcPluginState(session, emitAvailableCommandsUpdate);
		const [initialAdvisors] = applyAdvisorConfigs.mock.calls.at(-1) ?? [];
		expect(initialAdvisors).toEqual(expect.arrayContaining([expect.objectContaining({ name: "RPC Reviewer" })]));

		await fs.rm(watchdogPath);
		await refreshRpcPluginState(session, emitAvailableCommandsUpdate);
		const [reloadedAdvisors] = applyAdvisorConfigs.mock.calls.at(-1) ?? [];
		expect(reloadedAdvisors).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "RPC Reviewer" })]));
	});

	test.each([
		["marketplace", "install fixture@test"],
		["marketplace", "uninstall fixture@test"],
		["marketplace", "upgrade fixture@test"],
		["plugins", "enable fixture@test"],
		["plugins", "disable fixture@test"],
	])("refreshes advisors after TUI /%s %s", async (name: string, args: string) => {
		vi.spyOn(MarketplaceManager.prototype, "installPlugin").mockResolvedValue({ version: "1.0.0" } as never);
		vi.spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue();
		vi.spyOn(MarketplaceManager.prototype, "upgradePlugin").mockResolvedValue({ version: "2.0.0" } as never);
		vi.spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockResolvedValue();
		const { ctx, session } = createFakeCtx(projectDir);
		const command = BUILTIN_MARKETPLACE_SLASH_COMMANDS.find(candidate => candidate.name === name);
		if (!command?.handleTui) throw new Error(`Expected /${name} TUI handler`);

		await command.handleTui({ name, args, text: `/${name} ${args}` }, { ctx } as never);

		expect(session.applyAdvisorConfigs).toHaveBeenCalledTimes(1);
	});

	test.each(["install", "uninstall"] as const)("refreshes advisors after selector %s", async mode => {
		const applied = Promise.withResolvers<void>();
		const { ctx, session } = createFakeCtx(projectDir);
		session.applyAdvisorConfigs.mockImplementation(() => {
			applied.resolve();
			return 0;
		});
		vi.spyOn(MarketplaceManager.prototype, "listMarketplaces").mockResolvedValue([{ name: "test" }] as never);
		vi.spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue(
			mode === "uninstall"
				? ([{ id: "fixture@test", scope: "user", entries: [{ version: "1.0.0" }] }] as never)
				: [],
		);
		vi.spyOn(MarketplaceManager.prototype, "listAvailablePlugins").mockResolvedValue([{ name: "fixture" }] as never);
		const installPlugin = vi
			.spyOn(MarketplaceManager.prototype, "installPlugin")
			.mockResolvedValue({ version: "1.0.0" } as never);
		const uninstallPlugin = vi.spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue();
		const controller = new SelectorController(ctx);
		let selection: { handleInput(input: string): void } | undefined;
		controller.showSelector = create => {
			const result = create(() => {});
			selection = result.focus as { handleInput(input: string): void };
		};

		await controller.showPluginSelector(mode);
		selection?.handleInput("\n");
		await applied.promise;

		expect(mode === "install" ? installPlugin : uninstallPlugin).toHaveBeenCalledTimes(1);
		expect(session.applyAdvisorConfigs).toHaveBeenCalledTimes(1);
	});

	test("honors mcp.enableProjectConfig=false so opted-out project servers are not started on reload", async () => {
		const { ctx, mcpManager } = createFakeCtx(projectDir, { "mcp.enableProjectConfig": false });
		const runtime: TuiSlashCommandRuntime = { ctx };

		await executeBuiltinSlashCommand("/reload-plugins", runtime);

		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledWith(
			expect.objectContaining({ enableProjectConfig: false }),
		);
	});

	test("republishes edited agents to an existing task tool", async () => {
		const agentDir = path.join(projectDir, ".omp", "agents");
		const agentFile = path.join(agentDir, "reload-agent.md");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(agentFile, agentDefinition("VERSION_ONE"));
		const taskTool = await TaskTool.create(createTaskSession(projectDir));
		expect(taskTool.description).toContain("VERSION_ONE");

		await Bun.write(agentFile, agentDefinition("VERSION_TWO"));
		const { ctx } = createFakeCtx(projectDir);
		const runtime: TuiSlashCommandRuntime = { ctx };
		await executeBuiltinSlashCommand("/reload-plugins", runtime);

		expect(taskTool.description).toContain("VERSION_TWO");
		expect(taskTool.description).not.toContain("VERSION_ONE");
	});
});
