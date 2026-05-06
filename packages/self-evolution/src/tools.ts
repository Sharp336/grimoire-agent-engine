/**
 * Agent-callable tools for the self-evolution plugin.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ActivityLogger } from "./logging/activity-logger";
import type { SkillManager } from "./manager";
import type { EpisodeRetriever } from "./retrieval";
import type { SkillStore } from "./storage/types";

export interface ToolStores {
	ensureInit(cwd: string): void;
	episodeRetriever(): EpisodeRetriever;
	skillStore(): SkillStore;
	skillManager(): SkillManager;
	activityLogger(): ActivityLogger;
}

export function registerSelfEvolutionTools(api: ExtensionAPI, stores: ToolStores): void {
	api.registerTool({
		name: "query_episodic_memory",
		label: "Query Episodic Memory",
		description:
			"Search past agent sessions for relevant experiences. Returns summaries of the most relevant past episodes.",
		parameters: api.typebox.Object({
			query: api.typebox.String({ description: "The search query describing what you're looking for" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			stores.ensureInit(ctx.cwd);
			const episodes = await stores.episodeRetriever().retrieve(params.query, {
				maxEpisodes: 100,
				llmRerank: false, // tools use fast keyword search
				model: ctx.model,
			});
			await stores.activityLogger().log("experience_queried", {
				query: params.query,
				resultCount: episodes.length,
				episodeIds: episodes.map(e => e.episode.id),
			});
			const lines = episodes.map(
				e => `- ${e.episode.summary} (relevance: ${e.relevanceScore}, reason: ${e.reason})`,
			);
			return {
				content: [{ type: "text", text: lines.join("\n") || "No relevant episodes found." }],
				details: { count: episodes.length },
			};
		},
	});

	api.registerTool({
		name: "list_evolved_skills",
		label: "List Evolved Skills",
		description: "List all evolved skills from the self-evolution system, optionally filtering by quality.",
		parameters: api.typebox.Object({
			minQuality: api.typebox.Optional(api.typebox.Number({ description: "Minimum quality score (0-100)" })),
			includeDeprecated: api.typebox.Optional(api.typebox.Boolean({ description: "Include deprecated skills" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const skills = await stores.skillStore().list({
				deprecated: params.includeDeprecated ? undefined : false,
			});
			const filtered = params.minQuality ? skills.filter(s => (s.qualityScore ?? 0) >= params.minQuality!) : skills;
			const lines = filtered.map(s => {
				const total = s.successCount + s.failureCount;
				const rate = total > 0 ? `${Math.round((s.successCount / total) * 100)}%` : "n/a";
				return `- ${s.name} (v${s.version}, quality: ${s.qualityScore ?? "?"}, success: ${rate}, used: ${s.usageCount})`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") || "No skills found." }],
				details: { count: filtered.length },
			};
		},
	});

	api.registerTool({
		name: "optimize_skill_prompt",
		label: "Optimize Skill Prompt",
		description: "Run GEPA-style optimization on a skill's approach text.",
		parameters: api.typebox.Object({
			skillName: api.typebox.String({ description: "Name of the skill to optimize" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			stores.ensureInit(ctx.cwd);
			const skill = await stores.skillStore().get(params.skillName);
			if (!skill) {
				return {
					content: [{ type: "text", text: `Skill "${params.skillName}" not found.` }],
					details: {},
				};
			}
			const { RuleBasedPromptOptimizer } = await import("./optimizer");
			const optimizer = new RuleBasedPromptOptimizer();
			const oldApproach = skill.approach;
			const newApproach = await optimizer.optimize(skill, ctx.model);
			skill.approach = newApproach;
			skill.version += 1;
			await stores.skillStore().upsert(skill);
			await stores.activityLogger().log("skill_optimized", {
				skillName: skill.name,
				confidence: skill.qualityScore,
				oldScore: skill.qualityScore,
				newScore: skill.qualityScore,
			});
			return {
				content: [
					{
						type: "text",
						text: `Optimized "${skill.name}". Approach changed from:\n${oldApproach.slice(0, 200)}...\n\nTo:\n${newApproach.slice(0, 200)}...`,
					},
				],
				details: { skillName: skill.name, version: skill.version },
			};
		},
	});
}
