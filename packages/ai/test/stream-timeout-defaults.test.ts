import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs } from "../src/utils/idle-iterator";

/**
 * Stream watchdog defaults.
 *
 * OMP follows Pi-style streaming by default: provider silence alone is not
 * treated as failure. Watchdogs are only armed when explicitly requested by env
 * or per-request StreamOptions.
 */

const ENV_KEYS = [
	"PI_STREAM_IDLE_TIMEOUT_MS",
	"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"PI_STREAM_FIRST_EVENT_TIMEOUT_MS",
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		originalEnv[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = originalEnv[key];
		if (prior === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = prior;
		}
	}
});

describe("getStreamIdleTimeoutMs(fallbackMs)", () => {
	it("does not arm an idle watchdog when env vars are unset", () => {
		expect(getStreamIdleTimeoutMs(300_000)).toBeUndefined();
	});

	it("lets PI_STREAM_IDLE_TIMEOUT_MS explicitly enable the watchdog", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(42);
	});

	it("treats PI_STREAM_IDLE_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "0";
		expect(getStreamIdleTimeoutMs(300_000)).toBeUndefined();
	});
});

describe("getStreamFirstEventTimeoutMs(idleTimeoutMs, fallbackMs)", () => {
	it("does not arm a first-event watchdog when env is unset", () => {
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBeUndefined();
	});

	it("does not inherit a timeout from the idle watchdog by default", () => {
		expect(getStreamFirstEventTimeoutMs(50_000, 300_000)).toBeUndefined();
	});

	it("does not use the per-provider fallback as a default timeout", () => {
		expect(getStreamFirstEventTimeoutMs(500_000, 300_000)).toBeUndefined();
	});

	it("lets PI_STREAM_FIRST_EVENT_TIMEOUT_MS explicitly enable the watchdog", () => {
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "42";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(42);
	});

	it("treats PI_STREAM_FIRST_EVENT_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "0";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBeUndefined();
	});

	it("does not arm a global first-event watchdog when no fallback or env is provided", () => {
		expect(getStreamFirstEventTimeoutMs()).toBeUndefined();
	});
});
