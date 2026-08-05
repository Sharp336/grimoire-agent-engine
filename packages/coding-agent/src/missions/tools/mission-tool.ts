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
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import missionDescription from "../../prompts/tools/mission.md" with { type: "text" };
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { toolResult } from "../../tools/tool-result";
import { MissionRuntimeError } from "../runtime";
import type { MissionToolDetails } from "./mission-render";

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
