import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import listTasksDescription from "../prompts/tools/list-tasks.md" with { type: "text" };
import type { TaskRegistry } from "../task/registry";
import type { ToolSession } from ".";

const listTasksSchema = Type.Object({
	include_completed: Type.Optional(
		Type.Boolean({
			description: "Include completed/failed tasks. Default true.",
		}),
	),
});

export type ListTasksInput = Static<typeof listTasksSchema>;

export interface ListTasksDetails {
	summary: string;
	taskCount: number;
	runningCount: number;
	completedCount: number;
}

/**
 * List all async tasks in the current session.
 *
 * Lists both running and completed tasks. By default includes completed/failed tasks.
 * Results auto-deliver on completion — do NOT use this to poll for results.
 */
export class ListTasksTool implements AgentTool<typeof listTasksSchema, ListTasksDetails> {
	readonly name = "list_tasks";
	readonly label = "List Tasks";
	readonly description: string;
	readonly parameters = listTasksSchema;

	#registry: TaskRegistry;

	constructor(_session: ToolSession, registry: TaskRegistry) {
		this.#registry = registry;
		this.description = renderPromptTemplate(listTasksDescription);
	}

	async execute(
		_toolCallId: string,
		{ include_completed = true }: ListTasksInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ListTasksDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ListTasksDetails>> {
		const tasks = this.#registry.list();

		// Filter based on include_completed
		const filtered = include_completed ? tasks : tasks.filter(t => t.status === "running");

		// Count by status
		const runningCount = tasks.filter(t => t.status === "running").length;
		const completedCount = tasks.filter(t => t.status !== "running").length;
		const taskCount = filtered.length;

		// Build summary
		let summary = "";

		if (filtered.length === 0) {
			summary = include_completed ? "No tasks" : "No running tasks";
		} else {
			const lines: string[] = [];
			for (const task of filtered) {
				const ago = formatTime(Date.now() - task.createdAt);
				const status = formatStatus(task.status);
				lines.push(`${status} [${task.id}] ${task.description} (${task.agent}, ${ago})`);
			}
			summary = lines.join("\n");
		}

		return {
			content: [{ type: "text", text: summary }],
			details: {
				summary,
				taskCount,
				runningCount,
				completedCount,
			},
		};
	}
}

function formatStatus(status: string): string {
	switch (status) {
		case "running":
			return "⏳";
		case "completed":
			return "✅";
		case "failed":
			return "❌";
		case "cancelled":
			return "⊘";
		default:
			return "?";
	}
}

function formatTime(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return `${hours}h ago`;
}
