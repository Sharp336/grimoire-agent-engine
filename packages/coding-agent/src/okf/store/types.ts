/**
 * OKF store interface — a derived recall index over the on-disk bundle.
 *
 * The bundle filesystem (`bundle.ts`) is always the source of truth. The store
 * is a cache that accelerates search/recall. Two implementations:
 *   - `store-sqlite.ts` — local SQLite FTS5 (fallback, no server needed)
 *   - `store-hindsight.ts` — Hindsight server documents (pg0-backed)
 *
 * The store is NOT responsible for writing concept files; it mirrors what's
 * on disk. Call `reindex()` to resynchronise after out-of-band edits.
 */

import type { OkfConceptSummary } from "../bundle";

/** A single search/recall result. */
export interface OkfSearchResult {
	id: string;
	type: string;
	title?: string;
	description: string;
	tags: string[];
	/** Relevance score (lower = more relevant for FTS5 bm25). */
	score: number;
}

/** Options for listing concepts from the store. */
export interface OkfListOptions {
	type?: string;
	tag?: string;
	limit?: number;
}

/** Options for searching concepts. */
export interface OkfSearchOptions {
	limit?: number;
}

/**
 * Derived recall index over an OKF bundle.
 *
 * Implementations MUST be safe for concurrent reads. Write operations
 * (`upsert`, `delete`, `reindex`) are serialised by the caller.
 */
export interface OkfStore {
	/** Store or update a concept in the index. */
	upsert(summary: OkfConceptSummary, body: string): Promise<void>;

	/** Get a single concept's indexed data by id (or `undefined`). */
	get(id: string): Promise<OkfConceptSummary | undefined>;

	/** Remove a concept from the index. */
	delete(id: string): Promise<void>;

	/** List concepts, optionally filtered by type or tag. */
	list(options?: OkfListOptions): Promise<OkfConceptSummary[]>;

	/** Full-text search over concept content. */
	search(query: string, options?: OkfSearchOptions): Promise<OkfSearchResult[]>;

	/** Count concepts in the index. */
	count(): Promise<number>;

	/** Close the store and release resources. */
	close(): Promise<void>;
}
