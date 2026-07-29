import type { SearchCitation, SearchSource } from "../types";

export interface GeminiGroundingChunk {
	web?: {
		uri?: string;
		title?: string;
	};
}

export interface GeminiGroundingSupport {
	segment?: {
		startIndex?: number;
		endIndex?: number;
		text?: string;
	};
	groundingChunkIndices?: number[];
	confidenceScores?: number[];
}

export interface GeminiGroundingMetadata {
	groundingChunks?: GeminiGroundingChunk[];
	groundingSupports?: GeminiGroundingSupport[];
	webSearchQueries?: string[];
}

export interface GeminiGroundedResponse {
	candidates?: Array<{
		content?: {
			role?: string;
			parts?: Array<{ text?: string; thought?: boolean }>;
		};
		finishReason?: string;
		groundingMetadata?: GeminiGroundingMetadata;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
	modelVersion?: string;
}

export interface GroundedSearchResult {
	answer: string;
	sources: SearchSource[];
	citations: SearchCitation[];
	searchQueries: string[];
	model: string;
	finishReason?: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Converts a Gemini grounding response into the provider-neutral search result.
 * Thought parts are model reasoning, not search-answer text; grounding supports
 * retain their source chunk attribution rather than inferring citations.
 */
export function parseGeminiGroundedResponse(
	response: GeminiGroundedResponse,
	fallbackModel: string,
): GroundedSearchResult {
	const candidate = response.candidates?.[0];
	const grounding = candidate?.groundingMetadata;
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const searchQueries: string[] = [];
	const seenUrls = new Set<string>();

	for (const chunk of grounding?.groundingChunks ?? []) {
		const url = chunk.web?.uri;
		if (!url || seenUrls.has(url)) continue;
		seenUrls.add(url);
		sources.push({ title: chunk.web?.title ?? url, url });
	}

	for (const support of grounding?.groundingSupports ?? []) {
		for (const index of support.groundingChunkIndices ?? []) {
			const web = grounding?.groundingChunks?.[index]?.web;
			if (!web?.uri) continue;
			citations.push({
				url: web.uri,
				title: web.title ?? web.uri,
				citedText: support.segment?.text,
			});
		}
	}

	for (const query of grounding?.webSearchQueries ?? []) {
		if (query && !searchQueries.includes(query)) searchQueries.push(query);
	}

	return {
		answer: (candidate?.content?.parts ?? [])
			.filter(part => !part.thought)
			.map(part => part.text ?? "")
			.join(""),
		sources,
		citations,
		searchQueries,
		model: response.modelVersion ?? fallbackModel,
		finishReason: candidate?.finishReason,
		usage: response.usageMetadata
			? {
					inputTokens: response.usageMetadata.promptTokenCount ?? 0,
					outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
					totalTokens: response.usageMetadata.totalTokenCount ?? 0,
				}
			: undefined,
	};
}
