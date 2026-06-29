import { describe, expect, test } from "bun:test";
import { buildRestartLaunchFlags } from "@oh-my-pi/pi-coding-agent/main";

describe("restart launch flags", () => {
	test("resolves path launch flags against the original launch cwd", () => {
		const flags = buildRestartLaunchFlags(
			{
				config: ["./omp.yml", "/tmp/global.yml"],
				extensions: ["./ext", "pkg-extension", "../shared/ext"],
				hooks: ["./hooks/restart.ts", "@scope/pkg"],
				pluginDirs: ["plugins", "/opt/plugins"],
			},
			"/repo/original",
		);

		expect(flags.configFiles).toEqual(["/repo/original/omp.yml", "/tmp/global.yml"]);
		expect(flags.extensionPaths).toEqual(["/repo/original/ext", "pkg-extension", "/repo/shared/ext"]);
		expect(flags.hookPaths).toEqual(["/repo/original/hooks/restart.ts", "@scope/pkg"]);
		expect(flags.pluginDirs).toEqual(["/repo/original/plugins", "/opt/plugins"]);
	});
});
