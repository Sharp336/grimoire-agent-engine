import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { Settings } from "../../../config/settings";
import { getDisabledProviders, syncDisabledProviders } from "../../../discovery";
import { readMCPConfigFile } from "../../../mcp/config-writer";
import { initTheme, theme } from "../../../modes/theme/theme";
import {
	ExtensionDashboard,
	extensionDashboardFooter,
	extensionDashboardTitle,
	nextExtensionActivationState,
} from "./extension-dashboard";
import { ExtensionList } from "./extension-list";
import { InspectorPanel } from "./inspector-panel";
import { buildProviderTabs, extensionRowKey, loadAllExtensions, selectAfterRefresh } from "./state-manager";
import type { DashboardState, Extension } from "./types";

const cleanupPaths: string[] = [];
beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(cleanupPaths.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function extension(overrides: Partial<Extension> = {}): Extension {
	return {
		id: "skill:alpha",
		kind: "skill",
		name: "alpha",
		displayName: "alpha",
		path: "/tmp/project/.omp/skills/alpha/SKILL.md",
		source: {
			provider: "native",
			providerName: "OMP",
			level: "project",
		},
		state: "active",
		raw: {},
		...overrides,
	};
}

describe("extension activation rendering", () => {
	it("renders activation write scope title and conditional key hint", () => {
		expect(extensionDashboardTitle("global")).toBe("Extension Control Center · ✎ Global");
		expect(extensionDashboardTitle("project")).toBe("Extension Control Center · ✎ Project");
		expect(extensionDashboardFooter(true)).toContain("Ctrl+P: scope");
		expect(extensionDashboardFooter(false)).not.toContain("Ctrl+P: scope");
	});

	it("hides project-only rows from the global edit scope", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-global-scope-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp", "skills", "zzlocalonly"), { recursive: true });
		await fs.mkdir(path.join(agentDir, "skills", "user-only"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "skills", "zzlocalonly", "SKILL.md"),
			"---\nname: zzlocalonly\ndescription: Project only\n---\nProject only\n",
		);
		await Bun.write(
			path.join(agentDir, "skills", "user-only", "SKILL.md"),
			"---\nname: user-only\ndescription: User only\n---\nUser only\n",
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "zzlocalonly") dashboard.handleInput(char);

			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("zzlocalonly");

			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain("Extension Control Center · ✎ Global");
			expect(rendered).toContain("No extensions found");
			expect(rendered).toContain("Select an extension");
			expect(rendered).not.toContain("via OMP (Project)");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps project-disabled user rows active in the global edit scope", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-global-row-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await fs.mkdir(path.join(agentDir, "skills", "zzsharedonly"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "skills", "zzsharedonly", "SKILL.md"),
			"---\nname: zzsharedonly\ndescription: Shared user skill\n---\nShared user skill\n",
		);
		await Bun.write(path.join(projectRoot, ".omp", "config.yml"), "disabledExtensions:\n  - skill:zzsharedonly\n");

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "zzsharedonly") dashboard.handleInput(char);

			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("Disabled (manually disabled)");

			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain("Extension Control Center · ✎ Global");
			expect(rendered).toContain("zzsharedonly");
			expect(rendered).toContain("● Active");
			expect(rendered).not.toContain("Disabled (manually disabled)");

			dashboard.handleInput(" ");
			await Bun.sleep(100);

			const globalConfig = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
				disabledExtensions?: string[];
			};
			const projectConfig = YAML.parse(await Bun.file(path.join(projectRoot, ".omp", "config.yml")).text()) as {
				disabledExtensions?: string[];
			};
			expect(globalConfig.disabledExtensions).toEqual(["skill:zzsharedonly"]);
			expect(projectConfig.disabledExtensions).toEqual(["skill:zzsharedonly"]);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("does not present a same-id user skill as an active project fallback", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-shadowed-row-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp", "skills", "zzsameid"), { recursive: true });
		await fs.mkdir(path.join(agentDir, "skills", "zzsameid"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "skills", "zzsameid", "SKILL.md"),
			"---\nname: zzsameid\ndescription: Project skill\n---\nProject skill\n",
		);
		await Bun.write(
			path.join(agentDir, "skills", "zzsameid", "SKILL.md"),
			"---\nname: zzsameid\ndescription: User skill\n---\nUser skill\n",
		);
		await Bun.write(path.join(projectRoot, ".omp", "config.yml"), "disabledExtensions:\n  - skill:zzsameid\n");

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "zzsameid") dashboard.handleInput(char);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain("Disabled (manually disabled)");
			expect(rendered).not.toContain("● Active");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("writes MCP toggles to mcp.json instead of extension activation settings", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-global-mcp-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { zzmcpglobal: { command: "echo", args: ["ok"] } } }, null, 2),
		);
		await Bun.write(
			path.join(projectRoot, ".omp", "config.yml"),
			YAML.stringify({ enabledExtensions: ["mcp:zzmcpglobal"] }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "zzmcpglobal") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("● Active");

			dashboard.handleInput(" ");
			await Bun.sleep(200);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			const config = await readMCPConfigFile(path.join(agentDir, "mcp.json"));
			expect(config.mcpServers?.zzmcpglobal?.enabled).toBe(false);
			expect(rendered).toContain("Disabled (manually disabled)");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("does not apply a project MCP allowlist in the global edit scope", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-global-mcp-overlay-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { sourceDisabled: { command: "echo", enabled: false } } }),
		);
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ enabledServers: ["sourceDisabled"] }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "sourceDisabled") dashboard.handleInput(char);
			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("● Active");

			dashboard.handleInput("\u0010");
			await Bun.sleep(50);
			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("Disabled (manually disabled)");

			dashboard.handleInput(" ");
			await Bun.sleep(100);
			expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).mcpServers?.sourceDisabled?.enabled).toBe(
				true,
			);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("preserves a user MCP allowlist over a project denylist in the global edit scope", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-global-user-allow-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { userAllowed: { command: "echo", enabled: false } },
				enabledServers: ["userAllowed"],
			}),
		);
		await Bun.write(path.join(projectRoot, ".omp", "mcp.json"), JSON.stringify({ disabledServers: ["userAllowed"] }));

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "userAllowed") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("● Active");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("activates a source-disabled user MCP after hiding a same-name project definition", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-source-disabled-shadow-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { foo: { command: "project" } } }),
		);
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { foo: { command: "user", enabled: false } },
				enabledServers: ["foo"],
			}),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "foo") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain(`${theme.status.enabled} foo`);
			expect(rendered).not.toContain(`${theme.status.shadowed} foo`);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("disables a source-disabled user MCP after hiding a same-name project definition without a user allowlist", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-source-disabled-global-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { foo: { command: "project" } } }),
		);
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { foo: { command: "user", enabled: false } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "foo") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain(`${theme.status.disabled} foo`);
			expect(rendered).not.toContain(`${theme.status.shadowed} foo`);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("does not let a disabled high-priority MCP alias shadow a working user alias", async () => {
		const previousAgentDir = getAgentDir();
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-disabled-alias-home-"));
		const projectRoot = await fs.mkdtemp(path.join(homeDir, "project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(homeDir, agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { "disabled-alias": { command: "shared", enabled: false } } }),
		);
		await Bun.write(
			path.join(homeDir, ".claude.json"),
			JSON.stringify({ mcpServers: { "working-alias": { command: "shared" } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "alias") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain(`${theme.status.disabled} disabled-alias`);
			expect(rendered).toContain(`${theme.status.enabled} working-alias`);
			expect(rendered).not.toContain(`${theme.status.shadowed} working-alias`);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps an allowlisted source-disabled MCP alias shadowed when another alias wins", async () => {
		const previousAgentDir = getAgentDir();
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-allowlisted-alias-home-"));
		const projectRoot = await fs.mkdtemp(path.join(homeDir, "project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(homeDir, agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { first: { command: "shared" } },
				enabledServers: ["second"],
			}),
		);
		await Bun.write(
			path.join(homeDir, ".claude.json"),
			JSON.stringify({ mcpServers: { second: { command: "shared", enabled: false } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "shared") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain(`${theme.status.enabled} first`);
			expect(rendered).toContain(`${theme.status.shadowed} second`);
			expect(rendered).not.toContain(`${theme.status.enabled} second`);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps a project-shadowed user denylist row disabled and toggleable in the global edit scope", async () => {
		const previousAgentDir = getAgentDir();
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-denylisted-shadow-home-"));
		const projectRoot = await fs.mkdtemp(path.join(homeDir, "project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(homeDir, agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { foo: { command: "project" } } }),
		);
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { foo: { command: "user" } },
				disabledServers: ["foo"],
			}),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "foo") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);
			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("Disabled (manually disabled)");

			dashboard.handleInput(" ");
			await Bun.sleep(100);
			expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).disabledServers).toBeUndefined();
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("preserves a user MCP denylist in the global edit scope", async () => {
		const previousAgentDir = getAgentDir();
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-denylist-home-"));
		const projectRoot = await fs.mkdtemp(path.join(homeDir, "project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(homeDir, agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(path.join(projectRoot, ".omp", "mcp.json"), JSON.stringify({ enabledServers: ["denylisted"] }));
		await Bun.write(path.join(agentDir, "mcp.json"), JSON.stringify({ disabledServers: ["denylisted"] }));
		await Bun.write(
			path.join(homeDir, ".claude.json"),
			JSON.stringify({ mcpServers: { denylisted: { command: "claude-user" } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "denylisted") dashboard.handleInput(char);
			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("● Active");
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);
			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("Disabled (manually disabled)");

			dashboard.handleInput(" ");
			await Bun.sleep(100);
			expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).disabledServers).toBeUndefined();
			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("● Active");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps lower-priority user rows shadowed after hiding a same-name project MCP", async () => {
		const previousAgentDir = getAgentDir();
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-shadow-home-"));
		const projectRoot = await fs.mkdtemp(path.join(homeDir, "project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(homeDir, agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { shared: { command: "project" } } }),
		);
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { shared: { command: "native-user" } } }),
		);
		await Bun.write(
			path.join(homeDir, ".claude.json"),
			JSON.stringify({ mcpServers: { shared: { command: "claude-user" } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "shared") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered.match(new RegExp(`${theme.status.enabled} shared`, "g"))?.length).toBe(1);
			expect(rendered.match(new RegExp(`${theme.status.shadowed} shared`, "g"))?.length).toBe(1);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("activates a different-name user MCP after hiding an equivalent project definition", async () => {
		const previousAgentDir = getAgentDir();
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-alias-home-"));
		const projectRoot = await fs.mkdtemp(path.join(homeDir, "project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(homeDir, agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { "project-name": { command: "shared-command" } } }),
		);
		await Bun.write(
			path.join(homeDir, ".claude.json"),
			JSON.stringify({ mcpServers: { "user-name": { command: "shared-command" } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "user-name") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain(`${theme.status.enabled} user-name`);
			expect(rendered).not.toContain(`${theme.status.shadowed} user-name`);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("writes a project denylist entry when toggling an inherited MCP server", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-inherited-mcp-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { inherited: { command: "echo", args: ["global"] } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "inherited") dashboard.handleInput(char);
			await Bun.sleep(50);
			dashboard.handleInput(" ");
			await Bun.sleep(250);

			const projectConfig = await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"));
			const userConfig = await readMCPConfigFile(path.join(agentDir, "mcp.json"));
			expect(projectConfig.disabledServers).toEqual(["inherited"]);
			expect(projectConfig.mcpServers).toEqual({});
			expect(userConfig.mcpServers?.inherited).toMatchObject({ args: ["global"] });

			dashboard.handleInput(" ");
			await Bun.sleep(250);
			expect((await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"))).enabledServers).toEqual([
				"inherited",
			]);
			expect((await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"))).disabledServers).toBeUndefined();

			dashboard.handleInput(" ");
			await Bun.sleep(250);
			const restoredProjectConfig = await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"));
			expect(restoredProjectConfig.disabledServers).toBeUndefined();
			expect(restoredProjectConfig.enabledServers).toBeUndefined();
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("ignores project legacy MCP activation when rendering and toggling an inherited server", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-project-legacy-mcp-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { legacyinherited: { command: "echo" } } }),
		);
		await Bun.write(
			path.join(projectRoot, ".omp", "config.yml"),
			YAML.stringify({ disabledExtensions: ["mcp:legacyinherited"] }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			expect(stripAnsi(dashboard.render(120).join("\n"))).toContain("Active");
			for (const char of "legacyinherited") dashboard.handleInput(char);
			dashboard.handleInput(" ");
			await Bun.sleep(250);

			expect((await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"))).disabledServers).toEqual([
				"legacyinherited",
			]);
			const config = YAML.parse(await Bun.file(path.join(projectRoot, ".omp", "config.yml")).text()) as {
				disabledExtensions?: string[];
			};
			expect(config.disabledExtensions).toEqual(["mcp:legacyinherited"]);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("uses a binary toggle for a complete project MCP definition", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-zzlocal-mcp-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { zzlocalmcp: { command: "echo", args: ["zzlocalmcp"] } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "zzlocalmcp") dashboard.handleInput(char);
			await Bun.sleep(50);
			expect(stripAnsi(dashboard.render(120).join("\n"))).not.toContain("inherit");

			dashboard.handleInput(" ");
			await Bun.sleep(100);
			expect(
				(await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"))).mcpServers?.zzlocalmcp?.enabled,
			).toBe(false);
			dashboard.handleInput(" ");
			await Bun.sleep(100);
			expect(
				(await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"))).mcpServers?.zzlocalmcp?.enabled,
			).toBe(true);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("locks MCP toggles without changing their state when project MCP config loading is disabled", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-project-zzlocal-mcp-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { zzlocalmcp: { command: "echo", args: ["zzlocalmcp"] } } }),
		);
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { zzlocalmcp: { command: "echo", args: ["user"] } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			settings.set("mcp.enableProjectConfig", false);
			const server = (await loadAllExtensions(projectRoot, [], [], false)).find(
				extension => extension.id === "mcp:zzlocalmcp",
			);
			expect(server?.source.level).toBe("user");
			expect((server?.raw as { args?: string[] } | undefined)?.args).toEqual(["user"]);
			expect(server?.state).toBe("active");
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "zzlocalmcp") dashboard.handleInput(char);
			await Bun.sleep(50);

			const rendered = stripAnsi(dashboard.render(120).join("\n"));
			expect(rendered).toContain("Type: mcp");
			expect(rendered).not.toContain("inherit");
			dashboard.handleInput(" ");
			await Bun.sleep(50);
			expect(
				(await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"))).mcpServers?.zzlocalmcp?.enabled,
			).toBeUndefined();
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("uses binary provider activation for project-only AGENTS.md", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agents-provider-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(path.join(projectRoot, "AGENTS.md"), "Project instructions\n");

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (let i = 0; i < 30; i++) {
				if (stripAnsi(dashboard.render(140).join("\n")).includes("Enable AGENTS.md")) break;
				dashboard.handleInput("\x1b[C");
				await Bun.sleep(5);
			}

			expect(stripAnsi(dashboard.render(140).join("\n"))).toContain("Enable AGENTS.md");
			expect(settings.getProviderActivation("agents-md", "project")).toBe("inherit");

			dashboard.handleInput(" ");
			await Bun.sleep(120);
			expect(settings.getProviderActivation("agents-md", "project")).toBe("disabled");

			dashboard.handleInput(" ");
			await Bun.sleep(120);
			expect(settings.getProviderActivation("agents-md", "project")).toBe("enabled");

			dashboard.handleInput(" ");
			await Bun.sleep(120);
			expect(settings.getProviderActivation("agents-md", "project")).toBe("disabled");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps provider master row selected after provider refresh", () => {
		const ext = extension({
			id: "skill:provider-child",
			name: "provider-child",
			displayName: "provider-child",
			source: { provider: "claude", providerName: "Claude Code", level: "user" },
		});
		const state: DashboardState = {
			tabs: [
				{ id: "all", label: "ALL", enabled: true, count: 1 },
				{ id: "claude", label: "Claude Code", enabled: true, count: 1 },
			],
			activeTabIndex: 1,
			extensions: [ext],
			tabFiltered: [ext],
			searchFiltered: [ext],
			searchQuery: "",
			listIndex: 0,
			scrollOffset: 0,
			selected: null,
		};

		expect(selectAfterRefresh(state, "claude", [ext])).toBeNull();
	});

	it("uses scoped provider disablement when building provider tabs", () => {
		const previousDisabledProviders = getDisabledProviders();
		syncDisabledProviders(previousDisabledProviders.filter(providerId => providerId !== "claude"));
		try {
			const tabs = buildProviderTabs(
				[
					extension({
						id: "skill:provider-child",
						name: "provider-child",
						displayName: "provider-child",
						source: { provider: "claude", providerName: "Claude Code", level: "user" },
					}),
				],
				["claude"],
			);

			expect(tabs.find(tab => tab.id === "claude")).toMatchObject({ enabled: false, count: 1 });
		} finally {
			syncDisabledProviders(previousDisabledProviders);
		}
	});

	it("syncs provider registry from effective cwd state after a global provider toggle", async () => {
		const previousAgentDir = getAgentDir();
		const previousDisabledProviders = getDisabledProviders();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-provider-effective-sync-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await fs.mkdir(path.join(agentDir, "skills", "global-skill"), { recursive: true });
		await Bun.write(path.join(projectRoot, ".omp", "config.yml"), YAML.stringify({ enabledProviders: ["native"] }));
		await Bun.write(
			path.join(agentDir, "skills", "global-skill", "SKILL.md"),
			"---\nname: global-skill\ndescription: User skill\n---\nUser skill\n",
		);

		syncDisabledProviders(previousDisabledProviders.filter(providerId => providerId !== "native"));
		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			dashboard.handleInput("\x10");
			for (let i = 0; i < 30; i++) {
				if (stripAnsi(dashboard.render(140).join("\n")).includes("OMP Extension Packages")) break;
				dashboard.handleInput("\x1b[C");
				await Bun.sleep(5);
			}

			expect(stripAnsi(dashboard.render(140).join("\n"))).toContain("OMP Extension Packages");
			dashboard.handleInput(" ");
			await Bun.sleep(120);

			expect(settings.getProviderActivation("native", "global")).toBe("disabled");
			expect(settings.get("disabledProviders")).toEqual([]);
			expect(getDisabledProviders()).not.toContain("native");
		} finally {
			syncDisabledProviders(previousDisabledProviders);
			setAgentDir(previousAgentDir);
		}
	});

	it("renders inherited project activation as a leading icon without a text badge", () => {
		const list = new ExtensionList([
			extension({
				activationState: "inherit",
				activationTarget: "project",
			}),
		]);

		const rendered = list.render(80).join("\n");
		expect(stripAnsi(rendered)).not.toContain("project:inherit");
		expect(rendered).toContain(theme.fg("warning", theme.status.enabled));
	});

	it("preserves disabled icon styling for disabled inherited rows", () => {
		const list = new ExtensionList([
			extension({
				state: "disabled",
				disabledReason: "item-disabled",
				activationState: "inherit",
				activationTarget: "project",
			}),
		]);

		const rendered = list.render(80).join("\n");
		expect(stripAnsi(rendered)).not.toContain("project:inherit");
		expect(rendered).toContain(theme.fg("dim", theme.status.disabled));
	});

	it("folds activation labels into inspector status", () => {
		const inspector = new InspectorPanel();

		inspector.setExtension(extension({ activationState: "inherit", activationTarget: "project" }));
		let rendered = stripAnsi(inspector.render(80).join("\n"));
		expect(rendered).toContain("Active (inherit)");
		expect(rendered).not.toContain("Activation:");

		inspector.setExtension(
			extension({
				state: "disabled",
				disabledReason: "item-disabled",
				activationState: "inherit",
				activationTarget: "project",
			}),
		);
		rendered = stripAnsi(inspector.render(80).join("\n"));
		expect(rendered).toContain("Disabled (inherit)");
		expect(rendered).not.toContain("Activation:");

		inspector.setExtension(
			extension({
				state: "disabled",
				disabledReason: "item-disabled",
				activationState: "disabled",
				activationTarget: "global",
			}),
		);
		rendered = stripAnsi(inspector.render(80).join("\n"));
		expect(rendered).toContain("Disabled (manually disabled)");
		expect(rendered).not.toContain("Activation:");
	});

	it("does not toggle shadowed rows", () => {
		let toggled = false;
		let cycled = false;
		const list = new ExtensionList(
			[
				extension({
					state: "shadowed",
					disabledReason: "shadowed",
					activationState: "inherit",
					activationTarget: "project",
				}),
			],
			{
				onToggle: () => {
					toggled = true;
				},
				onActivationCycle: () => {
					cycled = true;
				},
			},
		);

		list.handleInput(" ");

		expect(toggled).toBe(false);
		expect(cycled).toBe(false);
	});

	it("does not toggle locked rows", () => {
		let toggled = false;
		let cycled = false;
		const list = new ExtensionList(
			[
				extension({
					state: "disabled",
					activationLocked: true,
					activationState: "enabled",
					activationTarget: "global",
				}),
			],
			{
				onToggle: () => {
					toggled = true;
				},
				onActivationCycle: () => {
					cycled = true;
				},
			},
		);

		list.handleInput(" ");

		expect(toggled).toBe(false);
		expect(cycled).toBe(false);
	});

	it("renders binary project activation without inherit labeling", () => {
		const inspector = new InspectorPanel();
		inspector.setExtension(
			extension({
				activationState: "enabled",
				activationTarget: "project",
				activationMode: "binary",
			}),
		);

		const rendered = stripAnsi(inspector.render(80).join("\n"));
		expect(rendered).toContain("Active");
		expect(rendered).not.toContain("Active (inherit)");
	});

	it("cycles project-only activation from inherited active to disabled to explicit enabled", () => {
		expect(
			nextExtensionActivationState({
				current: "inherit",
				currentlyDisabled: false,
				target: "project",
				mode: "binary",
				rowDisabled: false,
			}),
		).toBe("disabled");
		expect(
			nextExtensionActivationState({
				current: "disabled",
				currentlyDisabled: true,
				target: "project",
				mode: "binary",
				rowDisabled: true,
			}),
		).toBe("enabled");
	});

	it("colors provider master checkbox by activation state", () => {
		const inherited = new ExtensionList([], {
			masterSwitchProvider: "provider-a",
			masterSwitchActivationState: "inherit",
		});
		expect(inherited.render(80).join("\n")).toContain(theme.fg("warning", theme.checkbox.checked));

		const enabled = new ExtensionList([], {
			masterSwitchProvider: "provider-a",
			masterSwitchActivationState: "enabled",
		});
		expect(enabled.render(80).join("\n")).toContain(theme.fg("success", theme.checkbox.checked));
		const disabled = new ExtensionList([], {
			masterSwitchProvider: "provider-a",
			masterSwitchActivationState: "disabled",
			masterSwitchEnabled: false,
		});
		expect(disabled.render(80).join("\n")).toContain(theme.fg("dim", theme.checkbox.unchecked));
	});
	it("keeps the selected extension anchored by source row key after refresh", () => {
		const first = extension({ id: "skill:skill-a", name: "skill-a", displayName: "skill-a" });
		const second = extension({ id: "skill:skill-b", name: "skill-b", displayName: "skill-b" });
		const list = new ExtensionList([first, second]);

		list.handleInput("j");
		list.handleInput("j");
		expect(list.getSelectedExtension()?.id).toBe("skill:skill-b");

		const selectedKey = extensionRowKey(second);
		list.setExtensions([second, first]);
		expect(list.getSelectedExtension()?.id).toBe("skill:skill-a");

		expect(list.selectExtensionByKey(selectedKey)).toBe(true);
		expect(list.getSelectedExtension()?.id).toBe("skill:skill-b");
	});

	it("does not replace the shared provider registry while switching activation scope", async () => {
		const previousAgentDir = getAgentDir();
		const previousDisabledProviders = getDisabledProviders();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-provider-scope-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ disabledProviders: ["claude"] }));
		await Bun.write(path.join(projectRoot, ".omp", "config.yml"), YAML.stringify({ enabledProviders: ["claude"] }));

		setAgentDir(agentDir);
		syncDisabledProviders(["claude"]);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);

			expect(getDisabledProviders()).toEqual(["claude"]);
		} finally {
			syncDisabledProviders(previousDisabledProviders);
			setAgentDir(previousAgentDir);
		}
	});

	it("does not change a legacy MCP activation entry when enabling the server", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-legacy-mcp-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(projectRoot, agentDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { legacymcp: { command: "echo", enabled: false } } }),
		);
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ disabledExtensions: ["mcp:legacymcp"] }));

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "legacymcp") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);
			dashboard.handleInput(" ");
			await Bun.sleep(250);

			expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).mcpServers?.legacymcp?.enabled).toBe(true);
			const config = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
				disabledExtensions?: string[];
			};
			expect(config.disabledExtensions).toEqual(["mcp:legacymcp"]);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("does not edit a project MCP definition from Global scope", async () => {
		const previousAgentDir = getAgentDir();
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-home-"));
		const projectRoot = await fs.mkdtemp(path.join(homeDir, "project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-"));
		cleanupPaths.push(homeDir, agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(homeDir, ".claude.json"),
			JSON.stringify({ mcpServers: { shared: { command: "echo" } } }),
		);
		await Bun.write(
			path.join(projectRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { shared: { command: "echo", args: ["project"] } } }),
		);

		setAgentDir(agentDir);
		try {
			const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
			const dashboard = await ExtensionDashboard.create(projectRoot, settings, 28);
			for (const char of "shared") dashboard.handleInput(char);
			dashboard.handleInput("\u0010");
			await Bun.sleep(50);
			dashboard.handleInput(" ");
			await Bun.sleep(100);

			expect((await readMCPConfigFile(path.join(projectRoot, ".omp", "mcp.json"))).mcpServers?.shared).toMatchObject(
				{
					args: ["project"],
				},
			);
			expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).disabledServers).toEqual(["shared"]);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});
});
