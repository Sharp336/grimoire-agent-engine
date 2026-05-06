/**
 * ContextAwareRetriever: intent-filtered + profile-ranked episode retrieval.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import rerankEpisodesTemplate from "./prompts/rerank-episodes.md" with { type: "text" };
import type { EpisodeStore, IntentStore } from "./storage/types";
import type { Episode, RerankedEpisode, UserProfile } from "./types";
import { callBackgroundLlm } from "./utils/llm";

export interface ContextRetrievalOptions {
	maxEpisodes: number;
	llmRerank: boolean;
	model?: Model;
	currentIntent?: string;
	profile?: UserProfile;
}

export class ContextAwareRetriever {
	#episodeStore: EpisodeStore;
	#intentStore: IntentStore;

	constructor(episodeStore: EpisodeStore, intentStore: IntentStore) {
		this.#episodeStore = episodeStore;
		this.#intentStore = intentStore;
	}

	async retrieve(query: string, options: ContextRetrievalOptions): Promise<RerankedEpisode[]> {
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
			}));
		}

		// Take top for potential LLM reranking
		const topCandidates = relevant.slice(0, 10);

		if (!options.llmRerank || !options.model || topCandidates.length <= 3) {
			return topCandidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: c.reason,
			}));
		}

		return this.#llmRerank(topCandidates, query, options.model);
	}

	async #scoreCandidates(
		episodes: Episode[],
		query: string,
		options: ContextRetrievalOptions,
	): Promise<Array<{ episode: Episode; score: number; reason: string }>> {
		const queryWords = query
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 2);

		return Promise.all(
			episodes.map(async episode => {
				let score = 0;
				const reasons: string[] = [];

				// 1. Intent match (0-40 points)
				if (options.currentIntent) {
					const intents = await this.#intentStore.getByEpisode(episode.id);
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

				return {
					episode,
					score: Math.min(100, Math.round(score)),
					reason: reasons.join(", ") || "recent episode",
				};
			}),
		);
	}

	async #llmRerank(
		candidates: Array<{ episode: Episode; score: number; reason: string }>,
		query: string,
		model: Model,
	): Promise<RerankedEpisode[]> {
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

			const result: RerankedEpisode[] = [];
			for (const item of parsed) {
				if (!item.episodeId) continue;
				const candidate = candidates.find(c => c.episode.id === item.episodeId);
				if (candidate) {
					result.push({
						episode: candidate.episode,
						relevanceScore: Math.min(100, Math.max(0, item.relevanceScore ?? 50)),
						reason: item.reason || "LLM selected",
					});
				}
			}
			return result.length > 0
				? result
				: candidates.slice(0, 3).map(c => ({
						episode: c.episode,
						relevanceScore: c.score,
						reason: "LLM returned no valid matches",
					}));
		} catch (err) {
			logger.warn("LLM context-aware rerank parse failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: "LLM rerank parse failed",
			}));
		}
	}
}
