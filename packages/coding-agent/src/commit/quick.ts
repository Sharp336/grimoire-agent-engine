import type { Settings } from "../config/settings";
import type { HookCommandContext } from "../extensibility/hooks/types";
import { PREVIEW_LIMITS, previewLine, replaceTabs, TRUNCATE_LENGTHS } from "../tools/render-utils";
import * as git from "../utils/git";
import { resolvePrimaryModel } from "./model-selection";
import { generateQuickCommitPlan, type QuickCommitPlan, type QuickCommitPlanItem } from "./quick-planner";

export type { QuickCommitPlan } from "./quick-planner";

const RECENT_COMMITS_COUNT = 8;
const MAX_DIFF_CHARS = 120_000;
// Anchored without `m`: only the subject line is validated, so a conventional
// prefix buried in the commit body can never satisfy `messageFormat=conventional`.
const CONVENTIONAL_SUBJECT =
	/^(feat|fix|refactor|docs|test|chore|style|perf|build|ci|revert)(\([a-z0-9_-]+(?:\/[a-z0-9_-]+)?(?:,[a-z0-9_-]+(?:\/[a-z0-9_-]+)?)*\))?!?:\s\S/;

export interface QuickCommitResult {
	commitCount: number;
	branchName?: string;
}

export interface QuickCommitBranchContext {
	hasUI: boolean;
	ui: Pick<HookCommandContext["ui"], "select">;
}

export interface QuickCommitBranch {
	name: string;
	action: "create" | "checkout";
}

export async function runQuickCommit(
	startDir: string,
	ctx: HookCommandContext,
	settings: Settings,
): Promise<QuickCommitResult | undefined> {
	const cwd = await resolveQuickCommitCwd(startDir);
	let stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
	if (stagedFiles.length === 0) {
		ctx.ui.setStatus("commit", "Staging changes…");
		await git.stage.files(cwd);
		stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
	}
	if (stagedFiles.length === 0) {
		ctx.ui.setStatus("commit", undefined);
		ctx.ui.notify("No changes to commit.", "warning");
		return undefined;
	}

	ctx.ui.setStatus("commit", "Preparing commit plan…");
	const [diff, stat, numstat, recentCommits, currentBranch, defaultBranch] = await Promise.all([
		git.diff(cwd, { cached: true }),
		git.diff(cwd, { cached: true, stat: true }),
		git.diff(cwd, { cached: true, numstat: true }),
		git.log.subjects(cwd, RECENT_COMMITS_COUNT),
		git.branch.current(cwd),
		git.branch.default(cwd),
	]);
	if (
		settings.get("commit.messageFormat") === "user-submitted" &&
		!settings.get("commit.messageInstructions")?.trim()
	) {
		throw new Error("Commit Message Instructions are required when using the User-submitted message format.");
	}
	const resolved = await resolvePrimaryModel(undefined, settings, ctx.modelRegistry);
	const plan = await generateQuickCommitPlan({
		model: resolved.model,
		apiKey: resolved.apiKey,
		thinkingLevel: resolved.thinkingLevel,
		splitMode: settings.get("commit.splitMode"),
		messageFormat: settings.get("commit.messageFormat"),
		messageInstructions: settings.get("commit.messageInstructions") ?? "",
		files: stagedFiles,
		stat,
		numstat,
		recentCommits,
		diff: limitDiff(diff),
	});
	validateQuickCommitPlan(plan, stagedFiles, settings.get("commit.splitMode"), settings.get("commit.messageFormat"));

	if (plan.commits.length > 1) {
		if (!ctx.hasUI) throw new Error("Split commit plans require an interactive session.");
		const confirmed = await ctx.ui.confirm("Create split commits", formatSplitPlan(plan));
		if (!confirmed) {
			ctx.ui.setStatus("commit", undefined);
			return undefined;
		}
	}

	const branch = await resolveQuickCommitBranch(cwd, ctx, settings, currentBranch, defaultBranch, plan);
	if (branch) {
		if (branch.action === "create") {
			await git.branch.checkoutNew(cwd, branch.name);
		} else {
			await git.checkout(cwd, branch.name);
			// Switching to an *existing* branch can drop a staged path out of the
			// index without error: if that branch's tree already matches the
			// staged content for a path, the index-vs-HEAD diff for it becomes
			// empty and the path vanishes from `changedFiles`. Fail loudly rather
			// than let the single-commit path silently commit whatever remains
			// staged under a message describing the full original plan.
			const postCheckoutFiles = new Set(await git.diff.changedFiles(cwd, { cached: true }));
			const missing = plan.commits.flatMap(commit => commit.files).filter(file => !postCheckoutFiles.has(file));
			if (missing.length > 0) {
				const shown = missing.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS).map(file => replaceTabs(file));
				const suffix = missing.length > shown.length ? `, +${missing.length - shown.length} more` : "";
				throw new Error(
					`Switching to ${branch.name} dropped staged changes the plan expected: ${shown.join(", ")}${suffix}. Re-run /commit.`,
				);
			}
		}
	}
	const branchName = branch?.name;

	ctx.ui.setStatus("commit", "Creating commit…");
	try {
		if (plan.commits.length === 1) {
			await git.commit(cwd, plan.commits[0].message);
		} else {
			await createSplitCommits(cwd, plan);
		}
		ctx.ui.notify(`Created ${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"}.`, "info");
		return { commitCount: plan.commits.length, branchName };
	} finally {
		ctx.ui.setStatus("commit", undefined);
	}
}

export async function resolveQuickCommitCwd(startDir: string): Promise<string> {
	const cwd = await git.repo.root(startDir);
	if (!cwd) throw new Error("Commit requires a Git repository.");
	return cwd;
}

function limitDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_CHARS) return diff;
	return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[Diff truncated after ${MAX_DIFF_CHARS} characters; file metadata is complete.]`;
}

export function validateQuickCommitPlan(
	plan: QuickCommitPlan,
	stagedFiles: string[],
	splitMode: "on" | "off" | "auto",
	messageFormat: "conventional" | "freeform" | "user-submitted",
): void {
	if (plan.commits.length === 0) throw new Error("Commit planner returned no commits.");
	if (splitMode === "off" && plan.commits.length !== 1) {
		throw new Error("Commit planner returned multiple commits while split commits are disabled.");
	}
	const staged = new Set(stagedFiles);
	const assigned = new Set<string>();
	for (const commit of plan.commits) {
		if (commit.files.length === 0) throw new Error("Commit planner returned an empty file group.");
		if (!commit.message) throw new Error("Commit planner returned an empty commit message.");
		if (!commit.body) throw new Error("Commit planner returned an empty commit body.");
		if (!commit.branchType) throw new Error("Commit planner returned an empty branch type.");
		const subject = commit.message.split("\n", 1)[0];
		if (messageFormat === "conventional" && !CONVENTIONAL_SUBJECT.test(subject)) {
			throw new Error(`Commit message is not conventional: ${subject}`);
		}
		for (const file of commit.files) {
			if (!staged.has(file)) throw new Error(`Commit planner included a file that is not staged: ${file}`);
			if (assigned.has(file)) throw new Error(`Commit planner assigned a file to multiple commits: ${file}`);
			assigned.add(file);
		}
	}
	for (const file of stagedFiles) {
		if (!assigned.has(file)) throw new Error(`Commit planner omitted staged file: ${file}`);
	}
}

export async function resolveQuickCommitBranch(
	cwd: string,
	ctx: QuickCommitBranchContext,
	settings: Settings,
	currentBranch: string | null,
	defaultBranch: string | null,
	plan: QuickCommitPlan,
): Promise<QuickCommitBranch | undefined> {
	if (!isProtectedBranch(currentBranch, defaultBranch)) return undefined;
	const protection = settings.get("commit.mainBranchProtection");
	if (protection === "off") return undefined;
	const branchName = renderBranchName(settings.get("commit.branchNameTemplate") ?? "{type}/{slug}", plan.commits[0]);
	const branchExists = await git.ref.exists(cwd, `refs/heads/${branchName}`);
	if (protection === "on") {
		if (branchExists) throw new Error(`Feature branch already exists: ${branchName}`);
		return { name: branchName, action: "create" };
	}
	if (!ctx.hasUI) throw new Error("Main branch protection is set to ask, but this session is not interactive.");
	const useBranch = branchExists ? `Use existing ${branchName}` : `Create ${branchName}`;
	const commitHere = `Commit on ${currentBranch}`;
	const selected = await ctx.ui.select("Protected branch", [useBranch, commitHere]);
	if (!selected) throw new Error("Commit cancelled.");
	if (selected === commitHere) return undefined;
	return { name: branchName, action: branchExists ? "checkout" : "create" };
}

function isProtectedBranch(currentBranch: string | null, defaultBranch: string | null): boolean {
	if (!currentBranch) return false;
	return currentBranch === defaultBranch || currentBranch === "main" || currentBranch === "master";
}

function renderBranchName(template: string, commit: QuickCommitPlanItem): string {
	const type = normalizeBranchSegment(commit.branchType);
	const scope = commit.branchScope ? normalizeBranchSegment(commit.branchScope) : "";
	const subject = commit.message.split("\n", 1)[0].replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "");
	const slug = normalizeBranchSegment(subject);
	const name = template
		.replaceAll("{type}", type)
		.replaceAll("{scope}", scope)
		.replaceAll("{slug}", slug)
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (
		!name ||
		name.startsWith(".") ||
		name.endsWith(".") ||
		name.includes("..") ||
		name.includes("@{") ||
		name.endsWith(".lock")
	) {
		throw new Error(`Feature branch template produced an invalid name: ${name || "(empty)"}`);
	}
	return name;
}

function normalizeBranchSegment(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!normalized) throw new Error("Commit planner could not derive a valid branch name.");
	return normalized;
}

/**
 * Rebuild each commit from the staged snapshot captured before the index is
 * reset — never from the working tree. Re-`git add`ing a path would fold in
 * unstaged hunks the user deliberately left out and degrade a staged rename
 * into an addition that leaves the old path tracked-and-deleted.
 */
export async function createSplitCommits(cwd: string, plan: QuickCommitPlan): Promise<void> {
	const stagedDiff = await git.diff(cwd, { cached: true, binary: true });
	await git.stage.reset(cwd);
	let committed = 0;
	try {
		for (const commit of plan.commits) {
			await git.stage.hunks(
				cwd,
				commit.files.map(file => ({ path: file, hunks: { type: "all" } as const })),
				{ rawDiff: stagedDiff, diffCached: true },
			);
			await git.commit(cwd, commit.message);
			committed += 1;
			await git.stage.reset(cwd);
		}
	} catch (error) {
		// A pre-commit hook, signing step, or `git commit` failure here would
		// otherwise leave every later group unstaged in the working tree and
		// invisible to a retry's `changedFiles` scan. Restore the original
		// staged snapshot for every group that hasn't landed a commit yet
		// (fresh from `stagedDiff` against the current, post-success HEAD) so
		// the user's original index is recoverable instead of silently
		// omitted.
		const remaining = plan.commits.slice(committed);
		if (remaining.length > 0) {
			await git.stage.reset(cwd);
			await git.stage.hunks(
				cwd,
				remaining.flatMap(commit => commit.files).map(file => ({ path: file, hunks: { type: "all" } as const })),
				{ rawDiff: stagedDiff, diffCached: true },
			);
		}
		throw error;
	}
}

const CONFIRM_MAX_COMMITS = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const CONFIRM_MAX_FILES_PER_COMMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function formatSplitPlan(plan: QuickCommitPlan): string {
	const shown = plan.commits.slice(0, CONFIRM_MAX_COMMITS);
	const lines = shown.map((commit, index) => {
		const subject = previewLine(commit.message.split("\n", 1)[0], TRUNCATE_LENGTHS.LINE);
		const files = commit.files
			.slice(0, CONFIRM_MAX_FILES_PER_COMMIT)
			.map(file => previewLine(file, TRUNCATE_LENGTHS.SHORT));
		const omitted = commit.files.length - files.length;
		const fileList = omitted > 0 ? `${files.join(", ")}, +${omitted} more` : files.join(", ");
		return `${index + 1}. ${subject}\n   ${fileList}`;
	});
	if (plan.commits.length > shown.length) {
		lines.push(`… +${plan.commits.length - shown.length} more commits`);
	}
	return lines.join("\n\n");
}
