import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import githubDescription from "../prompts/tools/github.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { buildTextResult, normalizeOptionalString, requireNonEmpty, resolveGitHubRepo } from "./gh-common";
import {
	assertRepositorySelectorSupportedForOperation,
	executeIssueCreate,
	executeIssueState,
} from "./gh-issue-mutations";
import { executePrCheckout, executePrCreate, executePrPush } from "./gh-pr-checkout";
import { executeRunWatch } from "./gh-run-watch";
import {
	executeSearchCode,
	executeSearchCommits,
	executeSearchIssues,
	executeSearchPrs,
	executeSearchRepos,
} from "./gh-search";
import type { GithubInput } from "./gh-types";
import { executeRepoView } from "./gh-view";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";

export { parsePositiveDecimalInt, resolveDefaultRepoMemoized } from "./gh-common";
export {
	getOrFetchPrDiff,
	type PrDiffFile,
	type PrDiffLookupOptions,
	type PrDiffPayload,
	parsePrUnifiedDiff,
} from "./gh-pr-diff";
export { buildSearchDateQualifier, parseSearchDateBound } from "./gh-search";
export {
	GH_ISSUE_HIERARCHY_FIELDS,
	getOrFetchIssue,
	getOrFetchPr,
	githubIssueJsonWithHierarchyFallback,
	githubIssueJsonWithStateReasonFallback,
	type IssueHierarchyAvailability,
	type IssueViewLookupOptions,
	type PrViewLookupOptions,
	type ViewLookupResult,
} from "./gh-view";


const GITHUB_READONLY_OPS: ReadonlySet<string> = new Set([
	"repo_view",
	"file_read",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
]);

const githubSchema = type({
	op: type(
		"'repo_view' | 'file_read' | 'issue_create' | 'issue_state' | 'pr_create' | 'pr_checkout' | 'pr_push' | 'search_issues' | 'search_prs' | 'search_code' | 'search_commits' | 'search_repos' | 'run_watch'",
	).describe("github operation"),
	"repo?": type("string").describe("owner/repo"),
	"branch?": type("string").describe("branch"),
	"path?": type("string").describe("repository-relative file path"),
	"pr?": type("string | string[]").describe("pr number, url, or branch"),
	"issue?": type("string | string[]").describe("issue number or issue numbers"),
	"force?": type("boolean").describe("reset existing local branch"),
	"forceWithLease?": type("boolean").describe("force-with-lease push"),
	"title?": type("string").describe("issue or pr title"),
	"body?": type("string").describe("issue or pr body markdown"),
	"base?": type("string").describe("pr base branch"),
	"head?": type("string").describe("pr head branch"),
	"draft?": type("boolean").describe("open pr as draft"),
	"fill?": type("boolean").describe("auto-fill pr title/body from commits"),
	"reviewer?": type("string[]").describe("reviewers"),
	"assignee?": type("string[]").describe("assignees"),
	"label?": type("string[]").describe("labels"),
	"parent?": type("string").describe("parent issue number or canonical issue URL"),
	"subIssues?": type("string[]").describe("existing issue numbers or canonical issue URLs to attach as sub-issues"),
	"replaceParent?": type("boolean").describe("allow attached sub-issues to be moved from their current parents"),
	"state?": type("'open' | 'closed'").describe("issue state"),
	"stateReason?": type("'completed' | 'not_planned'").describe("reason for closing an issue"),
	"query?": type("string").describe("search query"),
	"since?": type("string").describe("lower-bound date filter"),
	"until?": type("string").describe("upper-bound date filter"),
	"dateField?": type("'created' | 'updated'").describe("date field"),
	"limit?": type("number").describe("max results"),
	"run?": type("string").describe("actions run id or url"),
	"tail?": type("number").describe("log lines per failed job"),
});

export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
}

export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}


export class GithubTool implements AgentTool<typeof githubSchema, GhToolDetails> {
	readonly name = "github";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = (args as Partial<GithubInput>).op;
		const op = typeof rawOp === "string" ? rawOp : "";
		return GITHUB_READONLY_OPS.has(op) ? "read" : "exec";
	};
	readonly summary = "Interact with GitHub repositories, files, issues, pull requests, and Actions";
	readonly loadMode = "discoverable";
	readonly label = "GitHub";
	readonly description = prompt.render(githubDescription);
	readonly parameters = githubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GithubTool | null {
		if (!git.github.available()) return null;
		return new GithubTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GithubInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GhToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GhToolDetails>> {
		const op = params.op;
		if (op === "issue_create") {
			return executeIssueCreate(this.session, params, signal);
		}
		if (op === "issue_state") {
			return executeIssueState(this.session, params, signal);
		}
		return untilAborted(signal, async () => {
			switch (op) {
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "file_read":
					return executeFileRead(this.session, params, signal);
				case "pr_create":
					return executePrCreate(this.session, params, signal);
				case "pr_checkout":
					return executePrCheckout(this.session, params, signal);
				case "pr_push":
					return executePrPush(this.session, params, signal);
				case "search_issues":
					return executeSearchIssues(this.session, params, signal);
				case "search_prs":
					return executeSearchPrs(this.session, params, signal);
				case "search_code":
					return executeSearchCode(this.session, params, signal);
				case "search_commits":
					return executeSearchCommits(this.session, params, signal);
				case "search_repos":
					return executeSearchRepos(this.session, params, signal);
				case "run_watch":
					return executeRunWatch(this.session, this.name, params, signal, onUpdate);
			}
		});
	}
}

async function executeFileRead(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = await resolveGitHubRepo(session.cwd, normalizeOptionalString(params.repo), undefined, signal);
	const filePath = requireNonEmpty(normalizeOptionalString(params.path), "path");
	if (filePath.startsWith("/")) {
		throw new ToolError("path must be repository-relative");
	}
	const branch = normalizeOptionalString(params.branch);
	const endpointPath = filePath
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");
	const args = [
		"api",
		`/repos/${repo}/contents/${endpointPath}`,
		"--method",
		"GET",
		"-H",
		"Accept: application/vnd.github.raw+json",
	];
	if (branch) {
		args.push("-f", `ref=${branch}`);
	}
	const text = await git.github.text(session.cwd, args, signal, {
		repoProvided: true,
		trimOutput: false,
	});
	const sourceUrl = `https://github.com/${repo}/blob/${encodeURIComponent(branch ?? "HEAD")}/${endpointPath}`;
	return buildTextResult(text, sourceUrl, { repo, branch });
}

