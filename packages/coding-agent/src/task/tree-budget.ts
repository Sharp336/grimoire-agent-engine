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
	#maxSpawns: number;
	#maxRequests: number;
	#maxTokens: number;
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

	/** Apply configured task settings to the shared budget before a new descendant starts. */
	updateLimits(limits: TaskTreeBudgetLimits): void {
		if (limits.maxSpawns !== undefined) this.#maxSpawns = normalizeLimit(limits.maxSpawns);
		if (limits.maxRequests !== undefined) this.#maxRequests = normalizeLimit(limits.maxRequests);
		if (limits.maxTokens !== undefined) this.#maxTokens = normalizeLimit(limits.maxTokens);
		if (this.#reason) return;
		const reason = this.#usageExhaustReason();
		if (reason) this.#exhaust(reason);
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
		const reason = this.#usageExhaustReason();
		return reason ? this.#exhaust(reason) : undefined;
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

	/** First request/token limit currently exceeded, or undefined while within budget. */
	#usageExhaustReason(): string | undefined {
		if (this.#maxRequests > 0 && this.#requests > this.#maxRequests) {
			return `Task tree request budget exceeded (${this.#requests} requests; budget ${this.#maxRequests})`;
		}
		if (this.#maxTokens > 0 && this.#tokens > this.#maxTokens) {
			return `Task tree token budget exceeded (${this.#tokens} tokens; budget ${this.#maxTokens})`;
		}
		return undefined;
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
