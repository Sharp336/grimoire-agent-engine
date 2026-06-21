import type { TaskContextResult } from "./retrieve";

/**
 * Build the system-prompt advertisement block for codemap.
 * This is the text that goes into the {{#if hasCodemap}} block in system-prompt.md.
 */
export const CODEMAP_ADVERTISEMENT = `## Code Summaries (codemap)
File-level code summaries are available for this repo. Before reading unfamiliar files, call \`get_task_context\` with your task to retrieve relevant summaries (packed within a token budget). After reading a non-trivial file or making load-bearing changes, call \`set_file_summary\` to record a short note (purpose, key symbols, gotchas, invariants). Summaries are anchored to file content via Bun.hash — if a file changes, its summary is flagged stale and should be refreshed.`;

/**
 * Build the first-turn injection block from a task-context result.
 * This is appended to the system prompt as an extra part.
 */
export function buildCodemapInjectionBlock(result: TaskContextResult): string {
	if (result.files.length === 0) return "";

	const lines: string[] = [
		"## Relevant Code Summaries",
		`The following file summaries are relevant to the task: "${result.task}"`,
		"",
	];

	for (const file of result.files) {
		const staleTag = file.stale ? (file.missing ? " [STALE: file missing]" : " [STALE: file changed]") : "";
		lines.push(`### ${file.path}${staleTag}`);
		lines.push(file.summary);
		lines.push("");
	}

	lines.push(
		`_${result.meta.fileCount} summaries, ~${result.meta.estimatedTokens} tokens${result.meta.truncated ? " (truncated)" : ""}_`,
	);

	return lines.join("\n");
}
