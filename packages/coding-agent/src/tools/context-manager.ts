import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { truncate } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type {
	ContextExpandResult,
	ContextMemoryAdapter,
	ContextMemoryEditResult,
	ContextMemoryReadResult,
	ContextMemoryScope,
	ContextNoteResult,
	ContextReduceResult,
	ContextSearchResult,
	SessionContextManager,
} from "../context-manager";
import ctxExpandDescription from "../prompts/tools/ctx-expand.md" with { type: "text" };
import ctxMemoryDescription from "../prompts/tools/ctx-memory.md" with { type: "text" };
import ctxNoteDescription from "../prompts/tools/ctx-note.md" with { type: "text" };
import ctxReduceDescription from "../prompts/tools/ctx-reduce.md" with { type: "text" };
import ctxSearchDescription from "../prompts/tools/ctx-search.md" with { type: "text" };
import type { ToolSession } from ".";

const ctxReduceSchema = type({
	tags: type("string[]").describe("stable transcript tags such as §12§"),
	"reason?": type("string").describe("why this history can leave the live context"),
});

export type CtxReduceParams = typeof ctxReduceSchema.infer;

const ctxExpandSchema = type({
	tags: type("string[]").describe("stable transcript tags such as §12§"),
	"max_chars?": type("number").describe("maximum characters returned in the canonical preview"),
});

export type CtxExpandParams = typeof ctxExpandSchema.infer;

const ctxSearchSchema = type({
	query: type("string").describe("natural-language or keyword search query"),
	"sources?": type("('memory' | 'session_fact' | 'compartment' | 'note' | 'git_commit')[]").describe(
		"sources to search",
	),
	"limit?": type("number").describe("maximum number of results"),
});

export type CtxSearchParams = typeof ctxSearchSchema.infer;

const ctxMemorySchema = type({
	action: type("'write' | 'read' | 'update' | 'archive' | 'forget' | 'merge'").describe("memory operation"),
	"category?": type("'project' | 'preference' | 'instruction' | 'personality' | 'relationship'").describe(
		"project or user-profile memory category",
	),
	"ids?": type("string[]").describe("memory IDs returned by read or search"),
	"content?": type("string").describe("memory content for write or update"),
	"reason?": type("string").describe("why the memory operation is needed"),
});

export type CtxMemoryParams = typeof ctxMemorySchema.infer;

const ctxNoteSchema = type({
	action: type("'write' | 'read' | 'filter' | 'update' | 'dismiss'").describe("note operation"),
	"id?": type("string").describe("note ID returned by a previous note or search result"),
	"category?": type("string").describe("note category"),
	"content?": type("string").describe("note content"),
	"surface_condition?": type("string").describe("condition under which the note should be surfaced"),
	"scope?": type("'project' | 'session'").describe("note lifetime scope"),
	"status?": type("'pending' | 'active' | 'dismissed'").describe("note status filter or replacement"),
});

export type CtxNoteParams = typeof ctxNoteSchema.infer;

interface CtxExpandDetails {
	readonly status: ContextExpandResult["status"];
	readonly requestedTags: readonly number[];
	readonly foundTags: readonly number[];
	readonly missingTags: readonly number[];
	readonly artifactId?: string;
	readonly cancelledDrops: number;
	readonly truncated: boolean;
}

interface CtxMemoryDetails {
	readonly action: CtxMemoryParams["action"];
	readonly ids: readonly string[];
	readonly records?: readonly ContextMemoryReadResult[];
	readonly missingIds?: readonly string[];
	readonly edits?: readonly ContextMemoryEditResult[];
	readonly createdId?: string;
}

function activeManager(session: ToolSession): SessionContextManager | undefined {
	const manager = session.getContextManager?.();
	return manager?.active ? manager : undefined;
}

function requireManager(session: ToolSession): SessionContextManager {
	const manager = activeManager(session);
	if (!manager) throw new Error("Managed context is not available for this session.");
	return manager;
}

function parseTag(value: string): number {
	const match = /^(?:§)?([1-9]\d*)(?:§)?$/.exec(value.trim());
	const tag = match?.[1] === undefined ? Number.NaN : Number(match[1]);
	if (!Number.isSafeInteger(tag))
		throw new Error(`Invalid context tag ${JSON.stringify(value)}. Use a tag such as §12§.`);
	return tag;
}

function parseTags(values: readonly string[]): number[] {
	if (values.length === 0) throw new Error("At least one context tag is required.");
	return [...new Set(values.map(parseTag))];
}

function formatTags(tags: readonly number[]): string {
	return tags.length === 0 ? "none" : tags.map(tag => `§${tag}§`).join(", ");
}

function requireIds(ids: readonly string[] | undefined, action: string, minimum = 1): string[] {
	const normalized = [...new Set((ids ?? []).map(id => id.trim()).filter(Boolean))];
	if (normalized.length < minimum) {
		throw new Error(`ctx_memory ${action} requires at least ${minimum} memory ID${minimum === 1 ? "" : "s"}.`);
	}
	return normalized;
}

function memoryScope(category: CtxMemoryParams["category"]): ContextMemoryScope | undefined {
	if (category === "project") return "project";
	if (category !== undefined) return "user";
	return undefined;
}

function requireMemoryAdapter(session: ToolSession): ContextMemoryAdapter {
	const adapter = requireManager(session).getMemoryAdapter();
	if (!adapter?.available) throw new Error("The Mnemopi context-memory adapter is not available for this session.");
	return adapter;
}

function jsonResult<T>(value: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

export class CtxReduceTool implements AgentTool<typeof ctxReduceSchema, ContextReduceResult> {
	readonly name = "ctx_reduce";
	readonly approval = "read" as const;
	readonly label = "Context Reduce";
	readonly description = ctxReduceDescription;
	readonly parameters = ctxReduceSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly summary = "Queue protocol-safe managed-context reduction by stable tag";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CtxReduceTool | null {
		return activeManager(session) ? new CtxReduceTool(session) : null;
	}

	async execute(_id: string, params: CtxReduceParams): Promise<AgentToolResult<ContextReduceResult>> {
		const result = await requireManager(this.session).reduceTags(
			parseTags(params.tags),
			params.reason?.trim() || undefined,
		);
		const rejected = result.rejected.map(item => `§${item.tagOrdinal}§ (${item.reasons.join(", ")})`);
		return {
			content: [
				{
					type: "text",
					text: [
						`Status: ${result.status}`,
						`Requested tags: ${formatTags(result.requestedTags)}`,
						`Expanded protocol-safe tags: ${formatTags(result.expandedTags)}`,
						...(result.eligibleAt === undefined
							? []
							: [`Eligible at: ${new Date(result.eligibleAt).toISOString()}`]),
						...(rejected.length === 0 ? [] : [`Rejected: ${rejected.join("; ")}`]),
					].join("\n"),
				},
			],
			details: result,
		};
	}
}

export class CtxExpandTool implements AgentTool<typeof ctxExpandSchema, CtxExpandDetails> {
	readonly name = "ctx_expand";
	readonly approval = "read" as const;
	readonly label = "Context Expand";
	readonly description = ctxExpandDescription;
	readonly parameters = ctxExpandSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Read canonical history for managed-context tags";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CtxExpandTool | null {
		return activeManager(session) ? new CtxExpandTool(session) : null;
	}

	async execute(_id: string, params: CtxExpandParams): Promise<AgentToolResult<CtxExpandDetails>> {
		const result = await requireManager(this.session).expandTags(parseTags(params.tags));
		const maxChars =
			params.max_chars === undefined ? undefined : Math.max(1, Math.min(200_000, Math.floor(params.max_chars)));
		const content = maxChars === undefined ? result.content : truncate(result.content, maxChars, "\n… [truncated]");
		const details: CtxExpandDetails = {
			status: result.status,
			requestedTags: result.requestedTags,
			foundTags: result.foundTags,
			missingTags: result.missingTags,
			cancelledDrops: result.cancelledDrops,
			truncated: content !== result.content,
			...(result.artifactId !== undefined ? { artifactId: result.artifactId } : {}),
		};
		const metadata = [
			`Status: ${result.status}`,
			`Found: ${formatTags(result.foundTags)}`,
			...(result.missingTags.length === 0 ? [] : [`Missing: ${formatTags(result.missingTags)}`]),
			...(result.artifactId === undefined ? [] : [`Full artifact: artifact://${result.artifactId}`]),
		].join("\n");
		return {
			content: [{ type: "text", text: `${metadata}\n\n${content}` }],
			details,
		};
	}
}

export class CtxSearchTool implements AgentTool<typeof ctxSearchSchema, ContextSearchResult> {
	readonly name = "ctx_search";
	readonly approval = "read" as const;
	readonly label = "Context Search";
	readonly description = ctxSearchDescription;
	readonly parameters = ctxSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search managed history, notes, Git, facts, and memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CtxSearchTool | null {
		return activeManager(session) ? new CtxSearchTool(session) : null;
	}

	async execute(
		_id: string,
		params: CtxSearchParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ContextSearchResult>> {
		const query = params.query.trim();
		if (!query) throw new Error("ctx_search requires a non-empty query.");
		const result = await requireManager(this.session).searchContext(query, {
			...(params.sources === undefined ? {} : { sources: params.sources }),
			...(params.limit === undefined ? {} : { limit: Math.max(1, Math.min(100, Math.floor(params.limit))) }),
			...(signal === undefined ? {} : { signal }),
		});
		return jsonResult(result);
	}
}

export class CtxMemoryTool implements AgentTool<typeof ctxMemorySchema, CtxMemoryDetails> {
	readonly name = "ctx_memory";
	readonly approval = "read" as const;
	readonly label = "Context Memory";
	readonly description = ctxMemoryDescription;
	readonly parameters = ctxMemorySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage canonical Mnemopi project and user memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CtxMemoryTool | null {
		if (session.settings.get("memory.backend") !== "mnemopi" || !activeManager(session)) return null;
		return new CtxMemoryTool(session);
	}

	async execute(_id: string, params: CtxMemoryParams): Promise<AgentToolResult<CtxMemoryDetails>> {
		const adapter = requireMemoryAdapter(this.session);
		if (params.action === "write") {
			const content = params.content?.trim();
			const scope = memoryScope(params.category);
			if (!content || !scope || !params.category) {
				throw new Error("ctx_memory write requires category and non-empty content.");
			}
			const createdId = await adapter.remember(scope, {
				content,
				source: params.reason?.trim() || "ctx_memory",
				memoryType: params.category,
				...(params.reason?.trim() ? { metadata: { reason: params.reason.trim() } } : {}),
			});
			if (!createdId) throw new Error("Mnemopi did not persist the requested memory.");
			return jsonResult({ action: params.action, ids: [createdId], createdId });
		}

		const ids = requireIds(params.ids, params.action, params.action === "merge" ? 2 : 1);
		if (params.action === "read") {
			const records: ContextMemoryReadResult[] = [];
			const missingIds: string[] = [];
			for (const id of ids) {
				const record = adapter.read(id);
				if (record) records.push(record);
				else missingIds.push(id);
			}
			return jsonResult({ action: params.action, ids, records, missingIds });
		}

		if (params.action === "update") {
			if (ids.length !== 1 || !params.content?.trim()) {
				throw new Error("ctx_memory update requires exactly one ID and non-empty content.");
			}
			const edits = [adapter.edit("update", ids[0]!, { content: params.content.trim() })];
			return jsonResult({ action: params.action, ids, edits });
		}

		if (params.action === "archive" || params.action === "forget") {
			const operation = params.action === "archive" ? "invalidate" : "forget";
			const edits = ids.map(id => adapter.edit(operation, id));
			return jsonResult({ action: params.action, ids, edits });
		}

		const explicitScope = memoryScope(params.category);
		const records = ids.map(id => adapter.read(id));
		const inferredScope = records.find(record => record !== undefined)?.scope;
		const scope = explicitScope ?? inferredScope;
		if (!scope || records.some(record => record !== undefined && record.scope !== scope)) {
			throw new Error("ctx_memory merge requires IDs from one memory scope or an explicit matching category.");
		}
		const createdId = await adapter.merge(scope, ids);
		if (!createdId) throw new Error("Mnemopi could not merge the requested memories.");
		return jsonResult({ action: params.action, ids, createdId });
	}
}

export class CtxNoteTool implements AgentTool<typeof ctxNoteSchema, ContextNoteResult> {
	readonly name = "ctx_note";
	readonly approval = "read" as const;
	readonly label = "Context Note";
	readonly description = ctxNoteDescription;
	readonly parameters = ctxNoteSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Manage searchable project and session context notes";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CtxNoteTool | null {
		return activeManager(session) ? new CtxNoteTool(session) : null;
	}

	async execute(_id: string, params: CtxNoteParams): Promise<AgentToolResult<ContextNoteResult>> {
		if (params.action === "write" && (!params.category?.trim() || !params.content?.trim())) {
			throw new Error("ctx_note write requires category and non-empty content.");
		}
		if ((params.action === "update" || params.action === "dismiss") && !params.id?.trim()) {
			throw new Error(`ctx_note ${params.action} requires id.`);
		}
		const result = await requireManager(this.session).manageNote({
			action: params.action,
			...(params.id?.trim() ? { id: params.id.trim() } : {}),
			...(params.category !== undefined ? { category: params.category.trim() } : {}),
			...(params.content !== undefined ? { content: params.content.trim() } : {}),
			...(params.surface_condition !== undefined ? { surfaceCondition: params.surface_condition } : {}),
			...(params.scope === undefined ? {} : { scope: params.scope }),
			...(params.status === undefined ? {} : { status: params.status }),
		});
		return jsonResult(result);
	}
}
