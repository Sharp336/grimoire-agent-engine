/**
 * SkillManager: lifecycle management for evolved skills (merge, evaluate, archive, versioning).
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { AggressiveSkillOptimizer } from "./aggressive-optimizer";
import { HeuristicSkillEvaluator } from "./evaluator";
import type { ActivityLogger } from "./logging/activity-logger";
import type { EpisodeStore, SkillEffectivenessStore, SkillStore, SkillVersionStore } from "./storage/types";
import type { EvolvedSkill, ExtractedSkill, SkillVersion } from "./types";

export interface SkillManagerOptions {
	enableVersioning: boolean;
	maxVersions: number;
}

export class SkillManager {
	#skillStore: SkillStore;
	#versionStore: SkillVersionStore;
	#activityLogger: ActivityLogger;
	#evaluator = new HeuristicSkillEvaluator();
	#optimizer = new AggressiveSkillOptimizer();
	#options: SkillManagerOptions;
	#skillEffectivenessStore: SkillEffectivenessStore;
	#episodeStore: EpisodeStore;

	constructor(
		skillStore: SkillStore,
		versionStore: SkillVersionStore,
		activityLogger: ActivityLogger,
		skillEffectivenessStore: SkillEffectivenessStore,
		episodeStore: EpisodeStore,
		options: SkillManagerOptions,
	) {
		this.#skillStore = skillStore;
		this.#versionStore = versionStore;
		this.#activityLogger = activityLogger;
		this.#skillEffectivenessStore = skillEffectivenessStore;
		this.#episodeStore = episodeStore;
		this.#options = options;
	}

	/**
	 * Integrate a newly extracted skill into the skill library.
	 */
	async integrate(extracted: ExtractedSkill, model?: Model): Promise<EvolvedSkill> {
		const existing = await this.#skillStore.get(extracted.name);

		if (existing) {
			const merged = this.#merge(existing, extracted);
			merged.qualityScore = this.#evaluator.reevaluate(merged).total;

			// Auto-optimize if quality is low but there is success history
			if (merged.qualityScore < 40 && merged.successCount > 0 && model) {
				try {
					const failureHistory = await this.#loadFailureHistory(merged);
					const optimized = await this.#optimizer.optimize(merged, model, failureHistory);
					if (optimized !== merged) {
						Object.assign(merged, optimized);
					}
					merged.qualityScore = this.#evaluator.reevaluate(merged).total;
				} catch (err) {
					logger.warn("Skill auto-optimization failed", {
						skill: merged.name,
						error: String(err),
					});
				}
			}

			// Also run aggressive optimization on merge if quality is very low or approach too short
			if ((merged.qualityScore < 50 || merged.approach.length < 200) && model) {
				try {
					const failureHistory = await this.#loadFailureHistory(merged);
					const optimized = await this.#optimizer.optimize(merged, model, failureHistory);
					if (optimized !== merged) {
						Object.assign(merged, optimized);
						merged.qualityScore = this.#evaluator.reevaluate(merged).total;
					}
				} catch (err) {
					logger.warn("Skill aggressive optimization on merge failed", {
						skill: merged.name,
						error: String(err),
					});
				}
			}

			await this.autoOptimizeIfNeeded(merged.name, model);

			await this.#skillStore.upsert(merged);
			if (this.#options.enableVersioning) {
				await this.#snapshot(existing, "merged", `merged with better approach`);
				await this.#snapshot(merged, "merged", `merged with extracted skill v${extracted.qualityScore}`);
			}
			await this.#activityLogger.log("skill_merged", {
				skillName: merged.name,
				oldVersion: existing.version,
				newVersion: merged.version,
				approachChanged: existing.approach !== merged.approach,
			});
			return merged;
		}

		const skill: EvolvedSkill = {
			...extracted,
			createdAt: Date.now(),
			usageCount: 1,
			lastUsedAt: Date.now(),
			successCount: 1,
			failureCount: 0,
			version: 1,
			qualityScore: extracted.qualityScore,
		};

		await this.#skillStore.upsert(skill);
		if (this.#options.enableVersioning) {
			await this.#snapshot(skill, "extracted", "initial extraction");
		}
		await this.#activityLogger.log("skill_extracted", {
			skillName: skill.name,
			version: skill.version,
			qualityScore: skill.qualityScore,
			llmRefined: extracted.llmRefined,
		});
		return skill;
	}

	/**
	 * Mark a skill as deprecated.
	 */
	async deprecate(name: string, reason: string): Promise<void> {
		const skill = await this.#skillStore.get(name);
		if (!skill) return;
		skill.deprecated = true;
		skill.deprecationReason = reason;
		await this.#skillStore.upsert(skill);
		if (this.#options.enableVersioning) {
			await this.#snapshot(skill, "deprecated", reason);
		}
		await this.#activityLogger.log("skill_deprecated", {
			skillName: name,
			reason,
			qualityScore: skill.qualityScore,
		});
	}

	/**
	 * Roll back a skill to a specific historical version.
	 */
	async rollback(name: string, targetVersion: number): Promise<EvolvedSkill | undefined> {
		const historical = await this.#versionStore.getSpecific(name, targetVersion);
		if (!historical) return undefined;

		const current = await this.#skillStore.get(name);
		if (current && this.#options.enableVersioning) {
			await this.#snapshot(current, "rolled_back", `rolled back to v${targetVersion}`);
		}

		const restored: EvolvedSkill = {
			...historical.skill,
			version: (current?.version ?? historical.skill.version) + 1,
			deprecated: false,
			deprecationReason: undefined,
		};
		await this.#skillStore.upsert(restored);
		if (this.#options.enableVersioning) {
			await this.#snapshot(restored, "rolled_back", `restored from v${targetVersion}`);
		}
		await this.#activityLogger.log("skill_rolled_back", {
			skillName: name,
			fromVersion: current?.version,
			toVersion: targetVersion,
			newVersion: restored.version,
		});
		return restored;
	}

	/**
	 * Archive low-quality skills (quality < 30 and usage < 1).
	 */
	async archiveLowQuality(): Promise<number> {
		const skills = await this.#skillStore.list();
		let archived = 0;
		for (const skill of skills) {
			if (skill.deprecated) continue;
			if ((skill.qualityScore ?? 0) < 30 && skill.usageCount < 1) {
				await this.deprecate(skill.name, "Low quality and unused");
				archived++;
			}
		}
		return archived;
	}
	async recordSkillUsage(name: string, succeeded: boolean): Promise<void> {
		await this.#skillEffectivenessStore.recordOutcome(name, succeeded);
	}

	async autoOptimizeIfNeeded(name: string, model?: Model): Promise<void> {
		const effectiveness = await this.#skillEffectivenessStore.get(name);
		if (!effectiveness) return;

		const skill = await this.#skillStore.get(name);
		if (!skill || skill.deprecated) return;

		// Auto-deprecate if too many failures
		if (effectiveness.timesFailed >= 3) {
			await this.deprecate(name, `Auto-deprecated: ${effectiveness.timesFailed} failures after injection`);
			return;
		}

		let shouldOptimize = false;
		let reason = "";

		// Condition a: injected enough but help rate is low (lowered threshold)
		if (effectiveness.timesInjected >= 2 && effectiveness.timesHelped / effectiveness.timesInjected < 0.6) {
			shouldOptimize = true;
			reason = "low effectiveness after injection";
		}
		// Condition b: low quality score
		else if (skill.qualityScore !== undefined && skill.qualityScore < 50) {
			shouldOptimize = true;
			reason = "low quality score";
		}
		// Condition c: approach too brief to be autonomous
		else if (skill.approach.length < 200) {
			shouldOptimize = true;
			reason = "approach too brief for autonomy";
		}

		if (shouldOptimize && model) {
			try {
				const failureHistory = await this.#loadFailureHistory(skill);
				const optimized = await this.#optimizer.optimize(skill, model, failureHistory);
				if (optimized !== skill) {
					skill.taskPattern = optimized.taskPattern;
					skill.approach = optimized.approach;
					skill.tools = optimized.tools;
					skill.pitfalls = optimized.pitfalls;
					skill.autonomyNotes = optimized.autonomyNotes;
					skill.lastOptimizedAt = optimized.lastOptimizedAt;
					skill.optimizationCount = optimized.optimizationCount;
					skill.version = optimized.version;
				}
				skill.qualityScore = this.#evaluator.reevaluate(skill).total;
				await this.#skillStore.upsert(skill);
				if (this.#options.enableVersioning) {
					await this.#snapshot(skill, "optimized", `auto-optimized: ${reason}`);
				}
				await this.#activityLogger.log("skill_auto_optimized", {
					skillName: name,
					qualityScore: skill.qualityScore,
					reason,
				});
			} catch (err) {
				logger.warn("Skill auto-optimization failed", {
					skill: name,
					error: String(err),
				});
			}
		}
	}

	async getHistory(name: string): Promise<SkillVersion[]> {
		return this.#versionStore.getHistory(name);
	}

	async #loadFailureHistory(
		skill: EvolvedSkill,
	): Promise<Array<{ episodeId: string; summary: string; errorPattern: string }>> {
		try {
			// Use skill name and task pattern as keywords to find matching failed episodes
			const keywords = `${skill.name} ${skill.taskPattern}`.slice(0, 120);
			const failedEpisodes = await this.#episodeStore.searchFailedByKeyword(keywords, 5);
			return failedEpisodes.map(ep => ({
				episodeId: ep.id,
				summary: ep.summary,
				errorPattern:
					ep.errorCount > 0
						? `${ep.errorCount} error(s), recovery: ${ep.hadRecovery ? "yes" : "no"}`
						: `no completion, recovery: ${ep.hadRecovery ? "yes" : "no"}`,
			}));
		} catch {
			return [];
		}
	}

	#merge(existing: EvolvedSkill, extracted: ExtractedSkill): EvolvedSkill {
		// Deduplicate tools and pitfalls
		const tools = [...new Set([...existing.tools, ...extracted.tools])];
		const pitfalls = [...new Set([...existing.pitfalls, ...extracted.pitfalls])];

		// Prefer the longer/more specific approach
		const approach = extracted.approach.length > existing.approach.length ? extracted.approach : existing.approach;

		return {
			...existing,
			description: extracted.description || existing.description,
			taskPattern: extracted.taskPattern || existing.taskPattern,
			approach,
			tools,
			pitfalls,
			usageCount: existing.usageCount + 1,
			lastUsedAt: Date.now(),
			version: existing.version + 1,
		};
	}

	async #snapshot(skill: EvolvedSkill, changeType: SkillVersion["changeType"], reason?: string): Promise<void> {
		const version: SkillVersion = {
			name: skill.name,
			version: skill.version,
			skill: { ...skill },
			changedAt: Date.now(),
			changeType,
			changeReason: reason,
		};
		await this.#versionStore.record(version);
		await this.#versionStore.prune(skill.name, this.#options.maxVersions);
	}
}
