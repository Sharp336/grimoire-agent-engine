import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	enqueueMemoryConsolidation,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * Delegates to the legacy entry points while sharing local memory by stable
 * memory project identity instead of cwd/worktree path.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings);
	},
	async clear(agentDir, cwd, session) {
		await clearMemoryData(agentDir, cwd, session?.settings.get("memory.projectKey"));
	},
	async enqueue(agentDir, cwd, session) {
		enqueueMemoryConsolidation(agentDir, cwd, undefined, session?.settings.get("memory.projectKey"));
	},
	async status() {
		return {
			backend: "local" as const,
			active: true,
			writable: false,
			searchable: false,
			message: "Local rollout-summary memory is active; structured search/save is not available.",
		};
	},
};
