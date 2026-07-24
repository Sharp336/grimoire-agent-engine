import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import type { GhToolDetails } from "./gh";
import {
	appendRepoFlag,
	buildTextResult,
	formatAuthor,
	formatLabels,
	normalizeOptionalString,
	normalizeText,
	parseIssueUrl,
	parsePositiveDecimalInt,
	pushLine,
	requireNonEmpty,
	resolveDefaultRepoMemoized,
} from "./gh-common";
import { formatShortSha } from "./gh-format";
import { FILE_PREVIEW_LIMIT } from "./gh-search";
import type {
	GhComment,
	GhIssueHierarchyLink,
	GhIssueSubIssuesSummary,
	GhIssueViewData,
	GhPrFile,
	GhPrReview,
	GhPrReviewComment,
	GhPrReviewCommentApi,
	GhPrViewData,
	GhRepoViewData,
	GhUser,
	GithubInput,
} from "./gh-types";
import { type CacheStatus, getOrFetchView, resolveGithubCacheAuthKey } from "./github-cache";
import { ToolAbortError, ToolError } from "./tool-errors";

export const GH_REPO_FIELDS = [
	"nameWithOwner",
	"description",
	"url",
	"defaultBranchRef",
	"homepageUrl",
	"forkCount",
	"isArchived",
	"isFork",
	"primaryLanguage",
	"repositoryTopics",
	"stargazerCount",
	"updatedAt",
	"viewerPermission",
	"visibility",
];
export const GH_ISSUE_FIELDS = [
	"author",
	"assignees",
	"body",
	"comments",
	"createdAt",
	"labels",
	"number",
	"parent",
	"state",
	"stateReason",
	"subIssues",
	"subIssuesSummary",
	"title",
	"updatedAt",
	"url",
];
export const GH_ISSUE_HIERARCHY_FIELDS = ["parent", "subIssues", "subIssuesSummary"] as const;

export type IssueHierarchyAvailability = "available" | "local-cli-unsupported" | "server-unsupported";

interface IssueHierarchyFetchResult<T> {
	data: T;
	hierarchyAvailability: IssueHierarchyAvailability;
}

export const GH_ISSUE_FIELDS_NO_COMMENTS = [
	"author",
	"assignees",
	"body",
	"createdAt",
	"labels",
	"number",
	"parent",
	"state",
	"stateReason",
	"subIssues",
	"subIssuesSummary",
	"title",
	"updatedAt",
	"url",
];

export const GH_ISSUE_STATE_REASON_FIELD = "stateReason";

export function ghUnknownJsonField(err: unknown): string | undefined {
	if (!(err instanceof Error)) return undefined;
	const match = err.message.match(/Unknown JSON field:?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z][A-Za-z0-9]*))/);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function ghJsonErrorNamesField(err: unknown, field: string): boolean {
	return ghUnknownJsonField(err) === field;
}

export function dropJsonFields(args: readonly string[], fieldsToDrop: readonly string[]): string[] | undefined {
	const next = [...args];
	const jsonIndex = next.indexOf("--json");
	if (jsonIndex < 0) return undefined;
	const fields = next[jsonIndex + 1];
	if (!fields) return undefined;
	const splitFields = fields.split(",");
	const kept = splitFields.filter(candidate => !fieldsToDrop.includes(candidate));
	if (kept.length === splitFields.length) return undefined;
	next[jsonIndex + 1] = kept.join(",");
	return next;
}

export function dropJsonField(args: readonly string[], field: string): string[] | undefined {
	return dropJsonFields(args, [field]);
}

/** Runs `gh --json` for issue data, retrying without optional stateReason on older gh releases. */
export async function githubIssueJsonWithStateReasonFallback<T>(
	cwd: string,
	args: readonly string[],
	signal: AbortSignal | undefined,
	options?: git.GhCommandOptions,
): Promise<T> {
	try {
		return await git.github.json<T>(cwd, [...args], signal, options);
	} catch (err) {
		if (!ghJsonErrorNamesField(err, GH_ISSUE_STATE_REASON_FIELD)) throw err;
		const retryArgs = dropJsonField(args, GH_ISSUE_STATE_REASON_FIELD);
		if (!retryArgs) throw err;
		return await git.github.json<T>(cwd, retryArgs, signal, options);
	}
}

function classifyHierarchyUnavailable(err: unknown): Exclude<IssueHierarchyAvailability, "available"> | undefined {
	if (err instanceof ToolAbortError || (err instanceof Error && err.name === "ToolAbortError")) return undefined;
	if (!(err instanceof Error)) return undefined;

	const unknownField = ghUnknownJsonField(err);
	if (
		err.message.includes("Unknown JSON field:") &&
		unknownField !== undefined &&
		GH_ISSUE_HIERARCHY_FIELDS.some(field => field === unknownField)
	) {
		return "local-cli-unsupported";
	}
	if (!err.message.includes("GraphQL:")) return undefined;

	const namesUnsupportedHierarchyField = GH_ISSUE_HIERARCHY_FIELDS.some(field => {
		const fieldName = `["'\`]?\\b${field}\\b["'\`]?`;
		const issueType = `["'\`]?\\bIssue\\b["'\`]?`;
		return (
			new RegExp(`Cannot query field\\s+${fieldName}[^\\r\\n]{0,80}on type\\s+${issueType}`, "i").test(
				err.message,
			) ||
			new RegExp(`${fieldName}[^\\r\\n]{0,80}does(?:n't| not) exist on type\\s+${issueType}`, "i").test(
				err.message,
			) ||
			new RegExp(`${fieldName}[^\\r\\n]{0,40}(?:is\\s+)?undefined[^\\r\\n]{0,80}on type\\s+${issueType}`, "i").test(
				err.message,
			)
		);
	});
	return namesUnsupportedHierarchyField ? "server-unsupported" : undefined;
}

/**
 * Fetches an issue with hierarchy data, retrying the base issue fields only
 * when the local CLI or remote GraphQL schema explicitly rejects hierarchy.
 */
export async function githubIssueJsonWithHierarchyFallback<T>(
	cwd: string,
	args: readonly string[],
	signal: AbortSignal | undefined,
	options?: git.GhCommandOptions,
): Promise<IssueHierarchyFetchResult<T>> {
	try {
		const data = await githubIssueJsonWithStateReasonFallback<T>(cwd, args, signal, options);
		return { data, hierarchyAvailability: "available" };
	} catch (err) {
		const hierarchyAvailability = classifyHierarchyUnavailable(err);
		if (!hierarchyAvailability) throw err;
		const retryArgs = dropJsonFields(args, GH_ISSUE_HIERARCHY_FIELDS);
		if (!retryArgs) throw err;
		const data = await githubIssueJsonWithStateReasonFallback<T>(cwd, retryArgs, signal, options);
		return { data, hierarchyAvailability };
	}
}

export const GH_PR_FIELDS = [
	"author",
	"baseRefName",
	"body",
	"comments",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
export const GH_PR_FIELDS_NO_COMMENTS = [
	"author",
	"baseRefName",
	"body",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
export const GH_REPO_CLONE_FIELDS = ["nameWithOwner", "sshUrl", "url"];

export const REVIEW_COMMENTS_PAGE_SIZE = 100;

export function normalizePrReviewComment(comment: GhPrReviewCommentApi): GhPrReviewComment | null {
	if (typeof comment.id !== "number") {
		return null;
	}

	return {
		author: comment.user ?? null,
		body: comment.body,
		createdAt: normalizeOptionalString(comment.created_at),
		id: comment.id,
		inReplyToId: typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : undefined,
		line: typeof comment.line === "number" ? comment.line : undefined,
		originalLine: typeof comment.original_line === "number" ? comment.original_line : undefined,
		path: normalizeOptionalString(comment.path),
		side: normalizeOptionalString(comment.side),
		url: normalizeOptionalString(comment.html_url),
	};
}

export async function fetchPrReviewComments(
	cwd: string,
	repo: string,
	prNumber: number,
	signal?: AbortSignal,
): Promise<GhPrReviewComment[]> {
	const reviewComments: GhPrReviewComment[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhPrReviewCommentApi[]>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/pulls/${prNumber}/comments`,
				"-F",
				`per_page=${REVIEW_COMMENTS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);

		const pageComments = response
			.map(comment => normalizePrReviewComment(comment))
			.filter((comment): comment is GhPrReviewComment => comment !== null);
		reviewComments.push(...pageComments);

		// Compare the raw page length: a dropped malformed item must not end
		// pagination early and silently lose the remaining pages.
		if (response.length < REVIEW_COMMENTS_PAGE_SIZE) {
			break;
		}

		page += 1;
	}

	return reviewComments;
}

export function formatCommentsSection(comments: GhComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const visible = comments.filter(comment => !comment.isMinimized);
	const hiddenCount = comments.length - visible.length;
	const lines: string[] = ["## Comments", ""];

	if (visible.length === 0) {
		lines.push(`No visible comments. Minimized comments omitted: ${hiddenCount}.`);
		return lines;
	}

	lines[0] = `## Comments (${visible.length})`;

	for (const comment of visible) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No comment body.");
		if (comment.url) {
			lines.push("");
			lines.push(`URL: ${comment.url}`);
		}
		lines.push("");
	}

	if (hiddenCount > 0) {
		lines.push(`Minimized comments omitted: ${hiddenCount}.`);
	}

	return lines;
}

export function formatReviewsSection(reviews: GhPrReview[] | undefined): string[] {
	if (!reviews || reviews.length === 0) {
		return [];
	}

	const lines: string[] = [`## Reviews (${reviews.length})`, ""];
	for (const review of reviews) {
		const author = formatAuthor(review.author) ?? "unknown";
		const submittedAt = review.submittedAt ? ` - ${review.submittedAt}` : "";
		const state = review.state ? ` [${review.state}]` : "";
		lines.push(`### ${author}${submittedAt}${state}`);
		if (review.commit?.oid) {
			lines.push("");
			lines.push(`Commit: ${formatShortSha(review.commit.oid)}`);
		}
		lines.push("");
		lines.push(normalizeText(review.body) || "No review body.");
		lines.push("");
	}

	return lines;
}

export function formatReviewCommentLocation(comment: GhPrReviewComment): string | undefined {
	if (!comment.path) {
		return undefined;
	}

	const line = comment.line ?? comment.originalLine;
	return line === undefined ? comment.path : `${comment.path}:${line}`;
}

export function formatReviewCommentsSection(comments: GhPrReviewComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const lines: string[] = [`## Review Comments (${comments.length})`, ""];
	for (const comment of comments) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		pushLine(lines, "Location", formatReviewCommentLocation(comment));
		pushLine(lines, "Side", comment.side);
		pushLine(lines, "Reply to", comment.inReplyToId);
		pushLine(lines, "URL", comment.url);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No review comment body.");
		lines.push("");
	}

	return lines;
}

export function formatRepoView(data: GhRepoViewData, input: { repo?: string; branch?: string }): string {
	const lines: string[] = [];
	const name = data.nameWithOwner ?? input.repo ?? "GitHub Repository";
	lines.push(`# ${name}`);
	lines.push("");
	lines.push(normalizeText(data.description) || "No description provided.");
	lines.push("");
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Default branch", data.defaultBranchRef?.name);
	pushLine(lines, "Branch", normalizeOptionalString(input.branch));
	pushLine(lines, "Visibility", data.visibility ?? undefined);
	pushLine(lines, "Viewer permission", data.viewerPermission ?? undefined);
	pushLine(lines, "Primary language", data.primaryLanguage?.name);
	pushLine(lines, "Stars", data.stargazerCount);
	pushLine(lines, "Forks", data.forkCount);
	pushLine(lines, "Archived", data.isArchived);
	pushLine(lines, "Fork", data.isFork);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Homepage", data.homepageUrl ?? undefined);
	const topics = data.repositoryTopics
		?.map(topic => topic.name ?? topic.topic?.name)
		.filter((value): value is string => Boolean(value))
		.join(", ");
	pushLine(lines, "Topics", topics || undefined);
	return lines.join("\n").trim();
}

function formatAssignees(assignees: GhUser[] | undefined): string | undefined {
	const names = assignees?.map(formatAuthor).filter((value): value is string => value !== undefined) ?? [];
	if (names.length === 0) return undefined;
	return names.join(", ");
}

interface ParsedLinkedIssueUrl {
	repo: string;
	issueNumber: number;
	host: string;
}

/**
 * Parse a canonical linked-issue URL from GitHub.com or GHES. The URL itself
 * is authoritative because gh's exported hierarchy shape omits repository
 * metadata, including for cross-repository relationships.
 */
function parseLinkedIssueUrl(value: string | undefined): ParsedLinkedIssueUrl | undefined {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return undefined;

	let linkedUrl: URL;
	try {
		linkedUrl = new URL(normalized);
	} catch {
		return undefined;
	}
	if (
		(linkedUrl.protocol !== "http:" && linkedUrl.protocol !== "https:") ||
		linkedUrl.username !== "" ||
		linkedUrl.password !== "" ||
		linkedUrl.search !== "" ||
		linkedUrl.hash !== ""
	) {
		return undefined;
	}

	const pathSegments = linkedUrl.pathname.split("/");
	if (
		pathSegments.length !== 5 ||
		pathSegments[0] !== "" ||
		pathSegments[3] !== "issues" ||
		pathSegments[1] === "" ||
		pathSegments[2] === ""
	) {
		return undefined;
	}

	let owner: string;
	let repo: string;
	try {
		owner = decodeURIComponent(pathSegments[1]);
		repo = decodeURIComponent(pathSegments[2]);
	} catch {
		return undefined;
	}
	const safeSegmentPattern = /^[A-Za-z0-9._~-]+$/;
	if (!safeSegmentPattern.test(owner) || !safeSegmentPattern.test(repo) || owner === "." || owner === "..") {
		return undefined;
	}
	if (repo === "." || repo === "..") return undefined;

	const issueNumber = parsePositiveDecimalInt(pathSegments[4]);
	if (issueNumber === undefined) return undefined;
	return { host: linkedUrl.host.toLowerCase(), repo: `${owner}/${repo}`, issueNumber };
}

interface FormattedIssueHierarchyLink {
	issueNumber: number;
	repo: string;
	host: string;
	state: string;
	title: string;
}

function normalizeIssueHierarchyLink(
	value: GhIssueHierarchyLink | null | undefined,
	expectedHost: string,
): FormattedIssueHierarchyLink | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number <= 0) return undefined;
	if (typeof value.state !== "string" || typeof value.title !== "string" || typeof value.url !== "string") {
		return undefined;
	}
	const state = value.state.trim();
	const title = value.title.trim().replace(/\s+/g, " ");
	const parsedUrl = parseLinkedIssueUrl(value.url);
	if (
		(state !== "OPEN" && state !== "CLOSED") ||
		!title ||
		!parsedUrl ||
		parsedUrl.host !== expectedHost ||
		parsedUrl.issueNumber !== value.number
	) {
		return undefined;
	}
	return { host: parsedUrl.host, issueNumber: parsedUrl.issueNumber, repo: parsedUrl.repo, state, title };
}

function formatIssueHierarchyUrl(link: FormattedIssueHierarchyLink): string {
	const base = `issue://${link.repo}/${link.issueNumber}`;
	return link.host === "github.com" ? base : `${base}?host=${encodeURIComponent(link.host)}`;
}

function formatIssueHierarchySection(data: GhIssueViewData, availability: IssueHierarchyAvailability): string[] {
	const lines = ["## Issue hierarchy", ""];
	if (availability === "local-cli-unsupported") {
		lines.push("Issue hierarchy unavailable: GitHub CLI 2.94.0 or later is required.");
		return lines;
	}
	if (availability === "server-unsupported") {
		lines.push("Issue hierarchy unavailable on this GitHub server.");
		return lines;
	}

	let partial = false;
	const expectedHost = parseLinkedIssueUrl(data.url)?.host;
	let parent: FormattedIssueHierarchyLink | undefined;
	if (data.parent === undefined) {
		partial = true;
	} else if (data.parent !== null) {
		parent = expectedHost ? normalizeIssueHierarchyLink(data.parent, expectedHost) : undefined;
		if (!parent) partial = true;
	}

	const subIssues: FormattedIssueHierarchyLink[] = [];
	let totalCount: number | undefined;
	const rawSubIssues = data.subIssues;
	if (
		!rawSubIssues ||
		typeof rawSubIssues !== "object" ||
		!Array.isArray(rawSubIssues.nodes) ||
		typeof rawSubIssues.totalCount !== "number" ||
		!Number.isSafeInteger(rawSubIssues.totalCount) ||
		rawSubIssues.totalCount < 0
	) {
		partial = true;
	} else {
		totalCount = rawSubIssues.totalCount;
		for (const rawSubIssue of rawSubIssues.nodes) {
			const subIssue = expectedHost ? normalizeIssueHierarchyLink(rawSubIssue, expectedHost) : undefined;
			if (subIssue) {
				subIssues.push(subIssue);
			} else {
				partial = true;
			}
		}
		if (totalCount !== rawSubIssues.nodes.length) partial = true;
	}

	let summary: GhIssueSubIssuesSummary | undefined;
	const rawSummary = data.subIssuesSummary;
	if (
		!rawSummary ||
		typeof rawSummary !== "object" ||
		typeof rawSummary.total !== "number" ||
		!Number.isSafeInteger(rawSummary.total) ||
		rawSummary.total < 0 ||
		typeof rawSummary.completed !== "number" ||
		!Number.isSafeInteger(rawSummary.completed) ||
		rawSummary.completed < 0 ||
		rawSummary.completed > rawSummary.total ||
		typeof rawSummary.percentCompleted !== "number" ||
		!Number.isFinite(rawSummary.percentCompleted) ||
		rawSummary.percentCompleted < 0 ||
		rawSummary.percentCompleted > 100
	) {
		partial = true;
	} else {
		summary = rawSummary;
	}
	if (summary && (summary.total < subIssues.length || (totalCount !== undefined && summary.total !== totalCount))) {
		summary = undefined;
		partial = true;
	}

	const hierarchyLines: string[] = [];
	if (parent) {
		hierarchyLines.push(`Parent: ${parent.state} ${parent.repo}#${parent.issueNumber} — ${parent.title}`);
		hierarchyLines.push(formatIssueHierarchyUrl(parent));
	}
	if (summary && summary.total > 0) {
		if (hierarchyLines.length > 0) hierarchyLines.push("");
		const roundedPercent = Math.round(summary.percentCompleted);
		hierarchyLines.push(`Sub-issues: ${summary.completed}/${summary.total} complete (${roundedPercent}%)`);
	} else if (subIssues.length > 0) {
		if (hierarchyLines.length > 0) hierarchyLines.push("");
		hierarchyLines.push("Sub-issues:");
	}
	for (const subIssue of subIssues) {
		hierarchyLines.push(`- ${subIssue.state} ${subIssue.repo}#${subIssue.issueNumber} — ${subIssue.title}`);
		hierarchyLines.push(`  ${formatIssueHierarchyUrl(subIssue)}`);
	}

	if (hierarchyLines.length > 0) {
		lines.push(...hierarchyLines);
	} else {
		lines.push("No visible parent or direct sub-issues for the current GitHub identity.");
	}
	if (partial) {
		lines.push("");
		lines.push("> WARNING: Issue hierarchy data is partial; only valid visible relationships are shown.");
	}
	return lines;
}

export function formatIssueView(
	data: GhIssueViewData,
	input: {
		issue: string;
		repo?: string;
		comments?: boolean;
		hierarchyAvailability: IssueHierarchyAvailability;
	},
): string {
	const lines: string[] = [];
	const issueNumber = data.number ?? input.issue;
	lines.push(`# Issue #${issueNumber}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "State reason", data.stateReason ?? undefined);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Assignees", formatAssignees(data.assignees));
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push(...formatIssueHierarchySection(data, input.hierarchyAvailability));
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

export function formatPrFiles(files: GhPrFile[] | undefined): string[] {
	if (!files || files.length === 0) return [];

	const lines: string[] = [`## Files (${files.length})`, ""];
	for (const file of files.slice(0, FILE_PREVIEW_LIMIT)) {
		const changeType = file.changeType ?? "CHANGED";
		const additions = file.additions ?? 0;
		const deletions = file.deletions ?? 0;
		lines.push(`- ${file.path ?? "(unknown file)"} [${changeType}] (+${additions} -${deletions})`);
	}

	if (files.length > FILE_PREVIEW_LIMIT) {
		lines.push(`[…${files.length - FILE_PREVIEW_LIMIT} files elided…]`);
	}

	return lines;
}

export function formatPrView(data: GhPrViewData, input: { pr?: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const prIdentifier = data.number ?? input.pr ?? "current";
	lines.push(`# Pull Request #${prIdentifier}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "Draft", data.isDraft);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Review decision", data.reviewDecision ?? undefined);
	pushLine(lines, "Merge state", data.mergeStateStatus);
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	const fileSection = formatPrFiles(data.files);
	if (fileSection.length > 0) {
		lines.push("");
		lines.push(...fileSection);
	}

	if ((input.comments ?? true) && data.reviews) {
		const reviewSection = formatReviewsSection(data.reviews);
		if (reviewSection.length > 0) {
			lines.push("");
			lines.push(...reviewSection);
		}
	}

	if ((input.comments ?? true) && data.reviewComments) {
		const reviewCommentsSection = formatReviewCommentsSection(data.reviewComments);
		if (reviewCommentsSection.length > 0) {
			lines.push("");
			lines.push(...reviewCommentsSection);
		}
	}

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

export async function executeRepoView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["repo", "view"];
	if (repo) {
		args.push(repo);
	}
	if (branch) {
		args.push("--branch", branch);
	}
	args.push("--json", GH_REPO_FIELDS.join(","));

	const data = await git.github.json<GhRepoViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatRepoView(data, { repo, branch }), data.url);
}

// ────────────────────────────────────────────────────────────────────────────
// Cached issue/PR view fetchers
//
// Used by `executeIssueView`/`executePrView` and by the `issue://` / `pr://`
// internal-URL protocol handlers. The cache wrapper lives in `./github-cache`;
// the fresh fetchers stay here to share the existing formatter helpers.
// ────────────────────────────────────────────────────────────────────────────

export interface IssueViewLookupOptions {
	cwd: string;
	repo?: string;
	/** Issue number or GitHub issue URL. */
	issue: string;
	includeComments?: boolean;
	forceRefresh?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface PrViewLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	includeComments?: boolean;
	signal?: AbortSignal;
	forceRefresh?: boolean;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface ViewLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

export async function fetchIssueViewFresh(
	cwd: string,
	repo: string | undefined,
	identifier: string,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhIssueViewData }> {
	const args = ["issue", "view", identifier];
	appendRepoFlag(args, repo, identifier);
	args.push("--json", (includeComments ? GH_ISSUE_FIELDS : GH_ISSUE_FIELDS_NO_COMMENTS).join(","));
	const { data, hierarchyAvailability } = await githubIssueJsonWithHierarchyFallback<GhIssueViewData>(
		cwd,
		args,
		signal,
		{
			repoProvided: Boolean(repo),
		},
	);
	const rendered = formatIssueView(data, {
		issue: identifier,
		repo,
		comments: includeComments,
		hierarchyAvailability,
	});
	return { rendered, sourceUrl: data.url, payload: data };
}

export async function fetchPrViewFresh(
	cwd: string,
	repo: string,
	number: number,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhPrViewData }> {
	const args = ["pr", "view", String(number)];
	appendRepoFlag(args, repo, String(number));
	args.push("--json", (includeComments ? GH_PR_FIELDS : GH_PR_FIELDS_NO_COMMENTS).join(","));
	const data = await git.github.json<GhPrViewData>(cwd, args, signal, { repoProvided: true });
	if (includeComments && typeof data.number === "number") {
		data.reviewComments = await fetchPrReviewComments(cwd, repo, data.number, signal);
	}
	const rendered = formatPrView(data, { pr: String(number), repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

/**
 * Cache-aware issue/view fetcher. Used by both the `github` tool op and the
 * `issue://` protocol handler so a single shared row services both surfaces.
 */
export async function getOrFetchIssue(options: IssueViewLookupOptions): Promise<ViewLookupResult<GhIssueViewData>> {
	const identifier = requireNonEmpty(options.issue, "issue");
	if (identifier.startsWith("-")) {
		throw new ToolError(`invalid issue identifier: ${identifier}. Pass an issue number or URL.`);
	}
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const urlParse = parseIssueUrl(identifier);
	// Prefer the URL's repo when the identifier is a full URL; fall back to the
	// explicit `repo` option, then to the cwd's default repo.
	let repo = urlParse.repo ?? normalizeOptionalString(options.repo);
	let cacheNumber = urlParse.issueNumber;
	if (cacheNumber === undefined) {
		cacheNumber = parsePositiveDecimalInt(identifier);
	}
	if (cacheNumber !== undefined && !repo) {
		try {
			repo = await resolveDefaultRepoMemoized(options.cwd, options.signal);
		} catch {
			// Resolution failure leaves `repo` undefined: we'll fall through to a
			// direct fetch below so gh produces its own error message instead of
			// us masking it with a friendlier one.
			repo = undefined;
		}
	}

	const doFetch = () => fetchIssueViewFresh(options.cwd, repo, identifier, includeComments, options.signal);

	if (!repo || cacheNumber === undefined) {
		const fresh = await doFetch();
		return { ...fresh, status: "miss", fetchedAt: Date.now() };
	}

	const lookup = await getOrFetchView<GhIssueViewData>({
		repo,
		kind: "issue",
		number: cacheNumber,
		includeComments,
		forceRefresh: options.forceRefresh,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

/**
 * Cache-aware PR view fetcher. Caller must supply a numeric PR number;
 * branch-name / current-branch lookups bypass the cache entirely upstream
 * (see `executePrView`).
 */
export async function getOrFetchPr(options: PrViewLookupOptions): Promise<ViewLookupResult<GhPrViewData>> {
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrViewFresh(options.cwd, options.repo, options.number, includeComments, options.signal);
	const lookup = await getOrFetchView<GhPrViewData>({
		repo: options.repo,
		kind: "pr",
		number: options.number,
		includeComments,
		forceRefresh: options.forceRefresh,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}
