import { Box, Container, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
import type { AgentProgress, SingleResult } from "../../task/types";
import { PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { getMarkdownTheme, getSymbolTheme, theme } from "../theme/theme";

export class BackgroundedTaskResultsMessageComponent extends Container {
	#box: Box;
	#expanded = false;

	#runId: string;
	#summaryText: string;
	#progress: AgentProgress[] | undefined;
	#results: SingleResult[] | undefined;

	constructor(params: { runId: string; summaryText: string; progress?: AgentProgress[]; results?: SingleResult[] }) {
		super();
		this.#runId = params.runId;
		this.#summaryText = params.summaryText;
		this.#progress = params.progress;
		this.#results = params.results;
		this.addChild(new Spacer(1));
		this.#box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		this.addChild(this.#box);
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#statusIcon(status: AgentProgress["status"], spinnerFrame: number): string {
		switch (status) {
			case "completed":
				return theme.status.success;
			case "failed":
				return theme.status.error;
			case "aborted":
				return theme.status.aborted;
			case "running": {
				const frames = getSymbolTheme().spinnerFrames;
				if (frames.length > 0) return frames[spinnerFrame % frames.length];
				return theme.status.running;
			}
			default:
				return theme.status.pending;
		}
	}

	#formatResultHeader(result: SingleResult): { icon: string; color: "success" | "error" | "muted"; text: string } {
		if (result.aborted) {
			return { icon: theme.status.aborted, color: "error", text: `${result.id} (aborted)` };
		}
		if (result.exitCode === 0) {
			return {
				icon: theme.status.success,
				color: "success",
				text: result.description ? `${result.id}: ${result.description}` : result.id,
			};
		}
		return {
			icon: theme.status.error,
			color: "error",
			text: result.description
				? `${result.id}: ${result.description} (exit ${result.exitCode})`
				: `${result.id} (exit ${result.exitCode})`,
		};
	}

	#rebuild(): void {
		this.#box.clear();

		const runIdShort = this.#runId.length > 8 ? this.#runId.slice(0, 8) : this.#runId;
		const label = theme.fg("customMessageLabel", theme.bold("[background agents]"));

		let header = `${label} ${theme.fg("muted", `run ${runIdShort}`)}`;

		if (this.#progress && this.#progress.length > 0) {
			const total = this.#progress.length;
			const completed = this.#progress.filter(p => p.status === "completed").length;
			const failed = this.#progress.filter(p => p.status === "failed").length;
			const aborted = this.#progress.filter(p => p.status === "aborted").length;
			const parts: string[] = [`${completed}/${total} completed`];
			if (failed > 0) parts.push(`${failed} failed`);
			if (aborted > 0) parts.push(`${aborted} aborted`);
			header += ` ${theme.fg("dim", parts.join(theme.sep.dot))}`;
		}

		this.#box.addChild(new Text(header, 0, 0));

		if (this.#progress && this.#progress.length > 0) {
			this.#box.addChild(new Spacer(1));

			const maxAgents = this.#expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const agents = this.#progress.slice(0, Math.min(this.#progress.length, maxAgents));
			const spinnerFrame = 0;

			for (let i = 0; i < agents.length; i++) {
				const p = agents[i];
				const isLast = i === agents.length - 1;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				const icon = this.#statusIcon(p.status, spinnerFrame);
				const id = truncateToWidth(replaceTabs(p.id), TRUNCATE_LENGTHS.SHORT);
				const desc = p.description?.trim();
				const title = desc ? `${id}: ${truncateToWidth(replaceTabs(desc), TRUNCATE_LENGTHS.CONTENT)}` : id;
				this.#box.addChild(
					new Text(` ${theme.fg("dim", branch)} ${theme.fg("accent", icon)} ${theme.fg("accent", title)}`, 0, 0),
				);

				const tool = p.currentTool ?? p.recentTools[0]?.tool;
				const args = p.currentToolArgs ?? p.recentTools[0]?.args;
				if (tool) {
					const toolLine = args ? `${replaceTabs(tool)}: ${replaceTabs(args)}` : replaceTabs(tool);
					const preview = this.#expanded ? toolLine : truncateToWidth(toolLine, 60);
					this.#box.addChild(
						new Text(` ${theme.fg("dim", theme.tree.vertical)} ${theme.fg("dim", preview)}`, 0, 0),
					);
				}
			}

			const remaining = this.#progress.length - agents.length;
			if (remaining > 0) {
				this.#box.addChild(new Text(theme.fg("dim", `… ${remaining} more agents`), 0, 0));
			}
		}

		// Expanded view: show full per-agent outputs (within task tool output caps)
		if (this.#expanded && this.#results && this.#results.length > 0) {
			this.#box.addChild(new Spacer(1));
			this.#box.addChild(new Text(theme.fg("dim", "Results"), 0, 0));

			for (const result of this.#results) {
				this.#box.addChild(new Spacer(1));
				const header = this.#formatResultHeader(result);
				this.#box.addChild(
					new Text(
						`${theme.fg(header.color, header.icon)} ${theme.fg("accent", truncateToWidth(replaceTabs(header.text), TRUNCATE_LENGTHS.LINE))}`,
						0,
						0,
					),
				);

				const raw = (result.output && result.output.trim().length > 0 ? result.output : result.stderr) || "";
				const content = replaceTabs(raw).trimEnd();
				const truncSuffix = result.truncated ? "\n\n[output truncated]" : "";
				const fenced = `\n\n\`\`\`\n${content || "(no output)"}${truncSuffix}\n\`\`\``;

				this.#box.addChild(
					new Markdown(fenced, 0, 0, getMarkdownTheme(), {
						color: (value: string) => theme.fg("customMessageText", value),
					}),
				);
			}
		}

		// Raw summary is useful but noisy. Keep it collapsed by default.
		const cleanSummary = replaceTabs(this.#summaryText).trim();
		if (cleanSummary) {
			this.#box.addChild(new Spacer(1));
			const lines = cleanSummary.split("\n");
			const maxLines = this.#expanded ? 12 : 3;
			const shown = lines.slice(0, maxLines).map(l => truncateToWidth(l, TRUNCATE_LENGTHS.LINE));
			for (const l of shown) {
				this.#box.addChild(new Text(theme.fg("customMessageText", l), 0, 0));
			}
			const remaining = lines.length - shown.length;
			if (remaining > 0) {
				this.#box.addChild(new Text(theme.fg("dim", `… ${remaining} more lines (Ctrl+O for more)`), 0, 0));
			}
		}
	}
}
