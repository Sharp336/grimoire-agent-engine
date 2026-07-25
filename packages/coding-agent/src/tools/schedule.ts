/**
 * Builtin `schedule` tool — one-shot session self-wake via session-schedule entries.
 *
 * Opt-in: the orchestrator gates construction/enablement on `schedule.enabled`
 * (default false). This module only exports the tool + renderer.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import scheduleDescription from "../prompts/tools/schedule.md" with { type: "text" };
import {
	type PendingSessionSchedule,
	resolveScheduleDueAtMs,
	SESSION_SCHEDULE_CUSTOM_TYPE,
	type SessionScheduleController,
	type SessionScheduleCreateData,
} from "../session/session-schedule";
import { framedBlock, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { formatErrorDetail, TRUNCATE_LENGTHS } from "./render-utils";
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

function requireSessionManager(session: ToolSession): NonNullable<ToolSession["sessionManager"]> {
	const manager = session.sessionManager;
	if (!manager) throw new ToolError("Session manager is unavailable; cannot persist schedules.");
	return manager;
}

function validateCreateInput(params: ScheduleToolInput): {
	delayMs?: number;
	atIso?: string;
	prompt: string;
} {
	const promptText = params.prompt?.trim();
	if (!promptText) {
		throw new ToolError("prompt is required when creating a schedule.");
	}
	const hasDelay = params.delayMs !== undefined;
	const hasAt = params.atIso !== undefined;
	if (hasDelay === hasAt) {
		throw new ToolError("Exactly one of delayMs or atIso must be supplied.");
	}
	if (hasDelay && (params.delayMs === undefined || !Number.isInteger(params.delayMs) || params.delayMs < 0)) {
		throw new ToolError("delayMs must be a non-negative integer.");
	}
	if (hasAt && (params.atIso === undefined || params.atIso.trim().length === 0)) {
		throw new ToolError("atIso must be a non-empty ISO-8601 timestamp.");
	}
	return {
		delayMs: params.delayMs,
		atIso: params.atIso,
		prompt: promptText,
	};
}

function validateCancelInput(params: ScheduleToolInput): string {
	const id = params.cancel?.trim();
	if (!id) throw new ToolError("cancel must be a non-empty schedule id.");
	if (params.delayMs !== undefined || params.atIso !== undefined || params.prompt !== undefined) {
		throw new ToolError("cancel cannot be combined with delayMs, atIso, or prompt.");
	}
	return id;
}

function persistCreateWithoutController(
	session: ToolSession,
	input: { delayMs?: number; atIso?: string; prompt: string },
	nowMs: number,
): PendingSessionSchedule {
	const manager = requireSessionManager(session);
	const due = resolveScheduleDueAtMs(input, nowMs);
	if ("error" in due) throw new ToolError(due.error);

	const schedule: SessionScheduleCreateData = {
		id: String(Snowflake.next()),
		dueAtMs: due.dueAtMs,
		prompt: input.prompt,
		createdAt: nowMs,
	};
	manager.appendCustomEntry(SESSION_SCHEDULE_CUSTOM_TYPE, schedule);
	return schedule;
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
		// Enablement is owned by tools/index.ts (`schedule.enabled`, default false).
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
			let cancelled: boolean;
			if (controller) {
				cancelled = controller.cancel(id);
			} else {
				requireSessionManager(this.#session).appendCustomEntry(SESSION_SCHEDULE_CUSTOM_TYPE, {
					id,
					cancelled: true,
				});
				cancelled = true;
			}
			return toolResult<ScheduleToolDetails>({ op: "cancel", id, cancelled })
				.text(cancelled ? `Cancelled schedule ${id}.` : `No pending schedule ${id}; cancel recorded.`)
				.done();
		}

		const input = validateCreateInput(params);
		const controller = this.#session.getSessionSchedule?.();
		const created = controller
			? controller.create(input)
			: persistCreateWithoutController(this.#session, input, Date.now());

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

function describeCall(args: ScheduleRenderArgs | undefined): string {
	if (args?.cancel) return "cancel";
	if (args?.delayMs !== undefined) return `in ${args.delayMs}ms`;
	if (args?.atIso) return `at ${args.atIso}`;
	return "create";
}

export const scheduleToolRenderer = {
	renderCall(args: ScheduleRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeCall(args);
		const meta: string[] = [];
		const trimmed = args?.prompt?.trim();
		if (trimmed) {
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${truncateToWidth(trimmed, TRUNCATE_LENGTHS.TITLE)}"`)));
		}
		if (args?.cancel) {
			meta.push(uiTheme.fg("muted", args.cancel));
		}
		return new Text(renderStatusLine({ icon: "pending", title: "Schedule", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ScheduleToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: ScheduleRenderArgs,
	): Component {
		const fallbackText = result.content?.find(part => part.type === "text")?.text ?? "";
		const details = result.details;
		let description: string;
		if (details?.op === "cancel") {
			description = "cancel";
		} else if (details?.op === "create") {
			description = "create";
		} else {
			description = describeCall(args);
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
