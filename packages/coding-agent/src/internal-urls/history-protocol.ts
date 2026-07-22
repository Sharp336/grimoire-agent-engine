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
 * - history:// - Index of all registry + on-disk agents (id, status, kind, last activity)
 * - history://<agentId> - Concise markdown transcript of that agent
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentRef } from "../registry/agent-registry";
import { AgentRegistry } from "../registry/agent-registry";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import { resolveResumableSession } from "../session/session-listing";
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
export class HistoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "history";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const host = url.rawHost || url.hostname;
		const rawPathname = url.rawPathname || "";
		let agentId = "";
		if (rawPathname.startsWith("/")) {
			agentId = host ? `${host}${rawPathname}` : rawPathname;
		} else {
			agentId = host ? (rawPathname ? `${host}/${rawPathname}` : host) : rawPathname;
		}
		agentId = agentId.trim();
		const registry = AgentRegistry.global();
		// Advisor transcripts are observability-only — surfaced in the Agent Hub, never
		// in the agent-facing roster. Hide them from the index, lookup, and completions.
		const visible = registry.list().filter(ref => ref.kind !== "advisor");

		if (!agentId) {
			const content = await this.#renderIndex(visible);
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		if (!ref) {
			// Case-insensitive fallback: agent ids are human-typed (e.g. AuthLoader).
			const lower = agentId.toLowerCase();
			ref = visible.find(candidate => candidate.id.toLowerCase() === lower);
		}

		if (!ref) {
			// Registry miss — the agent may have been unregistered or lost on resume.
			// Serve its transcript straight from disk if the session file persists.
			const disk = await this.#resolveFromDisk(agentId, context);
			if (disk) return { ...disk, url: url.href };

			const known = visible.map(candidate => candidate.id);
			const knownStr = known.length > 0 ? known.join(", ") : "none";
			throw new Error(`Unknown agent: ${agentId}\nKnown agents: ${knownStr}\nList all with history://`);
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
			// No live session and no retained sessionFile — try the disk scan before
			// giving up, in case the transcript lingers under an artifacts dir.
			const disk = await this.#resolveFromDisk(ref.id, context);
			if (disk) return { ...disk, url: url.href };
			throw new Error(`Agent ${ref.id} has no transcript: session is gone and no session file was retained`);
		}

		const content = formatSessionHistoryMarkdown(messages, { title: `${ref.id} (${ref.status})` });
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: ref.sessionFile ?? undefined,
			notes,
		};
	}

	/**
	 * Load a transcript for `agentId` from an on-disk `.jsonl` session file.
	 * Matches exact, case-insensitive, prefix, resumable session lookup, or direct path.
	 * Returns `undefined` when no file is found.
	 */
	async #resolveFromDisk(agentId: string, context?: ResolveContext): Promise<InternalResource | undefined> {
		const files = await sessionFilesFromDisk();
		const lower = agentId.toLowerCase();
		let matchedId: string | undefined;
		let sessionFile: string | undefined;

		// 1. Exact or case-insensitive match in sessionFilesFromDisk()
		for (const [id, file] of files) {
			if (id === agentId || id.toLowerCase() === lower) {
				matchedId = id;
				sessionFile = file;
				if (id === agentId) break;
			}
		}

		// 2. Case-insensitive prefix match in sessionFilesFromDisk()
		if (!sessionFile) {
			for (const [id, file] of files) {
				if (id.toLowerCase().startsWith(lower)) {
					matchedId = id;
					sessionFile = file;
					break;
				}
			}
		}

		// 3. Fallback to resolveResumableSession
		if (!sessionFile) {
			const cwd = context?.cwd ?? process.cwd();
			const match = await resolveResumableSession(agentId, cwd, undefined, undefined, {
				allowGlobalFallback: true,
			});
			if (match) {
				matchedId = match.session.id;
				sessionFile = match.session.path;
			}
		}

		// 4. Direct file path check
		if (!sessionFile && (agentId.endsWith(".jsonl") || agentId.includes("/") || agentId.includes("\\"))) {
			const resolvedPath = path.resolve(context?.cwd ?? process.cwd(), agentId);
			try {
				const stat = await fs.stat(resolvedPath);
				if (stat.isFile()) {
					matchedId = path.basename(resolvedPath, ".jsonl");
					sessionFile = resolvedPath;
				}
			} catch {
				// Not a file
			}
		}

		if (!matchedId || !sessionFile) return undefined;
		const messages = await loadSessionMessagesReadOnly(sessionFile);
		const content = formatSessionHistoryMarkdown(messages, { title: `${matchedId} (on disk)` });
		return {
			url: "",
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: sessionFile,
			notes: ["Source: session file (read-only, unregistered)"],
		};
	}

	async #renderIndex(refs: AgentRef[]): Promise<string> {
		const entries: IndexEntry[] = refs.map(ref => ({
			id: ref.id,
			status: ref.status,
			kind: ref.kind,
			parent: ref.parentId ?? "—",
			lastActivity: formatAgo(ref.lastActivity),
		}));

		const registeredIds = new Set(refs.map(ref => ref.id));
		const registeredFiles = new Set(refs.map(ref => ref.sessionFile).filter((f): f is string => Boolean(f)));
		const disk = await sessionFilesFromDisk();

		// Deduplicate disk entries by session file path
		const fileToId = new Map<string, string>();
		for (const [id, file] of disk) {
			if (registeredFiles.has(file)) continue;
			const existing = fileToId.get(file);
			if (!existing || (id.length < existing.length && !id.includes("T"))) {
				fileToId.set(file, id);
			}
		}

		for (const [, id] of fileToId) {
			if (registeredIds.has(id)) continue;
			entries.push({ id, status: "on disk", kind: "—", parent: "—", lastActivity: "—" });
		}

		const lines: string[] = ["# Agents", ""];
		if (entries.length === 0) {
			lines.push("No agents registered.");
			return `${lines.join("\n")}\n`;
		}
		lines.push("| id | status | kind | parent | last activity |", "|---|---|---|---|---|");
		for (const entry of entries) {
			lines.push(`| ${entry.id} | ${entry.status} | ${entry.kind} | ${entry.parent} | ${entry.lastActivity} |`);
		}
		lines.push("", "Read a transcript with `read history://<id>`.");
		return `${lines.join("\n")}\n`;
	}

	async complete(): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		const seenIds = new Set<string>();
		const seenFiles = new Set<string>();

		for (const ref of AgentRegistry.global().list()) {
			if (ref.kind === "advisor") continue;
			seenIds.add(ref.id);
			if (ref.sessionFile) seenFiles.add(ref.sessionFile);
			completions.push({
				value: ref.id,
				description: `${ref.status} · ${ref.kind}${ref.parentId ? ` · parent ${ref.parentId}` : ""}`,
			});
		}

		const disk = await sessionFilesFromDisk();
		const fileToId = new Map<string, string>();
		for (const [id, file] of disk) {
			if (seenFiles.has(file)) continue;
			const existing = fileToId.get(file);
			if (!existing || (id.length < existing.length && !id.includes("T"))) {
				fileToId.set(file, id);
			}
		}

		for (const [, id] of fileToId) {
			if (seenIds.has(id)) continue;
			seenIds.add(id);
			completions.push({ value: id, description: "on disk" });
		}
		return completions;
	}
}
