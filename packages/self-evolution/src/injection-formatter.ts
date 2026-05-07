/**
 * InjectionFormatter: formats conventions, episodes, and skills into
 * structured injection text for the LLM context.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { RetrievedEpisode } from "./context-aware-retriever";
import type { Convention } from "./types";

export class InjectionFormatter {
	formatInjection(
		episodes: RetrievedEpisode[],
		conventions: Convention[],
		skills: Array<{ name: string; taskPattern: string; approach: string }>,
	): string {
		const parts: string[] = [];

		// Project Conventions
		if (conventions.length > 0) {
			parts.push("## Project Conventions");
			for (const c of conventions) {
				const observed = c.timesApplied + c.timesViolated;
				parts.push(`[${c.type}] ${c.content} (confidence: ${c.confidence}%, observed ${observed} times)`);
			}
			parts.push("");
		}

		// Relevant Past Experiences — filter out low-quality episodes
		const filteredEpisodes = episodes.filter(e => e.relevanceScore >= 40 || e.helpRate > 0.5);
		if (filteredEpisodes.length > 0) {
			parts.push("## Relevant Past Experiences");
			for (const e of filteredEpisodes) {
				parts.push(`[score: ${e.relevanceScore.toFixed(2)}] ${e.episode.summary} (${e.reason})`);
			}
			parts.push("");
		}

		// Relevant Skills
		if (skills.length > 0) {
			parts.push("## Relevant Skills");
			for (const s of skills) {
				parts.push(`${s.name}: ${s.taskPattern}`);
				parts.push(s.approach);
			}
			parts.push("");
		}

		let result = parts.join("\n").trim();

		// Token guard: trim to ~2000 chars max
		if (result.length > 2000) {
			result = result.slice(0, 2000);
			const lastNewline = result.lastIndexOf("\n");
			if (lastNewline > 1800) {
				result = result.slice(0, lastNewline);
			}
			result += "\n... (truncated)";
		}

		logger.debug("injection formatted", {
			conventions: conventions.length,
			episodes: filteredEpisodes.length,
			skills: skills.length,
			chars: result.length,
		});

		return result;
	}
}
