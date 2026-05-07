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
	autonomy: number;
	userRating: number;
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
		const autonomy = this.#scoreAutonomy(skill);
		const userRating = 0; // New skill, no user rating yet

		const total =
			successRate +
			toolDiversity +
			pitfallCoverage +
			taskPatternSubstance +
			approachSubstance +
			descriptionQuality +
			reusesHistory +
			recoveryExperience +
			autonomy +
			userRating;

		return {
			successRate,
			toolDiversity,
			pitfallCoverage,
			taskPatternSubstance,
			approachSubstance,
			descriptionQuality,
			reusesHistory,
			recoveryExperience,
			autonomy,
			userRating,
			total: Math.min(100, total),
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
		const autonomy = this.#scoreAutonomy(skill);
		const userRating = this.#scoreUserRating(skill);

		const total =
			successRate +
			toolDiversity +
			pitfallCoverage +
			taskPatternSubstance +
			approachSubstance +
			descriptionQuality +
			reusesHistory +
			recoveryExperience +
			autonomy +
			userRating;

		return {
			successRate,
			toolDiversity,
			pitfallCoverage,
			taskPatternSubstance,
			approachSubstance,
			descriptionQuality,
			reusesHistory,
			recoveryExperience,
			autonomy,
			userRating,
			total: Math.min(100, total),
		};
	}

	#scoreAutonomy(skill: EvolvedSkill | ExtractedSkill): number {
		let score = 0;
		// +10 if approach includes explicit conditionals
		const approachLower = skill.approach.toLowerCase();
		if (/\b(if|else|when|unless)\b/.test(approachLower)) {
			score += 10;
		}
		// +10 if approach length > 300
		if (skill.approach.length > 300) {
			score += 10;
		}
		// +5 if pitfalls include recovery steps
		const hasRecoverySteps = skill.pitfalls.some(p =>
			/\b(then|use|fall back|try|retry|recover|fix|resolve)\b/i.test(p),
		);
		if (hasRecoverySteps) {
			score += 5;
		}
		return score;
	}

	#scoreUserRating(skill: EvolvedSkill): number {
		if (!skill.userRating) return 0;
		// Map 1-5 stars to -10 to +10 adjustment
		const map = { 1: -10, 2: -5, 3: 0, 4: 5, 5: 10 };
		return map[skill.userRating as keyof typeof map] ?? 0;
	}
}
