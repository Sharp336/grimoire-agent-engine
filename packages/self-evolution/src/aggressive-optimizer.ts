/**
 * AggressiveSkillOptimizer: deeply rewrites skills based on failure history
 * to maximize agent autonomy and minimize human intervention.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import aggressiveOptimizeTemplate from "./prompts/aggressive-optimize.md" with { type: "text" };
import type { EvolvedSkill } from "./types";
import { callBackgroundLlm } from "./utils/llm";

export interface FailureCase {
	episodeId: string;
	summary: string;
	errorPattern: string;
}

export class AggressiveSkillOptimizer {
	async optimize(
		skill: EvolvedSkill,
		model: Model | undefined,
		failureHistory?: FailureCase[],
	): Promise<EvolvedSkill> {
		if (!model) {
			logger.debug("Aggressive optimization skipped: no model available");
			return skill;
		}

		const userPrompt = this.#buildPrompt(skill, failureHistory);
		const response = await callBackgroundLlm(model, aggressiveOptimizeTemplate, userPrompt);

		if (!response || response.length < 50) {
			logger.debug("Aggressive optimization skipped: empty or too-short LLM response");
			return skill;
		}

		try {
			const parsed = this.#parseJson(response);
			if (!parsed) {
				logger.warn("Aggressive optimization failed: could not parse JSON", { skill: skill.name });
				return skill;
			}

			const updated: EvolvedSkill = {
				...skill,
				taskPattern: parsed.taskPattern ?? skill.taskPattern,
				approach: parsed.approach ?? skill.approach,
				tools: Array.isArray(parsed.tools) ? parsed.tools : skill.tools,
				pitfalls: Array.isArray(parsed.pitfalls) ? parsed.pitfalls : skill.pitfalls,
				autonomyNotes: parsed.autonomyNotes ?? skill.autonomyNotes,
				lastOptimizedAt: Date.now(),
				optimizationCount: (skill.optimizationCount ?? 0) + 1,
				version: skill.version + 1,
			};

			const changedFields = this.#getChangedFields(skill, updated);
			logger.debug("Skill aggressively optimized", {
				skill: skill.name,
				changedFields,
				previousVersion: skill.version,
				newVersion: updated.version,
				failureCasesAnalyzed: failureHistory?.length ?? 0,
			});

			return updated;
		} catch (err) {
			logger.warn("Aggressive optimization failed", {
				skill: skill.name,
				error: err instanceof Error ? err.message : String(err),
			});
			return skill;
		}
	}

	#buildPrompt(skill: EvolvedSkill, failureHistory?: FailureCase[]): string {
		let prompt = `Skill Name: ${skill.name}
Description: ${skill.description}
Task Pattern: ${skill.taskPattern}
Current Approach:
${skill.approach}

Tools: ${skill.tools.join(", ")}
Pitfalls: ${skill.pitfalls.join("; ")}

Usage Count: ${skill.usageCount}
Success Count: ${skill.successCount}
Failure Count: ${skill.failureCount}
Version: ${skill.version}`;

		if (failureHistory && failureHistory.length > 0) {
			prompt += `\n\n## Failure History (${failureHistory.length} cases)\n`;
			for (const f of failureHistory) {
				prompt += `\n- Episode ${f.episodeId}:\n  Summary: ${f.summary}\n  Error Pattern: ${f.errorPattern}\n`;
			}
		}

		return prompt;
	}

	#parseJson(
		response: string,
	):
		| { taskPattern?: string; approach?: string; tools?: string[]; pitfalls?: string[]; autonomyNotes?: string }
		| undefined {
		// Try to extract JSON from the response, handling potential markdown fences
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		const jsonStr = jsonMatch ? jsonMatch[0] : response;

		try {
			const parsed = JSON.parse(jsonStr) as {
				taskPattern?: string;
				approach?: string;
				tools?: string[];
				pitfalls?: string[];
				autonomyNotes?: string;
			};
			return parsed;
		} catch {
			return undefined;
		}
	}

	#getChangedFields(before: EvolvedSkill, after: EvolvedSkill): string[] {
		const changed: string[] = [];
		if (before.taskPattern !== after.taskPattern) changed.push("taskPattern");
		if (before.approach !== after.approach) changed.push("approach");
		if (JSON.stringify(before.tools) !== JSON.stringify(after.tools)) changed.push("tools");
		if (JSON.stringify(before.pitfalls) !== JSON.stringify(after.pitfalls)) changed.push("pitfalls");
		if (before.autonomyNotes !== after.autonomyNotes) changed.push("autonomyNotes");
		return changed;
	}
}
