import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import { listAllSessions, type SessionInfo } from "./session-listing";

export const SESSION_ARCHIVE_DEFAULT_LIMIT = 20;
export const SESSION_ARCHIVE_MAX_LIMIT = 100;
export const SESSION_ARCHIVE_MAX_OFFSET = 10_000;

export type SessionArchiveScope = "project" | "all";
export type SessionSearchRole = "all" | "user" | "assistant" | "tool" | "summary";

export interface SessionArchiveOptions {
	cwd: string;
	scope?: SessionArchiveScope;
	query?: string;
}

export interface SessionTranscriptSearchOptions extends SessionArchiveOptions {
	query: string;
	session?: string;
	role?: SessionSearchRole;
	caseSensitive?: boolean;
	limit?: number;
	offset?: number;
	signal?: AbortSignal;
}

export interface SessionTranscriptMatch {
	sessionId: string;
	title: string;
	project: string;
	modified: string;
	entryId: string;
	timestamp: string;
	role: Exclude<SessionSearchRole, "all"> | "other";
	snippet: string;
}

export interface SessionTranscriptSearchResult {
	matches: SessionTranscriptMatch[];
	hasMore: boolean;
	nextOffset?: number;
	scannedSessions: number;
	unreadableSessions: number;
}

function sameProject(sessionCwd: string, cwd: string): boolean {
	if (!sessionCwd) return false;
	return path.resolve(sessionCwd) === path.resolve(cwd);
}

/** Read-only top-level session discovery, deduplicated by physical transcript path. */
export async function listArchivedSessions(options: SessionArchiveOptions): Promise<SessionInfo[]> {
	const scope = options.scope ?? "project";
	const queryTokens = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	const seenPaths = new Set<string>();
	const sessions: SessionInfo[] = [];
	for (const session of await listAllSessions()) {
		const canonicalPath = path.resolve(session.path);
		if (seenPaths.has(canonicalPath)) continue;
		seenPaths.add(canonicalPath);
		if (scope === "project" && !sameProject(session.cwd, options.cwd)) continue;
		if (queryTokens.length > 0) {
			const metadata = [session.id, session.title ?? "", session.cwd, session.firstMessage].join("\n").toLowerCase();
			if (!queryTokens.every(token => metadata.includes(token))) continue;
		}
		sessions.push(session);
	}
	return sessions;
}

export function sessionProjectLabel(session: Pick<SessionInfo, "cwd">): string {
	if (!session.cwd) return "unknown";
	return path.basename(session.cwd) || session.cwd;
}

function candidateDescription(session: SessionInfo): string {
	return `${session.id} (${sessionProjectLabel(session)}, ${session.modified.toISOString()})`;
}

/** Resolve an exact or unique-prefix header session ID from a bounded session set. */
export function resolveArchivedSessionSelector(sessions: readonly SessionInfo[], rawSelector: string): SessionInfo {
	const selector = rawSelector.trim();
	if (!selector) {
		throw new Error("Archived session ID must not be empty.");
	}
	if (
		selector.endsWith(".jsonl") ||
		selector.includes("/") ||
		selector.includes("\\") ||
		selector.startsWith(".") ||
		selector.startsWith("~")
	) {
		throw new Error(
			"Direct transcript paths are not supported. Use history://session/<session-id> or session_search with a session ID.",
		);
	}

	const lower = selector.toLowerCase();
	const exact = sessions.filter(session => session.id.toLowerCase() === lower);
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) {
		throw new Error(
			`Ambiguous archived session ID '${selector}'. Matching transcripts:\n${exact
				.slice(0, 8)
				.map(candidateDescription)
				.join("\n")}`,
		);
	}

	const prefixes = sessions.filter(session => session.id.toLowerCase().startsWith(lower));
	if (prefixes.length === 1) return prefixes[0];
	if (prefixes.length > 1) {
		throw new Error(
			`Ambiguous archived session prefix '${selector}'. Use a longer prefix or full ID:\n${prefixes
				.slice(0, 8)
				.map(candidateDescription)
				.join("\n")}`,
		);
	}

	const suggestions = sessions.filter(session => session.id.toLowerCase().includes(lower)).slice(0, 5);
	const suffix =
		suggestions.length > 0
			? `\nPossible matches:\n${suggestions.map(candidateDescription).join("\n")}`
			: `\nSearch metadata with history://session?scope=all&q=${encodeURIComponent(selector)} or transcript content with session_search.`;
	throw new Error(`Unknown archived session: ${selector}${suffix}`);
}

function normalizeSearchRole(role: unknown): SessionTranscriptMatch["role"] {
	switch (role) {
		case "user":
		case "bashExecution":
		case "pythonExecution":
		case "fileMention":
			return "user";
		case "assistant":
			return "assistant";
		case "toolResult":
			return "tool";
		default:
			return "other";
	}
}

function* contentStrings(content: unknown): Generator<string> {
	if (typeof content === "string") {
		yield content;
		return;
	}
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (typeof record.text === "string") {
			yield record.text;
			continue;
		}
		if (record.type === "toolCall") {
			if (typeof record.name === "string") yield record.name;
			if (record.arguments !== undefined) {
				try {
					yield JSON.stringify(record.arguments);
				} catch {
					// Ignore non-serializable tool arguments in malformed legacy entries.
				}
			}
		}
	}
}

function* messageStrings(message: Record<string, unknown>): Generator<string> {
	yield* contentStrings(message.content);
	for (const key of ["command", "output", "code"] as const) {
		const value = message[key];
		if (typeof value === "string") yield value;
	}
	if (message.role === "fileMention" && Array.isArray(message.files)) {
		for (const file of message.files) {
			if (!file || typeof file !== "object") continue;
			const record = file as Record<string, unknown>;
			if (typeof record.path === "string") yield record.path;
			if (typeof record.content === "string") yield record.content;
		}
	}
	if ((message.role === "custom" || message.role === "hookMessage") && message.display !== false) {
		yield* contentStrings(message.content);
	}
}

function entrySearchSurface(entry: unknown): {
	entryId: string;
	timestamp: string;
	role: SessionTranscriptMatch["role"];
	strings: Iterable<string>;
} | null {
	if (!entry || typeof entry !== "object") return null;
	const record = entry as Record<string, unknown>;
	const entryId = typeof record.id === "string" ? record.id : "unknown";
	const timestamp = typeof record.timestamp === "string" ? record.timestamp : "unknown";
	if (record.type === "message" && record.message && typeof record.message === "object") {
		const message = record.message as Record<string, unknown>;
		return { entryId, timestamp, role: normalizeSearchRole(message.role), strings: messageStrings(message) };
	}
	if (record.type === "custom_message" && record.display !== false) {
		return { entryId, timestamp, role: "other", strings: contentStrings(record.content) };
	}
	if (record.type === "compaction" || record.type === "branch_summary") {
		const summary = typeof record.summary === "string" ? [record.summary] : [];
		return { entryId, timestamp, role: "summary", strings: summary };
	}
	return null;
}

function makeSnippet(text: string, index: number, queryLength: number): string {
	const context = 180;
	const start = Math.max(0, index - context);
	const end = Math.min(text.length, index + queryLength + context);
	const body = text.slice(start, end).replaceAll("\t", " ").replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function matchEntry(
	entry: unknown,
	pattern: RegExp,
	queryLength: number,
	role: SessionSearchRole,
): Omit<SessionTranscriptMatch, "sessionId" | "title" | "project" | "modified"> | null {
	const surface = entrySearchSurface(entry);
	if (!surface || (role !== "all" && surface.role !== role)) return null;
	for (const text of surface.strings) {
		pattern.lastIndex = 0;
		const match = pattern.exec(text);
		if (!match) continue;
		return {
			entryId: surface.entryId,
			timestamp: surface.timestamp,
			role: surface.role,
			snippet: makeSnippet(text, match.index, queryLength),
		};
	}
	return null;
}

async function searchSessionFile(
	session: SessionInfo,
	pattern: RegExp,
	queryLength: number,
	role: SessionSearchRole,
	capacity: number,
	signal?: AbortSignal,
): Promise<{ matches: SessionTranscriptMatch[]; overflow: boolean }> {
	const matches: SessionTranscriptMatch[] = [];
	let writeIndex = 0;
	let overflow = false;
	for await (const line of readLines(Bun.file(session.path).stream(), signal)) {
		const parsed = Bun.JSONL.parseChunk(line);
		for (const entry of parsed.values) {
			const match = matchEntry(entry, pattern, queryLength, role);
			if (!match) continue;
			const candidate: SessionTranscriptMatch = {
				...match,
				sessionId: session.id,
				title: session.title ?? session.firstMessage,
				project: sessionProjectLabel(session),
				modified: session.modified.toISOString(),
			};
			if (matches.length < capacity) {
				matches.push(candidate);
			} else {
				matches[writeIndex] = candidate;
				writeIndex = (writeIndex + 1) % capacity;
				overflow = true;
			}
		}
	}
	const chronological = overflow ? [...matches.slice(writeIndex), ...matches.slice(0, writeIndex)] : matches;
	chronological.reverse();
	return { matches: chronological, overflow };
}

/** Search persisted transcript entries, including content hidden behind compaction boundaries. */
export async function searchArchivedSessionTranscripts(
	options: SessionTranscriptSearchOptions,
): Promise<SessionTranscriptSearchResult> {
	const query = options.query.trim();
	if (!query) throw new Error("Session search query must not be empty.");
	if (query.length > 500) throw new Error("Session search query must not exceed 500 characters.");
	const limit = Math.min(
		Math.max(1, Math.floor(options.limit ?? SESSION_ARCHIVE_DEFAULT_LIMIT)),
		SESSION_ARCHIVE_MAX_LIMIT,
	);
	const offset = Math.min(Math.max(0, Math.floor(options.offset ?? 0)), SESSION_ARCHIVE_MAX_OFFSET);
	const capacity = offset + limit + 1;
	const role = options.role ?? "all";
	let sessions = await listArchivedSessions({ cwd: options.cwd, scope: options.scope });
	if (options.session) sessions = [resolveArchivedSessionSelector(sessions, options.session)];

	const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.caseSensitive ? "u" : "iu");
	const ordered: SessionTranscriptMatch[] = [];
	let hasMore = false;
	let scannedSessions = 0;
	let unreadableSessions = 0;

	for (let index = 0; index < sessions.length; index++) {
		const session = sessions[index];
		try {
			const result = await searchSessionFile(session, pattern, query.length, role, capacity, options.signal);
			scannedSessions++;
			for (const match of result.matches) {
				if (ordered.length < capacity) ordered.push(match);
				else hasMore = true;
			}
			if (result.overflow) hasMore = true;
		} catch (error) {
			if (options.signal?.aborted) throw error;
			unreadableSessions++;
		}
		if (ordered.length >= capacity) {
			hasMore = true;
			break;
		}
	}

	const matches = ordered.slice(offset, offset + limit);
	if (ordered.length > offset + limit) hasMore = true;
	return {
		matches,
		hasMore,
		nextOffset: hasMore ? offset + matches.length : undefined,
		scannedSessions,
		unreadableSessions,
	};
}
