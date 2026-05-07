/**
 * SkillExtractor: rule-based screening + optional LLM refinement.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { HeuristicSkillEvaluator } from "./evaluator";
import extractSkillPromptTemplate from "./prompts/extract-skill.md" with { type: "text" };
import type { ExtractedSkill, SessionTrace } from "./types";
import { callBackgroundLlm } from "./utils/llm";

export interface ExtractorOptions {
	skillThreshold: number;
	llmRefinement: boolean;
	model?: Model;
}

export class SkillExtractor {
	#evaluator = new HeuristicSkillEvaluator();

	async extract(trace: SessionTrace, options: ExtractorOptions): Promise<ExtractedSkill | undefined> {
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
		const ruleSkill = this.#ruleExtract(trace);

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

	#ruleExtract(trace: SessionTrace): ExtractedSkill {
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
		const pitfalls = this.#buildPitfalls(trace);

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
		return input
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

	#buildPitfalls(trace: SessionTrace): string[] {
		const pitfalls: string[] = [];
		if (trace.errorCount > 0) {
			pitfalls.push(`Watch for errors when running similar tasks; ${trace.errorCount} error(s) occurred.`);
		}
		if (trace.hadRecovery) {
			pitfalls.push("Agent recovered from an error mid-task; verify outputs when retrying.");
		}
		return pitfalls;
	}
}
