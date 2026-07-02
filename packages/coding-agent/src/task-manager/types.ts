/**
 * Task Manager type definitions.
 *
 * Markdown-native task entity model: tasks, decisions, documents, milestones.
 * All entities serialize to frontmatter + markdown body on disk.
 */

// ─── Entities ──────────────────────────────────────────────────────────────

export type EntityType = "task" | "decision" | "document" | "milestone";

export type TaskStatus = string;

export interface AcceptanceCriterion {
	text: string;
	checked: boolean;
}

export interface TaskComment {
	id: string;
	author: string;
	text: string;
	createdDate: string;
}

export interface DefinitionOfDoneItem {
	text: string;
	checked: boolean;
}

export interface Task {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	assignee: string | null;
	labels: string[];
	priority: string | null;
	parentTaskId: string | null;
	dependencies: string[];
	createdAt: string;
	updatedAt: string;
	milestone: string | null;
	taskPlan: string | null;
	acceptanceCriteria: AcceptanceCriterion[];
	definitionOfDone: DefinitionOfDoneItem[];
	comments: TaskComment[];
	notes: string | null;
	finalSummary: string | null;
	draft: boolean;
	archived: boolean;
	archivedAt: string | null;
	milestoneOrder: number | null;
	readonly rawContent?: string;
	readonly rawFrontmatter?: Record<string, unknown>;
}

export interface Decision {
	id: string;
	title: string;
	status: string;
	context: string;
	decision: string;
	consequences: string | null;
	createdAt: string;
	updatedAt: string;
	tags: string[];
	readonly rawContent?: string;
	readonly rawFrontmatter?: Record<string, unknown>;
}

export interface Document {
	id: string;
	title: string;
	type: string;
	tags: string[];
	path: string | null;
	content: string;
	createdAt: string;
	updatedAt: string;
	readonly rawContent?: string;
	readonly rawFrontmatter?: Record<string, unknown>;
}

export interface Milestone {
	id: string;
	name: string;
	description: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	archived: boolean;
	archivedAt: string | null;
	readonly rawContent?: string;
	readonly rawFrontmatter?: Record<string, unknown>;
}

// ─── Config ───────────────────────────────────────────────────────────────

export interface PrefixConfig {
	task: string;
	decision: string;
	document: string;
	milestone: string;
}

export interface TaskConfig {
	projectName: string;
	directories: {
		tasks: string;
		decisions: string;
		documents: string;
		milestones: string;
		archive: string;
	};
	files: {
		config: string;
		sequences: string;
	};
	statuses: string[];
	defaultStatus: string;
	prefixes: PrefixConfig;
	git: {
		enabled: boolean;
		autoCommit: boolean;
		commitPrefix: string;
	};
	taskTemplate: string | null;
}

// ─── Inputs ───────────────────────────────────────────────────────────────

export interface TaskCreateInput {
	title: string;
	description?: string;
	status?: string;
	assignee?: string | null;
	labels?: string[];
	priority?: string | null;
	parentTaskId?: string | null;
	dependencies?: string[];
	milestone?: string | null;
	taskPlan?: string | null;
	acceptanceCriteria?: string[];
	definitionOfDone?: string[];
	draft?: boolean;
}

export interface TaskUpdateInput {
	title?: string;
	description?: string;
	status?: string;
	assignee?: string | null;
	labels?: string[];
	priority?: string | null;
	parentTaskId?: string | null;
	dependencies?: string[];
	milestone?: string | null;
	taskPlan?: string | null;
	notes?: string | null;
	finalSummary?: string | null;
}

export interface TaskListFilter {
	status?: string | null;
	assignee?: string | null;
	parentTaskId?: string | null;
	labels?: string[];
	search?: string | null;
	limit?: number | null;
}

// ─── Search ───────────────────────────────────────────────────────────────

export interface SearchFilters {
	status?: string | null;
	priority?: string | null;
}

export interface SearchOptions {
	filters?: SearchFilters;
	limit?: number | null;
}

export interface SearchResult {
	id: string;
	type: EntityType;
	title: string;
	status: string;
	score: number;
}
