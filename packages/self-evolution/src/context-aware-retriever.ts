/**
 * ContextAwareRetriever: intent-filtered + profile-ranked episode retrieval.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import rerankEpisodesTemplate from "./prompts/rerank-episodes.md" with { type: "text" };
import type { EffectivenessStore, EpisodeStore, IntentStore } from "./storage/types";
import type { Episode, UserProfile } from "./types";
import { callBackgroundLlm } from "./utils/llm";

export interface ContextRetrievalOptions {
	maxEpisodes: number;
	llmRerank: boolean;
	model?: Model;
	currentIntent?: string;
	profile?: UserProfile;
}
export interface RetrievedEpisode {
	episode: Episode;
	relevanceScore: number;
	reason: string;
	timesInjected: number;
	helpRate: number;
}

function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
	if (!ext) return undefined;
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		rs: "rust",
		py: "python",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		h: "cpp",
		hpp: "cpp",
		c: "c",
		cs: "csharp",
		rb: "ruby",
		php: "php",
		scala: "scala",
		r: "r",
		sh: "shell",
		bash: "shell",
		zsh: "shell",
		md: "markdown",
		yml: "yaml",
		yaml: "yaml",
		json: "json",
		toml: "toml",
	};
	return map[ext];
}

export class ContextAwareRetriever {
	#episodeStore: EpisodeStore;
	#intentStore: IntentStore;
	#effectivenessStore: EffectivenessStore;

	constructor(episodeStore: EpisodeStore, intentStore: IntentStore, effectivenessStore: EffectivenessStore) {
		this.#episodeStore = episodeStore;
		this.#intentStore = intentStore;
		this.#effectivenessStore = effectivenessStore;
	}

	async retrieve(query: string, options: ContextRetrievalOptions): Promise<RetrievedEpisode[]> {
		// Load recent episodes
		const recent = await this.#episodeStore.listRecent(options.maxEpisodes * 2);
		if (recent.length === 0) return [];

		// Score all candidates
		const candidates = await this.#scoreCandidates(recent, query, options);
		candidates.sort((a, b) => b.score - a.score);

		// Filter by relevance threshold
		const relevant = candidates.filter(c => c.score >= 30);
		if (relevant.length === 0) {
			// Fallback: return top keyword matches regardless of intent
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: "fallback keyword match",
				timesInjected: c.timesInjected,
				helpRate: c.helpRate,
			}));
		}

		// Take top for potential LLM reranking
		const topCandidates = relevant.slice(0, 10);

		if (!options.llmRerank || !options.model || topCandidates.length <= 3) {
			return topCandidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: c.reason,
				timesInjected: c.timesInjected,
				helpRate: c.helpRate,
			}));
		}

		return this.#llmRerank(topCandidates, query, options.model);
	}

	async #scoreCandidates(
		episodes: Episode[],
		query: string,
		options: ContextRetrievalOptions,
	): Promise<Array<{ episode: Episode; score: number; reason: string; timesInjected: number; helpRate: number }>> {
		const queryWords = query
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 2);

		return Promise.all(
			episodes.map(async episode => {
				let score = 0;
				const reasons: string[] = [];

				// 1. Intent match (0-40 points)
				const intents = await this.#intentStore.getByEpisode(episode.id);
				if (options.currentIntent) {
					const match = intents.find(i => i.intent === options.currentIntent);
					if (match) {
						score += Math.min(40, match.confidence * 0.4);
						reasons.push("intent match");
					}
				}

				// 2. Keyword match (0-30 points)
				const text = `${episode.userPrompt} ${episode.summary} ${episode.toolsUsed.join(" ")}`.toLowerCase();
				let keywordMatches = 0;
				for (const word of queryWords) {
					if (text.includes(word)) keywordMatches++;
				}
				if (queryWords.length > 0) {
					score += (keywordMatches / queryWords.length) * 30;
					if (keywordMatches > 0) reasons.push("keyword match");
				}

				// 3. Success boost (0-15 points)
				if (episode.completedSuccessfully) {
					score += 15;
					reasons.push("successful");
				}

				// 4. Recovery experience (0-5 points)
				if (episode.hadRecovery) {
					score += 5;
					reasons.push("recovery experience");
				}

				// 5. Recency boost (0-10 points)
				const daysAgo = Math.floor((Date.now() - episode.timestamp) / 86400000);
				score += Math.max(0, 10 - daysAgo);

				// 6. Profile affinity boost (0-15 points)
				if (options.profile) {
					const p = options.profile;

					// 6a. Language match (0-5)
					const epLangs = new Set<string>();
					for (const file of episode.filesModified) {
						const lang = getLanguageFromPath(file);
						if (lang) epLangs.add(lang);
					}
					const langMatch = [...epLangs].some(l => p.preferredLanguages.includes(l));
					if (langMatch) {
						score += 5;
						reasons.push("language match");
					}

					// 6b. Tool affinity (0-5)
					const topTools = Object.entries(p.toolFrequency)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 3)
						.map(([t]) => t);
					const hasTopTool = episode.toolsUsed.some(t => topTools.includes(t));
					if (hasTopTool) {
						score += 5;
						reasons.push("tool affinity");
					}

					// 6c. Intent affinity (0-5) — reuse intents queried above
					const topIntents = Object.entries(p.intentDistribution)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 3)
						.map(([i]) => i);
					const hasTopIntent = intents.some(i => topIntents.includes(i.intent));
					if (hasTopIntent && !reasons.includes("intent match")) {
						score += 5;
						reasons.push("intent affinity");
					}
				}

				// 7. Effectiveness feedback boost (0-20 points)
				const eff = await this.#effectivenessStore.get(episode.id);
				let timesInjected = 0;
				let helpRate = 0;
				if (eff && eff.timesInjected > 0) {
					timesInjected = eff.timesInjected;
					helpRate = eff.timesHelped / eff.timesInjected;
					if (helpRate >= 0.5) {
						score += Math.min(20, Math.round(helpRate * 20));
						reasons.push("proven helpful");
					} else if (helpRate < 0.2 && timesInjected >= 3) {
						score -= 15;
						reasons.push("proven unhelpful");
					} else if (eff.timesFailed > 0) {
						score -= Math.min(10, Math.round((eff.timesFailed / eff.timesInjected) * 10));
						reasons.push("previously unhelpful");
					}
				}

				return {
					episode,
					score: Math.min(100, Math.round(score)),
					reason: reasons.join(", ") || "recent episode",
					timesInjected,
					helpRate,
				};
			}),
		);
	}

	async #llmRerank(
		candidates: Array<{ episode: Episode; score: number; reason: string; timesInjected: number; helpRate: number }>,
		query: string,
		model: Model,
	): Promise<RetrievedEpisode[]> {
		const episodesBlock = candidates
			.map(
				(c, i) =>
					`[${i + 1}] ID: ${c.episode.id}\nSummary: ${c.episode.summary}\nTools: ${c.episode.toolsUsed.join(", ")}\nSuccess: ${c.episode.completedSuccessfully}\n`,
			)
			.join("\n");

		const userPrompt = `Current task: "${query}"\n\nCandidate episodes:\n${episodesBlock}\n\nSelect the most relevant episodes. Return a JSON array: [{"episodeId": "...", "relevanceScore": 0-100, "reason": "..."}]`;

		const response = await callBackgroundLlm(model, rerankEpisodesTemplate, userPrompt);
		if (!response) {
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: "LLM rerank failed, using scored ranking",
				timesInjected: c.timesInjected,
				helpRate: c.helpRate,
			}));
		}

		try {
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			const json = jsonMatch ? jsonMatch[0] : response;
			const parsed = JSON.parse(json) as Array<{
				episodeId?: string;
				relevanceScore?: number;
				reason?: string;
			}>;

			const result: RetrievedEpisode[] = [];
			for (const item of parsed) {
				if (!item.episodeId) continue;
				const candidate = candidates.find(c => c.episode.id === item.episodeId);
				if (candidate) {
					result.push({
						episode: candidate.episode,
						relevanceScore: Math.min(100, Math.max(0, item.relevanceScore ?? 50)),
						reason: item.reason || "LLM selected",
						timesInjected: candidate.timesInjected,
						helpRate: candidate.helpRate,
					});
				}
			}
			return result.length > 0
				? result
				: candidates.slice(0, 3).map(c => ({
						episode: c.episode,
						relevanceScore: c.score,
						reason: "LLM returned no valid matches",
						timesInjected: c.timesInjected,
						helpRate: c.helpRate,
					}));
		} catch (err) {
			logger.warn("LLM context-aware rerank parse failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: "LLM rerank parse failed",
				timesInjected: c.timesInjected,
				helpRate: c.helpRate,
			}));
		}
	}
}
