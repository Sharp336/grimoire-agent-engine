import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, prompt, setProjectDir } from "@oh-my-pi/pi-utils";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { runCommitCommand } from "../../commit/pipeline";
import * as git from "../../utils/git";

import expertApplyNitsPrompt from "../../prompts/collab-modes/expert-apply-nits.md" with { type: "text" };
import expertArchitectPrompt from "../../prompts/collab-modes/expert-architect.md" with { type: "text" };
import expertArchitectWrapperPrompt from "../../prompts/collab-modes/expert-architect-wrapper.md" with { type: "text" };
import expertDesignReviewPrompt from "../../prompts/collab-modes/expert-design-review.md" with { type: "text" };
import expertImplementPrompt from "../../prompts/collab-modes/expert-implement.md" with { type: "text" };
import expertPlanPrompt from "../../prompts/collab-modes/expert-plan.md" with { type: "text" };
import expertReviewPrompt from "../../prompts/collab-modes/expert-review.md" with { type: "text" };
import expertReviseCodePrompt from "../../prompts/collab-modes/expert-revise-code.md" with { type: "text" };
import expertRevisePlanPrompt from "../../prompts/collab-modes/expert-revise-plan.md" with { type: "text" };
import simpleTaskPrompt from "../../prompts/collab-modes/simple-task.md" with { type: "text" };

const MAX_DESIGN_ROUNDS = 3;
const MAX_REVIEW_ROUNDS = 3;
const MAX_DIFF_CHARS = 60000;

type VerdictDecision = "approve" | "nits" | "revise";

interface Verdict {
	decision: VerdictDecision;
	notes: string;
}

function parseVerdict(message: string): Verdict {
	const match = message.match(/VERDICT:\s*(APPROVE_WITH_NITS|APPROVE|APPROVED|REVISE)/i);
	let decision: VerdictDecision = "revise";
	if (match) {
		const token = match[1].toUpperCase();
		if (token === "REVISE") decision = "revise";
		else if (token === "APPROVE_WITH_NITS") decision = "nits";
		else decision = "approve";
	}
	return { decision, notes: message };
}

function isRepeatConcern(previous: string, current: string): boolean {
	const tokenize = (s: string): Set<string> =>
		new Set(
			s
				.toLowerCase()
				.replace(/verdict:\s*\w+/gi, "")
				.replace(/[^a-z0-9\s]/g, " ")
				.split(/\s+/)
				.filter(w => w.length > 3),
		);
	const a = tokenize(previous);
	const b = tokenize(current);
	if (a.size === 0 || b.size === 0) return false;
	let intersection = 0;
	for (const word of a) if (b.has(word)) intersection++;
	const union = a.size + b.size - intersection;
	return union > 0 && intersection / union >= 0.85;
}

function truncateDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_CHARS) return diff;
	return (
		diff.slice(0, MAX_DIFF_CHARS) +
		`\n\n[... diff truncated at ${MAX_DIFF_CHARS} characters. Read the files directly to review the rest. ...]`
	);
}

/**
 * After the agent finishes implementing, run the omp commit pipeline and
 * optionally create a PR via the `gh` CLI.
 *
 * `runCommitCommand` resolves its cwd from `getProjectDir()`, so we save/restore
 * the global to ensure it operates in the session's cwd rather than whatever
 * directory the process was launched from.
 *
 * The commit pipeline is run with `push: false` even when a PR is requested,
 * because `git push` on a branch with no upstream fails. Instead, `gh pr create`
 * pushes the branch automatically when creating the PR.
 */
async function commitAndCreatePr(
	cwd: string,
	output: (text: string) => Promise<void> | void,
	createPr: boolean,
): Promise<void> {
	if (createPr) {
		const currentBranch = await git.branch.current(cwd);
		const defaultBranch = await git.branch.default(cwd);
		if (currentBranch && defaultBranch && currentBranch === defaultBranch) {
			await output(
				`On default branch '${currentBranch}' — refusing to push directly. Create a feature branch first.`,
			);
			return;
		}
	}

	const previousProjectDir = getProjectDir();
	if (previousProjectDir !== cwd) {
		setProjectDir(cwd);
	}
	try {
		await output("Running commit pipeline...");
		await runCommitCommand({
			push: false,
			dryRun: false,
			noChangelog: false,
		});
	} finally {
		if (previousProjectDir !== cwd) {
			setProjectDir(previousProjectDir);
		}
	}

	if (createPr) {
		await output("Creating pull request...");
		const branch = await git.branch.current(cwd);
		if (!branch) {
			await output("Could not determine current branch; skipping PR creation.");
			return;
		}
		const bodyFile = path.join(os.tmpdir(), `omp-pr-body-${Date.now()}.md`);
		await Bun.write(bodyFile, `Changes on branch ${branch}`);
		try {
			const prUrl = await git.github.text(cwd, [
				"pr",
				"create",
				"--body-file",
				bodyFile,
				"--title",
				`Changes from ${branch}`,
			]);
			await output(`Pull request created: ${prUrl}`);
		} catch (err) {
			await output(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			await Bun.file(bodyFile)
				.unlink()
				.catch(() => {});
		}
	}
}

/**
 * Collect a review diff that includes unstaged, staged, and untracked file
 * changes. `git diff` alone misses untracked files, so we check `git status
 * --porcelain` for `??` entries and append their content as pseudo-diff hunks.
 */
async function collectReviewDiff(cwd: string): Promise<string> {
	const unstagedDiff = await git.diff(cwd);
	const stagedDiff = await git.diff(cwd, { cached: true });

	const statusText = await git.status(cwd, { porcelainV1: true, untrackedFiles: "all" });
	const untrackedFiles: string[] = [];
	for (const line of statusText.split("\n")) {
		if (line.startsWith("?? ")) {
			untrackedFiles.push(line.slice(3).trim());
		}
	}

	let untrackedDiff = "";
	for (const file of untrackedFiles) {
		try {
			const content = await Bun.file(path.join(cwd, file)).text();
			untrackedDiff += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split("\n").length} @@\n`;
			for (const line of content.split("\n")) {
				untrackedDiff += `+${line}\n`;
			}
		} catch {
			// Skip binary or unreadable files
		}
	}

	return truncateDiff(`${unstagedDiff}\n${stagedDiff}\n${untrackedDiff}`);
}

/**
 * Expert mode: runs an architect↔implementer loop with design review,
 * implementation, and code review phases. After completion, commits and
 * optionally creates a PR.
 *
 * This function is intended for the TUI path where nested `session.prompt()`
 * calls are safe. ACP/text-mode handlers should return `{ prompt }` instead
 * to avoid racing with the outer ACP turn lifecycle.
 */
export async function handleExpertMode(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const task = command.args.trim();
	if (!task) {
		await runtime.output("Usage: /expert <task description>");
		return { consumed: true };
	}

	const cwd = runtime.cwd;
	const session = runtime.session;
	const architectSystem = prompt.render(expertArchitectPrompt);

	// ----- Phase 1: design dialogue -----
	await runtime.output("Expert mode: design dialogue");
	const planPromptText = prompt.render(expertPlanPrompt, { task });
	await session.prompt(planPromptText, { expandPromptTemplates: false, synthetic: true });
	let plan = session.getLastAssistantText() ?? "";

	let designNits: string | undefined;
	let previousDesignConcern: string | undefined;

	for (let round = 1; round <= MAX_DESIGN_ROUNDS; round++) {
		await runtime.output(`Architect design review (round ${round})`);
		const designReviewPrompt = prompt.render(expertDesignReviewPrompt, { task, plan });
		const architectPrompt = prompt.render(expertArchitectWrapperPrompt, {
			architectSystem,
			reviewPrompt: designReviewPrompt,
		});
		await session.prompt(architectPrompt, { expandPromptTemplates: false, synthetic: true });
		const reviewText = session.getLastAssistantText() ?? "";
		const verdict = parseVerdict(reviewText);

		if (verdict.decision === "approve") {
			await runtime.output("Architect approved the design.");
			break;
		}
		if (verdict.decision === "nits") {
			await runtime.output("Architect approved the design with minor notes.");
			designNits = verdict.notes;
			break;
		}

		if (round === MAX_DESIGN_ROUNDS) {
			await runtime.output(
				`Design still has blocking concerns after ${round} round(s); proceeding with the latest plan.`,
			);
			break;
		}
		if (previousDesignConcern && isRepeatConcern(previousDesignConcern, verdict.notes)) {
			await runtime.output("Architect repeated the same unresolved concern; proceeding.");
			break;
		}
		previousDesignConcern = verdict.notes;

		await runtime.output(`Implementer revising plan (round ${round})`);
		const revisePrompt = prompt.render(expertRevisePlanPrompt, { notes: verdict.notes });
		await session.prompt(revisePrompt, { expandPromptTemplates: false, synthetic: true });
		plan = session.getLastAssistantText() ?? plan;
	}

	// ----- Phase 2: implementation -----
	await runtime.output("Implementation phase");
	const implementPromptText = prompt.render(expertImplementPrompt, { nits: designNits ?? "" });
	await session.prompt(implementPromptText, { expandPromptTemplates: false, synthetic: true });

	// ----- Phase 3: code-review dialogue -----
	let previousReviewConcern: string | undefined;

	for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
		const diff = await collectReviewDiff(cwd);
		if (!diff.trim()) {
			await runtime.output("No changes to review; skipping code review.");
			break;
		}

		await runtime.output(`Architect code review (round ${round})`);
		const codeReviewPrompt = prompt.render(expertReviewPrompt, { task, plan, diff });
		const architectCodePrompt = prompt.render(expertArchitectWrapperPrompt, {
			architectSystem,
			reviewPrompt: codeReviewPrompt,
		});
		await session.prompt(architectCodePrompt, { expandPromptTemplates: false, synthetic: true });
		const reviewText = session.getLastAssistantText() ?? "";
		const verdict = parseVerdict(reviewText);

		if (verdict.decision === "approve") {
			await runtime.output("Architect approved the implementation.");
			break;
		}
		if (verdict.decision === "nits") {
			await runtime.output("Architect approved with minor notes; applying them.");
			const applyNitsPromptText = prompt.render(expertApplyNitsPrompt, { notes: verdict.notes });
			await session.prompt(applyNitsPromptText, { expandPromptTemplates: false, synthetic: true });
			break;
		}

		if (round === MAX_REVIEW_ROUNDS) {
			await runtime.output(`Implementation still has blocking concerns after ${round} round(s); proceeding.`);
			break;
		}
		if (previousReviewConcern && isRepeatConcern(previousReviewConcern, verdict.notes)) {
			await runtime.output("Architect repeated the same unresolved concern; proceeding.");
			break;
		}
		previousReviewConcern = verdict.notes;

		await runtime.output(`Implementer applying review changes (round ${round})`);
		const reviseCodePromptText = prompt.render(expertReviseCodePrompt, { notes: verdict.notes });
		await session.prompt(reviseCodePromptText, { expandPromptTemplates: false, synthetic: true });
	}

	// ----- Commit and PR -----
	await commitAndCreatePr(cwd, runtime.output, true);

	return { consumed: true };
}

/**
 * Simple mode: one-shot task execution. After the agent finishes, commits
 * and optionally creates a PR.
 *
 * This function is intended for the TUI path where nested `session.prompt()`
 * calls are safe. ACP/text-mode handlers should return `{ prompt }` instead
 * to avoid racing with the outer ACP turn lifecycle.
 */
export async function handleSimpleMode(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const task = command.args.trim();
	if (!task) {
		await runtime.output("Usage: /simple <task description>");
		return { consumed: true };
	}

	const session = runtime.session;
	const taskPrompt = prompt.render(simpleTaskPrompt, { task });
	await runtime.output("Simple mode: executing task...");
	await session.prompt(taskPrompt, { expandPromptTemplates: false, synthetic: true });

	await commitAndCreatePr(runtime.cwd, runtime.output, true);

	return { consumed: true };
}

/**
 * ACP-safe expert mode handler. Returns `{ prompt }` with the initial task
 * so the outer ACP turn drives the LLM interaction. The full multi-turn
 * workflow is only available in the TUI path via `handleExpertMode`.
 */
export function handleExpertModeAcp(command: ParsedSlashCommand): SlashCommandResult {
	const task = command.args.trim();
	if (!task) {
		return { consumed: true };
	}
	return { prompt: prompt.render(expertPlanPrompt, { task }) };
}

/**
 * ACP-safe simple mode handler. Returns `{ prompt }` with the task so the
 * outer ACP turn drives the LLM interaction.
 */
export function handleSimpleModeAcp(command: ParsedSlashCommand): SlashCommandResult {
	const task = command.args.trim();
	if (!task) {
		return { consumed: true };
	}
	return { prompt: prompt.render(simpleTaskPrompt, { task }) };
}
