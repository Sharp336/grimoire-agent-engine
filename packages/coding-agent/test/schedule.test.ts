import { describe, expect, test } from "bun:test";
import type { ScheduledItem } from "@oh-my-pi/pi-coding-agent/modes/schedule";
import {
	computeNextCronFire,
	describeDelay,
	describeSchedule,
	formatScheduleList,
	parseCronExpression,
	parseDelayToken,
	parseScheduleCommand,
} from "@oh-my-pi/pi-coding-agent/modes/schedule";

describe("schedule command parsing", () => {
	test("parses one-shot: in <DELAY> <instruction>", () => {
		const result = parseScheduleCommand("in 30m Check the build status");
		expect(result).toEqual({
			type: "add",
			kind: "once",
			intervalMs: 1_800_000,
			instruction: "Check the build status",
		});
	});

	test("parses recurring: every <INTERVAL> <instruction>", () => {
		const result = parseScheduleCommand("every 10m Check the deployment");
		expect(result).toEqual({
			type: "add",
			kind: "interval",
			intervalMs: 600_000,
			instruction: "Check the deployment",
		});
	});

	test("parses cron with double-quoted expression", () => {
		const result = parseScheduleCommand('cron "0 9 * * 1-5" Review open PRs');
		expect(result).toMatchObject({
			type: "add",
			kind: "cron",
			instruction: "Review open PRs",
		});
	});

	test("parses subcommands", () => {
		expect(parseScheduleCommand("list")).toEqual({ type: "list" });
		expect(parseScheduleCommand("ls")).toEqual({ type: "list" });
		expect(parseScheduleCommand("clear")).toEqual({ type: "clear" });
		expect(parseScheduleCommand("cancel s1")).toEqual({ type: "cancel", id: "s1" });
	});

	test("parses word-style duration: in 2 hours <instruction>", () => {
		const result = parseScheduleCommand("in 2 hours Review the PRs");
		expect(result).toEqual({
			type: "add",
			kind: "once",
			intervalMs: 7_200_000,
			instruction: "Review the PRs",
		});
	});

	test("parses word-style duration: every 30 minutes <instruction>", () => {
		const result = parseScheduleCommand("every 30 minutes Check the logs");
		expect(result).toEqual({
			type: "add",
			kind: "interval",
			intervalMs: 1_800_000,
			instruction: "Check the logs",
		});
	});

	test("rejects empty args", () => {
		expect(typeof parseScheduleCommand("")).toBe("string");
		expect(typeof parseScheduleCommand("   ")).toBe("string");
	});

	test("rejects missing instruction", () => {
		const r = parseScheduleCommand("in 30m");
		expect(typeof r).toBe("string");
		expect(r).toContain("instruction");
	});

	test("rejects invalid delay", () => {
		const r = parseScheduleCommand("in abc Check builds");
		expect(typeof r).toBe("string");
	});

	test("rejects cron without quotes", () => {
		const r = parseScheduleCommand("cron 0 9 * * 1-5 Review PRs");
		expect(typeof r).toBe("string");
		expect(r).toContain("quoted");
	});
});

describe("delay parsing", () => {
	test("parses compound durations", () => {
		expect(parseDelayToken("30m")).toBe(1_800_000);
		expect(parseDelayToken("1h")).toBe(3_600_000);
		expect(parseDelayToken("2h30m")).toBe(9_000_000);
		expect(parseDelayToken("1d")).toBe(86_400_000);
	});

	test("parses word-style durations", () => {
		expect(parseDelayToken("10 minutes")).toBe(600_000);
		expect(parseDelayToken("2 hours")).toBe(7_200_000);
	});

	test("rejects unknown units", () => {
		expect(typeof parseDelayToken("10x")).toBe("string");
	});

	test("rejects zero or negative", () => {
		expect(typeof parseDelayToken("0m")).toBe("string");
	});
});

describe("cron expression parsing", () => {
	test("parses basic 5-field expression", () => {
		const fields = parseCronExpression("0 9 * * *");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			expect(fields.minute.has(0)).toBe(true);
			expect(fields.hour.has(9)).toBe(true);
			expect(fields.dayOfMonth.size).toBe(31);
		}
	});

	test("parses ranges", () => {
		const fields = parseCronExpression("0 9 * * 1-5");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			expect(fields.dayOfWeek.has(1)).toBe(true);
			expect(fields.dayOfWeek.has(5)).toBe(true);
			expect(fields.dayOfWeek.has(0)).toBe(false);
		}
	});

	test("parses step values", () => {
		const fields = parseCronExpression("*/15 * * * *");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			expect(fields.minute.has(0)).toBe(true);
			expect(fields.minute.has(15)).toBe(true);
			expect(fields.minute.has(30)).toBe(true);
			expect(fields.minute.has(45)).toBe(true);
			expect(fields.minute.has(1)).toBe(false);
		}
	});

	test("parses comma-separated values", () => {
		const fields = parseCronExpression("0,30 * * * *");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			expect(fields.minute.has(0)).toBe(true);
			expect(fields.minute.has(30)).toBe(true);
			expect(fields.minute.size).toBe(2);
		}
	});

	test("expands aliases", () => {
		const fields = parseCronExpression("@hourly");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			expect(fields.minute.has(0)).toBe(true);
			expect(fields.hour.size).toBe(24);
		}
	});

	test("rejects wrong field count", () => {
		expect(typeof parseCronExpression("0 9 * *")).toBe("string");
		expect(typeof parseCronExpression("0 9 * * * *")).toBe("string");
	});

	test("rejects zero cron steps", () => {
		expect(typeof parseCronExpression("*/0 * * * *")).toBe("string");
		expect(typeof parseCronExpression("0-59/0 * * * *")).toBe("string");
	});

	test("tracks wildcard flags for DOM/DOW", () => {
		const fields = parseCronExpression("0 9 * * *");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			expect(fields.domWildcard).toBe(true);
			expect(fields.dowWildcard).toBe(true);
		}
		const restricted = parseCronExpression("0 9 15 * 1");
		expect(typeof restricted).not.toBe("string");
		if (typeof restricted !== "string") {
			expect(restricted.domWildcard).toBe(false);
			expect(restricted.dowWildcard).toBe(false);
		}
	});
});

describe("computeNextCronFire", () => {
	test("finds next occurrence within the same hour", () => {
		const fields = parseCronExpression("30 * * * *");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			const now = new Date("2026-01-01T10:00:00Z");
			const next = computeNextCronFire(fields, now);
			expect(next).toBeDefined();
			const nextDate = new Date(next!);
			expect(nextDate.getUTCMinutes()).toBe(30);
			expect(nextDate.getUTCHours()).toBe(10);
		}
	});

	test("wraps to next hour when minute has passed", () => {
		const fields = parseCronExpression("0 * * * *");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			const now = new Date("2026-01-01T10:30:00Z");
			const next = computeNextCronFire(fields, now);
			expect(next).toBeDefined();
			const nextDate = new Date(next!);
			expect(nextDate.getUTCMinutes()).toBe(0);
			expect(nextDate.getUTCHours()).toBe(11);
		}
	});

	test("DOM/DOW OR semantics: matches when either restricted field matches", () => {
		// "0 9 1 * 1" = 9am on the 1st of the month OR on Monday
		const fields = parseCronExpression("0 9 1 * 1");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			// 2026-01-02 is a Friday (DOW=5), not the 1st (DOM=2) → skip
			// Next fire should be 2026-01-05 (Monday) at 9am
			const now = new Date("2026-01-02T00:00:00Z");
			const next = computeNextCronFire(fields, now);
			expect(next).toBeDefined();
			const nextDate = new Date(next!);
			expect(nextDate.getUTCDate()).toBe(5); // Monday
			expect(nextDate.getUTCDay()).toBe(1); // Monday
		}
	});

	test("returns undefined for impossible date like Feb 30", () => {
		const fields = parseCronExpression("0 0 30 2 *");
		expect(typeof fields).not.toBe("string");
		if (typeof fields !== "string") {
			const now = new Date("2026-01-01T00:00:00Z");
			const next = computeNextCronFire(fields, now);
			expect(next).toBeUndefined();
		}
	});
});

describe("formatting helpers", () => {
	test("describeDelay formats common intervals", () => {
		expect(describeDelay(60_000)).toBe("1 minute");
		expect(describeDelay(600_000)).toBe("10 minutes");
		expect(describeDelay(3_600_000)).toBe("1 hour");
		expect(describeDelay(86_400_000)).toBe("1 day");
	});

	test("describeSchedule formats one-shot", () => {
		const item: ScheduledItem = {
			id: "s1",
			kind: "once",
			intervalMs: 1_800_000,
			nextFireAt: Date.now() + 1_800_000,
			instruction: "Check the build",
			active: true,
		};
		expect(describeSchedule(item)).toContain("in 30 minutes");
		expect(describeSchedule(item)).toContain("Check the build");
	});

	test("describeSchedule formats interval", () => {
		const item: ScheduledItem = {
			id: "s2",
			kind: "interval",
			intervalMs: 600_000,
			nextFireAt: Date.now() + 600_000,
			instruction: "Check deployment",
			active: true,
		};
		expect(describeSchedule(item)).toContain("every 10 minutes");
	});

	test("formatScheduleList shows empty state", () => {
		expect(formatScheduleList([])).toContain("No active schedules");
	});

	test("formatScheduleList shows active items", () => {
		const items: ScheduledItem[] = [
			{
				id: "s1",
				kind: "once",
				intervalMs: 1_800_000,
				nextFireAt: Date.now() + 1_800_000,
				instruction: "Check the build",
				active: true,
			},
		];
		const text = formatScheduleList(items);
		expect(text).toContain("s1");
		expect(text).toContain("Check the build");
		expect(text).toContain("1");
	});
});
