import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import gitlabDescription from "../prompts/tools/gitlab.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const GITLAB_READONLY_OPS: Record<string, true> = {
	repo_view: true,
	issue_view: true,
	mr_view: true,
	issue_list: true,
	mr_list: true,
	pipeline_status: true,
	pipeline_list: true,
};

const gitlabSchema = type({
	op: type(
		"'repo_view' | 'issue_view' | 'mr_view' | 'issue_list' | 'mr_list' | 'mr_create' | 'mr_checkout' | 'pipeline_status' | 'pipeline_list'",
	).describe("gitlab operation"),
	"repo?": type("string").describe("group/project, full URL, or Git URL"),
	"branch?": type("string").describe("branch or ref"),
	"issue?": type("string").describe("issue id or URL"),
	"mr?": type("string").describe("merge request id, URL, or branch"),
	"state?": type("'opened' | 'closed' | 'merged' | 'all'").describe("issue or merge request state"),
	"query?": type("string").describe("list search query"),
	"limit?": type("number").describe("max first-page results, capped at 100"),
	"label?": type("string[]").describe("labels"),
	"assignee?": type("string[]").describe("assignees"),
	"reviewer?": type("string[]").describe("reviewers"),
	"author?": type("string").describe("author username"),
	"sourceBranch?": type("string").describe("merge request source branch"),
	"targetBranch?": type("string").describe("merge request target branch"),
	"title?": type("string").describe("merge request title"),
	"body?": type("string").describe("merge request description"),
	"base?": type("string").describe("target branch alias"),
	"head?": type("string").describe("source branch alias"),
	"draft?": type("boolean").describe("create draft merge request"),
	"fill?": type("boolean").describe("auto-fill merge request from commits"),
	"force?": type("boolean").describe("force checkout reset"),
	"status?": type("string").describe("pipeline status filter"),
	"sha?": type("string").describe("commit SHA filter"),
});

type GitlabInput = typeof gitlabSchema.infer;

export interface GitlabToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	issueId?: string;
	mrId?: string;
	status?: string;
	url?: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function requireNonEmpty(value: string | null | undefined, label: string): string {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) throw new ToolError(`${label} is required`);
	return trimmed;
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

function readNumber(value: unknown, keys: readonly string[]): number | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	for (const key of keys) {
		const raw = record[key];
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
		if (typeof raw === "string") {
			const parsed = Number(raw);
			if (Number.isFinite(parsed)) return parsed;
		}
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

function formatRepoView(data: unknown): string {
	const title = readString(data, [
		"path_with_namespace",
		"pathWithNamespace",
		"full_path",
		"fullPath",
		"name_with_owner",
		"name",
		"path",
	]);
	const lines = [`# ${title ?? "GitLab project"}`];
	pushLine(lines, "Description", readString(data, ["description"]));
	pushLine(lines, "URL", sourceUrlOf(data));
	pushLine(lines, "Default branch", readString(data, ["default_branch", "defaultBranch"]));
	pushLine(lines, "Visibility", readString(data, ["visibility"]));
	pushLine(lines, "Stars", readNumber(data, ["star_count", "starCount", "stars"]));
	pushLine(lines, "Forks", readNumber(data, ["forks_count", "forksCount", "forks"]));
	pushLine(lines, "Open issues", readNumber(data, ["open_issues_count", "openIssuesCount"]));
	pushLine(lines, "Archived", readString(data, ["archived"]));
	pushLine(
		lines,
		"Last activity",
		readString(data, ["last_activity_at", "lastActivityAt", "updated_at", "updatedAt"]),
	);
	return lines.join("\n");
}

function formatIssueView(data: unknown): string {
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
	return lines.join("\n");
}

function formatMergeRequestView(data: unknown, heading = "GitLab merge request"): string {
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
	return lines.join("\n");
}

function extractItems(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const record = asRecord(value);
	if (!record) return [];
	for (const key of ["items", "data", "issues", "merge_requests", "mergeRequests", "pipelines"]) {
		const raw = record[key];
		if (Array.isArray(raw)) return raw;
	}
	return [];
}

function formatIssueListItem(item: unknown): string[] {
	const number = readString(item, ["iid", "number", "id"]);
	const title = readString(item, ["title"]) ?? "(untitled)";
	const lines = [`- ${number ? `#${number} ` : ""}${title}`];
	pushLine(lines, "  State", readString(item, ["state"]));
	pushLine(lines, "  Author", formatUser(asRecord(item)?.author));
	pushLine(lines, "  Assignees", formatUsers(asRecord(item)?.assignees));
	pushLine(lines, "  Labels", formatLabels(asRecord(item)?.labels));
	pushLine(lines, "  Updated", readString(item, ["updated_at", "updatedAt"]));
	pushLine(lines, "  URL", sourceUrlOf(item));
	return lines;
}

function formatMrListItem(item: unknown): string[] {
	const number = readString(item, ["iid", "number", "id"]);
	const title = readString(item, ["title"]) ?? "(untitled)";
	const lines = [`- ${number ? `!${number} ` : ""}${title}`];
	pushLine(lines, "  State", readString(item, ["state"]));
	pushLine(lines, "  Draft", readString(item, ["draft", "work_in_progress", "workInProgress"]));
	pushLine(lines, "  Author", formatUser(asRecord(item)?.author));
	pushLine(lines, "  Reviewers", formatUsers(asRecord(item)?.reviewers));
	pushLine(lines, "  Labels", formatLabels(asRecord(item)?.labels));
	pushLine(lines, "  Source", readString(item, ["source_branch", "sourceBranch"]));
	pushLine(lines, "  Target", readString(item, ["target_branch", "targetBranch"]));
	pushLine(lines, "  Updated", readString(item, ["updated_at", "updatedAt"]));
	pushLine(lines, "  URL", sourceUrlOf(item));
	return lines;
}

function formatListResults(
	title: string,
	params: GitlabInput,
	data: unknown,
	itemFormatter: (item: unknown) => string[],
): string {
	const items = extractItems(data);
	const lines = [`# ${title}`];
	pushLine(lines, "Query", normalizeOptionalString(params.query));
	pushLine(lines, "Repository", normalizeOptionalString(params.repo));
	pushLine(lines, "State", normalizeOptionalString(params.state));
	if (items.length === 0) {
		lines.push("", "No results.");
		return lines.join("\n");
	}
	lines.push("");
	for (const item of items) {
		lines.push(...itemFormatter(item));
	}
	return lines.join("\n");
}

function formatPipelineItem(item: unknown): string[] {
	const id = readString(item, ["id", "iid"]);
	const status = readString(item, ["status"]);
	const ref = readString(item, ["ref", "branch"]);
	const sha = readString(item, ["sha"]);
	const lines = [`- ${id ? `#${id}` : "Pipeline"}${status ? ` ${status}` : ""}`];
	pushLine(lines, "  Ref", ref);
	pushLine(lines, "  SHA", sha ? sha.slice(0, 12) : undefined);
	pushLine(lines, "  Updated", readString(item, ["updated_at", "updatedAt"]));
	pushLine(lines, "  URL", sourceUrlOf(item));
	return lines;
}

function formatPipelineStatus(data: unknown, params: GitlabInput): string {
	const items = extractItems(data);
	if (items.length > 0) return formatListResults("GitLab pipeline status", params, items, formatPipelineItem);
	const lines = ["# GitLab pipeline status"];
	pushLine(lines, "Status", readString(data, ["status"]));
	pushLine(lines, "Ref", readString(data, ["ref", "branch"]));
	pushLine(lines, "SHA", readString(data, ["sha"]));
	pushLine(lines, "URL", sourceUrlOf(data));
	return lines.join("\n");
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

function appendSingleStringFlag(args: string[], flag: string, values: string[] | undefined, label: string): void {
	const normalized = normalizeStringList(values);
	if (normalized.length > 1) throw new ToolError(`${label} accepts only one value`);
	const [value] = normalized;
	if (value) args.push(flag, value);
}

function appendScalarFlag(args: string[], flag: string, value: string | undefined): void {
	if (value) args.push(flag, value);
}

function appendLimit(args: string[], limit: number | undefined): void {
	if (limit === undefined) return;
	if (!Number.isFinite(limit) || limit <= 0) throw new ToolError("limit must be a positive number");
	args.push("--per-page", String(Math.floor(Math.min(limit, 100))));
}

function appendIssueState(args: string[], state: GitlabInput["state"]): void {
	if (!state || state === "opened") return;
	if (state === "all") {
		args.push("--all");
		return;
	}
	if (state === "closed") {
		args.push("--closed");
		return;
	}
	throw new ToolError("issue_list does not support state 'merged'");
}

function appendMrState(args: string[], state: GitlabInput["state"]): void {
	if (!state || state === "opened") return;
	if (state === "all") args.push("--all");
	else if (state === "closed") args.push("--closed");
	else if (state === "merged") args.push("--merged");
}

function extractMrIdFromCreateOutput(output: string): string | undefined {
	return output.match(/\/-\/merge_requests\/(\d+)/)?.[1] ?? output.match(/!(\d+)\b/)?.[1];
}

export class GitlabTool implements AgentTool<typeof gitlabSchema, GitlabToolDetails> {
	readonly name = "gitlab";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = (args as Partial<GitlabInput>).op;
		const op = typeof rawOp === "string" ? rawOp : "";
		return GITLAB_READONLY_OPS[op] ? "read" : "exec";
	};
	readonly summary = "Interact with GitLab issues, merge requests, projects, and CI/CD";
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
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "issue_view":
					return executeIssueView(this.session, params, signal);
				case "mr_view":
					return executeMrView(this.session, params, signal);
				case "issue_list":
					return executeIssueList(this.session, params, signal);
				case "mr_list":
					return executeMrList(this.session, params, signal);
				case "mr_create":
					return executeMrCreate(this.session, params, signal);
				case "mr_checkout":
					return executeMrCheckout(this.session, params, signal);
				case "pipeline_status":
					return executePipelineStatus(this.session, params, signal);
				case "pipeline_list":
					return executePipelineList(this.session, params, signal);
			}
		});
	}
}

async function executeRepoView(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["repo", "view"];
	if (repo) args.push(requireSafePositional(repo, "repo"));
	appendScalarFlag(args, "--branch", branch);
	args.push("--output", "json");
	const data = await git.gitlab.json<unknown>(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	const sourceUrl = sourceUrlOf(data);
	return buildTextResult(formatRepoView(data), sourceUrl, { repo, branch, url: sourceUrl });
}

async function executeIssueView(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const issue = requireSafePositional(requireNonEmpty(params.issue, "issue"), "issue");
	const args = ["issue", "view", issue, "--output", "json"];
	appendRepoFlag(args, repo);
	const data = await git.gitlab.json<unknown>(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	const sourceUrl = sourceUrlOf(data);
	return buildTextResult(formatIssueView(data), sourceUrl, { repo, issueId: issue, url: sourceUrl });
}

async function executeMrView(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const mr = requireSafePositional(requireNonEmpty(params.mr, "mr"), "mr");
	const args = ["mr", "view", mr, "--output", "json"];
	appendRepoFlag(args, repo);
	const data = await git.gitlab.json<unknown>(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	const sourceUrl = sourceUrlOf(data);
	return buildTextResult(formatMergeRequestView(data), sourceUrl, { repo, mrId: mr, url: sourceUrl });
}

async function executeIssueList(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const args = ["issue", "list", "--output", "json"];
	appendRepoFlag(args, repo);
	appendIssueState(args, params.state);
	appendScalarFlag(args, "--search", normalizeOptionalString(params.query));
	appendScalarFlag(args, "--author", normalizeOptionalString(params.author));
	appendSingleStringFlag(args, "--assignee", params.assignee, "issue_list assignee");
	appendCsvFlag(args, "--label", params.label);
	appendLimit(args, params.limit);
	const data = await git.gitlab.json<unknown>(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	return buildTextResult(formatListResults("GitLab issues", params, data, formatIssueListItem), undefined, { repo });
}

async function executeMrList(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const args = ["mr", "list", "--output", "json"];
	appendRepoFlag(args, repo);
	appendMrState(args, params.state);
	appendScalarFlag(args, "--search", normalizeOptionalString(params.query));
	appendScalarFlag(args, "--author", normalizeOptionalString(params.author));
	appendCsvFlag(args, "--assignee", params.assignee);
	appendCsvFlag(args, "--reviewer", params.reviewer);
	appendCsvFlag(args, "--label", params.label);
	appendScalarFlag(args, "--source-branch", normalizeOptionalString(params.sourceBranch ?? params.head));
	appendScalarFlag(args, "--target-branch", normalizeOptionalString(params.targetBranch ?? params.base));
	appendLimit(args, params.limit);
	const data = await git.gitlab.json<unknown>(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	return buildTextResult(formatListResults("GitLab merge requests", params, data, formatMrListItem), undefined, {
		repo,
	});
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
			return buildTextResult(formatMergeRequestView(data, "Created GitLab merge request"), sourceUrl, {
				repo,
				mrId,
				url: sourceUrl,
			});
		} catch {
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

async function executePipelineStatus(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["ci", "status", "--output", "json"];
	appendScalarFlag(args, "--branch", branch);
	appendRepoFlag(args, repo);
	const data = await git.gitlab.json<unknown>(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	return buildTextResult(formatPipelineStatus(data, params), sourceUrlOf(data), {
		repo,
		branch,
		status: readString(data, ["status"]),
		url: sourceUrlOf(data),
	});
}

async function executePipelineList(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitlabToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["ci", "list", "--output", "json"];
	appendRepoFlag(args, repo);
	appendScalarFlag(args, "--ref", branch);
	appendScalarFlag(args, "--status", normalizeOptionalString(params.status));
	appendScalarFlag(args, "--sha", normalizeOptionalString(params.sha));
	appendLimit(args, params.limit);
	const data = await git.gitlab.json<unknown>(session.cwd, args, signal, { repoProvided: Boolean(repo) });
	return buildTextResult(formatListResults("GitLab pipelines", params, data, formatPipelineItem), undefined, {
		repo,
		branch,
		status: normalizeOptionalString(params.status),
	});
}
