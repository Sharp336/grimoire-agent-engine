import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAllPluginAdvisorPaths,
	resolvePluginAdvisorManifestEntries,
	resolvePluginAdvisorPaths,
	resolvePluginExtensionPaths,
	resolvePluginToolPaths,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import type { InstalledPlugin, PluginManifest } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function makePlugin(pluginPath: string, manifest: PluginManifest): InstalledPlugin {
	return {
		name: "fixture-plugin",
		version: "1.0.0",
		path: pluginPath,
		manifest,
		enabledFeatures: null,
		enabled: true,
	};
}

describe("plugin manifest path resolution", () => {
	it("resolves a directory tools entry to its index, not the omp.extensions modules", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-manifest-paths-"));
		try {
			// The package declares both extensions and a directory-based tool entry.
			// `omp.extensions` and the sub-extension scan are extensions-specific and
			// must not hijack the `tools: "."` directory entry (regression: the shared
			// directory resolver returned the extension module for every key).
			fs.writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "fixture-plugin", version: "1.0.0", omp: { extensions: ["./ext.ts"], tools: "." } }),
			);
			fs.writeFileSync(path.join(dir, "index.ts"), "export default {};");
			fs.writeFileSync(path.join(dir, "ext.ts"), "export default function () {};");
			const plugin = makePlugin(dir, {
				name: "fixture-plugin",
				version: "1.0.0",
				extensions: ["./ext.ts"],
				tools: ".",
			});

			expect(resolvePluginToolPaths(plugin)).toEqual([path.join(dir, "index.ts")]);
			expect(resolvePluginExtensionPaths(plugin)).toEqual([path.join(dir, "ext.ts")]);
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	it("resolves only advisor files contained by the plugin root", () => {
		// macOS exposes os.tmpdir() through /var, while realpath resolves it under /private/var.
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-manifest-advisors-")));
		const pluginDir = path.join(root, "plugin");
		try {
			fs.mkdirSync(pluginDir);
			const advisorFile = path.join(pluginDir, "WATCHDOG.yml");
			const outsideFile = path.join(root, "outside.yml");
			fs.writeFileSync(advisorFile, "advisors: []\n");
			fs.writeFileSync(outsideFile, "advisors: []\n");
			const advisorEntries = ["./WATCHDOG.yml", "../outside.yml"];
			if (process.platform !== "win32") {
				fs.symlinkSync(outsideFile, path.join(pluginDir, "linked.yml"));
				advisorEntries.push("./linked.yml");
			}
			advisorEntries.push(42 as never);
			const plugin = makePlugin(pluginDir, {
				name: "fixture-plugin",
				version: "1.0.0",
				advisors: advisorEntries,
			});

			expect(resolvePluginAdvisorPaths(plugin)).toEqual([advisorFile]);
		} finally {
			removeSyncWithRetries(root);
		}
	});
	it("marks a non-array advisor manifest as invalid instead of silently ignoring it", () => {
		const plugin = makePlugin(process.cwd(), {
			name: "fixture-plugin",
			version: "1.0.0",
			advisors: "./WATCHDOG.yml" as never,
		});

		expect(resolvePluginAdvisorManifestEntries(plugin)).toEqual([{ entry: "./WATCHDOG.yml", resolvedPath: null }]);
	});

	it("discovers advisor files from enabled plugins without reading the process home", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-installed-advisors-")));
		try {
			const home = path.join(root, "home");
			const cwd = path.join(root, "project");
			const pluginsDir = path.join(home, ".omp", "plugins");
			const pluginDir = path.join(pluginsDir, "node_modules", "fixture-plugin");
			fs.mkdirSync(pluginDir, { recursive: true });
			fs.mkdirSync(cwd, { recursive: true });
			fs.writeFileSync(
				path.join(pluginsDir, "package.json"),
				JSON.stringify({ name: "omp-plugins", dependencies: { "fixture-plugin": "1.0.0" } }),
			);
			fs.writeFileSync(
				path.join(pluginDir, "package.json"),
				JSON.stringify({
					name: "fixture-plugin",
					version: "1.0.0",
					omp: { advisors: ["./WATCHDOG.yml"] },
				}),
			);
			const advisorFile = path.join(pluginDir, "WATCHDOG.yml");
			fs.writeFileSync(advisorFile, "advisors: []\n");

			expect(await getAllPluginAdvisorPaths(cwd, { home })).toEqual([advisorFile]);
		} finally {
			removeSyncWithRetries(root);
		}
	});
});
