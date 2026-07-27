/**
 * Translate a Pi frame's args into the local tool kwargs that run it.
 *
 * Shared deliberately by three consumers: the provider synthesizes a display
 * block from these, the coding-agent bridge executes with them, and the legacy
 * pi shim performs the identical translation for the old wire. Separate
 * hand-rolled copies drift, and the drift is invisible — the transcript shows
 * one operation while a different one runs.
 *
 * Kept apart from `cursor/exec-modern.ts` on purpose: these are pure
 * string/path functions with no protobuf coupling, while that module pulls in
 * `@bufbuild/protobuf` and the generated `agent_pb` graph. The legacy shim is
 * compiled into the bundled virtual module registry, so importing it from a
 * nested path would drag the whole exec implementation in with it — and
 * `./providers/*` is a single-segment wildcard export that cannot serve a
 * nested specifier under bunfs (issue #3442).
 *
 * Every `optional int32` here is presence-sensitive: `0` is a supplied value,
 * not "unset", so it must never be folded into a default.
 */

import * as path from "node:path";

/**
 * A `pi_read` range composed onto the path as `read`'s inline `:N+K` selector.
 *
 * `read` exposes no range kwargs, so an uncomposed range reads the whole file.
 * `offset` is a 1-indexed start clamped like the reference's
 * `Math.max(0, offset - 1)` over 0-indexed lines; `limit` is a line count.
 * `null` marks a present `limit: 0` — zero lines, which no selector expresses
 * and which must not degrade into a whole-file read.
 */
export function piReadPath(readPath: string, offset?: number, limit?: number): string | null {
	if (limit !== undefined && Math.floor(limit) <= 0) return null;
	const start = offset !== undefined ? Math.max(1, Math.floor(offset)) : undefined;
	const count = limit !== undefined ? Math.floor(limit) : undefined;
	if (start === undefined && count === undefined) return readPath;
	if (start === undefined) return `${readPath}:1+${count}`;
	return count === undefined ? `${readPath}:${start}-` : `${readPath}:${start}+${count}`;
}

/**
 * Join a Pi frame's optional `path` with the `glob`/`pattern` it scopes.
 *
 * The local `grep`/`glob` tools take one combined path spec. An absolute
 * pattern ignores the path, and an absent or `.` path leaves the pattern
 * standing alone rather than building a `./`- or `//`-prefixed spec.
 *
 * Uses `node:path` rather than string surgery so Windows absolutes (`C:\…`,
 * UNC) are recognised and separators stay normalized.
 */
export function piJoinPath(basePath: string | undefined, pattern: string): string {
	if (path.isAbsolute(pattern)) return pattern;
	if (!basePath || basePath === ".") return pattern;
	return path.join(basePath, pattern);
}

/**
 * The path a `pi_ls` frame lists.
 *
 * The frame's `limit` is deliberately NOT mapped. It caps directory *entries*
 * (the reference does a flat `readdir` and slices the entry array), while the
 * local `read` tool renders a depth-2 tree with per-directory caps and elision
 * summaries and applies a selector as a *rendered line* slice. Nested rows,
 * headers and "N more" lines all count toward that slice, so `:1+K` would cap
 * a different unit while looking honored — worse than leaving it unset, which
 * at least reports the local listing's own truncation faithfully.
 */
export function piLsPath(basePath: string | undefined): string {
	return basePath || ".";
}

/** Escape a literal string so the regex-only local `grep` tool matches it verbatim. */
export function piEscapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Clamp a present `optional int32` result cap the way the reference does; `undefined` stays unset. */
export function piLimit(limit: number | undefined): number | undefined {
	return limit === undefined ? undefined : Math.max(1, Math.floor(limit));
}

/**
 * A `pi_bash` frame's timeout as the local `bash` tool's kwarg.
 *
 * Presence-sensitive like every other `optional int32` here, and unusually
 * load-bearing: `bash` documents `timeout: 0` as "disables the command
 * deadline", so folding a supplied `0` into `undefined` applies the 300s
 * default and kills exactly the long-running command that asked not to be.
 * Negative values have no local meaning and fall back to the default.
 */
export function piTimeout(timeout: number | undefined): number | undefined {
	return timeout !== undefined && timeout >= 0 ? timeout : undefined;
}
