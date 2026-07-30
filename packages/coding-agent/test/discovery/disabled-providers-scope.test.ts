/**
 * `disabledProviders` is one array shared by the discovery registry
 * (capability/index.ts) and the model registry (config/model-registry.ts),
 * matched in both against a bare provider id. `cursor` is registered in both
 * namespaces, so a discovery toggle that persisted the bare id also removed the
 * Cursor models from `/model` and `/login`.
 *
 * These tests pin the qualifier that keeps the two apart against the real model
 * registry, plus the persistence rules that keep a discovery toggle from
 * rewriting entries it does not own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	disableProvider,
	enableProvider,
	initializeWithSettings,
	isProviderEnabled,
	resetProviderStateForTest,
	setDisabledProviders,
} from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/** Reject every request so refresh() stays on the bundled catalog. */
const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled in disabled-providers-scope test"));

describe("disabledProviders — discovery/model namespace", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-disabled-providers-scope-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });

		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		// The model registry drops a provider before it checks credentials, so the
		// Cursor backend needs one to prove the entry — not a missing login — is
		// what removes its models.
		await authStorage.set("cursor", {
			type: "oauth",
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3_600_000,
		});
	});

	afterEach(async () => {
		// initializeWithSettings() mutates module state that outlives this file.
		resetProviderStateForTest();
		authStorage?.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Bun.sleep(0);
		await tempDir?.remove();
	});

	const globalConfigPath = () => path.join(agentDir, "config.yml");

	async function writeGlobalConfig(value: Record<string, unknown>): Promise<void> {
		await Bun.write(globalConfigPath(), YAML.stringify(value, null, 2));
	}

	async function readGlobalConfig(): Promise<Record<string, unknown>> {
		const file = Bun.file(globalConfigPath());
		if (!(await file.exists())) return {};
		const parsed = YAML.parse(await file.text());
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	}

	/** Boot the real settings singleton the model registry reads from. */
	async function initSettings(): Promise<Settings> {
		const active = await Settings.init({ cwd: projectDir, agentDir });
		initializeWithSettings(active);
		return active;
	}

	/** Providers the real model registry offers for selection (`getAvailable()`). */
	async function selectableProviders(): Promise<Set<string>> {
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { fetch: offlineFetch });
		await registry.refresh("offline");
		return new Set(registry.getAvailable().map(model => model.provider));
	}

	test("an unqualified entry disables the model backend even with a credential present", async () => {
		await writeGlobalConfig({ disabledProviders: ["cursor"] });
		await initSettings();

		expect(await selectableProviders()).not.toContain("cursor");
		expect(isProviderEnabled("cursor")).toBe(false);
	});

	test("the qualified entry disables discovery and spares the model backend", async () => {
		await writeGlobalConfig({ disabledProviders: ["discovery:cursor"] });
		await initSettings();

		expect(await selectableProviders()).toContain("cursor");
		expect(isProviderEnabled("cursor")).toBe(false);
	});

	test("a discovery toggle persists the qualified entry", async () => {
		await writeGlobalConfig({ disabledProviders: [] });
		const active = await initSettings();

		disableProvider("cursor");
		await active.flush();

		expect((await readGlobalConfig()).disabledProviders).toEqual(["discovery:cursor"]);
		expect(isProviderEnabled("cursor")).toBe(false);
	});

	test("enabling clears both the qualified and the unqualified entry", async () => {
		await writeGlobalConfig({ disabledProviders: ["cursor", "discovery:cursor"] });
		const active = await initSettings();
		expect(isProviderEnabled("cursor")).toBe(false);

		enableProvider("cursor");
		await active.flush();

		expect((await readGlobalConfig()).disabledProviders).toEqual([]);
		expect(isProviderEnabled("cursor")).toBe(true);
	});

	test("disabling is idempotent against a pre-existing unqualified entry", async () => {
		await writeGlobalConfig({ disabledProviders: ["cursor"] });
		const active = await initSettings();

		disableProvider("cursor");
		await active.flush();

		expect((await readGlobalConfig()).disabledProviders).toEqual(["cursor"]);
	});

	test("a toggle that changes nothing does not touch the config", async () => {
		await writeGlobalConfig({ setupVersion: 1 });
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "settings.json"),
			JSON.stringify({ disabledProviders: ["github"] }),
		);
		const active = await initSettings();
		expect(isProviderEnabled("github")).toBe(false);

		// Only the project layer disables it, so there is nothing to drop here.
		enableProvider("github");
		await active.flush();

		expect(await readGlobalConfig()).not.toHaveProperty("disabledProviders");
		// Reporting it as enabled would load it for this process only.
		expect(isProviderEnabled("github")).toBe(false);
	});

	test("enabling reports the truth when a path-scoped rule keeps a provider off", async () => {
		await writeGlobalConfig({ disabledProviders: [{ paths: [projectDir], providers: ["opencode"] }] });
		const active = await initSettings();
		expect(isProviderEnabled("opencode")).toBe(false);

		enableProvider("opencode");
		await active.flush();

		expect((await readGlobalConfig()).disabledProviders).toEqual([{ paths: [projectDir], providers: ["opencode"] }]);
		expect(isProviderEnabled("opencode")).toBe(false);
	});

	test("replacing the discovery set keeps a model-only disable", async () => {
		await writeGlobalConfig({ disabledProviders: ["anthropic", "cursor"] });
		const active = await initSettings();

		setDisabledProviders(["opencode"]);
		await active.flush();

		expect((await readGlobalConfig()).disabledProviders).toEqual(["anthropic", "discovery:opencode"]);
		expect(await selectableProviders()).not.toContain("anthropic");
	});

	test("a toggle preserves path-scoped entries instead of flattening them", async () => {
		const scoped = { paths: [projectDir], providers: ["anthropic"] };
		await writeGlobalConfig({ disabledProviders: ["github", scoped] });
		const active = await initSettings();

		disableProvider("cursor");
		await active.flush();

		expect((await readGlobalConfig()).disabledProviders).toEqual(["github", scoped, "discovery:cursor"]);
	});

	test("a toggle does not copy project-layer entries into the global config", async () => {
		await writeGlobalConfig({ disabledProviders: [] });
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "settings.json"),
			JSON.stringify({ disabledProviders: ["github"] }),
		);
		const active = await initSettings();
		expect(isProviderEnabled("github")).toBe(false);

		disableProvider("cursor");
		await active.flush();

		expect((await readGlobalConfig()).disabledProviders).toEqual(["discovery:cursor"]);
	});
});
