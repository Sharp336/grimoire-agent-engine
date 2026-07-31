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

	it("does not scale 'adaptive' (Anthropic delegates think budget to Claude)", () => {
		// Adaptive effort is not a fixed-think-time tier; it delegates the think
		// budget to Claude, so it must not inflate the watchdog.
		expect(scaleIdleTimeoutByEffort(120_000, "adaptive")).toBe(120_000);
	});
});

// mapOptionsForApi preserves `reasoning` on the base options, but direct
// callers may set `effort` instead of `reasoning`. The provider derives
// the effective effort via `options?.reasoning ?? options?.effort`.
describe("Anthropic effective-effort fallback", () => {
	it("scales via the effort field for direct callers that skip reasoning", () => {
		// Direct caller sets effort="high" without going through mapOptionsForApi
		const reasoning: string | undefined = undefined;
		const effort: string | undefined = "high";
		const effectiveEffort = reasoning ?? effort;
		expect(scaleIdleTimeoutByEffort(120_000, effectiveEffort)).toBe(240_000);
	});

	it("prefers reasoning when both are set (direct-caller path)", () => {
		const reasoning: string | undefined = "max";
		const effort: string | undefined = "high";
		const effectiveEffort = reasoning ?? effort;
		expect(scaleIdleTimeoutByEffort(120_000, effectiveEffort)).toBe(480_000);
	});

	it("does not scale when neither reasoning nor effort is set", () => {
		const reasoning: string | undefined = undefined;
		const effort: string | undefined = undefined;
		const effectiveEffort = reasoning ?? effort;
		expect(scaleIdleTimeoutByEffort(120_000, effectiveEffort)).toBe(120_000);
	});
});
