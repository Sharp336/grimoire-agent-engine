/**
 * Best-effort kwarg-stripping retry ladder.
 *
 * When a provider returns HTTP 400 rejecting an optional request parameter
 * (reasoning config, `temperature`, `output_config`, forced `tool_choice`,
 * …), the error message almost always names the offending field. This module
 * picks which optional kwarg to strip next so a provider can retry with a
 * progressively smaller optional envelope. Pure selection only — the provider
 * owns applying the strip, rebuilding params, and the streaming retry guard
 * (the retry must happen before any replay-unsafe content is forwarded).
 *
 * Semantics-changing keys (`messages`, `tools`, `max_tokens`, `system`) are
 * never represented here: the ladder only strips the best-effort
 * sampling/reasoning envelope. A 400 whose message names none of the
 * registered kwargs returns `undefined` from {@link nextKwargStripRung} and
 * is not retried by the ladder — unrelated 400s (context overflow, malformed
 * schema) fall through to the existing error path unchanged.
 */

/**
 * Union of wire-key names the ladder can strip across all providers. Kept in
 * one place so the error classifier (`matchesUnsupportedKwarg` in `flags.ts`)
 * and the per-provider ladders stay in sync: a 400 only classifies as
 * `Flag.UnsupportedKwarg` when it names one of these keys. Word-boundary
 * anchored so `temp` does not match `temperature` and `effort` does not match
 * inside `reasoning_effort` (the `_` is a word character).
 */
export const UNSUPPORTED_KWARG_NAME_PATTERN =
	/\b(?:temperature|top[_-]?p|top[_-]?k|min[_-]?p|presence[_-]?penalty|repetition[_-]?penalty|thinking|budget[_-]?tokens|output[_-]?config|effort|reasoning(?:[_-]?effort)?|tool[_-]?choice|speed)\b/i;

/**
 * One rung of the ladder: the names the provider's 400 error message uses to
 * refer to this rung's keys, and the mutation that removes them from the
 * provider-specific params object.
 */
export interface KwargStripRung<P> {
	/** Stable id for logging and de-dup of attempts. */
	readonly id: string;
	/**
	 * Substrings matched (case-insensitive) against the flattened 400 error
	 * text to decide whether THIS rung is the one to apply next. A rung only
	 * fires when the error names one of its matchers.
	 */
	readonly matchers: readonly RegExp[];
	/**
	 * Mutate `params` in place to remove this rung's keys. MUST be a no-op
	 * when the keys are already absent (idempotent), so re-running a
	 * previously-applied rung is safe. For rungs that downgrade rather than
	 * delete (e.g. forced `tool_choice` → `auto`), the mutation rewrites the
	 * value instead of removing it.
	 */
	strip: (params: P) => void;
}

/**
 * Ordered set of rungs. Order is least-disruptive first: drop the reasoning
 * envelope before dropping sampling params, so a thinking rejection does not
 * also throw away the caller's `temperature`.
 */
export type KwargRetryLadder<P> = readonly KwargStripRung<P>[];

/**
 * Pick the next ladder rung whose matchers hit `errorText`, skipping rungs
 * already in `alreadyApplied`. Returns `undefined` when no remaining rung
 * matches — the signal that the 400 does not name a strippable kwarg and must
 * not be retried by the ladder. Pure: no side effects, no param mutation.
 */
export function nextKwargStripRung<P>(
	errorText: string,
	ladder: KwargRetryLadder<P>,
	alreadyApplied: ReadonlySet<string>,
): KwargStripRung<P> | undefined {
	for (const rung of ladder) {
		if (alreadyApplied.has(rung.id)) continue;
		if (rung.matchers.some(re => re.test(errorText))) return rung;
	}
	return undefined;
}
