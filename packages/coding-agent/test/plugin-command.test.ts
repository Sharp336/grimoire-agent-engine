import { describe, expect, it } from "bun:test";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import { parsePluginArgs } from "../src/cli/plugin-cli";
import Plugin from "../src/commands/plugin";

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("Plugin command scope parsing", () => {
	it("accepts project scope", async () => {
		const command = new Plugin(["install", "--scope", "project"], TEST_CONFIG);
		const { flags } = await command.parse(Plugin);
		expect(flags.scope).toBe("project");
	});

	it("rejects invalid scope values", async () => {
		const command = new Plugin(["install", "--scope", "porject"], TEST_CONFIG);
		await expect(command.parse(Plugin)).rejects.toThrow(/Expected --scope to be one of: user, project/);
	});

	it("parses --local independently from --compat-pi", () => {
		expect(parsePluginArgs(["plugin", "install", "--local"])?.flags).toEqual({ local: true });
		expect(parsePluginArgs(["plugin", "install", "-l"])?.flags).toEqual({ local: true });
		expect(parsePluginArgs(["plugin", "install", "--compat-pi"])?.flags).toEqual({ compatPi: true });
		expect(parsePluginArgs(["plugin", "install", "--local", "--compat-pi"])?.flags).toEqual({
			local: true,
			compatPi: true,
		});
	});
});
