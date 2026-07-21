import { describe, expect, it } from "bun:test";
import { formatContextUsage } from "./context-thresholds";

describe("formatContextUsage", () => {
	it("renders percent/window by default", () => {
		expect(formatContextUsage(12.3, 1_000_000, 157_000)).toBe("12.3%/1M");
	});

	it("omits used tokens when showTokens is false", () => {
		expect(formatContextUsage(12.3, 1_000_000, 157_000, false)).toBe("12.3%/1M");
	});

	it("inserts used tokens between percent and window when showTokens is true", () => {
		expect(formatContextUsage(12.3, 1_000_000, 157_000, true)).toBe("12.3% 157K/1M");
	});

	it("falls back to tokens/? for unknown windows regardless of showTokens", () => {
		expect(formatContextUsage(null, 0, 157_000, true)).toBe("157K/?");
		expect(formatContextUsage(12.3, Number.NaN, 157_000, true)).toBe("157K/?");
	});

	it("renders missing percent as ? with tokens still shown", () => {
		expect(formatContextUsage(undefined, 1_000_000, 157_000, true)).toBe("? 157K/1M");
	});

	it("omits the tokens slot when usedTokens is undefined", () => {
		expect(formatContextUsage(12.3, 1_000_000, undefined, true)).toBe("12.3%/1M");
	});
});
