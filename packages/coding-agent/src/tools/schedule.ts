/**
 * Builtin `schedule` tool — one-shot session self-wake via session-schedule entries.
 *
 * Opt-in: the orchestrator gates construction/enablement on `schedule.enabled`
 * (default false). This module only exports the tool + renderer.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import scheduleDescription from "../prompts/tools/schedule.md" with { type: "text" };
import { resolveScheduleDueAtMs } from "../session/session-schedule";
import { framedBlock, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { formatErrorDetail, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const scheduleSchema = type({
	"delayMs?": type("number.integer >= 0").describe("relative delay in milliseconds"),
	"atIso?": type("string").describe("absolute due time as ISO-8601"),
	"prompt?": type("string").describe("prompt enqueued when the schedule fires"),
	"cancel?": type("string").describe("id of a pending schedule to cancel"),
});

export type ScheduleToolInput = typeof scheduleSchema.infer;

export type ScheduleToolDetails =
	| {
			op: "create";
			id: string;
			dueAtMs: number;
			prompt: string;
			createdAt: number;
			meta?: OutputMeta;
	  }
	| {
			op: "cancel";
			id: string;
			cancelled: boolean;
			meta?: OutputMeta;
	  };

function validateCreateInput(params: ScheduleToolInput): {
	delayMs?: number;
	atIso?: string;
	prompt: string;
} {
	const promptText = params.prompt?.trim();
	if (!promptText) {
		throw new ToolError("prompt is required when creating a schedule.");
	}
	const input = {
		delayMs: params.delayMs,
		atIso: params.atIso,
		prompt: promptText,
	};
	// Reuse the fold's due-time rules so the tool cannot drift from them; the
	// resolved time is discarded because the live controller resolves against its
	// own clock, but every rejection surfaces here as a ToolError.
	const due = resolveScheduleDueAtMs(input, Date.now());
	if ("error" in due) throw new ToolError(due.error);
	return input;
}

function validateCancelInput(params: ScheduleToolInput): string {
	const id = params.cancel?.trim();
	if (!id) throw new ToolError("cancel must be a non-empty schedule id.");
	if (params.delayMs !== undefined || params.atIso !== undefined || params.prompt !== undefined) {
		throw new ToolError("cancel cannot be combined with delayMs, atIso, or prompt.");
	}
	return id;
}

export class ScheduleTool implements AgentTool<typeof scheduleSchema, ScheduleToolDetails> {
	readonly name = "schedule";
	readonly approval = "write" as const;
	readonly label = "Schedule";
	readonly summary = "Schedule a one-shot wake prompt for this session";
	readonly description: string;
	readonly parameters = scheduleSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<ScheduleToolInput>) =>
		args.cancel ? `cancel schedule ${args.cancel}` : args.prompt ? `schedule: ${args.prompt}` : "schedule";

	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(scheduleDescription);
	}

	static createIf(session: ToolSession): ScheduleTool | null {
		if (!session.settings.get("schedule.enabled") || session.isTopLevelSession?.() !== true) return null;
		return new ScheduleTool(session);
	}

	async execute(
		_toolCallId: string,
		params: ScheduleToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ScheduleToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ScheduleToolDetails>> {
		if (params.cancel !== undefined) {
			const id = validateCancelInput(params);
			const controller = this.#session.getSessionSchedule?.();
			if (!controller) throw new ToolError("Session schedule controller is unavailable.");
			const cancelled = controller.cancel(id);
			return toolResult<ScheduleToolDetails>({ op: "cancel", id, cancelled })
				.text(cancelled ? `Cancelled schedule ${id}.` : `No pending schedule ${id}; cancel recorded.`)
				.done();
		}

		const input = validateCreateInput(params);
		const controller = this.#session.getSessionSchedule?.();
		if (!controller) throw new ToolError("Session schedule controller is unavailable.");
		const created = controller.create(input);

		const dueLabel = new Date(created.dueAtMs).toISOString();
		return toolResult<ScheduleToolDetails>({
			op: "create",
			id: created.id,
			dueAtMs: created.dueAtMs,
			prompt: created.prompt,
			createdAt: created.createdAt,
		})
			.text(`Scheduled ${created.id} for ${dueLabel}.`)
			.done();
	}
}

interface ScheduleRenderArgs {
	delayMs?: number;
	atIso?: string;
	prompt?: string;
	cancel?: string;
}

/**
 * Streamed/partial tool calls hand the renderer arbitrary decoded JSON, so every
 * field is treated as unknown and narrowed before use. Model-supplied strings are
 * tab-replaced and width-capped so they cannot punch layout holes in the TUI.
 */
function coerceScheduleRenderArgs(args: unknown): ScheduleRenderArgs {
	if (!isRecord(args)) return {};
	return {
		delayMs: typeof args.delayMs === "number" ? args.delayMs : undefined,
		atIso: typeof args.atIso === "string" ? args.atIso : undefined,
		prompt: typeof args.prompt === "string" ? args.prompt : undefined,
		cancel: typeof args.cancel === "string" ? args.cancel : undefined,
	};
}

function sanitizeMeta(value: string): string {
	return truncateToWidth(replaceTabs(value), TRUNCATE_LENGTHS.TITLE);
}

function describeCall(args: ScheduleRenderArgs): string {
	if (args.cancel) return "cancel";
	if (args.delayMs !== undefined) return `in ${args.delayMs}ms`;
	if (args.atIso) return `at ${sanitizeMeta(args.atIso)}`;
	return "create";
}

export const scheduleToolRenderer = {
	renderCall(rawArgs: unknown, _options: RenderResultOptions, uiTheme: Theme): Component {
		const args = coerceScheduleRenderArgs(rawArgs);
		const description = describeCall(args);
		const meta: string[] = [];
		const trimmed = args.prompt?.trim();
		if (trimmed) {
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${sanitizeMeta(trimmed)}"`)));
		}
		if (args.cancel) {
			meta.push(uiTheme.fg("muted", sanitizeMeta(args.cancel)));
		}
		return new Text(renderStatusLine({ icon: "pending", title: "Schedule", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ScheduleToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		rawArgs?: unknown,
	): Component {
		const fallbackText = result.content?.find(part => part.type === "text")?.text ?? "";
		const details = result.details;
		let description: string;
		if (details?.op === "cancel") {
			description = "cancel";
		} else if (details?.op === "create") {
			description = "create";
		} else {
			description = describeCall(coerceScheduleRenderArgs(rawArgs));
		}

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Schedule", description }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(fallbackText || "Schedule tool failed", uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const meta: string[] = [];
		if (details) {
			switch (details.op) {
				case "create":
					meta.push(uiTheme.fg("muted", details.id));
					meta.push(uiTheme.fg("muted", new Date(details.dueAtMs).toISOString()));
					break;
				case "cancel":
					meta.push(uiTheme.fg("muted", details.id));
					break;
				default: {
					const _exhaustive: never = details;
					void _exhaustive;
					break;
				}
			}
		}

		return new Text(
			renderStatusLine(
				{
					icon: "success",
					title: "Schedule",
					description,
					meta,
				},
				uiTheme,
			),
			0,
			0,
		);
	},
};
