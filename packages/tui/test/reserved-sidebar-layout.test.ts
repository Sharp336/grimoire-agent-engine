import { describe, expect, it } from "bun:test";
import {
	composeRightSidebar,
	type RightSidebarOptions,
	resolveRightSidebarLayout,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

const OPTIONS: RightSidebarOptions = {
	width: 44,
	minWidth: 28,
	minMainWidth: 64,
};

describe("resolveRightSidebarLayout", () => {
	it("uses the preferred width when the terminal has room", () => {
		expect(resolveRightSidebarLayout(120, OPTIONS)).toEqual({
			terminalWidth: 120,
			mainWidth: 76,
			sidebarWidth: 44,
			sidebarContentWidth: 43,
			visible: true,
		});
	});

	it("shrinks the sidebar before the main content", () => {
		expect(resolveRightSidebarLayout(100, OPTIONS)).toEqual({
			terminalWidth: 100,
			mainWidth: 64,
			sidebarWidth: 36,
			sidebarContentWidth: 35,
			visible: true,
		});
	});

	it("is visible exactly at the minimum combined width", () => {
		expect(resolveRightSidebarLayout(92, OPTIONS)).toEqual({
			terminalWidth: 92,
			mainWidth: 64,
			sidebarWidth: 28,
			sidebarContentWidth: 27,
			visible: true,
		});
	});

	it("gives the full terminal to main content below the threshold", () => {
		expect(resolveRightSidebarLayout(91, OPTIONS)).toEqual({
			terminalWidth: 91,
			mainWidth: 91,
			sidebarWidth: 0,
			sidebarContentWidth: 0,
			visible: false,
		});
	});

	it("normalizes fractional and inverted dimensions", () => {
		expect(
			resolveRightSidebarLayout(80, {
				width: 10.9,
				minWidth: 30.2,
				minMainWidth: 1.8,
			}),
		).toEqual({
			terminalWidth: 80,
			mainWidth: 70,
			sidebarWidth: 10,
			sidebarContentWidth: 9,
			visible: true,
		});
	});
});

describe("composeRightSidebar", () => {
	it("places the separator at mainWidth and preserves ANSI width", () => {
		const layout = resolveRightSidebarLayout(120, OPTIONS);
		const result = composeRightSidebar(["main", "\x1b[31mcolored\x1b[0m"], ["side", "quota 42%"], layout);

		expect(result).toHaveLength(2);
		expect(visibleWidth(result[0]!)).toBeLessThanOrEqual(120);
		expect(result[0]!.indexOf("│")).toBeGreaterThan(0);
		expect(result[0]).toContain("side");
		expect(result[1]).toContain("\x1b[31mcolored\x1b[0m");
		expect(result[1]).toContain("quota 42%");
	});

	it("returns the original window reference when hidden", () => {
		const window = ["main"] as const;
		const layout = resolveRightSidebarLayout(91, OPTIONS);
		expect(composeRightSidebar(window, ["side"], layout)).toBe(window);
	});
});
