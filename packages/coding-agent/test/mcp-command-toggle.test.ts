import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		Bun.env.PI_CODING_AGENT_DIR = originalAgentDir;
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.PI_CODING_AGENT_DIR;
	delete Bun.env.PI_CODING_AGENT_DIR;
}

function createController() {
	const refreshMCPTools = vi.fn(async () => {});
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async () => ({ errors: new Map<string, string>() })),
		disconnectServer: vi.fn(async () => {}),
		prepareConfig: vi.fn(async (config: MCPServerConfig) => config),
		connectServers: vi.fn(
			async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
				errors: new Map<string, string>(),
				connectedServers: [],
				tools: [],
				exaApiKeys: [],
			}),
		),
		getTools: vi.fn(() => [] as unknown[]),
		waitForConnection: vi.fn(async () => ({})),
		getConnectionStatus: vi.fn(() => "connected"),
		getSource: vi.fn(() => undefined),
	};
	const presentCommandOutput = vi.fn();
	const session = {
		refreshMCPTools,
		setMCPPromptCommands: vi.fn(),
		getEnabledToolNames: vi.fn(() => [] as string[]),
		getToolByName: vi.fn((_name: string) => undefined as unknown),
		setActiveToolsByName: vi.fn(async () => {}),
		modelRegistry: { authStorage: undefined },
	};
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present: vi.fn(),
		presentCommandOutput,
		ui: { requestRender: vi.fn() },
		editor: {},
		showError: vi.fn(),
		showStatus: vi.fn(),
		oauthManualInput: {
			hasPending: vi.fn(() => false),
			pendingProviderId: undefined,
			tryClaimInput: vi.fn(),
		},
		session,
		settings: { get: vi.fn(() => false) },
		mcpManager,
	} as never);

	return { controller, mcpManager, refreshMCPTools, presentCommandOutput, session };
}

type PresentableComponent = { render(width: number): string[] };

function renderPresentedOutput(presentCommandOutput: { mock: { calls: unknown[][] } }): string {
	return presentCommandOutput.mock.calls
		.map(call => Bun.stripANSI((call[0] as PresentableComponent).render(120).join("\n")))
		.join("\n");
}

async function writeProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(
		getMCPConfigPath("project", projectDir),
		`${JSON.stringify(
			{
				mcpServers: servers,
			},
			null,
			2,
		)}\n`,
	);
}

describe("/mcp enable and disable", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("disabling one configured server does not reload other MCP servers", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("mcp1");
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
	});

	test("enabling one configured server connects only that MCP server", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).toHaveBeenCalledTimes(1);
		const [configs] = mcpManager.connectServers.mock.calls[0]!;
		expect(Object.keys(configs)).toEqual(["mcp1"]);
		expect(configs.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
	});

	test("quick adding a deferred lazy server reports on-demand availability", async () => {
		const { controller, mcpManager, presentCommandOutput, session } = createController();
		mcpManager.getConnectionStatus.mockReturnValue("deferred");
		const lazyTool = { name: "lazy_echo", description: "", parameters: {}, mcpServerName: "lazy" };
		mcpManager.getTools.mockReturnValue([lazyTool]);
		session.getToolByName.mockImplementation((name: string) => (name === lazyTool.name ? lazyTool : undefined));

		await controller.handle("/mcp add lazy -- lazy-server");

		// Deferred cached tools must activate even without a live transport.
		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["lazy_echo"]);
		// Deferred state must skip the direct-test fallback entirely.
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
		const rendered = renderPresentedOutput(presentCommandOutput);
		expect(rendered).toContain('Added server "lazy" to project config');
		expect(rendered).toContain("Server is available on demand");
		expect(rendered).not.toContain("Successfully connected to server");
	});

	test("activates server tools when the direct-test fallback connects", async () => {
		const { controller, mcpManager, presentCommandOutput, session } = createController();
		mcpManager.getConnectionStatus
			.mockReturnValueOnce("disconnected") // #waitForServerConnectionWithAnimation
			.mockReturnValueOnce("disconnected") // #syncManagerConnection pre-check
			.mockReturnValueOnce("connected"); // #syncManagerConnection post-connect
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined);
		const lazyTool = { name: "lazy_echo", description: "", parameters: {}, mcpServerName: "lazy" };
		mcpManager.getTools.mockReturnValue([lazyTool]);
		session.getToolByName.mockImplementation((name: string) => (name === lazyTool.name ? lazyTool : undefined));

		await controller.handle("/mcp add lazy -- lazy-server");

		expect(mcpManager.connectServers).toHaveBeenCalledTimes(1);
		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["lazy_echo"]);
		const rendered = renderPresentedOutput(presentCommandOutput);
		expect(rendered).toContain("Successfully connected to server");
	});
});
