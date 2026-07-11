import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsManager } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Legacy pi extensions (e.g. pi-vim) call `SettingsManager.create(cwd)`
// synchronously and immediately read `getGlobalSettings()`/`getProjectSettings()`
// off the result — upstream Pi's `SettingsManager` is sync and exposes those
// accessors returning the raw settings layers, including arbitrary
// extension-namespaced keys (like `piVim`) that the typed `get(path)` API
// cannot reach. Before this fix the shim returned a `Promise<Settings>` with no
// such accessors, so `s.getGlobalSettings is not a function` crashed the
// extension's session_start handler and vim mode never installed. These tests
// pin the sync-return + raw-layer-accessor contract through the public
// package specifier.

describe("SettingsManager legacy pi-compat accessors", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settingsmanager-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Bun.sleep(0);
		await tempDir?.remove();
	});

	it("create(cwd) returns synchronously with getGlobalSettings/getProjectSettings and reads namespaced keys", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ piVim: { modeColors: { normal: "blue" } } }, null, 2),
		);
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "settings.json"),
			JSON.stringify({ piVim: { modeColors: { insert: "green" } } }),
		);

		await Settings.init({ cwd: projectDir, agentDir });

		// The plugin does `const s = SettingsManager.create(cwd)` and then reads
		// accessors on the same tick — the result must NOT be a Promise.
		const manager = SettingsManager.create(projectDir);
		expect(manager).not.toBeInstanceOf(Promise);
		expect(typeof manager.getGlobalSettings).toBe("function");
		expect(typeof manager.getProjectSettings).toBe("function");

		// Arbitrary extension-namespaced keys are visible through the raw layers.
		expect(manager.getGlobalSettings().piVim).toEqual({ modeColors: { normal: "blue" } });
		expect(manager.getProjectSettings().piVim).toEqual({ modeColors: { insert: "green" } });
	});

	it("getGlobalSettings returns a deep clone that cannot mutate internal state", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ piVim: { modeColors: { normal: "blue" } } }, null, 2),
		);
		await Settings.init({ cwd: projectDir, agentDir });

		const manager = SettingsManager.create(projectDir);
		const layer = manager.getGlobalSettings();
		const mutated = layer.piVim;
		if (mutated && typeof mutated === "object" && "modeColors" in mutated) {
			const modeColors = mutated.modeColors;
			if (modeColors && typeof modeColors === "object") {
				(modeColors as Record<string, unknown>).normal = "red";
			}
		}

		// A fresh read is unaffected — the accessor handed out a clone.
		expect(manager.getGlobalSettings().piVim).toEqual({ modeColors: { normal: "blue" } });
	});

	it("create() works before Settings.init() by returning an isolated instance with the accessors", () => {
		resetSettingsForTest();

		const manager = SettingsManager.create(projectDir);
		expect(manager).toBeInstanceOf(Settings);
		expect(manager).not.toBeInstanceOf(Promise);
		expect(typeof manager.getGlobalSettings).toBe("function");
		expect(typeof manager.getProjectSettings).toBe("function");
		expect(manager.getGlobalSettings()).toEqual({});
		expect(manager.getProjectSettings()).toEqual({});
	});

	it("inMemory() returns a usable Settings with the accessors present", () => {
		const manager = SettingsManager.inMemory();
		expect(manager).toBeInstanceOf(Settings);
		expect(typeof manager.getGlobalSettings).toBe("function");
		expect(typeof manager.getProjectSettings).toBe("function");
		expect(manager.getGlobalSettings()).toEqual({});
		expect(manager.getProjectSettings()).toEqual({});
	});
});
