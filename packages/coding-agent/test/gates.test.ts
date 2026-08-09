import { describe, expect, test } from "bun:test";
import {
	DEFAULT_GATE_MAX_RETRIES,
	DEFAULT_GATE_TIMEOUT_MS,
	formatGateFailureMessage,
	type GoalGateConfig,
	type GoalGateFailure,
	runGoalGates,
} from "@oh-my-pi/pi-coding-agent/goals/gates";

const PASS_CONFIG: GoalGateConfig = {
	commands: ["true"],
	maxRetries: 3,
	timeoutMs: 5_000,
};

const FAIL_CONFIG: GoalGateConfig = {
	commands: ["false"],
	maxRetries: 3,
	timeoutMs: 5_000,
};

describe("runGoalGates", () => {
	test("passes when all commands exit 0", async () => {
		const attempts = new Map<string, number>();
		const result = await runGoalGates(PASS_CONFIG, process.cwd(), attempts);
		expect(result.passed).toBe(true);
		expect(result.failure).toBeUndefined();
		// Attempt counter reset to 0 on pass
		expect(attempts.get("true")).toBe(0);
	});

	test("fails when a command exits non-zero", async () => {
		const attempts = new Map<string, number>();
		const result = await runGoalGates(FAIL_CONFIG, process.cwd(), attempts);
		expect(result.passed).toBe(false);
		expect(result.failure).toBeDefined();
		expect(result.failure!.command).toBe("false");
		expect(result.failure!.attempt).toBe(1);
		expect(result.failure!.maxRetries).toBe(3);
		expect(result.failure!.exitText).toContain("exit code");
	});

	test("increments attempt counter across invocations", async () => {
		const attempts = new Map<string, number>();
		await runGoalGates(FAIL_CONFIG, process.cwd(), attempts);
		expect(attempts.get("false")).toBe(1);
		await runGoalGates(FAIL_CONFIG, process.cwd(), attempts);
		expect(attempts.get("false")).toBe(2);
	});

	test("bypasses gate after maxRetries exhausted", async () => {
		const attempts = new Map<string, number>([["false", 3]]);
		const result = await runGoalGates(FAIL_CONFIG, process.cwd(), attempts);
		// Should pass because the gate is bypassed after maxRetries
		expect(result.passed).toBe(true);
	});

	test("returns passed immediately when no commands configured", async () => {
		const config: GoalGateConfig = { commands: [], maxRetries: 3, timeoutMs: 5_000 };
		const result = await runGoalGates(config, process.cwd(), new Map());
		expect(result.passed).toBe(true);
	});

	test("stops at first failing command", async () => {
		const config: GoalGateConfig = {
			commands: ["false", "true"],
			maxRetries: 3,
			timeoutMs: 5_000,
		};
		const attempts = new Map<string, number>();
		const result = await runGoalGates(config, process.cwd(), attempts);
		expect(result.passed).toBe(false);
		expect(result.failure!.command).toBe("false");
		// Second command never ran
		expect(attempts.has("true")).toBe(false);
	});

	test("captures stdout from failing command", async () => {
		const config: GoalGateConfig = {
			commands: ["echo 'gate output here' && false"],
			maxRetries: 3,
			timeoutMs: 5_000,
		};
		const attempts = new Map<string, number>();
		const result = await runGoalGates(config, process.cwd(), attempts);
		expect(result.passed).toBe(false);
		expect(result.failure!.output).toContain("gate output here");
	});

	test("resets attempt counter after a successful run", async () => {
		const attempts = new Map<string, number>([["true", 2]]);
		const result = await runGoalGates(PASS_CONFIG, process.cwd(), attempts);
		expect(result.passed).toBe(true);
		expect(attempts.get("true")).toBe(0);
	});
});

describe("formatGateFailureMessage", () => {
	test("formats failure with command, exit text, and output", () => {
		const failure: GoalGateFailure = {
			command: "npm test",
			attempt: 2,
			maxRetries: 3,
			exitText: "exit code 1",
			output: "FAIL  src/app.test.ts\n  ● app > should work",
		};
		const message = formatGateFailureMessage(failure);
		expect(message).toContain("attempt 2/3");
		expect(message).toContain("`npm test`");
		expect(message).toContain("exit code 1");
		expect(message).toContain("FAIL  src/app.test.ts");
		expect(message).toContain('goal({op: "complete"})');
	});

	test("omits output section when empty", () => {
		const failure: GoalGateFailure = {
			command: "exit 1",
			attempt: 1,
			maxRetries: 3,
			exitText: "exit code 1",
			output: "",
		};
		const message = formatGateFailureMessage(failure);
		expect(message).not.toContain("Output:");
	});
});

describe("defaults", () => {
	test("DEFAULT_GATE_MAX_RETRIES is at least 1", () => {
		expect(DEFAULT_GATE_MAX_RETRIES).toBeGreaterThanOrEqual(1);
	});

	test("DEFAULT_GATE_TIMEOUT_MS is at least 30 seconds", () => {
		expect(DEFAULT_GATE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
	});
});
