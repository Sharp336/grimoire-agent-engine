import { describe, expect, test, vi } from "bun:test";
import {
	describeHeartbeatInterval,
	formatHeartbeatStatus,
	type HeartbeatState,
	MIN_HEARTBEAT_INTERVAL_MS,
	parseHeartbeatCommand,
	parseHeartbeatInterval,
} from "@oh-my-pi/pi-coding-agent/modes/heartbeat";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("heartbeat interval parsing", () => {
	test("parses compound durations like 10m, 90s, 1h30m", () => {
		expect(parseHeartbeatInterval("10m")).toBe(600_000);
		expect(parseHeartbeatInterval("90s")).toBe(90_000);
		expect(parseHeartbeatInterval("1h30m")).toBe(5_400_000);
	});

	test("parses space-separated amounts with unit words", () => {
		expect(parseHeartbeatInterval("15 seconds")).toBe(15_000);
		expect(parseHeartbeatInterval("1 hour")).toBe(3_600_000);
	});

	test("rejects intervals below the minimum", () => {
		expect(typeof parseHeartbeatInterval("5s")).toBe("string");
		expect(parseHeartbeatInterval("5s")).toContain("at least");
	});

	test("rejects unknown units", () => {
		expect(typeof parseHeartbeatInterval("10x")).toBe("string");
		expect(parseHeartbeatInterval("10x")).toContain("unit must be");
	});

	test("rejects zero or negative amounts", () => {
		expect(typeof parseHeartbeatInterval("0m")).toBe("string");
	});
});

describe("heartbeat command parsing", () => {
	test("parses subcommands", () => {
		expect(parseHeartbeatCommand("status")).toEqual({ type: "status" });
		expect(parseHeartbeatCommand("pause")).toEqual({ type: "pause" });
		expect(parseHeartbeatCommand("resume")).toEqual({ type: "resume" });
		expect(parseHeartbeatCommand("clear")).toEqual({ type: "clear" });
		expect(parseHeartbeatCommand("off")).toEqual({ type: "clear" });
		expect(parseHeartbeatCommand("stop")).toEqual({ type: "clear" });
	});

	test("parses set form with 'every' prefix", () => {
		expect(parseHeartbeatCommand("every 10m Check the build")).toEqual({
			type: "set",
			intervalMs: 600_000,
			instruction: "Check the build",
		});
	});

	test("parses set form without 'every' prefix", () => {
		expect(parseHeartbeatCommand("15m Check deployment status")).toEqual({
			type: "set",
			intervalMs: 900_000,
			instruction: "Check deployment status",
		});
	});

	test("rejects set without instruction", () => {
		const result = parseHeartbeatCommand("every 10m");
		expect(typeof result).toBe("string");
		expect(result).toContain("requires an instruction");
	});

	test("rejects empty args", () => {
		expect(typeof parseHeartbeatCommand("")).toBe("string");
		expect(typeof parseHeartbeatCommand("   ")).toBe("string");
	});

	test("rejects invalid interval", () => {
		const result = parseHeartbeatCommand("every abc Check builds");
		expect(typeof result).toBe("string");
	});
});

describe("describeHeartbeatInterval", () => {
	test("formats common intervals in human-readable units", () => {
		expect(describeHeartbeatInterval(3_600_000)).toBe("1 hour");
		expect(describeHeartbeatInterval(7_200_000)).toBe("2 hours");
		expect(describeHeartbeatInterval(60_000)).toBe("1 minute");
		expect(describeHeartbeatInterval(600_000)).toBe("10 minutes");
		expect(describeHeartbeatInterval(30_000)).toBe("30 seconds");
		expect(describeHeartbeatInterval(90_000)).toBe("90 seconds");
	});
});

describe("formatHeartbeatStatus", () => {
	test("reports active heartbeat", () => {
		const state: HeartbeatState = {
			intervalMs: 600_000,
			instruction: "Check the deployment",
			status: "active",
		};
		const text = formatHeartbeatStatus(state);
		expect(text).toContain("active");
		expect(text).toContain("10 minutes");
		expect(text).toContain("Check the deployment");
	});

	test("reports paused heartbeat", () => {
		const state: HeartbeatState = {
			intervalMs: 3_600_000,
			instruction: "Review open PRs",
			status: "paused",
		};
		const text = formatHeartbeatStatus(state);
		expect(text).toContain("paused");
		expect(text).toContain("1 hour");
	});

	test("reports no heartbeat when undefined", () => {
		const text = formatHeartbeatStatus(undefined);
		expect(text).toContain("No heartbeat set");
	});
});

describe("/heartbeat slash command forwarding", () => {
	test("forwards args to handleHeartbeatCommand", async () => {
		const handleHeartbeatCommand = vi.fn(async (_args: string) => undefined);
		const runtime = {
			ctx: { handleHeartbeatCommand, editor: { setText: vi.fn() } },
		} as unknown as BuiltinSlashCommandRuntime;
		const result = await executeBuiltinSlashCommand("/heartbeat every 10m Check builds", runtime);

		expect(result).toBe(true);
		expect(handleHeartbeatCommand).toHaveBeenCalledWith("every 10m Check builds");
	});

	test("clears the editor after handling", async () => {
		const handleHeartbeatCommand = vi.fn(async (_args: string) => undefined);
		const setText = vi.fn();
		const runtime = {
			ctx: { handleHeartbeatCommand, editor: { setText } },
		} as unknown as BuiltinSlashCommandRuntime;
		await executeBuiltinSlashCommand("/heartbeat status", runtime);

		expect(setText).toHaveBeenCalledWith("");
	});
});

describe("MIN_HEARTBEAT_INTERVAL_MS", () => {
	test("is at least 10 seconds", () => {
		expect(MIN_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
	});
});
