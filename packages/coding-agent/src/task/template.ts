import { prompt } from "@oh-my-pi/pi-utils";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { getTaskSimpleModeCapabilities, type TaskSimpleMode } from "./simple-mode";
import type { TaskItem } from "./types";

interface RenderResult {
	/** Full task text sent to the subagent */
	task: string;
	/** Raw per-task assignment text, without prompt template boilerplate */
	assignment: string;
	id: string;
	description: string;
	skills?: string[];
	model?: string;
}

/**
 * Build the full task text from shared context and per-task assignment.
 *
 * If context is provided, it is prepended with a separator.
 */
export function renderTemplate(
	context: string | undefined,
	task: TaskItem,
	simpleMode: TaskSimpleMode = "default",
): RenderResult {
	let { id, description, assignment, skills, model } = task;
	assignment = assignment.trim();
	const { contextEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	context = contextEnabled ? context?.trim() : undefined;

	if (!context || !assignment) {
		if (simpleMode === "independent" && assignment) {
			return {
				task: prompt.render(subagentUserPromptTemplate, { assignment, independentMode: true }),
				assignment,
				id,
				description,
				skills,
				model,
			};
		}
		return { task: assignment || context!, assignment: assignment || context!, id, description, skills, model };
	}
	return {
		task: prompt.render(subagentUserPromptTemplate, { context, assignment, independentMode: false }),
		assignment,
		id,
		description,
		skills,
		model,
	};
}
