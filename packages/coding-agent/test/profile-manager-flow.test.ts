/**
 * Headless simulation of the Profile Manager TUI flow: drives the component
 * exactly as the keyboard would, verifying the visual row set and the full
 * create→edit→delete cycle through emitted actions against real Settings.
 */
import { beforeAll, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { type ProfileManagerAction, ProfileManagerComponent } from "../src/modes/components/profile-manager";
import { initTheme } from "../src/modes/theme/theme";
import { profilePickerEntries } from "../src/slash-commands/helpers/profile-command";

let agentDir: string;

beforeAll(async () => {
	await initTheme();
	const temp = TempDir.createSync("@pi-tui-mgr-");
	agentDir = temp.join("agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(temp.join("project"), { recursive: true });
	await Bun.write(`${agentDir}/config.yml`, "modelRoles:\n  default: provider/base\n");
});

import * as fs from "node:fs";

test("manager flow: rows render and full create/edit/delete cycle works", async () => {
	resetSettingsForTest();
	const settings = await Settings.loadIsolated({ cwd: agentDir, agentDir });
	await settings.setProfile("global", "cheap", { description: "Low cost", modelRoles: { default: "m1" } });
	await settings.setProfile("global", "advanced", { description: "Max", modelRoles: { slow: "m2" } });

	const actions: ProfileManagerAction[] = [];
	const manager = new ProfileManagerComponent(profilePickerEntries(settings), "cheap", a => actions.push(a));

	const rendered = manager.render(80).join("\n");
	for (const needle of ["cheap", "advanced", "+ Create Profile", "Off"]) {
		expect(rendered).toContain(needle);
	}

	manager.handleInput("n");
	expect(actions.at(-1)).toEqual({ kind: "create" });

	await settings.setProfile("global", "coding", { modelRoles: { smol: "m3" } });
	manager.update(profilePickerEntries(settings), "cheap");
	manager.selectProfile("coding");

	manager.handleInput("e");
	expect(actions.at(-1)).toEqual({ kind: "edit", name: "coding" });

	manager.handleInput("d");
	expect(actions.at(-1)).toEqual({ kind: "delete", name: "coding" });
	await settings.removeProfile("global", "coding");

	// Deleting the row under the cursor moves focus to the first surviving
	// profile row; Enter then selects whichever row is focused.
	manager.update(profilePickerEntries(settings), "cheap");
	manager.handleInput("\r");
	expect(actions.at(-1)).toEqual({ kind: "select", name: "advanced" });

	// Off row: jump to it explicitly, then Enter deactivates.
	manager.selectProfile("off");
	manager.handleInput("\r");
	expect(actions.at(-1)).toEqual({ kind: "select", name: "off" });
	manager.handleInput("\x1b");
	expect(actions.at(-1)).toEqual({ kind: "cancel" });
	expect(settings.getActiveProfile()).toBe("");
});
