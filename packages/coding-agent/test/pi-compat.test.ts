import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getPluginsDir, getPluginsNodeModules, setAgentDir } from "@oh-my-pi/pi-utils";
import { loadCapability } from "../src/capability";
import { type Skill, skillCapability } from "../src/capability/skill";
import { loadCustomTools } from "../src/extensibility/custom-tools/loader";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import "../src/discovery/plugins";
import {
	buildPiCompatEnv,
	doctorPiCompatTarget,
	ensurePiCliShim,
	ensurePiCompatImportShims,
	getPiCompatHomeDir,
	normalizePiCompatibleManifest,
	parsePiInstallSource,
	planPiHomeSymlinkBridge,
} from "../src/extensibility/pi-compat";
import { PluginManager } from "../src/extensibility/plugins";
import {
	getAllPluginExtensionPaths,
	getAllPluginPromptPaths,
	getAllPluginSkillPaths,
	getAllPluginThemePaths,
} from "../src/extensibility/plugins/loader";

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function snapshotProcessEnv(keys: string[]): Record<string, string | undefined> {
	const snapshot: Record<string, string | undefined> = {};
	for (const key of keys) {
		snapshot[key] = process.env[key];
	}
	return snapshot;
}

function restoreProcessEnv(snapshot: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

describe("Pi compatibility source parsing", () => {
	it("parses Pi npm, git, and local source grammar", () => {
		const cwd = makeTempDir("omp-pi-source-");
		expect(parsePiInstallSource("npm:pi-teams@0.9.14", cwd)).toMatchObject({
			kind: "npm",
			installSpec: "pi-teams@0.9.14",
			packageNameHint: "pi-teams",
		});
		expect(parsePiInstallSource("npm:@scope/pkg@1.2.3", cwd)).toMatchObject({
			kind: "npm",
			installSpec: "@scope/pkg@1.2.3",
			packageNameHint: "@scope/pkg",
		});
		expect(parsePiInstallSource("git:github.com/u/r@v1", cwd)).toMatchObject({
			kind: "git",
			installSpec: "github:u/r#v1",
			packageNameHint: "r",
			ref: "v1",
		});
		expect(parsePiInstallSource("https://github.com/u/r@v1", cwd)).toMatchObject({
			kind: "git",
			installSpec: "github:u/r#v1",
		});
		const local = parsePiInstallSource("./local-plugin", cwd);
		expect(local.kind).toBe("local");
		expect(local.localPath).toBe(path.join(cwd, "local-plugin"));
		expect(parsePiInstallSource("C:/plugins/pi-local", cwd)).toMatchObject({
			kind: "local",
			localPath: path.normalize("C:/plugins/pi-local"),
		});
	});

	it("rejects shell metacharacters in package sources", () => {
		expect(() => parsePiInstallSource("npm:pi-teams;rm -rf /", process.cwd())).toThrow(/Invalid characters/);
	});
});

describe("Pi compatibility manifest normalization", () => {
	it("prefers OMP manifests but fills conventional Pi resource directories", async () => {
		const root = makeTempDir("omp-pi-manifest-");
		fs.mkdirSync(path.join(root, "skills"), { recursive: true });
		fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
		const result = await normalizePiCompatibleManifest(
			{
				version: "1.0.0",
				omp: { version: "ignored", extensions: ["omp-extension.ts"] },
				pi: { version: "ignored", extensions: ["pi-extension.ts"], skills: ["pi-skills"] },
			},
			root,
		);
		expect(result.source).toBe("omp");
		expect(result.manifest?.version).toBe("1.0.0");
		expect(result.manifest?.extensions).toEqual(["omp-extension.ts"]);
		expect(result.manifest?.skills).toEqual(["skills"]);
		expect(result.manifest?.prompts).toEqual(["prompts"]);
	});

	it("creates a manifest for packages with only conventional Pi directories", async () => {
		const root = makeTempDir("omp-pi-conventional-");
		fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
		fs.mkdirSync(path.join(root, "themes"), { recursive: true });
		const result = await normalizePiCompatibleManifest({ version: "2.0.0" }, root);
		expect(result.source).toBe("conventional");
		expect(result.manifest?.extensions).toEqual(["extensions"]);
		expect(result.manifest?.themes).toEqual(["themes"]);
	});
});

describe("Pi compatibility plugin resources", () => {
	let tempXdgDataHome = "";
	let originalXdgDataHome: string | undefined;
	const originalAgentDir = getAgentDir();

	beforeEach(() => {
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		tempXdgDataHome = makeTempDir("omp-pi-plugin-data-");
		fs.mkdirSync(path.join(tempXdgDataHome, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = tempXdgDataHome;
		setAgentDir(originalAgentDir);
	});

	afterEach(() => {
		fs.rmSync(tempXdgDataHome, { recursive: true, force: true });
		if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdgDataHome;
		setAgentDir(originalAgentDir);
	});

	it("resolves skills, prompts, and themes from Pi plugin manifests", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(getPluginsNodeModules(), "pi-fixture");
		writeJson(path.join(pluginsDir, "package.json"), {
			name: "omp-plugins",
			private: true,
			dependencies: { "pi-fixture": "1.0.0" },
		});
		writeJson(path.join(pluginDir, "package.json"), {
			name: "pi-fixture",
			version: "1.0.0",
			pi: {
				skills: ["skills"],
				prompts: ["prompts"],
				themes: ["themes"],
			},
		});
		fs.mkdirSync(path.join(pluginDir, "skills", "demo"), { recursive: true });
		fs.mkdirSync(path.join(pluginDir, "prompts"), { recursive: true });
		fs.mkdirSync(path.join(pluginDir, "themes"), { recursive: true });

		expect(await getAllPluginSkillPaths(process.cwd())).toEqual([path.join(pluginDir, "skills")]);
		expect(await getAllPluginPromptPaths(process.cwd())).toEqual([path.join(pluginDir, "prompts")]);
		expect(await getAllPluginThemePaths(process.cwd())).toEqual([path.join(pluginDir, "themes")]);
	});

	it("expands Pi extension directories to loadable entry files", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(getPluginsNodeModules(), "pi-dir-extension");
		writeJson(path.join(pluginsDir, "package.json"), {
			name: "omp-plugins",
			private: true,
			dependencies: { "pi-dir-extension": "1.0.0" },
		});
		writeJson(path.join(pluginDir, "package.json"), {
			name: "pi-dir-extension",
			version: "1.0.0",
			pi: { extensions: ["extensions"] },
		});
		fs.mkdirSync(path.join(pluginDir, "extensions", "teams"), { recursive: true });
		fs.writeFileSync(path.join(pluginDir, "extensions", "teams", "index.ts"), "export default () => {};\n");

		expect(await getAllPluginExtensionPaths(process.cwd())).toEqual([
			path.join(pluginDir, "extensions", "teams", "index.ts"),
		]);
	});

	it("loads direct SKILL.md entries from plugin manifests", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(getPluginsNodeModules(), "pi-direct-skill");
		const skillPath = path.join(pluginDir, "skills", "direct", "SKILL.md");
		writeJson(path.join(pluginsDir, "package.json"), {
			name: "omp-plugins",
			private: true,
			dependencies: { "pi-direct-skill": "1.0.0" },
		});
		writeJson(path.join(pluginDir, "package.json"), {
			name: "pi-direct-skill",
			version: "1.0.0",
			pi: { skills: ["skills/direct/SKILL.md"] },
		});
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, "---\nname: direct\ndescription: Direct skill\n---\nBody\n");

		const result = await loadCapability<Skill>(skillCapability.id, { providers: ["plugins"], cwd: process.cwd() });
		expect(result.items.map(skill => skill.name)).toEqual(["direct"]);
		expect(result.items[0]?.path).toBe(skillPath);
	});
});

describe("Pi compatibility shims and doctor", () => {
	let tempXdgDataHome = "";
	let originalXdgDataHome: string | undefined;
	const originalAgentDir = getAgentDir();

	beforeEach(() => {
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		tempXdgDataHome = makeTempDir("omp-pi-shim-data-");
		fs.mkdirSync(path.join(tempXdgDataHome, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = tempXdgDataHome;
		setAgentDir(originalAgentDir);
	});

	afterEach(() => {
		fs.rmSync(tempXdgDataHome, { recursive: true, force: true });
		if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdgDataHome;
		setAgentDir(originalAgentDir);
	});

	it("does not activate Pi compatibility environment for dry-run installs", async () => {
		const originalCompat = process.env.OMP_PI_COMPAT;
		const originalBridge = process.env.OMP_PI_COMPAT_BRIDGE;
		delete process.env.OMP_PI_COMPAT;
		delete process.env.OMP_PI_COMPAT_BRIDGE;
		try {
			const manager = new PluginManager(process.cwd());
			await manager.install("npm:pi-teams@0.9.14", { compatPi: true, dryRun: true });
			expect(process.env.OMP_PI_COMPAT).toBeUndefined();
			expect(process.env.OMP_PI_COMPAT_BRIDGE).toBeUndefined();
		} finally {
			if (originalCompat === undefined) delete process.env.OMP_PI_COMPAT;
			else process.env.OMP_PI_COMPAT = originalCompat;
			if (originalBridge === undefined) delete process.env.OMP_PI_COMPAT_BRIDGE;
			else process.env.OMP_PI_COMPAT_BRIDGE = originalBridge;
		}
	});

	it("sets Windows home variables for child-home bridge env", () => {
		const env = buildPiCompatEnv({
			baseEnv: {
				PATH: "/usr/bin",
				HOME: "/real-home",
				USERPROFILE: "C:\\Users\\real",
				HOMEDRIVE: "C:",
				HOMEPATH: "\\Users\\real",
			},
			bridgeMode: "child-home",
		});

		expect(env.HOME).toBe(getPiCompatHomeDir());
		expect(env.USERPROFILE).toBe(getPiCompatHomeDir());
		expect(env.HOMEDRIVE).not.toBe("C:");
		expect(env.HOMEPATH).not.toBe("\\Users\\real");
	});

	it("applies profiles for version-pinned npm package sources", () => {
		const source = parsePiInstallSource("npm:@tmustier/pi-agent-teams@0.5.4");
		const env = buildPiCompatEnv({
			baseEnv: { PATH: "/usr/bin" },
			bridgeMode: "profile",
			packageName: source.packageNameHint,
		});

		expect(source.packageNameHint).toBe("@tmustier/pi-agent-teams");
		expect(env.PI_TEAMS_ROOT_DIR).toBe(path.join(getAgentDir(), "teams"));
	});

	it("preserves selected bridge mode when loading extensions", async () => {
		const envSnapshot = snapshotProcessEnv([
			"HOME",
			"USERPROFILE",
			"HOMEDRIVE",
			"HOMEPATH",
			"PATH",
			"OMP_PI_COMPAT",
			"OMP_PI_COMPAT_HOME",
			"OMP_PI_COMPAT_BRIDGE",
			"PI_CODING_AGENT",
			"PI_CODING_AGENT_DIR",
			"PI_PACKAGE_DIR",
		]);
		const extensionDir = makeTempDir("omp-pi-extension-bridge-");
		const extensionPath = path.join(extensionDir, "extension.ts");
		fs.writeFileSync(extensionPath, "export default function() {}\n");
		process.env.OMP_PI_COMPAT_BRIDGE = "child-home";
		try {
			const result = await loadExtensions([extensionPath], process.cwd());

			expect(result.errors).toHaveLength(0);
			expect(process.env.OMP_PI_COMPAT_BRIDGE).toBe("child-home");
			expect(process.env.HOME).toBe(getPiCompatHomeDir());
		} finally {
			fs.rmSync(extensionDir, { recursive: true, force: true });
			restoreProcessEnv(envSnapshot);
		}
	});

	it("preserves selected bridge mode when loading custom tools", async () => {
		const envSnapshot = snapshotProcessEnv([
			"HOME",
			"USERPROFILE",
			"HOMEDRIVE",
			"HOMEPATH",
			"PATH",
			"OMP_PI_COMPAT",
			"OMP_PI_COMPAT_HOME",
			"OMP_PI_COMPAT_BRIDGE",
			"PI_CODING_AGENT",
			"PI_CODING_AGENT_DIR",
			"PI_PACKAGE_DIR",
		]);
		const toolDir = makeTempDir("omp-pi-tool-bridge-");
		const toolPath = path.join(toolDir, "tool.ts");
		fs.writeFileSync(
			toolPath,
			[
				"export default function(api) {",
				"  return {",
				'    name: "bridge_tool",',
				'    label: "Bridge Tool",',
				'    description: "Checks bridge activation",',
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() {",
				'      return { content: [{ type: "text", text: "ok" }] };',
				"    },",
				"  };",
				"}",
			].join("\n"),
		);
		process.env.OMP_PI_COMPAT_BRIDGE = "child-home";
		try {
			const result = await loadCustomTools([{ path: toolPath }], process.cwd(), []);

			expect(result.errors).toHaveLength(0);
			expect(result.tools).toHaveLength(1);
			expect(process.env.OMP_PI_COMPAT_BRIDGE).toBe("child-home");
			expect(process.env.HOME).toBe(getPiCompatHomeDir());
		} finally {
			fs.rmSync(toolDir, { recursive: true, force: true });
			restoreProcessEnv(envSnapshot);
		}
	});

	it("generates scoped pi executable and import alias shims", async () => {
		const shim = await ensurePiCliShim();
		expect(fs.existsSync(shim.shimPath)).toBe(true);
		expect(fs.readFileSync(shim.shimPath, "utf8")).toContain("exec omp");

		await ensurePiCompatImportShims();
		expect(fs.existsSync(path.join(getPluginsNodeModules(), "@mariozechner", "pi-coding-agent", "index.ts"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(getPluginsNodeModules(), "typebox", "compile.ts"))).toBe(true);
		expect(fs.existsSync(path.join(getPluginsNodeModules(), "@sinclair", "typebox", "compiler.ts"))).toBe(true);
		expect(fs.readFileSync(path.join(getPluginsNodeModules(), "typebox", "compile.ts"), "utf8")).toContain("file://");
	});

	it("refuses symlink bridge when .pi already exists", async () => {
		const home = makeTempDir("omp-pi-home-");
		fs.mkdirSync(path.join(home, ".pi"));
		const plan = await planPiHomeSymlinkBridge(home);
		expect(plan.mode).toBe("refuse-existing");
	});

	it("classifies known remote Pi package profiles without installing them", async () => {
		const report = await doctorPiCompatTarget("npm:pi-teams@0.9.14");

		expect(report.packageName).toBe("pi-teams");
		expect(report.tier).toBe(3);
		expect(report.recommendedBridgeMode).toBe("child-home");
		expect(report.findings.map(finding => finding.code)).toContain("pi_cli_shim");
		expect(report.findings.map(finding => finding.code)).toContain("legacy_pi_paths");
	});

	it("classifies local packages that import Pi APIs, spawn pi, and use legacy paths", async () => {
		const packageDir = makeTempDir("omp-pi-doctor-");
		writeJson(path.join(packageDir, "package.json"), {
			name: "doctor-fixture",
			version: "1.0.0",
			pi: { extensions: ["extension.ts"], skills: ["skills"] },
		});
		fs.writeFileSync(
			path.join(packageDir, "extension.ts"),
			[
				'import { Type } from "@mariozechner/pi-coding-agent";',
				'import { spawnSync } from "node:child_process";',
				'import * as os from "node:os";',
				'spawnSync("pi", ["--list-models"]);',
				'const legacy = os.homedir() + "/.pi/tasks";',
				"process.env.PI_TEAMS_ROOT_DIR = legacy;",
			].join("\n"),
		);
		const report = await doctorPiCompatTarget(packageDir);
		expect(report.tier).toBe(3);
		expect(report.findings.map(finding => finding.code)).toContain("pi_import_aliases");
		expect(report.findings.map(finding => finding.code)).toContain("pi_cli_shim");
		expect(report.findings.map(finding => finding.code)).toContain("legacy_pi_paths");
	});
});
