import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAdapter } from "@oh-my-pi/pi-coding-agent/dap/config";

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
			expect(adapter?.childSessionTypes).toContain("pwa-*");
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

	it("does not require Neovim Mason XDG data paths", async () => {
		const previousServerPath = process.env.JS_DEBUG_DAP_SERVER;
		const previousXdgDataHome = process.env.XDG_DATA_HOME;
		const previousXdgDataDirs = process.env.XDG_DATA_DIRS;
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-config-no-mason-"));
		try {
			delete process.env.JS_DEBUG_DAP_SERVER;
			await Bun.write(path.join(cwd, "package.json"), "{}");
			const binDir = path.join(cwd, "node_modules", ".bin");
			await fs.mkdir(binDir, { recursive: true });
			await writeExecutable(path.join(binDir, "node"));
			await writeExecutable(path.join(binDir, "js-debug-adapter"));
			process.env.XDG_DATA_HOME = path.join(cwd, "xdg-data");
			process.env.XDG_DATA_DIRS = path.join(cwd, "xdg-system-data");
			await Bun.write(
				path.join(
					process.env.XDG_DATA_HOME,
					"nvim",
					"mason",
					"packages",
					"js-debug-adapter",
					"js-debug",
					"src",
					"dapDebugServer.js",
				),
				"",
			);

			const adapter = resolveAdapter("js-debug-adapter", cwd);

			expect(adapter).toBeNull();
		} finally {
			restoreEnv("JS_DEBUG_DAP_SERVER", previousServerPath);
			restoreEnv("XDG_DATA_HOME", previousXdgDataHome);
			restoreEnv("XDG_DATA_DIRS", previousXdgDataDirs);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
