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

	it("rejects non-string task override record values", () => {
		const result = validateSettingsValues({
			task: {
				agentModelOverrides: { task_fast: 7 },
				agentPrewalk: { task_budget: false },
			},
		});
		expect(result.errors).toContain('Settings key "task.agentModelOverrides.task_fast" must be a string, got number');
		expect(result.errors).toContain('Settings key "task.agentPrewalk.task_budget" must be a string, got boolean');
	});

	it("accepts string-valued task override records", () => {
		const result = validateSettingsValues({
			task: {
				agentModelOverrides: { task_fast: "openai/gpt-5" },
				agentPrewalk: { task_budget: "openai/gpt-5-mini" },
			},
		});
		expect(result.errors).toEqual([]);
	});
});
