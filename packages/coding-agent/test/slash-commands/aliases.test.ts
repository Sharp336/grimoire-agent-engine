import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("builtin slash command aliases", () => {
	it("surfaces /accounts in builtin slash command definitions", () => {
		const accounts = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "accounts");
		expect(accounts).toBeDefined();
		expect(accounts?.description).toContain("alias for /switch");
	});
});
