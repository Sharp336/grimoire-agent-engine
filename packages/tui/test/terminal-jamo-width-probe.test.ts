import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { detectTerminalId, getTerminalInfo } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getHangulCompatibilityJamoWidth, resetHangulCompatibilityJamoWidthForTests } from "@oh-my-pi/pi-tui/utils";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

function jamoWidthFor(env: NodeJS.ProcessEnv): "platform" | "unicode" | 1 | 2 {
	return getTerminalInfo(detectTerminalId(env)).hangulJamoWidth;
}

describe("Hangul Compatibility Jamo width terminal capability", () => {
	it("forces wide for Ghostty, narrow for Warp, and the platform default otherwise", () => {
		// Ghostty follows UAX#11 and renders Hangul Compatibility Jamo at 2 cells;
		// Warp renders them at 1 cell. Every other terminal keeps the platform
		// default (macOS narrow, otherwise UAX#11).
		expect(jamoWidthFor({ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app" })).toBe(2);
		expect(jamoWidthFor({ TERM_PROGRAM: "ghostty" })).toBe(2);
		// Ghostty identified only via TERM (env-filtered shells that drop
		// GHOSTTY_RESOURCES_DIR / TERM_PROGRAM) must still resolve wide — mirrors
		// the Ghostty detection in terminal-capabilities.ts.
		expect(jamoWidthFor({ TERM: "xterm-ghostty" })).toBe(2);
		expect(jamoWidthFor({ TERM_PROGRAM: "WarpTerminal" })).toBe(1);
		expect(jamoWidthFor({ TERM_PROGRAM: "iTerm.app" })).toBe("platform");
		expect(jamoWidthFor({ TERM_PROGRAM: "Apple_Terminal" })).toBe("platform");
		expect(jamoWidthFor({})).toBe("platform");
	});
});

// The runtime CPR probe must correct the static table (e.g. Apple_Terminal
// resolves "platform", but Terminal.app 2.15 with SF Mono actually renders
// Compatibility Jamo at 2 cells — measured via DSR/CPR col 3 after `ㅁ`).
// These suites drive the real ProcessTerminal start() probe pipeline, so they
// opt out of the test-default headless suppression and opt into the probe.
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalProbeEnv = Bun.env.PI_TUI_JAMO_WIDTH_PROBE;
let previousHeadless = false;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("ProcessTerminal runtime Hangul Compatibility Jamo width CPR probe", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		previousHeadless = setTerminalHeadless(false);
		Bun.env.PI_TUI_JAMO_WIDTH_PROBE = "1";
		resetHangulCompatibilityJamoWidthForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		resetHangulCompatibilityJamoWidthForTests();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		if (originalProbeEnv === undefined) delete Bun.env.PI_TUI_JAMO_WIDTH_PROBE;
		else Bun.env.PI_TUI_JAMO_WIDTH_PROBE = originalProbeEnv;
	});

	function setupTerminal() {
		const writes: string[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		return { terminal, writes };
	}

	it("writes the probe glyph + CPR query and applies the measured 2-cell width", () => {
		vi.useFakeTimers();
		const { terminal, writes } = setupTerminal();

		// Probe payload: visible jamo ㅁ (U+3141) followed by DSR `CSI 6 n`.
		expect(writes.some(w => w.includes("\u3141\x1b[6n"))).toBe(true);

		// CPR reply: cursor at col 3 → the jamo occupies 2 cells.
		process.stdin.emit("data", "\x1b[1;3R");
		expect(getHangulCompatibilityJamoWidth()).toBe(2);

		// The late DA1 sentinel from other probes must not disturb the result.
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(getHangulCompatibilityJamoWidth()).toBe(2);

		terminal.stop();
	});

	it("applies the measured 1-cell width when the terminal reports col 2", () => {
		vi.useFakeTimers();
		const { terminal } = setupTerminal();

		process.stdin.emit("data", "\x1b[1;2R");
		expect(getHangulCompatibilityJamoWidth()).toBe(1);

		terminal.stop();
	});

	it("keeps the static fallback when the terminal never answers CPR", () => {
		vi.useFakeTimers();
		const { terminal } = setupTerminal();

		expect(getHangulCompatibilityJamoWidth()).toBe("platform");
		vi.advanceTimersByTime(800); // probe timeout (750 ms)
		expect(getHangulCompatibilityJamoWidth()).toBe("platform");

		terminal.stop();
	});

	it("swallows a late CPR reply so it never reaches the composer", () => {
		vi.useFakeTimers();
		const received: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const terminal = new ProcessTerminal();
		terminal.start(
			data => received.push(data),
			() => {},
		);
		// Answer CPR before the 750 ms timeout fires, then after stop() a
		// stray reply must be dropped (exclusively a terminal->host report).
		process.stdin.emit("data", "\x1b[1;3R");
		terminal.stop();
		process.stdin.emit("data", "\x1b[1;4R");
		expect(received).toEqual([]);
	});
});
