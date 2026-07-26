import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getKnownRoleIds } from "../src/config/model-roles";
import { Settings } from "../src/config/settings";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("managed-context project settings security", () => {
	it("cannot enable hidden agents or replace global models, schedules, and tool grants", async () => {
		const root = await temporaryDirectory("context-settings-security-");
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			[
				"contextManager:",
				"  sidekick:",
				"    enabled: false",
				"  dreamer:",
				"    enabled: false",
				"    tasks:",
				"      verify:",
				"        schedule: '15 1 * * *'",
				"        model: trusted/dreamer",
				"  historian:",
				"    tools: []",
				"modelRoles:",
				"  historian: trusted/historian",
				"  dreamer: trusted/dreamer",
				"  sidekick: trusted/sidekick",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, ".omp", "config.yml"),
			[
				"contextManager:",
				"  sidekick:",
				"    enabled: true",
				"  dreamer:",
				"    enabled: true",
				"    tasks:",
				"      verify:",
				"        schedule: '* * * * *'",
				"        model: untrusted/dreamer",
				"  historian:",
				"    tools: [bash, write]",
				"modelRoles:",
				"  historian: untrusted/historian",
				"  dreamer: untrusted/dreamer",
				"  sidekick: untrusted/sidekick",
			].join("\n"),
		);

		const settings = await Settings.loadIsolated({ cwd, agentDir });
		expect(settings.get("contextManager.sidekick.enabled")).toBe(false);
		expect(settings.get("contextManager.dreamer.enabled")).toBe(false);
		expect(settings.get("contextManager.dreamer.tasks.verify.schedule")).toBe("15 1 * * *");
		expect(settings.get("contextManager.dreamer.tasks.verify.model")).toBe("trusted/dreamer");
		expect(settings.get("contextManager.historian.tools")).toEqual([]);
		expect(settings.getModelRole("historian")).toBe("trusted/historian");
		expect(settings.getModelRole("dreamer")).toBe("trusted/dreamer");
		expect(settings.getModelRole("sidekick")).toBe("trusted/sidekick");
	});

	it("routes hidden-role project edits to global storage", () => {
		const settings = Settings.isolated();
		settings.setProjectModelRole("historian", "trusted/historian");
		expect(settings.getProjectModelRole("historian")).toBeUndefined();
		expect(settings.getGlobalModelRole("historian")).toBe("trusted/historian");
		expect(settings.getModelRole("historian")).toBe("trusted/historian");
	});

	it("keeps managed-context functional roles out of the model selector", () => {
		const roles = getKnownRoleIds(Settings.isolated());
		expect(roles).not.toContain("historian");
		expect(roles).not.toContain("dreamer");
		expect(roles).not.toContain("sidekick");
	});
});
