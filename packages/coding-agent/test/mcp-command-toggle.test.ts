import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
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

function createController(disabledExtensions: string[] = [], enableProjectConfig = true, source?: SourceMeta) {
	const refreshMCPTools = vi.fn(async () => {});
	const showError = vi.fn();
	const presentCommandOutput = vi.fn();
	const setProjectActivation = vi.fn(async () => {});
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async () => ({ errors: new Map<string, string>() })),
		disconnectServer: vi.fn(async () => {}),
		connectServers: vi.fn(
			async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
				errors: new Map<string, string>(),
				connectedServers: [],
				tools: [],
				exaApiKeys: [],
			}),
		),
		getTools: vi.fn(() => []),
		getAllServerNames: vi.fn(() => []),
		getConnection: vi.fn(() => undefined),
		waitForConnection: vi.fn(async () => ({})),
		getConnectionStatus: vi.fn(() => "connected"),
		getSource: vi.fn(() => source),
	};
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present: vi.fn(),
		presentCommandOutput,
		ui: { requestRender: vi.fn() },
		editor: {},
		showError,
		showStatus: vi.fn(),
		oauthManualInput: {
			hasPending: vi.fn(() => false),
			pendingProviderId: undefined,
			tryClaimInput: vi.fn(),
		},
		session: {
			refreshMCPTools,
			setMCPPromptCommands: vi.fn(),
			modelRegistry: { authStorage: undefined },
		},
		mcpManager,
		settings: {
			get: vi.fn((key: string) =>
				key === "disabledExtensions"
					? disabledExtensions
					: key === "mcp.enableProjectConfig"
						? enableProjectConfig
						: [],
			),
			getActivationProjectRoot: vi.fn((cwd: string) => cwd),
			getProjectActivation: vi.fn(() => "inherit"),
			setProjectActivation,
		},
	} as never);

	return { controller, mcpManager, presentCommandOutput, refreshMCPTools, setProjectActivation, showError };
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
		const { controller, mcpManager, refreshMCPTools, showError } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(showError.mock.calls).toEqual([]);
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
		const { controller, mcpManager, setProjectActivation } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).toHaveBeenCalledTimes(1);
		expect(setProjectActivation).not.toHaveBeenCalled();
		const [configs] = mcpManager.connectServers.mock.calls[0]!;
		expect(Object.keys(configs)).toEqual(["mcp1"]);
		expect(configs.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
		const persisted = (await Bun.file(getMCPConfigPath("project", projectDir)).json()) as {
			mcpServers: Record<string, MCPServerConfig>;
		};
		expect(persisted.mcpServers.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
	});

	test("enabling an inherited server changes only its user definition", async () => {
		await Bun.write(
			getMCPConfigPath("user", projectDir),
			JSON.stringify({ mcpServers: { inherited: { type: "stdio", command: "user", enabled: false } } }),
		);
		await Bun.write(getMCPConfigPath("project", projectDir), JSON.stringify({ disabledServers: ["inherited"] }));
		const { controller, mcpManager, showError } = createController();

		await controller.handle("/mcp enable inherited");

		expect(showError.mock.calls).toEqual([]);
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
		expect(await Bun.file(getMCPConfigPath("user", projectDir)).json()).toMatchObject({
			mcpServers: { inherited: { enabled: true } },
		});
		expect(await Bun.file(getMCPConfigPath("project", projectDir)).json()).toMatchObject({
			disabledServers: ["inherited"],
		});
	});

	test("disables an unconfigured server through the user denylist fallback", async () => {
		const { controller, mcpManager, setProjectActivation, showError } = createController([], true, {} as SourceMeta);

		await controller.handle("/mcp disable discovered");

		expect(showError.mock.calls).toEqual([]);
		expect(await Bun.file(getMCPConfigPath("user", projectDir)).json()).toMatchObject({
			disabledServers: ["discovered"],
		});
		expect(setProjectActivation).not.toHaveBeenCalled();
	});

	test("does not test a server disabled by the project denylist", async () => {
		await Bun.write(
			getMCPConfigPath("user", projectDir),
			JSON.stringify({ mcpServers: { inherited: { type: "stdio", command: "user" } } }),
		);
		await Bun.write(getMCPConfigPath("project", projectDir), JSON.stringify({ disabledServers: ["inherited"] }));
		const { controller, showError } = createController();

		await controller.handle("/mcp test inherited");

		expect(showError).toHaveBeenCalledWith('Server "inherited" is disabled. Run /mcp enable inherited first.');
	});

	test("does not enable a project server when project MCP loading is disabled", async () => {
		await writeProjectConfig(projectDir, {
			projectOnly: { type: "stdio", command: "project-only", enabled: false },
		});
		const { controller, mcpManager, showError } = createController([], false);

		await controller.handle("/mcp enable projectOnly");

		expect(mcpManager.connectServers).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith('Server "projectOnly" not found.');
	});

	test("lists activation-disabled user and project servers as disabled", async () => {
		await Bun.write(
			getMCPConfigPath("user", projectDir),
			`${JSON.stringify(
				{
					mcpServers: { "user-server": { type: "stdio", command: "user-server" } },
				},
				null,
				2,
			)}\n`,
		);
		await writeProjectConfig(projectDir, {
			"project-server": { type: "stdio", command: "project-server" },
		});
		const { controller, presentCommandOutput } = createController(["mcp:user-server", "mcp:project-server"]);

		await controller.handle("/mcp list");

		const output = presentCommandOutput.mock.calls[0]?.[0] as { render(width: number): string[] } | undefined;
		if (!output) throw new Error("expected /mcp list to render command output");
		const rendered = Bun.stripANSI(output.render(120).join("\n"));
		expect(rendered).toContain("user-server ◌ disabled");
		expect(rendered).toContain("project-server ◌ disabled");
		expect(rendered).not.toContain("user-server ○ not connected");
		expect(rendered).not.toContain("project-server ○ not connected");
	});

	test("removes a project server from the ancestor project root", async () => {
		await writeProjectConfig(projectDir, {
			ancestor: { type: "stdio", command: "ancestor-server" },
		});
		const nestedDir = path.join(projectDir, "packages", "nested");
		await fs.mkdir(nestedDir, { recursive: true });
		setProjectDir(nestedDir);
		const { controller, showError } = createController();

		await controller.handle("/mcp remove ancestor");

		expect(showError.mock.calls).toEqual([]);
		const persisted = (await Bun.file(getMCPConfigPath("project", projectDir)).json()) as {
			mcpServers: Record<string, MCPServerConfig>;
		};
		expect(persisted.mcpServers.ancestor).toBeUndefined();
	});
});
