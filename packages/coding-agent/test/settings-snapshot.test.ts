import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { getUi, isRpcReadable, SETTING_TABS, SETTINGS_SCHEMA, type SettingPath } from "../src/config/settings-schema";
import { buildSettingsSnapshot, isSettingTab } from "../src/config/settings-snapshot";

const paths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

/**
 * Names that read like credentials. Used ONLY to assert the boundary held; the
 * boundary itself is the explicit `rpcReadable` allowlist, never this pattern.
 */
const CREDENTIAL_NAME = /token|apikey|api_key|password|passwd|credential|bearer/i;
const NOT_CREDENTIALS: Record<string, true> = {
	"display.showTokenUsage": true,
	"compaction.thresholdTokens": true,
	"compaction.reserveTokens": true,
	"compaction.keepRecentTokens": true,
	"compaction.idleThresholdTokens": true,
	"branchSummary.reserveTokens": true,
	"memories.phase1InputTokenLimit": true,
	"memories.fallbackTokenLimit": true,
	"memories.summaryInjectionTokenLimit": true,
	"mnemopi.injectionTokenLimit": true,
	"hindsight.recallMaxTokens": true,
	"commit.mapReduceMaxFileTokens": true,
};

describe("settings snapshot", () => {
	it("describes every setting and withholds values by default", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		expect(snapshot.settings).toHaveLength(paths.length);
		const disclosed = snapshot.settings.filter(entry => "value" in entry);
		const redacted = snapshot.settings.filter(entry => entry.redacted === true);
		expect(disclosed.length + redacted.length).toBe(paths.length);
		// Deny-by-default: the allowlist is a small, deliberate minority.
		expect(disclosed.length).toBeLessThan(paths.length / 2);
		for (const entry of redacted) expect(entry).not.toHaveProperty("value");
	});

	it("never discloses a credential-shaped value", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		const leaked = snapshot.settings.filter(
			entry => "value" in entry && CREDENTIAL_NAME.test(entry.path) && NOT_CREDENTIALS[entry.path] !== true,
		);
		expect(leaked.map(entry => entry.path)).toEqual([]);
	});

	it("never discloses a secret-marked value", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		for (const entry of snapshot.settings) {
			if (getUi(entry.path as SettingPath)?.secret !== true) continue;
			expect(entry).not.toHaveProperty("value");
			expect(entry.redacted).toBe(true);
		}
	});

	it("withholds a value the moment its allowlist opt-in is absent", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		for (const entry of snapshot.settings) {
			const allowed = isRpcReadable(entry.path as SettingPath);
			expect("value" in entry).toBe(allowed && getUi(entry.path as SettingPath)?.secret !== true);
		}
	});

	it("returns the configured value for an allowlisted setting", () => {
		const settings = Settings.isolated({ colorBlindMode: true });
		const entry = buildSettingsSnapshot(settings).settings.find(item => item.path === "colorBlindMode");
		expect(entry?.value).toBe(true);
		expect(entry?.configured).toBe(true);
		expect(entry?.type).toBe("boolean");
	});

	it("carries schema metadata for redacted settings but no user state", () => {
		// A configured credential must reveal neither its value nor its existence.
		const settings = Settings.isolated({ "auth.broker.token": "super-secret-broker-token" });
		const entry = buildSettingsSnapshot(settings).settings.find(item => item.path === "auth.broker.token");
		// Metadata is public repository content; the value and its presence are not.
		expect(entry?.type).toBe("string");
		expect(entry?.redacted).toBe(true);
		expect(entry).not.toHaveProperty("value");
		expect(entry).not.toHaveProperty("configured");
		expect(JSON.stringify(entry)).not.toContain("super-secret-broker-token");
	});

	it("omits configured status from every redacted entry", () => {
		for (const entry of buildSettingsSnapshot(Settings.isolated()).settings) {
			if (entry.redacted !== true) continue;
			expect(entry).not.toHaveProperty("configured");
		}
	});

	it("omits default when a setting has none, so the wire has one shape", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated());
		const withoutDefault = snapshot.settings.find(entry => entry.path === "auth.broker.token");
		expect(withoutDefault).not.toHaveProperty("default");
		const withDefault = snapshot.settings.find(entry => entry.path === "colorBlindMode");
		expect(withDefault?.default).toBe(false);
		// JSON must not silently drop a declared field: what survives a round
		// trip is exactly what the type promises.
		for (const entry of snapshot.settings) {
			const roundTripped = JSON.parse(JSON.stringify(entry));
			expect(Object.keys(roundTripped).sort()).toEqual(Object.keys(entry).sort());
		}
	});

	it("keeps the allowlist inside its reviewed shape", () => {
		// The schema type permits opting in any setting. This starter set is
		// deliberately narrower: settings the panel already shows, whose values
		// are a bool or one of a fixed enum, so none can carry a path, a URL or
		// a credential. Broadening it must be a deliberate edit here, not a
		// quiet annotation elsewhere.
		const allowlisted = paths.filter(path => isRpcReadable(path));
		expect(allowlisted.length).toBeGreaterThan(0);
		for (const path of allowlisted) {
			const ui = getUi(path);
			expect(ui).toBeDefined();
			expect(ui?.tab).toBe("appearance");
			expect(ui?.secret).not.toBe(true);
			expect(["boolean", "enum"]).toContain(SETTINGS_SCHEMA[path].type);
		}
	});

	it("scopes to a tab and exposes enum choices", () => {
		const snapshot = buildSettingsSnapshot(Settings.isolated(), "appearance");
		expect(snapshot.settings.length).toBeGreaterThan(0);
		for (const entry of snapshot.settings) expect(entry.ui?.tab).toBe("appearance");
		const preset = snapshot.settings.find(entry => entry.path === "symbolPreset");
		expect(preset?.values?.length).toBeGreaterThan(0);
		expect(preset).toHaveProperty("value");
	});
});

describe("settings tab guard", () => {
	it("accepts every real tab", () => {
		for (const tab of SETTING_TABS) expect(isSettingTab(tab)).toBe(true);
	});

	it("rejects anything an RPC frame could actually carry", () => {
		// Frames are cast from parsed JSON, so the guard must survive non-strings
		// as well as typos; the handler turns a false here into `invalid_tab`.
		for (const value of ["appearence", "", "APPEARANCE", 1, 0, true, null, undefined, {}, [], ["appearance"]])
			expect(isSettingTab(value)).toBe(false);
	});

	it("guards the same tab set the snapshot filters on", () => {
		for (const tab of SETTING_TABS) {
			const scoped = buildSettingsSnapshot(Settings.isolated(), tab);
			for (const entry of scoped.settings) expect(entry.ui?.tab).toBe(tab);
		}
	});
});
