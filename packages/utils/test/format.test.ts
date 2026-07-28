import { describe, expect, it } from "bun:test";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils/format";

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

describe("formatBytes", () => {
	it("preserves the compact default format", () => {
		expect(formatBytes(0)).toBe("0B");
		expect(formatBytes(1024)).toBe("1.0KB");
		expect(formatBytes(1.5 * 1024 ** 2)).toBe("1.5MB");
	});

	it("supports a spaced minimum-unit display without trailing zeroes", () => {
		const options = { minimumUnit: "KB", unitSeparator: " ", trimTrailingZero: true } as const;
		expect(formatBytes(0, options)).toBe("0 KB");
		expect(formatBytes(1536, options)).toBe("1.5 KB");
		expect(formatBytes(1024 ** 2, options)).toBe("1 MB");
		expect(formatBytes(1.75 * 1024 ** 2, options)).toBe("1.8 MB");
	});
});
