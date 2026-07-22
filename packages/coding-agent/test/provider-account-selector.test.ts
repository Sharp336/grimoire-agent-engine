import { describe, expect, it, vi } from "bun:test";
import type { OAuthAccountSummary } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createProviderAccountSelectorExtension } from "@oh-my-pi/pi-coding-agent/provider-account-selector";

const ACCOUNTS: OAuthAccountSummary[] = [
	{ position: 0, credentialId: 10, accountId: "account-a", email: "a@example.com" },
	{ position: 1, credentialId: 11, accountId: "account-b", email: "b@example.com" },
];

function captureCommand(): RegisteredCommand {
	let command: RegisteredCommand | undefined;
	const api = {
		registerCommand(name: string, definition: RegisteredCommand): void {
			command = { ...definition, name };
		},
	} as unknown as ExtensionAPI;
	createProviderAccountSelectorExtension(api);
	if (!command) throw new Error("provider command was not registered");
	return command;
}

function commandContext(options?: { selections?: string[]; hasUI?: boolean }) {
	const selections = [...(options?.selections ?? [])];
	const pin = vi.fn(() => true);
	const clear = vi.fn();
	const setStatus = vi.fn();
	const notify = vi.fn();
	const context = {
		hasUI: options?.hasUI ?? false,
		providerSessionId: "provider-session-parent",
		authStorage: {
			listOAuthProviderIds: () => ["mcp_oauth:internal", "openai-codex"],
			listOAuthAccounts: () => ACCOUNTS,
			pinSessionOAuthAccount: pin,
			clearSessionOAuthAccountPin: clear,
		},
		models: {
			list: () => [{ provider: "openai-codex" }],
		},
		ui: {
			select: async () => selections.shift(),
			setStatus,
			notify,
		},
	} as unknown as ExtensionCommandContext;
	return { context, pin, clear, setStatus, notify };
}

describe("provider account selector extension", () => {
	it("pins the provider-facing parent session from direct command arguments", async () => {
		const command = captureCommand();
		const harness = commandContext();

		await command.handler("openai-codex 2", harness.context);

		expect(harness.pin).toHaveBeenCalledWith("openai-codex", "provider-session-parent", 1);
		expect(harness.setStatus).toHaveBeenCalledWith("provider-account", "openai-codex: b@example.com");
	});

	it("offers account selection interactively and can restore automatic routing", async () => {
		const command = captureCommand();
		const harness = commandContext({ selections: ["Automatic (ranked / round-robin)"], hasUI: true });

		await command.handler("", harness.context);

		expect(harness.clear).toHaveBeenCalledWith("openai-codex", "provider-session-parent");
		expect(harness.setStatus).toHaveBeenCalledWith("provider-account", undefined);
	});
});
