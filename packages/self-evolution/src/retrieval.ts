/**
 * Episodic memory retrieval: FTS5 BM25 recall + scoring + optional LLM reranking.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import rerankEpisodesTemplate from "./prompts/rerank-episodes.md" with { type: "text" };
import type { EpisodeStore } from "./storage/types";
import type { Episode, RerankedEpisode } from "./types";
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
		// Stage 1: FTS5 BM25 recall for semantic relevance
		const ftsCandidates = await this.#episodeStore.searchByKeyword(query, options.maxEpisodes);
		if (ftsCandidates.length === 0) return [];

		// Stage 2: Heuristic scoring on FTS5 results
		const scored = this.#scoreByKeyword(ftsCandidates, query);
		scored.sort((a, b) => b.score - a.score);

		const topCandidates = scored.slice(0, 10);

		if (!options.llmRerank || !options.model || topCandidates.length <= 3) {
			return topCandidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: Math.min(100, Math.round(c.score)),
				reason: c.reason,
			}));
		}

		// Stage 3: LLM rerank
		const reranked = await this.#llmRerank(topCandidates, query, options.model);
		reranked.sort((a, b) => b.relevanceScore - a.relevanceScore);
		return reranked.slice(0, 3);
	}

	#scoreByKeyword(episodes: Episode[], query: string): Array<{ episode: Episode; score: number; reason: string }> {
		const queryWords = query
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 2);

		return episodes.map(episode => {
			const text = `${episode.userPrompt} ${episode.summary} ${episode.toolsUsed.join(" ")}`.toLowerCase();
			let keywordMatches = 0;
			for (const word of queryWords) {
				if (text.includes(word)) keywordMatches++;
			}

			let score = 50; // Base score from FTS5 retrieval
			if (queryWords.length > 0) {
				score += (keywordMatches / queryWords.length) * 30;
			}

			const reasons: string[] = ["FTS5 match"];
			if (episode.completedSuccessfully) {
				score += 10;
				reasons.push("successful");
			}
			if (episode.hadRecovery) {
				score += 5;
				reasons.push("recovery");
			}
			const daysAgo = Math.floor((Date.now() - episode.timestamp) / 86400000);
			score += Math.max(0, 5 - daysAgo);

			return {
				episode,
				score: Math.min(100, score),
				reason: reasons.join(", "),
			};
		});
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
				relevanceScore: Math.min(100, Math.round(c.score)),
				reason: "LLM rerank failed, using FTS5 score",
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
						relevanceScore: Math.min(100, Math.round(c.score)),
						reason: "LLM returned no valid matches",
					}));
		} catch (err) {
			logger.warn("LLM episode rerank parse failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: Math.min(100, Math.round(c.score)),
				reason: "LLM rerank parse failed",
			}));
		}
	}
}
