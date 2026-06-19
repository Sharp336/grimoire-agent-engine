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
			const serverPath = path.join(cwd, "node_modules", "js-debug-adapter", "js-debug", "src", "dapDebugServer.js");
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
});
