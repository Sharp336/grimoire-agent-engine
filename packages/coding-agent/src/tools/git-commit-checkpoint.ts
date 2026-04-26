import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import gitCommitCheckpointDescription from "../prompts/tools/git-commit-checkpoint.md" with { type: "text" };
import { type CommitDirtyRepoEntry, commitDirtyRepos } from "../task/auto-commit";
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { shortenPath } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const gitCommitCheckpointSchema = Type.Object({
	reason: Type.String({
		description:
			"Short label for the scope being closed, e.g. 'after login refactor', 'end of scope'. Used only for agent bookkeeping and surfaced in the transcript — it is not written into the commit message itself.",
	}),
});

type GitCommitCheckpointParams = Static<typeof gitCommitCheckpointSchema>;

export type GitCommitCheckpointRepoEntry = CommitDirtyRepoEntry;

export interface GitCommitCheckpointToolDetails {
	overallStatus: "committed" | "clean" | "partial" | "failed";
	reason?: string;
	repos: GitCommitCheckpointRepoEntry[];
	meta?: OutputMeta;
}

export class GitCommitCheckpointTool
	implements AgentTool<typeof gitCommitCheckpointSchema, GitCommitCheckpointToolDetails>
{
	readonly name = "git_commit_checkpoint";
	readonly label = "GitCommitCheckpoint";
	readonly description: string;
	readonly parameters = gitCommitCheckpointSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(gitCommitCheckpointDescription);
	}

	static createIf(session: ToolSession): GitCommitCheckpointTool | null {
		if ((session.taskDepth ?? 0) !== 0) return null;
		if (!session.settings.get("tools.gitCommitCheckpoint.enabled")) return null;
		return new GitCommitCheckpointTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GitCommitCheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GitCommitCheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GitCommitCheckpointToolDetails>> {
		const cwd = this.session.cwd;
		const entries = await commitDirtyRepos({
			cwd,
			modelRegistry: this.session.modelRegistry,
			settings: this.session.settings,
			sessionId: this.session.getSessionId?.() ?? undefined,
		});

		if (entries.length === 0) {
			const details: GitCommitCheckpointToolDetails = {
				overallStatus: "clean",
				reason: params.reason,
				repos: [],
			};
			return toolResult<GitCommitCheckpointToolDetails>(details)
				.text(`Nothing to commit — all repos under ${shortenPath(cwd)} are clean.`)
				.done();
		}
		const committed = entries.filter(entry => entry.status === "committed").length;
		const failed = entries.filter(entry => entry.status === "failed").length;
		const overallStatus: GitCommitCheckpointToolDetails["overallStatus"] =
			failed === entries.length ? "failed" : failed > 0 ? "partial" : committed === 0 ? "clean" : "committed";

		const details: GitCommitCheckpointToolDetails = {
			overallStatus,
			reason: params.reason,
			repos: entries,
		};
		const text = formatResultText(entries);
		if (overallStatus === "failed") {
			throw new ToolError(text);
		}
		return toolResult<GitCommitCheckpointToolDetails>(details).text(text).done();
	}
}

function formatResultText(entries: GitCommitCheckpointRepoEntry[]): string {
	if (entries.length === 0) {
		return "No dirty repos.";
	}
	const lines: string[] = [];
	for (const entry of entries) {
		const repoLabel = shortenPath(entry.repoPath);
		if (entry.status === "committed") {
			const sha = entry.sha ?? "unknown";
			const fileWord = entry.filesChanged === 1 ? "file" : "files";
			const subject = entry.message?.trim().split("\n")[0];
			const suffix = subject ? ` — ${subject}` : "";
			lines.push(`${repoLabel}: ${sha} (${entry.filesChanged} ${fileWord})${suffix}`);
		} else if (entry.status === "skipped") {
			lines.push(`${repoLabel}: skipped (${entry.reason ?? "no-changes"})`);
		} else {
			lines.push(`${repoLabel}: failed — ${entry.error ?? "unknown error"}`);
		}
	}
	return lines.join("\n");
}
