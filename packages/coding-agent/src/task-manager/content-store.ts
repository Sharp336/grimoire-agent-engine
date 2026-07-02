/**
 * Content store — caches parsed task content to avoid re-reading files.
 *
 * Keyed by entity type + id. The cache is per-Core-instance and not shared
 * across processes — file locking handles cross-process safety.
 */

import type { Decision, Document, Milestone, Task } from "./types";

type EntityType = "tasks" | "decisions" | "documents" | "milestones";

type Entity<T extends EntityType> = T extends "tasks"
	? Task
	: T extends "decisions"
		? Decision
		: T extends "documents"
			? Document
			: Milestone;

export class ContentStore {
	#cache = new Map<string, unknown>();

	key(type: EntityType, id: string): string {
		return `${type}/${id}`;
	}

	get<T extends EntityType>(type: T, id: string): Entity<T> | undefined {
		return this.#cache.get(this.key(type, id)) as Entity<T> | undefined;
	}

	set<T extends EntityType>(type: T, id: string, entity: Entity<T>): void {
		this.#cache.set(this.key(type, id), entity);
	}

	delete(type: EntityType, id: string): void {
		this.#cache.delete(this.key(type, id));
	}

	clear(): void {
		this.#cache.clear();
	}
}
