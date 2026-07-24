import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { normalizeGeneratedTitle } from "../tiny/text";
import type { FileEntry } from "./session-entries";

export const CONSULTATION_THREAD_CUSTOM_TYPE = "consultation-thread";
export const CONSULTATION_TURN_CUSTOM_TYPE = "consultation-turn";
/** Written exactly once, only after the canonical title service produced a subject. */
export const CONSULTATION_TITLE_CUSTOM_TYPE = "consultation-title";
/** Append-only retry state for a consultation without a generated title. */
export const CONSULTATION_TITLE_STATE_CUSTOM_TYPE = "consultation-title-state";
export const CONSULTATION_STATUS_MESSAGE_TYPE = "consultation-status";
export const CONSULTATION_TRANSCRIPT_STEM = "__consult";

export type ConsultationStatus = "running" | "completed" | "failed" | "cancelled";

/** Immutable lineage for a durable consultation thread. */
export interface ConsultationThreadRecord {
	version: 1;
	consultationId: string;
	parentSessionId: string;
	parentLeafId: string | null;
	createdAt: number;
}

/**
 * One durable canonical subject, written only after generation succeeds.
 * `source` distinguishes it from the legacy first-question fallback records.
 */
export interface ConsultationTitleRecord {
	version: 1;
	consultationId: string;
	source: "canonical";
	title: string;
	createdAt: number;
}

/** Durable retry state while a consultation still has no generated subject. */
export interface ConsultationTitleStateRecord {
	version: 1;
	consultationId: string;
	status: "pending" | "failed";
	attemptedAt: number;
	error?: string;
}

export interface ConsultationTitlePresentation {
	/** Canonical generated title, absent until the title service succeeds. */
	generatedTitle: string | undefined;
	/** Safe display fallback; never evidence of generated-title success. */
	displayTitle: string;
}

/** First completed consultation exchange, suitable for canonical titling. */
export interface ConsultationFirstTurnConversation {
	question: string;
	answer: string;
}

/** Append-only state record for one consultation turn. */
export interface ConsultationTurnRecord {
	version: 1;
	consultationId: string;
	turnId: string;
	turnIndex: number;
	question: string;
	promptText: string;
	provider: string;
	model: string;
	status: ConsultationStatus;
	startedAt: number;
	finishedAt?: number;
	error?: string;
	partialAnswer?: string;
}

export interface ConsultationTurnState {
	turn: ConsultationTurnRecord;
	terminal: ConsultationTurnRecord | undefined;
}

/**
 * The result of looking up a thread in one consultation transcript. A collision
 * means the file contains conflicting immutable thread identities and must not
 * be used to revive either identity.
 */
export interface ConsultationThreadLookup {
	consultationId: string;
	thread: ConsultationThreadRecord | undefined;
	threadIds: readonly string[];
	hasCollision: boolean;
}

const FILE_SAFE_ID = /^[A-Za-z0-9._-]+$/;
const TERMINAL_STATUSES = new Set<ConsultationStatus>(["completed", "failed", "cancelled"]);
const CONSULTATION_TITLE_MAX_LENGTH = 80;
const CONSULTATION_SHORT_ID_LENGTH = 8;

export function normalizeConsultationTitle(value: string): string | undefined {
	const normalized = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	if (!normalized) return undefined;
	const chars = [...normalized];
	return chars.length > CONSULTATION_TITLE_MAX_LENGTH
		? `${chars.slice(0, CONSULTATION_TITLE_MAX_LENGTH - 1).join("")}…`
		: normalized;
}

/** Deterministic presentation fallback, never persisted as a generated title. */
export function fallbackConsultationTitle(question: string): string {
	return normalizeConsultationTitle(question) ?? "Untitled consultation";
}

/**
 * Compact a durable id by suffix. Snowflake ids share timestamp-heavy prefixes,
 * so a suffix stays short while growing only when sibling ids collide.
 */
export function consultationShortId(consultationId: string, siblingIds: readonly string[] = []): string {
	if (!FILE_SAFE_ID.test(consultationId)) return consultationId;
	const ids = new Set(siblingIds.filter(id => FILE_SAFE_ID.test(id)));
	ids.add(consultationId);
	for (
		let length = Math.min(CONSULTATION_SHORT_ID_LENGTH, consultationId.length);
		length < consultationId.length;
		length++
	) {
		const suffix = consultationId.slice(-length);
		let unique = true;
		for (const id of ids) {
			if (id !== consultationId && id.endsWith(suffix)) {
				unique = false;
				break;
			}
		}
		if (unique) return suffix;
	}
	return consultationId;
}

/** Stable presentation label; registry ids remain the full durable ids. */
export function formatConsultationDisplayName(
	displayTitle: string | undefined,
	consultationId: string,
	siblingIds: readonly string[] = [],
): string {
	return `${normalizeConsultationTitle(displayTitle ?? "") ?? "Untitled consultation"} · consult:${consultationShortId(consultationId, siblingIds)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is ConsultationStatus {
	return value === "running" || TERMINAL_STATUSES.has(value as ConsultationStatus);
}

function immutableThread(record: ConsultationThreadRecord): ConsultationThreadRecord {
	return Object.freeze({ ...record });
}

function immutableTitle(record: ConsultationTitleRecord): ConsultationTitleRecord {
	return Object.freeze({ ...record });
}

function immutableTurn(record: ConsultationTurnRecord): ConsultationTurnRecord {
	return Object.freeze({ ...record });
}

function parseThreadRecord(value: unknown): ConsultationThreadRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== 1 ||
		typeof value.consultationId !== "string" ||
		!FILE_SAFE_ID.test(value.consultationId) ||
		typeof value.parentSessionId !== "string" ||
		(value.parentLeafId !== null && typeof value.parentLeafId !== "string") ||
		!isFiniteNumber(value.createdAt)
	) {
		return undefined;
	}
	return immutableThread({
		version: 1,
		consultationId: value.consultationId,
		parentSessionId: value.parentSessionId,
		parentLeafId: value.parentLeafId,
		createdAt: value.createdAt,
	});
}

/**
 * Parse a canonical generated title. Display fallbacks intentionally never
 * satisfy this record: its presence is the durable success boundary.
 */
export function parseConsultationTitleRecord(value: unknown): ConsultationTitleRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== 1 ||
		typeof value.consultationId !== "string" ||
		!FILE_SAFE_ID.test(value.consultationId) ||
		value.source !== "canonical" ||
		typeof value.title !== "string" ||
		!isFiniteNumber(value.createdAt)
	) {
		return undefined;
	}
	const title = normalizeGeneratedTitle(value.title);
	return title
		? immutableTitle({
				version: 1,
				consultationId: value.consultationId,
				source: "canonical",
				title,
				createdAt: value.createdAt,
			})
		: undefined;
}

export function parseConsultationTitleStateRecord(value: unknown): ConsultationTitleStateRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== 1 ||
		typeof value.consultationId !== "string" ||
		!FILE_SAFE_ID.test(value.consultationId) ||
		(value.status !== "pending" && value.status !== "failed") ||
		!isFiniteNumber(value.attemptedAt) ||
		(value.error !== undefined && typeof value.error !== "string")
	) {
		return undefined;
	}
	return Object.freeze({
		version: 1,
		consultationId: value.consultationId,
		status: value.status,
		attemptedAt: value.attemptedAt,
		error: value.error,
	});
}

function parseTurnRecord(value: unknown): ConsultationTurnRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== 1 ||
		typeof value.consultationId !== "string" ||
		!FILE_SAFE_ID.test(value.consultationId) ||
		typeof value.turnId !== "string" ||
		!FILE_SAFE_ID.test(value.turnId) ||
		!isNonNegativeInteger(value.turnIndex) ||
		typeof value.question !== "string" ||
		typeof value.promptText !== "string" ||
		typeof value.provider !== "string" ||
		typeof value.model !== "string" ||
		!isStatus(value.status) ||
		!isFiniteNumber(value.startedAt) ||
		(value.finishedAt !== undefined && !isFiniteNumber(value.finishedAt)) ||
		(value.error !== undefined && typeof value.error !== "string") ||
		(value.partialAnswer !== undefined && typeof value.partialAnswer !== "string")
	) {
		return undefined;
	}
	return immutableTurn({
		version: 1,
		consultationId: value.consultationId,
		turnId: value.turnId,
		turnIndex: value.turnIndex,
		question: value.question,
		promptText: value.promptText,
		provider: value.provider,
		model: value.model,
		status: value.status,
		startedAt: value.startedAt,
		finishedAt: value.finishedAt,
		error: value.error,
		partialAnswer: value.partialAnswer,
	});
}

function customData(entry: FileEntry, customType: string): unknown | undefined {
	return entry.type === "custom" && entry.customType === customType ? entry.data : undefined;
}

function sameThread(a: ConsultationThreadRecord, b: ConsultationThreadRecord): boolean {
	return (
		a.consultationId === b.consultationId &&
		a.parentSessionId === b.parentSessionId &&
		a.parentLeafId === b.parentLeafId &&
		a.createdAt === b.createdAt
	);
}

/**
 * Look up immutable thread metadata without trusting the transcript filename.
 * A file with a foreign thread id or incompatible duplicate records is a
 * collision, rather than a reason to accidentally revive the wrong thread.
 */
export function lookupConsultationThread(
	entries: readonly FileEntry[],
	consultationId: string,
): ConsultationThreadLookup {
	const byId = new Map<string, ConsultationThreadRecord>();
	const collisions = new Set<string>();
	for (const entry of entries) {
		const record = parseThreadRecord(customData(entry, CONSULTATION_THREAD_CUSTOM_TYPE));
		if (!record) continue;
		const previous = byId.get(record.consultationId);
		if (previous && !sameThread(previous, record)) collisions.add(record.consultationId);
		else if (!previous) byId.set(record.consultationId, record);
	}
	const threadIds = [...byId.keys()].sort();
	const thread = byId.get(consultationId);
	return Object.freeze({
		consultationId,
		thread,
		threadIds: Object.freeze(threadIds),
		hasCollision: collisions.size > 0 || (threadIds.length > 0 && (threadIds.length !== 1 || !thread)),
	});
}

/** Return one immutable thread record only when its identity is unambiguous. */
export function consultationThreadMetadata(
	entries: readonly FileEntry[],
	consultationId: string,
): ConsultationThreadRecord | undefined {
	const lookup = lookupConsultationThread(entries, consultationId);
	return lookup.hasCollision ? undefined : lookup.thread;
}

/**
 * The first valid title is authoritative. A later title cannot silently rename
 * an already durable consultation after a restart or concurrent follow-up.
 */
export function consultationThreadTitleRecord(
	entries: readonly FileEntry[],
	consultationId: string,
): ConsultationTitleRecord | undefined {
	for (const entry of entries) {
		const record = parseConsultationTitleRecord(customData(entry, CONSULTATION_TITLE_CUSTOM_TYPE));
		if (record?.consultationId === consultationId) return record;
	}
	return undefined;
}

/** Resolve the persisted title without exposing transcript entry internals. */
export function consultationThreadTitle(entries: readonly FileEntry[], consultationId: string): string | undefined {
	return consultationThreadTitleRecord(entries, consultationId)?.title;
}

/** Latest durable retry state; any generated title remains authoritative. */
export function consultationThreadTitleState(
	entries: readonly FileEntry[],
	consultationId: string,
): ConsultationTitleStateRecord | undefined {
	let state: ConsultationTitleStateRecord | undefined;
	for (const entry of entries) {
		const record = parseConsultationTitleStateRecord(customData(entry, CONSULTATION_TITLE_STATE_CUSTOM_TYPE));
		if (record?.consultationId === consultationId) state = record;
	}
	return state;
}

/**
 * Keep canonical generated data distinct from the display-only question
 * fallback. Consumers must use `generatedTitle` to determine title success.
 */
export function consultationThreadTitlePresentation(
	entries: readonly FileEntry[],
	consultationId: string,
): ConsultationTitlePresentation {
	const generatedTitle = consultationThreadTitle(entries, consultationId);
	const firstQuestion = consultationTurnStates(entries, consultationId)[0]?.turn.question ?? "";
	return Object.freeze({
		generatedTitle,
		displayTitle: generatedTitle ?? fallbackConsultationTitle(firstQuestion),
	});
}

/**
 * Reduce append-only turn records to their latest state, ordered by turn index.
 * Duplicate indices/ids with incompatible immutable turn metadata are ignored
 * after the first record, so corrupt records cannot rewrite an earlier turn.
 */
export function consultationTurnStates(
	entries: readonly FileEntry[],
	consultationId: string,
): readonly ConsultationTurnState[] {
	const turns = new Map<string, { turn: ConsultationTurnRecord; latest: ConsultationTurnRecord; order: number }>();
	let order = 0;
	for (const entry of entries) {
		const record = parseTurnRecord(customData(entry, CONSULTATION_TURN_CUSTOM_TYPE));
		if (!record || record.consultationId !== consultationId) continue;
		const existing = turns.get(record.turnId);
		if (!existing) {
			turns.set(record.turnId, { turn: record, latest: record, order: order++ });
			continue;
		}
		if (
			existing.turn.turnIndex !== record.turnIndex ||
			existing.turn.question !== record.question ||
			existing.turn.promptText !== record.promptText ||
			existing.turn.provider !== record.provider ||
			existing.turn.model !== record.model ||
			existing.turn.startedAt !== record.startedAt
		) {
			continue;
		}
		existing.latest = record;
	}
	return Object.freeze(
		[...turns.values()]
			.sort((a, b) => a.turn.turnIndex - b.turn.turnIndex || a.order - b.order)
			.map(({ turn, latest }) =>
				Object.freeze({ turn, terminal: TERMINAL_STATUSES.has(latest.status) ? latest : undefined }),
			),
	);
}

/** The latest terminal state across all ordered turns, if a turn has finished. */
export function latestTerminalConsultationTurn(
	entries: readonly FileEntry[],
	consultationId: string,
): ConsultationTurnRecord | undefined {
	let latest: ConsultationTurnRecord | undefined;
	for (const state of consultationTurnStates(entries, consultationId)) {
		if (state.terminal) latest = state.terminal;
	}
	return latest;
}

/**
 * Recover the first completed consultation exchange from its turn-local
 * messages. Follow-ups are deliberately excluded from the title input.
 */
export function consultationFirstTurnConversation(
	entries: readonly FileEntry[],
	consultationId: string,
): ConsultationFirstTurnConversation | undefined {
	const firstTurn = consultationTurnStates(entries, consultationId)[0];
	if (firstTurn?.terminal?.status !== "completed") return undefined;

	let insideFirstTurn = false;
	for (const entry of entries) {
		const turn = parseTurnRecord(customData(entry, CONSULTATION_TURN_CUSTOM_TYPE));
		if (turn?.consultationId === consultationId) {
			if (turn.turnId === firstTurn.turn.turnId) {
				insideFirstTurn = true;
				continue;
			}
			if (insideFirstTurn) break;
			continue;
		}
		if (!insideFirstTurn || entry.type !== "message" || entry.message.role !== "assistant") continue;
		const answer = entry.message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("")
			.trim();
		if (answer) return Object.freeze({ question: firstTurn.turn.question, answer });
	}
	return undefined;
}

/**
 * Replay only message entries belonging to successfully completed turns. Failed
 * and cancelled turns deliberately contribute no partial user/assistant replay.
 */
export function replayCompletedConsultationMessages(
	entries: readonly FileEntry[],
	consultationId: string,
): readonly AgentMessage[] {
	const completedTurnIds = new Set(
		consultationTurnStates(entries, consultationId)
			.filter(state => state.terminal?.status === "completed")
			.map(state => state.turn.turnId),
	);
	if (completedTurnIds.size === 0) return Object.freeze([]);

	const replay: AgentMessage[] = [];
	const seenTurnIds = new Set<string>();
	let precedingMessage: AgentMessage | undefined;
	let activeTurnId: string | undefined;
	for (const entry of entries) {
		if (entry.type === "message") {
			if (activeTurnId && completedTurnIds.has(activeTurnId)) replay.push(entry.message);
			else precedingMessage = entry.message;
			continue;
		}
		const turn = parseTurnRecord(customData(entry, CONSULTATION_TURN_CUSTOM_TYPE));
		if (turn?.consultationId !== consultationId) continue;
		if (!seenTurnIds.has(turn.turnId) && completedTurnIds.has(turn.turnId) && precedingMessage?.role === "user") {
			replay.push(precedingMessage);
		}
		seenTurnIds.add(turn.turnId);
		precedingMessage = undefined;
		activeTurnId = TERMINAL_STATUSES.has(turn.status) ? undefined : turn.turnId;
	}
	return Object.freeze(replay);
}

/**
 * Return only the latest turn's answer. A failed, cancelled, or running latest
 * turn without a saved partial answer must not fall back to an older turn.
 */
export function latestConsultationAnswer(entries: readonly FileEntry[], consultationId: string): string | undefined {
	const latest = consultationTurnStates(entries, consultationId).at(-1);
	const partialAnswer = latest?.terminal?.partialAnswer?.trim();
	if (partialAnswer) return partialAnswer;
	if (latest?.terminal?.status !== "completed") return undefined;
	for (const message of [...replayCompletedConsultationMessages(entries, consultationId)].reverse()) {
		if (message.role !== "assistant") continue;
		const answer = message.content
			.filter(content => content.type === "text")
			.map(content => content.text)
			.join("")
			.trim();
		if (answer) return answer;
	}
	return undefined;
}

export function consultationTranscriptStem(id: string): string {
	if (!FILE_SAFE_ID.test(id)) throw new Error("Invalid consultation id");
	return `${CONSULTATION_TRANSCRIPT_STEM}.${id}`;
}

export function consultationTranscriptFilename(id: string): string {
	return `${consultationTranscriptStem(id)}.jsonl`;
}

export function parseConsultationTranscriptName(name: string): string | undefined {
	const prefix = `${CONSULTATION_TRANSCRIPT_STEM}.`;
	const suffix = ".jsonl";
	if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
	const id = name.slice(prefix.length, -suffix.length);
	return FILE_SAFE_ID.test(id) ? id : undefined;
}

export function consultationAgentId(ownerId: string, id: string): string {
	return `${ownerId}/consult:${id}`;
}
