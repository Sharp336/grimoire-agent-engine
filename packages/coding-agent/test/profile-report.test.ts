import { describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	formatProfileReport,
	resolveProfileAnthropicIdentity,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/profile-report";

describe("profile report", () => {
	it("registers /profile", () => {
		expect(BUILTIN_SLASH_COMMANDS.find(command => command.name === "profile")?.description).toContain("Anthropic");
	});

	it("shows the profile and Anthropic account email", () => {
		expect(
			formatProfileReport("claude-1", {
				email: "person@example.com",
			}),
		).toBe("Using profile claude-1 · Anthropic account: person@example.com");
	});

	it("finds the sole Anthropic account before the session routes to it", () => {
		const authStorage = {
			getOAuthAccountIdentity: () => undefined,
			listOAuthAccounts: () => [{ position: 0, credentialId: 1, email: "person@example.com" }],
		} as unknown as AuthStorage;
		expect(resolveProfileAnthropicIdentity(authStorage, "session-1")?.email).toBe("person@example.com");
	});

	it("states when the profile has no Anthropic login", () => {
		expect(formatProfileReport("claude-2", undefined)).toBe(
			"Using profile claude-2 · Anthropic account: not signed in",
		);
	});
});
