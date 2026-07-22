import { beforeAll, describe, expect, it, vi } from "bun:test";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/logout-account-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage, StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

interface TestEditorContainer {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createEditorContainer(): TestEditorContainer {
	return {
		children: [],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function createStoredCredential(
	id: number,
	email: string,
	accountId: string,
	clientProfile: "claude-code" | "cowork",
): StoredAuthCredential {
	return {
		id,
		provider: "anthropic",
		disabledCause: null,
		credential: {
			type: "oauth",
			access: `access-${id}`,
			refresh: `refresh-${id}`,
			expires: Date.now() + 60_000,
			email,
			accountId,
			clientProfile,
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController logout", () => {
	it("Cowork logout lists and removes only Cowork credentials", async () => {
		const editorContainer = createEditorContainer();
		const credentials = [
			createStoredCredential(20, "claude@example.com", "acct-claude", "claude-code"),
			createStoredCredential(21, "cowork-a@example.com", "acct-cowork-a", "cowork"),
			createStoredCredential(22, "cowork-b@example.com", "acct-cowork-b", "cowork"),
		];
		const removeCredential = vi.fn(async (_provider: string, credentialId: number) => {
			const index = credentials.findIndex(row => row.id === credentialId);
			if (index === -1) return false;
			credentials.splice(index, 1);
			return true;
		});
		const authStorage = {
			reload: vi.fn(async () => undefined),
			listStoredCredentials: (_provider?: string, options?: { clientProfile?: "claude-code" | "cowork" }) =>
				options?.clientProfile
					? credentials.filter(
							row => row.credential.type === "oauth" && row.credential.clientProfile === options.clientProfile,
						)
					: credentials,
			getActiveOAuthClientProfile: (_provider: string) => "cowork",
			getOAuthAccountIdentity: (_provider: string, _sessionId?: string) => ({ accountId: "acct-cowork-a" }),
			getCredentialOrigin: (_provider: string) => ({ kind: "oauth" }),
			removeCredential,
		} as unknown as AuthStorage;
		const refreshProvider = vi.fn(async (_providerId: string, _mode: string) => undefined);
		const presented = Promise.withResolvers<void>();
		const ctx = {
			editorContainer,
			editor: {},
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
			session: {
				sessionId: "session-logout-test",
				modelRegistry: {
					authStorage,
					refreshProvider,
				},
			},
			showError: vi.fn(),
			present: vi.fn(() => {
				presented.resolve();
			}),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		await controller.showOAuthSelector("logout", "anthropic-cowork");

		const selector = editorContainer.children[0];
		if (!(selector instanceof LogoutAccountSelectorComponent)) {
			throw new Error("Expected logout account selector");
		}
		const rendered = selector
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("cowork-a@example.com");
		expect(rendered).toContain("cowork-b@example.com");
		expect(rendered).not.toContain("claude@example.com");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		await presented.promise;

		expect(removeCredential).toHaveBeenCalledWith("anthropic", 22);
		expect(credentials.map(row => row.id)).toEqual([20, 21]);
		expect(refreshProvider).toHaveBeenCalledWith("anthropic", "online");
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.present).toHaveBeenCalled();
	});
});
