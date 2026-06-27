import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { Settings } from "../config/settings";
import gitlabDescription from "../prompts/tools/gitlab.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { type PrDiffPayload, parsePrUnifiedDiff, type ViewLookupResult } from "./gh";
import { getOrFetchView, normalizeGitlabHost, resolveGitlabCacheAuthKey } from "./github-cache";
import type { OutputMeta } from "./output-meta";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const gitlabSchema = type({
	op: type("'mr_create' | 'mr_checkout'").describe("gitlab operation"),
	"repo?": type("string").describe("group/project, full URL, or Git URL"),
	"branch?": type("string").describe("branch or ref"),
	"mr?": type("string").describe("merge request id, URL, or branch"),
	"label?": type("string[]").describe("labels"),
	"assignee?": type("string[]").describe("assignees"),
	"reviewer?": type("string[]").describe("reviewers"),
	"sourceBranch?": type("string").describe("merge request source branch"),
	"targetBranch?": type("string").describe("merge request target branch"),
	"title?": type("string").describe("merge request title"),
	"body?": type("string").describe("merge request description"),
	"base?": type("string").describe("target branch alias"),
	"head?": type("string").describe("source branch alias"),
	"draft?": type("boolean").describe("create draft merge request"),
	"fill?": type("boolean").describe("auto-fill merge request from commits"),
	"force?": type("boolean").describe("force checkout reset"),
});

type GitlabInput = typeof gitlabSchema.infer;

export interface GitlabToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	mrId?: string;
	url?: string;
}

export interface GitlabIssueViewLookupOptions {
	cwd: string;
	host: string;
	repo: string;
	issue: string;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface GitlabMrViewLookupOptions {
	cwd: string;
	host: string;
	repo: string;
	number: number;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface GitlabMrDiffLookupOptions {
	cwd: string;
	host: string;
	repo: string;
	number: number;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function requireSafePositional(value: string, label: string): string {
	if (value.startsWith("-")) throw new ToolError(`${label} must not start with '-'`);
	return value;
}

function readString(value: unknown, keys: readonly string[]): string | undefined {
	const record = asRecord(value);
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

function formatUser(value: unknown): string | undefined {
	if (typeof value === "string") return normalizeOptionalString(value);
	return readString(value, ["username", "login", "name"]);
}

function formatUsers(value: unknown): string | undefined {
	if (!Array.isArray(value)) return formatUser(value);
	const users = value.map(formatUser).filter((user): user is string => Boolean(user));
	return users.length > 0 ? users.join(", ") : undefined;
}

function formatLabels(value: unknown): string | undefined {
	if (typeof value === "string") return normalizeOptionalString(value);
	if (!Array.isArray(value)) return undefined;
	const labels = value
		.map(label => (typeof label === "string" ? label : readString(label, ["name", "title"])))
		.filter((label): label is string => Boolean(label));
	return labels.length > 0 ? labels.join(", ") : undefined;
}

function pushLine(lines: string[], label: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") return;
	lines.push(`${label}: ${value}`);
}

function appendBody(lines: string[], value: string | undefined): void {
	const body = normalizeOptionalString(value);
	if (!body) return;
	lines.push("", body);
}

function sourceUrlOf(data: unknown): string | undefined {
	return readString(data, ["web_url", "webUrl", "url", "http_url_to_repo", "httpUrlToRepo"]);
}

function appendGitlabComments(lines: string[], comments: unknown[]): void {
	if (comments.length === 0) return;
	lines.push("", `## Comments (${comments.length})`);
	for (const comment of comments) {
		const record = asRecord(comment);
		const author = formatUser(record?.author) ?? "?";
		const created = readString(comment, ["created_at", "createdAt", "created"]) ?? "?";
		lines.push("", `### @${author} - ${created}`);
		const body = readString(comment, ["body"]);
		if (body) lines.push("", body);
	}
}

function extractGitlabIssueComments(data: unknown): unknown[] {
	const record = asRecord(data);
	const notes = record?.Notes ?? record?.notes;
	return Array.isArray(notes) ? notes : [];
}

function extractGitlabMrComments(data: unknown): unknown[] {
	const record = asRecord(data);
	const discussions = record?.Discussions ?? record?.discussions;
	if (!Array.isArray(discussions)) return [];
	const comments: unknown[] = [];
	for (const discussion of discussions) {
		const discussionRecord = asRecord(discussion);
		const notes = discussionRecord?.notes ?? discussionRecord?.Notes;
		if (Array.isArray(notes)) comments.push(...notes);
	}
	return comments;
}

export function formatGitlabIssueView(data: unknown): string {
	const number = readString(data, ["iid", "number", "id"]);
	const title = readString(data, ["title"]);
	const lines = [`# GitLab issue ${number ? `#${number}` : ""}${title ? `: ${title}` : ""}`.trimEnd()];
	pushLine(lines, "State", readString(data, ["state"]));
	pushLine(lines, "Author", formatUser(asRecord(data)?.author));
	pushLine(lines, "Assignees", formatUsers(asRecord(data)?.assignees));
	pushLine(lines, "Labels", formatLabels(asRecord(data)?.labels));
	pushLine(lines, "Created", readString(data, ["created_at", "createdAt"]));
	pushLine(lines, "Updated", readString(data, ["updated_at", "updatedAt"]));
	pushLine(lines, "URL", sourceUrlOf(data));
	appendBody(lines, readString(data, ["description", "body"]));
	appendGitlabComments(lines, extractGitlabIssueComments(data));
	return lines.join("\n");
}

export function formatGitlabMergeRequestView(data: unknown, heading = "GitLab merge request"): string {
	const number = readString(data, ["iid", "number", "id"]);
	const title = readString(data, ["title"]);
	const lines = [`# ${heading} ${number ? `!${number}` : ""}${title ? `: ${title}` : ""}`.trimEnd()];
	pushLine(lines, "State", readString(data, ["state"]));
	pushLine(lines, "Draft", readString(data, ["draft", "work_in_progress", "workInProgress"]));
	pushLine(lines, "Author", formatUser(asRecord(data)?.author));
	pushLine(lines, "Assignees", formatUsers(asRecord(data)?.assignees));
	pushLine(lines, "Reviewers", formatUsers(asRecord(data)?.reviewers));
	pushLine(lines, "Labels", formatLabels(asRecord(data)?.labels));
	pushLine(lines, "Source", readString(data, ["source_branch", "sourceBranch"]));
	pushLine(lines, "Target", readString(data, ["target_branch", "targetBranch"]));
	pushLine(lines, "Created", readString(data, ["created_at", "createdAt"]));
	pushLine(lines, "Updated", readString(data, ["updated_at", "updatedAt"]));
	pushLine(lines, "URL", sourceUrlOf(data));
	appendBody(lines, readString(data, ["description", "body"]));
	appendGitlabComments(lines, extractGitlabMrComments(data));
	return lines.join("\n");
}

function gitlabCacheRepoKey(host: string, repo: string): string {
	return `gitlab:${normalizeGitlabHost(host)}/${repo}`;
}

function requirePositiveNumber(value: string | number, label: string): number {
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(number) || number <= 0) throw new ToolError(`${label} must be a positive number`);
	return number;
}

export async function getOrFetchGitlabIssue(options: GitlabIssueViewLookupOptions): Promise<ViewLookupResult<unknown>> {
	const includeComments = options.includeComments ?? true;
	const issueNumber = requirePositiveNumber(options.issue, "issue");
	const authKey =
		options.cacheAuthKey === undefined ? (resolveGitlabCacheAuthKey(options.host) ?? null) : options.cacheAuthKey;
	const doFetch = async () => {
		const args = includeComments
			? [
					"issue",
					"view",
					options.issue,
					"--output",
					"json",
					"--comments",
					"--per-page",
					"100",
					"--repo",
					options.repo,
				]
			: ["issue", "view", options.issue, "--output", "json", "--repo", options.repo];
		const data = await git.gitlab.json<unknown>(options.cwd, args, options.signal, { repoProvided: true });
		return { rendered: formatGitlabIssueView(data), sourceUrl: sourceUrlOf(data), payload: data };
	};
	const lookup = await getOrFetchView<unknown>({
		repo: gitlabCacheRepoKey(options.host, options.repo),
		kind: "issue",
		number: issueNumber,
		includeComments,
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

export async function getOrFetchGitlabMr(options: GitlabMrViewLookupOptions): Promise<ViewLookupResult<unknown>> {
	const includeComments = options.includeComments ?? true;
	const authKey =
		options.cacheAuthKey === undefined ? (resolveGitlabCacheAuthKey(options.host) ?? null) : options.cacheAuthKey;
	const doFetch = async () => {
		const args = includeComments
			? [
					"mr",
					"view",
					String(options.number),
					"--output",
					"json",
					"--comments",
					"--per-page",
					"100",
					"--repo",
					options.repo,
				]
			: ["mr", "view", String(options.number), "--output", "json", "--repo", options.repo];
		const data = await git.gitlab.json<unknown>(options.cwd, args, options.signal, { repoProvided: true });
		return { rendered: formatGitlabMergeRequestView(data), sourceUrl: sourceUrlOf(data), payload: data };
	};
	const lookup = await getOrFetchView<unknown>({
		repo: gitlabCacheRepoKey(options.host, options.repo),
		kind: "pr",
		number: options.number,
		includeComments,
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

export async function getOrFetchGitlabMrDiff(
	options: GitlabMrDiffLookupOptions,
): Promise<ViewLookupResult<PrDiffPayload>> {
	const authKey =
		options.cacheAuthKey === undefined ? (resolveGitlabCacheAuthKey(options.host) ?? null) : options.cacheAuthKey;
	const doFetch = async () => {
		const args = ["mr", "diff", String(options.number), "--color=never", "--raw", "--repo", options.repo];
		const text = await git.gitlab.text(options.cwd, args, options.signal, { repoProvided: true, trimOutput: false });
		const payload = parsePrUnifiedDiff(text);
		return { rendered: text, sourceUrl: undefined, payload: { unified: "", files: payload.files } };
	};
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: gitlabCacheRepoKey(options.host, options.repo),
		kind: "pr-diff",
		number: options.number,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: { unified: lookup.rendered, files: lookup.payload.files },
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

function buildTextResult(
	text: string,
	sourceUrl?: string,
	details?: GitlabToolDetails,
): AgentToolResult<GitlabToolDetails> {
	const builder = toolResult<GitlabToolDetails>(details).text(text);
	if (sourceUrl) builder.sourceUrl(sourceUrl);
	return builder.done();
}

function appendRepoFlag(args: string[], repo: string | undefined): void {
	if (repo) args.push("--repo", repo);
}

function normalizeStringList(values: string[] | undefined): string[] {
	return values?.map(value => value.trim()).filter(Boolean) ?? [];
}

function appendCsvFlag(args: string[], flag: string, values: string[] | undefined): void {
	const normalized = normalizeStringList(values);
	if (normalized.length > 0) args.push(flag, normalized.join(","));
}

function appendScalarFlag(args: string[], flag: string, value: string | undefined): void {
	if (value) args.push(flag, value);
}

function extractMrIdFromCreateOutput(output: string): string | undefined {
	return output.match(/\/-\/merge_requests\/(\d+)/)?.[1] ?? output.match(/!(\d+)\b/)?.[1];
}

export class GitlabTool implements AgentTool<typeof gitlabSchema, GitlabToolDetails> {
	readonly name = "gitlab";
	readonly approval = "exec" as const;
	readonly summary = "Create and checkout GitLab merge requests";
	readonly loadMode = "discoverable";
	readonly label = "GitLab";
	readonly description = prompt.render(gitlabDescription);
	readonly parameters = gitlabSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GitlabTool | null {
		if (!git.gitlab.available()) return null;
		return new GitlabTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GitlabInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GitlabToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GitlabToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "mr_create":
					return executeMrCreate(this.session, params, signal);
				case "mr_checkout":
					return executeMrCheckout(this.session, params, signal);
			}
		});
	}
}

async function executeMrCreate(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const title = normalizeOptionalString(params.title);
	const body = params.body ?? "";
	const fill = params.fill ?? false;
	if (!fill && !title) throw new ToolError("title is required unless fill is true");
	if (fill && (title || params.body !== undefined)) {
		throw new ToolError("fill is mutually exclusive with title and body");
	}
	if (!fill && body === "-") throw new ToolError("body must not be '-'");

	const args = ["mr", "create", "--yes"];
	appendRepoFlag(args, repo);
	if (fill) {
		args.push("--fill");
	} else {
		args.push("--title", title ?? "", "--description", body);
	}
	appendScalarFlag(args, "--source-branch", normalizeOptionalString(params.sourceBranch ?? params.head));
	appendScalarFlag(args, "--target-branch", normalizeOptionalString(params.targetBranch ?? params.base));
	appendCsvFlag(args, "--assignee", params.assignee);
	appendCsvFlag(args, "--reviewer", params.reviewer);
	appendCsvFlag(args, "--label", params.label);
	if (params.draft) args.push("--draft");

	const output = await git.gitlab.text(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	const mrId = extractMrIdFromCreateOutput(output);
	if (mrId) {
		try {
			const viewArgs = ["mr", "view", mrId, "--output", "json"];
			appendRepoFlag(viewArgs, repo);
			const data = await git.gitlab.json<unknown>(session.cwd, viewArgs, signal, { repoProvided: Boolean(repo) });
			const sourceUrl = sourceUrlOf(data) ?? sourceUrlOf({ web_url: output.match(/https?:\/\/\S+/)?.[0] });
			return buildTextResult(formatGitlabMergeRequestView(data, "Created GitLab merge request"), sourceUrl, {
				repo,
				mrId,
				url: sourceUrl,
			});
		} catch (err) {
			if (signal?.aborted || err instanceof ToolAbortError) throw err;
			// Creation already succeeded; keep the useful URL instead of failing the whole tool on a follow-up view miss.
		}
	}
	const sourceUrl = output.match(/https?:\/\/\S+/)?.[0];
	return buildTextResult(`# Created GitLab merge request\n${output}`, sourceUrl, { repo, mrId, url: sourceUrl });
}

async function executeMrCheckout(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const mr = normalizeOptionalString(params.mr);
	const branch = normalizeOptionalString(params.branch);
	const args = ["mr", "checkout"];
	if (mr) args.push(requireSafePositional(mr, "mr"));
	appendScalarFlag(args, "--branch", branch);
	if (params.force) args.push("--force");
	appendRepoFlag(args, repo);
	const output = await git.gitlab.text(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	return buildTextResult(`# GitLab merge request checkout\n${output}`, undefined, { repo, branch, mrId: mr });
}
