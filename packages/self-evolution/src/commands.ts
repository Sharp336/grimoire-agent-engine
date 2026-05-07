/**
 * Slash commands for the self-evolution plugin.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { logger } from "@oh-my-pi/pi-utils";
import { HeuristicSkillEvaluator } from "./evaluator";
import type { ActivityLogger } from "./logging/activity-logger";
import type { SkillManager } from "./manager";
import type { SqliteStatsStore } from "./storage/skills";
import type { EpisodeStore, SkillStore, SkillVersionStore } from "./storage/types";

export interface CommandStores {
	ensureInit(cwd: string): void;
	episodeStore(): EpisodeStore;
	skillStore(): SkillStore;
	versionStore(): SkillVersionStore;
	statsStore(): SqliteStatsStore;
	skillManager(): SkillManager;
	activityLogger(): ActivityLogger;
}

export function registerSelfEvolutionCommands(api: ExtensionAPI, stores: CommandStores): void {
	api.registerCommand("evolution-status", {
		description: "Show self-evolution statistics (episodes, skills, versions).",
		async handler(_args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			try {
				const [episodeCount, skillCount, versionCount, archivedSessions] = await Promise.all([
					stores.episodeStore().count(),
					stores.skillStore().count(),
					stores.versionStore().count(),
					stores.statsStore().get("sessions_archived"),
				]);
				ctx.ui.notify(
					`Episodes: ${episodeCount} | Skills: ${skillCount} | Versions: ${versionCount} | Sessions archived: ${archivedSessions}`,
					"info",
				);
			} catch (err) {
				logger.error("evolution-status failed", { error: String(err) });
				ctx.ui.notify("Failed to load evolution status", "error");
			}
		},
	});

	api.registerCommand("evolution-skills", {
		description: "List evolved skills with detailed score breakdown.",
		async handler(args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			try {
				const skills = await stores.skillStore().list();
				if (skills.length === 0) {
					ctx.ui.notify("No evolved skills yet", "info");
					return;
				}

				// Check if user wants detailed view
				const showDetail = args.trim() === "--detail";
				const evaluator = new HeuristicSkillEvaluator();

				const lines: string[] = [];
				for (const s of skills) {
					const total = s.successCount + s.failureCount;
					const rate = total > 0 ? `${Math.round((s.successCount / total) * 100)}%` : "n/a";
					const userStars = s.userRating ? "★".repeat(s.userRating) + "☆".repeat(5 - s.userRating) : "unrated";

					lines.push(
						`${s.name} (v${s.version}) | quality: ${s.qualityScore ?? "?"} | success: ${rate} | used: ${s.usageCount} | your rating: ${userStars}${s.deprecated ? " [DEPRECATED]" : ""}`,
					);

					if (showDetail) {
						const breakdown = evaluator.reevaluate(s);
						lines.push(
							`  └─ successRate=${breakdown.successRate} diversity=${breakdown.toolDiversity} pitfalls=${breakdown.pitfallCoverage} ` +
								`pattern=${breakdown.taskPatternSubstance} approach=${breakdown.approachSubstance} desc=${breakdown.descriptionQuality} ` +
								`history=${breakdown.reusesHistory} recovery=${breakdown.recoveryExperience} autonomy=${breakdown.autonomy} user=${breakdown.userRating} ` +
								`- TOTAL=${breakdown.total}`,
						);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				logger.error("evolution-skills failed", { error: String(err) });
				ctx.ui.notify("Failed to list skills", "error");
			}
		},
	});

	api.registerCommand("evolution-rate", {
		description: "Rate a skill 1-5 stars. Usage: /evolution-rate <name> <1-5>",
		async handler(args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /evolution-rate <skill-name> <1-5>", "warning");
				return;
			}

			const ratingStr = parts.pop()!;
			const name = parts.join(" ");
			const rating = Number.parseInt(ratingStr, 10);

			if (Number.isNaN(rating) || rating < 1 || rating > 5) {
				ctx.ui.notify("Rating must be a number between 1 and 5", "error");
				return;
			}

			try {
				const skill = await stores.skillStore().get(name);
				if (!skill) {
					ctx.ui.notify(`Skill "${name}" not found. Use /evolution-skills to list.`, "error");
					return;
				}

				skill.userRating = rating;
				// Re-evaluate to update quality score with user rating
				const evaluator = new HeuristicSkillEvaluator();
				const breakdown = evaluator.reevaluate(skill);
				skill.qualityScore = breakdown.total;

				await stores.skillStore().upsert(skill);
				await stores.activityLogger().log("skill_user_rated", {
					skillName: name,
					rating,
					newQualityScore: skill.qualityScore,
				});

				const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
				ctx.ui.notify(`Rated "${name}" ${stars} (quality updated to ${skill.qualityScore})`, "info");
			} catch (err) {
				logger.error("evolution-rate failed", { error: String(err) });
				ctx.ui.notify("Failed to rate skill", "error");
			}
		},
	});

	api.registerCommand("evolution-clear", {
		description: "Clear all self-evolution data for this project.",
		async handler(_args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			try {
				const confirmed = await ctx.ui.confirm(
					"Clear self-evolution data",
					"This will delete all episodes, skills, and version history for this project. Continue?",
				);
				if (!confirmed) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
				ctx.ui.notify("Please delete the ~/.omp/self-evolution/ directory manually to clear all data.", "warning");
			} catch (err) {
				logger.error("evolution-clear failed", { error: String(err) });
			}
		},
	});

	api.registerCommand("evolution-archive", {
		description: "Archive low-quality skills (quality < 30 and unused).",
		async handler(_args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			try {
				const count = await stores.skillManager().archiveLowQuality();
				ctx.ui.notify(`Archived ${count} low-quality skill(s)`, "info");
			} catch (err) {
				logger.error("evolution-archive failed", { error: String(err) });
				ctx.ui.notify("Failed to archive skills", "error");
			}
		},
	});

	api.registerCommand("evolution-skill-history", {
		description: "View version history for a skill. Usage: /evolution-skill-history <name>",
		async handler(args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /evolution-skill-history <name>", "warning");
				return;
			}
			try {
				const history = await stores.skillManager().getHistory(name);
				if (history.length === 0) {
					ctx.ui.notify(`No history found for skill "${name}"`, "info");
					return;
				}
				const lines = history.map(
					h =>
						`v${h.version} | ${h.changeType} | ${new Date(h.changedAt).toISOString()}${h.changeReason ? ` | ${h.changeReason}` : ""}`,
				);
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				logger.error("evolution-skill-history failed", { error: String(err) });
				ctx.ui.notify("Failed to load skill history", "error");
			}
		},
	});

	api.registerCommand("evolution-rollback", {
		description: "Rollback a skill to a specific version. Usage: /evolution-rollback <name> <version>",
		async handler(args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			const parts = args.trim().split(/\s+/);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /evolution-rollback <name> <version>", "warning");
				return;
			}
			const version = Number.parseInt(parts[parts.length - 1]!, 10);
			const name = parts.slice(0, -1).join(" ");
			if (Number.isNaN(version)) {
				ctx.ui.notify("Invalid version number", "error");
				return;
			}
			try {
				const restored = await stores.skillManager().rollback(name, version);
				if (restored) {
					ctx.ui.notify(`Rolled back "${name}" to v${version} (new version: v${restored.version})`, "info");
				} else {
					ctx.ui.notify(`Version ${version} of "${name}" not found`, "error");
				}
			} catch (err) {
				logger.error("evolution-rollback failed", { error: String(err) });
				ctx.ui.notify("Rollback failed", "error");
			}
		},
	});
}
