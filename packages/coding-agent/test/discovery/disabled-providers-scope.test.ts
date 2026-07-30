/**
 * `disabledProviders` is one array shared by the discovery registry
 * (capability/index.ts) and the model registry (config/model-registry.ts),
 * matched in both against a bare provider id. `cursor` is registered in both
 * namespaces, so a discovery toggle that persisted the bare id also removed the
 * Cursor models from `/model` and `/login`.
 *
 * These tests pin the qualifier that keeps the two apart, and the unqualified
 * form that every pre-existing config relies on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	disableProvider,
	enableProvider,
	initializeWithSettings,
	isProviderEnabled,
	setDisabledProviders,
} from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/** Seed the setting through the same layer a real config file writes to. */
function settingsWith(entries: string[]): Settings {
	const settings = Settings.isolated();
	settings.set("disabledProviders", entries);
	initializeWithSettings(settings);
	return settings;
}

/** How model-registry.ts reads the setting (getDisabledProviderIdsFromSettings). */
function modelRegistrySees(settings: Settings, providerId: string): boolean {
	return new Set(settings.get("disabledProviders")).has(providerId);
}

describe("disabledProviders — discovery/model namespace", () => {
	afterEach(() => {
		setDisabledProviders([]);
	});

	test("a discovery toggle persists the qualified entry and spares the model backend", () => {
		const settings = settingsWith([]);

		disableProvider("cursor");

		expect(settings.get("disabledProviders")).toEqual(["discovery:cursor"]);
		expect(isProviderEnabled("cursor")).toBe(false);
		expect(modelRegistrySees(settings, "cursor")).toBe(false);
	});

	test("an unqualified entry still disables both subsystems", () => {
		const settings = settingsWith(["cursor"]);

		expect(isProviderEnabled("cursor")).toBe(false);
		expect(modelRegistrySees(settings, "cursor")).toBe(true);
	});

	test("enabling clears both the qualified and the unqualified entry", () => {
		const settings = settingsWith(["cursor", "discovery:cursor"]);
		expect(isProviderEnabled("cursor")).toBe(false);

		enableProvider("cursor");

		expect(settings.get("disabledProviders")).toEqual([]);
		expect(isProviderEnabled("cursor")).toBe(true);
	});

	test("disabling is idempotent against a pre-existing unqualified entry", () => {
		const settings = settingsWith(["cursor"]);

		disableProvider("cursor");

		expect(settings.get("disabledProviders")).toEqual(["cursor"]);
	});

	test("entries owned by the model registry survive a discovery toggle", () => {
		const settings = settingsWith(["anthropic", "openai"]);

		disableProvider("cursor");

		expect(settings.get("disabledProviders")).toEqual(["anthropic", "openai", "discovery:cursor"]);
		expect(modelRegistrySees(settings, "anthropic")).toBe(true);
	});
});
