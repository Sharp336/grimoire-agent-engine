/**
 * Single source of truth for the `/council` argument grammar. The command usage line, the council
 * builtin's TUI `inlineHint`, and its `acpInputHint` all derive from these so the three copies
 * cannot drift apart again.
 *
 * This is a leaf module on purpose: `builtin-registry.ts` reads {@link COUNCIL_GRAMMAR} while
 * evaluating its command table, and `helpers/council.ts` reaches `builtin-registry` transitively
 * through the coordinator, so keeping the constants here is what stops that cycle from becoming a
 * temporal-dead-zone crash whenever the helper is imported first.
 */
export const COUNCIL_GRAMMAR = "<task> | status | cancel | resume [run-id] | config";

export const COUNCIL_USAGE = [
	`Usage: /council [--] ${COUNCIL_GRAMMAR}`,
	"A council sends your task to every enabled reviewer role in parallel and adjudicates their findings into one plan, spending on every configured role. `resume` with no run id continues the newest resumable run; `/council config` sets the roster.",
].join("\n");
