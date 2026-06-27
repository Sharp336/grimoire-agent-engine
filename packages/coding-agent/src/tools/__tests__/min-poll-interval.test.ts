import { describe, expect, test } from "bun:test";
import { clampWaitMs, parseWaitDurationMs } from "../job";
describe("parseWaitDurationMs", () => {
	test("parses known durations", () => {
		expect(parseWaitDurationMs("5s")).toBe(5_000);
		expect(parseWaitDurationMs("10s")).toBe(10_000);
		expect(parseWaitDurationMs("30s")).toBe(30_000);
		expect(parseWaitDurationMs("1m")).toBe(60_000);
		expect(parseWaitDurationMs("5m")).toBe(5 * 60_000);
	});

	test("falls back to 30s for undefined", () => {
		expect(parseWaitDurationMs(undefined)).toBe(30_000);
	});

	test("falls back to 30s for unknown values", () => {
		expect(parseWaitDurationMs("invalid")).toBe(30_000);
	});

	test("falls back to 30s for empty string", () => {
		expect(parseWaitDurationMs("")).toBe(30_000);
	});
});

describe("min poll interval floor", () => {
	test("applies no clamping when no setting is provided (default 0)", () => {
		const result = clampWaitMs(5_000, undefined);
		expect(result).toBe(5_000);
	});

	test("allows 5s poll when min is lower (no-clamp scenario)", () => {
		// waitMs=5000, min set to 2s — no clamping needed
		const result = clampWaitMs(5_000, 2);
		expect(result).toBe(5_000);
	});

	test("clamps to a custom 2min (120s) when computed wait is shorter", () => {
		const result = clampWaitMs(5_000, 120);
		expect(result).toBe(120_000);
	});

	test("respects custom min of 600s (10min) even with long smart-ladder max", () => {
		const result = clampWaitMs(300_000, 600);
		expect(result).toBe(600_000);
	});

	test("min wins when min exceeds computed wait (safest behavior)", () => {
		// 5s smart-ladder floor clamped to 5min floor = 5min
		const result = clampWaitMs(5_000, 300);
		expect(result).toBe(300_000);
	});

	test("handles 0 min poll interval by allowing the ladder floor to pass through", () => {
		const result = clampWaitMs(5_000, 0);
		expect(result).toBe(5_000);
	});

	test("ignores non-numeric setting and falls back to 0 (no clamping)", () => {
		expect(clampWaitMs(5_000, "invalid")).toBe(5_000);
		expect(clampWaitMs(5_000, null)).toBe(5_000);
		expect(clampWaitMs(5_000, "")).toBe(5_000);
	});

	test("combined path: fixed duration + min floor", () => {
		// Using a fixed "5s" duration with 2min floor → result is 2min
		const waitMs = parseWaitDurationMs("5s"); // 5_000
		const result = clampWaitMs(waitMs, 120);
		expect(result).toBe(120_000);
	});

	test("combined path: smart ladder + min floor", () => {
		// Simulate a cold smart-poll ladder returning 5s, with a 5min floor → result is 5min
		const result = clampWaitMs(5_000, 300);
		expect(result).toBe(300_000);
	});
});
