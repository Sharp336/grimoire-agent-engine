/**
 * Review-finding regression tests: effective-state reload signals (E),
 * prototype-key profile-name safety (F), central name validation with
 * reserved sentinels (I), and status-line sanitization of profile names (J).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { onActiveProfileChanged, onModelRolesChanged, resetSettingsForTest, Settings } from "../src/config/settings";
import { sanitizeStatusText } from "../src/modes/shared";
import { initTheme } from "../src/modes/theme/theme";
import { TRUNCATE_LENGTHS, truncateToWidth } from "../src/tools/render-utils";

const YAML = Bun.YAML;

describe("review-finding regressions", () => {
	test("E: external edit to the ACTIVE profile's roles fires signals on reloadFromDisk", async () => {
		const temp = TempDir.createSync("@pi-regression-e-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				activeProfile: "a",
				profiles: { a: { modelRoles: { default: "provider/one" } } },
			}),
		);
		resetSettingsForTest();
		const s = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		expect(s.getModelRole("default")).toBe("provider/one");

		let roleSignals = 0;
		let profileSignals = 0;
		const unsubs = [onModelRolesChanged(() => roleSignals++), onActiveProfileChanged(() => profileSignals++)];
		try {
			// Same active profile NAME, different roles: the signal must fire.
			fs.writeFileSync(
				path.join(agentDir, "config.yml"),
				YAML.stringify({
					activeProfile: "a",
					profiles: { a: { modelRoles: { default: "provider/two" } } },
				}),
			);
			await s.reloadFromDisk();
			expect(s.getModelRole("default")).toBe("provider/two");
			expect(roleSignals).toBeGreaterThan(0);
			expect(profileSignals).toBeGreaterThan(0);
		} finally {
			for (const unsub of unsubs) unsub();
		}

		// Inactive-profile external edits stay silent on the live signals.
		let silent = 0;
		const unsub = onActiveProfileChanged(() => silent++);
		try {
			fs.writeFileSync(
				path.join(agentDir, "config.yml"),
				YAML.stringify({
					activeProfile: "a",
					profiles: {
						a: { modelRoles: { default: "provider/two" } },
						b: { modelRoles: { default: "provider/other" } },
					},
				}),
			);
			await s.reloadFromDisk();
			expect(silent).toBe(0);
			expect(s.getModelRole("default")).toBe("provider/two"); // live model untouched
		} finally {
			unsub();
		}
		await temp.remove();
	});

	test("F: prototype keys never masquerade as profiles", async () => {
		const temp = TempDir.createSync("@pi-regression-f-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), "activeProfile: toString\n");
		resetSettingsForTest();
		const s = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		// No real `toString` profile exists: inherited Object.prototype.toString
		// must not be returned, and the active profile must not resolve to it.
		expect(s.getProfile("toString")).toBeUndefined();
		expect(s.getProfiles()).toEqual({});
		// isProfileActive must be false — the "active" name has no overlay.
		expect(s.isProfileActive()).toBe(false);
		await temp.remove();
	});

	test("F: __proto__ in profiles config is ignored, not inherited", async () => {
		const temp = TempDir.createSync("@pi-regression-f2-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Raw YAML with a __proto__ key (YAML.parse produces an own property).
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			"profiles:\n  __proto__:\n    modelRoles:\n      default: provider/evil\n  real:\n    modelRoles:\n      default: provider/ok\n",
		);
		resetSettingsForTest();
		const s = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		expect(Object.keys(s.getProfiles()).sort()).toEqual(["real"]);
		expect(s.getProfile("__proto__")).toBeUndefined();
		await temp.remove();
	});

	test("I: reserved sentinel and prototype-collision names are rejected", async () => {
		const temp = TempDir.createSync("@pi-regression-i-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), "modelRoles:\n  default: provider/base\n");
		resetSettingsForTest();
		const s = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		for (const name of ["off", "+create", "__proto__", "constructor", "hasOwnProperty", "bad name", "", "  x  "]) {
			await expect(s.setProfile("global", name, { modelRoles: { default: "m" } })).rejects.toThrow();
		}
		// Valid names with the advertised charset still work.
		await s.setProfile("global", "work.machine-1", { modelRoles: { default: "m" } });
		expect(s.getProfile("work.machine-1")).toBeDefined();
		await temp.remove();
	});

	test("J: status-line profile name is sanitized and width-bounded", async () => {
		await initTheme();
		// Malformed config values that could corrupt TUI layout.
		const evil = "\x1b[31mred\u0007\tnew\nline";
		const safe = truncateToWidth(sanitizeStatusText(evil), TRUNCATE_LENGTHS.SHORT);
		expect(safe).not.toContain("\x1b");
		expect(safe).not.toContain("\n");
		expect(safe).not.toContain("\t");
		expect(safe.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.SHORT);
		// A long-but-valid name is truncated, not passed through.
		const long = truncateToWidth(sanitizeStatusText("x".repeat(200)), TRUNCATE_LENGTHS.SHORT);
		expect(long.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.SHORT);
	});
});
