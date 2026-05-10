/**
 * ConventionComplianceChecker: lightweight heuristic check for convention
 * adherence based on tool calls and file modifications in a session trace.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Convention, ConventionFeedback, SessionTrace } from "./types";

export class ConventionComplianceChecker {
	/**
	 * Check whether the agent complied with injected conventions during the session.
	 */
	check(trace: SessionTrace, conventions: Convention[]): ConventionFeedback[] {
		const feedback: ConventionFeedback[] = [];
		const filesModified = new Set(
			trace.entries
				.filter(
					e =>
						e.type === "tool_call" &&
						(e.toolName === "write" || e.toolName === "edit" || e.toolName === "ast_edit"),
				)
				.map(e => {
					const path = (e.args as Record<string, unknown>)?.path;
					return typeof path === "string" ? path.toLowerCase() : "";
				})
				.filter(Boolean),
		);
		const toolsUsed = new Set(
			trace.entries.filter(e => e.type === "tool_call" && e.toolName).map(e => e.toolName!.toLowerCase()),
		);
		const userPrompt = trace.userPrompt.toLowerCase();

		for (const convention of conventions) {
			const content = convention.content.toLowerCase();
			let complied = true;
			let violationDetails: string | undefined;

			switch (convention.type) {
				case "negative_rule": {
					// Check if any forbidden action was performed
					const forbiddenFile = this.#extractFileReference(content);
					if (forbiddenFile && filesModified.has(forbiddenFile)) {
						complied = false;
						violationDetails = `Modified forbidden file: ${forbiddenFile}`;
					}
					const forbiddenTool = this.#extractToolReference(content);
					if (forbiddenTool && toolsUsed.has(forbiddenTool)) {
						complied = false;
						violationDetails = `Used forbidden tool: ${forbiddenTool}`;
					}
					break;
				}
				case "positive_rule": {
					// Check if required action was performed
					const requiredFile = this.#extractFileReference(content);
					if (requiredFile && !filesModified.has(requiredFile) && userPrompt.includes(requiredFile)) {
						// Only flag if the task context suggests the file should have been touched
						complied = false;
						violationDetails = `Did not modify required file: ${requiredFile}`;
					}
					break;
				}
				case "preference": {
					// Check if preferred tool was used when relevant
					const preferredTool = this.#extractToolReference(content);
					if (preferredTool && toolsUsed.size > 0 && !toolsUsed.has(preferredTool)) {
						complied = false;
						violationDetails = `Did not use preferred tool: ${preferredTool}`;
					}
					break;
				}
			}

			feedback.push({
				conventionId: convention.id,
				sessionId: trace.sessionId,
				complied,
				violationDetails,
				recordedAt: Date.now(),
			});

			if (!complied) {
				logger.debug("Convention violated", {
					conventionId: convention.id,
					content: convention.content.slice(0, 60),
					violationDetails,
				});
			}
		}

		return feedback;
	}

	#extractFileReference(content: string): string | undefined {
		// Simple heuristic: look for file extensions or known config files
		const match = content.match(/([\w./-]+\.[a-zA-Z0-9]+)/);
		return match ? match[1].toLowerCase() : undefined;
	}

	#extractToolReference(content: string): string | undefined {
		// Map common tool mentions to actual tool names
		const toolMap: Record<string, string> = {
			ast_grep: "ast_grep",
			"ast edit": "ast_edit",
			web_search: "web_search",
			"web search": "web_search",
			bash: "bash",
			python: "python",
			read: "read",
			write: "write",
			edit: "edit",
			search: "search",
			find: "find",
		};
		for (const [key, tool] of Object.entries(toolMap)) {
			if (content.includes(key)) return tool;
		}
		return undefined;
	}
}

export function createConventionComplianceChecker(): ConventionComplianceChecker {
	return new ConventionComplianceChecker();
}
