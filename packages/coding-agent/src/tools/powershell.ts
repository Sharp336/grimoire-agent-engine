import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { $which, prompt } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import powershellDescription from "../prompts/tools/powershell.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, OutputSink, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import {
	formatStyledTruncationWarning,
	type OutputMeta,
	resolveOutputMaxColumns,
	resolveOutputSinkHeadBytes,
	stripOutputNotice,
} from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { acquirePsHost } from "./pshost-manager";
import { capPreviewLines, replaceTabs } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const powershellSchema = type({
	command: type("string").describe("PowerShell command to run in the persistent session"),
	"cwd?": type("string").describe("working directory for this command"),
	"timeout?": type("number").describe("timeout in seconds"),
});

type PowerShellToolParams = typeof powershellSchema.infer;

export interface PowerShellToolDetails {
	meta?: OutputMeta;
	/** PID of the backing pwsh host (attach with `Enter-PSHostProcess -Id`). */
	pid?: number;
	/** Monotonic execution id within the host. */
	execId?: number;
	exitCode?: number;
	hadErrors?: boolean;
}

export class PowerShellTool implements AgentTool<typeof powershellSchema, PowerShellToolDetails> {
	readonly name = "powershell";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<PowerShellToolParams>;
		const command = typeof params.command === "string" ? params.command : "(missing)";
		return [`Command: ${truncateForPrompt(command)}`];
	};
	readonly summary =
		"Execute PowerShell in a persistent host whose session state (variables, modules, last result objects) is retained across calls";
	readonly loadMode = "discoverable";
	readonly label = "PowerShell";
	readonly parameters = powershellSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly description: string;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(powershellDescription);
	}

	async execute(
		_toolCallId: string,
		{ command, cwd, timeout: rawTimeout }: PowerShellToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PowerShellToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<PowerShellToolDetails>> {
		const settings = this.session.settings;
		const timeoutSec = clampTimeout("powershell", rawTimeout);

		const host = await acquirePsHost({
			sessionId: this.session.getSessionId?.() ?? "default",
			cwd: this.session.cwd,
			shellPath: settings.get("powershell.shellPath")?.trim() || undefined,
			historyDepth: settings.get("powershell.historyDepth"),
			idleTtlMs: settings.get("powershell.idleTtlMs"),
		});

		const resolvedCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : undefined;
		const width = settings.get("powershell.outputWidth");

		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("powershell")) ?? {};
		const sink = new OutputSink({
			onChunk: streamTailUpdates(tailBuffer, onUpdate),
			artifactPath,
			artifactId,
			headBytes: resolveOutputSinkHeadBytes(settings),
			maxColumns: resolveOutputMaxColumns(settings),
		});

		const result = await host.run(
			{ command, cwd: resolvedCwd, width, timeoutMs: timeoutSec * 1000, signal },
			(_err, chunk) => sink.push(chunk),
		);
		const summary = await sink.dump();
		const outputText = summary.output || "(no output)";

		if (result.timedOut) {
			throw new ToolError(`${outputText}\n\nCommand timed out after ${timeoutSec} seconds`);
		}
		if (result.cancelled) {
			throw new ToolAbortError(outputText === "(no output)" ? "Command aborted" : outputText);
		}

		const exitCode = result.exitCode ?? undefined;
		const nonZeroExit = exitCode !== undefined && exitCode !== 0;
		const failed = result.hadErrors || nonZeroExit;

		const details: PowerShellToolDetails = {
			pid: host.pid,
			execId: result.execId,
			exitCode,
			hadErrors: result.hadErrors,
		};

		const note = nonZeroExit
			? `Command exited with code ${exitCode}`
			: result.hadErrors
				? "Command reported errors"
				: undefined;
		const finalText = note ? `${outputText}\n\n${note}` : outputText;

		const builder = toolResult(details).text(finalText).truncationFromSummary(summary, { direction: "tail" });
		if (failed) builder.error();
		return builder.done();
	}
}

/** Factory: only expose the tool when a pwsh executable is resolvable. */
export async function loadPowerShellTool(session: ToolSession): Promise<PowerShellTool | null> {
	const settings = session.settings;
	const shellPath = settings.get("powershell.shellPath")?.trim();
	const probe = shellPath || "pwsh";
	const resolved = await $which(probe);
	if (!resolved) return null;
	return new PowerShellTool(session);
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface PowerShellRenderArgs {
	command?: string;
}

interface PowerShellRenderContext {
	/** Visual lines for truncated output (pre-computed by tool-execution) */
	visualLines?: string[];
	/** Number of lines skipped */
	skippedCount?: number;
	/** Total visual lines */
	totalVisualLines?: number;
}

function formatPowerShellCommandLines(command: string, uiTheme: Theme): string[] {
	const sanitized = replaceTabs(command);
	const rawLines = sanitized.length > 0 ? sanitized.split("\n") : ["…"];
	const prefix = uiTheme.fg("dim", "PS> ");
	return rawLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

export const powershellToolRenderer = {
	renderCall(args: PowerShellRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const command = args.command ?? "";
		const header = renderStatusLine({ icon: "pending", title: "PowerShell", description: "" }, uiTheme);
		const cmdLines = formatPowerShellCommandLines(command, uiTheme);
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render: (width: number): readonly string[] =>
				outputBlock.render(
					{
						header,
						state: "pending",
						sections: [{ lines: capPreviewLines(cmdLines, uiTheme, { expanded: _options.expanded }) }],
						width,
					},
					uiTheme,
				),
			invalidate: () => {
				outputBlock.invalidate();
			},
		});
	},

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: PowerShellToolDetails;
		},
		options: RenderResultOptions & { renderContext?: PowerShellRenderContext },
		uiTheme: Theme,
		args?: PowerShellRenderArgs,
	): Component {
		const details = result.details;
		const command = args?.command ?? "";
		const header = renderStatusLine({ icon: "success", title: "PowerShell", description: "" }, uiTheme);
		const cmdLines = formatPowerShellCommandLines(command, uiTheme);
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
		const outputBlock = new CachedOutputBlock();

		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const { expanded, renderContext } = options;
				const output = stripOutputNotice(textContent, details?.meta).trimEnd();
				const outputLines: string[] = [];

				if (output) {
					if (expanded) {
						outputLines.push(...output.split("\n").map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
					} else if (renderContext?.visualLines) {
						const { visualLines, skippedCount = 0, totalVisualLines = visualLines.length } = renderContext;
						if (skippedCount > 0) {
							outputLines.push(
								uiTheme.fg(
									"dim",
									`… (${skippedCount} earlier lines, showing ${visualLines.length} of ${totalVisualLines}) (ctrl+o to expand)`,
								),
							);
						}
						const styledVisual = visualLines.map(line =>
							line.includes("\x1b[") ? replaceTabs(line) : uiTheme.fg("toolOutput", replaceTabs(line)),
						);
						outputLines.push(...styledVisual);
					} else {
						const outputLinesRaw = output.split("\n");
						const maxLines = 5;
						const displayLines = outputLinesRaw.slice(0, maxLines);
						const remaining = outputLinesRaw.length - maxLines;
						outputLines.push(...displayLines.map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
						if (remaining > 0) {
							outputLines.push(uiTheme.fg("dim", `… (${remaining} more lines) (ctrl+o to expand)`));
						}
					}
				}

				if (details?.meta?.truncation) {
					const warning = formatStyledTruncationWarning(details.meta, uiTheme);
					if (warning) outputLines.push(warning);
				}

				return outputBlock.render(
					{
						header,
						state: "success",
						sections: [
							{ lines: capPreviewLines(cmdLines, uiTheme, { expanded }) },
							{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
						],
						width,
					},
					uiTheme,
				);
			},
			invalidate: () => {
				outputBlock.invalidate();
			},
		});
	},
	mergeCallAndResult: true,
	provisionalPendingPreview: "collapsed",
};
