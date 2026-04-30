import { Container, Text, type TUI } from "@oh-my-pi/pi-tui";
import type { AgentSession, AsyncJobSnapshotItem } from "../../session/agent-session";
import type { AgentProgress, TaskBackgroundRunEvent } from "../../task/types";
import {
	formatDuration,
	PREVIEW_LIMITS,
	replaceTabs,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../../tools/render-utils";
import { getSymbolTheme, theme } from "../theme/theme";

type RunState = {
	progress: AgentProgress[];
	lastUpdateMs: number;
	completed: boolean;
	resultsInserted: boolean;
};

export class BackgroundTaskRunsComponent extends Container {
	#ui: TUI;
	#session: AgentSession;
	#text: Text;
	#expanded = false;
	#spinnerFrame = 0;
	#spinnerInterval: NodeJS.Timeout | undefined = undefined;

	#runs = new Map<string, RunState>();

	constructor(ui: TUI, session: AgentSession) {
		super();
		this.#ui = ui;
		this.#session = session;
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	override render(width: number): string[] {
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
		return super.render(width);
	}

	stopAnimation(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	markResultsInserted(runId: string): void {
		const run = this.#runs.get(runId);
		if (!run) return;
		run.resultsInserted = true;
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
	}

	getRunSnapshot(runId: string): { progress: AgentProgress[]; completed: boolean } | undefined {
		const run = this.#runs.get(runId);
		if (!run) return undefined;
		return { progress: run.progress, completed: run.completed };
	}

	deleteRun(runId: string): void {
		if (!this.#runs.has(runId)) return;
		this.#runs.delete(runId);
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
	}

	updateFromEvent(event: TaskBackgroundRunEvent): void {
		const existing = this.#runs.get(event.runId);
		const completed = event.type === "background_run_complete";

		this.#runs.set(event.runId, {
			progress: event.progress,
			lastUpdateMs: event.timestamp,
			completed,
			resultsInserted: existing?.resultsInserted ?? false,
		});

		this.#updateSpinnerAnimation();
		this.#updateDisplay();
	}

	#updateSpinnerAnimation(): void {
		const hasLegacyRunning = Array.from(this.#runs.values()).some(r => !r.completed && !r.resultsInserted);
		const hasAsyncRunning = (this.#session.getAsyncJobSnapshot()?.running.length ?? 0) > 0;
		const hasRunning = hasLegacyRunning || hasAsyncRunning;
		if (hasRunning && !this.#spinnerInterval) {
			this.#spinnerInterval = setInterval(() => {
				const frames = getSymbolTheme().spinnerFrames;
				if (frames.length === 0) return;
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frames.length;
				this.#ui.requestRender();
			}, 80);
		} else if (!hasRunning && this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	#formatRunId(runId: string): string {
		return runId.length > 8 ? runId.slice(0, 8) : runId;
	}

	#statusIcon(status: AgentProgress["status"]): string {
		switch (status) {
			case "completed":
				return theme.status.success;
			case "failed":
				return theme.status.error;
			case "aborted":
				return theme.status.aborted;
			case "running": {
				const frames = getSymbolTheme().spinnerFrames;
				if (frames.length > 0) return frames[this.#spinnerFrame % frames.length];
				return theme.status.running;
			}
			default:
				return theme.status.pending;
		}
	}

	#statusColor(status: AgentProgress["status"]): "success" | "error" | "accent" | "muted" {
		if (status === "completed") return "success";
		if (status === "failed" || status === "aborted") return "error";
		if (status === "pending") return "muted";
		return "accent";
	}

	#renderAgent(progress: AgentProgress, prefix: string, continuationPrefix: string): string[] {
		const lines: string[] = [];
		const icon = this.#statusIcon(progress.status);
		const color = this.#statusColor(progress.status);

		const id = truncateToWidth(replaceTabs(progress.id), TRUNCATE_LENGTHS.SHORT);
		const desc = progress.description?.trim();
		const title = desc ? `${id}: ${truncateToWidth(replaceTabs(desc), TRUNCATE_LENGTHS.CONTENT)}` : id;
		lines.push(`${prefix} ${theme.fg(color, icon)} ${theme.fg("accent", title)}`);
		if (progress.status === "running") {
			if (progress.retry) {
				const remainingMs = Math.max(0, progress.retry.retryAtMs - Date.now());
				const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
				const retryText = `Retrying in ${remainingSeconds}s… (${progress.retry.attempt}/${progress.retry.maxAttempts})`;
				lines.push(`${continuationPrefix}${theme.fg("warning", `${theme.status.running} ${retryText}`)}`);
			} else if (progress.currentTool) {
				const tool = replaceTabs(progress.currentTool);
				const args = progress.currentToolArgs ? replaceTabs(progress.currentToolArgs) : "";
				const toolPart = this.#expanded
					? `${tool}${args ? `: ${args}` : ""}`
					: truncateToWidth(`${tool}${args ? `: ${args}` : ""}`, 60);
				lines.push(`${continuationPrefix}${theme.fg("dim", theme.tree.hook)} ${theme.fg("muted", toolPart)}`);
			} else if (progress.recentTools.length > 0) {
				const recent = progress.recentTools[0];
				const tool = replaceTabs(recent.tool);
				const args = recent.args ? replaceTabs(recent.args) : "";
				const toolPart = this.#expanded
					? `${tool}${args ? `: ${args}` : ""}`
					: truncateToWidth(`${tool}${args ? `: ${args}` : ""}`, 60);
				lines.push(`${continuationPrefix}${theme.fg("dim", theme.tree.hook)} ${theme.fg("dim", toolPart)}`);
			}
		}

		if (this.#expanded && progress.status !== "running" && progress.result) {
			const raw =
				(progress.result.output && progress.result.output.trim().length > 0
					? progress.result.output
					: progress.result.stderr) ?? "";
			const outputLines = replaceTabs(raw).split("\n");
			for (const line of outputLines) {
				lines.push(`${continuationPrefix}${theme.fg("dim", theme.tree.vertical)} ${theme.fg("dim", line)}`);
			}
			if (progress.result.truncated) {
				lines.push(
					`${continuationPrefix}${theme.fg("dim", theme.tree.vertical)} ${theme.fg("warning", "(truncated)")}`,
				);
			}
		}
		return lines;
	}

	#renderAsyncJob(job: AsyncJobSnapshotItem): string[] {
		const frames = getSymbolTheme().spinnerFrames;
		const spinner = frames.length > 0 ? frames[this.#spinnerFrame % frames.length] : theme.status.running;
		const rawLabel = replaceTabs(job.label || job.id);
		const labelLines = rawLabel.split("\n");
		const firstLine = this.#expanded ? labelLines[0] : truncateToWidth(labelLines[0], TRUNCATE_LENGTHS.LINE);
		const lines: string[] = [];
		lines.push(
			`${theme.fg("dim", theme.tree.branch)} ${theme.fg("accent", spinner)} ${theme.fg("dim", `[${job.type}]`)} ${theme.fg("accent", firstLine)} ${theme.fg("dim", `(${formatDuration(Math.max(0, Date.now() - job.startTime))})`)}`,
		);
		if (this.#expanded && labelLines.length > 1) {
			const continuation = `${theme.fg("dim", theme.tree.vertical)}  `;
			for (const line of labelLines.slice(1)) {
				lines.push(`${continuation}  ${theme.fg("dim", line)}`);
			}
		}
		if (job.currentTool) {
			const tool = replaceTabs(job.currentTool);
			const args = job.currentToolArgs ? replaceTabs(job.currentToolArgs) : "";
			const toolPart = this.#expanded
				? `${tool}${args ? `: ${args}` : ""}`
				: truncateToWidth(`${tool}${args ? `: ${args}` : ""}`, TRUNCATE_LENGTHS.LINE);
			lines.push(
				`${theme.fg("dim", theme.tree.vertical)}  ${theme.fg("dim", theme.tree.hook)} ${theme.fg("muted", toolPart)}`,
			);
		}
		return lines;
	}

	#updateDisplay(): void {
		const visibleRuns = Array.from(this.#runs.entries())
			.filter(([, r]) => !r.resultsInserted)
			.sort((a, b) => a[1].lastUpdateMs - b[1].lastUpdateMs);

		if (visibleRuns.length === 0) {
			const runningJobs = this.#session.getAsyncJobSnapshot()?.running ?? [];
			if (runningJobs.length === 0) {
				this.#text.setText("");
				return;
			}
			const lines = ["", theme.bold(theme.fg("accent", "Background jobs"))];
			const maxJobs = this.#expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			for (const job of runningJobs.slice(0, maxJobs)) {
				lines.push(...this.#renderAsyncJob(job));
			}
			const remaining = runningJobs.length - Math.min(runningJobs.length, maxJobs);
			if (remaining > 0) {
				lines.push(theme.fg("dim", `… ${remaining} more jobs`));
			}
			this.#text.setText(lines.join("\n"));
			return;
		}

		const lines: string[] = [];
		lines.push("");
		lines.push(theme.bold(theme.fg("accent", "Background agents")));

		for (let runIndex = 0; runIndex < visibleRuns.length; runIndex++) {
			const [runId, run] = visibleRuns[runIndex];
			const progress = run.progress;
			const total = progress.length;
			const completedCount = progress.filter(p => p.status === "completed").length;
			const runningCount = progress.filter(p => p.status === "running").length;
			const failedCount = progress.filter(p => p.status === "failed").length;
			const abortedCount = progress.filter(p => p.status === "aborted").length;

			const isLastRun = runIndex === visibleRuns.length - 1;
			const runPrefix = isLastRun ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch);
			const runContinue = isLastRun ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

			const frames = getSymbolTheme().spinnerFrames;
			const spinner = frames.length > 0 ? frames[this.#spinnerFrame % frames.length] : theme.status.running;
			const runIcon = run.completed ? theme.status.success : spinner;
			const runColor = run.completed ? "success" : "accent";

			const counts: string[] = [`${completedCount}/${total} completed`];
			if (runningCount > 0) counts.push(`${runningCount} running`);
			if (failedCount > 0) counts.push(`${failedCount} failed`);
			if (abortedCount > 0) counts.push(`${abortedCount} aborted`);

			lines.push(
				`${runPrefix} ${theme.fg(runColor, runIcon)} ${theme.fg("muted", `run ${this.#formatRunId(runId)}`)} ${theme.fg(
					"dim",
					counts.join(theme.sep.dot),
				)} ${theme.fg("dim", `(${formatDuration(Math.max(0, Date.now() - run.lastUpdateMs))} since update)`)}`,
			);

			const maxAgents = this.#expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const agentsToShow = progress.slice(0, Math.min(progress.length, maxAgents));
			for (const agentProgress of agentsToShow) {
				const agentLines = this.#renderAgent(
					agentProgress,
					`${runContinue}${theme.fg("dim", theme.tree.branch)}`,
					`${runContinue}${theme.fg("dim", theme.tree.vertical)}  `,
				);
				for (const line of agentLines) lines.push(line);
			}

			const remaining = progress.length - agentsToShow.length;
			if (remaining > 0) {
				lines.push(`${runContinue}${theme.fg("dim", `… ${remaining} more agents`)}`);
			}
		}

		this.#text.setText(lines.join("\n"));
	}
}
