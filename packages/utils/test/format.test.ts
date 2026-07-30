import { describe, expect, it } from "bun:test";
import {
	formatAge,
	formatBytes,
	formatCount,
	formatDuration,
	formatNumber,
	formatPercent,
	pluralize,
	truncate,
} from "@oh-my-pi/pi-utils/format";

describe("formatDuration", () => {
	// Codex's wham/usage endpoint returns the prior window's reset_at until the
	// next request opens a fresh window, so the `resetsAt - now` delta can land
	// in the recent past. The util must defend against that — older builds
	// rendered "-612090ms", which leaked straight into the /usage TUI.
	it("clamps non-positive, NaN, and Infinity inputs to 0ms", () => {
		expect(formatDuration(-612_090)).toBe("0ms");
		expect(formatDuration(-1)).toBe("0ms");
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(Number.NaN)).toBe("0ms");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
		expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe("0ms");
	});

	it("formats sub-second, sub-minute, sub-hour, sub-day, and multi-day ranges", () => {
		expect(formatDuration(500)).toBe("500ms");
		expect(formatDuration(1_500)).toBe("1.5s");
		expect(formatDuration(90_000)).toBe("1m30s");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_660_000)).toBe("1h1m");
		expect(formatDuration(2 * 86_400_000 + 3_600_000)).toBe("2d1h");
	});
});
describe("formatNumber", () => {
	it("handles non-finite inputs by returning '0'", () => {
		expect(formatNumber(Number.NaN)).toBe("0");
		expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0");
		expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe("0");
	});

	it("formats sub-thousand integers accurately", () => {
		expect(formatNumber(0)).toBe("0");
		expect(formatNumber(500)).toBe("500");
		expect(formatNumber(999)).toBe("999");
	});

	it("formats thousands with decimal or rounded suffix", () => {
		expect(formatNumber(1_000)).toBe("1K");
		expect(formatNumber(1_500)).toBe("1.5K");
		expect(formatNumber(9_949)).toBe("9.9K");
		expect(formatNumber(9_950)).toBe("10K");
		expect(formatNumber(25_000)).toBe("25K");
		expect(formatNumber(994_999)).toBe("995K");
		expect(formatNumber(995_000)).toBe("995K");
	});

	it("prevents 1000K rollover at tier boundary by advancing to 1M", () => {
		expect(formatNumber(999_500)).toBe("1M");
		expect(formatNumber(999_999)).toBe("1M");
		expect(formatNumber(1_000_000)).toBe("1M");
		expect(formatNumber(1_500_000)).toBe("1.5M");
		expect(formatNumber(9_949_000)).toBe("9.9M");
		expect(formatNumber(9_950_000)).toBe("10M");
		expect(formatNumber(25_000_000)).toBe("25M");
		expect(formatNumber(994_999_000)).toBe("995M");
		expect(formatNumber(995_000_000)).toBe("995M");
	});
	it("prevents 1000M rollover at tier boundary by advancing to 1B", () => {
		expect(formatNumber(999_500_000)).toBe("1B");
		expect(formatNumber(999_999_999)).toBe("1B");
		expect(formatNumber(1_000_000_000)).toBe("1B");
		expect(formatNumber(1_500_000_000)).toBe("1.5B");
		expect(formatNumber(9_949_000_000)).toBe("9.9B");
		expect(formatNumber(9_950_000_000)).toBe("10B");
	});

	it("preserves negative sign while applying tier formatting", () => {
		expect(formatNumber(-500)).toBe("-500");
		expect(formatNumber(-1_500)).toBe("-1.5K");
		expect(formatNumber(-999_500)).toBe("-1M");
		expect(formatNumber(-1_500_000)).toBe("-1.5M");
		expect(formatNumber(-1_500_000_000)).toBe("-1.5B");
	});
});

describe("formatBytes", () => {
	it("handles invalid or non-positive bytes", () => {
		expect(formatBytes(-100)).toBe("0B");
		expect(formatBytes(0)).toBe("0B");
		expect(formatBytes(Number.NaN)).toBe("0B");
	});

	it("formats byte units correctly", () => {
		expect(formatBytes(512)).toBe("512B");
		expect(formatBytes(1536)).toBe("1.5KB");
		expect(formatBytes(2 * 1024 * 1024)).toBe("2.0MB");
	});
});

describe("formatPercent", () => {
	it("handles non-finite inputs", () => {
		expect(formatPercent(Number.NaN)).toBe("0.0%");
		expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("0.0%");
	});

	it("formats ratios to single decimal percentages", () => {
		expect(formatPercent(0.5)).toBe("50.0%");
		expect(formatPercent(0.1234)).toBe("12.3%");
	});
});
