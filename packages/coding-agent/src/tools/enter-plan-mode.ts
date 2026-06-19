/**
 * Enter Plan Mode tool — agent-initiated entry into read-only plan mode.
 *
 * Mirrors Claude Code's `EnterPlanMode`: the agent decides on its own that a
 * task warrants planning, calls this tool, and the host (interactive TUI or
 * ACP) switches the session into plan mode. The actual mode transition lives in
 * the frontend (`InteractiveMode.#enterPlanMode` / `AcpAgent.#applyModeChange`)
 * and is reached through `ToolSession.requestEnterPlanMode`, installed by that
 * frontend. Hosts without a handler (print/headless, subagents) never expose
 * this tool — see the `supportsAgentPlanEntry` gate in `createTools`.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { z } from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import enterPlanModeDescription from "../prompts/tools/enter-plan-mode.md" with { type: "text" };
import { Ellipsis, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";

const enterPlanModeSchema = z.object({
	reason: z.string().describe("one short sentence on why planning is warranted").optional(),
});

export type EnterPlanModeInput = z.infer<typeof enterPlanModeSchema>;

export interface EnterPlanModeDetails {
	entered: boolean;
	reason?: string;
}

export class EnterPlanModeTool implements AgentTool<typeof enterPlanModeSchema, EnterPlanModeDetails> {
	readonly name = "enter_plan_mode";
	readonly label = "Plan Mode";
	readonly approval = "read" as const;
	readonly description = prompt.render(enterPlanModeDescription);
	readonly parameters = enterPlanModeSchema;
	readonly intent = (args: Partial<EnterPlanModeInput>) => args.reason?.trim() || "entering plan mode";
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	static createIf(session: ToolSession): EnterPlanModeTool | null {
		return session.supportsAgentPlanEntry ? new EnterPlanModeTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: EnterPlanModeInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<EnterPlanModeDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<EnterPlanModeDetails>> {
		const reason = params.reason?.trim() || undefined;
		if (this.#session.getPlanModeState?.()?.enabled) {
			return {
				content: [{ type: "text", text: "Already in plan mode." }],
				details: { entered: false, reason },
			};
		}
		const goalState = this.#session.getGoalModeState?.();
		if (goalState?.enabled || goalState?.goal.status === "paused") {
			throw new ToolError("Exit goal mode before entering plan mode.");
		}
		if (!this.#session.canEnterPlanMode?.() || !this.#session.requestEnterPlanMode) {
			throw new ToolError("Plan mode entry is not available in this session.");
		}
		await this.#session.requestEnterPlanMode();
		return {
			content: [
				{
					type: "text",
					text: 'Entered plan mode. The working tree is now read-only — research, ground every claim in real code, and draft your plan to a `local://<slug>-plan.md` file, then call `resolve` with `action: "apply"` and `extra: { title: "<slug>" }` to submit it for approval.',
				},
			],
			details: { entered: true, reason },
		};
	}
}

export const enterPlanModeToolRenderer = {
	renderCall(args: EnterPlanModeInput, _options: RenderResultOptions, uiTheme: Theme): Component {
		const reasonTrimmed = args?.reason?.trim();
		const reason = reasonTrimmed
			? truncateToWidth(replaceTabs(reasonTrimmed), TRUNCATE_LENGTHS.CONTENT, Ellipsis.Omit)
			: undefined;
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Enter plan mode",
				meta: reason ? [uiTheme.fg("muted", reason)] : undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EnterPlanModeDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const entered = result.details?.entered === true && !result.isError;
		const title = result.isError ? "Plan mode" : entered ? "Plan mode enabled" : "Plan mode unchanged";
		const text = renderStatusLine(
			{
				icon: result.isError ? "error" : entered ? "success" : "info",
				title,
				badge: result.isError
					? { label: "error", color: "error" }
					: entered
						? { label: "read-only", color: "success" }
						: undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	mergeCallAndResult: true,
	inline: true,
};
