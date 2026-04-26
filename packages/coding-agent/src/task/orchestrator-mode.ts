import type { TaskIsolationMode } from "./isolation-backend";

export const DIRECT_FILE_MUTATION_TOOL_NAMES = new Set(["ast_edit", "edit", "notebook", "resolve", "write"]);

interface AgentToolScope {
	tools?: string[];
}

interface TaskIsolationOptions {
	configuredMode: TaskIsolationMode;
	isolationRequested: boolean;
	orchestratorMode: boolean;
	agent: AgentToolScope;
	/** Depth of the dispatching session. >0 means we're already inside an isolated task; nesting isolation is unsupported. */
	taskDepth?: number;
}

export function isDirectMutationToolName(name: string): boolean {
	return DIRECT_FILE_MUTATION_TOOL_NAMES.has(name);
}

/**
 * Whether an agent can directly mutate repository files without shell workarounds.
 * Omitted tool lists mean full access, so treat them as edit-capable.
 */
export function agentHasDirectMutationTools(agent: AgentToolScope): boolean {
	return agent.tools === undefined || agent.tools.some(name => isDirectMutationToolName(name));
}

/**
 * Orchestrator mode auto-isolates edit-capable agents and falls back to worktree
 * when no explicit task isolation backend is configured.
 */
export function resolveTaskIsolation(options: TaskIsolationOptions): {
	autoIsolation: boolean;
	taskIsolationMode: TaskIsolationMode;
} {
	// Nested dispatch (depth>0): never isolate. A task dispatched from inside an already-
	// isolated worktree cannot layer another isolation on top without degenerate performance
	// (nested FUSE) or divergent baselines (worktree inside worktree). Sub-sub-tasks run
	// inline in the parent task's worktree and share its branch. Cherry-pick semantics
	// collapse to a no-op because the edits are already on the parent branch.
	if ((options.taskDepth ?? 0) > 0) {
		return { autoIsolation: false, taskIsolationMode: "none" };
	}
	const autoIsolation = options.orchestratorMode && agentHasDirectMutationTools(options.agent);
	if (!options.isolationRequested && !autoIsolation) {
		return { autoIsolation: false, taskIsolationMode: "none" };
	}
	if (options.configuredMode !== "none") {
		return {
			autoIsolation,
			taskIsolationMode: options.configuredMode,
		};
	}
	return {
		autoIsolation,
		taskIsolationMode: autoIsolation ? "worktree" : "none",
	};
}

/**
 * Orchestrator sessions always integrate isolated edits through temporary branches
 * so the client can preserve branch state for recovery without reopening root edits.
 */
export function resolveTaskMergeMode(options: {
	configuredMode: "patch" | "branch";
	orchestratorMode: boolean;
	taskDepth?: number;
}): "patch" | "branch" {
	if ((options.taskDepth ?? 0) > 0) return "patch";
	return options.orchestratorMode ? "branch" : options.configuredMode;
}
