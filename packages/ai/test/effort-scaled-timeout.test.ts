import { describe, expect, it } from "bun:test";
import { scaleIdleTimeoutByEffort } from "../src/utils/idle-iterator";

describe("scaleIdleTimeoutByEffort", () => {
	it("returns undefined unchanged (disabled watchdog)", () => {
		expect(scaleIdleTimeoutByEffort(undefined, "high")).toBeUndefined();
		expect(scaleIdleTimeoutByEffort(undefined, "max")).toBeUndefined();
		expect(scaleIdleTimeoutByEffort(undefined, undefined)).toBeUndefined();
	});

	it("does not scale for low/medium/minimal effort", () => {
		expect(scaleIdleTimeoutByEffort(120_000, "low")).toBe(120_000);
		expect(scaleIdleTimeoutByEffort(120_000, "medium")).toBe(120_000);
		expect(scaleIdleTimeoutByEffort(120_000, "minimal")).toBe(120_000);
	});

	it("scales high by 2x", () => {
		expect(scaleIdleTimeoutByEffort(120_000, "high")).toBe(240_000);
	});

	it("scales xhigh by 3x", () => {
		expect(scaleIdleTimeoutByEffort(120_000, "xhigh")).toBe(360_000);
	});

	it("scales max by 4x", () => {
		expect(scaleIdleTimeoutByEffort(120_000, "max")).toBe(480_000);
	});

	it("does not scale for unrecognized effort", () => {
		expect(scaleIdleTimeoutByEffort(120_000, "unknown")).toBe(120_000);
		expect(scaleIdleTimeoutByEffort(120_000, undefined)).toBe(120_000);
		expect(scaleIdleTimeoutByEffort(120_000, "")).toBe(120_000);
	});

	it("does not scale 'none' (Codex disables reasoning)", () => {
		expect(scaleIdleTimeoutByEffort(120_000, "none")).toBe(120_000);
	});
});
