import { afterEach, describe, expect, it } from "bun:test";
import { resolveHangulCompatibilityJamoWidthFromTerminalIdentity } from "@oh-my-pi/pi-tui/terminal";
import {
	resetHangulCompatibilityJamoWidthForTests,
	setHangulCompatibilityJamoWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui/utils";

describe("Hangul Compatibility Jamo width terminal-identity resolution", () => {
	it("forces wide (2) for Ghostty, platform default otherwise", () => {
		// Ghostty follows UAX#11 and renders Hangul Compatibility Jamo at 2 cells;
		// every other terminal keeps the platform default (macOS narrow, otherwise
		// UAX#11), so the override is a no-op outside Ghostty.
		expect(
			resolveHangulCompatibilityJamoWidthFromTerminalIdentity({
				GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
			}),
		).toBe(2);
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "ghostty" })).toBe(2);
		// Ghostty identified only via TERM (env-filtered shells that drop
		// GHOSTTY_RESOURCES_DIR / TERM_PROGRAM) must still resolve wide — mirrors
		// the Ghostty detection in terminal-capabilities.ts.
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM: "xterm-ghostty" })).toBe(2);
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "iTerm.app" })).toBe("platform");
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "Apple_Terminal" })).toBe(
			"platform",
		);
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({})).toBe("platform");
	});

	it("resolves WarpTerminal to narrow (1), case-insensitively and only on the exact identity", () => {
		// Warp reports TERM_PROGRAM=WarpTerminal and renders Hangul Compatibility
		// Jamo at one cell, disagreeing with UAX#11's two on the Linux platform
		// default; the resolver opts it into the narrow width profile.
		for (const id of ["WarpTerminal", "warpterminal", "WARPTERMINAL"]) {
			expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: id })).toBe(1);
		}
		// Ghostty still wins when both identities are present.
		expect(
			resolveHangulCompatibilityJamoWidthFromTerminalIdentity({
				TERM_PROGRAM: "WarpTerminal",
				GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
			}),
		).toBe(2);
		// Only the exact program opts in — a prefix, suffix, or TERM substring is
		// not Warp and keeps the platform default.
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "warp" })).toBe("platform");
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "warpterminal-x" })).toBe(
			"platform",
		);
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM: "xterm-warp" })).toBe("platform");
	});
});

describe("resolved profile drives the measured jamo width", () => {
	afterEach(() => {
		resetHangulCompatibilityJamoWidthForTests();
	});

	// End-to-end: the resolved terminal profile, pushed into the shared width
	// engine, changes the measured width of Compatibility Jamo (U+3131..U+318E)
	// — narrow (1) for Warp, wide (2) for Ghostty. Canonical conjoining Jamo
	// (U+1100..U+11FF), the same syllable decomposed, is the control: it is
	// outside the corrected block and measures the same under either profile.
	it("measures Compatibility Jamo per the resolved profile; canonical Jamo is the control", () => {
		const compatJamo = "\u314e\u314f\u3134"; // ㅎㅏㄴ
		const canonicalConjoiningJamo = "\u1112\u1161\u11ab"; // 한 (decomposed)

		setHangulCompatibilityJamoWidth(
			resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "WarpTerminal" }),
		);
		expect(visibleWidth(compatJamo)).toBe(3);
		const conjoiningWarp = visibleWidth(canonicalConjoiningJamo);

		setHangulCompatibilityJamoWidth(
			resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "ghostty" }),
		);
		expect(visibleWidth(compatJamo)).toBe(6);
		expect(visibleWidth(canonicalConjoiningJamo)).toBe(conjoiningWarp);
	});
});
