/**
 * Task loader — loads tasks from local branches and remote branches.
 *
 * Uses GitOperations for `git branch`, `git show`. Builds a unified index
 * that resolves conflicts between branches (local takes priority).
 */

import type { Core } from "./core";
import type { GitOperations } from "./git-ops";
import type { Task } from "./types";

export interface BranchTaskEntry {
	task: Task;
	branch: string;
	isLocal: boolean;
}

export class TaskLoader {
	#core: Core;
	#git: GitOperations;

	constructor(core: Core) {
		this.#core = core;
		this.#git = core.git;
	}

	async loadLocalBranchTasks(_branch?: string): Promise<Task[]> {
		await this.#core.ensureConfigLoaded();
		const ids = await this.#core.fs.listEntityFiles("tasks");
		const tasks: Task[] = [];
		for (const id of ids) {
			try {
				tasks.push(await this.#core.loadTask(id));
			} catch {
				// Skip files that fail to parse
			}
		}
		return tasks;
	}

	async loadRemoteTasks(): Promise<BranchTaskEntry[]> {
		if (!this.#git.enabled) return [];
		const branches = await this.#git.listBranches();
		const current = await this.#git.currentBranch();
		const entries: BranchTaskEntry[] = [];

		for (const branch of branches) {
			if (branch === current) continue;
			const config = await this.#core.config;
			const tasksDir = config.directories.tasks;
			const result = await this.#git.showFile(branch, tasksDir);
			if (!result) continue;

			// The git show output for a directory won't work; we need individual files.
			// ponytail: listing remote branch files requires git ls-tree, but for Phase 1
			// we only load local tasks — remote loading is a Phase 2 enhancement.
		}

		return entries;
	}

	async buildRemoteTaskIndex(): Promise<Map<string, BranchTaskEntry[]>> {
		const index = new Map<string, BranchTaskEntry[]>();
		const remote = await this.loadRemoteTasks();
		for (const entry of remote) {
			const existing = index.get(entry.task.id) ?? [];
			existing.push(entry);
			index.set(entry.task.id, existing);
		}
		return index;
	}

	resolveTaskConflict(entries: BranchTaskEntry[]): BranchTaskEntry {
		// Local branches take priority over remote; newest updatedAt wins within a tier.
		const local = entries.filter(e => e.isLocal);
		const pool = local.length > 0 ? local : entries;
		return pool.reduce((best, cur) => (cur.task.updatedAt > best.task.updatedAt ? cur : best));
	}
}
