/**
 * Unit tests for the `lifecycle`/`idleTimeoutMs` fields added to
 * `MCPServerConfigBase` by RFC #2888 ("per-server MCP lifecycle: lazy|eager
 * + idleTimeout"). Pure config validation — no subprocess, no manager.
 */
import { describe, expect, it } from "bun:test";
import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

function baseConfig(): MCPStdioServerConfig {
	return { type: "stdio", command: "echo" };
}

describe("MCP lazy-lifecycle config validation", () => {
	it("accepts an eager server (the default) with no lifecycle field", () => {
		expect(validateServerConfig("s", baseConfig())).toEqual([]);
	});

	it('accepts an explicit lifecycle: "eager"', () => {
		expect(validateServerConfig("s", { ...baseConfig(), lifecycle: "eager" })).toEqual([]);
	});

	it('accepts lifecycle: "lazy" with an idleTimeoutMs', () => {
		expect(validateServerConfig("s", { ...baseConfig(), lifecycle: "lazy", idleTimeoutMs: 60_000 })).toEqual([]);
	});

	it('accepts lifecycle: "lazy" with idleTimeoutMs: 0 (idle reaping disabled)', () => {
		expect(validateServerConfig("s", { ...baseConfig(), lifecycle: "lazy", idleTimeoutMs: 0 })).toEqual([]);
	});

	it('accepts lifecycle: "lazy" with no idleTimeoutMs (falls back to the manager default)', () => {
		expect(validateServerConfig("s", { ...baseConfig(), lifecycle: "lazy" })).toEqual([]);
	});

	it("rejects an unknown lifecycle value", () => {
		const errors = validateServerConfig("s", {
			...baseConfig(),
			// @ts-expect-error intentionally invalid for the test
			lifecycle: "eventually",
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"lifecycle" must be "eager" or "lazy"');
	});

	it("rejects a negative idleTimeoutMs", () => {
		const errors = validateServerConfig("s", { ...baseConfig(), lifecycle: "lazy", idleTimeoutMs: -1 });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"idleTimeoutMs" must be a non-negative number');
	});

	it("rejects a non-finite idleTimeoutMs", () => {
		const errors = validateServerConfig("s", { ...baseConfig(), lifecycle: "lazy", idleTimeoutMs: Number.NaN });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"idleTimeoutMs" must be a non-negative number');
	});
});
