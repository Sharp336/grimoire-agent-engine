import { describe, expect, test } from "bun:test";
import { resolveDevinTemperature } from "@oh-my-pi/pi-ai/providers/devin";

describe("resolveDevinTemperature", () => {
	test("clamps temperature 0 to a near-zero floor", () => {
		// The Devin agent API rejects temperature: 0 with invalid_argument.
		// Callers requesting deterministic output (FastContext hint mode) must
		// get a clamped value instead of passing 0 through.
		expect(resolveDevinTemperature(0)).toBeGreaterThan(0);
		expect(resolveDevinTemperature(0)).toBeLessThanOrEqual(0.01);
	});

	test("passes through non-zero temperatures unchanged", () => {
		expect(resolveDevinTemperature(0.3)).toBe(0.3);
		expect(resolveDevinTemperature(0.4)).toBe(0.4);
		expect(resolveDevinTemperature(1)).toBe(1);
	});

	test("defaults to 0.4 when undefined", () => {
		expect(resolveDevinTemperature(undefined)).toBe(0.4);
	});
});
