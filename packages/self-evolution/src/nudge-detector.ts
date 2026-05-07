/**
 * NudgeDetector: monitors a running SessionTrace and detects inefficiency patterns.
 */
import type { SessionTrace } from "./types";

export interface Nudge {
	type: string;
	severity: "info" | "warn";
	message: string;
	suggestion: string;
}

const NUDGE_COOLDOWN_MS = 30_000;

export class NudgeDetector {
	#lastNudgeAt = 0;

	check(trace: SessionTrace): Nudge | undefined {
		const now = Date.now();
		if (now - this.#lastNudgeAt < NUDGE_COOLDOWN_MS) return undefined;

		const nudge =
			this.#detectErrorCascade(trace) ??
			this.#detectRedundantSearch(trace) ??
			this.#detectSlowLoop(trace) ??
			this.#detectReadOnlyAfterWrite(trace);

		if (nudge) {
			this.#lastNudgeAt = now;
		}
		return nudge;
	}

	#detectRedundantSearch(trace: SessionTrace): Nudge | undefined {
		const toolCalls = trace.entries.filter(e => e.type === "tool_call");
		if (toolCalls.length < 3) return undefined;

		// Look for 3+ consecutive search/read/find calls
		let consecutiveSearch = 0;
		for (const entry of toolCalls) {
			const name = entry.toolName ?? "";
			if (name === "search" || name === "find" || name === "read") {
				consecutiveSearch++;
				if (consecutiveSearch >= 3) {
					return {
						type: "redundant-search",
						severity: "info",
						message: "Multiple consecutive searches detected with no file modifications.",
						suggestion: "Consider narrowing your search or using ast_grep for structural queries.",
					};
				}
			} else {
				consecutiveSearch = 0;
			}
		}
		return undefined;
	}

	#detectSlowLoop(trace: SessionTrace): Nudge | undefined {
		if (trace.toolCallCount < 5) return undefined;

		const toolCalls = trace.entries.filter(e => e.type === "tool_call");
		const hasFileMod = toolCalls.some(e => {
			const name = e.toolName ?? "";
			return name === "write" || name === "edit" || name === "ast_edit";
		});

		if (!hasFileMod) {
			return {
				type: "slow-loop",
				severity: "warn",
				message: `${trace.toolCallCount} tool calls with no successful file modifications — possible spinning.`,
				suggestion: "Pause and re-evaluate the approach. Are you stuck on a search pattern?",
			};
		}
		return undefined;
	}

	#detectErrorCascade(trace: SessionTrace): Nudge | undefined {
		const results = trace.entries.filter(e => e.type === "tool_result");
		if (results.length < 3) return undefined;

		// Check last 3 tool results
		const lastThree = results.slice(-3);
		const allErrors = lastThree.every(e => e.isError);
		if (allErrors) {
			return {
				type: "error-cascade",
				severity: "warn",
				message: "3+ consecutive tool failures detected.",
				suggestion: "Check the error patterns. Is there a missing file, wrong path, or permission issue?",
			};
		}
		return undefined;
	}

	#detectReadOnlyAfterWrite(trace: SessionTrace): Nudge | undefined {
		const toolCalls = trace.entries.filter(e => e.type === "tool_call");
		if (toolCalls.length < 4) return undefined;

		// Find last write/edit
		let lastWriteIndex = -1;
		for (let i = toolCalls.length - 1; i >= 0; i--) {
			const name = toolCalls[i]?.toolName ?? "";
			if (name === "write" || name === "edit" || name === "ast_edit") {
				lastWriteIndex = i;
				break;
			}
		}
		if (lastWriteIndex < 0) return undefined;

		// Check if everything after last write is read-only
		const afterWrite = toolCalls.slice(lastWriteIndex + 1);
		if (
			afterWrite.length >= 3 &&
			afterWrite.every(e => {
				const name = e.toolName ?? "";
				return name === "read" || name === "search" || name === "find";
			})
		) {
			return {
				type: "read-only-after-write",
				severity: "info",
				message: "Multiple read-only operations after the last file modification.",
				suggestion: "If verification is complete, consider wrapping up the task or running tests.",
			};
		}
		return undefined;
	}
}
