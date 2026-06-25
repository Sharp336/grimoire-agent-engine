import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { z } from "zod/v4";
import type { ToolSession } from "../../tools";
import { CURSOR_WEB_SEARCH_TOOL_NAME } from "./composer-surface";
import { executeSearch } from "./execute-query";
import type { SearchRenderDetails } from "./render";

/** Cursor Composer wire schema (`search_term` + optional rationale). */
export const cursorWebSearchSchema = z.object({
	search_term: z.string().describe("The search term to look up on the web"),
	explanation: z
		.string()
		.describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal.")
		.optional(),
});

export type CursorWebSearchParams = z.infer<typeof cursorWebSearchSchema>;

/**
 * Cursor-style web search alias for Composer-family models.
 *
 * Delegates to the shared `web_search` provider chain; only the wire name and
 * parameter shape differ from the built-in `web_search` tool.
 */
export class CursorWebSearchTool implements AgentTool<typeof cursorWebSearchSchema, SearchRenderDetails> {
	readonly name = CURSOR_WEB_SEARCH_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "Web Search";
	readonly hidden = true;
	readonly description =
		"Search the web for real-time information about any topic. Use when you need up-to-date facts, documentation, release notes, benchmarks, or news that may be outside your training data.";
	readonly parameters = cursorWebSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: CursorWebSearchParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		const authStorage =
			this.#session.authStorage ?? (await import("../../sdk").then(module => module.discoverAuthStorage()));
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(
			_toolCallId,
			{ query: params.search_term },
			{ authStorage, sessionId, signal },
		);
	}
}