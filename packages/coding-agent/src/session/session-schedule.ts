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

/** Largest delay Bun can represent without firing its timeout almost immediately. */
export const SESSION_SCHEDULE_MAX_DELAY_MS = 2_147_483_647;

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
	isLive?: () => boolean;
};

export type ArmSessionSchedulesOptions = {
	now?: () => number;
	/**
	 * Schedules created due-now in this live session (delayMs: 0). They fire with
	 * triggerTurn so the wake starts a turn — unlike a restored overdue schedule,
	 * which is delivered at the next turn boundary without starting one.
	 */
	triggerTurnIds?: ReadonlySet<string>;
	/**
	 * Ids with a delivery in flight. The controller shares this set across rearms so
	 * an unrelated create/cancel cannot arm a second timer for a wake whose enqueue
	 * is still awaiting completion (which would deliver it twice).
	 */
	inflight?: Set<string>;
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

/** ISO-8601 date or date-time; rejects locale forms Date.parse tolerates (e.g. 07/27/2026). */
const ISO_8601_SHAPE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

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
		if (delayMs > SESSION_SCHEDULE_MAX_DELAY_MS) {
			return { error: `delayMs must not exceed ${SESSION_SCHEDULE_MAX_DELAY_MS}.` };
		}
		return { dueAtMs: nowMs + delayMs };
	}
	const atIso = input.atIso;
	if (atIso === undefined || atIso.trim().length === 0) {
		return { error: "atIso must be a non-empty ISO-8601 timestamp." };
	}
	if (!ISO_8601_SHAPE.test(atIso.trim())) {
		return { error: `atIso must be an ISO-8601 timestamp: ${atIso}` };
	}
	const parsed = Date.parse(atIso);
	if (!Number.isFinite(parsed)) {
		return { error: `atIso is not a valid ISO-8601 timestamp: ${atIso}` };
	}
	if (parsed <= nowMs) {
		return { error: "atIso must be in the future." };
	}
	if (parsed - nowMs > SESSION_SCHEDULE_MAX_DELAY_MS) {
		return { error: `atIso must not be more than ${SESSION_SCHEDULE_MAX_DELAY_MS}ms in the future.` };
	}
	return { dueAtMs: parsed };
}

/**
 * Fire one schedule. Delivery is ordered before the tombstone: persisting `fired`
 * before the enqueue succeeds would permanently drop the wake on any send failure,
 * while delivering first means a tombstone failure merely repeats the wake once on
 * restore — a duplicate beats a lost delivery. A failed send leaves the create
 * pending, so the next rearm or restore fires it again.
 */
async function enqueueAndPersistFired(
	host: SessionScheduleFireHost,
	schedule: PendingSessionSchedule,
	triggerTurn: boolean,
	isArmLive: () => boolean,
): Promise<void> {
	if (!isArmLive() || (host.isLive && !host.isLive())) return;
	const isStillPending = (): boolean =>
		foldPendingSessionSchedules(host.getEntries()).some(entry => entry.id === schedule.id);
	if (!isStillPending()) return;

	// Flush before delivering so a branch swap or liveness loss during the write is
	// observed before the message goes out, not after.
	if (host.flush) await host.flush();
	if ((host.isLive && !host.isLive()) || !isStillPending()) return;

	await host.sendHiddenMessage({
		customType: SESSION_SCHEDULE_MESSAGE_TYPE,
		content: schedule.prompt,
		deliverAs: "nextTurn",
		triggerTurn,
	});

	// Delivered: tombstone so restore does not re-arm. If the session died or the
	// branch moved during the send, leave the create pending instead.
	if ((host.isLive && !host.isLive()) || !isStillPending()) return;
	host.appendCustomEntry(SESSION_SCHEDULE_CUSTOM_TYPE, {
		id: schedule.id,
		fired: true,
	} satisfies SessionScheduleFiredData);
	if (host.flush) await host.flush();
}

/**
 * Arm one timeout per pending schedule. A restored schedule whose dueAtMs has
 * already passed fires once at the next turn boundary (triggerTurn: false) rather
 * than being dropped or re-armed as a late repeating wake; a schedule created
 * due-now in this session fires with triggerTurn: true so the wake starts a turn.
 */
export function armSessionSchedules(
	entries: readonly SessionEntry[],
	timers: SessionScheduleTimerHost,
	host: SessionScheduleFireHost,
	options?: ArmSessionSchedulesOptions,
): ArmSessionSchedulesResult {
	const now = options?.now ?? (() => host.now?.() ?? Date.now());
	const triggerTurnIds = options?.triggerTurnIds;
	const inflight = options?.inflight ?? new Set<string>();
	const pending = foldPendingSessionSchedules(entries);
	const armed = new Map<string, Timer>();
	let active = true;

	const disarm = (): void => {
		active = false;
		for (const timer of armed.values()) timers.clear(timer);
		armed.clear();
	};

	const armOne = (schedule: PendingSessionSchedule): void => {
		// A delivery already in flight survives rearms; a second timer would deliver
		// the same wake twice.
		if (inflight.has(schedule.id)) return;
		const dueAtMs = schedule.dueAtMs;
		const nowMs = now();
		const overdue = dueAtMs <= nowMs;
		const delayMs = overdue ? 0 : Math.max(0, dueAtMs - nowMs);
		// Overdue restored: enqueue as nextTurn context without starting a turn
		// (boundary). Due-now create or future wake: trigger a turn when it fires.
		const triggerTurn = !overdue || (triggerTurnIds?.has(schedule.id) ?? false);
		if (!overdue && delayMs > SESSION_SCHEDULE_MAX_DELAY_MS) {
			logger.warn("session-schedule not armed: persisted delay exceeds timer maximum", {
				id: schedule.id,
				dueAtMs,
				delayMs,
			});
			return;
		}

		const timer = timers.setTimeout(() => {
			armed.delete(schedule.id);
			inflight.add(schedule.id);
			void enqueueAndPersistFired(host, schedule, triggerTurn, () => active)
				.catch(err => {
					logger.warn("session-schedule fire failed", {
						id: schedule.id,
						error: err instanceof Error ? err.message : String(err),
					});
				})
				.finally(() => {
					inflight.delete(schedule.id);
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
	readonly #inflight = new Set<string>();
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

	/**
	 * Disarm previous timers and arm every currently pending schedule. Deliveries in
	 * flight are left alone. `triggerTurnIds` marks schedules created due-now in this
	 * session so their fire triggers a turn instead of waiting for a turn boundary.
	 */
	rearmFromEntries(
		entries: readonly SessionEntry[] = this.#host.getEntries(),
		triggerTurnIds?: ReadonlySet<string>,
	): PendingSessionSchedule[] {
		this.#assertLive();
		this.#disarm?.();
		const result = armSessionSchedules(entries, this.#timers, this.#host, {
			now: this.#now,
			triggerTurnIds,
			inflight: this.#inflight,
		});
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
		// delayMs: 0 is due at creation: fire immediately and trigger a turn, unlike
		// a restored overdue wake, which waits for the next turn boundary.
		this.rearmFromEntries(undefined, due.dueAtMs <= nowMs ? new Set([schedule.id]) : undefined);
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
