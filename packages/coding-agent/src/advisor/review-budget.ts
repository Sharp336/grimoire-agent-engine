import type { AgentPreModelCallStop, AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";

/**
 * Per-review spend guard for one advisor.
 *
 * A "review" is one `agent.prompt(batch)` cycle: the advisor reads a transcript
 * delta, investigates with its tools, and (optionally) calls `advise`. That
 * cycle is an ordinary agent loop with no upper bound — the loop continues
 * while the model keeps emitting tool calls — so a single review can issue an
 * unbounded number of provider requests, each one re-sending the advisor's
 * whole append-only context. Observed worst case: 95 requests for one review.
 *
 * Two independent limiters, both scoped to the current review:
 *
 * - **Request cap** — a counter this class owns, so it is exact. Enforced from
 *   `beforeModelCall`, which ends the loop *before* the request is prepared;
 *   the loop records a zero-usage `stopReason: "aborted"` message, so nothing
 *   is billed and the advisor's failure ladder sees a normal completed turn.
 * - **Cost ceiling** — compares the summed cost of requests that have already
 *   **completed** in this review, fed by {@link recordCompletedCost} from the
 *   advisor's live `message_end` subscription. It is exact for completed work
 *   and lags by at most the in-flight request: the ceiling refuses to dispatch
 *   the *next* request, it cannot cut off the current one. It is a backstop for
 *   very large contexts, not a dollar-precise cutoff.
 *
 * Separately, {@link guardTool} short-circuits a tool call whose `(name, args)`
 * pair already ran in this review. A degenerate reviewer can otherwise spend
 * dozens of requests re-reading the same range and re-globbing the same
 * pattern, and every repeated result stays in the append-only context and
 * inflates every later request in the session.
 *
 * Each limit is disabled by a non-positive value.
 */
export interface AdvisorReviewBudgetLimits {
	/** Max provider requests per review; `0` disables the cap. */
	maxRequests: number;
	/** Max USD of completed requests per review; `0` disables the ceiling. */
	maxCostUsd: number;
	/** Occurrence at which an identical `(tool, args)` call is refused; `0` disables the guard. */
	maxIdenticalToolCalls: number;
}

export interface AdvisorReviewBudgetStop {
	kind: "requests" | "cost";
	reason: string;
}

/** Stable key for a tool call: object key order must not create a new identity. */
function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export class AdvisorReviewBudget {
	readonly #resolveLimits: () => AdvisorReviewBudgetLimits;
	readonly #onStop: ((stop: AdvisorReviewBudgetStop) => void) | undefined;
	#reviewId: number | undefined;
	#requests = 0;
	#costUsd = 0;
	#toolCalls = new Map<string, number>();
	#stop: AdvisorReviewBudgetStop | undefined;

	constructor(
		limits: AdvisorReviewBudgetLimits | (() => AdvisorReviewBudgetLimits),
		onStop?: (stop: AdvisorReviewBudgetStop) => void,
	) {
		this.#resolveLimits = typeof limits === "function" ? limits : () => limits;
		this.#onStop = onStop;
	}

	/**
	 * Reset counters for a new logical review. Retrying the same review id keeps
	 * the original budget, so provider recovery cannot multiply the cap.
	 */
	beginReview(reviewId?: number): void {
		if (reviewId !== undefined && reviewId === this.#reviewId) return;
		this.#reviewId = reviewId;
		this.#requests = 0;
		this.#costUsd = 0;
		this.#toolCalls.clear();
		this.#stop = undefined;
	}

	/** Fold one finished advisor request's cost into the current review. */
	recordCompletedCost(usd: number): void {
		if (Number.isFinite(usd) && usd > 0) this.#costUsd += usd;
	}

	/** Why the current review was cut short, or `undefined` if it ran free. */
	get stop(): AdvisorReviewBudgetStop | undefined {
		return this.#stop;
	}

	/** Requests dispatched so far in the current review. */
	get requests(): number {
		return this.#requests;
	}

	/** Cost of requests that have completed in the current review. */
	get costUsd(): number {
		return this.#costUsd;
	}

	/**
	 * Pre-model-call gate. Returns a stop verdict to refuse the next provider
	 * request, or `undefined` to let it through (counting it).
	 */
	beforeModelCall(): AgentPreModelCallStop | undefined {
		const { maxRequests, maxCostUsd } = this.#resolveLimits();
		if (maxRequests > 0 && this.#requests >= maxRequests) {
			return this.#halt("requests", `advisor review reached ${maxRequests} provider requests`);
		}
		if (maxCostUsd > 0 && this.#costUsd >= maxCostUsd) {
			return this.#halt(
				"cost",
				`advisor review spent $${this.#costUsd.toFixed(2)} of its $${maxCostUsd.toFixed(2)} ceiling`,
			);
		}
		this.#requests++;
		return undefined;
	}

	/**
	 * Record one tool call and return a refusal message when this exact
	 * `(name, args)` pair has already run in this review, or `undefined` to let
	 * it execute.
	 */
	noteToolCall(name: string, args: unknown): string | undefined {
		const max = this.#resolveLimits().maxIdenticalToolCalls;
		if (max <= 0) return undefined;
		const key = `${name}\u001f${canonicalize(args)}`;
		const seen = (this.#toolCalls.get(key) ?? 0) + 1;
		this.#toolCalls.set(key, seen);
		if (seen < max) return undefined;
		return `Refused: this exact \`${name}\` call already ran in this review (attempt ${seen}). The earlier result stands unchanged — re-running it cannot return anything new. Act on what you already have: call \`advise\`, or end the review without advice.`;
	}

	/**
	 * Wrap a tool so repeated identical calls short-circuit instead of
	 * re-executing. The proxy preserves the original receiver: real tools use
	 * ES `#private` fields, which throw when an extracted method is called with
	 * a clone as `this`.
	 */
	guardTool<T extends AgentTool<any>>(tool: T, identity?: unknown): T {
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return target[prop as keyof T];
				return (
					toolCallId: string,
					params: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					context: never,
				) => {
					const refusal = this.noteToolCall(target.name, identity === undefined ? params : { identity, params });
					if (refusal !== undefined) {
						// Not `isError`: an error result feeds the advisor failure
						// ladder, and a refused repeat is a healthy outcome.
						return Promise.resolve({
							content: [{ type: "text", text: refusal }],
							useless: true,
						} satisfies AgentToolResult);
					}
					return target.execute(toolCallId, params as never, signal, onUpdate, context);
				};
			},
		}) as T;
	}

	#halt(kind: AdvisorReviewBudgetStop["kind"], reason: string): AgentPreModelCallStop {
		if (!this.#stop) {
			this.#stop = { kind, reason };
			this.#onStop?.(this.#stop);
		}
		return { stop: true, reason };
	}
}
