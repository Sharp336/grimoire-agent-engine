import * as path from "node:path";
import type { Client } from "@libsql/client";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { ToolSession } from "../tools";
import type { CodemapConfig } from "./config";
import { loadCodemapConfig } from "./config";
import { closeCodemapDb, openCodemapDb } from "./db";
import { getTaskContext } from "./retrieve";
import { checkStaleness, computeFileHash } from "./staleness";
import { deleteSummary, getSummary, upsertSummary } from "./store";

// --- Shared per-session DB client cache -------------------------------------

let cachedClient: Client | null = null;
let cachedConfig: CodemapConfig | null = null;
let clientPromise: Promise<{ client: Client; config: CodemapConfig }> | null = null;

/**
 * Resolve (or reuse) a codemap DB client for the session.
 *
 * The client is cached at module level keyed by `config.dbPath` + Turso
 * connection fields so that repeated tool calls don't reopen the libSQL
 * native binding each time. If connection-shaping fields changed (e.g.
 * settings edited mid-session), the previous client is closed before
 * opening the new one.
 *
 * Uses an in-flight promise guard to prevent concurrent callers from
 * double-opening: all concurrent calls await the same open promise.
 */
async function getClient(session: ToolSession): Promise<{ client: Client; config: CodemapConfig }> {
	const config = loadCodemapConfig(session.settings, getAgentDir());
	const cacheKey = `${config.dbPath}|${config.turso.syncUrl}|${config.turso.authToken}`;
	const cachedKey = cachedConfig
		? `${cachedConfig.dbPath}|${cachedConfig.turso.syncUrl}|${cachedConfig.turso.authToken}`
		: null;

	if (cachedClient && cacheKey === cachedKey) {
		return { client: cachedClient, config };
	}

	// If an open is already in flight, await it instead of starting a second
	if (clientPromise) {
		return clientPromise;
	}

	const promise = (async () => {
		if (cachedClient) {
			await closeCodemapDb(cachedClient);
			cachedClient = null;
			cachedConfig = null;
		}
		const client = await openCodemapDb(config);
		cachedClient = client;
		cachedConfig = config;
		return { client, config };
	})();
	clientPromise = promise;
	try {
		return await promise;
	} finally {
		clientPromise = null;
	}
}

/**
 * Resolve a project label from cwd. Mirrors hindsight's computeBankScope —
 * the cwd basename is a stable, human-readable scope key that groups
 * summaries across sessions for the same repo.
 */
function resolveProjectLabel(cwd: string): string {
	return path.basename(cwd);
}

/** Normalize a resolved path to forward-slash relative form for storage.
 * Rejects paths that escape the project cwd (path traversal). */
function toStoredPath(cwd: string, filePath: string): { relativePath: string; absolutePath: string } {
	const absolutePath = path.resolve(cwd, filePath);
	// Guard against path traversal: the resolved path must be inside cwd.
	const normalizedCwd = path.resolve(cwd);
	const rel = path.relative(normalizedCwd, absolutePath);
	const escapes = rel.startsWith("..") || path.isAbsolute(rel);
	if (escapes) {
		throw new Error(`Path "${filePath}" resolves outside the project directory.`);
	}
	const relativePath = rel.replace(/\\/g, "/");
	return { relativePath, absolutePath };
}

// --- Tool 1: set_file_summary -----------------------------------------------

const setFileSummarySchema = type({
	file: type("string").describe("File path (relative to cwd)"),
	summary: type("string").describe("1-3 sentences: purpose, key symbols, gotchas, invariants"),
	"symbol_name?": type("string").describe("Optional: specific symbol this summary is about"),
	"symbol_kind?": type("string").describe("Optional: function | class | method | etc."),
});
export type SetFileSummaryParams = typeof setFileSummarySchema.infer;

export class SetFileSummaryTool implements AgentTool<typeof setFileSummarySchema> {
	readonly name = "set_file_summary";
	readonly approval = "read" as const;
	readonly label = "Set File Summary";
	readonly description =
		"Persist a summary written by the agent after reading a file. Stores it for future task-relevant retrieval.";
	readonly parameters = setFileSummarySchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Store a code summary for a file";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SetFileSummaryTool | null {
		if (!session.settings.get("codemap.enabled")) return null;
		return new SetFileSummaryTool(session);
	}

	async execute(_id: string, params: SetFileSummaryParams): Promise<AgentToolResult> {
		// Validate path before opening DB — fail fast on traversal attempts.
		const { relativePath, absolutePath } = toStoredPath(this.session.cwd, params.file);
		const { client, config } = await getClient(this.session);
		const contentHash = await computeFileHash(absolutePath);
		const projectLabel = resolveProjectLabel(this.session.cwd);
		const row = await upsertSummary(client, {
			projectLabel,
			filePath: relativePath,
			summaryText: params.summary,
			contentHash,
			maxSummaryChars: config.maxSummaryChars,
			symbolName: params.symbol_name ?? null,
			symbolKind: params.symbol_kind ?? null,
		});
		const hashPreview = contentHash.slice(0, 8) || "none";
		return {
			content: [{ type: "text", text: `Summary stored for ${relativePath} (hash: ${hashPreview}).` }],
			details: { id: row.id, contentHash },
		};
	}
}

// --- Tool 2: get_file_summary -----------------------------------------------

const getFileSummarySchema = type({
	file: type("string").describe("File path (relative to cwd)"),
});
export type GetFileSummaryParams = typeof getFileSummarySchema.infer;

export class GetFileSummaryTool implements AgentTool<typeof getFileSummarySchema> {
	readonly name = "get_file_summary";
	readonly approval = "read" as const;
	readonly label = "Get File Summary";
	readonly description =
		"Retrieve the stored summary for a file, with a staleness check against the current file content hash.";
	readonly parameters = getFileSummarySchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Retrieve a stored code summary for a file";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GetFileSummaryTool | null {
		if (!session.settings.get("codemap.enabled")) return null;
		return new GetFileSummaryTool(session);
	}
	async execute(_id: string, params: GetFileSummaryParams): Promise<AgentToolResult> {
		// Validate path before opening DB — fail fast on traversal attempts.
		const { relativePath, absolutePath } = toStoredPath(this.session.cwd, params.file);
		const { client } = await getClient(this.session);
		const projectLabel = resolveProjectLabel(this.session.cwd);
		const row = await getSummary(client, projectLabel, relativePath);
		if (!row) {
			return {
				content: [{ type: "text", text: `No summary stored for ${relativePath}.` }],
				details: { found: false, relativePath },
			};
		}
		const staleness = await checkStaleness(absolutePath, row.contentHash);
		const lines: string[] = [`Summary for ${relativePath}:`, "", row.summaryText];
		if (staleness.missing) {
			lines.push("", "[STALE] File no longer exists on disk.");
		} else if (staleness.stale) {
			lines.push("", "[STALE] File has changed since this summary was written.");
		} else {
			lines.push("", "[FRESH] File matches the summary's content hash.");
		}
		if (row.symbolName) {
			lines.push("", `Symbol: ${row.symbolName}${row.symbolKind ? ` (${row.symbolKind})` : ""}`);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				found: true,
				id: row.id,
				stale: staleness.stale,
				missing: staleness.missing,
				updatedAt: row.updatedAt,
				symbolName: row.symbolName,
				symbolKind: row.symbolKind,
			},
		};
	}
}

// --- Tool 3: get_task_context -----------------------------------------------

const getTaskContextSchema = type({
	task: type("string").describe("The current task or goal in natural language"),
	"max_files?": type("number").describe("Optional: cap on number of files returned (default 12)"),
	"token_budget?": type("number").describe("Optional: token budget for packed summaries (default from config)"),
});
export type GetTaskContextParams = typeof getTaskContextSchema.infer;

export class GetTaskContextTool implements AgentTool<typeof getTaskContextSchema> {
	readonly name = "get_task_context";
	readonly approval = "read" as const;
	readonly label = "Get Task Context";
	readonly description =
		"Retrieve task-relevant file summaries via hybrid (lexical + vector) retrieval with reciprocal rank fusion and budget packing.";
	readonly parameters = getTaskContextSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Retrieve task-relevant code summaries";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GetTaskContextTool | null {
		if (!session.settings.get("codemap.enabled")) return null;
		return new GetTaskContextTool(session);
	}

	async execute(_id: string, params: GetTaskContextParams): Promise<AgentToolResult> {
		const { client, config } = await getClient(this.session);
		const projectLabel = resolveProjectLabel(this.session.cwd);
		const opts: { maxFiles?: number; tokenBudget?: number } = {};
		if (params.max_files !== undefined) opts.maxFiles = params.max_files;
		if (params.token_budget !== undefined) opts.tokenBudget = params.token_budget;
		const result = await getTaskContext(client, config, params.task, projectLabel, this.session.cwd, opts);
		const header = `Task context for: ${params.task}`;
		const body = JSON.stringify(result, null, 2);
		return {
			content: [{ type: "text", text: `${header}\n\n${body}` }],
			details: result,
		};
	}
}

// --- Tool 4: delete_file_summary --------------------------------------------

const deleteFileSummarySchema = type({
	file: type("string").describe("File path (relative to cwd)"),
});
export type DeleteFileSummaryParams = typeof deleteFileSummarySchema.infer;

export class DeleteFileSummaryTool implements AgentTool<typeof deleteFileSummarySchema> {
	readonly name = "delete_file_summary";
	readonly approval = "read" as const;
	readonly label = "Delete File Summary";
	readonly description =
		"Delete the stored summary for a file. Use when a file is removed or its summary is no longer relevant.";
	readonly parameters = deleteFileSummarySchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Delete a stored code summary for a file";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): DeleteFileSummaryTool | null {
		if (!session.settings.get("codemap.enabled")) return null;
		return new DeleteFileSummaryTool(session);
	}
	async execute(_id: string, params: DeleteFileSummaryParams): Promise<AgentToolResult> {
		// Validate path before opening DB — fail fast on traversal attempts.
		const { relativePath } = toStoredPath(this.session.cwd, params.file);
		const { client } = await getClient(this.session);
		const projectLabel = resolveProjectLabel(this.session.cwd);
		const removed = await deleteSummary(client, projectLabel, relativePath);
		if (!removed) {
			return {
				content: [{ type: "text", text: `No summary found for ${relativePath} — nothing to delete.` }],
				details: { removed: false, relativePath },
			};
		}
		return {
			content: [{ type: "text", text: `Summary deleted for ${relativePath}.` }],
			details: { removed: true, relativePath },
		};
	}
}
