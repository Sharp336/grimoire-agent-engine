import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { SignInTab } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/sign-in";
import type { SetupSceneHost } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type { Component } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createAuthStorage(
	login: (provider: OAuthProviderId, ctrl: OAuthLoginCallbacks) => Promise<void>,
): AuthStorage {
	return {
		has: (_providerId: string) => false,
		hasAuth: (_providerId: string) => false,
		getCredentialOrigin: (_providerId: string) => undefined,
		login,
	} as AuthStorage;
}

function createHost(
	authStorage: AuthStorage,
	openedUrls: string[],
	setFocused: (component: Component | undefined) => void,
): SetupSceneHost {
	const host: SetupSceneHost = Object.assign(Object.create(null), {
		ctx: {
			openInBrowser(url: string): void {
				openedUrls.push(url);
			},
			session: {
				modelRegistry: {
					authStorage,
					async refresh(): Promise<void> {},
				},
			},
		},
		requestRender(): void {},
		finish(): void {},
		setFocus(component: Component | null): void {
			setFocused(component ?? undefined);
		},
		restoreFocus(): void {},
	});
	return host;
}

function sendInput(component: Component | undefined, data: string): void {
	if (!component?.handleInput) {
		throw new Error("Expected a focused prompt input");
	}
	component.handleInput(data);
}

function typeInput(component: Component | undefined, value: string): void {
	for (const char of value) {
		sendInput(component, char);
	}
}

function renderText(component: Component, width = 120): string {
	return component
		.render(width)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function selectAnthropic(tab: SignInTab): void {
	typeInput(tab, "anthropic");
	tab.handleInput("\n");
}

describe("SignInTab", () => {
	it("keeps the OSC8 login link and manual-code prompt above clipped wizard rows", async () => {
		const url = `https://example.com/oauth/authorize?client_id=omp&redirect_uri=http%3A%2F%2Flocalhost%3A45454%2Fcallback&state=${"a".repeat(96)}`;
		const loginGate = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		let focusTarget: Component | undefined;
		const openedUrls: string[] = [];

		const authStorage = createAuthStorage(
			async (_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> => {
				ctrl.onAuth({ url });
				const prompt = ctrl.onManualCodeInput?.();
				await loginGate.promise;
				await prompt;
			},
		);

		const host = createHost(authStorage, openedUrls, component => {
			focusTarget = component;
		});

		const tab = new SignInTab(host);
		try {
			selectAnthropic(tab);
			const rendered = tab.render(36);
			const compact = rendered.map(line => Bun.stripANSI(line).trim()).join("");
			expect(compact).toContain(url);
			expect(compact).not.toContain("…");
			expect(rendered.join("\n")).toContain(`\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`);
			expect(openedUrls).toEqual([url]);
			expect(focusTarget).toBeDefined();
			sendInput(focusTarget, "\x1bc");
			expect(copySpy).toHaveBeenCalledTimes(2);
			expect(copySpy).toHaveBeenLastCalledWith(url);

			// On a ~24-row terminal the wizard body ends up ~8 rows; the OSC8
			// link, a plain URL row, and the focused input must survive that clip.
			const clippedBody = rendered.slice(0, 8).map(line => Bun.stripANSI(line).trim());
			const plainUrlIndex = clippedBody.findIndex(line => line.startsWith("https://example.com/oauth/authorize?"));
			const inputIndex = clippedBody.findIndex(line => line.startsWith(">"));
			expect(clippedBody.some(line => line.startsWith("Browser login: Open login URL"))).toBe(true);
			expect(plainUrlIndex).toBeGreaterThanOrEqual(0);
			expect(clippedBody).toContain("Paste the authorization code (or full redirect URL):");
			expect(inputIndex).toBeGreaterThanOrEqual(0);
			expect(plainUrlIndex).toBeLessThan(inputIndex);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});

	it("copies the active login URL from the keyboard while the setup TUI owns selection", async () => {
		const url = "https://example.com/oauth/authorize?client_id=omp&state=copy";
		const loginGate = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

		const authStorage = createAuthStorage(
			async (_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> => {
				ctrl.onAuth({ url });
				await loginGate.promise;
			},
		);

		const host = createHost(authStorage, [], () => {});

		const tab = new SignInTab(host);
		try {
			selectAnthropic(tab);
			await Promise.resolve();
			expect(copySpy).toHaveBeenCalledTimes(1);

			tab.handleInput("\x1bc");
			await Promise.resolve();
			expect(copySpy).toHaveBeenCalledTimes(2);
			expect(copySpy).toHaveBeenLastCalledWith(url);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});
	it("masks a secret OAuth prompt while returning the raw pasted value to login", async () => {
		const secret = "secret-cleartext-sentinel";
		const submitted = Promise.withResolvers<string>();
		let focusTarget: Component | undefined;
		const authStorage = createAuthStorage(
			async (_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> => {
				const prompt = ctrl.onPrompt?.({
					message: "Paste the secret token:",
					secret: true,
					allowEmpty: true,
				});
				if (!prompt) {
					throw new Error("Expected OAuth prompt callback");
				}
				submitted.resolve(await prompt);
			},
		);
		const host = createHost(authStorage, [], component => {
			focusTarget = component;
		});
		const tab = new SignInTab(host);

		try {
			selectAnthropic(tab);
			typeInput(focusTarget, secret);

			const rendered = renderText(tab);
			expect(rendered).not.toContain(secret);
			expect(rendered).toContain("•".repeat([...secret].length));

			sendInput(focusTarget, "\n");
			expect(await submitted.promise).toBe(secret);
			expect(renderText(tab)).not.toContain(secret);
		} finally {
			tab.dispose();
		}
	});

	it("uses browser OAuth when an allow-empty secret prompt is submitted blank", async () => {
		const url = "https://example.com/oauth/browser-fallback";
		const submitted = Promise.withResolvers<string>();
		const openedUrls: string[] = [];
		let focusTarget: Component | undefined;
		const authStorage = createAuthStorage(
			async (_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> => {
				const prompt = ctrl.onPrompt?.({
					message: "Paste the secret token:",
					secret: true,
					allowEmpty: true,
				});
				if (!prompt) {
					throw new Error("Expected OAuth prompt callback");
				}
				const value = await prompt;
				submitted.resolve(value);
				if (value === "") {
					ctrl.onAuth({ url });
				}
			},
		);
		const host = createHost(authStorage, openedUrls, component => {
			focusTarget = component;
		});
		const tab = new SignInTab(host);

		try {
			selectAnthropic(tab);
			sendInput(focusTarget, "\n");

			expect(await submitted.promise).toBe("");
			expect(openedUrls).toEqual([url]);
		} finally {
			tab.dispose();
		}
	});

	it("purges a cancelled secret prompt so undo cannot recover its value", async () => {
		const secret = "cancelled-secret-sentinel";
		const cancelled = Promise.withResolvers<string>();
		let focusTarget: Component | undefined;
		const authStorage = createAuthStorage(
			async (_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> => {
				const prompt = ctrl.onPrompt?.({ message: "Paste the secret token:", secret: true });
				if (!prompt) {
					throw new Error("Expected OAuth prompt callback");
				}
				cancelled.resolve(await prompt);
				if (!ctrl.signal?.aborted) {
					throw new Error("Expected cancelled login signal");
				}
				throw new Error("Login cancelled");
			},
		);
		const host = createHost(authStorage, [], component => {
			focusTarget = component;
		});
		const tab = new SignInTab(host);

		try {
			selectAnthropic(tab);
			typeInput(focusTarget, secret);
			const rendered = renderText(tab);
			expect(rendered).not.toContain(secret);
			expect(rendered).toContain("•".repeat([...secret].length));

			sendInput(focusTarget, "\x1b");
			expect(await cancelled.promise).toBe("");

			sendInput(focusTarget, "\x1f");
			if (!focusTarget) {
				throw new Error("Expected a focused prompt input");
			}
			const afterCancel = renderText(focusTarget);
			expect(afterCancel).not.toContain(secret);
			expect(afterCancel).not.toContain("•");
		} finally {
			tab.dispose();
		}
	});
});
