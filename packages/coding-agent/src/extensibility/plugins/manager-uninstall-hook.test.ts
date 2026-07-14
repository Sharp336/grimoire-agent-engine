import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ORIGINAL_ENV = {
	HOME: process.env.HOME,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	OMP_PROFILE: process.env.OMP_PROFILE,
	PI_PROFILE: process.env.PI_PROFILE,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

test("PluginManager.uninstall runs lifecycle hook before removing package", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omp-plugin-uninstall-hook-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	const markerPath = path.join(root, "uninstall-hook.json");
	const pluginName = "hooked-plugin";

	process.env.HOME = root;
	process.env.XDG_DATA_HOME = path.join(root, "xdg-data");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;

	// Test changes environment before loading dir singletons; static imports would snapshot the wrong roots.
	const dirs = await import("@oh-my-pi/pi-utils/dirs");
	dirs.__resetDirsFromEnvForTests();

	try {
		// Test intentionally loads the manager after resetting plugin roots.
		const { PluginManager } = await import("./manager");
		const pluginsDir = dirs.getPluginsDir();
		const pluginPath = path.join(dirs.getPluginsNodeModules(), pluginName);
		await mkdir(pluginPath, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			path.join(pluginPath, "package.json"),
			JSON.stringify({
				name: pluginName,
				version: "1.0.0",
				type: "module",
				omp: { version: "1.0.0", lifecycle: { uninstall: "./uninstall.mjs" } },
			}),
		);
		await writeFile(
			path.join(pluginPath, "uninstall.mjs"),
			`import { access, writeFile } from "node:fs/promises";\nexport async function uninstall(ctx) {\n  await access(ctx.pluginPath + "/package.json");\n  await writeFile(${JSON.stringify(markerPath)}, JSON.stringify(ctx));\n}\n`,
		);
		await mkdir(pluginsDir, { recursive: true });
		await writeFile(
			dirs.getPluginsPackageJson(),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: { [pluginName]: "file:node_modules/hooked-plugin" },
			}),
		);

		const manager = new PluginManager(projectDir);
		await manager.uninstall(pluginName);

		const hookContext = JSON.parse(await readFile(markerPath, "utf8"));
		assert.equal(hookContext.cwd, projectDir);
		assert.equal(hookContext.agentDir, agentDir);
		assert.equal(hookContext.pluginPath, pluginPath);
		await access(markerPath);
	} finally {
		restoreEnv();
		dirs.__resetDirsFromEnvForTests();
		await rm(root, { recursive: true, force: true });
	}
});
