import type { ConventionStore, EffectivenessStore, EpisodeStore } from "./storage/types";
import type { DailyReport, Episode, ErrorPattern } from "./types";

const CORRECTION_KEYWORDS = [
	"fix",
	"correct",
	"wrong",
	"not working",
	"error",
	"bug",
	"issue",
	"broken",
	"repair",
	"resolve",
	"debug",
	"fail",
	"failed",
];

export class DailyReportGenerator {
	#episodeStore: EpisodeStore;
	#conventionStore: ConventionStore;
	#effectivenessStore: EffectivenessStore;

	constructor(episodeStore: EpisodeStore, conventionStore: ConventionStore, effectivenessStore: EffectivenessStore) {
		this.#episodeStore = episodeStore;
		this.#conventionStore = conventionStore;
		this.#effectivenessStore = effectivenessStore;
	}

	async generate(date?: Date): Promise<DailyReport> {
		const targetDate = date ?? new Date();
		const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).getTime();
		const endOfDay = startOfDay + 86_400_000;

		const episodes = await this.#episodeStore.listRecent(1000);
		const dayEpisodes = episodes.filter(e => e.timestamp >= startOfDay && e.timestamp < endOfDay);

		// Fetch effectiveness data for episodes
		const effectivenessResults = await Promise.all(dayEpisodes.map(e => this.#effectivenessStore.get(e.id)));

		const sessions = dayEpisodes.map((e, i) => ({
			sessionId: e.sessionId,
			userPrompt: e.userPrompt,
			toolCallCount: e.toolCallCount,
			errorCount: e.errorCount,
			completedSuccessfully: e.completedSuccessfully,
			errors: this.#extractErrors(e),
			highlights: this.#extractHighlights(e, effectivenessResults[i]),
		}));

		const topErrorPatterns = this.#buildErrorPatterns(dayEpisodes);
		const topTools = this.#buildTopTools(dayEpisodes);
		const keyMoments = this.#buildKeyMoments(dayEpisodes);

		const allConventions = await this.#conventionStore.listAll();
		const newConventions = allConventions.filter(c => c.createdAt >= startOfDay && c.createdAt < endOfDay);

		const totalSessions = dayEpisodes.length;
		const successfulSessions = dayEpisodes.filter(e => e.completedSuccessfully).length;
		const failedSessions = dayEpisodes.filter(e => !e.completedSuccessfully && e.errorCount > 0).length;
		const emptySessions = dayEpisodes.filter(
			e => !e.completedSuccessfully && e.errorCount === 0 && e.toolCallCount === 0,
		).length;
		const partialSessions = dayEpisodes.filter(
			e => !e.completedSuccessfully && e.errorCount === 0 && e.toolCallCount > 0,
		).length;

		return {
			date: this.#formatDate(targetDate),
			totalSessions,
			successfulSessions,
			failedSessions,
			emptySessions,
			partialSessions,
			sessions,
			topErrorPatterns,
			newConventions,
			topTools,
			keyMoments,
		};
	}

	formatReport(report: DailyReport): string {
		const lines: string[] = [];
		lines.push(`# Daily Report: ${report.date}`);
		lines.push("");
		lines.push(
			`## Summary: ${report.totalSessions} total = ${report.successfulSessions} success + ${report.failedSessions} failed + ${report.emptySessions} empty + ${report.partialSessions} partial`,
		);
		lines.push("");

		lines.push("## Key Moments");
		const moments = report.keyMoments.slice(0, 10);
		if (moments.length === 0) {
			lines.push("_No key moments recorded._");
		} else {
			for (const m of moments) {
				const time = new Date(m.timestamp).toISOString();
				lines.push(`- **${m.type.toUpperCase()}** (${time}): ${m.description}`);
			}
		}
		lines.push("");

		lines.push("## Top Error Patterns");
		if (report.topErrorPatterns.length === 0) {
			lines.push("_No errors recorded._");
		} else {
			for (const p of report.topErrorPatterns) {
				lines.push(
					`- **${p.name}**: ${p.description} (${p.count} occurrences, ${p.affectedSessions.length} sessions)`,
				);
			}
		}
		lines.push("");

		lines.push("## New Conventions");
		if (report.newConventions.length === 0) {
			lines.push("_No new conventions extracted._");
		} else {
			for (const c of report.newConventions) {
				lines.push(`- **${c.type}**: ${c.content} (confidence: ${c.confidence}%)`);
			}
		}
		lines.push("");

		lines.push("## Top Tools");
		if (report.topTools.length === 0) {
			lines.push("_No tool usage recorded._");
		} else {
			for (const t of report.topTools) {
				lines.push(`- ${t.tool}: ${t.count}`);
			}
		}
		lines.push("");

		lines.push("## Session Details");
		for (const s of report.sessions) {
			const status = s.completedSuccessfully ? "✅" : s.errorCount > 0 ? "❌" : "⚪";
			lines.push(`### ${status} ${s.sessionId}`);
			lines.push(`- **Prompt**: ${s.userPrompt.slice(0, 200)}${s.userPrompt.length > 200 ? "..." : ""}`);
			lines.push(`- **Tools**: ${s.toolCallCount} calls`);
			if (s.errorCount > 0) {
				lines.push(`- **Errors**: ${s.errorCount}`);
			}
			if (s.highlights.length > 0) {
				lines.push(`- **Highlights**: ${s.highlights.join(", ")}`);
			}
			if (s.errors.length > 0) {
				lines.push(`- **Error details**: ${s.errors.join("; ")}`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	#extractErrors(episode: Episode): string[] {
		if (episode.errorCount === 0) {
			return [];
		}
		// Parse the outcome portion of the summary for error details
		const outcomeMatch = episode.summary.match(/Outcome: (.+)$/);
		if (outcomeMatch) {
			const outcome = outcomeMatch[1];
			if (outcome?.includes("error")) {
				return [outcome];
			}
		}
		return [`${episode.errorCount} error(s) occurred`];
	}

	#extractHighlights(episode: Episode, effectiveness?: import("./types").EpisodeEffectiveness): string[] {
		const highlights: string[] = [];
		if (episode.completedSuccessfully) {
			highlights.push("Completed successfully");
		}
		if (episode.hadRecovery) {
			highlights.push("Recovered from errors");
		}
		if (episode.errorCount > 0) {
			highlights.push(`${episode.errorCount} error(s)`);
		}
		if (episode.toolCallCount === 0) {
			highlights.push("No tool calls");
		}
		if (episode.toolsUsed.length > 5) {
			highlights.push("High tool variety");
		}
		if (effectiveness && effectiveness.timesHelped > 0) {
			highlights.push("Previously helped similar sessions");
		}
		return highlights;
	}

	#buildErrorPatterns(episodes: Episode[]): ErrorPattern[] {
		const errorEpisodes = episodes.filter(e => e.errorCount > 0);
		if (errorEpisodes.length === 0) {
			return [];
		}

		// Group by simple heuristic: look for tool names in user prompt that often relate to errors
		const patterns: ErrorPattern[] = [];
		const grouped = new Map<string, Episode[]>();

		for (const e of errorEpisodes) {
			const category = this.#categorizeError(e);
			const list = grouped.get(category) ?? [];
			list.push(e);
			grouped.set(category, list);
		}

		for (const [category, eps] of grouped) {
			const count = eps.reduce((sum, e) => sum + e.errorCount, 0);
			const timestamps = eps.map(e => e.timestamp);
			patterns.push({
				id: `daily-${category}-${Math.min(...timestamps)}`,
				name: `${this.#capitalize(category)} Error`,
				description: `Errors detected in ${eps.length} session(s) categorized as ${category}`,
				regex: `failed with \\d+ error\\(s\\)`,
				category: this.#mapCategory(category),
				affectedSessions: eps.map(e => e.sessionId),
				count,
				firstSeenAt: Math.min(...timestamps),
				lastSeenAt: Math.max(...timestamps),
				extractedConventions: [],
			});
		}

		return patterns.sort((a, b) => b.count - a.count);
	}

	#categorizeError(episode: Episode): string {
		const prompt = episode.userPrompt.toLowerCase();
		if (prompt.includes("type") || prompt.includes("typescript") || prompt.includes("typecheck")) {
			return "type";
		}
		if (prompt.includes("syntax") || prompt.includes("parse")) {
			return "syntax";
		}
		if (prompt.includes("not found") || prompt.includes("missing") || prompt.includes("cannot find")) {
			return "not_found";
		}
		if (prompt.includes("permission") || prompt.includes("access denied")) {
			return "permission";
		}
		if (prompt.includes("format") || prompt.includes("lint")) {
			return "format";
		}
		return "other";
	}

	#mapCategory(category: string): ErrorPattern["category"] {
		switch (category) {
			case "type":
				return "type";
			case "syntax":
				return "syntax";
			case "not_found":
				return "not_found";
			case "permission":
				return "permission";
			case "format":
				return "format";
			default:
				return "other";
		}
	}

	#capitalize(s: string): string {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}

	#buildTopTools(episodes: Episode[]): Array<{ tool: string; count: number }> {
		const counts = new Map<string, number>();
		for (const e of episodes) {
			for (const tool of e.toolsUsed) {
				counts.set(tool, (counts.get(tool) ?? 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.map(([tool, count]) => ({ tool, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);
	}

	#buildKeyMoments(episodes: Episode[]): Array<{
		type: "error" | "recovery" | "success" | "correction";
		sessionId: string;
		description: string;
		timestamp: number;
	}> {
		const moments: Array<{
			type: "error" | "recovery" | "success" | "correction";
			sessionId: string;
			description: string;
			timestamp: number;
		}> = [];

		for (const e of episodes) {
			if (e.errorCount > 0) {
				moments.push({
					type: "error",
					sessionId: e.sessionId,
					description: `Session failed with ${e.errorCount} error(s): ${e.userPrompt.slice(0, 100)}${e.userPrompt.length > 100 ? "..." : ""}`,
					timestamp: e.timestamp,
				});
			}
			if (e.hadRecovery) {
				moments.push({
					type: "recovery",
					sessionId: e.sessionId,
					description: `Session recovered from errors: ${e.userPrompt.slice(0, 100)}${e.userPrompt.length > 100 ? "..." : ""}`,
					timestamp: e.timestamp,
				});
			}
			if (e.completedSuccessfully) {
				moments.push({
					type: "success",
					sessionId: e.sessionId,
					description: `Session completed successfully: ${e.userPrompt.slice(0, 100)}${e.userPrompt.length > 100 ? "..." : ""}`,
					timestamp: e.timestamp,
				});
			}
			if (this.#isCorrectionPrompt(e.userPrompt)) {
				moments.push({
					type: "correction",
					sessionId: e.sessionId,
					description: `User requested correction: ${e.userPrompt.slice(0, 100)}${e.userPrompt.length > 100 ? "..." : ""}`,
					timestamp: e.timestamp,
				});
			}
		}

		return moments.sort((a, b) => a.timestamp - b.timestamp).slice(0, 10);
	}

	#isCorrectionPrompt(prompt: string): boolean {
		const lower = prompt.toLowerCase();
		return CORRECTION_KEYWORDS.some(kw => lower.includes(kw));
	}

	#formatDate(date: Date): string {
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
}
