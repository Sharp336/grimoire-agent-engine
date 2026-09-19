import type { Agent, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { LocalProtocolOptions } from "../internal-urls";
import { resolveApprovedPlan } from "../plan-mode/approved-plan";
import { listPlanFiles, readPlanFile } from "../plan-mode/plan-files";
import type { PlanModeState } from "../plan-mode/state";
import planYoloHandoffPrompt from "../prompts/system/plan-yolo-handoff.md" with { type: "text" };
import { type ConfiguredThinkingLevel } from "../thinking";
import { isMCPToolName } from "../tools/builtin-names";
import type { PlanProposalHandler } from "../tools/resolve";
import { ToolError } from "../tools/tool-errors";
import type { PlanYolo } from "./agent-session-types";
import type { SessionManager } from "./session-manager";

const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";

/** Capabilities the plan-yolo coordinator borrows from its owning session. */
export interface PlanYoloCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
	setActiveToolsByName(names: string[]): Promise<void>;
	setActiveToolPresentation(toolNames: string[], mountedToolNames: string[]): Promise<void>;
	runToolRegistryMutation<T>(mutation: () => Promise<T>): Promise<T>;
	getEnabledToolNames(): string[];
	getSelectedMCPToolNames(): string[];
	getMountedXdevToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	getPlanReferencePath(): string;
	setPlanProposalHandler(handler: PlanProposalHandler | null): void;
	localProtocolOptions(): LocalProtocolOptions;
}

/** Initial plan-yolo startup state. */
export interface PlanYoloCoordinatorOptions {
	planYolo?: PlanYolo;
}

/** Coordinates automatic plan-yolo handoffs. */
export class PlanYoloCoordinator {
	readonly #host: PlanYoloCoordinatorHost;
	#planYolo: PlanYolo | undefined;
	#planYoloPreviousNonMCPPresentation: { enabled: string[]; mounted: string[] } | undefined;
	#planYoloArmed = false;

	constructor(host: PlanYoloCoordinatorHost, options: PlanYoloCoordinatorOptions = {}) {
		this.#host = host;
		this.#planYolo = options.planYolo;
	}

	/** Lazily enables plan-yolo's plan phase before the first prompt is built. */
	async armPlanYoloIfNeeded(): Promise<void> {
		if (!this.#planYolo || this.#planYoloArmed) return;
		this.#planYoloArmed = true;
		const previousEnabledTools = this.#host.getEnabledToolNames();
		const previousMountedTools = this.#host.getMountedXdevToolNames();
		const previousPlanModeState = this.#host.getPlanModeState();
		const planModeState: PlanModeState = {
			enabled: true,
			planFilePath: this.#host.getPlanReferencePath() || "local://PLAN.md",
			workflow: "parallel",
		};
		// PlanYolo's injected write is a plan transport, not a user grant. Publish
		// plan mode before applying the tool set so SessionTools keeps an existing
		// device-only write restricted.
		this.#host.setPlanModeState(planModeState);
		const augmentations = this.#host.hasBuiltInTool("write") ? ["write"] : [];
		try {
			await this.#host.setActiveToolsByName([...new Set([...previousEnabledTools, ...augmentations])]);
		} catch (error) {
			this.#host.setPlanModeState(previousPlanModeState);
			this.#planYoloArmed = false;
			throw error;
		}
		this.#planYoloPreviousNonMCPPresentation = {
			enabled: previousEnabledTools.filter(name => !isMCPToolName(name)),
			mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
		};
		this.#host.setPlanProposalHandler(title => this.#finalizePlanYoloProposal(title));
	}

	async #finalizePlanYoloProposal(title: string): Promise<AgentToolResult<unknown>> {
		const planYolo = this.#planYolo;
		const state = this.#host.getPlanModeState();
		if (!planYolo || !state?.enabled) throw new ToolError("Plan mode is not active.");
		const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url =>
				readPlanFile(url, {
					localProtocolOptions: this.#host.localProtocolOptions(),
					cwd: this.#host.sessionManager.getCwd(),
				}),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions: this.#host.localProtocolOptions() }),
		});
		this.#host.setPlanModeState(undefined);
		const previousPresentation = this.#planYoloPreviousNonMCPPresentation;
		try {
			if (previousPresentation) {
				await this.#host.runToolRegistryMutation(async () => {
					const liveMCP = this.#host.getSelectedMCPToolNames();
					const liveMountedMCP = this.#host.getMountedXdevToolNames().filter(isMCPToolName);
					await this.#host.setActiveToolPresentation(
						[...new Set([...previousPresentation.enabled, ...liveMCP])],
						[...new Set([...previousPresentation.mounted, ...liveMountedMCP])],
					);
				});
			}
		} catch (error) {
			this.#host.setPlanModeState(state);
			throw error;
		}
		this.#host.setPlanProposalHandler(null);
		this.#planYolo = undefined;
		this.#planYoloPreviousNonMCPPresentation = undefined;
		await this.#host.setModelTemporary(planYolo.target, planYolo.thinkingLevel, { ephemeral: true });
		this.#host.emitNotice(
			"info",
			`Plan-yolo: plan approved, switched to ${planYolo.target.provider}/${planYolo.target.id} to implement "${resolvedTitle}".`,
			"plan-yolo",
		);
		this.#host.agent.steer({
			role: "custom",
			customType: PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
			content: prompt.render(planYoloHandoffPrompt, { planFilePath, title: resolvedTitle }),
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
		return {
			content: [{ type: "text", text: `Plan approved. Implementing now with ${planYolo.target.id}.` }],
			details: { planFilePath, title: resolvedTitle, planExists: true },
		};
	}
}
