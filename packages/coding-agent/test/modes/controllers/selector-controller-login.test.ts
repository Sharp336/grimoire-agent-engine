import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { OAuthLoginCallbacks, OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import { LoginDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/login-dialog";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

interface RenderableBlock {
	render(width: number): string[];
}

function renderPresented(blocks: unknown[]): string {
	return blocks
		.flatMap(block => {
			const maybeRenderable = block as Partial<RenderableBlock>;
			return maybeRenderable.render ? maybeRenderable.render(120) : [String(block)];
		})
		.join("\n");
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SelectorController login", () => {
	it("presents OAuth success as soon as credentials are saved", async () => {
		const loginSaved = Promise.withResolvers<void>();
		const presentedBlocks: unknown[] = [];
		const prompt = {
			message: "Paste your token",
			secret: true,
			allowEmpty: true,
		} satisfies OAuthPrompt;
		const showPrompt = vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("");
		const authStorage = {
			login: vi.fn(async (_provider: string, callbacks: OAuthLoginCallbacks) => {
				await callbacks.onPrompt(prompt);
				loginSaved.resolve();
			}),
		} as unknown as AuthStorage;
		const refresh = vi.fn(() => new Promise<void>(() => {}));
		const refreshInBackground = vi.fn();
		const ctx = {
			oauthManualInput: {
				waitForInput: vi.fn(),
				clear: vi.fn(),
			},
			session: {
				modelRegistry: {
					authStorage,
					refresh,
					refreshInBackground,
				},
			},
			// The login flow swaps the editor slot for the cancellable dialog
			// and restores it when the flow settles.
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		void controller.showOAuthSelector("login", "xai-oauth");
		await loginSaved.promise;
		await Promise.resolve();

		expect(renderPresented(presentedBlocks)).toContain("Successfully logged in to xai-oauth");
		expect(refreshInBackground).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(showPrompt).toHaveBeenCalledWith(prompt);
	});

	it("Esc during a pending login aborts the flow and restores the editor", async () => {
		const login = vi.fn(
			(_provider: string, ctrl: { signal?: AbortSignal }) =>
				new Promise<void>((_resolve, reject) => {
					ctrl.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const authStorage = { login } as unknown as AuthStorage;
		const editorSlot: unknown[] = [];
		const editor = {};
		const presentedBlocks: unknown[] = [];
		const ctx = {
			oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
			session: { modelRegistry: { authStorage, refreshInBackground: vi.fn() } },
			editorContainer: {
				clear: vi.fn(() => editorSlot.splice(0)),
				addChild: vi.fn((child: unknown) => editorSlot.push(child)),
				children: editorSlot,
			},
			editor,
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		const loginDone = controller.showOAuthSelector("login", "xai-oauth");
		const dialog = editorSlot[0] as { handleInput(data: string): void };
		expect(dialog).toBeDefined();
		expect(dialog).not.toBe(editor);

		dialog.handleInput("\x1b"); // Esc cancels the pairing wait
		await loginDone;

		// The abort is user-driven: no error surfaced, the cancellation is
		// announced, and the editor owns the slot again.
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Login cancelled");
		expect(editorSlot).toEqual([editor]);
		expect(renderPresented(presentedBlocks)).not.toContain("Successfully logged in");
	});

	it("keeps secret OAuth prompts hidden and purges their input state before the next prompt", async () => {
		const secretMarker = "SENTINEL_TOKEN_XYZ";
		const rawSecret = `  ${secretMarker}  `;
		const tui = new TUI(new VirtualTerminal(120, 20));
		const dialog = new LoginDialogComponent(tui, "xai-oauth", () => {});

		try {
			const rawSecretSubmitted = dialog.showPrompt({
				message: "Paste your token",
				secret: true,
			});
			dialog.handleInput(rawSecret);
			const hiddenPrompt = stripVTControlCharacters(dialog.render(120).join("\n"));
			expect(hiddenPrompt).toContain("Input hidden");
			expect(hiddenPrompt).not.toContain(secretMarker);
			dialog.handleInput("\n");
			expect(await rawSecretSubmitted).toBe(rawSecret);

			const blankSubmitted = dialog.showPrompt({
				message: "Paste a token or leave blank",
				secret: true,
				allowEmpty: true,
			});
			dialog.handleInput("\n");
			expect(await blankSubmitted).toBe("");

			const clearedSecret = dialog.showPrompt({
				message: "Clear sensitive input",
				secret: true,
				allowEmpty: true,
			});
			dialog.handleInput(rawSecret);
			dialog.handleInput("\x01"); // Ctrl+A
			dialog.handleInput("\x0b"); // Ctrl+K, puts the token in the kill ring
			dialog.handleInput("\n");
			await clearedSecret;

			const ordinaryPrompt = dialog.showPrompt({
				message: "Ordinary prompt",
				allowEmpty: true,
			});
			dialog.handleInput("\x1f"); // Ctrl+_, undo
			dialog.handleInput("\x19"); // Ctrl+Y, yank
			const renderedOrdinaryPrompt = stripVTControlCharacters(dialog.render(120).join("\n"));
			expect(renderedOrdinaryPrompt).not.toContain(secretMarker);
			dialog.handleInput("\n");
			await ordinaryPrompt;
		} finally {
			tui.stop();
		}
	});

	it("purges cancelled secret prompts before a later ordinary prompt", async () => {
		const secretMarker = "CANCELLED_SENTINEL_TOKEN_XYZ";
		const tui = new TUI(new VirtualTerminal(120, 20));
		const dialog = new LoginDialogComponent(tui, "xai-oauth", () => {});

		try {
			const cancelledPrompt = dialog.showPrompt({
				message: "Paste your token",
				secret: true,
			});
			dialog.handleInput(secretMarker);
			dialog.handleInput("\x01"); // Ctrl+A
			dialog.handleInput("\x0b"); // Ctrl+K, puts the token in the kill ring
			dialog.handleInput("\x1b");
			await expect(cancelledPrompt).rejects.toThrow("Login cancelled");

			const ordinaryPrompt = dialog.showPrompt({
				message: "Ordinary prompt",
				allowEmpty: true,
			});
			dialog.handleInput("\x1f"); // Ctrl+_, undo
			dialog.handleInput("\x19"); // Ctrl+Y, yank
			const renderedOrdinaryPrompt = stripVTControlCharacters(dialog.render(120).join("\n"));
			expect(renderedOrdinaryPrompt).not.toContain(secretMarker);
			dialog.handleInput("\n");
			await ordinaryPrompt;
		} finally {
			tui.stop();
		}
	});
});
