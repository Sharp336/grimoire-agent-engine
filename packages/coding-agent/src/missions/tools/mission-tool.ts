/**
 * Hidden parent-only `mission` tool — the model's only handle on an active
 * mission's lifecycle. `MissionRuntime` activates it by name while a mission is
 * nonterminal (see `runtime.ts#activateTool`), so it lives in `HIDDEN_TOOLS` and
 * is registered into the session tool registry (sdk.ts) even though it never
 * joins the default active set.
 *
 * The op set mirrors exactly what the mission prompts instruct the model to call
 * (`prompts/missions/active.md`): `get`, `set_plan`, `run_next`, `resolve_handoff`,
 * `revise_pending`. `accept`/`pause`/`resume`/`cancel` are host controls driven by
 * `/mission` or RPC, never model tool ops, so they are intentionally absent.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import missionDescription from "../../prompts/tools/mission.md" with { type: "text" };
import type { ToolSession } from "../../tools";
import type { OutputMeta } from "../../tools/output-meta";
import { formatErrorDetail, replaceTabs, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { ToolError } from "../../tools/tool-errors";
import { toolResult } from "../../tools/tool-result";
import { framedBlock, renderStatusLine, truncateToWidth } from "../../tui";
import { MissionRuntimeError } from "../runtime";
import type { MissionHandoffDecision, MissionStatus } from "../types";

const remediationFeatureSchema = type({
	id: type("string").describe("stable remediation feature id"),
	description: type("string").describe("what this remediation feature must accomplish"),
	"skillName?": type("string").describe("existing loaded skill this feature should use"),
	preconditions: type("string[]").describe("feature ids that must complete first"),
	expectedBehavior: type("string[]").describe("observable acceptance criteria"),
	"fulfills?": type("string[]").describe("issue ids this remediation resolves"),
});

const runbookServiceSchema = type({
	name: "string",
	start: "string",
	ready: "string",
	"stop?": "string",
	"logs?": "string",
});

const runbookSchema = type({
	setup: "string[]",
	services: runbookServiceSchema.array(),
	userTests: "string[]",
});

const milestoneSpecSchema = type({
	id: "string",
	description: "string",
	featureIds: "string[]",
	validators: type("'scrutiny' | 'user-testing'").array(),
});

const featureSpecSchema = type({
	id: "string",
	description: "string",
	"skillName?": "string",
	milestoneId: "string",
	preconditions: "string[]",
	expectedBehavior: "string[]",
	"fulfills?": "string[]",
});

const planSchema = type({
	goal: "string",
	runbook: runbookSchema,
	milestones: milestoneSpecSchema.array(),
	features: featureSpecSchema.array(),
});

/**
 * Discriminated on `op` so each variant carries exactly the fields its
 * `MissionRuntime` method needs — invalid combinations (a `plan` on `run_next`,
 * a `decision` on `set_plan`) are unrepresentable rather than optionally ignored.
 */
const missionSchema = type({ op: "'get'" })
	.or({ op: "'set_plan'", plan: planSchema })
	.or({ op: "'run_next'" })
	.or({
		op: "'resolve_handoff'",
		decision: type("'accept' | 'retry_same' | 'retry_fresh' | 'cancel_feature' | 'pause'").describe(
			"how to clear the pending handoff",
		),
		"message_to_worker?": type("string").describe("guidance carried into a retry"),
	})
	.or({ op: "'revise_pending'", add_features: remediationFeatureSchema.array() });

export type MissionToolInput = typeof missionSchema.infer;

export type MissionToolDetails =
	| { op: "get"; status: MissionStatus | "none"; meta?: OutputMeta }
	| { op: "set_plan"; status: MissionStatus; milestoneCount: number; featureCount: number; meta?: OutputMeta }
	| { op: "run_next"; handoff: "implementation" | "validation" | "none"; meta?: OutputMeta }
	| { op: "resolve_handoff"; decision: MissionHandoffDecision; status: MissionStatus; meta?: OutputMeta }
	| { op: "revise_pending"; status: MissionStatus; addedFeatures: number; meta?: OutputMeta };

export class MissionTool implements AgentTool<typeof missionSchema, MissionToolDetails> {
	readonly name = "mission";
	readonly label = "Mission";
	readonly summary = "Drive an active mission through its lifecycle";
	readonly description = prompt.render(missionDescription);
	readonly parameters = missionSchema;
	readonly strict = true;
	readonly intent = "omit" as const;

	readonly #session: ToolSession;

	constructor(session: ToolSession) {
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
		if (!runtime) {
			throw new ToolError("No active mission for this session.");
		}
		try {
			switch (params.op) {
				case "get": {
					const state = runtime.snapshot();
					if (!state) {
						return toolResult<MissionToolDetails>({ op: "get", status: "none" })
							.text("No active mission.")
							.done();
					}
					const active = state.activeRun ? `\nActive feature: ${state.activeRun.featureId}` : "";
					const pending = state.pendingHandoff ? `\nPending handoff: ${state.pendingHandoff.kind}` : "";
					return toolResult<MissionToolDetails>({ op: "get", status: state.status })
						.text(
							`Mission ${state.id}\nStatus: ${state.status}\n` +
								`${state.milestones.length} milestones, ${state.features.length} features${active}${pending}`,
						)
						.done();
				}
				case "set_plan": {
					const state = await runtime.setPlan(params.plan);
					return toolResult<MissionToolDetails>({
						op: "set_plan",
						status: state.status,
						milestoneCount: state.milestones.length,
						featureCount: state.features.length,
					})
						.text(
							`Plan set. Status: ${state.status}. ` +
								`${state.milestones.length} milestones, ${state.features.length} features.`,
						)
						.done();
				}
				case "run_next": {
					const handoff = await runtime.runNext(signal);
					if (!handoff) {
						return toolResult<MissionToolDetails>({ op: "run_next", handoff: "none" })
							.text("No feature is currently runnable.")
							.done();
					}
					const verdict =
						handoff.kind === "validation" ? `verdict ${handoff.verdict}` : `outcome ${handoff.outcome}`;
					return toolResult<MissionToolDetails>({ op: "run_next", handoff: handoff.kind })
						.text(`Handoff (${handoff.kind}, ${verdict}): ${handoff.summary}`)
						.done();
				}
				case "resolve_handoff": {
					const state = await runtime.resolveHandoff({
						decision: params.decision,
						messageToWorker: params.message_to_worker,
					});
					return toolResult<MissionToolDetails>({
						op: "resolve_handoff",
						decision: params.decision,
						status: state.status,
					})
						.text(`Handoff resolved (${params.decision}). Status: ${state.status}.`)
						.done();
				}
				case "revise_pending": {
					const state = await runtime.revisePending({ addFeatures: params.add_features });
					return toolResult<MissionToolDetails>({
						op: "revise_pending",
						status: state.status,
						addedFeatures: params.add_features.length,
					})
						.text(`Added ${params.add_features.length} remediation feature(s). Status: ${state.status}.`)
						.done();
				}
				default: {
					const _exhaustive: never = params;
					void _exhaustive;
					throw new ToolError("Unknown mission op.");
				}
			}
		} catch (error) {
			if (error instanceof MissionRuntimeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}
	}
}

interface MissionRenderArgs {
	op?: MissionToolInput["op"];
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
