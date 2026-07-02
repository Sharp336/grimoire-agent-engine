/**
 * Statistics — aggregate counts for the Task Manager overview.
 *
 * Pure functions over the task/milestone/document arrays.
 */

import type { Milestone, Task } from "./types";

export interface TaskStatistics {
	total: number;
	byStatus: Record<string, number>;
	byPriority: Record<string, number>;
	byAssignee: Record<string, number>;
	blocked: Task[];
	drafts: number;
	archived: number;
	milestoneProgress: Array<{
		milestone: Milestone;
		total: number;
		done: number;
		percentage: number;
	}>;
}

export function computeStatistics(tasks: Task[], milestones: Milestone[]): TaskStatistics {
	const byStatus: Record<string, number> = {};
	const byPriority: Record<string, number> = {};
	const byAssignee: Record<string, number> = {};
	let drafts = 0;
	let archived = 0;
	const blocked: Task[] = [];

	for (const task of tasks) {
		if (task.archived) {
			archived++;
			continue;
		}
		if (task.draft) drafts++;

		byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
		if (task.priority) byPriority[task.priority] = (byPriority[task.priority] ?? 0) + 1;
		if (task.assignee) byAssignee[task.assignee] = (byAssignee[task.assignee] ?? 0) + 1;
		if (task.status === "blocked") blocked.push(task);
	}

	const milestoneProgress = milestones
		.map(milestone => {
			const milestoneTasks = tasks.filter(t => t.milestone === milestone.id && !t.archived);
			const done = milestoneTasks.filter(t => t.status === "done").length;
			const total = milestoneTasks.length;
			return {
				milestone,
				total,
				done,
				percentage: total === 0 ? 0 : Math.round((done / total) * 100),
			};
		})
		.filter(m => m.total > 0);

	return {
		total: tasks.filter(t => !t.archived).length,
		byStatus,
		byPriority,
		byAssignee,
		blocked,
		drafts,
		archived,
		milestoneProgress,
	};
}
