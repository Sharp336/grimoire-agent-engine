/**
 * HeuristicSkillEvaluator: multi-dimensional quality scoring (0-100).
 */
import type { EvolvedSkill, ExtractedSkill } from "./types";

export interface ScoreBreakdown {
	successRate: number;
	toolDiversity: number;
	pitfallCoverage: number;
	taskPatternSubstance: number;
	approachSubstance: number;
	descriptionQuality: number;
	reusesHistory: number;
	recoveryExperience: number;
	total: number;
}

export class HeuristicSkillEvaluator {
	/**
	 * Score an extracted skill. Returns 0-100 total.
	 */
	evaluate(skill: ExtractedSkill): ScoreBreakdown {
		const successRate = Math.min(35, 35); // New skill, assume full success weight
		const toolDiversity = Math.min(15, skill.tools.length * 5);
		const pitfallCoverage = Math.min(12, skill.pitfalls.length * 4);
		const taskPatternSubstance = skill.taskPattern.length > 20 ? 8 : 0;
		const approachSubstance = skill.approach.length > 50 ? 10 : 0;
		const descriptionQuality = skill.description.length > 30 ? 10 : 0;
		const reusesHistory = skill.llmRefined ? 5 : 0;
		const recoveryExperience = skill.pitfalls.some(
			p => p.toLowerCase().includes("recover") || p.toLowerCase().includes("error"),
		)
			? 3
			: 0;

		const total =
			successRate +
			toolDiversity +
			pitfallCoverage +
			taskPatternSubstance +
			approachSubstance +
			descriptionQuality +
			reusesHistory +
			recoveryExperience;

		return {
			successRate,
			toolDiversity,
			pitfallCoverage,
			taskPatternSubstance,
			approachSubstance,
			descriptionQuality,
			reusesHistory,
			recoveryExperience,
			total,
		};
	}

	/**
	 * Re-evaluate an existing skill using its persisted stats.
	 */
	reevaluate(skill: EvolvedSkill): ScoreBreakdown {
		const totalUses = skill.successCount + skill.failureCount;
		const successRate = totalUses > 0 ? Math.min(35, Math.round((skill.successCount / totalUses) * 35)) : 20;
		const toolDiversity = Math.min(15, skill.tools.length * 5);
		const pitfallCoverage = Math.min(12, skill.pitfalls.length * 4);
		const taskPatternSubstance = skill.taskPattern.length > 20 ? 8 : 0;
		const approachSubstance = skill.approach.length > 50 ? 10 : 0;
		const descriptionQuality = skill.description.length > 30 ? 10 : 0;
		const reusesHistory = skill.usageCount > 1 ? 5 : 0;
		const recoveryExperience = skill.pitfalls.some(
			p => p.toLowerCase().includes("recover") || p.toLowerCase().includes("error"),
		)
			? 3
			: 0;

		const total =
			successRate +
			toolDiversity +
			pitfallCoverage +
			taskPatternSubstance +
			approachSubstance +
			descriptionQuality +
			reusesHistory +
			recoveryExperience;

		return {
			successRate,
			toolDiversity,
			pitfallCoverage,
			taskPatternSubstance,
			approachSubstance,
			descriptionQuality,
			reusesHistory,
			recoveryExperience,
			total,
		};
	}
}
