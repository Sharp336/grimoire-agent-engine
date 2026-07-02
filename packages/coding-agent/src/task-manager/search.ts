/**
 * Search service for Task Manager.
 *
 * Replaces `fuse.js` with omp's `fuzzyRank` from `@oh-my-pi/pi-tui`.
 * Searches across tasks, documents, and decisions — returns results sorted
 * by fuzzy match score (lower score = better match).
 */

import { fuzzyRank } from "@oh-my-pi/pi-tui";
import { DEFAULT_SEARCH_LIMIT } from "./constants";
import type { Core } from "./core";
import type { SearchFilters, SearchOptions, SearchResult } from "./types";

interface SearchableItem {
	id: string;
	type: "task" | "decision" | "document";
	title: string;
	status: string;
	priority: string | null;
}

export class SearchService {
	#core: Core;

	constructor(core: Core) {
		this.#core = core;
	}

	async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
		const items = await this.#collectSearchableItems(options?.filters);
		const ranked = fuzzyRank(items, query, item => `${item.title} ${item.id} ${item.status}`);
		const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
		return ranked.slice(0, limit).map(({ item, score }) => ({
			id: item.id,
			type: item.type,
			title: item.title,
			status: item.status,
			score,
		}));
	}

	async #collectSearchableItems(filters?: SearchFilters): Promise<SearchableItem[]> {
		await this.#core.ensureConfigLoaded();
		const items: SearchableItem[] = [];

		// Tasks
		const taskIds = await this.#core.fs.listEntityFiles("tasks");
		for (const id of taskIds) {
			try {
				const task = await this.#core.loadTask(id);
				if (task.archived) continue;
				if (filters?.status && task.status !== filters.status) continue;
				if (filters?.priority && task.priority !== filters.priority) continue;
				items.push({
					id: task.id,
					type: "task",
					title: task.title,
					status: task.status,
					priority: task.priority,
				});
			} catch {
				// Skip unparseable files
			}
		}

		// Documents
		const docIds = await this.#core.fs.listEntityFiles("documents");
		for (const id of docIds) {
			try {
				const doc = await this.#core.loadDocument(id);
				items.push({
					id: doc.id,
					type: "document",
					title: doc.title,
					status: "n/a",
					priority: null,
				});
			} catch {
				// Skip unparseable files
			}
		}

		// Decisions
		const decisionIds = await this.#core.fs.listEntityFiles("decisions");
		for (const id of decisionIds) {
			try {
				const decision = await this.#core.loadDecision(id);
				items.push({
					id: decision.id,
					type: "decision",
					title: decision.title,
					status: decision.status,
					priority: null,
				});
			} catch {
				// Skip unparseable files
			}
		}

		return items;
	}
}
