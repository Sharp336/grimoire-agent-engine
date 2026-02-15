import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import checkTaskDescription from "../prompts/tools/check-task.md" with { type: "text" };
import type { AsyncTaskHandle, TaskRegistry } from "../task/registry";

const checkTaskSchema = Type.Object({
	task_id: Type.String({
		description: "The ID of the async task to check",
		maxLength: 64,
	}),
});

type CheckTaskParams = Static<typeof checkTaskSchema>;

export interface CheckTaskDetails {
	status: "running" | "completed" | "failed" | "cancelled" | "not_found";
	taskId: string;
	message?: string;
	result?: unknown;
	error?: string;
	followUpDeliveryFailed?: boolean;
}

export class CheckTaskTool implements AgentTool<typeof checkTaskSchema, CheckTaskDetails> {
	readonly name = "check_task";
	readonly label = "CheckTask";
	readonly description: string;
	readonly parameters = checkTaskSchema;

	#registry: TaskRegistry;

	constructor(registry: TaskRegistry) {
		this.#registry = registry;
		this.description = renderPromptTemplate(checkTaskDescription);
	}

	async execute(
		_toolCallId: string,
		params: CheckTaskParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CheckTaskDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CheckTaskDetails>> {
		const task = this.#registry.get(params.task_id);

		if (!task) {
			return {
				content: [
					{
						type: "text",
						text: `Task ${params.task_id} not found.`,
					},
				],
				details: {
					status: "not_found",
					taskId: params.task_id,
					message: `Task ${params.task_id} not found in registry.`,
				},
			};
		}

		const details: CheckTaskDetails = {
			status: task.status,
			taskId: task.id,
			message: `Task ${task.id} status: ${task.status}`,
		};

		if (task.status === "completed" && task.result) {
			details.result = task.result;
		} else if (task.status === "failed" && task.error) {
			details.error = task.error;
		}

		if (task.followUpDeliveryFailed) {
			details.followUpDeliveryFailed = true;
		}

		return {
			content: [
				{
					type: "text",
					text: this.#formatTaskStatus(task),
				},
			],
			details,
		};
	}

	#formatTaskStatus(task: AsyncTaskHandle | undefined): string {
		if (!task) return "";

		const lines = [
			`Task: ${task.id}`,
			`Status: ${task.status}`,
			`Agent: ${task.agent}`,
			`Description: ${task.description}`,
		];

		if (task.completedAt) {
			const duration = Math.round((task.completedAt - task.createdAt) / 1000);
			lines.push(`Duration: ${duration}s`);
		}

		if (task.status === "completed" && task.result) {
			lines.push(`Results: ${task.result.length} item(s)`);
		} else if (task.status === "failed" && task.error) {
			lines.push(`Error: ${task.error}`);
		}

		if (task.followUpDeliveryFailed) {
			lines.push(`⚠️ Task completion notification failed - check task result manually`);
		}

		return lines.join("\n");
	}
}
