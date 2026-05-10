import type { UserPersona } from "@oh-my-pi/pi-coding-agent/persona/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { RetrievedEpisode } from "./context-aware-retriever";
import type { Convention, UserProfile } from "./types";

export class InjectionFormatter {
	formatInjection(
		episodes: RetrievedEpisode[],
		conventions: Convention[],
		skills: Array<{ name: string; taskPattern: string; approach: string }>,
		profile?: UserProfile,
		persona?: UserPersona,
	): string {
		const parts: string[] = [];

		// User Profile (semantic memory)
		const profileText = this.#formatProfile(profile, persona);
		if (profileText) {
			parts.push(profileText);
		}

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
			profile: profile ? "yes" : "no",
			persona: persona ? "yes" : "no",
			chars: result.length,
		});

		return result;
	}

	#formatProfile(profile?: UserProfile, persona?: UserPersona): string | undefined {
		if (!profile && !persona) return undefined;

		const lines: string[] = [];
		lines.push("## User Profile");

		// Persona data (manual)
		if (persona) {
			if (persona.career.role) lines.push(`- Role: ${persona.career.role}`);
			if (persona.career.expertise?.length) lines.push(`- Expertise: ${persona.career.expertise.join(", ")}`);
			if (persona.preferences.communicationStyle)
				lines.push(`- Communication style: ${persona.preferences.communicationStyle}`);
			if (persona.preferences.outputFormat) lines.push(`- Output format: ${persona.preferences.outputFormat}`);
			if (persona.thinking.workStyle) lines.push(`- Work style: ${persona.thinking.workStyle}`);
			if (persona.interaction.proactive !== undefined)
				lines.push(`- Allows proactive extension: ${persona.interaction.proactive ? "yes" : "no"}`);
			if (persona.constraints.forbidden.length)
				lines.push(`- Forbidden: ${persona.constraints.forbidden.join(", ")}`);
		}

		// Profile data (auto-derived)
		if (profile && profile.sessionCount > 0) {
			lines.push(`- Sessions analyzed: ${profile.sessionCount}`);
			lines.push(`- Avg tool calls/session: ${profile.avgToolCallsPerSession.toFixed(1)}`);
			if (profile.preferredLanguages.length)
				lines.push(`- Preferred languages: ${profile.preferredLanguages.join(", ")}`);

			const topIntents = Object.entries(profile.intentDistribution)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([i, c]) => `${i}(${c})`)
				.join(", ");
			if (topIntents) lines.push(`- Top intents: ${topIntents}`);

			const topTools = Object.entries(profile.toolFrequency)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([t, c]) => `${t}(${c})`)
				.join(", ");
			if (topTools) lines.push(`- Top tools: ${topTools}`);
		}

		if (lines.length <= 1) return undefined; // Only header, no content
		return `${lines.join("\n")}\n`;
	}
}
