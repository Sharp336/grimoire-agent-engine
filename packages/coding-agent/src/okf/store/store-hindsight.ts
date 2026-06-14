/**
 * Hindsight-backed OKF store — routes OKF concept storage and recall through a
 * Hindsight server (pg0-backed embedded Postgres).
 *
 * Maps each OKF concept to a Hindsight **document** in a dedicated OKF bank:
 *   - documentId = concept ID
 *   - tags = ["okf", ...conceptTags]
 *   - content = concept body (markdown)
 *   - metadata = frontmatter fields
 *
 * Recall uses Hindsight's `recall` endpoint with a tag filter for "okf",
 * so OKF concepts are isolated from episodic memories in the same bank.
 */

import type { HindsightApi } from "../../hindsight/client";
import type { OkfConceptSummary } from "../bundle";
import type { OkfListOptions, OkfSearchOptions, OkfSearchResult, OkfStore } from "./types";

/** Tag applied to every OKF concept in Hindsight, for isolation and recall filtering. */
const OKF_TAG = "okf";

/** Hindsight implementation of {@link OkfStore}. */
export class HindsightOkfStore implements OkfStore {
	readonly #api: HindsightApi;
	readonly #bankId: string;
	#banksEnsured = false;

	constructor(api: HindsightApi, bankId: string) {
		this.#api = api;
		this.#bankId = bankId;
	}

	async #ensureBank(): Promise<void> {
		if (this.#banksEnsured) return;
		try {
			await this.#api.createBank(this.#bankId, {
				retainMission: "OKF concept documents — curated project knowledge in markdown.",
			});
		} catch {
			// Bank may already exist; createBank is idempotent.
		}
		this.#banksEnsured = true;
	}

	async upsert(summary: OkfConceptSummary, body: string): Promise<void> {
		await this.#ensureBank();
		await this.#api.retain(this.#bankId, body, {
			documentId: summary.id,
			tags: [OKF_TAG, ...summary.tags],
			metadata: {
				type: summary.type,
				title: summary.title ?? "",
				description: summary.description,
				okf_id: summary.id,
			},
			updateMode: "replace",
		});
	}

	async get(id: string): Promise<OkfConceptSummary | undefined> {
		await this.#ensureBank();
		const doc = await this.#api.getDocument(this.#bankId, id);
		if (!doc) return undefined;
		return documentToSummary(doc, id);
	}

	async delete(id: string): Promise<void> {
		await this.#ensureBank();
		await this.#api.deleteDocument(this.#bankId, id);
	}

	async list(options: OkfListOptions = {}): Promise<OkfConceptSummary[]> {
		await this.#ensureBank();
		const limit = Math.min(options.limit ?? 1000, 10000);
		const response = await this.#api.listDocuments(this.#bankId, { limit });
		const docs = (response as { items?: unknown[] }).items ?? [];
		return docs
			.map((doc, i) => documentToSummary(doc as Record<string, unknown>, `doc-${i}`))
			.filter((s): s is OkfConceptSummary => s !== undefined)
			.filter(s => {
				if (options.type && s.type !== options.type) return false;
				if (options.tag && !s.tags.includes(options.tag)) return false;
				return true;
			});
	}

	async search(query: string, options: OkfSearchOptions = {}): Promise<OkfSearchResult[]> {
		await this.#ensureBank();
		const limit = Math.min(options.limit ?? 10, 100);
		if (!query.trim()) return [];

		try {
			const response = await this.#api.recall(this.#bankId, query, {
				tags: [OKF_TAG],
				tagsMatch: "all",
				maxTokens: limit * 500,
				budget: "mid",
			});
			const results = (response as { results?: unknown[] }).results ?? [];
			return results.slice(0, limit).map((r, i) => {
				const item = r as Record<string, unknown>;
				const id = String(item.document_id ?? item.id ?? `result-${i}`);
				return {
					id,
					type: String((item.metadata as Record<string, unknown>)?.type ?? "Reference"),
					title: (item.metadata as Record<string, unknown>)?.title as string | undefined,
					description: String((item.metadata as Record<string, unknown>)?.description ?? ""),
					tags: [],
					score: i,
				};
			});
		} catch {
			return [];
		}
	}

	async count(): Promise<number> {
		await this.#ensureBank();
		const response = await this.#api.listDocuments(this.#bankId, { limit: 1 });
		const total = (response as { total?: number }).total;
		return typeof total === "number" ? total : 0;
	}

	async close(): Promise<void> {
		// Hindsight API is stateless (fetch-based); nothing to close.
	}
}

/** Coerce a Hindsight document response into an OkfConceptSummary. */
function documentToSummary(doc: Record<string, unknown>, fallbackId: string): OkfConceptSummary | undefined {
	const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
	const id = String(metadata.okf_id ?? doc.id ?? fallbackId);
	const tagsValue = metadata.tags ?? doc.tags;
	const tags = Array.isArray(tagsValue) ? tagsValue.filter((t): t is string => typeof t === "string") : [];
	return {
		id,
		type: String(metadata.type ?? "Reference"),
		title: typeof metadata.title === "string" && metadata.title ? metadata.title : undefined,
		description: String(metadata.description ?? ""),
		tags,
		filePath: "",
		mtime: 0,
	};
}
