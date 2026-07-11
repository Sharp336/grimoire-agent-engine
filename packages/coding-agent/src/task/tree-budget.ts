export interface TaskTreeBudgetLimits {
	maxSpawns?: number;
	maxRequests?: number;
	maxTokens?: number;
}

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

/** Session-wide safety budget shared by every descendant spawned through `task`. */
export class TaskTreeBudget {
	readonly #maxSpawns: number;
	readonly #maxRequests: number;
	readonly #maxTokens: number;
	readonly #controller = new AbortController();
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
		return reason;
	}
}

function normalizeLimit(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : 0;
}
