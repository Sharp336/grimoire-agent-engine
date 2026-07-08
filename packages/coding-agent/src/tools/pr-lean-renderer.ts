/**
 * Lean compact-YAML renderer for GitHub pull request data.
 *
 * Produces a terse YAML block that is ~46% smaller (token-wise) than the full
 * Markdown pr:// view and avoids the extra `fetchPrReviewComments` subprocess
 * call. Surfaced via `pr://owner/repo/<N>?lean=1`.
 *
 * Token comparison vs `pr://` full:
 *   - No review bodies (count only)
 *   - No comment bodies (count only)
 *   - Body truncated to LEAN_BODY_MAX chars
 *   - Compact YAML instead of nested Markdown headers
 */

/** Maximum characters of the PR body to include in lean output. */
export const LEAN_BODY_MAX = 1200;

/** Minimal PR data shape consumed by the lean renderer. */
export interface PrLeanInput {
	number?: number;
	title?: string;
	state?: string;
	author?: { login?: string | null; name?: string | null } | null;
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
	/** null is the gh CLI representation of "no decision yet". */
	reviewDecision?: string | null;
	body?: string | null;
	/** Issue-level comments — absent in lean fetches (no `comments` gh field). */
	comments?: Array<unknown>;
	/** Inline review comments — absent in lean fetches (skips the extra API call). */
	reviewComments?: Array<unknown>;
	reviews?: Array<{
		author?: { login?: string | null; name?: string | null } | null;
		state?: string | null;
	}>;
	files?: Array<{
		path?: string;
		additions?: number;
		deletions?: number;
		changeType?: string;
	}>;
}

/** Escape a string for inline YAML double-quoted scalar. */
export function escapeLean(s: string): string {
	return `"${s.replace(/\r\n/g, "\\n").replace(/\r/g, "\\n").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`;
}

function normalizeBody(value: string | null | undefined): string {
	if (!value) return "";
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/**
 * Render `data` as a compact YAML block.
 *
 * Omits review and comment bodies (shows counts instead). Body is truncated to
 * {@link LEAN_BODY_MAX} characters with a note when it overflows.
 */
export function formatPrLean(data: PrLeanInput): string {
	const lines: string[] = [];
	lines.push("pull_request:");
	lines.push(`  number: ${data.number ?? "?"}`);
	lines.push(`  title: ${escapeLean(data.title ?? "")}`);
	lines.push(`  state: ${(data.state ?? "?").toLowerCase()}`);
	const authorLogin = data.author?.login ?? data.author?.name ?? "?";
	lines.push(`  author: ${authorLogin}`);
	lines.push(`  draft: ${data.isDraft ? "yes" : "no"}`);
	lines.push(`  merged: ${data.state?.toLowerCase() === "merged" ? "yes" : "no"}`);
	if (data.baseRefName) lines.push(`  base: ${data.baseRefName}`);
	if (data.headRefName) lines.push(`  head: ${data.headRefName}`);
	if (data.reviewDecision) lines.push(`  review_decision: ${data.reviewDecision}`);

	const body = normalizeBody(data.body);
	const bodyTrunc =
		body.length > LEAN_BODY_MAX
			? `${body.slice(0, LEAN_BODY_MAX)}\n... (truncated, ${body.length} chars total)`
			: body;
	lines.push(`  body: ${escapeLean(bodyTrunc)}`);

	const commentCount = (data.comments?.length ?? 0) + (data.reviewComments?.length ?? 0);
	const reviewCount = data.reviews?.length ?? 0;
	lines.push(`  comment_count: ${commentCount} -- use pr://<owner>/<repo>/<n> to fetch issue comments`);
	lines.push(`  review_count: ${reviewCount} -- use pr://<owner>/<repo>/<n> to fetch review bodies`);

	if (data.files && data.files.length > 0) {
		lines.push("  files:");
		for (const f of data.files) {
			lines.push(`    - path: ${f.path ?? "?"}`);
			lines.push(`      changes: +${f.additions ?? 0} -${f.deletions ?? 0} [${f.changeType ?? "?"}]`);
		}
	}

	return lines.join("\n");
}
