/**
 * Hidden parent-only `mission` tool.
 *
 * Mirrors `goals/tools/goal-tool.ts`: the tool is a thin, strictly-typed façade
 * over the session-owned runtime. Every mutation is delegated to
 * {@link MissionRuntimeContract}; this file never writes mission state, never
 * touches Git, and never exposes the host-only transitions (`accept`, `pause`,
 * `resume`, `cancel`).
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import {
	MISSION_WORKER_TURN_CAP,
	type MissionFeature,
	type MissionHandoff,
	type MissionMilestone,
	type MissionPlan,
	type MissionRemediationFeatureSpec,
	type MissionRuntimeContract,
	type MissionState,
	type MissionStatus,
} from "../missions/types";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import missionDescription from "../prompts/tools/mission.md" with { type: "text" };
import { framedBlock, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import { formatErrorDetail, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";

export interface MissionSessionAccessors {
	getMissionRuntime?: () => MissionRuntimeContract | undefined;
	getMissionState?: () => MissionState | null;
}

export type MissionToolSession = ToolSession & MissionSessionAccessors;

const MissionServiceSchema = type({
	name: type("string").describe("service name"),
	start: type("string").describe("command that starts the service"),
	ready: type("string").describe("command or probe proving readiness"),
	"stop?": type("string").describe("command that stops the service"),
	"logs?": type("string").describe("command that tails logs"),
});

const MissionRunbookSchema = type({
	setup: type("string").array().describe("idempotent setup commands"),
	services: MissionServiceSchema.array().describe("long-running services the runbook manages"),
	userTests: type("string").array().describe("user-facing verification commands"),
});

const MissionMilestoneSchema = type({
	id: type("string").describe("milestone id"),
	description: type("string").describe("what this milestone delivers"),
	featureIds: type("string").array().atLeastLength(1).describe("implementation feature ids in this milestone"),
	validators: type('"scrutiny" | "user-testing"')
		.array()
		.atLeastLength(1)
		.describe("validator roles, in the order they must run"),
});

const MissionFeatureSchema = type({
	id: type("string").describe("feature id"),
	description: type("string").describe("what the worker must implement"),
	"skillName?": type("string").describe("name of an existing loaded skill the worker must read"),
	milestoneId: type("string").describe("owning milestone id"),
	preconditions: type("string").array().describe("feature ids that must complete first"),
	expectedBehavior: type("string").array().atLeastLength(1).describe("observable acceptance criteria"),
	"fulfills?": type("string").array().describe("requirement ids this feature satisfies"),
});

const MissionPlanSchema = type({
	goal: type("string").describe("mission goal"),
	runbook: MissionRunbookSchema.describe("setup, services, and user tests"),
	milestones: MissionMilestoneSchema.array().atLeastLength(1).describe("ordered milestones"),
	features: MissionFeatureSchema.array().atLeastLength(1).describe("ordered implementation features"),
});

const MissionRemediationSchema = type({
	id: type("string").describe("remediation feature id"),
	description: type("string").describe("what must be fixed"),
	"skillName?": type("string").describe("name of an existing loaded skill the worker must read"),
	preconditions: type("string").array().describe("feature ids that must complete first"),
	expectedBehavior: type("string").array().atLeastLength(1).describe("observable acceptance criteria"),
	"fulfills?": type("string").array().describe("requirement ids this feature satisfies"),
});

const missionSchema = type({
	op: type("'get' | 'set_plan' | 'run_next' | 'resolve_handoff' | 'revise_pending'").describe("mission operation"),
	"plan?": MissionPlanSchema.describe("complete mission plan (set_plan)"),
	"decision?": type("'accept' | 'retry_same' | 'retry_fresh' | 'cancel_feature' | 'pause'").describe(
		"handoff resolution (resolve_handoff)",
	),
	"message_to_worker?": type("string").describe("message carried into a retried worker turn"),
	"add_features?": MissionRemediationSchema.array()
		.atLeastLength(1)
		.describe("remediation features for the failed validator's milestone (revise_pending)"),
});

export type MissionToolInput = typeof missionSchema.infer;
export type MissionToolOp = MissionToolInput["op"];
export type MissionHandoffDecision = NonNullable<MissionToolInput["decision"]>;

export interface MissionToolDetails {
	op: MissionToolOp;
	mission: MissionState | null;
	handoff?: MissionHandoff | null;
}

function requirePlan(params: MissionToolInput): MissionPlan {
	if (!params.plan) throw new ToolError("set_plan requires a complete `plan`.");
	return params.plan;
}

function requireDecision(params: MissionToolInput): { decision: MissionHandoffDecision; messageToWorker?: string } {
	if (!params.decision) throw new ToolError("resolve_handoff requires a `decision`.");
	const message = params.message_to_worker?.trim();
	return { decision: params.decision, ...(message ? { messageToWorker: message } : {}) };
}

function requireRemediation(params: MissionToolInput): MissionRemediationFeatureSpec[] {
	const features = params.add_features;
	if (!features || features.length === 0) throw new ToolError("revise_pending requires a nonempty `add_features`.");
	return features;
}

export function currentMissionFeature(state: MissionState | null): MissionFeature | undefined {
	if (!state) return undefined;
	const activeId = state.activeRun?.featureId;
	if (activeId) {
		const active = state.features.find(feature => feature.id === activeId);
		if (active) return active;
	}
	return state.features.find(feature => feature.status === "in_progress");
}

function milestoneOf(state: MissionState | null, feature: MissionFeature | undefined): MissionMilestone | undefined {
	if (!state || !feature) return undefined;
	return state.milestones.find(milestone => milestone.id === feature.milestoneId);
}

export function sanitizeMissionLine(value: string, maxWidth: number): string {
	return replaceTabs(truncateToWidth(value.replaceAll(/\s+/g, " ").trim(), maxWidth));
}

export function missionHandoffSummary(
	handoff: MissionHandoff | null | undefined,
	maxWidth: number,
): string | undefined {
	if (!handoff) return undefined;
	const blocking = handoff.issues.filter(issue => issue.severity === "blocking").length;
	const verdict =
		handoff.kind === "implementation" ? `implementation ${handoff.outcome}` : `${handoff.role} ${handoff.verdict}`;
	const suffix = blocking > 0 ? ` (${blocking} blocking)` : "";
	return sanitizeMissionLine(`${verdict}${suffix}: ${handoff.summary}`, maxWidth);
}

function describeOp(op: MissionToolOp | undefined): string {
	switch (op) {
		case "get":
			return "status";
		case "set_plan":
			return "plan";
		case "run_next":
			return "run next";
		case "resolve_handoff":
			return "resolve handoff";
		case "revise_pending":
			return "revise";
		default:
			return op ?? "?";
	}
}

function missionBadgeColor(status: MissionStatus): ThemeColor {
	switch (status) {
		case "completed":
			return "success";
		case "paused":
		case "awaiting_input":
		case "planning":
			return "warning";
		case "cancelled":
			return "muted";
		default:
			return "accent";
	}
}

function renderMissionText(state: MissionState | null, handoff: MissionHandoff | null | undefined): string {
	if (!state) return "No active mission.";
	const feature = currentMissionFeature(state);
	const milestone = milestoneOf(state, feature);
	const lines = [
		`Mission ${state.id}: ${state.status}${state.pauseReason ? ` (${state.pauseReason})` : ""}`,
		`Goal: ${state.goal || "(not set)"}`,
	];
	if (milestone) lines.push(`Milestone: ${milestone.id} — ${milestone.description}`);
	if (feature) {
		const role = feature.validator ? ` validator=${feature.validator}` : "";
		lines.push(
			`Feature: ${feature.id} (${feature.status}) turns ${feature.retryBudgetUsed}/${MISSION_WORKER_TURN_CAP}${role}`,
		);
	}
	if (state.pendingHandoff)
		lines.push(`Pending handoff: ${missionHandoffSummary(state.pendingHandoff, TRUNCATE_LENGTHS.RECAP) ?? ""}`);
	if (handoff === null) lines.push("Handoff this turn: none (nothing runnable)");
	lines.push("", `Snapshot: ${JSON.stringify(state)}`);
	return lines.join("\n");
}

export class MissionTool implements AgentTool<typeof missionSchema, MissionToolDetails> {
	readonly name = "mission";
	readonly label = "Mission";
	readonly description = prompt.render(missionDescription);
	readonly parameters = missionSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly approval = (args: unknown): ToolTier => {
		const op = args !== null && typeof args === "object" && "op" in args ? args.op : undefined;
		if (op === "get") return "read";
		if (op === "run_next") return "exec";
		return "write";
	};
	readonly #session: MissionToolSession;

	constructor(session: MissionToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: MissionToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<MissionToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<MissionToolDetails>> {
		const runtime = this.#session.getMissionRuntime?.();
		if (!runtime) throw new ToolError("No active owned mission.");
		let mission: MissionState | null;
		let handoff: MissionHandoff | null | undefined;
		switch (params.op) {
			case "get":
				mission = this.#session.getMissionState?.() ?? runtime.snapshot();
				break;
			case "set_plan":
				mission = await runtime.setPlan(requirePlan(params));
				break;
			case "run_next":
				handoff = await runtime.runNext(signal);
				mission = runtime.snapshot();
				break;
			case "resolve_handoff":
				mission = await runtime.resolveHandoff(requireDecision(params));
				break;
			case "revise_pending":
				mission = await runtime.revisePending({ addFeatures: requireRemediation(params) });
				break;
		}
		return {
			content: [{ type: "text", text: renderMissionText(mission, handoff) }],
			details: { op: params.op, mission, ...(handoff === undefined ? {} : { handoff }) },
		};
	}
}

interface MissionRenderArgs {
	op?: MissionToolOp;
	decision?: MissionHandoffDecision;
}

export const missionToolRenderer = {
	renderCall(args: MissionRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta = args.decision ? [uiTheme.fg("muted", args.decision)] : [];
		return new Text(
			renderStatusLine({ icon: "pending", title: "Mission", description: describeOp(args.op), meta }, uiTheme),
			0,
			0,
		);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: MissionToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: MissionRenderArgs,
	): Component {
		const fallbackText = result.content?.find(part => part.type === "text")?.text ?? "";
		const details = result.details;
		const description = describeOp(details?.op ?? args?.op);
		if (result.isError)
			return framedBlock(uiTheme, width => ({
				header: renderStatusLine({ icon: "error", title: "Mission", description }, uiTheme),
				sections: [{ lines: formatErrorDetail(fallbackText || "Mission tool failed", uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		const mission = details?.mission ?? null;
		if (!mission)
			return new Text(
				renderStatusLine({ icon: "warning", title: "Mission", description, meta: ["no active mission"] }, uiTheme),
				0,
				0,
			);
		const header = renderStatusLine(
			{
				icon: "success",
				title: "Mission",
				description,
				badge: { label: mission.status, color: missionBadgeColor(mission.status) },
			},
			uiTheme,
		);
		const feature = currentMissionFeature(mission);
		const milestone = milestoneOf(mission, feature);
		const lines = [
			uiTheme.italic(uiTheme.fg("muted", `"${sanitizeMissionLine(mission.goal, TRUNCATE_LENGTHS.LONG)}"`)),
		];
		const position: string[] = [];
		if (milestone) position.push(`milestone ${milestone.id}`);
		if (feature) {
			position.push(`feature ${feature.id}`);
			position.push(`${feature.retryBudgetUsed} / ${MISSION_WORKER_TURN_CAP} turns`);
			if (feature.validator) position.push(`validator ${feature.validator}`);
		}
		if (mission.pauseReason) position.push(`paused: ${mission.pauseReason}`);
		if (position.length > 0) lines.push(uiTheme.fg("dim", position.join(" · ")));
		const sections: Array<{ label?: string; lines: string[] }> = [{ lines }];
		const summary =
			missionHandoffSummary(details?.handoff, TRUNCATE_LENGTHS.LONG) ??
			missionHandoffSummary(mission.pendingHandoff, TRUNCATE_LENGTHS.LONG);
		if (summary) sections.push({ label: "Handoff", lines: [uiTheme.fg("muted", summary)] });
		return framedBlock(uiTheme, width => ({ header, sections, state: "success", borderColor: "borderMuted", width }));
	},
	mergeCallAndResult: true,
};
