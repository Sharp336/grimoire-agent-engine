/**
 * Protocol handlers for `issue://` and `pr://`.
 *
 * Single GitHub issue/PR reads and GitLab issue/MR reads route through the
 * SQLite-backed cache. GitLab cache rows are enabled only when a local glab
 * credential identity is visible. Root and repo-scoped reads
 * (`issue://`, `pr://owner/repo`) issue a live list call for browsing.
 *
 * URL shapes:
 * - `issue://` / `pr://` — list recent items in the caller's default repo.
 * - `issue://owner/repo` / `pr://owner/repo` — list recent items for that repo.
 * - `issue://123` / `pr://123` — single item; repo/backend derived from the
 *   session cwd (passed through `ResolveContext`).
 * - `issue://owner/repo/123` / `pr://owner/repo/123` — fully qualified single
 *   item. GitHub by default; GitLab only when the checkout has a matching
 *   GitLab remote.
 * - `issue://owner/repo/123?comments=0` — single item, comments suppressed.
 * - `issue://owner/repo?state=closed&limit=20` — list options pass through to
 *   the selected backend.
 */
import type { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import {
	getOrFetchIssue,
	getOrFetchPr,
	getOrFetchPrDiff,
	githubIssueJsonWithStateReasonFallback,
	type PrDiffFile,
	parsePositiveDecimalInt,
	resolveDefaultRepoMemoized,
} from "../tools/gh";
import { type CacheStatus, formatFreshnessNote, normalizeGitlabHost } from "../tools/github-cache";
import { getOrFetchGitlabIssue, getOrFetchGitlabMr, getOrFetchGitlabMrDiff } from "../tools/gitlab";
import * as git from "../utils/git";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

type Scheme = "issue" | "pr";

type IssuePrBackend = { kind: "github"; repo: string } | { kind: "gitlab"; host: string; repo: string };

interface ParsedGitRemote {
	backend: "gitlab";
	host: string;
	repo: string;
}

interface ParsedSingle {
	kind: "single";
	repo?: string;
	number: number;
	comments: boolean;
}

interface ParsedPrDiff {
	kind: "pr-diff";
	repo?: string;
	number: number;
	/**
	 * `list` → enumerate changed files.
	 * `all`  → full unified diff.
	 * `slice`→ single file's diff section (1-indexed `index`).
	 */
	mode: "list" | "all" | "slice";
	index?: number;
}

interface ParsedList {
	kind: "list";
	repo?: string;
	state: "open" | "closed" | "merged" | "all";
	limit: number;
	author: string | undefined;
	label: string | undefined;
}

type Parsed = ParsedSingle | ParsedList | ParsedPrDiff;

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;

function allowedListStates(scheme: Scheme): readonly ParsedList["state"][] {
	return scheme === "pr" ? ["open", "closed", "merged", "all"] : ["open", "closed", "all"];
}

function isAllowedListState(scheme: Scheme, value: string): value is ParsedList["state"] {
	return value === "open" || value === "closed" || value === "all" || (scheme === "pr" && value === "merged");
}

function parseListOptions(url: InternalUrl, scheme: Scheme, repo: string | undefined): ParsedList {
	const stateRaw = url.searchParams.get("state");
	const allowedStates = allowedListStates(scheme);
	let state: ParsedList["state"] = "open";
	if (stateRaw !== null) {
		if (!isAllowedListState(scheme, stateRaw)) {
			// Reject instead of silently falling back to "open": a typo'd state
			// would otherwise return the open list, indistinguishable from "no
			// matches for the requested state".
			throw new Error(
				`Invalid ${scheme}:// list state '${stateRaw}'. Expected one of: ${allowedStates.join(", ")}.`,
			);
		}
		state = stateRaw;
	}

	const limitRaw = url.searchParams.get("limit");
	let limit = LIST_LIMIT_DEFAULT;
	if (limitRaw !== null) {
		const parsed = parsePositiveDecimalInt(limitRaw);
		if (parsed === undefined) {
			throw new Error(
				`Invalid ${scheme}:// list limit '${limitRaw}'. Expected a positive integer (max ${LIST_LIMIT_MAX}).`,
			);
		}
		limit = Math.min(parsed, LIST_LIMIT_MAX);
	}
	return {
		kind: "list",
		repo,
		state,
		limit,
		author: url.searchParams.get("author") ?? undefined,
		label: url.searchParams.get("label") ?? undefined,
	};
}

function parseUrl(url: InternalUrl, scheme: Scheme): Parsed {
	const host = url.rawHost || url.hostname;
	const rawPath = url.rawPathname ?? url.pathname;
	// Strip a single leading slash so we can detect empty internal segments
	// (e.g. `pr://owner//77` → pathname `//77` → stripped `/77` → ["", "77"]).
	const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const parts: string[] = [];
	if (stripped !== "") {
		for (const seg of stripped.split("/")) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(seg);
			} catch {
				throw new Error(`Invalid ${scheme}:// URL: empty or unsafe path segment`);
			}
			if (decoded === "" || decoded === "." || decoded === "..") {
				throw new Error(`Invalid ${scheme}:// URL: empty or unsafe path segment`);
			}
			parts.push(seg);
		}
	}

	// Shapes:
	//   scheme://                    → list default repo
	//   scheme://N                   → single item, default repo
	//   scheme://owner/repo          → list specific repo
	//   scheme://owner/repo/N        → single item, specific repo
	//   pr://N/diff[/<sub>]          → diff family, default repo
	//   pr://owner/repo/N/diff[/<sub>] → diff family, specific repo
	let repo: string | undefined;
	let numberPart: string | undefined;
	let diffParts: string[] = [];

	if (!host && parts.length === 0) {
		return parseListOptions(url, scheme, undefined);
	}
	if (host && parts.length === 0) {
		// scheme://N (numeric) or scheme://owner (host-only, no repo segment)
		numberPart = host;
	} else if (parts[0] === "diff" && parsePositiveDecimalInt(host) !== undefined) {
		// <scheme>://N/diff[/<sub>] — short form with diff suffix. Restrict this
		// ambiguity to numeric hosts so `<scheme>://owner/diff` remains the valid
		// repo-scoped listing for a repository named `diff`. `issue://` falls
		// through to the `scheme === "issue"` branch below for the "issues have
		// no diff" rejection rather than being misparsed as repo `<N>/diff`.
		numberPart = host;
		diffParts = parts;
	} else if (host && parts.length === 1) {
		// scheme://owner/repo  → list
		repo = `${host}/${parts[0]}`;
		return parseListOptions(url, scheme, repo);
	} else if (host && parts.length >= 2) {
		// scheme://owner/repo/N[/diff[/<sub>]]
		repo = `${host}/${parts[0]}`;
		numberPart = parts[1];
		diffParts = parts.slice(2);
	} else {
		throw new Error(
			`Invalid ${scheme}:// URL. Expected ${scheme}://, ${scheme}://<number>, ${scheme}://<owner>/<repo>, or ${scheme}://<owner>/<repo>/<number>`,
		);
	}

	// Reject unrecognized trailing segments before parsing the number so
	// shapes like `issue://owner/repo/foo/bar` surface as "Invalid URL"
	// rather than the misleading "Invalid number: foo".
	if (diffParts.length > 0) {
		if (scheme === "issue") {
			throw new Error(
				`Invalid issue:// URL. Issue views do not have a diff; use pr://<owner>/<repo>/<n>/diff for pull requests.`,
			);
		}
		if (diffParts[0] !== "diff" || diffParts.length > 2) {
			throw new Error(
				`Invalid pr:// URL. Expected pr://<n>, pr://<n>/diff, pr://<n>/diff/all, or pr://<n>/diff/<i>`,
			);
		}
	}

	const num = parsePositiveDecimalInt(numberPart);
	if (num === undefined) {
		throw new Error(`Invalid ${scheme}:// number: ${numberPart ?? "(missing)"}`);
	}

	if (diffParts.length === 0) {
		const commentsParam = url.searchParams.get("comments");
		const comments =
			commentsParam === null ? true : !(commentsParam === "0" || commentsParam.toLowerCase() === "false");
		return { kind: "single", repo, number: num, comments };
	}

	// diffParts has already been validated above; scheme is `pr`.
	if (diffParts.length === 1) {
		return { kind: "pr-diff", repo, number: num, mode: "list" };
	}
	const sub = diffParts[1] ?? "";
	if (sub === "all") {
		return { kind: "pr-diff", repo, number: num, mode: "all" };
	}
	const idx = parsePositiveDecimalInt(sub);
	if (idx === undefined) {
		throw new Error(`Invalid pr:// diff sub-path '${sub}'. Use 'all' or a 1-indexed file number.`);
	}
	return { kind: "pr-diff", repo, number: num, mode: "slice", index: idx };
}

/**
 * Resolve the working directory the protocol should use.
 *
 * Order:
 * 1. Caller-supplied `context.cwd` (the session that initiated `read`).
 * 2. First registered session via `AgentRegistry` (single-session fallback).
 * 3. `process.cwd()` (last resort).
 *
 * The earlier-fallback drives `gh repo view` and any `gh issue list` /
 * `gh pr list` for short-form URLs, so getting this right is what keeps
 * reads of `issue://N` from picking the wrong repo across concurrent sessions.
 */
function resolveCwd(context: ResolveContext | undefined): string {
	if (context?.cwd) return context.cwd;
	for (const ref of AgentRegistry.global().list()) {
		const cwd = ref.session?.sessionManager?.getCwd();
		if (cwd) return cwd;
	}
	return process.cwd();
}

function settingsFromContext(context: ResolveContext | undefined): Settings | undefined {
	const raw = context?.settings;
	if (!raw || typeof raw !== "object") return undefined;
	if (typeof (raw as { get?: unknown }).get !== "function") return undefined;
	return raw as Settings;
}

function cleanGitlabRepoPath(value: string): string | undefined {
	let repo = value.trim();
	const queryStart = repo.search(/[?#]/);
	if (queryStart >= 0) repo = repo.slice(0, queryStart);
	repo = repo.replace(/^\/+/, "").replace(/\/+$/, "");
	if (repo.endsWith(".git")) repo = repo.slice(0, -4);
	if (!repo?.includes("/")) return undefined;
	try {
		repo = repo
			.split("/")
			.map(segment => decodeURIComponent(segment))
			.join("/");
	} catch {
		return undefined;
	}
	return repo;
}

function parseGitLabRemoteUrl(remoteUrl: string): ParsedGitRemote | undefined {
	const trimmed = remoteUrl.trim();
	if (!trimmed) return undefined;
	let host = "";
	let repo: string | undefined;
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
		try {
			const parsed = new URL(trimmed);
			host = normalizeGitlabHost(parsed.hostname);
			repo = cleanGitlabRepoPath(parsed.pathname);
		} catch {
			return undefined;
		}
	} else {
		const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
		if (!scpMatch) return undefined;
		host = normalizeGitlabHost(scpMatch[1] ?? "");
		repo = cleanGitlabRepoPath(scpMatch[2] ?? "");
	}
	if (!host || !repo) return undefined;
	const configuredHost = normalizeGitlabHost(process.env.GITLAB_HOST || process.env.GITLAB_URI || "");
	const isGitlabHost = host.includes("gitlab") || (configuredHost !== "" && host === configuredHost);
	if (!isGitlabHost) return undefined;
	return { backend: "gitlab", host, repo };
}

async function resolveGitLabRemote(
	cwd: string,
	parsedRepo: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ host: string; repo: string } | undefined> {
	try {
		const remoteNames = await git.remote.list(cwd, signal);
		const orderedNames = [
			"origin",
			"upstream",
			...remoteNames.filter(name => name !== "origin" && name !== "upstream"),
		].filter((name, index, names) => remoteNames.includes(name) && names.indexOf(name) === index);
		for (const remoteName of orderedNames) {
			let remoteUrl: string | undefined;
			try {
				remoteUrl = await git.remote.url(cwd, remoteName, signal);
			} catch {
				continue;
			}
			const remote = remoteUrl ? parseGitLabRemoteUrl(remoteUrl) : undefined;
			if (!remote) continue;
			if (parsedRepo && remote.repo.toLowerCase() !== parsedRepo.toLowerCase()) continue;
			return { host: remote.host, repo: remote.repo };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function resolveBackend(
	scheme: Scheme,
	parsedRepo: string | undefined,
	context: ResolveContext | undefined,
	usageHint: string = `${scheme}://<owner>/<repo>`,
): Promise<IssuePrBackend> {
	const cwd = resolveCwd(context);
	const gitlabRemote = await resolveGitLabRemote(cwd, parsedRepo, context?.signal);
	if (gitlabRemote) return { kind: "gitlab", host: gitlabRemote.host, repo: gitlabRemote.repo };
	if (parsedRepo) return { kind: "github", repo: parsedRepo };
	try {
		return { kind: "github", repo: await resolveDefaultRepoMemoized(cwd, context?.signal) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`${scheme}:// could not resolve a default repo from the current session: ${message}\nUse ${usageHint} instead.`,
		);
	}
}

interface IssueListItem {
	number?: number;
	title?: string;
	state?: string;
	stateReason?: string | null;
	author?: { login?: string } | null;
	labels?: Array<{ name?: string }>;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
}

interface PrListItem extends IssueListItem {
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
}

function supportsExplicitInternalRepo(repo: string): boolean {
	return repo.split("/").filter(Boolean).length === 2;
}

function formatItemUrl(scheme: Scheme, repo: string, number: string | number): string {
	if (supportsExplicitInternalRepo(repo)) return `${scheme}://${repo}/${number}`;
	return `${scheme}://${number}`;
}

function formatListRootUrl(scheme: Scheme, repo: string): string {
	return supportsExplicitInternalRepo(repo) ? `${scheme}://${repo}` : `${scheme}://`;
}

function formatListItemUrl(scheme: Scheme, repo: string, number: string): string {
	return number === "?" ? formatListRootUrl(scheme, repo) : formatItemUrl(scheme, repo, number);
}

function formatSpecificItemFooter(scheme: Scheme, repo: string): string {
	if (supportsExplicitInternalRepo(repo)) {
		return `\n\n---\nRead a specific item: \`${scheme}://${repo}/<N>\` (or \`${scheme}://<N>\` for the current repo).`;
	}
	return `\n\n---\nRead a specific item in the current GitLab checkout: \`${scheme}://<N>\`.`;
}

function formatPrDiffUrl(repo: string | undefined, prNumber: number): string {
	const itemUrl = repo ? formatItemUrl("pr", repo, prNumber) : `pr://${prNumber}`;
	return `${itemUrl}/diff`;
}

function formatPrDiffUsageHint(parsed: ParsedPrDiff): string {
	if (parsed.mode === "all") return `pr://<owner>/<repo>/${parsed.number}/diff/all`;
	if (parsed.mode === "slice") return `pr://<owner>/<repo>/${parsed.number}/diff/${parsed.index ?? "<i>"}`;
	return `pr://<owner>/<repo>/${parsed.number}/diff`;
}

function formatListItem(scheme: Scheme, repo: string, item: IssueListItem | PrListItem): string {
	const number = item.number ?? "?";
	const title = item.title ?? "(no title)";
	const state = item.state?.toLowerCase() ?? "?";
	const author = item.author?.login ?? "?";
	const updated = item.updatedAt ?? item.createdAt ?? "";
	const draftSuffix = scheme === "pr" && (item as PrListItem).isDraft ? " [draft]" : "";
	const labels = (item.labels ?? [])
		.map(l => l.name)
		.filter(Boolean)
		.join(", ");
	const labelSuffix = labels ? `  labels: ${labels}` : "";
	const itemUrl = formatListItemUrl(scheme, repo, String(number));
	return `- [${state}${draftSuffix}] #${number}  @${author}  ${updated}\n    ${title}${labelSuffix}\n    ${itemUrl}`;
}

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function readGitlabListString(value: unknown, keys: readonly string[]): string | undefined {
	const record = asJsonRecord(value);
	if (!record) return undefined;
	for (const key of keys) {
		const raw = record[key];
		if (typeof raw === "string") {
			const trimmed = raw.trim();
			if (trimmed) return trimmed;
		}
		if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
		if (typeof raw === "boolean") return String(raw);
	}
	return undefined;
}

function formatGitlabListUser(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	return readGitlabListString(value, ["username", "login", "name"]);
}

function formatGitlabListLabels(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (!Array.isArray(value)) return undefined;
	const labels = value
		.map(label => (typeof label === "string" ? label : readGitlabListString(label, ["name", "title"])))
		.filter((label): label is string => Boolean(label));
	return labels.length > 0 ? labels.join(", ") : undefined;
}

function extractGitlabListItems(data: unknown): unknown[] {
	if (Array.isArray(data)) return data;
	const record = asJsonRecord(data);
	if (!record) return [];
	for (const key of ["items", "data", "issues", "merge_requests", "mergeRequests"]) {
		const raw = record[key];
		if (Array.isArray(raw)) return raw;
	}
	return [];
}

function formatGitlabListItem(scheme: Scheme, repo: string, item: unknown): string {
	const record = asJsonRecord(item);
	const number = readGitlabListString(item, ["iid", "number", "id"]) ?? "?";
	const title = readGitlabListString(item, ["title"]) ?? "(no title)";
	const state = readGitlabListString(item, ["state"])?.toLowerCase() ?? "?";
	const author = formatGitlabListUser(record?.author) ?? "?";
	const labels = formatGitlabListLabels(record?.labels);
	const updated = readGitlabListString(item, ["updated_at", "updatedAt", "created_at", "createdAt"]) ?? "";
	const sourceUrl = readGitlabListString(item, ["web_url", "webUrl", "url"]);
	const labelSuffix = labels ? `  labels: ${labels}` : "";
	const itemUrl = formatListItemUrl(scheme, repo, number);
	const sourceLine = sourceUrl ? `\n    ${sourceUrl}` : "";
	const numberPrefix = scheme === "pr" ? "!" : "#";
	return `- [${state}] ${numberPrefix}${number}  @${author}  ${updated}\n    ${title}${labelSuffix}\n    ${itemUrl}${sourceLine}`;
}

function appendGitlabListState(args: string[], scheme: Scheme, state: ParsedList["state"]): void {
	if (state === "open") return;
	if (state === "all") {
		args.push("--all");
		return;
	}
	if (state === "closed") {
		args.push("--closed");
		return;
	}
	if (scheme === "pr" && state === "merged") args.push("--merged");
}

async function fetchAndRenderList(
	scheme: Scheme,
	options: ParsedList,
	url: InternalUrl,
	context: ResolveContext | undefined,
): Promise<InternalResource> {
	const backend = await resolveBackend(scheme, options.repo, context);
	const cwd = resolveCwd(context);
	if (backend.kind === "gitlab") {
		const args =
			scheme === "issue"
				? ["issue", "list", "--output", "json", "--repo", backend.repo]
				: ["mr", "list", "--output", "json", "--repo", backend.repo];
		appendGitlabListState(args, scheme, options.state);
		if (options.author) args.push("--author", options.author);
		if (options.label) args.push("--label", options.label);
		args.push("--per-page", String(options.limit));
		const data = await git.gitlab.json<unknown>(cwd, args, context?.signal, { repoProvided: true });
		const items = extractGitlabListItems(data);
		const header =
			scheme === "issue"
				? `# GitLab Issues in ${backend.repo} (${options.state}, up to ${options.limit})`
				: `# GitLab Merge Requests in ${backend.repo} (${options.state}, up to ${options.limit})`;
		const body =
			items.length === 0
				? "_No matches._"
				: items.map(item => formatGitlabListItem(scheme, backend.repo, item)).join("\n\n");
		const footer = formatSpecificItemFooter(scheme, backend.repo);
		const rendered = `${header}\n\n${body}${footer}`;
		return {
			url: url.href,
			content: rendered,
			contentType: "text/markdown",
			size: Buffer.byteLength(rendered, "utf-8"),
			notes: [`Live listing for ${backend.repo}`],
		};
	}

	const repo = backend.repo;
	const fields =
		scheme === "issue"
			? ["number", "title", "state", "author", "labels", "createdAt", "updatedAt", "url"]
			: [
					"number",
					"title",
					"state",
					"isDraft",
					"author",
					"baseRefName",
					"headRefName",
					"labels",
					"createdAt",
					"updatedAt",
					"url",
				];
	const args = [
		scheme,
		"list",
		"--repo",
		repo,
		"--state",
		options.state,
		"--limit",
		String(options.limit),
		"--json",
		fields.join(","),
	];
	if (options.author) args.push("--author", options.author);
	if (options.label) args.push("--label", options.label);

	const items =
		scheme === "issue"
			? await githubIssueJsonWithStateReasonFallback<Array<IssueListItem>>(cwd, args, context?.signal, {
					repoProvided: true,
				})
			: await git.github.json<Array<PrListItem>>(cwd, args, context?.signal, {
					repoProvided: true,
				});
	const header =
		scheme === "issue"
			? `# Issues in ${repo} (${options.state}, up to ${options.limit})`
			: `# Pull Requests in ${repo} (${options.state}, up to ${options.limit})`;
	const body =
		items.length === 0 ? "_No matches._" : items.map(item => formatListItem(scheme, repo, item)).join("\n\n");
	const footer = formatSpecificItemFooter(scheme, repo);
	const rendered = `${header}\n\n${body}${footer}`;

	return {
		url: url.href,
		content: rendered,
		contentType: "text/markdown",
		size: Buffer.byteLength(rendered, "utf-8"),
		notes: [`Live listing for ${repo}`],
	};
}

interface BuildSingleArgs {
	url: InternalUrl;
	scheme: Scheme;
	parsed: ParsedSingle;
	rendered: string;
	status: CacheStatus;
	fetchedAt: number;
	backendLabel: "GitHub" | "GitLab";
	/** Resolved repo (post short-form expansion) — used for the PR-only diff hint. */
	repo?: string;
}

function buildSingleResource({
	url,
	scheme,
	parsed,
	rendered,
	status,
	fetchedAt,
	backendLabel,
	repo,
}: BuildSingleArgs): InternalResource {
	const notes: string[] = [formatFreshnessNote(status, fetchedAt)];
	if (!parsed.comments) notes.push("Comments disabled");
	if (scheme === "pr") {
		const diffUrl = formatPrDiffUrl(repo ?? parsed.repo, parsed.number);
		notes.push(`Diff: ${diffUrl}`);
	}
	const content =
		status === "stale"
			? `> WARNING: Live ${backendLabel} refresh failed; this ${scheme} content is cached and may be stale.\n\n${rendered}`
			: rendered;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes,
	};
}

function formatFileLine(idx: number, file: PrDiffFile, repo: string, prNumber: number): string {
	const stats = file.changeType === "binary" ? "(binary)" : `+${file.additions} -${file.deletions}`;
	const rename = file.oldPath ? `  (renamed from ${file.oldPath})` : "";
	return `${idx}. ${file.path}  ${stats}  [${file.changeType}]${rename}\n   ${formatPrDiffUrl(repo, prNumber)}/${idx}`;
}

async function fetchAndRenderPrDiff(
	url: InternalUrl,
	parsed: ParsedPrDiff,
	context: ResolveContext | undefined,
): Promise<InternalResource> {
	const cwd = resolveCwd(context);
	const backend = await resolveBackend("pr", parsed.repo, context, formatPrDiffUsageHint(parsed));
	const repo = backend.repo;
	const lookup =
		backend.kind === "gitlab"
			? await getOrFetchGitlabMrDiff({
					cwd,
					host: backend.host,
					repo,
					number: parsed.number,
					signal: context?.signal,
					settings: settingsFromContext(context),
				})
			: await getOrFetchPrDiff({
					cwd,
					repo,
					number: parsed.number,
					signal: context?.signal,
					settings: settingsFromContext(context),
				});
	const files = lookup.payload.files;
	const freshness = formatFreshnessNote(lookup.status, lookup.fetchedAt);

	if (parsed.mode === "all") {
		const content = lookup.payload.unified;
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [
				freshness,
				`Full diff for ${formatItemUrl("pr", repo, parsed.number)} (${files.length} file${files.length === 1 ? "" : "s"})`,
			],
		};
	}

	if (parsed.mode === "slice") {
		const index = parsed.index ?? 0;
		if (index < 1 || index > files.length) {
			throw new Error(
				`${formatPrDiffUrl(repo, parsed.number)}/${index} is out of range; PR has ${files.length} file${files.length === 1 ? "" : "s"}. Use ${formatPrDiffUrl(repo, parsed.number)} to list available indices.`,
			);
		}
		const file = files[index - 1];
		if (!file) {
			throw new Error(`${formatPrDiffUrl(repo, parsed.number)}/${index} resolved to a missing slice (parser bug).`);
		}
		const content = lookup.payload.unified.slice(file.startOffset, file.endOffset);
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [
				freshness,
				`Showing file ${index}/${files.length}: ${file.path}`,
				`Read all: ${formatPrDiffUrl(repo, parsed.number)}/all`,
			],
		};
	}

	// mode === "list"
	const header = `# Pull Request Diff: ${repo}#${parsed.number} (${files.length} file${files.length === 1 ? "" : "s"})`;
	const body =
		files.length === 0
			? "_No file changes._"
			: files.map((f, i) => formatFileLine(i + 1, f, repo, parsed.number)).join("\n\n");
	const footer = `\n\n---\nRead all: \`${formatPrDiffUrl(repo, parsed.number)}/all\`. Each file is also available as \`${formatPrDiffUrl(repo, parsed.number)}/<i>\`.`;
	const content = `${header}\n\n${body}${footer}`;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [freshness, `File listing for ${formatItemUrl("pr", repo, parsed.number)}`],
	};
}

/**
 * Handler for `issue://` URLs.
 */
export class IssueProtocolHandler implements ProtocolHandler {
	readonly scheme = "issue";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) {
			throw new Error("aborted");
		}
		const parsed = parseUrl(url, "issue");
		if (parsed.kind === "list") {
			try {
				return await fetchAndRenderList("issue", parsed, url, context);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`issue:// listing failed: ${message}`);
			}
		}
		// parseUrl already rejects `issue://.../diff`; this guard is a belt-and-
		// suspenders catch in case the union grows.
		if (parsed.kind !== "single") {
			throw new Error(`Invalid issue:// URL: unexpected variant '${parsed.kind}'`);
		}
		try {
			const cwd = resolveCwd(context);
			const backend = await resolveBackend("issue", parsed.repo, context, `issue://<owner>/<repo>/${parsed.number}`);
			const lookup =
				backend.kind === "gitlab"
					? await getOrFetchGitlabIssue({
							cwd,
							host: backend.host,
							repo: backend.repo,
							issue: String(parsed.number),
							includeComments: parsed.comments,
							signal: context?.signal,
							settings: settingsFromContext(context),
						})
					: await getOrFetchIssue({
							cwd,
							repo: backend.repo,
							issue: String(parsed.number),
							includeComments: parsed.comments,
							signal: context?.signal,
							settings: settingsFromContext(context),
						});
			return buildSingleResource({
				url,
				scheme: "issue",
				parsed,
				rendered: lookup.rendered,
				status: lookup.status,
				fetchedAt: lookup.fetchedAt,
				backendLabel: backend.kind === "gitlab" ? "GitLab" : "GitHub",
				repo: backend.repo,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`issue:// resolution failed: ${message}`);
		}
	}
}

/**
 * Handler for `pr://` URLs.
 */
export class PrProtocolHandler implements ProtocolHandler {
	readonly scheme = "pr";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) {
			throw new Error("aborted");
		}
		const parsed = parseUrl(url, "pr");
		if (parsed.kind === "list") {
			try {
				return await fetchAndRenderList("pr", parsed, url, context);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`pr:// listing failed: ${message}`);
			}
		}
		if (parsed.kind === "pr-diff") {
			try {
				return await fetchAndRenderPrDiff(url, parsed, context);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`pr:// diff resolution failed: ${message}`);
			}
		}
		const cwd = resolveCwd(context);
		try {
			const backend = await resolveBackend("pr", parsed.repo, context, `pr://<owner>/<repo>/${parsed.number}`);
			const lookup =
				backend.kind === "gitlab"
					? await getOrFetchGitlabMr({
							cwd,
							host: backend.host,
							repo: backend.repo,
							number: parsed.number,
							includeComments: parsed.comments,
							signal: context?.signal,
							settings: settingsFromContext(context),
						})
					: await getOrFetchPr({
							cwd,
							repo: backend.repo,
							number: parsed.number,
							includeComments: parsed.comments,
							signal: context?.signal,
							settings: settingsFromContext(context),
						});
			return buildSingleResource({
				url,
				scheme: "pr",
				parsed,
				rendered: lookup.rendered,
				status: lookup.status,
				fetchedAt: lookup.fetchedAt,
				backendLabel: backend.kind === "gitlab" ? "GitLab" : "GitHub",
				repo: backend.repo,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`pr:// resolution failed: ${message}`);
		}
	}
}
