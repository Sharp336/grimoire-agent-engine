/**
 * Protocol handler for history:// URLs.
 *
 * Exposes agent transcripts as concise markdown. Live refs render from the
 * in-memory message array; parked refs (session disposed, sessionFile
 * retained) load read-only from the JSONL session file — no writer, no lock.
 *
 * Agents that are no longer in the `AgentRegistry` — one-shot helpers
 * unregistered after `finalizeSubagentLifecycle` (`keepAlive: false`, e.g. the
 * `eval` `agent()` bridge), agents released via the Agent Hub / vibe kill, or
 * any agent after a session resume — remain reachable: `resolve`, `complete`,
 * and the index all fall back to scanning artifacts dirs for `<id>.jsonl`,
 * mirroring how `agent://` reads `.md` outputs straight off disk.
 *
 * URL forms:
 * - history:// - Index of registered and persisted agents
 * - history://<agentId> - Legacy agent transcript lookup
 * - history://agent/<agentId> - Explicit agent transcript lookup
 * - history://session - Bounded current-project archived session index
 * - history://session/<sessionId> - Archived top-level session by exact ID or unique prefix
 */
import type { AgentRef } from "../registry/agent-registry";
import { AgentRegistry } from "../registry/agent-registry";
import {
	listArchivedSessions,
	resolveArchivedSessionSelector,
	SESSION_ARCHIVE_DEFAULT_LIMIT,
	SESSION_ARCHIVE_MAX_LIMIT,
	SESSION_ARCHIVE_MAX_OFFSET,
	type SessionArchiveScope,
	sessionProjectLabel,
} from "../session/session-archive";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import type { SessionInfo } from "../session/session-listing";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import { sessionFilesFromDisk } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/** Humanize a last-activity timestamp as `Ns/Nm/Nh/Nd ago`. */
function formatAgo(timestamp: number): string {
	const diffMs = Math.max(0, Date.now() - timestamp);
	const secs = Math.floor(diffMs / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** One row of the history index — either a registered ref or a disk-only transcript. */
interface IndexEntry {
	id: string;
	status: string;
	kind: string;
	parent: string;
	lastActivity: string;
}

/**
 * Handler for history:// URLs.
 *
 * Resolves agent ids against the global AgentRegistry, then falls back to
 * on-disk `.jsonl` transcripts, serving read-only history for live, parked,
 * and unregistered agents alike.
 */
type HistoryRoute =
	| { kind: "agent-index" }
	| { kind: "agent"; id: string }
	| { kind: "session-index" }
	| { kind: "session"; id: string };

function decodeSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new Error(`Invalid history:// identifier encoding: ${value}`);
	}
}

function parseHistoryRoute(url: InternalUrl): HistoryRoute {
	const host = (url.rawHost || url.hostname).trim();
	const pathname = (url.rawPathname ?? url.pathname).replace(/^\/+/, "").trim();
	if (!host) {
		if (!pathname) return { kind: "agent-index" };
		throw new Error(
			"Direct transcript paths are not supported. Use history://session/<session-id> or session_search.",
		);
	}

	const namespace = host.toLowerCase();
	if (namespace === "agent") {
		if (!pathname) return { kind: "agent-index" };
		if (pathname.includes("/")) throw new Error("history://agent accepts one agent ID.");
		return { kind: "agent", id: decodeSegment(pathname) };
	}
	if (namespace === "session") {
		if (!pathname) return { kind: "session-index" };
		if (pathname.includes("/")) {
			throw new Error("history://session accepts one session ID, not a filesystem path.");
		}
		return { kind: "session", id: decodeSegment(pathname) };
	}
	if (pathname) {
		throw new Error(
			"Direct transcript paths are not supported. Use history://session/<session-id> or history://agent/<agent-id>.",
		);
	}
	return { kind: "agent", id: decodeSegment(host) };
}

function parseListInteger(
	url: InternalUrl,
	name: "limit" | "offset",
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = url.searchParams.get(name);
	if (raw === null) return fallback;
	if (!/^\d+$/.test(raw)) {
		throw new Error(`Invalid history://session ${name} '${raw}'. Expected an integer ${minimum}–${maximum}.`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`Invalid history://session ${name} '${raw}'. Expected an integer ${minimum}–${maximum}.`);
	}
	return value;
}

function sanitizeTableCell(value: string, width: number): string {
	const normalized = value.replaceAll("\t", " ").replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
	return Bun.wrapAnsi(normalized, width, { hard: true, trim: true }).split("\n", 1)[0] ?? "";
}

/**
 * Handler for history:// URLs.
 *
 * Agent transcripts retain the legacy bare-id surface. Archived top-level
 * sessions live under an explicit namespace so agent/session collisions have
 * deterministic semantics and archive enumeration stays bounded.
 */
export class HistoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "history";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const route = parseHistoryRoute(url);
		const registry = AgentRegistry.global();
		const visible = registry.list().filter(ref => ref.kind !== "advisor");

		switch (route.kind) {
			case "agent-index":
				return this.#resource(url.href, await this.#renderAgentIndex(visible));
			case "agent":
				return await this.#resolveAgent(url.href, route.id, visible);
			case "session-index":
				return await this.#resolveSessionIndex(url, context);
			case "session":
				return await this.#resolveSession(url.href, route.id, context);
		}
	}

	async #resolveAgent(url: string, agentId: string, visible: AgentRef[]): Promise<InternalResource> {
		const registry = AgentRegistry.global();
		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		if (!ref) {
			const lower = agentId.toLowerCase();
			ref = visible.find(candidate => candidate.id.toLowerCase() === lower);
		}

		if (!ref) {
			const disk = await this.#resolveAgentFromDisk(agentId);
			if (disk) return { ...disk, url };
			const known = visible.map(candidate => candidate.id);
			throw new Error(
				`Unknown agent: ${agentId}\nKnown agents: ${known.length > 0 ? known.join(", ") : "none"}\nList agents with history://`,
			);
		}

		const notes: string[] = [];
		let messages: unknown[];
		if (ref.session) {
			messages = ref.session.messages;
			notes.push("Source: live session");
		} else if (ref.sessionFile) {
			messages = await loadSessionMessagesReadOnly(ref.sessionFile);
			notes.push(`Source: session file (read-only, ${ref.status})`);
		} else {
			const disk = await this.#resolveAgentFromDisk(ref.id);
			if (disk) return { ...disk, url };
			throw new Error(`Agent ${ref.id} has no transcript: session is gone and no session file was retained`);
		}

		const content = formatSessionHistoryMarkdown(messages, { title: `${ref.id} (${ref.status})` });
		return {
			url,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: ref.sessionFile ?? undefined,
			notes,
		};
	}

	async #resolveAgentFromDisk(agentId: string): Promise<InternalResource | undefined> {
		const lower = agentId.toLowerCase();
		for (const [id, sessionFile] of await sessionFilesFromDisk()) {
			if (id !== agentId && id.toLowerCase() !== lower) continue;
			const messages = await loadSessionMessagesReadOnly(sessionFile);
			const content = formatSessionHistoryMarkdown(messages, { title: `${id} (on disk)` });
			return {
				url: "",
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
				sourcePath: sessionFile,
				notes: ["Source: session file (read-only, unregistered)"],
			};
		}
		return undefined;
	}

	async #resolveSession(url: string, sessionId: string, context?: ResolveContext): Promise<InternalResource> {
		const sessions = await listArchivedSessions({ cwd: context?.cwd ?? process.cwd(), scope: "all" });
		const session = resolveArchivedSessionSelector(sessions, sessionId);
		const messages = await loadSessionMessagesReadOnly(session.path);
		const content = formatSessionHistoryMarkdown(messages, { title: `${session.id} (archived session)` });
		return {
			url,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: session.path,
			notes: ["Source: archived top-level session file (read-only)"],
		};
	}

	async #resolveSessionIndex(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const allowedParams: Record<string, true> = { scope: true, q: true, limit: true, offset: true };
		for (const key of url.searchParams.keys()) {
			if (!(key in allowedParams)) {
				throw new Error(`Unknown history://session parameter '${key}'. Use scope, q, limit, or offset.`);
			}
		}
		const scopeRaw = url.searchParams.get("scope") ?? "project";
		if (scopeRaw !== "project" && scopeRaw !== "all") {
			throw new Error(`Invalid history://session scope '${scopeRaw}'. Expected project or all.`);
		}
		const scope: SessionArchiveScope = scopeRaw;
		const query = url.searchParams.get("q")?.trim() ?? "";
		if (query.length > 200) throw new Error("history://session q must not exceed 200 characters.");
		const limit = parseListInteger(url, "limit", SESSION_ARCHIVE_DEFAULT_LIMIT, 1, SESSION_ARCHIVE_MAX_LIMIT);
		const offset = parseListInteger(url, "offset", 0, 0, SESSION_ARCHIVE_MAX_OFFSET);
		const sessions = await listArchivedSessions({
			cwd: context?.cwd ?? process.cwd(),
			scope,
			query,
		});
		const page = sessions.slice(offset, offset + limit);
		return this.#resource(url.href, this.#renderSessionIndex(page, sessions.length, { scope, query, limit, offset }));
	}

	#resource(url: string, content: string): InternalResource {
		return {
			url,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #renderAgentIndex(refs: AgentRef[]): Promise<string> {
		const entries: IndexEntry[] = refs.map(ref => ({
			id: ref.id,
			status: ref.status,
			kind: ref.kind,
			parent: ref.parentId ?? "—",
			lastActivity: formatAgo(ref.lastActivity),
		}));
		const registered = new Set(refs.map(ref => ref.id));
		for (const id of (await sessionFilesFromDisk()).keys()) {
			if (registered.has(id)) continue;
			entries.push({ id, status: "on disk", kind: "—", parent: "—", lastActivity: "—" });
		}

		const lines = ["# Agents", ""];
		if (entries.length === 0) {
			lines.push("No agents registered.");
		} else {
			lines.push("| id | status | kind | parent | last activity |", "|---|---|---|---|---|");
			for (const entry of entries) {
				lines.push(`| ${entry.id} | ${entry.status} | ${entry.kind} | ${entry.parent} | ${entry.lastActivity} |`);
			}
		}
		lines.push(
			"",
			"Read an agent with `history://agent/<id>` (legacy `history://<id>` also works).",
			"List archived top-level sessions with `history://session`.",
		);
		return `${lines.join("\n")}\n`;
	}

	#renderSessionIndex(
		sessions: readonly SessionInfo[],
		total: number,
		options: { scope: SessionArchiveScope; query: string; limit: number; offset: number },
	): string {
		const start = total === 0 ? 0 : options.offset + 1;
		const end = Math.min(total, options.offset + sessions.length);
		const lines = [
			"# Archived Sessions",
			"",
			`Scope: ${options.scope} · Showing ${start}–${end} of ${total}${options.query ? ` · Filter: ${sanitizeTableCell(options.query, 80)}` : ""}`,
			"",
		];
		if (sessions.length === 0) {
			lines.push("_No matching sessions._");
		} else {
			lines.push("| session | modified | project | status | title |", "|---|---|---|---|---|");
			for (const session of sessions) {
				lines.push(
					`| [${session.id}](history://session/${session.id}) | ${session.modified.toISOString()} | ${sanitizeTableCell(sessionProjectLabel(session), 40)} | ${session.status ?? "unknown"} | ${sanitizeTableCell(session.title ?? session.firstMessage, 100)} |`,
				);
			}
		}

		const nextOffset = options.offset + sessions.length;
		if (nextOffset < total) {
			const params = new URLSearchParams({
				scope: options.scope,
				limit: String(options.limit),
				offset: String(nextOffset),
			});
			if (options.query) params.set("q", options.query);
			lines.push("", `Next page: \`history://session?${params.toString()}\``);
		}
		lines.push(
			"",
			"Read one with `history://session/<full-id-or-unique-prefix>`.",
			"Search transcript contents with `session_search`.",
		);
		return `${lines.join("\n")}\n`;
	}

	async complete(query = ""): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [
			{ value: "agent/", description: "explicit agent transcript namespace" },
			{ value: "session/", description: "archived top-level session namespace" },
		];
		const seen = new Set<string>(["agent/", "session/"]);
		for (const ref of AgentRegistry.global().list()) {
			if (ref.kind === "advisor") continue;
			const value = ref.id === "agent" || ref.id === "session" ? `agent/${ref.id}` : ref.id;
			if (seen.has(value)) continue;
			seen.add(value);
			completions.push({
				value,
				description: `${ref.status} · ${ref.kind}${ref.parentId ? ` · parent ${ref.parentId}` : ""}`,
			});
		}
		if (!query.startsWith("session/")) {
			for (const id of (await sessionFilesFromDisk()).keys()) {
				const value = id === "agent" || id === "session" ? `agent/${id}` : id;
				if (seen.has(value)) continue;
				seen.add(value);
				completions.push({ value, description: "on disk agent" });
			}
		}
		return completions;
	}
}
