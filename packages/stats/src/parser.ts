import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AssistantMessage, getPriorityPremiumRequests, type ServiceTier } from "@oh-my-pi/pi-ai";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import type {
	AgentType,
	HealthEventKind,
	MessageStats,
	SessionCompactionEntry,
	SessionEntry,
	SessionHealthStats,
	SessionInitEntry,
	SessionMessageEntry,
	SessionModelChangeEntry,
	SessionServiceTierChangeEntry,
	ToolResultMessage,
	UserMessageLink,
	UserMessageStats,
} from "./types";
import { computeUserMessageMetrics } from "./user-metrics";

/** Basename of an advisor agent's transcript inside a session artifacts dir. */
const ADVISOR_TRANSCRIPT_BASENAME = "__advisor.jsonl";

/**
 * Classify which agent produced a transcript from its path within the sessions
 * directory. Layout: `<sessionsDir>/<project>/<file>.jsonl` is the `main`
 * agent; subagent and advisor transcripts live nested one level deeper inside
 * the session's artifacts dir (`<project>/<session>/<id>.jsonl`,
 * `<project>/<session>/__advisor.jsonl`). Any `__advisor.jsonl` — at any depth,
 * including a subagent's own advisor — counts as `advisor`; every other nested
 * transcript is a task `subagent`.
 */
export function classifyAgentType(sessionPath: string): AgentType {
	if (path.basename(sessionPath) === ADVISOR_TRANSCRIPT_BASENAME) return "advisor";
	const rel = path.relative(getSessionsDir(), sessionPath);
	// `<project>/<file>.jsonl` -> 2 segments. Deeper nesting is a subagent.
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

/**
 * Extract folder name from session filename.
 * Session files are named like: --work--pi--/timestamp_uuid.jsonl
 * The folder part uses -- as path separator.
 */
function extractFolderFromPath(sessionPath: string): string {
	const sessionsDir = getSessionsDir();
	const rel = path.relative(sessionsDir, sessionPath);
	const projectDir = rel.split(path.sep)[0];
	// Convert --work--pi-- to /work/pi
	return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

/**
 * Check if an entry is an assistant message.
 */
function isAssistantMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	// Legacy sessions (pre-id tracking) recorded message entries without an `id`.
	// They're not linkable and would violate the messages.entry_id NOT NULL
	// constraint, so skip them at the parser boundary.
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "assistant";
}

/**
 * Check if an entry is a user message (non-toolResult).
 */
function isUserMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "user";
}

/**
 * Check if an entry is a service-tier change.
 */
function isServiceTierChange(entry: SessionEntry): entry is SessionServiceTierChangeEntry {
	return entry.type === "service_tier_change";
}

/**
 * Extract plain text from a user message content payload.
 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

/**
 * Build user-message stats from an entry. Returns null for empty/synthetic content.
 */
function extractUserStats(sessionFile: string, folder: string, entry: SessionMessageEntry): UserMessageStats | null {
	const msg = entry.message as { role: "user"; content?: unknown; synthetic?: boolean };
	if (msg.role !== "user" || msg.synthetic) return null;
	const text = extractUserText(msg.content);
	if (!text.trim()) return null;
	const metrics = computeUserMessageMetrics(text);
	const ts = Date.parse(entry.timestamp);
	return {
		sessionFile,
		entryId: entry.id,
		folder,
		timestamp: Number.isFinite(ts) ? ts : 0,
		model: null,
		provider: null,
		chars: metrics.chars,
		words: metrics.words,
		yelling: metrics.yelling,
		profanity: metrics.profanity,
		anguish: metrics.anguish,
		negation: metrics.negation,
		repetition: metrics.repetition,
		blame: metrics.blame,
	};
}

/**
 * Extract stats from an assistant message entry.
 */
function extractStats(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	currentServiceTier: ServiceTier | undefined,
	agentType: AgentType,
): MessageStats | null {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant") return null;

	// Backfill: when the session recorded `priority` as the active service tier
	// at this point but the AI usage payload was captured before priority
	// requests were folded into `premiumRequests`, derive the count here so the
	// "Premium Reqs" stat aggregates priority traffic on re-sync. Trust any
	// non-zero value already in `usage.premiumRequests` (Copilot multipliers or
	// the new AI code path) and only synthesise when the field is missing/zero.
	const recorded = msg.usage.premiumRequests ?? 0;
	const derived = recorded > 0 ? recorded : getPriorityPremiumRequests(currentServiceTier, msg.provider);
	const usage = derived === recorded ? msg.usage : { ...msg.usage, premiumRequests: derived };

	return {
		sessionFile,
		entryId: entry.id,
		folder,
		model: msg.model,
		provider: msg.provider,
		api: msg.api,
		timestamp: msg.timestamp,
		duration: msg.duration ?? null,
		ttft: msg.ttft ?? null,
		stopReason: msg.stopReason,
		errorMessage: msg.errorMessage ?? null,
		usage,
		agentType,
	};
}

type HealthCounters = Pick<
	SessionHealthStats,
	| "retryCount"
	| "toolLoopCount"
	| "cancellationCount"
	| "editFilesChanged"
	| "editLinesAdded"
	| "editLinesRemoved"
	| "compactionCount"
	| "compactionTokensBefore"
	| "modelSwitchCount"
	| "subagentSpawnCount"
	| "largeResultCount"
	| "largeResultBytes"
	| "largeResultLines"
>;

type HealthDimensions = {
	toolName?: string | null;
	model?: string | null;
	provider?: string | null;
};

const ABORT_LIKE_RE = /\b(abort(?:ed|ing)?|cancel(?:ed|led|ing)?|interrupt(?:ed|ing)?|stopped by user)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseEntryTimestamp(timestamp: unknown): number {
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	if (typeof timestamp !== "string") return 0;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

function healthStat(
	sessionFile: string,
	folder: string,
	entryId: string,
	timestamp: number,
	agentType: AgentType,
	kind: HealthEventKind,
	values: Partial<HealthCounters> & HealthDimensions,
): SessionHealthStats {
	return {
		sessionFile,
		entryId,
		folder,
		timestamp,
		agentType,
		kind,
		toolName: values.toolName ?? null,
		model: values.model ?? null,
		provider: values.provider ?? null,
		retryCount: values.retryCount ?? 0,
		toolLoopCount: values.toolLoopCount ?? 0,
		cancellationCount: values.cancellationCount ?? 0,
		editFilesChanged: values.editFilesChanged ?? 0,
		editLinesAdded: values.editLinesAdded ?? 0,
		editLinesRemoved: values.editLinesRemoved ?? 0,
		compactionCount: values.compactionCount ?? 0,
		compactionTokensBefore: values.compactionTokensBefore ?? 0,
		modelSwitchCount: values.modelSwitchCount ?? 0,
		subagentSpawnCount: values.subagentSpawnCount ?? 0,
		largeResultCount: values.largeResultCount ?? 0,
		largeResultBytes: values.largeResultBytes ?? 0,
		largeResultLines: values.largeResultLines ?? 0,
	};
}

function isModelChangeEntry(entry: SessionEntry): entry is SessionModelChangeEntry {
	const record = entry as Record<string, unknown>;
	return (
		entry.type === "model_change" &&
		typeof record.id === "string" &&
		typeof record.timestamp === "string" &&
		typeof record.model === "string"
	);
}

function isCompactionEntry(entry: SessionEntry): entry is SessionCompactionEntry {
	const record = entry as Record<string, unknown>;
	return entry.type === "compaction" && typeof record.id === "string" && typeof record.timestamp === "string";
}

function isSessionInitEntry(entry: SessionEntry): entry is SessionInitEntry {
	const record = entry as Record<string, unknown>;
	return entry.type === "session_init" && typeof record.id === "string" && typeof record.timestamp === "string";
}

function isToolResultMessageEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: ToolResultMessage } {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	const message = (msgEntry as unknown as { message?: unknown }).message;
	if (!isRecord(message)) return false;
	return message.role === "toolResult" && typeof message.toolName === "string";
}

function splitProviderModel(value: string): { provider: string | null; model: string } {
	const slash = value.indexOf("/");
	if (slash <= 0) return { provider: null, model: value };
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function assistantModelKey(message: AssistantMessage): string | undefined {
	if (!message.model) return undefined;
	return message.provider ? `${message.provider}/${message.model}` : message.model;
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isAbortLikeText(value: unknown): boolean {
	return typeof value === "string" && ABORT_LIKE_RE.test(value);
}

function extractTextContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const block of value) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function toolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") {
			names.push(block.name);
		}
	}
	return names;
}

interface DiffChurn {
	files: number;
	added: number;
	removed: number;
}

function countLogicalLines(text: string): number {
	if (text.length === 0) return 0;
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n").length : normalized.split("\n").length;
}

function hasMoveMetadata(details: Record<string, unknown>): boolean {
	const move = typeof details.move === "string" ? details.move.trim() : "";
	const sourcePath = typeof details.sourcePath === "string" ? details.sourcePath.trim() : "";
	return move.length > 0 || sourcePath.length > 0;
}

function churnFromEditMetadata(details: Record<string, unknown>): DiffChurn | null {
	const op = typeof details.op === "string" ? details.op : undefined;
	const oldText = typeof details.oldText === "string" ? details.oldText : undefined;
	const newText = typeof details.newText === "string" ? details.newText : undefined;
	if (op === "delete" && oldText !== undefined) {
		return { files: 1, added: 0, removed: countLogicalLines(oldText) };
	}
	if (op === "create" && newText !== undefined) {
		return { files: 1, added: countLogicalLines(newText), removed: 0 };
	}
	if (op === "update" && hasMoveMetadata(details)) {
		return { files: 1, added: 0, removed: 0 };
	}
	return null;
}

function parseUnifiedDiff(diff: string): DiffChurn {
	let added = 0;
	let removed = 0;
	let diffGitFiles = 0;
	let headerFiles = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("diff --git ")) {
			diffGitFiles++;
			continue;
		}
		if (line.startsWith("--- ")) {
			headerFiles++;
			continue;
		}
		if (line.startsWith("+++ ")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	const files = diffGitFiles || headerFiles || (added > 0 || removed > 0 ? 1 : 0);
	return { files, added, removed };
}

function extractEditChurn(details: unknown): DiffChurn | null {
	if (!isRecord(details)) return null;
	const perFile = Array.isArray(details.perFileResults) ? details.perFileResults : [];
	const paths = new Set<string>();
	let fallbackFiles = 0;
	let added = 0;
	let removed = 0;
	let sawChurn = false;
	const addChurn = (pathName: string | null, churn: DiffChurn) => {
		sawChurn = true;
		added += churn.added;
		removed += churn.removed;
		if (pathName) paths.add(pathName);
		else fallbackFiles += churn.files;
	};

	for (const item of perFile) {
		if (!isRecord(item)) continue;
		const pathName = typeof item.path === "string" ? item.path : null;
		if (typeof item.diff === "string" && item.diff.length > 0) {
			addChurn(pathName, parseUnifiedDiff(item.diff));
			continue;
		}
		const metadataChurn = churnFromEditMetadata(item);
		if (metadataChurn) addChurn(pathName, metadataChurn);
	}
	if (!sawChurn && typeof details.diff === "string" && details.diff.length > 0) {
		addChurn(null, parseUnifiedDiff(details.diff));
	}
	if (!sawChurn) {
		const metadataChurn = churnFromEditMetadata(details);
		if (metadataChurn) addChurn(typeof details.path === "string" ? details.path : null, metadataChurn);
	}

	const files = paths.size + fallbackFiles || (added > 0 || removed > 0 ? 1 : 0);
	if (files === 0 && added === 0 && removed === 0) return null;
	return { files, added, removed };
}

function extractLargeResult(details: unknown): { bytes: number; lines: number } | null {
	if (!isRecord(details) || !isRecord(details.meta) || !isRecord(details.meta.truncation)) return null;
	const truncation = details.meta.truncation;
	return {
		bytes: numberField(truncation.totalBytes),
		lines: numberField(truncation.totalLines),
	};
}

interface ModelSwitchState {
	currentModel: string | undefined;
}

function extractModelChangeHealth(
	sessionFile: string,
	folder: string,
	entry: SessionModelChangeEntry,
	agentType: AgentType,
	modelSwitchState: ModelSwitchState,
): SessionHealthStats | null {
	const previousModel = modelSwitchState.currentModel;
	modelSwitchState.currentModel = entry.model;
	if (!previousModel || previousModel === entry.model) return null;

	const { provider, model } = splitProviderModel(entry.model);
	return healthStat(sessionFile, folder, entry.id, parseEntryTimestamp(entry.timestamp), agentType, "model_switch", {
		modelSwitchCount: 1,
		model,
		provider,
	});
}

function extractCompactionHealth(
	sessionFile: string,
	folder: string,
	entry: SessionCompactionEntry,
	agentType: AgentType,
): SessionHealthStats {
	const record = entry as unknown as Record<string, unknown>;
	return healthStat(sessionFile, folder, entry.id, parseEntryTimestamp(entry.timestamp), agentType, "compaction", {
		compactionCount: 1,
		compactionTokensBefore: numberField(record.tokensBefore),
	});
}

function extractSessionInitHealth(
	sessionFile: string,
	folder: string,
	entry: SessionInitEntry,
	agentType: AgentType,
): SessionHealthStats | null {
	if (agentType !== "subagent") return null;
	return healthStat(sessionFile, folder, entry.id, parseEntryTimestamp(entry.timestamp), agentType, "subagent_spawn", {
		subagentSpawnCount: 1,
	});
}

interface AssistantLoopState {
	previousToolName: string | undefined;
}

function extractAssistantHealth(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	agentType: AgentType,
	loopState: AssistantLoopState,
): SessionHealthStats[] {
	const msg = entry.message as AssistantMessage;
	const timestamp = Number.isFinite(msg.timestamp) ? msg.timestamp : parseEntryTimestamp(entry.timestamp);
	const rows: SessionHealthStats[] = [];
	if (msg.stopReason === "error") {
		rows.push(
			healthStat(sessionFile, folder, entry.id, timestamp, agentType, "retry", {
				retryCount: 1,
				model: msg.model,
				provider: msg.provider,
			}),
		);
	}
	if (msg.stopReason === "aborted" || isAbortLikeText(msg.errorMessage)) {
		rows.push(
			healthStat(sessionFile, folder, entry.id, timestamp, agentType, "cancellation", {
				cancellationCount: 1,
				model: msg.model,
				provider: msg.provider,
			}),
		);
	}
	const names = toolCallNames(msg.content);
	if (names.length > 0) {
		const loopCounts = new Map<string, number>();
		let previousTool = loopState.previousToolName;
		for (const name of names) {
			if (previousTool === name) loopCounts.set(name, (loopCounts.get(name) ?? 0) + 1);
			previousTool = name;
		}
		loopState.previousToolName = previousTool;
		for (const [toolName, toolLoopCount] of loopCounts) {
			rows.push(
				healthStat(sessionFile, folder, entry.id, timestamp, agentType, "tool_loop", {
					toolName,
					toolLoopCount,
					model: msg.model,
					provider: msg.provider,
				}),
			);
		}
	} else {
		loopState.previousToolName = undefined;
	}
	return rows;
}

function extractToolResultHealth(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry & { message: ToolResultMessage },
	agentType: AgentType,
): SessionHealthStats[] {
	const msg = entry.message;
	const timestamp = parseEntryTimestamp(entry.timestamp);
	const rows: SessionHealthStats[] = [];
	if (msg.isError && isAbortLikeText(extractTextContent(msg.content))) {
		rows.push(
			healthStat(sessionFile, folder, entry.id, timestamp, agentType, "cancellation", {
				cancellationCount: 1,
				toolName: msg.toolName,
			}),
		);
	}
	const churn = extractEditChurn(msg.details);
	if (churn) {
		rows.push(
			healthStat(sessionFile, folder, entry.id, timestamp, agentType, "edit_churn", {
				toolName: msg.toolName,
				editFilesChanged: churn.files,
				editLinesAdded: churn.added,
				editLinesRemoved: churn.removed,
			}),
		);
	}
	const largeResult = extractLargeResult(msg.details);
	if (largeResult) {
		rows.push(
			healthStat(sessionFile, folder, entry.id, timestamp, agentType, "large_result", {
				toolName: msg.toolName,
				largeResultCount: 1,
				largeResultBytes: largeResult.bytes,
				largeResultLines: largeResult.lines,
			}),
		);
	}
	return rows;
}

const LF = 0x0a;

function parseSessionEntriesLenient(bytes: Uint8Array): { entries: SessionEntry[]; read: number } {
	const entries: SessionEntry[] = [];
	let cursor = 0;

	while (cursor < bytes.length) {
		const { values, error, read, done } = Bun.JSONL.parseChunk(bytes, cursor, bytes.length);
		if (values.length > 0) {
			entries.push(...(values as SessionEntry[]));
		}

		if (error) {
			const nextNewline = bytes.indexOf(LF, Math.max(read, cursor));
			if (nextNewline === -1) break;
			cursor = nextNewline + 1;
			continue;
		}

		if (read <= cursor) break;
		cursor = read;
		if (done) break;
	}

	return { entries, read: cursor };
}

function scanLastServiceTier(bytes: Uint8Array): ServiceTier | undefined {
	let cursor = 0;
	let currentServiceTier: ServiceTier | undefined;

	while (cursor < bytes.length) {
		const { values, error, read, done } = Bun.JSONL.parseChunk(bytes, cursor, bytes.length);
		for (const value of values as SessionEntry[]) {
			if (isServiceTierChange(value)) currentServiceTier = value.serviceTier ?? undefined;
		}

		if (error) {
			const nextNewline = bytes.indexOf(LF, Math.max(read, cursor));
			if (nextNewline === -1) break;
			cursor = nextNewline + 1;
			continue;
		}

		if (read <= cursor) break;
		cursor = read;
		if (done) break;
	}

	return currentServiceTier;
}

interface PrefixAssistantState {
	lastToolName: string | undefined;
	currentModel: string | undefined;
}

function scanPrefixAssistantState(bytes: Uint8Array): PrefixAssistantState {
	const state: PrefixAssistantState = { lastToolName: undefined, currentModel: undefined };
	let cursor = 0;

	while (cursor < bytes.length) {
		const { values, error, read, done } = Bun.JSONL.parseChunk(bytes, cursor, bytes.length);
		for (const value of values as SessionEntry[]) {
			if (isUserMessage(value)) {
				state.lastToolName = undefined;
			} else if (isModelChangeEntry(value)) {
				state.currentModel = value.model;
			} else if (isAssistantMessage(value)) {
				const message = value.message as AssistantMessage;
				const names = toolCallNames(message.content);
				state.lastToolName = names.at(-1);
				state.currentModel = assistantModelKey(message) ?? state.currentModel;
			}
		}

		if (error) {
			const nextNewline = bytes.indexOf(LF, Math.max(read, cursor));
			if (nextNewline === -1) break;
			cursor = nextNewline + 1;
			continue;
		}

		if (read <= cursor) break;
		cursor = read;
		if (done) break;
	}

	return state;
}

/**
 * Parse a session file and extract all assistant message stats.
 * Uses incremental reading with offset tracking.
 *
 * Service-tier carry-over: `currentServiceTier` is a session-scoped piece of
 * state derived from `service_tier_change` entries that affects whether
 * subsequent OpenAI assistant replies count as premium requests. Incremental
 * syncs that resume past the most-recent tier change would otherwise lose
 * that state and silently record `premiumRequests = 0` for priority traffic
 * (the coding-agent stopped folding the tier into `usage.premiumRequests`
 * after 13f59162e — the parser is now the sole source of truth). When
 * `fromOffset > 0` we therefore scan the bytes preceding `fromOffset`
 * for the latest service-tier value before parsing the unprocessed tail.
 * The scan only keeps the current tier and does not materialize prefix
 * entries, preserving offset-based memory behavior for large sessions.
 */
export interface ParseSessionResult {
	stats: MessageStats[];
	userStats: UserMessageStats[];
	userLinks: UserMessageLink[];
	healthStats: SessionHealthStats[];
	newOffset: number;
}
export async function parseSessionFile(sessionPath: string, fromOffset = 0): Promise<ParseSessionResult> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(sessionPath).bytes();
	} catch (err) {
		if (isEnoent(err)) return { stats: [], userStats: [], userLinks: [], healthStats: [], newOffset: fromOffset };
		throw err;
	}

	const folder = extractFolderFromPath(sessionPath);
	const agentType = classifyAgentType(sessionPath);
	const stats: MessageStats[] = [];
	const userStats: UserMessageStats[] = [];
	const userLinks: UserMessageLink[] = [];
	const healthStats: SessionHealthStats[] = [];
	const userByEntryId = new Map<string, UserMessageStats>();
	const start = Math.max(0, Math.min(fromOffset, bytes.length));
	const unprocessed = bytes.subarray(start);
	const { entries, read } = parseSessionEntriesLenient(unprocessed);
	let currentServiceTier: ServiceTier | undefined;
	const assistantLoopState: AssistantLoopState = { previousToolName: undefined };
	const modelSwitchState: ModelSwitchState = { currentModel: undefined };
	if (start > 0) {
		currentServiceTier = scanLastServiceTier(bytes.subarray(0, start));
		const prefixAssistantState = scanPrefixAssistantState(bytes.subarray(0, start));
		assistantLoopState.previousToolName = prefixAssistantState.lastToolName;
		modelSwitchState.currentModel = prefixAssistantState.currentModel;
	}
	for (const entry of entries) {
		if (isServiceTierChange(entry)) {
			currentServiceTier = entry.serviceTier ?? undefined;
			continue;
		}
		if (isModelChangeEntry(entry)) {
			const modelChangeHealth = extractModelChangeHealth(sessionPath, folder, entry, agentType, modelSwitchState);
			if (modelChangeHealth) healthStats.push(modelChangeHealth);
			continue;
		}
		if (isCompactionEntry(entry)) {
			healthStats.push(extractCompactionHealth(sessionPath, folder, entry, agentType));
			continue;
		}
		if (isSessionInitEntry(entry)) {
			const sessionInitHealth = extractSessionInitHealth(sessionPath, folder, entry, agentType);
			if (sessionInitHealth) healthStats.push(sessionInitHealth);
			continue;
		}
		if (isUserMessage(entry)) {
			const userMsg = extractUserStats(sessionPath, folder, entry);
			if (userMsg) {
				userStats.push(userMsg);
				userByEntryId.set(entry.id, userMsg);
			}
			assistantLoopState.previousToolName = undefined;
			continue;
		}
		if (isToolResultMessageEntry(entry)) {
			healthStats.push(...extractToolResultHealth(sessionPath, folder, entry, agentType));
			continue;
		}
		if (isAssistantMessage(entry)) {
			const msgStats = extractStats(sessionPath, folder, entry, currentServiceTier, agentType);
			if (msgStats) stats.push(msgStats);
			healthStats.push(...extractAssistantHealth(sessionPath, folder, entry, agentType, assistantLoopState));
			modelSwitchState.currentModel =
				assistantModelKey(entry.message as AssistantMessage) ?? modelSwitchState.currentModel;
			// Link assistant's responding model back to the user message it answered.
			const parentId = (entry as SessionMessageEntry).parentId;
			if (parentId) {
				const msg = entry.message as AssistantMessage;
				if (msg.model && msg.provider) {
					// Emit unconditionally. The aggregator's UPDATE is guarded by
					// `model IS NULL` so this is idempotent: a no-op for already
					// linked rows, a fix-up for fresh inserts (which start NULL
					// because the user row is recorded before its reply lands) and
					// for cross-pass orphans whose parent was committed by an
					// earlier incremental sync.
					userLinks.push({
						sessionFile: sessionPath,
						entryId: parentId,
						model: msg.model,
						provider: msg.provider,
					});
				}
			}
		}
	}

	return { stats, userStats, userLinks, healthStats, newOffset: start + read };
}

/**
 * List all session directories (folders).
 */
export async function listSessionFolders(): Promise<string[]> {
	try {
		const sessionsDir = getSessionsDir();
		const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => path.join(sessionsDir, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files in a folder.
 */
export async function listSessionFiles(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
		return entries
			.filter(e => e.isFile() && e.name.endsWith(".jsonl"))
			.map(e => path.join(e.parentPath, e.name))
			.sort();
	} catch {
		return [];
	}
}

/**
 * List all session files across all folders.
 */
export async function listAllSessionFiles(): Promise<string[]> {
	const folders = await listSessionFolders();
	const allFiles: string[] = [];

	for (const folder of folders) {
		const files = await listSessionFiles(folder);
		allFiles.push(...files);
	}

	return allFiles;
}

/**
 * Find a specific entry in a session file.
 */
export async function getSessionEntry(sessionPath: string, entryId: string): Promise<SessionEntry | null> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(sessionPath).bytes();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}

	const { entries } = parseSessionEntriesLenient(bytes);
	for (const entry of entries) {
		if ("id" in entry && entry.id === entryId) {
			return entry;
		}
	}
	return null;
}
