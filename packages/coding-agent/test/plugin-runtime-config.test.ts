/**
 * Contract tests for the strict `readPluginRuntimeConfig` helper and the
 * production loader's delegation to it. Malformed/unreadable lockfiles must
 * surface; ENOENT remains the only silent empty-config case.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins, getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import {
	normalizePluginRuntimeConfig,
	readPluginRuntimeConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/runtime-config";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterEach(async () => {
	clearClaudePluginRootsCache();
	mock.restore();
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function makeTempRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

describe("readPluginRuntimeConfig", () => {
	test("missing lockfile returns empty normalized config", async () => {
		const root = await makeTempRoot("omp-plugin-runtime-missing-");
		const lockPath = path.join(root, "omp-plugins.lock.json");

		await expect(readPluginRuntimeConfig(lockPath)).resolves.toEqual(normalizePluginRuntimeConfig({}));
	});

	test("valid lockfile returns normalized plugins and settings", async () => {
		const root = await makeTempRoot("omp-plugin-runtime-valid-");
		const lockPath = path.join(root, "omp-plugins.lock.json");
		await Bun.write(
			lockPath,
			JSON.stringify({
				plugins: {
					"demo-plugin": { version: "1.2.3", enabled: true, enabledFeatures: null },
				},
				settings: {
					"demo-plugin": { "autoContext.enabled": true },
				},
			}),
		);

		await expect(readPluginRuntimeConfig(lockPath)).resolves.toEqual({
			plugins: {
				"demo-plugin": { version: "1.2.3", enabled: true, enabledFeatures: null },
			},
			settings: {
				"demo-plugin": { "autoContext.enabled": true },
			},
		});
	});

	test("legacy lockfile without settings is normalized", async () => {
		const root = await makeTempRoot("omp-plugin-runtime-legacy-");
		const lockPath = path.join(root, "omp-plugins.lock.json");
		await Bun.write(
			lockPath,
			JSON.stringify({
				plugins: {
					"@scope/legacy": { version: "0.1.0", enabled: true, enabledFeatures: null },
				},
			}),
		);

		await expect(readPluginRuntimeConfig(lockPath)).resolves.toEqual({
			plugins: {
				"@scope/legacy": { version: "0.1.0", enabled: true, enabledFeatures: null },
			},
			settings: {},
		});
	});

	test("malformed JSON rethrows", async () => {
		const root = await makeTempRoot("omp-plugin-runtime-malformed-");
		const lockPath = path.join(root, "omp-plugins.lock.json");
		await Bun.write(lockPath, "{ not-json");

		await expect(readPluginRuntimeConfig(lockPath)).rejects.toThrow();
	});

	test("unreadable lockfile rethrows", async () => {
		// root bypasses Unix file permissions, so this cannot exercise EACCES.
		if (process.getuid?.() === 0) return;

		const root = await makeTempRoot("omp-plugin-runtime-unreadable-");
		const lockPath = path.join(root, "omp-plugins.lock.json");
		await Bun.write(lockPath, JSON.stringify({ plugins: {}, settings: {} }));
		await fs.chmod(lockPath, 0o000);
		try {
			await expect(readPluginRuntimeConfig(lockPath)).rejects.toThrow();
		} finally {
			await fs.chmod(lockPath, 0o644);
		}
	});
});

describe("plugin loader strict lockfile contract", () => {
	test("getPluginSettings rethrows when the runtime lockfile is malformed", async () => {
		const root = await makeTempRoot("omp-plugin-loader-settings-");
		const pluginsDir = path.join(root, "plugins");
		const lockfile = path.join(pluginsDir, "omp-plugins.lock.json");
		await fs.mkdir(pluginsDir, { recursive: true });
		await Bun.write(lockfile, "{ broken");

		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile);
		spyOn(piUtils, "getProjectDir").mockReturnValue(root);

		await expect(getPluginSettings("demo-plugin", root)).rejects.toThrow();
	});

	test("getEnabledPlugins rethrows when a plugins-root lockfile is malformed", async () => {
		const root = await makeTempRoot("omp-plugin-loader-enabled-");
		const home = path.join(root, "home");
		const cwd = path.join(root, "project");
		const pluginsDir = path.join(home, ".omp", "plugins");
		await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(pluginsDir, "omp-plugins.lock.json"), "{ broken");

		await expect(getEnabledPlugins(cwd, { home })).rejects.toThrow();
	});
});
