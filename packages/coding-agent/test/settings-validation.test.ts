/**
 * Focused contract tests for validateSettingsValues — path-scoped
 * enabledModels/disabledProviders entries and typed record members.
 */
import { describe, expect, it } from "bun:test";
import { validateSettingsValues } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("validateSettingsValues", () => {
	it("accepts a supported path-scoped enabledModels entry", () => {
		const result = validateSettingsValues({
			enabledModels: [{ path: "/repo", models: ["openai/model"] }],
		});
		expect(result.errors).toEqual([]);
	});

	it("accepts a supported path-scoped disabledProviders entry", () => {
		const result = validateSettingsValues({
			disabledProviders: [{ path: "/repo", providers: ["ollama"] }],
		});
		expect(result.errors).toEqual([]);
	});

	it("still rejects invalid path-scoped array member shapes", () => {
		const result = validateSettingsValues({
			enabledModels: ["ok", 42],
		});
		expect(result.errors.some(error => error.includes("enabledModels[1]") && error.includes("number"))).toBe(true);
	});

	it("reports invalid providers.maxInFlightRequests members", () => {
		const result = validateSettingsValues({
			providers: { maxInFlightRequests: { openai: "nope" } },
		});
		expect(
			result.errors.some(error => error.includes("Provider request limits must be positive numbers: openai")),
		).toBe(true);
	});
});
