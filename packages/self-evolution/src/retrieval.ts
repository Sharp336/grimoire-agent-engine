/**
 * Episodic memory retrieval: keyword recall + optional LLM reranking.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import rerankEpisodesTemplate from "./prompts/rerank-episodes.md" with { type: "text" };
import type { EpisodeStore } from "./storage/types";
import type { Episode, EpisodeCandidate, RerankedEpisode } from "./types";
import { callBackgroundLlm } from "./utils/llm";

export interface RetrievalOptions {
	maxEpisodes: number;
	llmRerank: boolean;
	model?: Model;
}

export class EpisodeRetriever {
	#episodeStore: EpisodeStore;

	constructor(episodeStore: EpisodeStore) {
		this.#episodeStore = episodeStore;
	}

	async retrieve(query: string, options: RetrievalOptions): Promise<RerankedEpisode[]> {
		// Load recent episodes as candidate pool
		const recent = await this.#episodeStore.listRecent(options.maxEpisodes);
		if (recent.length === 0) return [];

		// Keyword scoring
		const candidates = this.#scoreByKeyword(recent, query);
		candidates.sort((a, b) => b.keywordScore - a.keywordScore);

		// Take top 10 for reranking
		const topCandidates = candidates.slice(0, 10);

		if (!options.llmRerank || !options.model || topCandidates.length <= 3) {
			// No LLM reranking: return top 3 by keyword score
			return topCandidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.keywordScore,
				reason: "keyword match",
			}));
		}

		// LLM rerank
		const reranked = await this.#llmRerank(topCandidates, query, options.model);
		reranked.sort((a, b) => b.relevanceScore - a.relevanceScore);
		return reranked.slice(0, 3);
	}

	#scoreByKeyword(episodes: Episode[], query: string): EpisodeCandidate[] {
		const queryWords = query
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 2);
		if (queryWords.length === 0) {
			return episodes.map(e => ({ episode: e, keywordScore: 50 }));
		}

		return episodes.map(episode => {
			const text = `${episode.userPrompt} ${episode.summary} ${episode.toolsUsed.join(" ")}`.toLowerCase();
			let matches = 0;
			for (const word of queryWords) {
				if (text.includes(word)) matches++;
			}
			const baseScore = (matches / queryWords.length) * 60;
			// Boost successful and recovery episodes
			const successBoost = episode.completedSuccessfully ? 20 : 0;
			const recoveryBoost = episode.hadRecovery ? 10 : 0;
			const recencyBoost = Math.max(0, 10 - Math.floor((Date.now() - episode.timestamp) / 86400000));
			return {
				episode,
				keywordScore: Math.min(100, baseScore + successBoost + recoveryBoost + recencyBoost),
			};
		});
	}

	async #llmRerank(candidates: EpisodeCandidate[], query: string, model: Model): Promise<RerankedEpisode[]> {
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
				relevanceScore: c.keywordScore,
				reason: "LLM rerank failed, using keyword score",
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
						relevanceScore: c.keywordScore,
						reason: "LLM returned no valid matches",
					}));
		} catch (err) {
			logger.warn("LLM episode rerank parse failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.keywordScore,
				reason: "LLM rerank parse failed",
			}));
		}
	}
}
