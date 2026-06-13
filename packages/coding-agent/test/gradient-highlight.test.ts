import { beforeAll, describe, expect, it } from "bun:test";
import { paintGradient } from "@oh-my-pi/pi-coding-agent/modes/gradient-highlight";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const SPEC = { stops: 8, hue: (t: number) => t * 330 };

describe("paintGradient", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("returns an empty string for empty input instead of a stray ANSI reset", () => {
		// Empty text must round-trip to empty; emitting only the reset escape would
		// leak \x1b[39m into otherwise-empty cells (e.g. an unset status badge).
		expect(paintGradient("", SPEC)).toBe("");
	});

	it("paints non-empty text and re-emits the reset so following text keeps its color", () => {
		const painted = paintGradient("Hi", SPEC, "\x1b[39m");
		expect(Bun.stripANSI(painted)).toBe("Hi");
		expect(painted.endsWith("\x1b[39m")).toBe(true);
	});
});
