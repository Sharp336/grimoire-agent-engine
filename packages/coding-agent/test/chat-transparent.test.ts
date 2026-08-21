import { beforeAll, describe, expect, test } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { loadTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import { initTheme, setChatTransparent, setTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Regression tests for #2394: TUI panels render as unreadable black blocks in
 * Ghostty (and other terminals whose default background clashes with the
 * theme's opaque panel fills).
 *
 * The `chat.transparent` setting drops the opaque background fill from
 * chat-owned surfaces (user messages, custom messages, tool panels) so they
 * render on the terminal's default background, while non-chat surfaces such
 * as the status line and selection highlight keep their fills.
 */

const CHAT_SURFACES = ["userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const;
const OPAQUE_BG = /\x1b\[48;/;
const DEFAULT_BG = "\x1b[49m";

describe("chat.transparent (#2394)", () => {
	beforeAll(async () => {
		await initTheme();
		await setTheme("titanium");
	});

	test("default: chat surfaces render the theme's opaque fills", async () => {
		await setChatTransparent(false);
		for (const key of CHAT_SURFACES) {
			expect(theme.getBgAnsi(key)).toMatch(OPAQUE_BG);
		}
		const rendered = new UserMessageComponent("hello world").render(80).join("\n");
		expect(rendered).toContain("\x1b[48;");
	});

	test("enabled: chat surfaces drop to the terminal default background", async () => {
		await setChatTransparent(true);
		for (const key of CHAT_SURFACES) {
			expect(theme.getBgAnsi(key)).toBe(DEFAULT_BG);
		}
		const rendered = new UserMessageComponent("hello world").render(80).join("\n");
		expect(rendered).not.toContain("\x1b[48;");
	});

	test("enabled: non-chat surfaces keep their opaque fills", async () => {
		await setChatTransparent(true);
		expect(theme.getBgAnsi("statusLineBg")).toMatch(OPAQUE_BG);
		expect(theme.getBgAnsi("selectedBg")).toMatch(OPAQUE_BG);
	});

	test("disabling restores the opaque fills", async () => {
		await setChatTransparent(true);
		await setChatTransparent(false);
		for (const key of CHAT_SURFACES) {
			expect(theme.getBgAnsi(key)).toMatch(OPAQUE_BG);
		}
	});

	test("loadTheme honors the chatTransparent option directly", async () => {
		const transparent = await loadTheme("titanium", { chatTransparent: true });
		for (const key of CHAT_SURFACES) {
			expect(transparent.getBgAnsi(key)).toBe(DEFAULT_BG);
		}
		expect(transparent.getBgAnsi("statusLineBg")).toMatch(OPAQUE_BG);

		const opaque = await loadTheme("titanium", {});
		for (const key of CHAT_SURFACES) {
			expect(opaque.getBgAnsi(key)).toMatch(OPAQUE_BG);
		}
	});
});
