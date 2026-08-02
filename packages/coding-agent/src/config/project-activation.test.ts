import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { MCPServer } from "../capability/mcp";
import type { Rule } from "../capability/rule";
import { initializeWithSettings, loadCapability, syncDisabledProviders } from "../discovery";
import { loadSkills } from "../extensibility/skills";
import { loadAllMCPConfigs } from "../mcp/config";
import {
	resolveActivationProjectRootSync,
	resolveExistingActivationProjectRootSync,
	resolveProjectConfigRootSync,
} from "./activation-paths";
import { projectActivationKindFromExtensionId, Settings } from "./settings";

const cleanupPaths: string[] = [];

async function mkTmp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupPaths.push(dir);
	return dir;
}

async function mkProjectTmp(prefix: string): Promise<string> {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".tmp-omp-projects-"));
	cleanupPaths.push(base);
	return fs.mkdtemp(path.join(base, prefix));
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(cleanupPaths.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("project activation settings", () => {
	it("parses activation-managed extension ids", () => {
		expect(projectActivationKindFromExtensionId("skill:alpha")).toEqual({ kind: "skills", name: "alpha" });
		expect(projectActivationKindFromExtensionId("mcp:server")).toBeNull();
		expect(projectActivationKindFromExtensionId("rule:policy")).toEqual({ kind: "rules", name: "policy" });
		expect(projectActivationKindFromExtensionId("extension-module:module")).toEqual({
			kind: "extensions",
			name: "module",
		});
		expect(projectActivationKindFromExtensionId("slash-command:review")).toEqual({
			kind: "slash-commands",
			name: "review",
		});
	});

	it("keeps disabledExtensions dominant when a layer contains the same enabled id", () => {
		const sm = Settings.isolated({
			disabledExtensions: ["skill:alpha"],
			enabledExtensions: ["skill:alpha"],
		});

		expect(sm.get("disabledExtensions")).toEqual(["skill:alpha"]);
	});

	it("writes project activation to existing state fields and global activation inside tmp", async () => {
		const projectCwd = await mkProjectTmp(".tmp-project-activation-");
		const projectAgentDir = await mkTmp("omp-project-agent-");
		await Bun.write(
			path.join(projectAgentDir, "config.yml"),
			YAML.stringify({ disabledExtensions: ["skill:alpha"] }),
		);
		const projectSettings = await Settings.loadIsolated({ cwd: projectCwd, agentDir: projectAgentDir });
		const projectConfigPath = path.join(projectCwd, ".omp", "config.yml");

		expect(projectSettings.getActivationWriteTarget(projectCwd, "project")).toBe("project");
		expect(projectSettings.getDefaultActivationScope(projectCwd)).toBe("global");
		expect(projectSettings.getActivationWriteTarget(projectCwd)).toBe("global");
		expect(projectSettings.getActivationProjectRoot(projectCwd)).toBeNull();
		expect(projectSettings.get("disabledExtensions")).toEqual(["skill:alpha"]);
		await expect(fs.stat(path.join(projectCwd, ".omp"))).rejects.toThrow();

		const defaultWrite = await projectSettings.setProjectActivation("skills", "alpha", "disabled");
		expect(defaultWrite).toEqual({ target: "global", path: path.join(projectAgentDir, "config.yml") });
		await expect(fs.stat(path.join(projectCwd, ".omp"))).rejects.toThrow();
		const projectWrite = await projectSettings.setProjectActivation("skills", "alpha", "disabled", "project");
		expect(projectWrite).toEqual({ target: "project", path: projectConfigPath });
		const projectConfig = YAML.parse(await fs.readFile(projectConfigPath, "utf8")) as {
			disabledExtensions?: string[];
		};
		expect(projectConfig.disabledExtensions).toEqual(["skill:alpha"]);

		await projectSettings.setProjectActivation("skills", "alpha", "inherit", "project");
		const inheritedConfig = YAML.parse(await fs.readFile(projectConfigPath, "utf8")) as {
			disabledExtensions?: string[];
		};
		expect(inheritedConfig.disabledExtensions).toBeUndefined();
		expect(projectSettings.get("disabledExtensions")).toEqual(["skill:alpha"]);

		await projectSettings.setProjectActivation("skills", "alpha", "enabled", "project");
		const enabledConfig = YAML.parse(await fs.readFile(projectConfigPath, "utf8")) as {
			disabledExtensions?: string[];
			enabledExtensions?: string[];
		};
		expect(enabledConfig.disabledExtensions).toBeUndefined();
		expect(enabledConfig.enabledExtensions).toEqual(["skill:alpha"]);
		expect(projectSettings.get("disabledExtensions")).toEqual([]);

		const tmpCwd = await mkTmp("omp-global-cwd-");
		const globalAgentDir = await mkTmp("omp-global-agent-");
		const globalSettings = await Settings.loadIsolated({ cwd: tmpCwd, agentDir: globalAgentDir });
		expect(globalSettings.getActivationWriteTarget(tmpCwd)).toBe("global");
		const literalTmpSettings = await Settings.loadIsolated({
			cwd: path.join("/tmp", "omp-literal-global"),
			agentDir: projectAgentDir,
		});
		expect(literalTmpSettings.getActivationWriteTarget(path.join("/tmp", "omp-literal-global"))).toBe("global");

		const globalWrite = await globalSettings.setProjectActivation("skills", "beta", "disabled");
		expect(globalWrite).toEqual({ target: "global", path: path.join(globalAgentDir, "config.yml") });
		const globalConfig = YAML.parse(await fs.readFile(path.join(globalAgentDir, "config.yml"), "utf8")) as {
			disabledExtensions?: string[];
		};
		expect(globalConfig.disabledExtensions).toEqual(["skill:beta"]);
		await expect(fs.stat(path.join(tmpCwd, ".omp"))).rejects.toThrow();
	});

	it("uses an existing project config inside temporary directories", async () => {
		const projectRoot = await mkTmp("omp-activation-project-");
		const agentDir = await mkTmp("omp-activation-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });

		expect(settings.getDefaultActivationScope(projectRoot)).toBe("project");
		expect(settings.getActivationWriteTarget(projectRoot, "project")).toBe("project");

		await settings.setProjectActivation("skills", "temp-project", "disabled");
		const projectConfig = YAML.parse(await Bun.file(path.join(projectRoot, ".omp", "config.yml")).text()) as {
			disabledExtensions?: string[];
		};
		expect(projectConfig.disabledExtensions).toEqual(["skill:temp-project"]);
		const globalConfigFile = Bun.file(path.join(agentDir, "config.yml"));
		const globalConfig = (await globalConfigFile.exists()) ? await globalConfigFile.text() : "";
		expect(globalConfig).not.toContain("skill:temp-project");
	});

	it("does not inherit an OMP marker from a temporary-directory root", async () => {
		const temporaryRoot = await mkTmp("omp-activation-temp-root-");
		const nestedCwd = path.join(temporaryRoot, "unrelated", "project");
		await fs.mkdir(path.join(temporaryRoot, ".omp"), { recursive: true });
		await fs.mkdir(nestedCwd, { recursive: true });
		vi.spyOn(os, "tmpdir").mockReturnValue(temporaryRoot);

		expect(resolveExistingActivationProjectRootSync(nestedCwd)).toBeNull();
	});

	it("uses the Git worktree root for activation and MCP configuration", async () => {
		const worktreeRoot = await mkTmp("omp-activation-worktree-");
		const nestedCwd = path.join(worktreeRoot, "packages", "feature");
		const agentDir = await mkTmp("omp-activation-agent-");
		await fs.mkdir(path.join(worktreeRoot, ".git"), { recursive: true });
		await fs.mkdir(nestedCwd, { recursive: true });

		const settings = await Settings.loadIsolated({ cwd: nestedCwd, agentDir });
		expect(resolveActivationProjectRootSync(nestedCwd, agentDir)).toBe(worktreeRoot);
		expect(settings.getActivationProjectRoot(nestedCwd, "project")).toBe(worktreeRoot);

		const write = await settings.setProjectActivation("skills", "alpha", "disabled", "project");
		expect(write).toEqual({ target: "project", path: path.join(worktreeRoot, ".omp", "config.yml") });
		await Bun.write(
			path.join(worktreeRoot, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { worktree: { command: "echo" } } }),
		);
		await Bun.write(
			path.join(worktreeRoot, "mcp.json"),
			JSON.stringify({ mcpServers: { standalone: { command: "standalone-echo" } } }),
		);

		initializeWithSettings(settings);
		const mcp = await loadAllMCPConfigs(nestedCwd, { filterExa: false });
		expect(Object.keys(mcp.configs)).toContain("worktree");
		expect(Object.keys(mcp.configs)).toContain("standalone");
		await expect(fs.stat(path.join(nestedCwd, ".omp"))).rejects.toThrow();
	});

	it("does not resurrect stale project activation keys after a write deletes them", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-activation-cache-");
		const agentDir = await mkTmp("omp-project-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ disabledExtensions: ["skill:alpha", "skill:beta", "skill:gamma"] }, null, 2),
		);
		await Bun.write(
			path.join(projectRoot, ".omp", "config.yml"),
			YAML.stringify(
				{
					disabledExtensions: ["skill:alpha"],
					enabledExtensions: ["skill:beta", "skill:gamma"],
				},
				null,
				2,
			),
		);

		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
		expect(settings.get("disabledExtensions")).toEqual(["skill:alpha"]);

		await settings.setProjectActivation("skills", "alpha", "enabled", "project");

		expect(settings.get("disabledExtensions")).toEqual([]);
		expect(settings.getProjectActivation("skills", "alpha", "project")).toBe("enabled");
		expect(settings.getProjectActivation("skills", "beta", "project")).toBe("enabled");
		expect(settings.getProjectActivation("skills", "gamma", "project")).toBe("enabled");
		const projectConfig = YAML.parse(await fs.readFile(path.join(projectRoot, ".omp", "config.yml"), "utf8")) as {
			disabledExtensions?: string[];
			enabledExtensions?: string[];
		};
		expect(projectConfig.disabledExtensions).toBeUndefined();
		expect(projectConfig.enabledExtensions).toEqual(["skill:alpha", "skill:beta", "skill:gamma"]);
	});

	it("quarantines a malformed activation config before replacing it", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-activation-invalid-");
		const agentDir = await mkTmp("omp-project-agent-");
		const configPath = path.join(projectRoot, ".omp", "config.yml");
		await Bun.write(configPath, "disabledExtensions: []\n");
		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
		await Bun.write(configPath, "disabledExtensions: [\n");

		await settings.setProjectActivation("skills", "alpha", "disabled", "project");

		const config = YAML.parse(await Bun.file(configPath).text()) as { disabledExtensions?: string[] };
		expect(config.disabledExtensions).toEqual(["skill:alpha"]);
		const siblingFiles = await fs.readdir(path.dirname(configPath));
		expect(siblingFiles.some(file => file.startsWith("config.yml.broken-"))).toBe(true);
	});

	it("keeps global activation scope independent from project disabled extensions", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-global-scope-");
		const agentDir = await mkTmp("omp-project-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ disabledExtensions: ["extension-module:rtk"], disabledProviders: ["native"] }, null, 2),
		);
		await Bun.write(
			path.join(projectRoot, ".omp", "config.yml"),
			YAML.stringify({ disabledExtensions: ["skill:find-skills"], disabledProviders: ["claude"] }, null, 2),
		);

		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });

		expect(settings.getActivationDisabledExtensions("global")).toEqual(["extension-module:rtk"]);
		expect(settings.getActivationDisabledExtensions("project")).toEqual([
			"extension-module:rtk",
			"skill:find-skills",
		]);
		expect(settings.getActivationDisabledProviders("global")).toEqual(["native"]);
		expect(settings.getActivationDisabledProviders("project")).toEqual(["claude", "native"]);
	});

	it("preserves concurrent global dashboard extension toggles", async () => {
		const agentDir = await mkTmp("omp-global-activation-lock-");
		const cwd = await mkTmp("omp-global-activation-cwd-");
		const [first, second] = await Promise.all([
			Settings.loadIsolated({ cwd, agentDir }),
			Settings.loadIsolated({ cwd, agentDir }),
		]);

		await Promise.all([
			first.setExtensionActivation("skill:alpha", "disabled", "global"),
			second.setExtensionActivation("tool:beta", "disabled", "global"),
		]);

		const config = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
			disabledExtensions?: string[];
		};
		expect(config.disabledExtensions).toEqual(["skill:alpha", "tool:beta"]);
	});

	it("loads only activation keys from ancestor project config", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-activation-only-");
		const nestedCwd = path.join(projectRoot, "packages", "coding-agent");
		const agentDir = await mkTmp("omp-project-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await fs.mkdir(nestedCwd, { recursive: true });
		await Bun.write(
			path.join(projectRoot, ".omp", "config.yml"),
			YAML.stringify({ "advisor.enabled": true, disabledExtensions: ["skill:alpha"] }, null, 2),
		);

		const settings = await Settings.loadIsolated({ cwd: nestedCwd, agentDir });

		expect(settings.getActivationDisabledExtensions("project")).toEqual(["skill:alpha"]);
		expect(settings.get("advisor.enabled")).toBe(false);
	});

	it("treats OMP config roots as global activation directories", async () => {
		const globalRoot = await fs.mkdtemp(path.join(os.homedir(), ".tmp-omp-global-root-"));
		cleanupPaths.push(globalRoot);
		const globalAgentDir = path.join(globalRoot, "agent");
		await fs.mkdir(globalAgentDir, { recursive: true });

		for (const cwd of [globalAgentDir, path.join(globalAgentDir, "sessions")]) {
			const settings = await Settings.loadIsolated({ cwd, agentDir: globalAgentDir });
			expect(settings.getActivationWriteTarget(cwd)).toBe("global");
		}

		const baseGlobalRoot = path.join(os.homedir(), ".omp");
		const profileAgentDir = path.join(baseGlobalRoot, "profiles", "work", "agent");
		const profileSettings = await Settings.loadIsolated({ cwd: baseGlobalRoot, agentDir: profileAgentDir });
		expect(profileSettings.getActivationWriteTarget(baseGlobalRoot)).toBe("global");
	});

	it("keeps a Git-managed agent directory in global activation scope", async () => {
		const agentDir = await mkTmp("omp-global-git-agent-");
		await fs.mkdir(path.join(agentDir, ".git"), { recursive: true });

		const settings = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		expect(resolveActivationProjectRootSync(agentDir, agentDir)).toBeNull();
		expect(settings.getDefaultActivationScope(agentDir)).toBe("global");
		expect(settings.getActivationWriteTarget(agentDir, "project")).toBe("global");
		await settings.setProjectActivation("skills", "alpha", "disabled", "project");
		expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(true);
		expect(await Bun.file(path.join(agentDir, ".omp", "config.yml")).exists()).toBe(false);
	});

	it("treats system directories as global activation directories", async () => {
		const agentDir = await mkTmp("omp-system-global-agent-");
		for (const cwd of ["/", "/usr", "/usr/bin", "/etc"]) {
			const settings = await Settings.loadIsolated({ cwd, agentDir });
			expect(settings.getActivationWriteTarget(cwd)).toBe("global");
			expect(settings.getActivationProjectRoot(cwd)).toBeNull();
			expect(settings.getActivationWriteTarget(cwd, "project")).toBe("global");
			expect(resolveProjectConfigRootSync(cwd, agentDir)).toBeNull();
		}

		const settings = await Settings.loadIsolated({ cwd: "/usr/bin", agentDir });
		const write = await settings.setProjectActivation("skills", "alpha", "disabled");
		expect(write).toEqual({ target: "global", path: path.join(agentDir, "config.yml") });
		const config = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			disabledExtensions?: string[];
		};
		expect(config.disabledExtensions).toEqual(["skill:alpha"]);
	});

	it("does not use an unmarked temporary directory as a project MCP root", async () => {
		const cwd = await mkTmp("omp-activation-temporary-cwd-");
		const agentDir = await mkTmp("omp-activation-agent-");
		expect(resolveProjectConfigRootSync(cwd, agentDir)).toBeNull();
	});

	it("writes project activation under the nearest ancestor with .omp", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-activation-root-");
		const nestedCwd = path.join(projectRoot, "packages", "coding-agent");
		const agentDir = await mkTmp("omp-project-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await fs.mkdir(nestedCwd, { recursive: true });

		const projectSettings = await Settings.loadIsolated({ cwd: nestedCwd, agentDir });
		expect(projectSettings.getDefaultActivationScope(nestedCwd)).toBe("project");
		expect(projectSettings.getActivationWriteTarget(nestedCwd)).toBe("project");
		expect(projectSettings.getActivationProjectRoot(nestedCwd)).toBe(projectRoot);

		const write = await projectSettings.setProjectActivation("rules", "policy", "disabled");
		const configPath = path.join(projectRoot, ".omp", "config.yml");
		expect(write).toEqual({ target: "project", path: configPath });
		const config = YAML.parse(await fs.readFile(configPath, "utf8")) as {
			disabledExtensions?: string[];
		};
		expect(config.disabledExtensions).toEqual(["rule:policy"]);

		await projectSettings.setProjectActivation("extensions", "module", "enabled");
		const extensionConfig = YAML.parse(await fs.readFile(configPath, "utf8")) as {
			disabledExtensions?: string[];
			enabledExtensions?: string[];
		};
		expect(extensionConfig.enabledExtensions).toEqual(["extension-module:module"]);
		expect(projectSettings.getProjectActivation("extensions", "module")).toBe("enabled");
		await expect(fs.stat(path.join(nestedCwd, ".omp"))).rejects.toThrow();
	});

	it("writes file slash-command activation to the shared extension lists", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-command-activation-");
		const agentDir = await mkTmp("omp-command-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });

		await settings.setProjectActivation("slash-commands", "review", "disabled");
		const projectConfig = YAML.parse(await fs.readFile(path.join(projectRoot, ".omp", "config.yml"), "utf8")) as {
			disabledExtensions?: string[];
		};
		expect(projectConfig.disabledExtensions).toEqual(["slash-command:review"]);
	});

	it("lets project enabledProviders override global disabledProviders", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-provider-activation-");
		const agentDir = await mkTmp("omp-provider-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ disabledProviders: ["mcp-json"] }, null, 2));

		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
		expect(settings.getProviderActivation("mcp-json")).toBe("inherit");
		expect(settings.isProviderEffectivelyDisabled("mcp-json")).toBe(true);
		expect(settings.isProviderEffectivelyDisabled("mcp-json", "global")).toBe(true);

		const write = await settings.setProviderActivation("mcp-json", "enabled");
		const projectConfigPath = path.join(projectRoot, ".omp", "config.yml");
		expect(write).toEqual({ target: "project", path: projectConfigPath });
		const projectConfig = YAML.parse(await fs.readFile(projectConfigPath, "utf8")) as {
			disabledProviders?: string[];
			enabledProviders?: string[];
		};
		expect(projectConfig.disabledProviders).toBeUndefined();
		expect(projectConfig.enabledProviders).toEqual(["mcp-json"]);
		expect(settings.isProviderEffectivelyDisabled("mcp-json")).toBe(false);
		expect(settings.isProviderEffectivelyDisabled("mcp-json", "project")).toBe(false);
		expect(settings.isProviderEffectivelyDisabled("mcp-json", "global")).toBe(true);
		syncDisabledProviders(settings.get("disabledProviders") as string[]);
		const globalConfig = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			disabledProviders?: string[];
		};
		expect(globalConfig.disabledProviders).toEqual(["mcp-json"]);
	});

	it("resolves path-scoped project provider allowlists", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-provider-path-activation-");
		const agentDir = await mkTmp("omp-provider-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ disabledProviders: ["mcp-json"] }, null, 2));
		await Bun.write(
			path.join(projectRoot, ".omp", "config.yml"),
			YAML.stringify(
				{
					enabledProviders: [{ pathPrefix: projectRoot, providers: ["mcp-json"] }],
				},
				null,
				2,
			),
		);

		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });

		expect(settings.get("disabledProviders")).toEqual([]);
		expect(settings.isProviderEffectivelyDisabled("mcp-json")).toBe(false);
		expect(settings.isProviderEffectivelyDisabled("mcp-json", "global")).toBe(true);
	});

	it("preserves path-scoped provider entries when toggling bare activation", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-provider-path-toggle-");
		const agentDir = await mkTmp("omp-provider-agent-");
		const globalConfigPath = path.join(agentDir, "config.yml");
		const projectConfigPath = path.join(projectRoot, ".omp", "config.yml");
		const globalScoped = { pathPrefix: projectRoot, providers: ["claude"] };
		const projectScoped = { pathPrefix: projectRoot, providers: ["native"] };
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await Bun.write(globalConfigPath, YAML.stringify({ disabledProviders: [globalScoped] }, null, 2));
		await Bun.write(projectConfigPath, YAML.stringify({ enabledProviders: [projectScoped] }, null, 2));
		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });

		await settings.setProviderActivation("mcp-json", "disabled", "global");
		await settings.setProviderActivation("mcp-json", "enabled", "project");

		const globalConfig = YAML.parse(await Bun.file(globalConfigPath).text()) as { disabledProviders?: unknown[] };
		const projectConfig = YAML.parse(await Bun.file(projectConfigPath).text()) as { enabledProviders?: unknown[] };
		expect(globalConfig.disabledProviders).toEqual(["mcp-json", globalScoped]);
		expect(projectConfig.enabledProviders).toEqual(["mcp-json", projectScoped]);
	});

	it("enables a provider disabled by a matching path-scoped global entry", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-provider-scoped-global-toggle-");
		const otherRoot = await mkProjectTmp(".tmp-project-provider-other-global-toggle-");
		const agentDir = await mkTmp("omp-provider-agent-");
		const configPath = path.join(agentDir, "config.yml");
		const matchingEntry = { pathPrefix: projectRoot, providers: ["claude", "mcp-json"] };
		const otherEntry = { pathPrefix: otherRoot, providers: ["mcp-json"] };
		await Bun.write(configPath, YAML.stringify({ disabledProviders: [matchingEntry, otherEntry] }, null, 2));
		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });

		expect(settings.getProviderActivation("mcp-json", "global")).toBe("disabled");
		expect(settings.isProviderEffectivelyDisabled("mcp-json", "global")).toBe(true);

		await settings.setProviderActivation("mcp-json", "enabled", "global");

		expect(settings.getProviderActivation("mcp-json", "global")).toBe("enabled");
		expect(settings.isProviderEffectivelyDisabled("mcp-json", "global")).toBe(false);
		const config = YAML.parse(await Bun.file(configPath).text()) as { disabledProviders?: unknown[] };
		expect(config.disabledProviders).toEqual([{ pathPrefix: projectRoot, providers: ["claude"] }, otherEntry]);
	});

	it("ignores legacy extension activation when loading MCP servers", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await mkProjectTmp(".tmp-project-mcp-load-");
		const agentDir = await mkTmp("omp-mcp-load-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { server: { command: "echo", args: ["ok"] } } }, null, 2),
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ disabledExtensions: ["mcp:server"] }, null, 2),
		);
		setAgentDir(agentDir);
		try {
			initializeWithSettings(await Settings.loadIsolated({ cwd: projectRoot, agentDir }));
			const mcp = await loadAllMCPConfigs(projectRoot, { filterExa: false });
			expect(Object.keys(mcp.configs)).toContain("server");
			const directMcp = await loadCapability<MCPServer>("mcps", { cwd: projectRoot });
			expect(directMcp.items.map(server => server.name)).toContain("server");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps source enabled:false hard-disabled", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await mkProjectTmp(".tmp-project-mcp-hard-disable-");
		const agentDir = await mkTmp("omp-mcp-hard-disable-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { server: { command: "echo", enabled: false } } }, null, 2),
		);
		setAgentDir(agentDir);
		try {
			initializeWithSettings(await Settings.loadIsolated({ cwd: projectRoot, agentDir }));
			const mcp = await loadAllMCPConfigs(projectRoot, { filterExa: false });
			expect(Object.keys(mcp.configs)).not.toContain("server");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("does not load global agent mcp.json twice as standalone project MCP", async () => {
		const previousAgentDir = getAgentDir();
		const agentDir = await mkTmp("omp-mcp-global-agent-");
		await fs.mkdir(path.join(agentDir, ".git"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { server: { command: "echo", args: ["ok"] } } }, null, 2),
		);
		await Bun.write(
			path.join(agentDir, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { mustNotLoad: { command: "echo", args: ["project"] } } }, null, 2),
		);

		setAgentDir(agentDir);
		try {
			expect(resolveActivationProjectRootSync(agentDir, agentDir)).toBeNull();
			const mcp = await loadCapability<MCPServer>("mcps", { cwd: agentDir, includeDisabled: true });
			const names = mcp.all.map(server => server.name).filter(name => name === "server");
			expect(names).toEqual(["server"]);
			expect(mcp.all.map(server => server.name)).not.toContain("mustNotLoad");
			const loadedConfigs = await loadAllMCPConfigs(agentDir, { filterExa: false });
			expect(loadedConfigs.configs).not.toHaveProperty("mustNotLoad");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});
	it("does not apply extension activation to MCP during next-startup discovery", async () => {
		const cwd = await mkProjectTmp(".tmp-omp-activation-runtime-");
		const agentDir = await mkTmp("omp-activation-runtime-agent-");
		await fs.mkdir(path.join(cwd, ".omp", "skills", "alpha"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".omp", "skills", "alpha", "SKILL.md"),
			"---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body\n",
		);
		await fs.writeFile(
			path.join(cwd, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { server: { command: "echo", args: ["ok"] } } }, null, 2),
		);
		await fs.writeFile(
			path.join(cwd, ".omp", "rules", "policy.md"),
			"---\ndescription: Policy rule\n---\nPolicy body\n",
		);
		await Bun.write(
			path.join(cwd, ".omp", "config.yml"),
			YAML.stringify({ disabledExtensions: ["mcp:server", "rule:policy", "skill:alpha"] }, null, 2),
		);

		const sm = await Settings.loadIsolated({ cwd, agentDir });
		initializeWithSettings(sm);
		const disabledExtensions = sm.get("disabledExtensions");

		const skills = await loadSkills({ cwd, disabledExtensions });
		expect(skills.skills.map(skill => skill.name)).not.toContain("alpha");

		const mcp = await loadAllMCPConfigs(cwd, { filterExa: false });
		expect(Object.keys(mcp.configs)).toContain("server");

		const rules = await loadCapability<Rule>("rules", { cwd, disabledExtensions });
		expect(rules.items.map(rule => rule.name)).not.toContain("policy");
	});
});
