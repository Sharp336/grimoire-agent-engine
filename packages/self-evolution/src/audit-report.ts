/**
 * Self-evolution audit report generator.
 *
 * Produces a structured health check of the self-evolution system,
 * highlighting data quality issues and actionable fixes.
 */
import type { Database } from "bun:sqlite";
import type { ActivityLogger } from "./logging/activity-logger";
import type { EpisodeStore, SkillStore } from "./storage/types";

export interface AuditReport {
	generatedAt: number;
	episodes: {
		total: number;
		maxAllowed: number;
		atCapacity: boolean;
		successRate: number;
		avgToolCalls: number;
		avgErrors: number;
	};
	skills: {
		total: number;
		deprecated: number;
		names: string[];
		qualityScores: number[];
	};
	effectiveness: {
		episodesTracked: number;
		totalInjections: number;
		totalHelped: number;
		helpRate: number;
		skillsTracked: number;
	};
	intents: Array<{ intent: string; count: number; avgConfidence: number }>;
	workflows: {
		totalPatterns: number;
		meaningfulPatterns: number;
	};
	conventions: {
		total: number;
		byType: Record<string, number>;
	};
	profile: {
		sessionCount: number;
		errorRate: number;
		topIntent: string;
	};
	issues: string[];
	recommendations: string[];
}

export async function generateAuditReport(
	db: Database,
	episodeStore: EpisodeStore,
	skillStore: SkillStore,
	maxEpisodes: number,
	activityLogger?: ActivityLogger,
): Promise<AuditReport> {
	const issues: string[] = [];
	const recommendations: string[] = [];

	// Episodes
	const episodeCount = await episodeStore.count();
	const recentEpisodes = await episodeStore.listRecent(Math.min(episodeCount, 100));
	const successful = recentEpisodes.filter(e => e.completedSuccessfully).length;
	const totalToolCalls = recentEpisodes.reduce((sum, e) => sum + e.toolCallCount, 0);
	const totalErrors = recentEpisodes.reduce((sum, e) => sum + e.errorCount, 0);
	const successRate = recentEpisodes.length > 0 ? successful / recentEpisodes.length : 0;
	const avgToolCalls = recentEpisodes.length > 0 ? totalToolCalls / recentEpisodes.length : 0;
	const avgErrors = recentEpisodes.length > 0 ? totalErrors / recentEpisodes.length : 0;

	if (episodeCount >= maxEpisodes * 0.9) {
		issues.push(`Episode pool at ${episodeCount}/${maxEpisodes} capacity — old episodes are being rotated out.`);
		recommendations.push("Increase --self-evolution-max-episodes to retain more history.");
	}
	if (successRate < 0.7) {
		issues.push(`Low session success rate: ${(successRate * 100).toFixed(0)}%.`);
		recommendations.push("Review error patterns and consider extracting recovery skills.");
	}

	// Skills
	const skills = await skillStore.list();
	const deprecatedSkills = skills.filter(s => s.deprecated);
	const skillNames = skills.map(s => s.name);
	const qualityScores = skills.map(s => s.qualityScore ?? 0);

	if (skills.length === 0) {
		issues.push("No skills extracted yet.");
		recommendations.push("Lower --self-evolution-skill-threshold to capture more sessions as skills.");
	} else if (skills.length < 5) {
		issues.push(`Only ${skills.length} skill(s) extracted from ${episodeCount} episodes.`);
		recommendations.push("Review skillThreshold — many sessions may be below the tool-call minimum.");
	}

	const badNames = skillNames.filter(n => /^(untitled|task-\d+|yes|no|ok)$/i.test(n));
	if (badNames.length > 0) {
		issues.push(`${badNames.length} skill(s) have meaningless names: ${badNames.join(", ")}.`);
		recommendations.push("Use /evolution-archive to clean up low-quality skills.");
	}

	// Effectiveness
	const effRow = db
		.prepare(
			"SELECT COUNT(*) as c, SUM(times_injected) as injected, SUM(times_helped) as helped FROM episode_effectiveness",
		)
		.get() as { c: number; injected: number; helped: number } | undefined;
	const skillEffRow = db.prepare("SELECT COUNT(*) as c FROM skill_effectiveness").get() as { c: number } | undefined;
	const episodesTracked = effRow?.c ?? 0;
	const totalInjections = effRow?.injected ?? 0;
	const totalHelped = effRow?.helped ?? 0;
	const helpRate = totalInjections > 0 ? totalHelped / totalInjections : 0;

	if (helpRate < 0.5 && totalInjections > 10) {
		issues.push(
			`Episode injection help rate is ${(helpRate * 100).toFixed(0)}% — more than half of injections are not helping.`,
		);
		recommendations.push(
			"Consider disabling prompt injection (--no-self-evolution-enable-prompt-injection) or tuning retrieval.",
		);
	}

	// Intents
	const intentRows = db
		.prepare(
			"SELECT intent, COUNT(*) as count, AVG(confidence) as avg_conf FROM episode_intents GROUP BY intent ORDER BY count DESC",
		)
		.all() as Array<{ intent: string; count: number; avg_conf: number }>;

	// Workflows
	const wfRow = db.prepare("SELECT COUNT(*) as c FROM workflow_patterns").get() as { c: number } | undefined;
	const meaningfulWf = db.prepare("SELECT COUNT(*) as c FROM workflow_patterns WHERE occurrence_count >= 2").get() as
		| { c: number }
		| undefined;

	// Conventions
	const convRows = db.prepare("SELECT type, COUNT(*) as count FROM conventions GROUP BY type").all() as Array<{
		type: string;
		count: number;
	}>;
	const conventionByType: Record<string, number> = {};
	for (const row of convRows) {
		conventionByType[row.type] = row.count;
	}
	const totalConventions = convRows.reduce((sum, r) => sum + r.count, 0);
	if (totalConventions === 0) {
		issues.push("No project conventions extracted from dialogue.");
		recommendations.push(
			"Conventions are extracted from user_input and assistant_message entries — they require explicit rule-like language.",
		);
	}

	// Profile
	const profileRow = db.prepare("SELECT profile_json FROM user_profiles WHERE id = 'default'").get() as
		| { profile_json: string }
		| undefined;
	let sessionCount = 0;
	let errorRate = 0;
	let topIntent = "unknown";
	if (profileRow) {
		try {
			const profile = JSON.parse(profileRow.profile_json) as {
				sessionCount?: number;
				errorRate?: number;
				intentDistribution?: Record<string, number>;
			};
			sessionCount = profile.sessionCount ?? 0;
			errorRate = profile.errorRate ?? 0;
			const intents = Object.entries(profile.intentDistribution ?? {});
			intents.sort((a, b) => b[1] - a[1]);
			topIntent = intents[0]?.[0] ?? "unknown";
		} catch {
			// ignore parse error
		}
	}

	const report: AuditReport = {
		generatedAt: Date.now(),
		episodes: {
			total: episodeCount,
			maxAllowed: maxEpisodes,
			atCapacity: episodeCount >= maxEpisodes,
			successRate,
			avgToolCalls,
			avgErrors,
		},
		skills: {
			total: skills.length,
			deprecated: deprecatedSkills.length,
			names: skillNames,
			qualityScores,
		},
		effectiveness: {
			episodesTracked,
			totalInjections,
			totalHelped,
			helpRate,
			skillsTracked: skillEffRow?.c ?? 0,
		},
		intents: intentRows.map(r => ({
			intent: r.intent,
			count: r.count,
			avgConfidence: r.avg_conf,
		})),
		workflows: {
			totalPatterns: wfRow?.c ?? 0,
			meaningfulPatterns: meaningfulWf?.c ?? 0,
		},
		conventions: {
			total: totalConventions,
			byType: conventionByType,
		},
		profile: {
			sessionCount,
			errorRate,
			topIntent,
		},
		issues,
		recommendations,
	};

	await activityLogger?.log("audit_report_generated", {
		episodeCount,
		skillCount: skills.length,
		issueCount: issues.length,
	});

	return report;
}

export function formatAuditReport(report: AuditReport): string {
	const lines: string[] = [];
	lines.push(`# Self-Evolution Audit Report`);
	lines.push(`Generated: ${new Date(report.generatedAt).toISOString()}`);
	lines.push("");

	lines.push("## Episodes");
	lines.push(`- Total: ${report.episodes.total} / ${report.episodes.maxAllowed} max`);
	lines.push(`- Success rate: ${(report.episodes.successRate * 100).toFixed(0)}%`);
	lines.push(`- Avg tool calls: ${report.episodes.avgToolCalls.toFixed(1)}`);
	lines.push(`- Avg errors: ${report.episodes.avgErrors.toFixed(1)}`);
	lines.push("");

	lines.push("## Skills");
	lines.push(`- Total: ${report.skills.total} (${report.skills.deprecated} deprecated)`);
	if (report.skills.names.length > 0) {
		lines.push(`- Names: ${report.skills.names.join(", ")}`);
		lines.push(`- Quality scores: ${report.skills.qualityScores.join(", ")}`);
	}
	lines.push("");

	lines.push("## Effectiveness");
	lines.push(`- Episodes tracked: ${report.effectiveness.episodesTracked}`);
	lines.push(`- Injections: ${report.effectiveness.totalInjections}`);
	lines.push(`- Helped: ${report.effectiveness.totalHelped}`);
	lines.push(`- Help rate: ${(report.effectiveness.helpRate * 100).toFixed(0)}%`);
	lines.push(`- Skills tracked: ${report.effectiveness.skillsTracked}`);
	lines.push("");

	lines.push("## Intents");
	for (const i of report.intents) {
		lines.push(`- ${i.intent}: ${i.count} (avg confidence: ${i.avgConfidence.toFixed(1)})`);
	}
	lines.push("");

	lines.push("## Workflow Patterns");
	lines.push(`- Total: ${report.workflows.totalPatterns}`);
	lines.push(`- Meaningful (≥2 occurrences): ${report.workflows.meaningfulPatterns}`);
	lines.push("");

	lines.push("## Conventions");
	lines.push(`- Total: ${report.conventions.total}`);
	for (const [type, count] of Object.entries(report.conventions.byType)) {
		lines.push(`  - ${type}: ${count}`);
	}
	lines.push("");

	lines.push("## Profile");
	lines.push(`- Sessions: ${report.profile.sessionCount}`);
	lines.push(`- Error rate: ${(report.profile.errorRate * 100).toFixed(0)}%`);
	lines.push(`- Top intent: ${report.profile.topIntent}`);
	lines.push("");

	if (report.issues.length > 0) {
		lines.push("## Issues Found");
		for (const issue of report.issues) {
			lines.push(`- ${issue}`);
		}
		lines.push("");
	}

	if (report.recommendations.length > 0) {
		lines.push("## Recommendations");
		for (const rec of report.recommendations) {
			lines.push(`- ${rec}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
