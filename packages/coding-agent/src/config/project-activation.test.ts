import { afterEach, describe, expect, it } from "bun:test";
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
	await Promise.all(cleanupPaths.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("project activation settings", () => {
	it("parses activation-managed extension ids", () => {
		expect(projectActivationKindFromExtensionId("skill:alpha")).toEqual({ kind: "skills", name: "alpha" });
		expect(projectActivationKindFromExtensionId("mcp:server")).toEqual({ kind: "mcp", name: "server" });
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

		expect(projectSettings.canUseProjectActivation(projectCwd)).toBe(true);
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

		const globalWrite = await globalSettings.setProjectActivation("mcp", "server", "disabled");
		expect(globalWrite).toEqual({ target: "global", path: path.join(globalAgentDir, "config.yml") });
		const globalConfig = YAML.parse(await fs.readFile(path.join(globalAgentDir, "config.yml"), "utf8")) as {
			disabledExtensions?: string[];
		};
		expect(globalConfig.disabledExtensions).toEqual(["mcp:server"]);
		await expect(fs.stat(path.join(tmpCwd, ".omp"))).rejects.toThrow();
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

	it("treats system directories as global activation directories", async () => {
		const agentDir = await mkTmp("omp-system-global-agent-");
		for (const cwd of ["/", "/usr", "/usr/bin", "/etc"]) {
			const settings = await Settings.loadIsolated({ cwd, agentDir });
			expect(settings.getActivationWriteTarget(cwd)).toBe("global");
			expect(settings.getActivationProjectRoot(cwd)).toBeNull();
			expect(settings.getActivationWriteTarget(cwd, "project")).toBe("global");
		}

		const settings = await Settings.loadIsolated({ cwd: "/usr/bin", agentDir });
		const write = await settings.setProjectActivation("skills", "alpha", "disabled");
		expect(write).toEqual({ target: "global", path: path.join(agentDir, "config.yml") });
		const config = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")) as {
			disabledExtensions?: string[];
		};
		expect(config.disabledExtensions).toEqual(["skill:alpha"]);
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

	it("lets project enabledExtensions override global MCP disablement", async () => {
		const projectRoot = await mkProjectTmp(".tmp-project-mcp-activation-");
		const agentDir = await mkTmp("omp-mcp-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ disabledExtensions: ["mcp:server"] }, null, 2),
		);

		const settings = await Settings.loadIsolated({ cwd: projectRoot, agentDir });
		expect(settings.getProjectActivation("mcp", "server")).toBe("inherit");
		expect(settings.isProjectActivationEffectivelyDisabled("mcp", "server")).toBe(true);

		const write = await settings.setProjectActivation("mcp", "server", "enabled");
		const projectConfigPath = path.join(projectRoot, ".omp", "config.yml");
		expect(write).toEqual({ target: "project", path: projectConfigPath });
		const projectConfig = YAML.parse(await fs.readFile(projectConfigPath, "utf8")) as {
			enabledExtensions?: string[];
		};
		expect(projectConfig.enabledExtensions).toEqual(["mcp:server"]);
		expect(settings.isProjectActivationEffectivelyDisabled("mcp", "server")).toBe(false);
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

	it("applies project enabledExtensions over global MCP disablement during loading", async () => {
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
		await Bun.write(
			path.join(projectRoot, ".omp", "config.yml"),
			YAML.stringify({ enabledExtensions: ["mcp:server"] }, null, 2),
		);

		setAgentDir(agentDir);
		try {
			initializeWithSettings(await Settings.loadIsolated({ cwd: projectRoot, agentDir }));
			const mcp = await loadAllMCPConfigs(projectRoot, { filterExa: false });
			expect(Object.keys(mcp.configs)).toContain("server");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps source enabled:false hard-disabled after an activation override", async () => {
		const previousAgentDir = getAgentDir();
		const projectRoot = await mkProjectTmp(".tmp-project-mcp-hard-disable-");
		const agentDir = await mkTmp("omp-mcp-hard-disable-agent-");
		await fs.mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { server: { command: "echo", enabled: false } } }, null, 2),
		);
		await Bun.write(
			path.join(projectRoot, ".omp", "config.yml"),
			YAML.stringify({ enabledExtensions: ["mcp:server"] }, null, 2),
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
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { server: { command: "echo", args: ["ok"] } } }, null, 2),
		);

		setAgentDir(agentDir);
		try {
			const mcp = await loadCapability<MCPServer>("mcps", { cwd: agentDir, includeDisabled: true });
			const names = mcp.all.map(server => server.name).filter(name => name === "server");
			expect(names).toEqual(["server"]);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});
	it("applies project activation during next-startup discovery for skills, MCP, and rules", async () => {
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
		expect(Object.keys(mcp.configs)).not.toContain("server");

		const rules = await loadCapability<Rule>("rules", { cwd, disabledExtensions });
		expect(rules.items.map(rule => rule.name)).not.toContain("policy");
	});
});
