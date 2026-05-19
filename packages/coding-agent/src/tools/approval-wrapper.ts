/**
 * Universal approval wrapper.
 *
 * Wraps any AgentTool with approval-policy enforcement so the feature
 * applies to built-in tools even when no extensions are loaded.
 */
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Settings } from "../config/settings";
import { applyToolProxy } from "../extensibility/tool-proxy";
import type { ApprovalPolicy } from "./approval";
import { formatApprovalPrompt, requiresApproval } from "./approval";

export class ApprovalToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(private tool: AgentTool<TParameters, TDetails>) {
		applyToolProxy(tool, this);
	}

	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	) {
		const autoApprove = context?.autoApprove ?? false;
		const hasUI = context?.hasUI ?? false;

		// Skip approval checks if:
		// 1. autoApprove flag is set (--auto-approve / --yolo)
		// 2. No UI available (headless/internal sessions are trusted)
		if (!autoApprove && hasUI) {
			const settings: Settings | undefined = context?.settings;
			const userPolicies: Record<string, ApprovalPolicy> = settings?.get("tools.approval") ?? {};
			const approvalCheck = requiresApproval(this.tool.name, params, userPolicies);

			if (approvalCheck.required) {
				if (!context.ui) {
					// This should not happen (hasUI is true but ui is undefined),
					// but fail closed if it does
					throw new Error(
						`Tool "${this.tool.name}" requires approval but UI context is unavailable.`,
					);
				}

				const message = formatApprovalPrompt(this.tool.name, params, approvalCheck.reason);
				const approved = await context.ui.confirm(`Approve ${this.tool.name}?`, message);

				if (!approved) {
					throw new Error(`Tool call denied by user: ${this.tool.name}`);
				}
			}
		}

		return await this.tool.execute(toolCallId, params, signal, onUpdate, context);
	}
}
