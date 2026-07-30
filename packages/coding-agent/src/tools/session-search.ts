import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import sessionSearchDescription from "../prompts/tools/session-search.md" with { type: "text" };
import {
	SESSION_ARCHIVE_DEFAULT_LIMIT,
	SESSION_ARCHIVE_MAX_LIMIT,
	SESSION_ARCHIVE_MAX_OFFSET,
	type SessionArchiveScope,
	type SessionSearchRole,
	type SessionTranscriptSearchResult,
	searchArchivedSessionTranscripts,
} from "../session/session-archive";
import type { ToolSession } from ".";

const sessionSearchSchema = type({
	query: type("string > 0").describe("literal text to find in persisted session transcripts"),
	"scope?": type("'project' | 'all'").describe("current project or every project; default project"),
	"session?": type("string > 0").describe("exact or unique-prefix archived session ID"),
	"role?": type("'all' | 'user' | 'assistant' | 'tool' | 'summary'").describe("entry role; default all"),
	"case?": type("boolean").describe("case-sensitive matching; default false"),
	"limit?": type("number > 0").describe("matches per page; default 20, max 100"),
	"offset?": type("number >= 0").describe("matches to skip; default 0, max 10000"),
});

export type SessionSearchParams = typeof sessionSearchSchema.infer;

export interface SessionSearchDetails extends SessionTranscriptSearchResult {
	query: string;
	scope: SessionArchiveScope;
	role: SessionSearchRole;
	offset: number;
	limit: number;
}

function formatSearchResult(details: SessionSearchDetails): string {
	const lines = [
		"# Session Search",
		"",
		`Query: ${truncateToWidth(replaceTabs(details.query), 120)} · Scope: ${details.scope} · Role: ${details.role}`,
	];
	if (details.matches.length === 0) {
		lines.push("", "_No matching persisted transcript entries._");
	} else {
		let activeSessionId: string | undefined;
		for (const match of details.matches) {
			if (match.sessionId !== activeSessionId) {
				activeSessionId = match.sessionId;
				lines.push(
					"",
					`## history://session/${match.sessionId}`,
					`${truncateToWidth(replaceTabs(match.title), 100)} · ${truncateToWidth(replaceTabs(match.project), 40)} · modified ${match.modified}`,
				);
			}
			lines.push(
				`- **${match.role}** · ${match.timestamp} · entry \`${match.entryId}\``,
				`  > ${truncateToWidth(replaceTabs(match.snippet), 420)}`,
			);
		}
	}
	if (details.hasMore && details.nextOffset !== undefined) {
		lines.push("", `More matches available. Continue with \`offset: ${details.nextOffset}\`.`);
	}
	lines.push("", `Scanned ${details.scannedSessions} session${details.scannedSessions === 1 ? "" : "s"}.`);
	if (details.unreadableSessions > 0) {
		lines.push(
			`Skipped ${details.unreadableSessions} unreadable session${details.unreadableSessions === 1 ? "" : "s"}.`,
		);
	}
	return `${lines.join("\n")}\n`;
}

export class SessionSearchTool implements AgentTool<typeof sessionSearchSchema, SessionSearchDetails> {
	readonly name = "session_search";
	readonly approval = "read" as const;
	readonly label = "Session Search";
	readonly description = sessionSearchDescription;
	readonly parameters = sessionSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search persisted session transcript contents";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: SessionSearchParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SessionSearchDetails>> {
		const query = params.query.trim();
		const limit = params.limit ?? SESSION_ARCHIVE_DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_ARCHIVE_MAX_LIMIT) {
			throw new Error(`session_search limit must be an integer from 1 to ${SESSION_ARCHIVE_MAX_LIMIT}.`);
		}
		const offset = params.offset ?? 0;
		if (!Number.isInteger(offset) || offset < 0 || offset > SESSION_ARCHIVE_MAX_OFFSET) {
			throw new Error(`session_search offset must be an integer from 0 to ${SESSION_ARCHIVE_MAX_OFFSET}.`);
		}
		const scope = params.scope ?? "project";
		const role = params.role ?? "all";
		return untilAborted(signal, async () => {
			const result = await searchArchivedSessionTranscripts({
				query,
				cwd: this.session.cwd,
				scope,
				session: params.session,
				role,
				caseSensitive: params.case,
				limit,
				offset,
				signal,
			});
			const details: SessionSearchDetails = { ...result, query, scope, role, offset, limit };
			return { content: [{ type: "text", text: formatSearchResult(details) }], details };
		});
	}
}
