/**
 * Contracts for session self-scheduling: fold, arming, controller fire/cancel/restore,
 * overdue turn-boundary delivery, due-time resolution, and schedule-tool input validation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ManagedTimers } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/managed-timers";
import type { CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	armSessionSchedules,
	foldPendingSessionSchedules,
	resolveScheduleDueAtMs,
	SESSION_SCHEDULE_CUSTOM_TYPE,
	SESSION_SCHEDULE_MAX_DELAY_MS,
	SESSION_SCHEDULE_MESSAGE_TYPE,
	SessionScheduleController,
	type SessionScheduleFireHost,
} from "@oh-my-pi/pi-coding-agent/session/session-schedule";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ScheduleTool } from "@oh-my-pi/pi-coding-agent/tools/schedule";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { logger } from "@oh-my-pi/pi-utils";

type HiddenMessage = {
	customType: string;
	content: string;
	deliverAs?: "steer" | "followUp" | "nextTurn";
	triggerTurn?: boolean;
};

async function flushMicrotasks(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function scheduleCustomEntry(data: unknown, id = "entry"): CustomEntry {
	return {
		type: "custom",
		customType: SESSION_SCHEDULE_CUSTOM_TYPE,
		data,
		id,
		parentId: null,
		timestamp: "1970-01-01T00:00:00.000Z",
	};
}

function scheduleEntriesOf(entries: readonly SessionEntry[]): CustomEntry[] {
	return entries.filter(
		(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === SESSION_SCHEDULE_CUSTOM_TYPE,
	);
}

interface ScheduleHarness {
	controller: SessionScheduleController;
	entries: SessionEntry[];
	hiddenMessages: HiddenMessage[];
	timers: ManagedTimers;
	host: SessionScheduleFireHost;
	now: () => number;
	setNow: (next: number) => void;
	dispose: () => void;
}

function createHarness(initialNowMs = 1_000_000): ScheduleHarness {
	let nowMs = initialNowMs;
	const entries: SessionEntry[] = [];
	const hiddenMessages: HiddenMessage[] = [];
	let entrySeq = 0;

	const timers = new ManagedTimers((_event, _error) => {});
	const host: SessionScheduleFireHost = {
		getEntries: () => entries,
		appendCustomEntry: (customType, data) => {
			const id = `entry-${++entrySeq}`;
			entries.push({
				type: "custom",
				customType,
				data,
				id,
				parentId: null,
				timestamp: new Date(nowMs).toISOString(),
			});
			return id;
		},
		sendHiddenMessage: async message => {
			hiddenMessages.push({ ...message });
		},
	};

	const controller = new SessionScheduleController(timers, host, () => nowMs);

	return {
		controller,
		entries,
		hiddenMessages,
		timers,
		host,
		now: () => nowMs,
		setNow: (next: number) => {
			nowMs = next;
		},
		dispose: () => {
			controller.dispose();
			timers.clearAll();
		},
	};
}

describe("session-schedule", () => {
	let harness: ScheduleHarness | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		harness = undefined;
	});

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("creating a schedule appends exactly one session-schedule entry and arms one timer", () => {
		harness = createHarness(1_000_000);
		const created = harness.controller.create({ delayMs: 2_000, prompt: "wake me" });

		const scheduleEntries = scheduleEntriesOf(harness.entries);
		expect(scheduleEntries).toHaveLength(1);
		expect(scheduleEntries[0]?.data).toEqual({
			id: created.id,
			dueAtMs: 1_002_000,
			prompt: "wake me",
			createdAt: 1_000_000,
		});
		expect(vi.getTimerCount()).toBe(1);
		expect(harness.controller.listPending()).toHaveLength(1);
		expect(harness.hiddenMessages).toHaveLength(0);
	});

	it("advancing past dueAtMs enqueues exactly one hidden message with the stored prompt", async () => {
		harness = createHarness(1_000_000);
		const prompt = "check the build";
		harness.controller.create({ delayMs: 1_500, prompt });

		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1_499);
		await flushMicrotasks();
		expect(harness.hiddenMessages).toHaveLength(0);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]).toEqual({
			customType: SESSION_SCHEDULE_MESSAGE_TYPE,
			content: prompt,
			deliverAs: "nextTurn",
			triggerTurn: true,
		});
		expect(foldPendingSessionSchedules(harness.entries)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancelling before the deadline appends a cancel tombstone and fires nothing", async () => {
		harness = createHarness(1_000_000);
		const created = harness.controller.create({ delayMs: 5_000, prompt: "should not fire" });

		expect(vi.getTimerCount()).toBe(1);
		expect(harness.controller.cancel(created.id)).toBe(true);

		const scheduleEntries = scheduleEntriesOf(harness.entries);
		expect(scheduleEntries).toHaveLength(2);
		expect(scheduleEntries[1]?.data).toEqual({ id: created.id, cancelled: true });
		expect(harness.controller.listPending()).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		expect(harness.hiddenMessages).toHaveLength(0);
	});

	it("re-fold after fire does not re-arm that id; a still-pending schedule does re-arm", async () => {
		harness = createHarness(1_000_000);
		const first = harness.controller.create({ delayMs: 1_000, prompt: "first wake" });

		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]?.content).toBe("first wake");
		expect(vi.getTimerCount()).toBe(0);

		// Fired tombstone keeps the id out of the pending fold.
		expect(foldPendingSessionSchedules(harness.entries).some(entry => entry.id === first.id)).toBe(false);
		harness.controller.rearmFromEntries();
		expect(vi.getTimerCount()).toBe(0);

		const second = harness.controller.create({ delayMs: 4_000, prompt: "second wake" });
		expect(vi.getTimerCount()).toBe(1);
		expect(foldPendingSessionSchedules(harness.entries).map(entry => entry.id)).toEqual([second.id]);

		harness.controller.rearmFromEntries();
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(4_000);
		await flushMicrotasks();
		expect(harness.hiddenMessages).toHaveLength(2);
		expect(harness.hiddenMessages.map(message => message.content)).toEqual(["first wake", "second wake"]);
	});

	it("does not arm malformed persisted future entries beyond the timer maximum", () => {
		harness = createHarness(1_000_000);
		harness.entries.push(
			scheduleCustomEntry({
				id: "too-far",
				dueAtMs: harness.now() + SESSION_SCHEDULE_MAX_DELAY_MS + 1,
				prompt: "do not overflow",
				createdAt: harness.now(),
			}),
		);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const armed = armSessionSchedules(harness.entries, harness.timers, harness.host, { now: () => harness!.now() });

		expect(armed.pending.map(schedule => schedule.id)).toEqual(["too-far"]);
		expect(vi.getTimerCount()).toBe(0);
		expect(scheduleEntriesOf(harness.entries)).toHaveLength(1);
		expect(harness.hiddenMessages).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			"session-schedule not armed: persisted delay exceeds timer maximum",
			expect.objectContaining({ id: "too-far" }),
		);
		armed.disarm();
	});

	it("does not deliver after a fire loses session liveness during flush", async () => {
		harness = createHarness(1_000_000);
		let live = true;
		const flushGate = Promise.withResolvers<void>();
		harness.host.isLive = () => live;
		harness.host.flush = () => flushGate.promise;
		harness.entries.push(
			scheduleCustomEntry({ id: "liveness", dueAtMs: harness.now(), prompt: "must not deliver", createdAt: 0 }),
		);
		const nowMs = harness.now();
		armSessionSchedules(harness.entries, harness.timers, harness.host, { now: () => nowMs });

		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		// The fired tombstone is only persisted after a successful enqueue.
		expect(scheduleEntriesOf(harness.entries)).toHaveLength(1);
		live = false;
		flushGate.resolve();
		await flushMicrotasks();
		expect(harness.hiddenMessages).toEqual([]);
		// Liveness loss aborts delivery but keeps the wake pending for a later session.
		expect(foldPendingSessionSchedules(harness.entries).map(entry => entry.id)).toEqual(["liveness"]);
	});

	it("does not deliver after the transcript branch changes during flush", async () => {
		harness = createHarness(1_000_000);
		const flush = Promise.withResolvers<void>();
		harness.host.flush = () => flush.promise;
		harness.entries.push(
			scheduleCustomEntry({
				id: "old-branch",
				dueAtMs: harness.now(),
				prompt: "must not cross branches",
				createdAt: 0,
			}),
		);
		armSessionSchedules(harness.entries, harness.timers, harness.host, { now: harness.now });

		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		// The fired tombstone is only persisted after a successful enqueue.
		expect(scheduleEntriesOf(harness.entries)).toHaveLength(1);

		harness.host.getEntries = () => [];
		flush.resolve();
		await flushMicrotasks();
		expect(harness.hiddenMessages).toEqual([]);
		// No tombstone is written onto the new branch; the old branch keeps the wake.
		expect(scheduleEntriesOf(harness.entries)).toHaveLength(1);
	});

	it("delivers a committed wake after an unrelated same-branch rearm during flush", async () => {
		harness = createHarness(1_000_000);
		const flush = Promise.withResolvers<void>();
		harness.host.flush = () => flush.promise;
		harness.entries.push(
			scheduleCustomEntry({ id: "same-branch", dueAtMs: harness.now(), prompt: "deliver once", createdAt: 0 }),
		);
		const armed = armSessionSchedules(harness.entries, harness.timers, harness.host, { now: harness.now });

		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		armed.disarm();
		flush.resolve();
		await flushMicrotasks();
		expect(harness.hiddenMessages.map(message => message.content)).toEqual(["deliver once"]);
	});

	it("overdue creates stay pending after fold and fire once at the next turn boundary", async () => {
		harness = createHarness(10_000);
		harness.entries.push(
			scheduleCustomEntry(
				{
					id: "overdue-1",
					dueAtMs: 1_000,
					prompt: "catch up",
					createdAt: 0,
				},
				"seed-overdue",
			),
		);

		const pending = foldPendingSessionSchedules(harness.entries);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.id).toBe("overdue-1");

		const armed = armSessionSchedules(harness.entries, harness.timers, harness.host, { now: () => harness!.now() });
		expect(armed.pending).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]).toEqual({
			customType: SESSION_SCHEDULE_MESSAGE_TYPE,
			content: "catch up",
			deliverAs: "nextTurn",
			triggerTurn: false,
		});
		expect(vi.getTimerCount()).toBe(0);

		// Fired tombstone: another arm + zero-delay tick must not repeat delivery.
		const rearmed = armSessionSchedules(harness.entries, harness.timers, harness.host, { now: () => harness!.now() });
		expect(rearmed.pending).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(harness.hiddenMessages).toHaveLength(1);

		armed.disarm();
		rearmed.disarm();
	});

	it("a failed enqueue leaves the wake pending and a re-arm delivers it once", async () => {
		harness = createHarness(1_000_000);
		const local = harness;
		let failSends = true;
		local.host.sendHiddenMessage = async message => {
			if (failSends) throw new Error("queue unavailable");
			local.hiddenMessages.push({ ...message });
		};
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const created = local.controller.create({ delayMs: 1_000, prompt: "retry me" });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();

		// Regression: the fired tombstone used to be persisted before sendHiddenMessage,
		// so one failed enqueue permanently dropped the wake. Failure must leave the
		// create pending — no delivery, no tombstone, and no hot retry loop.
		expect(local.hiddenMessages).toEqual([]);
		expect(scheduleEntriesOf(local.entries)).toHaveLength(1);
		expect(foldPendingSessionSchedules(local.entries).map(entry => entry.id)).toEqual([created.id]);
		expect(vi.getTimerCount()).toBe(0);
		expect(warn).toHaveBeenCalledWith("session-schedule fire failed", expect.objectContaining({ id: created.id }));

		// The pending intent re-arms and delivers once the enqueue works again.
		failSends = false;
		local.setNow(local.now() + 1_000);
		local.controller.rearmFromEntries();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(local.hiddenMessages).toEqual([
			{
				customType: SESSION_SCHEDULE_MESSAGE_TYPE,
				content: "retry me",
				deliverAs: "nextTurn",
				triggerTurn: false,
			},
		]);
		expect(foldPendingSessionSchedules(local.entries)).toEqual([]);
	});

	it("a freshly created delayMs:0 schedule fires immediately and triggers a turn", async () => {
		harness = createHarness(1_000_000);
		harness.controller.create({ delayMs: 0, prompt: "wake now" });

		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		// Regression: a due-now create took the restored-overdue path and queued the
		// wake without starting a turn. Unlike a restored overdue schedule (turn
		// boundary, triggerTurn: false, covered above), a fresh delayMs:0 fires a turn.
		expect(harness.hiddenMessages).toEqual([
			{
				customType: SESSION_SCHEDULE_MESSAGE_TYPE,
				content: "wake now",
				deliverAs: "nextTurn",
				triggerTurn: true,
			},
		]);
		expect(foldPendingSessionSchedules(harness.entries)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("an unrelated rearm during an in-flight delivery does not double-fire the wake", async () => {
		harness = createHarness(1_000_000);
		const local = harness;
		const sendGate = Promise.withResolvers<void>();
		let sendsStarted = 0;
		local.host.sendHiddenMessage = async message => {
			sendsStarted += 1;
			await sendGate.promise;
			local.hiddenMessages.push({ ...message });
		};

		local.controller.create({ delayMs: 1_000, prompt: "in flight" });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(sendsStarted).toBe(1);

		// An unrelated create rearms every pending schedule while the first delivery is
		// still awaiting its enqueue; the in-flight id must not be armed a second time.
		const second = local.controller.create({ delayMs: 5_000, prompt: "unrelated" });
		expect(vi.getTimerCount()).toBe(1);

		sendGate.resolve();
		await flushMicrotasks();
		expect(local.hiddenMessages.map(message => message.content)).toEqual(["in flight"]);
		expect(foldPendingSessionSchedules(local.entries).map(entry => entry.id)).toEqual([second.id]);

		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(local.hiddenMessages.map(message => message.content)).toEqual(["in flight", "unrelated"]);
		expect(foldPendingSessionSchedules(local.entries)).toEqual([]);
	});

	it("resolveScheduleDueAtMs rejects both delayMs+atIso and neither", () => {
		const neither = resolveScheduleDueAtMs({ prompt: "wake" }, 1_000);
		expect(neither).toEqual({ error: "Exactly one of delayMs or atIso must be supplied." });

		const both = resolveScheduleDueAtMs(
			{
				prompt: "wake",
				delayMs: 500,
				atIso: "2020-01-01T00:00:00.000Z",
			},
			1_000,
		);
		expect(both).toEqual({ error: "Exactly one of delayMs or atIso must be supplied." });

		const fromDelay = resolveScheduleDueAtMs({ prompt: "wake", delayMs: 250 }, 1_000);
		expect(fromDelay).toEqual({ dueAtMs: 1_250 });

		const atMs = Date.parse("2020-01-01T00:00:00.000Z");
		const fromAt = resolveScheduleDueAtMs({ prompt: "wake", atIso: "2020-01-01T00:00:00.000Z" }, atMs - 1);
		expect(fromAt).toEqual({ dueAtMs: atMs });

		expect(resolveScheduleDueAtMs({ prompt: "wake", atIso: new Date(atMs - 1).toISOString() }, atMs)).toEqual({
			error: "atIso must be in the future.",
		});

		expect(resolveScheduleDueAtMs({ prompt: "wake", delayMs: SESSION_SCHEDULE_MAX_DELAY_MS + 1 }, 1_000)).toEqual({
			error: `delayMs must not exceed ${SESSION_SCHEDULE_MAX_DELAY_MS}.`,
		});
		expect(
			resolveScheduleDueAtMs(
				{
					prompt: "wake",
					atIso: new Date(1_000 + SESSION_SCHEDULE_MAX_DELAY_MS + 1).toISOString(),
				},
				1_000,
			),
		).toEqual({ error: `atIso must not be more than ${SESSION_SCHEDULE_MAX_DELAY_MS}ms in the future.` });
	});

	it("schedule tool input validation rejects both and neither create combinations", async () => {
		const tool = new ScheduleTool({ cwd: "/tmp/schedule-test" } as ToolSession);

		await expect(tool.execute("call-neither", { prompt: "wake" })).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("call-neither", { prompt: "wake" })).rejects.toThrow(
			"Exactly one of delayMs or atIso must be supplied.",
		);

		await expect(
			tool.execute("call-both", {
				prompt: "wake",
				delayMs: 100,
				atIso: "2020-01-01T00:00:00.000Z",
			}),
		).rejects.toBeInstanceOf(ToolError);
		await expect(
			tool.execute("call-both-again", {
				prompt: "wake",
				delayMs: 100,
				atIso: "2020-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow("Exactly one of delayMs or atIso must be supplied.");
	});

	it("only exposes schedule to top-level sessions", () => {
		const settings = { get: () => true };
		expect(
			ScheduleTool.createIf({
				cwd: "/tmp/schedule-test",
				settings,
				isTopLevelSession: () => true,
			} as unknown as ToolSession),
		).toBeInstanceOf(ScheduleTool);
		expect(
			ScheduleTool.createIf({
				cwd: "/tmp/schedule-test",
				settings,
				isTopLevelSession: () => false,
			} as unknown as ToolSession),
		).toBeNull();
	});

	it("rejects creates and cancels when the live controller is unavailable", async () => {
		const tool = new ScheduleTool({ cwd: "/tmp/schedule-test" } as ToolSession);

		await expect(tool.execute("create", { prompt: "wake", delayMs: 1 })).rejects.toThrow(
			"Session schedule controller is unavailable.",
		);
		await expect(tool.execute("cancel", { cancel: "schedule-1" })).rejects.toThrow(
			"Session schedule controller is unavailable.",
		);
	});

	it("forwards cancel ids to the live controller and reports unknown ids", async () => {
		const cancel = vi.fn((id: string) => id === "known");
		const tool = new ScheduleTool({
			cwd: "/tmp/schedule-test",
			getSessionSchedule: () => ({ cancel }) as never,
		} as unknown as ToolSession);

		const known = await tool.execute("cancel-known", { cancel: "known" });
		const unknown = await tool.execute("cancel-unknown", { cancel: "unknown" });

		expect(cancel).toHaveBeenNthCalledWith(1, "known");
		expect(cancel).toHaveBeenNthCalledWith(2, "unknown");
		expect(known.details).toMatchObject({ op: "cancel", id: "known", cancelled: true });
		expect(unknown.details).toMatchObject({ op: "cancel", id: "unknown", cancelled: false });
	});

	it("rejects mixed cancel and create input before touching the controller", async () => {
		const cancel = vi.fn(() => true);
		const tool = new ScheduleTool({
			cwd: "/tmp/schedule-test",
			getSessionSchedule: () => ({ cancel }) as never,
		} as unknown as ToolSession);

		await expect(tool.execute("mixed", { cancel: "schedule-1", prompt: "wake", delayMs: 1 })).rejects.toThrow(
			"cancel cannot be combined with delayMs, atIso, or prompt.",
		);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("a tool-created schedule reaches the live controller and actually fires", async () => {
		// Regression: the tool used to read its controller through a synthetic cast that was
		// never populated on ToolSession, so every create silently took the controller-less
		// fallback — the entry persisted but no timer was ever armed and the wake never fired.
		harness = createHarness();
		const local = harness;
		const tool = new ScheduleTool({
			cwd: "/tmp/schedule-test",
			getSessionSchedule: () => local.controller,
		} as ToolSession);

		await tool.execute("call-1", { prompt: "wake up", delayMs: 5_000 });

		local.setNow(local.now() + 5_000);
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();

		expect(local.hiddenMessages).toHaveLength(1);
		expect(local.hiddenMessages[0]?.content).toContain("wake up");
	});

	it("fold ignores unknown or garbage custom-entry payloads without throwing", () => {
		const entries: SessionEntry[] = [
			scheduleCustomEntry(undefined, "u1"),
			scheduleCustomEntry(null, "u2"),
			scheduleCustomEntry("not-an-object", "u3"),
			scheduleCustomEntry({ id: "" }, "u4"),
			scheduleCustomEntry({ id: "partial" }, "u5"),
			scheduleCustomEntry({ id: "bad-due", dueAtMs: Number.NaN, prompt: "x", createdAt: 1 }, "u6"),
			scheduleCustomEntry({ id: "empty-prompt", dueAtMs: 1, prompt: "", createdAt: 1 }, "u7"),
			scheduleCustomEntry({ id: "cancel-noise", cancelled: "yes" }, "u8"),
			{
				type: "custom",
				customType: "other-extension",
				data: { id: "other", dueAtMs: 1, prompt: "ignore", createdAt: 1 },
				id: "other",
				parentId: null,
				timestamp: "1970-01-01T00:00:00.000Z",
			},
			scheduleCustomEntry(
				{
					id: "good",
					dueAtMs: 42,
					prompt: "keep me",
					createdAt: 7,
				},
				"good-entry",
			),
		];

		expect(() => foldPendingSessionSchedules(entries)).not.toThrow();
		expect(foldPendingSessionSchedules(entries)).toEqual([
			{
				id: "good",
				dueAtMs: 42,
				prompt: "keep me",
				createdAt: 7,
			},
		]);
	});
});
