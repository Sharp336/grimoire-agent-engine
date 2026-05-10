/**
 * NudgeDetector: monitors a running SessionTrace and detects inefficiency patterns
 * with causal root-cause attribution.
 */
import { TraceAnalyzer } from "./trace-analyzer";
import type { Nudge, SessionTrace } from "./types";

const NUDGE_COOLDOWN_MS = 30_000;

export class NudgeDetector {
	#lastNudgeAt = 0;
	readonly #analyzer = new TraceAnalyzer();

	check(trace: SessionTrace): Nudge | undefined {
		const now = Date.now();
		if (now - this.#lastNudgeAt < NUDGE_COOLDOWN_MS) return undefined;

		// Run full causal analysis first
		const diagnosis = this.#analyzer.analyze(trace);

		// Priority ordering: cascades > read failures > error cascade > redundant search > slow loop > read-only-after-write
		const nudge =
			this.#detectCascadingReadFailures(diagnosis) ??
			this.#detectEditVerifyMismatch(diagnosis) ??
			this.#detectSearchMisledRead(diagnosis) ??
			this.#detectErrorCascade(trace) ??
			this.#detectRedundantSearch(trace) ??
			this.#detectSlowLoop(trace) ??
			this.#detectReadOnlyAfterWrite(trace);

		if (nudge) {
			this.#lastNudgeAt = now;
		}
		return nudge;
	}

	#detectCascadingReadFailures(diagnosis: import("./types").ToolChainDiagnosis): Nudge | undefined {
		const verifyFailures = diagnosis.readFailures.filter(rf => rf.failureType === "verify_after_edit_failure");
		if (verifyFailures.length >= 2) {
			return {
				type: "cascade-read-verify-failure",
				severity: "warn",
				message: `${verifyFailures.length} read failures occurred while verifying files after failed edits.`,
				suggestion:
					"The edit tool is failing before the file is modified, so read verification sees the old/unmodified state. Fix the edit (check anchors/payload) before verifying.",
			};
		}
		return undefined;
	}

	#detectEditVerifyMismatch(diagnosis: import("./types").ToolChainDiagnosis): Nudge | undefined {
		const mismatches = diagnosis.readFailures.filter(
			rf =>
				rf.failureType === "path_not_found" &&
				rf.precedingTool &&
				["edit", "write", "ast_edit"].includes(rf.precedingTool) &&
				rf.precedingToolSuccess === false,
		);
		if (mismatches.length >= 1) {
			return {
				type: "edit-verify-path-mismatch",
				severity: "warn",
				message: `Read verification failed after ${mismatches[0].precedingTool} failure — the target file may not exist.`,
				suggestion:
					"edit/write failed, so the file was never modified. The read verification path may be stale. Check if the edit target path exists before editing, and verify the correct path after.",
			};
		}
		return undefined;
	}

	#detectSearchMisledRead(diagnosis: import("./types").ToolChainDiagnosis): Nudge | undefined {
		const misled = diagnosis.readFailures.filter(rf => rf.failureType === "search_misled");
		if (misled.length >= 1) {
			return {
				type: "search-misled-read",
				severity: "info",
				message: "A search/find failure was followed by a read on a guessed path that also failed.",
				suggestion:
					"When search/find fails, do not guess paths for read. Use find to list matching files first, or confirm the file exists with a targeted search.",
			};
		}
		return undefined;
	}

	#detectErrorCascade(trace: SessionTrace): Nudge | undefined {
		const results = trace.entries.filter(e => e.type === "tool_result");
		if (results.length < 3) return undefined;

		const lastThree = results.slice(-3);
		const allErrors = lastThree.every(e => e.isError);
		if (allErrors) {
			// Try to identify the root cause from error details
			const errorTexts = lastThree
				.map(e => {
					if (!e.result) return "";
					try {
						return typeof e.result === "string" ? e.result : JSON.stringify(e.result);
					} catch {
						return "";
					}
				})
				.filter(Boolean);

			const hasPathIssue = errorTexts.some(t => /ENOENT|not found|no such file|Path not found/i.test(t));
			const hasPermission = errorTexts.some(t => /EACCES|permission denied/i.test(t));
			const hasSyntax = errorTexts.some(t => /SyntaxError|Unexpected token|invalid json/i.test(t));

			let suggestion = "Check the error patterns. Is there a missing file, wrong path, or permission issue?";
			if (hasPathIssue)
				suggestion =
					"Consecutive failures involve missing files/paths. Verify paths exist before reading or editing.";
			else if (hasPermission)
				suggestion =
					"Consecutive failures involve permission issues. Check file permissions or use elevated access.";
			else if (hasSyntax)
				suggestion = "Consecutive failures involve syntax or format errors. Review JSON/edit payload formatting.";

			return {
				type: "error-cascade",
				severity: "warn",
				message: "3+ consecutive tool failures detected.",
				suggestion,
			};
		}
		return undefined;
	}

	#detectRedundantSearch(trace: SessionTrace): Nudge | undefined {
		const toolCalls = trace.entries.filter(e => e.type === "tool_call");
		if (toolCalls.length < 3) return undefined;

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
						suggestion:
							"Consider narrowing your search or using ast_grep for structural queries. If searching for a file, use find instead.",
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
				suggestion:
					"Pause and re-evaluate the approach. Are you stuck on a search pattern? Consider using find for file discovery or ast_grep for structural queries.",
			};
		}
		return undefined;
	}

	#detectReadOnlyAfterWrite(trace: SessionTrace): Nudge | undefined {
		const toolCalls = trace.entries.filter(e => e.type === "tool_call");
		if (toolCalls.length < 4) return undefined;

		let lastWriteIndex = -1;
		for (let i = toolCalls.length - 1; i >= 0; i--) {
			const name = toolCalls[i]?.toolName ?? "";
			if (name === "write" || name === "edit" || name === "ast_edit") {
				lastWriteIndex = i;
				break;
			}
		}
		if (lastWriteIndex < 0) return undefined;

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
