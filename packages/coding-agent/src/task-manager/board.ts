/**
 * Board generation — pure functions for kanban board views.
 *
 * Produces status-grouped and milestone-grouped board data that the
 * `omp board` command renders to stdout.
 */

import type { Milestone, Task } from "./types";

export interface KanbanColumn {
	status: string;
	tasks: Task[];
}

export interface KanbanBoard {
	columns: KanbanColumn[];
	totalTasks: number;
}

export interface MilestoneGroupedBoard {
	milestones: Array<{
		milestone: Milestone | null;
		columns: KanbanColumn[];
		taskCount: number;
	}>;
	totalTasks: number;
}

export interface BoardMetadata {
	generatedAt: string;
	totalTasks: number;
	statusCounts: Record<string, number>;
	columns: KanbanColumn[];
}

/** Group tasks into columns by status, preserving config status order. */
export function buildKanbanStatusGroups(tasks: Task[], statuses: string[]): KanbanBoard {
	const columns: KanbanColumn[] = statuses.map(status => ({
		status,
		tasks: tasks.filter(t => t.status === status),
	}));

	// Include any statuses that exist on tasks but aren't in the config
	const knownStatuses = new Set(statuses);
	const extraStatuses = new Set<string>();
	for (const task of tasks) {
		if (!knownStatuses.has(task.status)) {
			extraStatuses.add(task.status);
		}
	}
	for (const status of extraStatuses) {
		columns.push({
			status,
			tasks: tasks.filter(t => t.status === status),
		});
	}

	return {
		columns,
		totalTasks: tasks.length,
	};
}

/** Generate a kanban board with metadata (counts, timestamp). */
export function generateKanbanBoardWithMetadata(tasks: Task[], statuses: string[]): BoardMetadata {
	const board = buildKanbanStatusGroups(tasks, statuses);
	const statusCounts: Record<string, number> = {};
	for (const col of board.columns) {
		statusCounts[col.status] = col.tasks.length;
	}
	return {
		generatedAt: new Date().toISOString(),
		totalTasks: board.totalTasks,
		statusCounts,
		columns: board.columns,
	};
}

/** Group tasks by milestone, then build kanban columns within each group. */
export function generateMilestoneGroupedBoard(
	tasks: Task[],
	milestones: Milestone[],
	statuses: string[],
): MilestoneGroupedBoard {
	const groups: MilestoneGroupedBoard["milestones"] = [];
	let totalTasks = 0;

	for (const milestone of milestones) {
		const milestoneTasks = tasks.filter(t => t.milestone === milestone.id);
		if (milestoneTasks.length === 0) continue;
		const board = buildKanbanStatusGroups(milestoneTasks, statuses);
		groups.push({
			milestone,
			columns: board.columns,
			taskCount: board.totalTasks,
		});
		totalTasks += board.totalTasks;
	}

	// Tasks with no milestone
	const unassigned = tasks.filter(t => !t.milestone || !milestones.some(m => m.id === t.milestone));
	if (unassigned.length > 0) {
		const board = buildKanbanStatusGroups(unassigned, statuses);
		groups.push({
			milestone: null,
			columns: board.columns,
			taskCount: board.totalTasks,
		});
		totalTasks += board.totalTasks;
	}

	return { milestones: groups, totalTasks };
}

/** Render a kanban board as a formatted text table for terminal output. */
export function renderKanbanTable(board: KanbanBoard): string {
	const lines: string[] = [];
	const colWidth = 20;
	const sep = "│";

	// Header
	const header = board.columns
		.map(col => {
			const label = `${col.status} (${col.tasks.length})`;
			return padColumn(label, colWidth);
		})
		.join(` ${sep} `);
	lines.push(header);
	lines.push(board.columns.map(() => "─".repeat(colWidth)).join(`${sep}─${sep}`));

	// Rows
	const maxRows = Math.max(...board.columns.map(c => c.tasks.length), 0);
	for (let i = 0; i < maxRows; i++) {
		const row = board.columns
			.map(col => {
				const task = col.tasks[i];
				return task ? padColumn(`${task.id}: ${task.title}`, colWidth) : " ".repeat(colWidth);
			})
			.join(` ${sep} `);
		lines.push(row);
	}

	return lines.join("\n");
}

function padColumn(text: string, width: number): string {
	const trimmed = text.length > width ? `${text.slice(0, width - 1)}…` : text;
	return trimmed.padEnd(width);
}
