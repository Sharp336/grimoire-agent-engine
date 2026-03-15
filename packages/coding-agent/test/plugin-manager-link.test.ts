import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";

describe("PluginManager.link", () => {
	it("rejects local paths that resolve outside the working directory", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "omp-plugin-link-cwd-"));
		const outside = mkdtempSync(path.join(tmpdir(), "omp-plugin-link-outside-"));
		const pluginDir = path.join(outside, "demo-plugin");
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "demo-plugin", version: "1.0.0" }),
		);

		const manager = new PluginManager(cwd);
		await expect(manager.link(path.relative(cwd, pluginDir))).rejects.toThrow(
			"resolves outside working directory",
		);
	});
});
