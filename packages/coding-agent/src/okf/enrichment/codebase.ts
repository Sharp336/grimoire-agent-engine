import * as prompt from "@oh-my-pi/pi-utils/prompt";
import enrichmentPrompt from "../../prompts/okf/enrichment-codebase.md" with { type: "text" };

export interface CodebaseEnrichmentOptions {
	cwd: string;
	focus?: string;
	maxConcepts?: number;
}

/** Build the subagent assignment for the codebase-walking enrichment task. */
export function buildCodebaseEnrichmentPrompt(options: CodebaseEnrichmentOptions): string {
	return prompt.render(enrichmentPrompt, {
		focus: options.focus ?? "",
		maxConcepts: String(options.maxConcepts ?? 10),
		cwd: options.cwd,
	});
}
