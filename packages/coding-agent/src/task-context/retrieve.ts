import * as path from "node:path";
import type { Client } from "@libsql/client";
import type { CodemapConfig } from "./config";
import { checkStaleness } from "./staleness";
import type { RankedSummary } from "./store";
import { searchFts, searchVector } from "./store";

export interface TaskContextResult {
	task: string;
	files: Array<{
		path: string;
		score: number;
		summary: string;
		stale: boolean;
		missing: boolean;
		updatedAt: string;
	}>;
	meta: {
		fileCount: number;
		estimatedTokens: number;
		truncated: boolean;
	};
}

// --- Lexical extraction ---

const STOPWORDS: Record<string, true> = {
	the: true,
	and: true,
	for: true,
	with: true,
	this: true,
	that: true,
	from: true,
	into: true,
	but: true,
	not: true,
	are: true,
	was: true,
	were: true,
	have: true,
	has: true,
	will: true,
	would: true,
	could: true,
	should: true,
	how: true,
	does: true,
	what: true,
	when: true,
	where: true,
	why: true,
	who: true,
	can: true,
	use: true,
	using: true,
	work: true,
	works: true,
};

export function extractKeywords(task: string): string[] {
	// Tokenize on non-alphanumeric, lowercase, keep >= 3 chars, drop stopwords
	const tokens = task.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return tokens.filter(t => t.length >= 3 && !STOPWORDS[t]);
}

// Split camelCase and snake_case for richer FTS queries
export function splitTokens(tokens: string[]): string[] {
	const result: string[] = [];
	for (const token of tokens) {
		result.push(token);
		// Split camelCase: buildSystemPrompt → build, system, prompt
		const camelParts = token.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
		if (camelParts.length > 1) result.push(...camelParts.filter(p => p.length >= 3));
		// Split snake_case: get_task_context → get, task, context
		if (token.includes("_")) {
			const snakeParts = token.split("_").filter(p => p.length >= 3);
			result.push(...snakeParts);
		}
	}
	return [...new Set(result)];
}

// --- Reciprocal Rank Fusion ---

export function reciprocalRankFusion(
	ftsResults: RankedSummary[],
	vectorResults: RankedSummary[],
	ftsWeight: number,
	vectorWeight: number,
): RankedSummary[] {
	const k = 60; // Standard RRF constant
	const scores = new Map<number, { summary: RankedSummary; score: number }>();

	for (let i = 0; i < ftsResults.length; i++) {
		const s = ftsResults[i];
		const rrfScore = ftsWeight / (k + i + 1);
		const existing = scores.get(s.id);
		if (existing) existing.score += rrfScore;
		else scores.set(s.id, { summary: s, score: rrfScore });
	}

	for (let i = 0; i < vectorResults.length; i++) {
		const s = vectorResults[i];
		const rrfScore = vectorWeight / (k + i + 1);
		const existing = scores.get(s.id);
		if (existing) existing.score += rrfScore;
		else scores.set(s.id, { summary: s, score: rrfScore });
	}

	return [...scores.values()].sort((a, b) => b.score - a.score).map(({ summary, score }) => ({ ...summary, score }));
}

// --- Budget packer ---

// Codemap's exact documented token formula: ceil(summary_text.length / 4) + 20
export function tokenCost(summaryText: string): number {
	return Math.ceil(summaryText.length / 4) + 20;
}

export function packBudget(
	ranked: RankedSummary[],
	tokenBudget: number,
	maxFiles: number,
	_cwd: string,
): { files: TaskContextResult["files"]; estimatedTokens: number; truncated: boolean } {
	let totalTokens = 0;
	const files: TaskContextResult["files"] = [];

	for (const summary of ranked) {
		if (files.length >= maxFiles) break;
		const cost = tokenCost(summary.summaryText);
		if (totalTokens + cost > tokenBudget && files.length > 0) {
			// Would exceed budget and we have at least one file
			break;
		}
		totalTokens += cost;
		files.push({
			path: summary.filePath,
			score: Number(summary.score.toFixed(4)),
			summary: summary.summaryText,
			stale: false, // Will be set by staleness check
			missing: false,
			updatedAt: summary.updatedAt,
		});
	}

	return {
		files,
		estimatedTokens: totalTokens,
		truncated: ranked.length > files.length,
	};
}

// --- Main retrieval pipeline ---

export interface GetTaskContextOptions {
	maxFiles?: number;
	tokenBudget?: number;
	/** Optional query embedding vector. When provided, enables vector seed retrieval;
	 * when omitted, vector search is skipped (no embedding client available). */
	queryEmbedding?: number[];
}

export async function getTaskContext(
	client: Client,
	config: CodemapConfig,
	task: string,
	projectLabel: string,
	cwd: string,
	opts: GetTaskContextOptions = {},
): Promise<TaskContextResult> {
	const maxFiles = opts.maxFiles ?? 12;
	const tokenBudget = opts.tokenBudget ?? config.tokenBudget;
	const seedLimit = config.maxResults;
	const queryEmbedding = opts.queryEmbedding;

	// Step 1: Lexical extraction
	const keywords = splitTokens(extractKeywords(task));
	const queryStr = keywords.join(" ");

	// Step 2: Parallel seed retrieval
	// Vector search is skipped when no queryEmbedding is provided (no embedding client).
	const vectorPromise =
		queryEmbedding && queryEmbedding.length > 0
			? searchVector(client, projectLabel, queryEmbedding, seedLimit).catch(() => [] as RankedSummary[])
			: Promise.resolve([] as RankedSummary[]);

	const [ftsResults, vectorResults] = await Promise.all([
		queryStr ? searchFts(client, projectLabel, queryStr, seedLimit) : Promise.resolve([] as RankedSummary[]),
		vectorPromise,
	]);

	// Step 3: RRF fusion (FTS weighted higher since it's lexical task matching)
	const fused = reciprocalRankFusion(ftsResults, vectorResults, 0.7, 0.3);

	// If FTS returned nothing and vector returned nothing, return empty
	if (fused.length === 0) {
		return { task, files: [], meta: { fileCount: 0, estimatedTokens: 0, truncated: false } };
	}

	// Step 4: Budget packer
	const packed = packBudget(fused, tokenBudget, maxFiles, cwd);

	// Step 5: Staleness check for each included file
	const filesWithStaleness = await Promise.all(
		packed.files.map(async f => {
			const fullPath = path.resolve(cwd, f.path);
			const storedHash = fused.find(s => s.filePath === f.path)?.contentHash ?? "";
			const staleness = await checkStaleness(fullPath, storedHash);
			return { ...f, stale: staleness.stale, missing: staleness.missing };
		}),
	);

	return {
		task,
		files: filesWithStaleness,
		meta: {
			fileCount: filesWithStaleness.length,
			estimatedTokens: packed.estimatedTokens,
			truncated: packed.truncated,
		},
	};
}
