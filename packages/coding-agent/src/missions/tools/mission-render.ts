/**
 * Presentation half of the hidden `mission` tool.
 *
 * Kept apart from `mission-tool.ts` on purpose: `tools/renderers.ts` needs the
 * renderer at module scope, and `mission-tool.ts` reaches `MissionRuntime`,
 * which pulls the task executor back around into `tools`. Importing the tool
 * module from the renderer table closed that loop and left
 * `missionToolRenderer` in its temporal dead zone. This module imports only
 * TUI and type leaves, so the table can depend on it safely.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import type { OutputMeta } from "../../tools/output-meta";
import { formatErrorDetail, replaceTabs, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { framedBlock, renderStatusLine, truncateToWidth } from "../../tui";
import type { MissionHandoffDecision, MissionStatus } from "../types";

export type MissionToolDetails =
	| { op: "get"; status: MissionStatus | "none"; meta?: OutputMeta }
	| { op: "set_plan"; status: MissionStatus; milestoneCount: number; featureCount: number; meta?: OutputMeta }
	| { op: "run_next"; handoff: "implementation" | "validation" | "none"; meta?: OutputMeta }
	| { op: "resolve_handoff"; decision: MissionHandoffDecision; status: MissionStatus; meta?: OutputMeta }
	| { op: "revise_pending"; status: MissionStatus; addedFeatures: number; meta?: OutputMeta };

interface MissionRenderArgs {
	op?: "get" | "set_plan" | "run_next" | "resolve_handoff" | "revise_pending";
	decision?: string;
	message_to_worker?: string;
}

/**
 * Streamed/partial tool calls hand the renderer arbitrary decoded JSON, so every
 * field is treated as unknown and narrowed before use. Model-supplied strings are
 * tab-replaced and width-capped so they cannot punch layout holes in the TUI.
 */
function coerceMissionRenderArgs(args: unknown): MissionRenderArgs {
	if (!isRecord(args)) return {};
	const op = args.op;
	return {
		op:
			op === "get" || op === "set_plan" || op === "run_next" || op === "resolve_handoff" || op === "revise_pending"
				? op
				: undefined,
		decision: typeof args.decision === "string" ? args.decision : undefined,
		message_to_worker: typeof args.message_to_worker === "string" ? args.message_to_worker : undefined,
	};
}

function sanitizeMeta(value: string): string {
	return truncateToWidth(replaceTabs(value), TRUNCATE_LENGTHS.TITLE);
}

function describeOp(op: MissionRenderArgs["op"]): string {
	switch (op) {
		case "get":
			return "get";
		case "set_plan":
			return "set plan";
		case "run_next":
			return "run next";
		case "resolve_handoff":
			return "resolve handoff";
		case "revise_pending":
			return "revise pending";
		default:
			return op ?? "?";
	}
}

export const missionToolRenderer = {
	renderCall(rawArgs: unknown, _options: RenderResultOptions, uiTheme: Theme): Component {
		const args = coerceMissionRenderArgs(rawArgs);
		const description = describeOp(args.op);
		const meta: string[] = [];
		if (args.op === "resolve_handoff" && args.decision) {
			meta.push(uiTheme.fg("muted", sanitizeMeta(args.decision)));
		}
		const message = args.message_to_worker?.trim();
		if (message) {
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${sanitizeMeta(message)}"`)));
		}
		return new Text(renderStatusLine({ icon: "pending", title: "Mission", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: MissionToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		rawArgs?: unknown,
	): Component {
		const fallbackText = result.content?.find(part => part.type === "text")?.text ?? "";
		const details = result.details;
		const description = describeOp(details?.op ?? coerceMissionRenderArgs(rawArgs).op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Mission", description }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(fallbackText || "Mission tool failed", uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const meta: string[] = [];
		if (details) {
			switch (details.op) {
				case "get":
					meta.push(uiTheme.fg("muted", details.status));
					break;
				case "set_plan":
					meta.push(uiTheme.fg("muted", details.status));
					meta.push(uiTheme.fg("muted", `${details.milestoneCount}m/${details.featureCount}f`));
					break;
				case "run_next":
					meta.push(uiTheme.fg("muted", details.handoff));
					break;
				case "resolve_handoff":
					meta.push(uiTheme.fg("muted", details.decision));
					meta.push(uiTheme.fg("muted", details.status));
					break;
				case "revise_pending":
					meta.push(uiTheme.fg("muted", details.status));
					meta.push(uiTheme.fg("muted", `+${details.addedFeatures}`));
					break;
				default: {
					const _exhaustive: never = details;
					void _exhaustive;
					break;
				}
			}
		}

		return new Text(renderStatusLine({ icon: "success", title: "Mission", description, meta }, uiTheme), 0, 0);
	},
};
