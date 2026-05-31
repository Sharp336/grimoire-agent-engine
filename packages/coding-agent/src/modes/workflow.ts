import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

/**
 * "workflowz" keyword support.
 *
 * Typing the explicit "/workflow" prefix in the input editor paints it with a
 * warm amber→green gradient ({@link highlightWorkflow}); submitting a message
 * that starts with it appends a hidden {@link WORKFLOW_NOTICE} that steers the
 * model to author a deterministic multi-subagent workflow in eval cells
 * (agent/parallel/pipeline). Matching is case-sensitive and command-prefixed
 * only, so ordinary prose mentioning "workflow" never triggers.
 */

// Detection: explicit slash command prefix only. Non-global so `.test` stays stateless.
const WORKFLOW_COMMAND = /^\s*\/workflow(?:\s|$)/;

/** Hidden system notice appended after a user message starts with "/workflow". */
export const WORKFLOW_NOTICE: string = workflowNotice.trim();

/**
 * Whether `text` starts with the explicit "/workflow" command prefix in prose —
 * never inside a code block, inline code span, or XML/HTML section.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_COMMAND);
}

/**
 * Highlight the explicit "/workflow" command prefix in `text` for editor
 * display with a warm amber→green gradient (hue 30..150), visually distinct
 * from ultrathink's rainbow and orchestrate's teal→violet.
 */
export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /\/workflow/,
	highlight: /^\s*\/workflow(?=\s|$)/g,
	stops: 14,
	hue: t => 30 + t * 120,
});
