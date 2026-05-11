// Pre-dispatch guards for the task tool. Lives in its own module so tests can
// exercise it without pulling in the full `task/index.ts` evaluation, which
// transitively imports `tools/index.ts` and trips the `BUILTIN_TOOLS` TDZ cycle.

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { assignmentRequiresWrite } from "./agents";
import type { AgentDefinition, TaskToolDetails } from "./types";

// Shared between `execute()` (pre-async-dispatch fast path so a read-only mismatch
// never becomes a silently "successful" background job — see
// https://github.com/can1357/oh-my-pi/pull/1016#discussion_r3222623330) and
// `#executeSync` (covers agents added on disk after the cached check loaded).
export function buildReadOnlyDispatchError(opts: {
	agent: Pick<AgentDefinition, "readOnly">;
	planModeEnabled: boolean;
	tasks: ReadonlyArray<{ id: string; assignment: string }>;
	agentName: string;
	projectAgentsDir?: string | null;
}): AgentToolResult<TaskToolDetails> | undefined {
	const agentIsReadOnly = opts.planModeEnabled || opts.agent.readOnly === true;
	if (!agentIsReadOnly) return undefined;
	const writeIntentTasks = opts.tasks.filter(t => assignmentRequiresWrite(t.assignment));
	if (writeIntentTasks.length === 0) return undefined;
	const taskIds = writeIntentTasks.map(t => `"${t.id}"`).join(", ");
	const subject = writeIntentTasks.length === 1 ? `task ${taskIds} requires` : `tasks ${taskIds} require`;
	const cause = opts.planModeEnabled
		? "plan mode restricts every agent to a read-only tool set"
		: `agent "${opts.agentName}" is read-only`;
	return {
		content: [
			{
				type: "text",
				text: `Cannot dispatch: ${cause}, but ${subject} file edits or state-changing commands. Re-dispatch with a write-capable agent (e.g. "task"). If this is a false positive, rephrase the assignment to start with an investigation verb (investigate, find, locate, analyze, summarize, review) instead of a write verb.`,
			},
		],
		details: {
			projectAgentsDir: opts.projectAgentsDir ?? null,
			results: [],
			totalDurationMs: 0,
		},
	};
}
