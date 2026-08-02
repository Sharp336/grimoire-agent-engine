import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { createMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { logger } from "@oh-my-pi/pi-utils";

const ORIGINAL_TIMEOUT = process.env.OMP_MCP_TIMEOUT_MS;

afterEach(() => {
	if (ORIGINAL_TIMEOUT === undefined) {
		delete process.env.OMP_MCP_TIMEOUT_MS;
	} else {
		process.env.OMP_MCP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
	}
});

describe("MCP timeout configuration", () => {
	test("uses the default timeout when no config or env override is set", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs()).toBe(30_000);
	});

	test("uses per-server timeout when env override is unset", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
	});

	test("allows the env override to disable MCP client-side timeouts", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "0";

		const timeout = resolveMCPTimeoutMs(30_000);
		expect(timeout).toBe(0);
		expect(isMCPTimeoutEnabled(timeout)).toBe(false);
	});

	test("allows the env override to set one timeout for every server", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(180_000);
	});

	test("rejects negative env values and warns, falling back to the default", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "-1";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("OMP_MCP_TIMEOUT_MS");
		} finally {
			warn.mockRestore();
		}
	});

	test("rejects non-numeric env values and falls back to the default", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "not-a-number";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs()).toBe(30_000);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("MCP timeout ordering", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function abortError(): Error {
		return new DOMException("aborted", "AbortError");
	}

	test("timeout-first: timedOut stays latched when the external signal aborts afterwards", () => {
		vi.useFakeTimers();
		const external = new AbortController();
		const operation = createMCPTimeout(100, external.signal);

		expect(operation.timedOut()).toBe(false);
		vi.advanceTimersByTime(100);

		// The timer fired first: the timeout contract must latch even though the
		// underlying abort controller is what the consumer's fetch saw.
		expect(operation.timedOut()).toBe(true);
		expect(operation.isTimeoutAbort(abortError())).toBe(true);

		// A later external abort must not rewrite the outcome: the error is still
		// reported as the timeout, not as an external cancellation. isTimeoutAbort
		// itself flips false (the external signal did abort), which is why the
		// transport consults timedOut() as the latched truth.
		external.abort();
		expect(operation.timedOut()).toBe(true);
		expect(operation.isTimeoutAbort(abortError())).toBe(false);

		operation.clear();
	});

	test("external-first: timedOut stays false until the timer fires; isTimeoutAbort stays false", () => {
		vi.useFakeTimers();
		const external = new AbortController();
		const operation = createMCPTimeout(100, external.signal);

		external.abort();
		expect(operation.timedOut()).toBe(false);
		expect(operation.isTimeoutAbort(abortError())).toBe(false);

		// Advancing past the deadline fires the timer: the timeout latch engages,
		// but isTimeoutAbort still refuses because the external signal aborted
		// first — the error surfaced to the consumer is an external cancellation,
		// not the timeout contract.
		vi.advanceTimersByTime(100);
		expect(operation.timedOut()).toBe(true);
		expect(operation.isTimeoutAbort(abortError())).toBe(false);

		operation.clear();
	});

	test("isTimeoutAbort only treats AbortErrors from the timer as timeouts", () => {
		vi.useFakeTimers();
		const external = new AbortController();
		const operation = createMCPTimeout(100, external.signal);

		// Non-AbortError failures are never the timeout contract, even after the
		// timer fired.
		expect(operation.isTimeoutAbort(new Error("Unexpected end of JSON input"))).toBe(false);
		vi.advanceTimersByTime(100);
		expect(operation.isTimeoutAbort(new Error("Unexpected end of JSON input"))).toBe(false);

		operation.clear();
	});
});
