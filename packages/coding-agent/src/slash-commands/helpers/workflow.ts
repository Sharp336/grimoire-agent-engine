import type { AgentSession } from "../../session/agent-session";
import type { WorkflowSnapshot } from "../../workflows";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

interface WorkflowCancellationControl {
	cancelActiveWorkflow(): Promise<WorkflowSnapshot>;
}

function getWorkflowCancellationControl(session: AgentSession): WorkflowCancellationControl | undefined {
	const tool = session.getToolByName("workflow");
	if (
		typeof tool !== "object" ||
		tool === null ||
		!("cancelActiveWorkflow" in tool) ||
		typeof tool.cancelActiveWorkflow !== "function"
	) {
		return undefined;
	}
	return tool as WorkflowCancellationControl;
}

export async function handleWorkflowCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (verb !== "cancel" || rest) return usage("Usage: /workflow cancel", runtime);
	const control = getWorkflowCancellationControl(runtime.session);
	if (!control) return usage("No durable workflow is active in this session.", runtime);
	try {
		const snapshot = await control.cancelActiveWorkflow();
		await runtime.output(`Workflow ${snapshot.definition.id}: ${snapshot.status}`);
		return commandConsumed();
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error), runtime);
	}
}
