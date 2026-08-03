import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("plugin config", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let lockfile: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-config-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		lockfile = path.join(pluginsDir, "omp-plugins.lock.json");

		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile);
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		mock.restore();
		await removeWithRetries(tmpRoot);
	});

	async function writeLegacyLockfile(pluginName: string): Promise<void> {
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: {
					[pluginName]: { version: "0.2.2", enabledFeatures: null, enabled: true },
				},
			}),
		);
	}

	test("set initializes missing settings in legacy runtime config", async () => {
		const pluginName = "@gaodes/pi-graphify";
		await writeLegacyLockfile(pluginName);

		await new PluginManager(tmpRoot).setPluginSetting(pluginName, "autoContext.enabled", true);

		const lock = await Bun.file(lockfile).json();
		expect(lock.settings[pluginName]).toEqual({ "autoContext.enabled": true });
		expect(lock.plugins[pluginName]).toEqual({ version: "0.2.2", enabledFeatures: null, enabled: true });
	});

	test("list treats missing settings in legacy runtime config as empty", async () => {
		const pluginName = "@gaodes/pi-graphify";
		await writeLegacyLockfile(pluginName);

		await expect(new PluginManager(tmpRoot).getPluginSettings(pluginName)).resolves.toEqual({});
	});

	test("re-enabling from a project UI clears the project-disabled override", async () => {
		const pluginName = "@gaodes/pi-graphify";
		const overridesPath = path.join(tmpRoot, "plugin-overrides.json");
		await writeLegacyLockfile(pluginName);
		await Bun.write(
			overridesPath,
			JSON.stringify({
				disabled: [pluginName, "other-plugin"],
				features: { [pluginName]: ["inspect"] },
			}),
		);

		await new PluginManager(tmpRoot).setEnabled(pluginName, true, { clearProjectDisabled: true });

		const overrides = await Bun.file(overridesPath).json();
		expect(overrides).toEqual({
			disabled: ["other-plugin"],
			features: { [pluginName]: ["inspect"] },
		});
		const lock = await Bun.file(lockfile).json();
		expect(lock.plugins[pluginName].enabled).toBe(true);
	});

	test("re-enabling clears the override from the discovered legacy config dir", async () => {
		const pluginName = "@gaodes/pi-graphify";
		const legacyOverridesPath = path.join(tmpRoot, ".claude", "plugin-overrides.json");
		await writeLegacyLockfile(pluginName);
		await fs.mkdir(path.dirname(legacyOverridesPath), { recursive: true });
		await Bun.write(legacyOverridesPath, JSON.stringify({ disabled: [pluginName] }));

		await new PluginManager(tmpRoot).setEnabled(pluginName, true, { clearProjectDisabled: true });

		// The override is removed from the file the runtime loader reads...
		await expect(Bun.file(legacyOverridesPath).json()).resolves.toEqual({});
		// ...and no unrelated override file is created elsewhere.
		expect(await Bun.file(path.join(tmpRoot, ".omp", "plugin-overrides.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(tmpRoot, "plugin-overrides.json")).exists()).toBe(false);
	});

	test("re-enabling honors loader precedence when multiple override files exist", async () => {
		const pluginName = "@gaodes/pi-graphify";
		const canonicalOverridesPath = path.join(tmpRoot, ".omp", "plugin-overrides.json");
		const legacyOverridesPath = path.join(tmpRoot, ".claude", "plugin-overrides.json");
		await writeLegacyLockfile(pluginName);
		await fs.mkdir(path.dirname(canonicalOverridesPath), { recursive: true });
		await fs.mkdir(path.dirname(legacyOverridesPath), { recursive: true });
		await Bun.write(canonicalOverridesPath, JSON.stringify({ disabled: [pluginName] }));
		await Bun.write(legacyOverridesPath, JSON.stringify({ disabled: [pluginName] }));

		await new PluginManager(tmpRoot).setEnabled(pluginName, true, { clearProjectDisabled: true });

		// Only the highest-precedence file — the one the loader reads — is mutated.
		await expect(Bun.file(canonicalOverridesPath).json()).resolves.toEqual({});
		await expect(Bun.file(legacyOverridesPath).json()).resolves.toEqual({ disabled: [pluginName] });
	});
	test("marketplace state applies project overrides to the runtime package name", async () => {
		const installPath = path.join(tmpRoot, "marketplace-plugin");
		await fs.mkdir(installPath, { recursive: true });
		await Bun.write(path.join(installPath, "package.json"), JSON.stringify({ name: "@scope/runtime-plugin" }));
		await Bun.write(
			path.join(tmpRoot, "plugin-overrides.json"),
			JSON.stringify({ disabled: ["@scope/runtime-plugin"] }),
		);

		const manager = new PluginManager(tmpRoot);
		await expect(
			manager.getMarketplaceEffectiveState("catalog-name@test-marketplace", installPath, true),
		).resolves.toEqual({
			packageName: "@scope/runtime-plugin",
			enabled: false,
		});

		await manager.clearProjectDisabledOverride("@scope/runtime-plugin");
		await expect(
			manager.getMarketplaceEffectiveState("catalog-name@test-marketplace", installPath, true),
		).resolves.toEqual({
			packageName: "@scope/runtime-plugin",
			enabled: true,
		});
	});

	test("marketplace aggregate state and override cleanup include every registry entry", async () => {
		const firstInstallPath = path.join(tmpRoot, "marketplace-plugin-user");
		const secondInstallPath = path.join(tmpRoot, "marketplace-plugin-project");
		await fs.mkdir(firstInstallPath, { recursive: true });
		await fs.mkdir(secondInstallPath, { recursive: true });
		await Bun.write(path.join(firstInstallPath, "package.json"), JSON.stringify({ name: "@scope/runtime-user" }));
		await Bun.write(path.join(secondInstallPath, "package.json"), JSON.stringify({ name: "@scope/runtime-project" }));
		await Bun.write(
			path.join(tmpRoot, "plugin-overrides.json"),
			JSON.stringify({ disabled: ["@scope/runtime-project", "other-plugin"] }),
		);
		const entries = [
			{
				scope: "user" as const,
				installPath: firstInstallPath,
				version: "1.0.0",
				installedAt: "2026-07-29T00:00:00.000Z",
				lastUpdated: "2026-07-29T00:00:00.000Z",
				enabled: true,
			},
			{
				scope: "project" as const,
				installPath: secondInstallPath,
				version: "1.0.0",
				installedAt: "2026-07-29T00:00:00.000Z",
				lastUpdated: "2026-07-29T00:00:00.000Z",
				enabled: true,
			},
		];
		const manager = new PluginManager(tmpRoot);

		await expect(
			manager.getMarketplaceAggregateEffectiveState("catalog-name@test-marketplace", entries),
		).resolves.toEqual({
			packageNames: ["@scope/runtime-user", "@scope/runtime-project"],
			enabled: false,
		});

		await manager.clearProjectDisabledOverrides(["@scope/runtime-user", "@scope/runtime-project"]);
		await expect(Bun.file(path.join(tmpRoot, "plugin-overrides.json")).json()).resolves.toEqual({
			disabled: ["other-plugin"],
		});
		await expect(
			manager.getMarketplaceAggregateEffectiveState("catalog-name@test-marketplace", entries),
		).resolves.toEqual({
			packageNames: ["@scope/runtime-user", "@scope/runtime-project"],
			enabled: true,
		});
	});
});
