import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { buildRestartLaunchFlags, resolveRestartPromptLaunchValue } from "@oh-my-pi/pi-coding-agent/main";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("restart launch flags", () => {
	test("resolves path launch flags against the original launch cwd", () => {
		const flags = buildRestartLaunchFlags(
			{
				config: ["./omp.yml", "/tmp/global.yml"],
				extensions: ["./ext", "pkg-extension", "../shared/ext"],
				hooks: ["./hooks/restart.ts", "@scope/pkg"],
				pluginDirs: ["plugins", "/opt/plugins"],
				providerSessionId: "provider-session-1",
			},
			"/repo/original",
		);

		expect(flags.configFiles).toEqual(["/repo/original/omp.yml", "/tmp/global.yml"]);
		expect(flags.extensionPaths).toEqual(["/repo/original/ext", "/repo/original/pkg-extension", "/repo/shared/ext"]);
		expect(flags.hookPaths).toEqual(["/repo/original/hooks/restart.ts", "/repo/original/@scope/pkg"]);
		expect(flags.pluginDirs).toEqual(["/repo/original/plugins", "/opt/plugins"]);
		expect(flags.providerSessionId).toBe("provider-session-1");
	});

	test("absolutizes only file-backed prompt launch flags", async () => {
		using tempDir = TempDir.createSync("@omp-restart-prompts-");
		const promptPath = path.join(tempDir.path(), "prompts", "system.md");
		await Bun.write(promptPath, "single-line prompt");

		expect(await resolveRestartPromptLaunchValue("prompts/system.md", tempDir.path())).toBe(promptPath);
		expect(await resolveRestartPromptLaunchValue("literal prompt", tempDir.path())).toBe("literal prompt");
		expect(await resolveRestartPromptLaunchValue("literal\nprompt", tempDir.path())).toBe("literal\nprompt");
	});
});
