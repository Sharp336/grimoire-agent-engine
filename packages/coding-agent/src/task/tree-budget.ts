import { logger } from "@oh-my-pi/pi-utils";

interface TaskTreeAbortTarget {
	readonly isDisposed: boolean;
	abort(): Promise<void>;
}

/** Optional aggregate limits applied across one root session's task descendants. */
export interface TaskTreeBudgetLimits {
	maxSpawns?: number;
	maxRequests?: number;
	maxTokens?: number;
}

/** Current task-tree consumption and the first aggregate limit that was exceeded. */
export interface TaskTreeBudgetSnapshot {
	spawns: number;
	requests: number;
	tokens: number;
	maxSpawns: number;
	maxRequests: number;
	maxTokens: number;
	exhausted: boolean;
	reason?: string;
}

/** Session-wide safety budget shared by task and eval-agent descendants. */
export class TaskTreeBudget {
	readonly #maxSpawns: number;
	readonly #maxRequests: number;
	readonly #maxTokens: number;
	readonly #controller = new AbortController();
	readonly #abortTargets = new Set<WeakRef<TaskTreeAbortTarget>>();
	#spawns = 0;
	#requests = 0;
	#tokens = 0;
	#reason?: string;

	constructor(limits: TaskTreeBudgetLimits = {}) {
		this.#maxSpawns = normalizeLimit(limits.maxSpawns);
		this.#maxRequests = normalizeLimit(limits.maxRequests);
		this.#maxTokens = normalizeLimit(limits.maxTokens);
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** Register a keep-alive descendant for aggregate budget abort propagation. */
	registerAbortTarget(target: TaskTreeAbortTarget): void {
		for (const ref of this.#abortTargets) {
			const existing = ref.deref();
			if (!existing || existing.isDisposed) {
				this.#abortTargets.delete(ref);
			} else if (existing === target) {
				return;
			}
		}
		if (this.#reason) {
			this.#abortTarget(target);
		} else {
			this.#abortTargets.add(new WeakRef(target));
		}
	}

	reserveSpawns(count: number): string | undefined {
		if (this.#reason) return this.#reason;
		const next = this.#spawns + Math.max(0, Math.trunc(count));
		if (this.#maxSpawns > 0 && next > this.#maxSpawns) {
			return `Task tree spawn budget exceeded (${next} requested; budget ${this.#maxSpawns})`;
		}
		this.#spawns = next;
		return undefined;
	}

	releaseSpawns(count: number): void {
		this.#spawns = Math.max(0, this.#spawns - Math.max(0, Math.trunc(count)));
	}

	recordRequest(tokens: number): string | undefined {
		if (this.#reason) return this.#reason;
		this.#requests += 1;
		this.#tokens += Math.max(0, Math.trunc(tokens));
		if (this.#maxRequests > 0 && this.#requests > this.#maxRequests) {
			return this.#exhaust(
				`Task tree request budget exceeded (${this.#requests} requests; budget ${this.#maxRequests})`,
			);
		}
		if (this.#maxTokens > 0 && this.#tokens > this.#maxTokens) {
			return this.#exhaust(`Task tree token budget exceeded (${this.#tokens} tokens; budget ${this.#maxTokens})`);
		}
		return undefined;
	}

	snapshot(): TaskTreeBudgetSnapshot {
		return {
			spawns: this.#spawns,
			requests: this.#requests,
			tokens: this.#tokens,
			maxSpawns: this.#maxSpawns,
			maxRequests: this.#maxRequests,
			maxTokens: this.#maxTokens,
			exhausted: this.#reason !== undefined,
			reason: this.#reason,
		};
	}

	#exhaust(reason: string): string {
		this.#reason = reason;
		this.#controller.abort(new Error(reason));
		for (const ref of this.#abortTargets) {
			const target = ref.deref();
			if (target && !target.isDisposed) this.#abortTarget(target);
		}
		this.#abortTargets.clear();
		return reason;
	}

	#abortTarget(target: TaskTreeAbortTarget): void {
		void target.abort().catch(error => {
			logger.debug("Task-tree keep-alive abort failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
}

function normalizeLimit(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : 0;
}
