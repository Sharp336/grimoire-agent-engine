import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandIsRoutable, operationCapabilities } from "@oh-my-pi/appserver";
import { Settings } from "../src/config/settings.ts";
import { createAppserverRuntime } from "../src/session/appserver-authority.ts";

describe("coding-agent appserver config capabilities", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	test("routes validated settings writes without claiming the unsupported config.write command", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-appserver-config-capabilities-"));
		dirs.push(root);
		const runtime = createAppserverRuntime({
			sessionsDir: path.join(root, "sessions"),
			lifecycleMetadataPath: path.join(root, "lifecycle.json"),
			settings: Settings.isolated(),
		});

		expect(commandIsRoutable(runtime.operationsAuthority, "settings.read")).toBe(true);
		expect(commandIsRoutable(runtime.operationsAuthority, "settings.write")).toBe(true);
		expect(commandIsRoutable(runtime.operationsAuthority, "config.write")).toBe(false);
		expect(runtime.operationsAuthority.configWrite).toBeUndefined();
		// config.write is the protocol's shared mutation capability for the
		// implemented settings.write command; routability remains command-specific.
		expect(operationCapabilities(runtime.operationsAuthority)).toContain("config.write");
	});
});
