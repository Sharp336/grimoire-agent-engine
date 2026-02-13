/**
 * Cancel Task Tool - Cancel an async task by ID
 *
 * Use this tool to cancel a running async task that was previously started
 * with the task tool.
 *
 * Returns different messages based on task state:
 * - "Task {id} cancelled" - Successfully cancelled a running task
 * - "Task {id} not found" - Task ID does not exist in registry
 * - "Task {id} already completed" - Task is no longer running
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { TaskRegistry } from "../task/registry";

// =============================================================================
// Types
// =============================================================================

const cancelTaskSchema = Type.Object({
	task_id: Type.String({ description: "The ID of the async task to cancel" }),
});

export type CancelTaskInput = Static<typeof cancelTaskSchema>;

export interface CancelTaskDetails {
	taskId: string;
	status: "cancelled" | "not_found" | "already_completed";
}

// =============================================================================
// Tool Class
// =============================================================================

type CancelTaskParams = CancelTaskInput;

/**
 * Cancel task tool for stopping running async tasks.
 *
 * Allows stopping a task that was previously started with the task tool.
 */
export class CancelTaskTool implements AgentTool<typeof cancelTaskSchema, CancelTaskDetails> {
	readonly name = "cancel_task";
	readonly label = "Cancel Task";
	readonly description = "Cancel a running async task by ID";
	readonly parameters = cancelTaskSchema;

	constructor(private readonly registry: TaskRegistry) {}

	async execute(_toolCallId: string, params: CancelTaskParams): Promise<AgentToolResult<CancelTaskDetails>> {
		const { task_id: taskId } = params;

		// Check if task exists
		const task = this.registry.get(taskId);
		if (!task) {
			return {
				content: [{ type: "text" as const, text: `Task ${taskId} not found` }],
				details: {
					taskId,
					status: "not_found",
				},
			};
		}

		// Check if task is still running
		if (task.status !== "running") {
			return {
				content: [{ type: "text" as const, text: `Task ${taskId} already completed` }],
				details: {
					taskId,
					status: "already_completed",
				},
			};
		}

		// Cancel the task
		const cancelled = this.registry.cancel(taskId);

		if (!cancelled) {
			return {
				content: [{ type: "text" as const, text: `Task ${taskId} already completed` }],
				details: {
					taskId,
					status: "already_completed",
				},
			};
		}

		return {
			content: [{ type: "text" as const, text: `Task ${taskId} cancelled` }],
			details: {
				taskId,
				status: "cancelled",
			},
		};
	}
}
