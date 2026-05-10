/**
 * SkillExtractor: rule-based screening + optional LLM refinement.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { HeuristicSkillEvaluator } from "./evaluator";
import extractSkillPromptTemplate from "./prompts/extract-skill.md" with { type: "text" };
import type { ExtractedSkill, SessionTrace, ToolChainDiagnosis } from "./types";
import { callBackgroundLlm } from "./utils/llm";

export interface ExtractorOptions {
	skillThreshold: number;
	llmRefinement: boolean;
	model?: Model;
}

export class SkillExtractor {
	#evaluator = new HeuristicSkillEvaluator();

	async extract(
		trace: SessionTrace,
		options: ExtractorOptions,
		diagnosis?: ToolChainDiagnosis,
	): Promise<ExtractedSkill | undefined> {
		// Rule 1: must have enough tool calls OR had recovery OR had errors
		const isSignificant = trace.toolCallCount >= options.skillThreshold || trace.hadRecovery || trace.errorCount > 0;
		if (!isSignificant) {
			logger.debug("Skill extraction skipped: task not significant", {
				toolCalls: trace.toolCallCount,
				threshold: options.skillThreshold,
			});
			return undefined;
		}

		// Rule-based extraction (always runs)
		const ruleSkill = this.#ruleExtract(trace, diagnosis);

		// LLM refinement (only for complex successful tasks)
		if (options.llmRefinement && trace.toolCallCount >= options.skillThreshold && trace.completedSuccessfully) {
			const refined = await this.#llmRefine(ruleSkill, trace, options.model);
			if (refined) {
				const score = this.#evaluator.evaluate(refined);
				refined.qualityScore = score.total;
				return refined;
			}
		}

		const score = this.#evaluator.evaluate(ruleSkill);
		ruleSkill.qualityScore = score.total;
		return ruleSkill;
	}

	#ruleExtract(trace: SessionTrace, diagnosis?: ToolChainDiagnosis): ExtractedSkill {
		const toolsUsed = new Set<string>();
		const filesModified = new Set<string>();

		for (const entry of trace.entries) {
			if (entry.type === "tool_call" && entry.toolName) {
				toolsUsed.add(entry.toolName);
				if (entry.toolName === "write" || entry.toolName === "edit" || entry.toolName === "ast_edit") {
					const p = (entry.args as Record<string, unknown>)?.path;
					if (typeof p === "string") filesModified.add(p);
				}
			}
		}

		const userPrompt = trace.userPrompt || "untitled task";
		const name = this.#toKebabCase(userPrompt.slice(0, 40));
		const description = `Extracted from session ${trace.sessionId}: ${userPrompt.slice(0, 120)}`;
		const taskPattern = userPrompt.slice(0, 200);

		// Build a simple approach from the tool sequence
		const approach = this.#buildApproach(trace, Array.from(filesModified));

		// Build pitfalls from errors observed
		// Build pitfalls from errors observed (enhanced with causal diagnosis)
		const pitfalls = this.#buildPitfalls(trace, diagnosis);

		return {
			name,
			description,
			taskPattern,
			approach,
			tools: Array.from(toolsUsed),
			pitfalls,
			qualityScore: 0,
			llmRefined: false,
			autonomyNotes: "Initial extraction. May need refinement for full autonomy.",
		};
	}

	async #llmRefine(
		ruleSkill: ExtractedSkill,
		trace: SessionTrace,
		model?: Model,
	): Promise<ExtractedSkill | undefined> {
		// Build a condensed trace summary for the LLM
		const toolSummary = trace.entries
			.filter(e => e.type === "tool_call")
			.map(e => e.toolName)
			.join(", ");
		const errorSummary = trace.errorCount > 0 ? `Errors encountered: ${trace.errorCount}` : "No errors";
		const recoverySummary = trace.hadRecovery ? "The agent recovered from errors during execution." : "";

		// Extract recent user inputs and assistant reasoning from the trace
		const userInputs = trace.entries
			.filter(e => e.type === "user_input" && e.content)
			.slice(-5)
			.map((e, i) => `User input ${i + 1}: ${e.content}`)
			.join("\n");
		const assistantMessages = trace.entries
			.filter(e => e.type === "assistant_message" && e.content)
			.slice(-3)
			.map((e, i) => `Agent reasoning ${i + 1}: ${e.content}`)
			.join("\n");

		const userPrompt = `Task: ${trace.userPrompt}\n\nTools used: ${toolSummary}\n${errorSummary}\n${recoverySummary}\n\nRecent user dialogue:\n${userInputs || "(none recorded)"}\n\nRecent agent reasoning:\n${assistantMessages || "(none recorded)"}\n\nWhat project-specific conventions did the user enforce? What pitfalls are specific to THIS codebase?\n\nCurrent rule-based extraction:\n- Name: ${ruleSkill.name}\n- Task pattern: ${ruleSkill.taskPattern}\n- Approach: ${ruleSkill.approach}\n- Tools: ${ruleSkill.tools.join(", ")}\n- Pitfalls: ${ruleSkill.pitfalls.join("; ") || "none"}\n\nPlease refine the approach and pitfalls based on the actual execution trace. Return ONLY a JSON object with fields: approach (string), pitfalls (string[]), description (string), taskPattern (string).`;

		const response = await callBackgroundLlm(model, extractSkillPromptTemplate, userPrompt);
		if (!response) return undefined;

		try {
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			const json = jsonMatch ? jsonMatch[0] : response;
			const parsed = JSON.parse(json) as {
				approach?: string;
				pitfalls?: string[];
				description?: string;
				taskPattern?: string;
			};

			return {
				...ruleSkill,
				approach: parsed.approach || ruleSkill.approach,
				pitfalls: Array.isArray(parsed.pitfalls) ? parsed.pitfalls : ruleSkill.pitfalls,
				description: parsed.description || ruleSkill.description,
				taskPattern: parsed.taskPattern || ruleSkill.taskPattern,
				llmRefined: true,
			};
		} catch (err) {
			logger.warn("LLM skill refinement parse failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	}

	#toKebabCase(input: string): string {
		// Filter out meaningless prompts that produce garbage skill names
		const trimmed = input.trim();
		const meaningless = /^\s*(yes|no|ok|sure|start|go|1|2|3|4|5|6|7|8|9|0|\d+)\s*$/i;
		if (meaningless.test(trimmed) || trimmed.length < 5) {
			return `task-${Date.now().toString(36)}`;
		}
		return trimmed
			.toLowerCase()
			.replace(/[^a-z0-9\s]+/g, " ")
			.trim()
			.replace(/\s+/g, "-")
			.slice(0, 60);
	}

	#buildApproach(trace: SessionTrace, files: string[]): string {
		const steps: string[] = [];
		for (const entry of trace.entries) {
			if (entry.type === "tool_call" && entry.toolName) {
				steps.push(entry.toolName);
			}
		}
		const deduped = [...new Set(steps)];
		const fileHint = files.length > 0 ? ` Modified files: ${files.join(", ")}.` : "";
		return `Tool sequence: ${deduped.join(" → ")}.${fileHint}`;
	}

	#buildPitfalls(trace: SessionTrace, diagnosis?: ToolChainDiagnosis): string[] {
		const pitfalls: string[] = [];

		// Add diagnosis-driven pitfalls when available
		if (diagnosis) {
			// Report top read failure type with specific guidance
			if (diagnosis.readFailures.length > 0) {
				const byType = new Map<string, number>();
				for (const rf of diagnosis.readFailures) {
					byType.set(rf.failureType, (byType.get(rf.failureType) ?? 0) + 1);
				}
				const top = [...byType.entries()].sort((a, b) => b[1] - a[1])[0];
				if (top) {
					const [type, count] = top;
					pitfalls.push(
						`Causal diagnosis: ${count} read failure(s) of type "${type}". ${this.#readFailurePitfall(type)}`,
					);
				}
			}

			// Report top cascade pattern
			if (diagnosis.cascadePatterns.length > 0) {
				const top = diagnosis.cascadePatterns[0];
				pitfalls.push(
					`Cascade risk: ${top.triggerTool} failure can trigger ${top.followUpTool} failure. Root cause: ${top.rootCause}.`,
				);
			}

			if (diagnosis.redundantSearches) {
				pitfalls.push("Redundant search chains detected; prefer find or ast_grep for structural queries.");
			}

			if (diagnosis.slowLoop) {
				pitfalls.push("Slow tool loop: many calls with no successful modifications. Re-evaluate approach earlier.");
			}
		}

		if (trace.errorCount > 0) {
			pitfalls.push(`Watch for errors when running similar tasks; ${trace.errorCount} error(s) occurred.`);
		}
		if (trace.hadRecovery) {
			pitfalls.push("Agent recovered from an error mid-task; verify outputs when retrying.");
		}
		return pitfalls;
	}

	#readFailurePitfall(type: string): string {
		switch (type) {
			case "path_not_found":
				return "Always confirm file existence with find before reading.";
			case "permission_denied":
				return "Check file permissions before attempting reads.";
			case "invalid_sel":
				return "Validate line range selectors; use 1-indexed format.";
			case "verify_after_edit_failure":
				return "Confirm edit success before reading back to verify.";
			case "search_misled":
				return "Do not guess paths from failed searches; confirm with find.";
			default:
				return "Review read arguments and preconditions carefully.";
		}
	}
}
