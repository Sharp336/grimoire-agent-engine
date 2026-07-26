import type { RecallResult } from "@oh-my-pi/pi-mnemopi";
import type {
	ContextMemoryAdapter,
	ContextMemoryEditInput,
	ContextMemoryEditOperation,
	ContextMemoryEditResult,
	ContextMemoryEmbeddingIdentity,
	ContextMemoryMaintenanceRecord,
	ContextMemoryPatchInput,
	ContextMemoryReadResult,
	ContextMemoryRecallResult,
	ContextMemoryRecord,
	ContextMemoryRememberInput,
	ContextMemoryScope,
} from "../context-manager/memory";
import { type MnemopiScopedMemory, type MnemopiSessionState, requireMnemopi } from "./state";

interface MnemopiContextRow {
	readonly id?: string;
	readonly content?: string;
	readonly source?: string | null;
	readonly importance?: number | null;
	readonly memory_type?: string | null;
	readonly memory_store?: string | null;
	readonly metadata?: unknown;
	readonly metadata_json?: unknown;
}

interface MnemopiMaintenanceRow {
	readonly id: string;
	readonly content: string;
	readonly source: string | null;
	readonly timestamp: string | null;
	readonly importance: number | null;
	readonly memory_type: string | null;
	readonly metadata_json: string | null;
	readonly recall_count: number | null;
	readonly last_recalled: string | null;
	readonly valid_until: string | null;
	readonly created_at: string | null;
}

function parseMetadata(value: string | null): Readonly<Record<string, unknown>> | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
}

function maintenanceScope(
	fallback: ContextMemoryScope,
	metadata: Readonly<Record<string, unknown>> | undefined,
): ContextMemoryScope {
	return metadata?.contextMemoryScope === "project" || metadata?.contextMemoryScope === "user"
		? metadata.contextMemoryScope
		: fallback;
}

function normalizedContent(content: string): string {
	return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function score(result: RecallResult): number {
	return result.score ?? result.importance ?? 0;
}

function toRecord(result: RecallResult, target: MnemopiScopedMemory, scope: ContextMemoryScope): ContextMemoryRecord {
	return {
		id: result.id,
		bank: target.bank,
		scope,
		content: result.content,
		source: result.source ?? undefined,
		timestamp: result.timestamp ?? undefined,
		score: score(result),
		importance: result.importance,
		recallCount: result.recall_count,
	};
}

export class MnemopiContextAdapter implements ContextMemoryAdapter {
	readonly available = true;
	readonly autoRecall: boolean;
	readonly projectBank: string;
	readonly userBank: string;
	readonly embeddingIdentity: ContextMemoryEmbeddingIdentity;
	readonly #state: MnemopiSessionState;
	readonly #project: MnemopiScopedMemory;
	readonly #user: MnemopiScopedMemory;
	#cachedRecall:
		| { readonly query: string; readonly limit: number; readonly result: ContextMemoryRecallResult }
		| undefined;

	constructor(state: MnemopiSessionState) {
		this.#state = state.aliasOf ?? state;
		const targets = this.#state.getContextMemoryTargets();
		this.#project = targets.project;
		this.#user = targets.user;
		this.projectBank = targets.project.bank;
		this.userBank = targets.user.bank;
		this.autoRecall = this.#state.config.autoRecall;
		const embedding = this.#state.config.providerOptions;
		this.embeddingIdentity = {
			enabled: embedding.noEmbeddings !== true,
			provider: embedding.embeddingApiUrl ? `api:${embedding.embeddingApiUrl}` : "local",
			model: embedding.embeddingModel ?? requireMnemopi().DEFAULT_MODEL,
		};
	}

	async recall(query: string, limit: number, signal?: AbortSignal): Promise<ContextMemoryRecallResult> {
		const normalizedQuery = query.trim();
		const safeLimit = Math.max(1, Math.floor(limit));
		if (this.#cachedRecall?.query === normalizedQuery && this.#cachedRecall.limit === safeLimit) {
			return this.#cachedRecall.result;
		}
		signal?.throwIfAborted();
		const sameBank = this.#project.bank === this.#user.bank;
		const [projectRecall, userRecall] = await Promise.allSettled([
			sameBank
				? Promise.resolve<RecallResult[]>([])
				: this.#project.memory.recallEnhanced(normalizedQuery, safeLimit, {
						includeFacts: true,
						channelId: this.#project.bank,
					}),
			this.#user.memory.recallEnhanced(normalizedQuery, safeLimit, {
				includeFacts: true,
				channelId: this.#user.bank,
			}),
		]);
		signal?.throwIfAborted();
		const projectResults = projectRecall.status === "fulfilled" ? projectRecall.value : [];
		const userResults = userRecall.status === "fulfilled" ? userRecall.value : [];
		const project = projectResults.map(result => toRecord(result, this.#project, "project"));
		const projectContent = new Set(project.map(record => normalizedContent(record.content)));
		const projectIds = new Set(project.map(record => record.id));
		const user = userResults
			.map(result => toRecord(result, this.#user, "user"))
			.filter(record => !projectIds.has(record.id) && !projectContent.has(normalizedContent(record.content)));
		const result = { query: normalizedQuery, project, user } satisfies ContextMemoryRecallResult;
		this.#cachedRecall = { query: normalizedQuery, limit: safeLimit, result };
		return result;
	}

	read(id: string): ContextMemoryReadResult | undefined {
		for (const { target, scope } of this.#targets()) {
			const row = target.memory.get(id) as MnemopiContextRow | null;
			if (!row) continue;
			const store = row.memory_store ?? "working";
			return {
				id: row.id ?? id,
				bank: target.bank,
				scope,
				content: row.content ?? "",
				source: row.source ?? undefined,
				importance: row.importance ?? undefined,
				memoryType: row.memory_type ?? undefined,
				metadata: row.metadata ?? row.metadata_json,
				editable: store !== "fact",
			};
		}
		return undefined;
	}

	async remember(scope: ContextMemoryScope, input: ContextMemoryRememberInput): Promise<string | undefined> {
		const target = scope === "user" ? this.#user : this.#project;
		const id = target.memory.remember(input.content, {
			scope: "bank",
			source: input.source,
			importance: input.importance,
			memoryType: input.memoryType,
			metadata: { ...input.metadata, contextMemoryScope: scope, bank: target.bank },
			extract: false,
		});
		this.#cachedRecall = undefined;
		return id;
	}

	edit(
		operation: ContextMemoryEditOperation,
		id: string,
		input: ContextMemoryEditInput = {},
	): ContextMemoryEditResult {
		for (const { target, scope } of this.#targets()) {
			const row = target.memory.get(id) as MnemopiContextRow | null;
			if (!row) continue;
			const store = row.memory_store ?? "working";
			if (store === "fact" || ((operation === "update" || operation === "forget") && store !== "working")) {
				return { status: "not_editable", id, bank: target.bank, scope };
			}
			let status: ContextMemoryEditResult["status"] = "not_found";
			if (operation === "update" && target.memory.update(id, input.content ?? null, input.importance ?? null)) {
				status = "updated";
			} else if (operation === "forget" && target.memory.forget(id)) {
				status = "deleted";
			} else if (operation === "invalidate" && target.memory.beam.invalidate(id, input.replacementId ?? null)) {
				status = "invalidated";
			}
			if (status !== "not_found") this.#cachedRecall = undefined;
			return { status, id, bank: target.bank, scope };
		}
		return { status: "not_found", id };
	}

	list(scope?: ContextMemoryScope): readonly ContextMemoryMaintenanceRecord[] {
		const records: ContextMemoryMaintenanceRecord[] = [];
		for (const { target, scope: fallbackScope } of this.#targets()) {
			const rows = target.memory.db
				.query<MnemopiMaintenanceRow, []>(`
SELECT id, content, source, timestamp, importance, memory_type, metadata_json,
	recall_count, last_recalled, valid_until, created_at
FROM working_memory
WHERE superseded_by IS NULL
	AND (valid_until IS NULL OR valid_until > datetime('now'))
ORDER BY created_at, id
`)
				.all();
			for (const row of rows) {
				const metadata = parseMetadata(row.metadata_json);
				const recordScope = maintenanceScope(fallbackScope, metadata);
				if (scope !== undefined && recordScope !== scope) continue;
				records.push({
					id: row.id,
					bank: target.bank,
					scope: recordScope,
					content: row.content,
					editable: true,
					recallCount: row.recall_count ?? 0,
					...(row.source !== null ? { source: row.source } : {}),
					...(row.importance !== null ? { importance: row.importance } : {}),
					...(row.memory_type !== null ? { memoryType: row.memory_type } : {}),
					...(metadata !== undefined ? { metadata } : {}),
					...(row.last_recalled !== null ? { lastRecalled: row.last_recalled } : {}),
					...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
					...(row.created_at !== null ? { createdAt: row.created_at } : {}),
				});
			}
		}
		return records;
	}

	patch(id: string, input: ContextMemoryPatchInput): ContextMemoryEditResult {
		for (const { target, scope: fallbackScope } of this.#targets()) {
			const existing = target.memory.get(id) as MnemopiContextRow | null;
			if (!existing) continue;
			const store = existing.memory_store ?? "working";
			const metadata =
				existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
					? (existing.metadata as Readonly<Record<string, unknown>>)
					: undefined;
			const scope = maintenanceScope(fallbackScope, metadata);
			if (store !== "working") return { status: "not_editable", id, bank: target.bank, scope };
			if (
				(input.content !== undefined || input.importance !== undefined) &&
				!target.memory.update(id, input.content ?? null, input.importance ?? null)
			) {
				return { status: "not_found", id, bank: target.bank, scope };
			}
			if (input.memoryType !== undefined || input.metadata !== undefined || input.source !== undefined) {
				const result = target.memory.db
					.prepare<never, [string | null, string | null, string | null, string]>(`
UPDATE working_memory
SET memory_type = COALESCE(?, memory_type),
	metadata_json = COALESCE(?, metadata_json),
	source = COALESCE(?, source)
WHERE id = ?
`)
					.run(
						input.memoryType ?? null,
						input.metadata === undefined ? null : JSON.stringify(input.metadata),
						input.source ?? null,
						id,
					);
				if (Number(result.changes) !== 1) return { status: "not_found", id, bank: target.bank, scope };
			}
			this.#cachedRecall = undefined;
			return { status: "updated", id, bank: target.bank, scope };
		}
		return { status: "not_found", id };
	}

	async merge(scope: ContextMemoryScope, ids: readonly string[]): Promise<string | undefined> {
		const uniqueIds = [...new Set(ids)];
		const rows = uniqueIds
			.map(id => this.read(id))
			.filter((row): row is ContextMemoryReadResult => row !== undefined);
		if (rows.length === 0) return undefined;
		const content = [...new Set(rows.map(row => row.content.trim()).filter(Boolean))].join("\n\n");
		if (!content) return undefined;
		const mergedId = await this.remember(scope, {
			content,
			source: "managed-context-merge",
			importance: Math.max(...rows.map(row => row.importance ?? 0.5)),
			metadata: { mergedMemoryIds: rows.map(row => row.id) },
		});
		if (!mergedId) return undefined;
		for (const row of rows) {
			if (row.id !== mergedId) this.edit("invalidate", row.id, { replacementId: mergedId });
		}
		return mergedId;
	}

	async embedBatch(texts: readonly string[]): Promise<readonly Float32Array[] | undefined> {
		const matrix = await requireMnemopi().embed(texts);
		return matrix ?? undefined;
	}

	cosineSimilarity(left: Float32Array, right: Float32Array): number {
		return requireMnemopi().cosineSimilarity(left, right);
	}

	#targets(): readonly { readonly target: MnemopiScopedMemory; readonly scope: ContextMemoryScope }[] {
		if (this.#project.bank === this.#user.bank) return [{ target: this.#user, scope: "user" }];
		return [
			{ target: this.#project, scope: "project" },
			{ target: this.#user, scope: "user" },
		];
	}
}
