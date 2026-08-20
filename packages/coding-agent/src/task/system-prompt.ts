import { prompt } from "@oh-my-pi/pi-utils";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import type { SystemPromptPreset } from "./types";

export interface SubagentSystemPromptData {
	[key: string]: unknown;
	agent: string;
	context: string;
	planReference: string;
	planReferencePath: string;
	worktree: string;
	outputSchema: unknown;
	outputSchemaOverridesAgent: boolean;
	ircPeers: string;
	ircSelfId: string;
}

export function buildSubagentSystemPrompt(
	defaultPrompt: readonly string[],
	systemPreset: SystemPromptPreset | undefined,
	data: SubagentSystemPromptData,
): string[] {
	const subagentPrompt = prompt.render(subagentSystemPromptTemplate, data);
	if (systemPreset === "minimal-task" || defaultPrompt.length === 0) return [subagentPrompt];
	return [...defaultPrompt.slice(0, -1), subagentPrompt, defaultPrompt[defaultPrompt.length - 1]];
}
