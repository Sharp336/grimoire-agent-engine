/**
 * Task Manager constants.
 *
 * On-disk layout uses `.omp/tasks/` — omp-native, following the existing
 * `.omp/` convention used for `.omp/agents`, `.omp/rules`, `.omp/ssh.json`.
 */

import type { TaskConfig } from "./types";

export const DEFAULT_DIRECTORIES = {
	tasks: ".omp/tasks/tasks",
	decisions: ".omp/tasks/decisions",
	documents: ".omp/tasks/documents",
	milestones: ".omp/tasks/milestones",
	archive: ".omp/tasks/archive",
};

export const DEFAULT_FILES = {
	config: ".omp/tasks/config.yml",
	sequences: ".omp/tasks/sequences.json",
};

export const DEFAULT_STATUSES = ["todo", "in-progress", "done", "blocked"];

export const FALLBACK_STATUS = "todo";

export const DEFAULT_PREFIXES = {
	task: "task",
	decision: "decision",
	document: "doc",
	milestone: "milestone",
};

export const DEFAULT_INIT_CONFIG: TaskConfig = {
	projectName: "Project",
	directories: { ...DEFAULT_DIRECTORIES },
	files: { ...DEFAULT_FILES },
	statuses: [...DEFAULT_STATUSES],
	defaultStatus: FALLBACK_STATUS,
	prefixes: { ...DEFAULT_PREFIXES },
	git: {
		enabled: true,
		autoCommit: true,
		commitPrefix: "task:",
	},
	taskTemplate: null,
};

/** File extension for all task entities. */
export const ENTITY_EXTENSION = ".md";

/** Max search results when no explicit limit is set. */
export const DEFAULT_SEARCH_LIMIT = 50;
