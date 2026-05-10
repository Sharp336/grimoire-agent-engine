/**
 * TraceAnalyzer: causal tool-chain diagnosis engine.
 *
 * Analyzes SessionTrace to identify:
 * - Tool failure cascades (why tool X failing caused tool Y to fail)
 * - Read failure root causes (path missing vs edit-verify mismatch vs search-misled)
 * - Adaptive error pattern discovery (new patterns not in hard-coded list)
 * - Tool efficiency and redundancy detection
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import traceAnalysisSystemTemplate from "./prompts/trace-analysis.md" with { type: "text" };
import traceAnalysisInputTemplate from "./prompts/trace-analysis-input.md" with { type: "text" };
import type {
	CascadePattern,
	ReadFailureAnalysis,
	ReadFailureType,
	SessionTrace,
	ToolChainDiagnosis,
	TraceEntry,
} from "./types";
import { callBackgroundLlm } from "./utils/llm";

interface PairedToolCall {
	call: TraceEntry;
	result: TraceEntry;
	index: number;
}

/** JSON schema returned by the LLM diagnosis. */
interface LlmDiagnosisOutput {
	read_failures: Array<{
		failure_type: ReadFailureType;
		attempted_path: string | null;
		preceding_tool: string | null;
		preceding_tool_succeeded: boolean | null;
		suggestion: string;
	}>;
	cascade_patterns: Array<{
		trigger_tool: string;
		trigger_error: string;
		follow_up_tool: string;
		follow_up_error: string | null;
		root_cause: string;
		count: number;
		suggestion: string;
	}>;
	redundant_searches: boolean;
	slow_loop: boolean;
	tool_efficiency: number;
	dominant_error_tool: string | null;
	dominant_error_pattern: string | null;
	suggested_action: string;
}

const READ_FAILURE_SIGNATURES: Array<{
	pattern: RegExp;
	failureType: ReadFailureType;
	suggestion: string;
}> = [
	{
		pattern: /ENOENT|no such file or directory|Path not found|ENOTDIR/i,
		failureType: "path_not_found",
		suggestion: "Path does not exist. Use find/search first, or verify the path was not renamed/moved.",
	},
	{
		pattern: /EACCES|permission denied|Access denied/i,
		failureType: "permission_denied",
		suggestion: "Permission denied. Check file permissions or use elevated access.",
	},
	{
		pattern: /sel=0 is invalid|Invalid range|count must be >= 1|end must be >= start/i,
		failureType: "invalid_sel",
		suggestion: "Invalid sel parameter. Use 1-indexed line numbers. Format: '50', '50-200', '50+150'.",
	},
];

export class TraceAnalyzer {
	/**
	 * Run full causal analysis on a session trace.
	 */
	analyze(trace: SessionTrace): ToolChainDiagnosis {
		const paired = this.#pairToolCalls(trace);
		const readFailures = this.#analyzeReadFailures(paired);
		const cascadePatterns = this.#detectCascades(paired);
		const redundantSearches = this.#detectRedundantSearches(paired);
		const slowLoop = this.#detectSlowLoop(paired);
		const toolEfficiency = this.#computeToolEfficiency(paired);
		const dominantErrorTool = this.#findDominantErrorTool(paired);
		const dominantErrorPattern = this.#findDominantErrorPattern(paired);

		const suggestedAction = this.#buildSuggestion(
			readFailures,
			cascadePatterns,
			redundantSearches,
			slowLoop,
			dominantErrorTool,
		);

		return {
			sessionId: trace.sessionId,
			readFailures,
			cascadePatterns,
			redundantSearches,
			slowLoop,
			toolEfficiency,
			dominantErrorTool,
			dominantErrorPattern,
			suggestedAction,
		};
	}

	/**
	 * Deep LLM-enhanced analysis (asynchronous).
	 * Use at session end or for cross-session aggregation where causal attribution matters.
	 *
	 * Falls back to rule-based analysis if the LLM call fails or no model is provided.
	 */
	async analyzeWithLlm(trace: SessionTrace, model?: Model): Promise<ToolChainDiagnosis> {
		const ruleBased = this.analyze(trace);
		if (!model) return ruleBased;

		const llmResult = await this.#callLlmDiagnosis(trace, model);
		if (!llmResult) return ruleBased;

		return this.#mergeDiagnoses(ruleBased, llmResult);
	}

	async #callLlmDiagnosis(trace: SessionTrace, model: Model): Promise<LlmDiagnosisOutput | undefined> {
		const toolEntries = trace.entries
			.filter(e => e.type === "tool_call" || e.type === "tool_result")
			.map(e => ({
				type: e.type,
				toolName: e.toolName,
				timestamp: e.timestamp,
				isError: e.isError,
				args: e.args,
				result: typeof e.result === "string" ? e.result.slice(0, 500) : e.result,
			}));

		const traceJson = JSON.stringify(toolEntries, null, 2).slice(0, 12_000);

		const userPrompt = prompt.render(traceAnalysisInputTemplate, {
			session_id: trace.sessionId,
			cwd: trace.cwd,
			user_prompt: trace.userPrompt.slice(0, 200),
			tool_call_count: String(trace.toolCallCount),
			error_count: String(trace.errorCount),
			completed_successfully: String(trace.completedSuccessfully),
			trace_json: traceJson,
		});

		const responseText = await callBackgroundLlm(model, traceAnalysisSystemTemplate, userPrompt);
		if (!responseText) return undefined;

		try {
			const parsed = this.#parseJsonObject(responseText);
			if (!parsed) {
				logger.warn("LLM trace analysis returned non-JSON", { snippet: responseText.slice(0, 200) });
				return undefined;
			}
			return this.#validateLlmOutput(parsed);
		} catch (err) {
			logger.warn("LLM trace analysis parse failed", { error: String(err) });
			return undefined;
		}
	}

	#mergeDiagnoses(rule: ToolChainDiagnosis, llm: LlmDiagnosisOutput): ToolChainDiagnosis {
		const llmReadFailures: ReadFailureAnalysis[] = llm.read_failures.map(rf => ({
			failureType: rf.failure_type,
			attemptedPath: rf.attempted_path ?? undefined,
			precedingTool: rf.preceding_tool ?? undefined,
			precedingToolSuccess: rf.preceding_tool_succeeded ?? undefined,
			suggestion: rf.suggestion,
		}));

		const llmCascades: CascadePattern[] = llm.cascade_patterns.map(cp => ({
			triggerTool: cp.trigger_tool,
			triggerError: cp.trigger_error,
			followUpTool: cp.follow_up_tool,
			followUpError: cp.follow_up_error ?? undefined,
			rootCause: cp.root_cause,
			count: cp.count,
		}));

		return {
			...rule,
			readFailures: llmReadFailures.length > 0 ? llmReadFailures : rule.readFailures,
			cascadePatterns: llmCascades.length > 0 ? llmCascades : rule.cascadePatterns,
			suggestedAction: llm.suggested_action || rule.suggestedAction,
			dominantErrorTool: llm.dominant_error_tool ?? rule.dominantErrorTool,
			dominantErrorPattern: llm.dominant_error_pattern ?? rule.dominantErrorPattern,
		};
	}

	#parseJsonObject(text: string): Record<string, unknown> | undefined {
		if (!text) return undefined;
		let candidate = text.trim();
		const codeBlockMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (codeBlockMatch) candidate = codeBlockMatch[1].trim();

		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			/* continue */
		}

		let depth = 0;
		let start = -1;
		for (let i = 0; i < candidate.length; i++) {
			if (candidate[i] === "{" && (i === 0 || candidate[i - 1] !== "\\")) {
				if (depth === 0) start = i;
				depth++;
			} else if (candidate[i] === "}" && (i === 0 || candidate[i - 1] !== "\\")) {
				depth--;
				if (depth === 0 && start !== -1) {
					try {
						const extracted = candidate.slice(start, i + 1);
						const parsed = JSON.parse(extracted) as unknown;
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
							return parsed as Record<string, unknown>;
						}
					} catch {
						/* continue */
					}
				}
			}
		}
		return undefined;
	}

	#validateLlmOutput(value: Record<string, unknown>): LlmDiagnosisOutput | undefined {
		if (!Array.isArray(value.read_failures)) return undefined;
		if (!Array.isArray(value.cascade_patterns)) return undefined;
		if (typeof value.redundant_searches !== "boolean") return undefined;
		if (typeof value.slow_loop !== "boolean") return undefined;
		if (typeof value.tool_efficiency !== "number") return undefined;
		if (typeof value.suggested_action !== "string") return undefined;

		return {
			read_failures: value.read_failures.filter(this.#isValidReadFailure),
			cascade_patterns: value.cascade_patterns.filter(this.#isValidCascade),
			redundant_searches: value.redundant_searches,
			slow_loop: value.slow_loop,
			tool_efficiency: value.tool_efficiency,
			dominant_error_tool: typeof value.dominant_error_tool === "string" ? value.dominant_error_tool : null,
			dominant_error_pattern: typeof value.dominant_error_pattern === "string" ? value.dominant_error_pattern : null,
			suggested_action: value.suggested_action,
		};
	}

	#isValidReadFailure(item: unknown): boolean {
		if (!item || typeof item !== "object") return false;
		const o = item as Record<string, unknown>;
		return typeof o.failure_type === "string" && typeof o.suggestion === "string";
	}

	#isValidCascade(item: unknown): boolean {
		if (!item || typeof item !== "object") return false;
		const o = item as Record<string, unknown>;
		return (
			typeof o.trigger_tool === "string" &&
			typeof o.follow_up_tool === "string" &&
			typeof o.root_cause === "string" &&
			typeof o.count === "number" &&
			typeof o.suggestion === "string"
		);
	}

	/**
	 * Pair each tool_call with its corresponding tool_result.
	 */
	#pairToolCalls(trace: SessionTrace): PairedToolCall[] {
		const paired: PairedToolCall[] = [];
		const pending: TraceEntry[] = [];

		for (let i = 0; i < trace.entries.length; i++) {
			const entry = trace.entries[i];
			if (entry.type === "tool_call") {
				pending.push(entry);
			} else if (entry.type === "tool_result" && pending.length > 0) {
				const call = pending.shift()!;
				paired.push({ call, result: entry, index: i });
			}
		}

		return paired;
	}

	/**
	 * Analyze read failures with root-cause attribution.
	 */
	#analyzeReadFailures(paired: PairedToolCall[]): ReadFailureAnalysis[] {
		const failures: ReadFailureAnalysis[] = [];

		for (let i = 0; i < paired.length; i++) {
			const { call, result } = paired[i];
			if (call.toolName !== "read" || !result.isError) continue;

			const errorText = this.#extractErrorText(result);
			const attemptedPath = this.#extractPath(call.args);
			const preceding = i > 0 ? paired[i - 1] : undefined;

			// Determine failure type from error text
			let failureType: ReadFailureType = "other";
			let suggestion = "Review the read call arguments and ensure the path exists.";

			for (const sig of READ_FAILURE_SIGNATURES) {
				if (sig.pattern.test(errorText)) {
					failureType = sig.failureType;
					suggestion = sig.suggestion;
					break;
				}
			}

			// Causal analysis: was this a verification read after a failed edit?
			if (
				preceding &&
				(preceding.call.toolName === "edit" ||
					preceding.call.toolName === "write" ||
					preceding.call.toolName === "ast_edit") &&
				preceding.result.isError &&
				failureType === "path_not_found"
			) {
				failureType = "verify_after_edit_failure";
				suggestion = `The preceding ${preceding.call.toolName} failed, then read was used to verify — but the file was never modified. The read path may be stale or the edit never succeeded.`;
			}

			// Causal analysis: was this read based on a search/find result?
			if (
				preceding &&
				(preceding.call.toolName === "search" || preceding.call.toolName === "find") &&
				preceding.result.isError &&
				failureType === "path_not_found"
			) {
				failureType = "search_misled";
				suggestion =
					"The preceding search/find failed, suggesting the target does not exist in the expected location.";
			}

			failures.push({
				failureType,
				attemptedPath,
				precedingTool: preceding?.call.toolName,
				precedingToolSuccess: preceding ? !preceding.result.isError : undefined,
				suggestion,
			});
		}

		return failures;
	}

	/**
	 * Detect cascade patterns: tool A fails, then tool B is called and also fails.
	 */
	#detectCascades(paired: PairedToolCall[]): CascadePattern[] {
		const patterns = new Map<string, CascadePattern>();

		for (let i = 0; i < paired.length - 1; i++) {
			const current = paired[i];
			const next = paired[i + 1];

			if (!current.result.isError) continue;

			const triggerTool = current.call.toolName ?? "unknown";
			const triggerError = this.#extractErrorText(current.result).slice(0, 80);
			const followUpTool = next.call.toolName ?? "unknown";

			// Only count if the follow-up is likely a remediation attempt
			const remediationTools = new Set(["read", "search", "find", "bash"]);
			if (!remediationTools.has(followUpTool)) continue;

			const followUpError = next.result.isError ? this.#extractErrorText(next.result).slice(0, 80) : undefined;

			const rootCause = this.#inferRootCause(current, next);
			const key = `${triggerTool}:${triggerError}:${followUpTool}`;

			const existing = patterns.get(key);
			if (existing) {
				existing.count++;
			} else {
				patterns.set(key, {
					triggerTool,
					triggerError,
					followUpTool,
					followUpError,
					rootCause,
					count: 1,
				});
			}
		}

		return Array.from(patterns.values()).sort((a, b) => b.count - a.count);
	}

	/**
	 * Detect redundant search chains (3+ consecutive search/read/find with no modification).
	 */
	#detectRedundantSearches(paired: PairedToolCall[]): boolean {
		let consecutive = 0;
		for (const { call } of paired) {
			const name = call.toolName ?? "";
			if (name === "search" || name === "find" || name === "read") {
				consecutive++;
				if (consecutive >= 3) return true;
			} else if (name === "write" || name === "edit" || name === "ast_edit") {
				consecutive = 0;
			}
		}
		return false;
	}

	/**
	 * Detect slow loop: many calls with no successful file modification.
	 */
	#detectSlowLoop(paired: PairedToolCall[]): boolean {
		if (paired.length < 5) return false;
		const hasMod = paired.some(
			p =>
				!p.result.isError &&
				(p.call.toolName === "write" || p.call.toolName === "edit" || p.call.toolName === "ast_edit"),
		);
		return !hasMod;
	}

	/**
	 * Compute tool efficiency: successful modifications / total calls.
	 */
	#computeToolEfficiency(paired: PairedToolCall[]): number {
		if (paired.length === 0) return 1;
		const modCalls = paired.filter(
			p => p.call.toolName === "write" || p.call.toolName === "edit" || p.call.toolName === "ast_edit",
		);
		if (modCalls.length === 0) return 1;
		const successful = modCalls.filter(p => !p.result.isError).length;
		return successful / modCalls.length;
	}

	/**
	 * Find the tool that caused the most errors in this session.
	 */
	#findDominantErrorTool(paired: PairedToolCall[]): string | undefined {
		const counts: Record<string, number> = {};
		for (const { call, result } of paired) {
			if (!result.isError || !call.toolName) continue;
			counts[call.toolName] = (counts[call.toolName] ?? 0) + 1;
		}
		const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
		return sorted[0]?.[0];
	}

	/**
	 * Find the dominant error pattern by grouping similar error messages.
	 */
	#findDominantErrorPattern(paired: PairedToolCall[]): string | undefined {
		const counts: Record<string, number> = {};
		for (const { result } of paired) {
			if (!result.isError) continue;
			const text = this.#extractErrorText(result).slice(0, 60);
			if (text.length < 5) continue;
			counts[text] = (counts[text] ?? 0) + 1;
		}
		const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
		return sorted[0]?.[0];
	}

	/**
	 * Infer the root cause of a cascade (why the trigger tool failed).
	 */
	#inferRootCause(trigger: PairedToolCall, followUp: PairedToolCall): string {
		const triggerTool = trigger.call.toolName ?? "unknown";
		const triggerError = this.#extractErrorText(trigger.result);
		const followUpTool = followUp.call.toolName ?? "unknown";

		// edit failure → read verification failure
		if (
			(triggerTool === "edit" || triggerTool === "ast_edit") &&
			followUpTool === "read" &&
			triggerError.includes("anchor")
		) {
			return "edit anchor mismatch — the file content did not match expected state";
		}

		// edit failure → read verification failure (path mismatch)
		if (
			(triggerTool === "edit" || triggerTool === "write") &&
			followUpTool === "read" &&
			(triggerError.includes("ENOENT") || triggerError.includes("not found"))
		) {
			return "edit/write targeted a non-existent path, read verification confirmed absence";
		}

		// read failure → search retry
		if (triggerTool === "read" && followUpTool === "search") {
			return "read failed, agent fell back to search to locate the file";
		}

		// search failure → read guess
		if (triggerTool === "search" && followUpTool === "read") {
			return "search returned no results, agent guessed a path and read failed";
		}

		// bash failure → read verification
		if (triggerTool === "bash" && followUpTool === "read") {
			return "shell command failed, agent tried to read output file that was never created";
		}

		return `${triggerTool} failure led to ${followUpTool} remediation attempt`;
	}

	/**
	 * Build a human-readable suggestion based on the full diagnosis.
	 */
	#buildSuggestion(
		readFailures: ReadFailureAnalysis[],
		cascades: CascadePattern[],
		redundantSearches: boolean,
		slowLoop: boolean,
		dominantErrorTool?: string,
	): string {
		const parts: string[] = [];

		if (readFailures.length > 0) {
			const byType = this.#groupBy(readFailures, f => f.failureType);
			const topType = Object.entries(byType).sort((a, b) => b[1].length - a[1].length)[0];
			if (topType) {
				parts.push(
					`Primary read issue: ${topType[0]} (${topType[1].length} occurrences). ${topType[1][0]?.suggestion}`,
				);
			}
		}

		if (cascades.length > 0 && cascades[0].count >= 2) {
			const top = cascades[0];
			parts.push(
				`Cascade pattern: ${top.triggerTool} failure → ${top.followUpTool} failure. Root cause: ${top.rootCause}`,
			);
		}

		if (redundantSearches) {
			parts.push("Redundant search chain detected. Consider using find or ast_grep for structural queries.");
		}

		if (slowLoop) {
			parts.push("Slow loop: many tool calls with no successful modifications. Re-evaluate approach.");
		}

		if (dominantErrorTool && !parts.some(p => p.includes(dominantErrorTool))) {
			parts.push(`Dominant error source: "${dominantErrorTool}". Review tool arguments and preconditions.`);
		}

		return parts.join(" | ") || "No significant issues detected.";
	}

	#extractErrorText(result: TraceEntry): string {
		if (!result.result) return "";
		try {
			return typeof result.result === "string" ? result.result : JSON.stringify(result.result);
		} catch {
			return "";
		}
	}

	#extractPath(args: unknown): string | undefined {
		if (!args || typeof args !== "object") return undefined;
		const a = args as Record<string, unknown>;
		const p = a.path ?? a.file_path;
		return typeof p === "string" ? p : undefined;
	}

	#groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
		const result = {} as Record<K, T[]>;
		for (const item of items) {
			const key = keyFn(item);
			if (!result[key]) result[key] = [];
			result[key].push(item);
		}
		return result;
	}
}

/**
 * Aggregate trace-level diagnoses across multiple episodes for cross-session analysis.
 */
export function aggregateDiagnoses(
	diagnoses: ToolChainDiagnosis[],
	project: string,
): import("./types").CrossSessionDiagnosis {
	const totalEpisodes = diagnoses.length;
	const failedEpisodes = diagnoses.filter(d => d.readFailures.length > 0 || d.cascadePatterns.length > 0).length;

	// Count read failures by type
	const breakdown: Record<ReadFailureType, number> = {
		path_not_found: 0,
		permission_denied: 0,
		invalid_sel: 0,
		verify_after_edit_failure: 0,
		search_misled: 0,
		other: 0,
	};

	let totalReadFailures = 0;
	const allCascades: CascadePattern[] = [];

	for (const d of diagnoses) {
		for (const rf of d.readFailures) {
			breakdown[rf.failureType]++;
			totalReadFailures++;
		}
		allCascades.push(...d.cascadePatterns);
	}

	const readFailureRate = totalEpisodes > 0 ? totalReadFailures / totalEpisodes : 0;

	// Find top cascade pattern across all sessions
	const cascadeMap = new Map<string, CascadePattern>();
	for (const c of allCascades) {
		const key = `${c.triggerTool}:${c.followUpTool}:${c.rootCause}`;
		const existing = cascadeMap.get(key);
		if (existing) {
			existing.count += c.count;
		} else {
			cascadeMap.set(key, { ...c });
		}
	}
	const topCascade = Array.from(cascadeMap.values()).sort((a, b) => b.count - a.count)[0];

	// Trend: compare recent 10 vs previous 10
	const recent = diagnoses.slice(-10).filter(d => d.readFailures.length > 0).length;
	const previous = diagnoses.slice(-20, -10).filter(d => d.readFailures.length > 0).length;
	let trend: "improving" | "stable" | "degrading" = "stable";
	if (recent < previous * 0.7) trend = "improving";
	else if (recent > previous * 1.3) trend = "degrading";

	// Root cause summary
	const topType = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0];
	const rootCauseSummary =
		topType && topType[1] > 0
			? `Read failures dominated by "${topType[0]}" (${topType[1]} cases). ${topCascade ? `Top cascade: ${topCascade.triggerTool} → ${topCascade.followUpTool}.` : ""}`
			: "No significant read failure patterns.";

	return {
		project,
		totalEpisodes,
		failedEpisodes,
		readFailureRate,
		readFailureBreakdown: breakdown,
		topCascadePattern: topCascade,
		trend,
		rootCauseSummary,
	};
}
