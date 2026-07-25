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

	it("discloses exactly the reviewed set and nothing else", () => {
		// Read off the built snapshot, not off `isRpcReadable`: deriving the
		// expectation from the same helper the code uses would pass no matter what
		// the endpoint actually emits.
		//
		// The list is exact on purpose. Annotating one more setting widens
		// disclosure, and a category check ("appearance booleans and enums") would
		// still pass while it happened. Widening this set must be a deliberate
		// edit here.
		const disclosed = buildSettingsSnapshot(Settings.isolated())
			.settings.filter(entry => entry.redacted !== true)
			.map(entry => entry.path)
			.sort();
		expect(disclosed).toEqual([
			"colorBlindMode",
			"display.cacheMissMarker",
			"display.collapseCompacted",
			"display.shimmer",
			"display.showTokenUsage",
			"display.smoothStreaming",
			"images.autoResize",
			"images.blockImages",
			"showHardwareCursor",
			"statusLine.compactThinkingLevel",
			"statusLine.preset",
			"statusLine.separator",
			"statusLine.sessionAccent",
			"statusLine.showHookStatus",
			"statusLine.transparent",
			"symbolPreset",
			"task.showResolvedModelBadge",
			"terminal.showImages",
			"terminal.showProgress",
			"tui.hyperlinks",
			"tui.imeSafeCursor",
			"tui.renderMermaid",
			"tui.scrollbackRebuild",
			"tui.textSizing",
			"tui.tight",
			"tui.titleState",
		]);
	});

	it("keeps every disclosed setting inside its reviewed shape", () => {
		// Settings the panel already shows, whose values are a bool or one of a
		// fixed enum, so none can carry a path, a URL or a credential.
		for (const entry of buildSettingsSnapshot(Settings.isolated()).settings) {
			if (entry.redacted === true) continue;
			expect(entry.ui).toBeDefined();
			expect(entry.ui?.tab).toBe("appearance");
			expect(entry.ui?.secret).not.toBe(true);
			expect(["boolean", "enum"]).toContain(entry.type);
		}
	});

	it("preserves the rendering metadata a client would otherwise duplicate", () => {
		const byPath = new Map(buildSettingsSnapshot(Settings.isolated()).settings.map(e => [e.path, e]));
		// Static choices, including their labels.
		expect(byPath.get("symbolPreset")?.ui?.options).toEqual(getUi("symbolPreset")?.options);
		// A runtime-populated submenu must stay distinguishable from "no choices".
		expect(byPath.get("theme.dark")?.ui?.options).toBe("runtime");
		// Ordered selection semantics.
		expect(byPath.get("providers.webSearchOrder")?.ui?.ordered).toBe(true);
		// A config-only setting keeps its top-level prose.
		expect(byPath.get("tui.maxInlineImageColumns")?.description).toContain("inline images");
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
