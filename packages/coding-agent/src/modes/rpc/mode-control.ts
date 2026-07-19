import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { resolveLocalUrlToPath } from "../../internal-urls";
import { normalizePlanTitle, type PlanApprovalDetails, resolveApprovedPlan } from "../../plan-mode/approved-plan";
import type { PlanModeState } from "../../plan-mode/state";
import { normalizeLocalScheme } from "../../tools/path-utils";
import type { PlanProposalHandler } from "../../tools/resolve";
import { ToolError } from "../../tools/tool-errors";
import type { RpcMode } from "./rpc-types";

const DEFAULT_RPC_PLAN_FILE_URL = "local://PLAN.md";

export interface RpcModeControllerSession {
	settings: { get(path: "plan.enabled"): boolean };
	sessionManager: {
		getArtifactsDir(): string | null;
		getSessionId(): string;
		getCwd(): string;
	};
	hasPlanYoloWorkflow(): boolean;
	getEnabledToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	setPlanProposalHandler(handler: PlanProposalHandler | null): void;
	setPlanReferencePath(planFilePath: string): void;
}
export interface RpcModeControllerOptions {
	session: RpcModeControllerSession;
	confirm(title: string, message: string, signal: AbortSignal): Promise<boolean>;
	onModeChanged(mode: RpcMode): void;
}

export class RpcModeController {
	readonly #session: RpcModeControllerSession;
	readonly #confirm: RpcModeControllerOptions["confirm"];
	readonly #onModeChanged: RpcModeControllerOptions["onModeChanged"];
	#previousTools: string[] | undefined;
	#pendingProposalAbort: AbortController | undefined;
	#ownedPlanState: PlanModeState | undefined;
	constructor(options: RpcModeControllerOptions) {
		this.#session = options.session;
		this.#confirm = options.confirm;
		this.#onModeChanged = options.onModeChanged;
	}

	get mode(): RpcMode {
		return this.#session.getPlanModeState()?.enabled ? "plan" : "default";
	}

	get ownsPlanMode(): boolean {
		return this.#ownedPlanState !== undefined && this.#session.getPlanModeState() === this.#ownedPlanState;
	}

	async apply(mode: RpcMode): Promise<void> {
		if (mode === this.mode) {
			if (mode === "plan" && !this.ownsPlanMode) {
				throw new Error("Plan mode is managed by another workflow");
			}
			return;
		}
		if (mode === "default" && !this.ownsPlanMode) {
			throw new Error("Plan mode is managed by another workflow");
		}
		if (mode === "plan") {
			if (!this.#session.settings.get("plan.enabled")) {
				throw new Error("Plan mode is disabled by the plan.enabled setting");
			}
			if (this.#session.hasPlanYoloWorkflow()) {
				throw new Error("Cannot enter RPC plan mode while a plan-yolo workflow is configured");
			}
			const previousTools = this.#session.getEnabledToolNames();
			const augmentations = this.#session.hasBuiltInTool("write") ? ["write"] : [];
			await this.#session.setActiveToolsByName([...new Set([...previousTools, ...augmentations])]);
			const previous = this.#session.getPlanModeState();
			const state: PlanModeState = {
				enabled: true,
				planFilePath: previous?.planFilePath ?? DEFAULT_RPC_PLAN_FILE_URL,
				workflow: previous?.workflow ?? "parallel",
				reentry: previous !== undefined,
			};
			this.#previousTools = previousTools;
			this.#session.setPlanModeState(state);
			this.#ownedPlanState = state;
			this.#session.setPlanProposalHandler(title => this.#handlePlanProposal(title));
		} else {
			this.cancelPendingProposal();
			if (this.#previousTools) {
				await this.#session.setActiveToolsByName(this.#previousTools);
			}
			this.#previousTools = undefined;
			this.#ownedPlanState = undefined;
			this.#session.setPlanProposalHandler(null);
			this.#session.setPlanModeState(undefined);
		}
		this.#onModeChanged(mode);
	}

	cancelPendingProposal(): void {
		this.#pendingProposalAbort?.abort();
		this.#pendingProposalAbort = undefined;
	}

	#resolvePlanFilePath(planFilePath: string): string {
		if (planFilePath.startsWith("local:")) {
			const normalized = normalizeLocalScheme(planFilePath);
			return resolveLocalUrlToPath(normalized, {
				getArtifactsDir: () => this.#session.sessionManager.getArtifactsDir(),
				getSessionId: () => this.#session.sessionManager.getSessionId(),
			});
		}
		return path.resolve(this.#session.sessionManager.getCwd(), planFilePath);
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		try {
			return await Bun.file(this.#resolvePlanFilePath(planFilePath)).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async #listPlanFiles(): Promise<string[]> {
		const localRoot = this.#resolvePlanFilePath("local://");
		try {
			const entries = await fs.readdir(localRoot, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async entry => {
						const stat = await fs.stat(path.join(localRoot, entry.name)).catch(() => null);
						return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
					}),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
		}
	}

	async #handlePlanProposal(title: string): Promise<AgentToolResult<unknown>> {
		const state = this.#session.getPlanModeState();
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}
		if (this.#pendingProposalAbort) {
			throw new ToolError("A plan approval request is already pending.");
		}
		const approvalAbort = new AbortController();
		this.#pendingProposalAbort = approvalAbort;
		try {
			const {
				planFilePath,
				planContent,
				title: resolvedTitle,
			} = await resolveApprovedPlan({
				suppliedTitle: title,
				statePlanFilePath: state.planFilePath,
				readPlan: url => this.#readPlanFile(url),
				listPlanFiles: () => this.#listPlanFiles(),
			});
			if (approvalAbort.signal.aborted) {
				throw new ToolError("Plan approval was cancelled.");
			}
			const previewLines = planContent.split("\n");
			const preview = previewLines.slice(0, 12).join("\n");
			const approved = await this.#confirm(
				"Approve plan?",
				`Approve plan "${resolvedTitle}" and start implementation?\n\n${preview}${previewLines.length > 12 ? "\n…" : ""}`,
				approvalAbort.signal,
			);
			if (approvalAbort.signal.aborted) {
				throw new ToolError("Plan approval was cancelled.");
			}
			if (this.#session.getPlanModeState() !== state) {
				throw new ToolError("Plan mode changed while approval was pending.");
			}
			const details: PlanApprovalDetails = {
				planFilePath,
				title: resolvedTitle,
				planExists: true,
			};
			if (!approved) {
				const normalizedTitle = normalizePlanTitle(resolvedTitle).title;
				return {
					content: [
						{
							type: "text",
							text: `Plan refinement requested. Update the plan file, then write ${normalizedTitle} to xd://propose again when ready.`,
						},
					],
					details,
				};
			}
			this.#session.setPlanReferencePath(planFilePath);
			if (this.#pendingProposalAbort === approvalAbort) {
				this.#pendingProposalAbort = undefined;
			}
			await this.apply("default");
			return {
				content: [
					{
						type: "text",
						text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
					},
				],
				details,
			};
		} finally {
			if (this.#pendingProposalAbort === approvalAbort) {
				this.#pendingProposalAbort = undefined;
			}
		}
	}
}
