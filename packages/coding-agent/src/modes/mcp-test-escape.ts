/**
 * Esc-routing state for `/mcp test`.
 *
 * While a test is pending, Esc aborts it. After it settles (fast for most
 * servers — context7 answers in ~1s), Esc stays owned by the test for a short
 * grace window so a user reacting to the "(esc to cancel)" hint never falls
 * through to the session interrupt path. Past the window, Esc is released back
 * to normal semantics.
 */

/** How long after a /mcp test settles, Esc stays owned by the test result instead of falling
 *  through to the session interrupt path (covers the user reaction window to "(esc to cancel)"). */
export const MCP_TEST_ESC_GRACE_MS = 5000;

export type McpTestEscDecision = "abort" | "consume" | "fallthrough";

export class McpTestEscapeState {
	#active: { abortController: AbortController; name: string; settledAt?: number; cancelled?: boolean } | undefined;

	/** Register an in-flight test. Replaces any previous active state (concurrent tests are not supported). */
	begin(abortController: AbortController, name: string): void {
		this.#active = { abortController, name };
	}

	/** Mark the test for `abortController` settled. Identity-guarded: a superseded (replaced) test
	 *  must not settle the newer one. Records `cancelled` when the signal was already aborted, and
	 *  schedules release of the active state after MCP_TEST_ESC_GRACE_MS via setTimeout. */
	settle(abortController: AbortController): void {
		if (!this.#active || this.#active.abortController !== abortController) return;
		this.#active.settledAt = Date.now();
		this.#active.cancelled = abortController.signal.aborted;
		const settled = this.#active;
		setTimeout(() => {
			// Release only if this settle is still the active one (superseded by a newer begin).
			if (this.#active === settled) this.#active = undefined;
		}, MCP_TEST_ESC_GRACE_MS);
	}

	hasActive(): boolean {
		return this.#active !== undefined;
	}

	/** Esc routing decision. Pending → abort the test, return "abort". Settled within grace →
	 *  "consume" (never the session). Settled past grace (or no active test) → release state, "fallthrough". */
	handleEscape(now: number = Date.now()): McpTestEscDecision {
		const active = this.#active;
		if (!active) return "fallthrough";
		if (active.settledAt === undefined) {
			active.abortController.abort();
			return "abort";
		}
		if (now - active.settledAt < MCP_TEST_ESC_GRACE_MS) {
			return "consume";
		}
		this.#active = undefined;
		return "fallthrough";
	}

	/** Name of the active test (for consume feedback). */
	get name(): string | undefined {
		return this.#active?.name;
	}

	/** Whether the settled test was aborted by Esc (for consume feedback). */
	get cancelled(): boolean | undefined {
		return this.#active?.cancelled;
	}
}
