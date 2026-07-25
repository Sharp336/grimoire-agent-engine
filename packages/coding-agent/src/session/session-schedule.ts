/**
 * Session self-scheduling — persist wake intent in the transcript, fold the
 * newest entry per id, and arm one ManagedTimers timeout per pending schedule.
 *
 * Schedules are one-shot and live only while the process does. Firing never
 * invokes a tool; it enqueues the stored prompt as a hidden nextTurn message
 * through the same sendHiddenMessage seam GoalRuntime uses.
 */
import { isRecord, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { ManagedTimers } from "../extensibility/extensions/managed-timers";
import type { SessionEntry } from "./session-entries";

export const SESSION_SCHEDULE_CUSTOM_TYPE = "session-schedule";
export const SESSION_SCHEDULE_MESSAGE_TYPE = "session-schedule-wake";

/** Create payload persisted via appendCustomEntry. */
export type SessionScheduleCreateData = {
	id: string;
	dueAtMs: number;
	prompt: string;
	createdAt: number;
};

/** Cancellation tombstone for the same id. */
export type SessionScheduleCancelData = {
	id: string;
	cancelled: true;
};

/** Fired tombstone so restore does not re-arm an already-delivered wake. */
export type SessionScheduleFiredData = {
	id: string;
	fired: true;
};

export type SessionScheduleData = SessionScheduleCreateData | SessionScheduleCancelData | SessionScheduleFiredData;

export type SessionScheduleClassification =
	| { kind: "create"; data: SessionScheduleCreateData }
	| { kind: "cancel"; data: SessionScheduleCancelData }
	| { kind: "fired"; data: SessionScheduleFiredData };

/** Pending wake after the newest-per-id fold drops cancelled and fired ids. */
export type PendingSessionSchedule = SessionScheduleCreateData;

export type SessionScheduleCreateInput = {
	delayMs?: number;
	atIso?: string;
	prompt: string;
};

/** Timer surface compatible with {@link ManagedTimers}. */
export type SessionScheduleTimerHost = Pick<ManagedTimers, "setTimeout" | "clear">;

/**
 * Fire host — mirrors GoalRuntimeHost.sendHiddenMessage and adds the persistence
 * + triggerTurn hooks schedules need. Orchestrator wires this from AgentSession.
 */
export type SessionScheduleFireHost = {
	getEntries: () => readonly SessionEntry[];
	appendCustomEntry: (customType: string, data?: unknown) => string;
	flush?: () => Promise<void>;
	sendHiddenMessage: (message: {
		customType: string;
		content: string;
		deliverAs?: "steer" | "followUp" | "nextTurn";
		triggerTurn?: boolean;
	}) => Promise<void>;
	now?: () => number;
};

export type ArmSessionSchedulesResult = {
	pending: PendingSessionSchedule[];
	disarm: () => void;
};

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Classify a custom-entry payload; unknown shapes are ignored (not authoritative). */
export function classifySessionScheduleData(data: unknown): SessionScheduleClassification | undefined {
	if (!isRecord(data) || typeof data.id !== "string" || data.id.length === 0) return undefined;

	if (data.cancelled === true) {
		return { kind: "cancel", data: { id: data.id, cancelled: true } };
	}
	if (data.fired === true) {
		return { kind: "fired", data: { id: data.id, fired: true } };
	}
	if (
		isFiniteNumber(data.dueAtMs) &&
		typeof data.prompt === "string" &&
		data.prompt.length > 0 &&
		isFiniteNumber(data.createdAt)
	) {
		return {
			kind: "create",
			data: {
				id: data.id,
				dueAtMs: data.dueAtMs,
				prompt: data.prompt,
				createdAt: data.createdAt,
			},
		};
	}
	return undefined;
}

/**
 * Newest entry per id wins. Cancelled and fired ids are dropped; overdue creates
 * remain pending so restore can fire them once at the next turn boundary.
 */
export function foldPendingSessionSchedules(entries: readonly SessionEntry[]): PendingSessionSchedule[] {
	const newest = new Map<string, SessionScheduleClassification>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SESSION_SCHEDULE_CUSTOM_TYPE) continue;
		const classified = classifySessionScheduleData(entry.data);
		if (!classified) continue;
		newest.set(classified.data.id, classified);
	}

	const pending: PendingSessionSchedule[] = [];
	for (const classified of newest.values()) {
		switch (classified.kind) {
			case "create":
				pending.push(classified.data);
				break;
			case "cancel":
			case "fired":
				break;
			default: {
				const _exhaustive: never = classified;
				void _exhaustive;
				break;
			}
		}
	}
	return pending;
}

export function resolveScheduleDueAtMs(
	input: SessionScheduleCreateInput,
	nowMs: number,
): { dueAtMs: number } | { error: string } {
	const hasDelay = input.delayMs !== undefined;
	const hasAt = input.atIso !== undefined;
	if (hasDelay === hasAt) {
		return { error: "Exactly one of delayMs or atIso must be supplied." };
	}
	if (hasDelay) {
		const delayMs = input.delayMs;
		if (delayMs === undefined || !Number.isInteger(delayMs) || delayMs < 0) {
			return { error: "delayMs must be a non-negative integer." };
		}
		return { dueAtMs: nowMs + delayMs };
	}
	const atIso = input.atIso;
	if (atIso === undefined || atIso.trim().length === 0) {
		return { error: "atIso must be a non-empty ISO-8601 timestamp." };
	}
	const parsed = Date.parse(atIso);
	if (!Number.isFinite(parsed)) {
		return { error: `atIso is not a valid ISO-8601 timestamp: ${atIso}` };
	}
	return { dueAtMs: parsed };
}

async function persistFiredAndEnqueue(
	host: SessionScheduleFireHost,
	schedule: PendingSessionSchedule,
	triggerTurn: boolean,
): Promise<void> {
	const stillPending = foldPendingSessionSchedules(host.getEntries()).some(entry => entry.id === schedule.id);
	if (!stillPending) return;

	host.appendCustomEntry(SESSION_SCHEDULE_CUSTOM_TYPE, {
		id: schedule.id,
		fired: true,
	} satisfies SessionScheduleFiredData);
	if (host.flush) await host.flush();

	await host.sendHiddenMessage({
		customType: SESSION_SCHEDULE_MESSAGE_TYPE,
		content: schedule.prompt,
		deliverAs: "nextTurn",
		triggerTurn,
	});
}

/**
 * Arm one timeout per pending schedule. A schedule whose dueAtMs has already
 * passed fires once at the next turn boundary (triggerTurn: false) rather than
 * being dropped or re-armed as a late repeating wake.
 */
export function armSessionSchedules(
	entries: readonly SessionEntry[],
	timers: SessionScheduleTimerHost,
	host: SessionScheduleFireHost,
	options?: { now?: () => number },
): ArmSessionSchedulesResult {
	const now = options?.now ?? (() => host.now?.() ?? Date.now());
	const pending = foldPendingSessionSchedules(entries);
	const armed = new Map<string, Timer>();

	const disarm = (): void => {
		for (const timer of armed.values()) timers.clear(timer);
		armed.clear();
	};

	const armOne = (schedule: PendingSessionSchedule): void => {
		const dueAtMs = schedule.dueAtMs;
		const nowMs = now();
		const overdue = dueAtMs <= nowMs;
		const delayMs = overdue ? 0 : Math.max(0, dueAtMs - nowMs);
		// Overdue: enqueue as nextTurn context without starting a turn (boundary).
		// Future: wake the session when the timer fires.
		const triggerTurn = !overdue;

		const timer = timers.setTimeout(() => {
			armed.delete(schedule.id);
			void persistFiredAndEnqueue(host, schedule, triggerTurn).catch(err => {
				logger.warn("session-schedule fire failed", {
					id: schedule.id,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, delayMs);
		armed.set(schedule.id, timer);
	};

	for (const schedule of pending) armOne(schedule);

	return { pending, disarm };
}

/** Live controller: create/cancel persist first, then (re)arm timers. */
export class SessionScheduleController {
	readonly #timers: SessionScheduleTimerHost;
	readonly #host: SessionScheduleFireHost;
	readonly #now: () => number;
	#disarm: (() => void) | undefined;
	#disposed = false;

	constructor(timers: SessionScheduleTimerHost, host: SessionScheduleFireHost, now?: () => number) {
		this.#timers = timers;
		this.#host = host;
		this.#now = now ?? (() => host.now?.() ?? Date.now());
	}

	listPending(entries: readonly SessionEntry[] = this.#host.getEntries()): PendingSessionSchedule[] {
		return foldPendingSessionSchedules(entries);
	}

	/** Disarm previous timers and arm every currently pending schedule. */
	rearmFromEntries(entries: readonly SessionEntry[] = this.#host.getEntries()): PendingSessionSchedule[] {
		this.#assertLive();
		this.#disarm?.();
		const result = armSessionSchedules(entries, this.#timers, this.#host, { now: this.#now });
		this.#disarm = result.disarm;
		return result.pending;
	}

	create(input: SessionScheduleCreateInput): PendingSessionSchedule {
		this.#assertLive();
		const prompt = input.prompt.trim();
		if (!prompt) throw new Error("prompt must be a non-empty string.");

		const nowMs = this.#now();
		const due = resolveScheduleDueAtMs(input, nowMs);
		if ("error" in due) throw new Error(due.error);

		const schedule: PendingSessionSchedule = {
			id: String(Snowflake.next()),
			dueAtMs: due.dueAtMs,
			prompt,
			createdAt: nowMs,
		};
		this.#host.appendCustomEntry(SESSION_SCHEDULE_CUSTOM_TYPE, schedule);
		this.rearmFromEntries();
		return schedule;
	}

	cancel(id: string): boolean {
		this.#assertLive();
		const trimmed = id.trim();
		if (!trimmed) throw new Error("cancel id must be a non-empty string.");

		const pending = this.listPending();
		const existed = pending.some(schedule => schedule.id === trimmed);
		this.#host.appendCustomEntry(SESSION_SCHEDULE_CUSTOM_TYPE, {
			id: trimmed,
			cancelled: true,
		} satisfies SessionScheduleCancelData);
		this.rearmFromEntries();
		return existed;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#disarm?.();
		this.#disarm = undefined;
	}

	#assertLive(): void {
		if (this.#disposed) throw new Error("SessionScheduleController has been disposed.");
	}
}

/**
 * Named init the orchestrator calls from AgentSession construction and after
 * newSession/switchSession.
 */
export function initSessionSchedules(
	entries: readonly SessionEntry[],
	timers: SessionScheduleTimerHost,
	host: SessionScheduleFireHost,
	options?: { now?: () => number },
): SessionScheduleController {
	const controller = new SessionScheduleController(timers, host, options?.now);
	controller.rearmFromEntries(entries);
	return controller;
}
