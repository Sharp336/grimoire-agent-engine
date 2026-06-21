import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAdapter, selectAttachAdapter, selectLaunchAdapter } from "@oh-my-pi/pi-coding-agent/dap/config";

const DAP_PORT_ARGUMENT = "$" + "{port}";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true, writable: true });
}

async function writeExecutable(filePath: string): Promise<void> {
	await Bun.write(filePath, "#!/bin/sh\nexit 0\n");
	await fs.chmod(filePath, 0o755);
}

describe("DAP adapter config resolution", () => {
	it("resolves bundled Bun adapter through the CLI worker entry", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-bun-"));
		try {
			const adapter = resolveAdapter("bun", cwd);

			expect(adapter?.command).toBe("omp");
			expect(adapter?.resolvedCommand).toBe(process.execPath);
			expect(adapter?.args.at(-1)).toBe("__omp_worker_bun_dap");
			expect(adapter?.connectMode).toBe("stdio");
			expect(adapter?.debugConfigTypes).toContain("bun");
			expect(adapter?.launchDefaults).toMatchObject({ request: "launch", type: "bun" });
			expect(adapter?.attachDefaults).toMatchObject({ request: "attach", type: "bun" });
			expect(adapter?.requiresRootMarkerForAutoSelect).toBe(true);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("auto-selects Bun only under Bun root markers", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-bun-select-"));
		try {
			const program = path.join(cwd, "app.ts");
			await Bun.write(program, "console.log('ok');\n");

			expect(selectLaunchAdapter(program, cwd)?.name).not.toBe("bun");

			await Bun.write(path.join(cwd, "bun.lock"), "");
			expect(selectLaunchAdapter(program, cwd)?.name).toBe("bun");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("routes Bun inspector URL attaches to the Bun adapter", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-bun-attach-"));
		try {
			const adapter = selectAttachAdapter(cwd, undefined, undefined, "ws://127.0.0.1:6499/test");

			expect(adapter?.name).toBe("bun");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("uses an explicit js-debug server path without requiring the adapter wrapper", async () => {
		const previousServerPath = process.env.JS_DEBUG_DAP_SERVER;
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-env-"));
		try {
			await Bun.write(path.join(cwd, "package.json"), "{}");
			await fs.mkdir(path.join(cwd, "node_modules", ".bin"), { recursive: true });
			const nodePath = path.join(cwd, "node_modules", ".bin", "node");
			await writeExecutable(nodePath);
			const serverPath = path.join(cwd, "dapDebugServer.js");
			await Bun.write(serverPath, "");
			process.env.JS_DEBUG_DAP_SERVER = serverPath;

			const adapter = resolveAdapter("js-debug-adapter", cwd);

			expect(adapter?.command).toBe("node");
			expect(adapter?.resolvedCommand).toBe(nodePath);
			expect(adapter?.connectMode).toBe("tcp");
			expect(adapter?.args).toEqual([serverPath, DAP_PORT_ARGUMENT, "127.0.0.1"]);
			expect(adapter?.debugConfigTypes).toContain("pwa-*");
			expect(adapter?.threadlessContinueNeedsChildStopWait).toBe(true);
		} finally {
			restoreEnv("JS_DEBUG_DAP_SERVER", previousServerPath);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("discovers js-debug server entrypoints from the resolved adapter package", async () => {
		const previousServerPath = process.env.JS_DEBUG_DAP_SERVER;
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-package-"));
		try {
			delete process.env.JS_DEBUG_DAP_SERVER;
			await Bun.write(path.join(cwd, "package.json"), "{}");
			const binDir = path.join(cwd, "node_modules", ".bin");
			await fs.mkdir(binDir, { recursive: true });
			const nodePath = path.join(binDir, "node");
			const adapterCommandPath = path.join(binDir, "js-debug-adapter");
			await writeExecutable(nodePath);
			await writeExecutable(adapterCommandPath);
			const serverPath = path.join(cwd, "node_modules", "js-debug-adapter", "dist", "src", "dapDebugServer.js");
			await Bun.write(serverPath, "");

			const adapter = resolveAdapter("js-debug-adapter", cwd);

			expect(adapter?.command).toBe("node");
			expect(adapter?.resolvedCommand).toBe(nodePath);
			expect(adapter?.connectMode).toBe("tcp");
			expect(adapter?.args).toEqual([serverPath, DAP_PORT_ARGUMENT, "127.0.0.1"]);
		} finally {
			restoreEnv("JS_DEBUG_DAP_SERVER", previousServerPath);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("discovers js-debug server entrypoints from the adapter launcher script", async () => {
		const previousServerPath = process.env.JS_DEBUG_DAP_SERVER;
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-launcher-"));
		try {
			delete process.env.JS_DEBUG_DAP_SERVER;
			await Bun.write(path.join(cwd, "package.json"), "{}");
			const binDir = path.join(cwd, "node_modules", ".bin");
			await fs.mkdir(binDir, { recursive: true });
			const nodePath = path.join(binDir, "node");
			const adapterCommandPath = path.join(binDir, "js-debug-adapter");
			await writeExecutable(nodePath);
			const serverPath = path.join(cwd, "tools", "debuggers", "js", "js-debug", "src", "dapDebugServer.js");
			await Bun.write(serverPath, "");
			await Bun.write(
				adapterCommandPath,
				'#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../../tools/debuggers/js/js-debug/src/dapDebugServer.js" "$@"\n',
			);
			await fs.chmod(adapterCommandPath, 0o755);

			const adapter = resolveAdapter("js-debug-adapter", cwd);

			expect(adapter?.command).toBe("node");
			expect(adapter?.resolvedCommand).toBe(nodePath);
			expect(adapter?.args).toEqual([serverPath, DAP_PORT_ARGUMENT, "127.0.0.1"]);
		} finally {
			restoreEnv("JS_DEBUG_DAP_SERVER", previousServerPath);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("discovers js-debug server entrypoints from Windows command shims", async () => {
		const previousServerPath = process.env.JS_DEBUG_DAP_SERVER;
		const previousPlatform = process.platform;
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-win-shim-"));
		try {
			delete process.env.JS_DEBUG_DAP_SERVER;
			await Bun.write(path.join(cwd, "package.json"), "{}");
			const binDir = path.join(cwd, "node_modules", ".bin");
			await fs.mkdir(binDir, { recursive: true });
			const nodePath = path.join(binDir, "node.cmd");
			const adapterCommandPath = path.join(binDir, "js-debug-adapter.cmd");
			await Bun.write(nodePath, "");
			const serverPath = path.join(
				cwd,
				"node_modules",
				"debuggers",
				"js-debug",
				"js-debug",
				"src",
				"dapDebugServer.js",
			);
			await Bun.write(serverPath, "");
			await Bun.write(
				adapterCommandPath,
				'@"%~dp0\\node.exe" "%~dp0\\..\\debuggers\\js-debug\\js-debug\\src\\dapDebugServer.js" %*\n',
			);
			setPlatform("win32");

			const adapter = resolveAdapter("js-debug-adapter", cwd);

			expect(adapter?.command).toBe("node");
			expect(adapter?.resolvedCommand).toBe(nodePath);
			expect(adapter?.args).toEqual([serverPath, DAP_PORT_ARGUMENT, "127.0.0.1"]);
		} finally {
			setPlatform(previousPlatform);
			restoreEnv("JS_DEBUG_DAP_SERVER", previousServerPath);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("discovers js-debug server entrypoints from default XDG Mason packages without the adapter wrapper", async () => {
		const previousServerPath = process.env.JS_DEBUG_DAP_SERVER;
		const previousXdgDataHome = process.env.XDG_DATA_HOME;
		const previousXdgDataDirs = process.env.XDG_DATA_DIRS;
		const previousHome = process.env.HOME;
		const previousPath = process.env.PATH;
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-default-xdg-mason-"));
		try {
			delete process.env.JS_DEBUG_DAP_SERVER;
			delete process.env.XDG_DATA_HOME;
			process.env.XDG_DATA_DIRS = path.join(cwd, "xdg-system-data");
			process.env.HOME = cwd;
			process.env.PATH = "";
			await Bun.write(path.join(cwd, "package.json"), "{}");
			const binDir = path.join(cwd, "node_modules", ".bin");
			await fs.mkdir(binDir, { recursive: true });
			const nodePath = path.join(binDir, "node");
			await writeExecutable(nodePath);
			const serverPath = path.join(
				cwd,
				".local",
				"share",
				"nvim",
				"mason",
				"packages",
				"js-debug-adapter",
				"js-debug",
				"src",
				"dapDebugServer.js",
			);
			await Bun.write(serverPath, "");

			const adapter = resolveAdapter("js-debug-adapter", cwd);

			expect(adapter?.command).toBe("node");
			expect(adapter?.resolvedCommand).toBe(nodePath);
			expect(adapter?.connectMode).toBe("tcp");
			expect(adapter?.args).toEqual([serverPath, DAP_PORT_ARGUMENT, "127.0.0.1"]);
		} finally {
			restoreEnv("JS_DEBUG_DAP_SERVER", previousServerPath);
			restoreEnv("XDG_DATA_HOME", previousXdgDataHome);
			restoreEnv("XDG_DATA_DIRS", previousXdgDataDirs);
			restoreEnv("HOME", previousHome);
			restoreEnv("PATH", previousPath);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
