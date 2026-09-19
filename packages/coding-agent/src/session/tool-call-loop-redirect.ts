import type { RepeatedToolCallDetection } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { prompt } from "@oh-my-pi/pi-utils";
import toolCallLoopRedirectTemplate from "../prompts/system/tool-call-loop-redirect.md" with { type: "text" };

export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

/** Structured record of the loop a redirect was issued for. */
export interface ToolCallLoopRedirectDetails {
	toolName: string;
	count: number;
	argumentsSummary: string;
	resultSummary: string;
}

export function renderToolCallLoopRedirect(detection: RepeatedToolCallDetection): string {
	return prompt.render(toolCallLoopRedirectTemplate, {
		tool_name: detection.toolName,
		count: detection.count,
		arguments_summary: detection.argumentsSummary,
		result_summary: detection.resultSummary || "(no text result)",
	});
}

export function toolCallLoopRedirectDetails(detection: RepeatedToolCallDetection): ToolCallLoopRedirectDetails {
	return {
		toolName: detection.toolName,
		count: detection.count,
		argumentsSummary: detection.argumentsSummary,
		resultSummary: detection.resultSummary,
	};
}
