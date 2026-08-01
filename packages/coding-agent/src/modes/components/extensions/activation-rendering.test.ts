import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { Settings } from "../../../config/settings";
import { initTheme, theme } from "../../../modes/theme/theme";
import {
	ExtensionDashboard,
	extensionDashboardFooter,
	extensionDashboardTitle,
	nextExtensionActivationState,
} from "./extension-dashboard";
import { ExtensionList } from "./extension-list";
import { InspectorPanel } from "./inspector-panel";
import { extensionRowKey, selectAfterRefresh } from "./state-manager";
import type { DashboardState, Extension } from "./types";

const cleanupPaths: string[] = [];
beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
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
		const projectRoot = await fs.mkdtemp(path.join(os.homedir(), ".tmp-omp-extension-global-scope-"));
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
		const projectRoot = await fs.mkdtemp(path.join(os.homedir(), ".tmp-omp-extension-global-row-"));
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
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("does not present a same-id user skill as an active project fallback", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.homedir(), ".tmp-omp-extension-shadowed-row-"));
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

	it("disables global MCP rows even when project forces them enabled", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.homedir(), ".tmp-omp-extension-global-mcp-"));
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
			expect(settings.getProjectActivation("mcp", "zzmcpglobal", "global")).toBe("disabled");
			expect(rendered).toContain("Disabled (manually disabled)");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("uses binary provider activation for project-only AGENTS.md", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await fs.mkdtemp(path.join(os.homedir(), "tmp-omp-extension-agents-provider-"));
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

		inspector.setExtension(extension({ state: "disabled", activationLocked: true }));
		rendered = stripAnsi(inspector.render(80).join("\n"));
		expect(rendered).toContain("Disabled (locked)");
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
});
