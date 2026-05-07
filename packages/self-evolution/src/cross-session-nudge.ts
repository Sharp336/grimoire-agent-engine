/**
 * CrossSessionNudgeEngine: analyzes historical patterns across ALL sessions
 * and delivers proactive insights before each new session starts.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { EpisodeStore, IntentStore, NudgeHistoryStore } from "./storage/types";
import type { CrossSessionNudge } from "./types";

const CROSS_SESSION_COOLDOWN_MS = 60_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HIGH_TOOL_CALL_THRESHOLD = 20;
const LOW_SUCCESS_RATE_THRESHOLD = 0.3;
const MIN_EPISODES_FOR_PROJECT_ANALYSIS = 5;

export class CrossSessionNudgeEngine {
	#nudgeHistoryStore: NudgeHistoryStore;
	#episodeStore: EpisodeStore;
	#lastDeliveredAt = 0;
	#deliveredThisSession = false;

	constructor(nudgeHistoryStore: NudgeHistoryStore, episodeStore: EpisodeStore, _intentStore: IntentStore) {
		this.#nudgeHistoryStore = nudgeHistoryStore;
		this.#episodeStore = episodeStore;
	}

	resetSession(): void {
		this.#deliveredThisSession = false;
	}

	async analyze(cwd: string, userPrompt: string): Promise<CrossSessionNudge | undefined> {
		const now = Date.now();
		if (this.#deliveredThisSession) return undefined;
		if (now - this.#lastDeliveredAt < CROSS_SESSION_COOLDOWN_MS) return undefined;

		try {
			const last30d = now - THIRTY_DAYS_MS;
			const project = cwd;

			const nudge =
				(await this.#detectRecurringRedundantSearch(last30d)) ??
				(await this.#detectRecurringErrorCascade(last30d)) ??
				(await this.#detectSlowProjectWarmup(project)) ??
				(await this.#detectSkillUnderutilization(userPrompt));

			if (nudge) {
				this.#lastDeliveredAt = now;
				this.#deliveredThisSession = true;
			}
			return nudge;
		} catch (err) {
			logger.warn("CrossSessionNudgeEngine analyze failed", { error: String(err) });
			return undefined;
		}
	}

	async #detectRecurringRedundantSearch(since: number): Promise<CrossSessionNudge | undefined> {
		const count = await this.#nudgeHistoryStore.countByType("redundant-search", since);
		if (count >= 3) {
			return {
				type: "cross-session-redundant-search",
				severity: "info",
				message: `You've had redundant search chains in ${count} recent sessions.`,
				suggestion: "Consider using ast_grep for structural code queries instead of repeated text searches.",
				detectedAt: Date.now(),
			};
		}
		return undefined;
	}

	async #detectRecurringErrorCascade(since: number): Promise<CrossSessionNudge | undefined> {
		const count = await this.#nudgeHistoryStore.countByType("error-cascade", since);
		if (count >= 2) {
			return {
				type: "cross-session-error-cascade",
				severity: "warn",
				message: `Multiple sessions recently ended with tool failure cascades.`,
				suggestion:
					"Common cause: missing files or permission issues. Verify paths and permissions before running commands.",
				detectedAt: Date.now(),
			};
		}
		return undefined;
	}

	async #detectSlowProjectWarmup(project: string): Promise<CrossSessionNudge | undefined> {
		// Get recent episodes for this project
		const recentEpisodes = await this.#episodeStore.listRecent(50);
		const projectEpisodes = recentEpisodes.filter(e => e.cwd === project);

		if (projectEpisodes.length < MIN_EPISODES_FOR_PROJECT_ANALYSIS) {
			return undefined;
		}

		const totalToolCalls = projectEpisodes.reduce((sum, e) => sum + e.toolCallCount, 0);
		const avgToolCalls = totalToolCalls / projectEpisodes.length;
		const successCount = projectEpisodes.filter(e => e.completedSuccessfully).length;
		const successRate = successCount / projectEpisodes.length;

		if (avgToolCalls >= HIGH_TOOL_CALL_THRESHOLD && successRate <= LOW_SUCCESS_RATE_THRESHOLD) {
			return {
				type: "cross-session-slow-warmup",
				severity: "warn",
				message: `This project has a high exploration overhead (${Math.round(avgToolCalls)} avg tool calls per session with low success rate).`,
				suggestion: "Consider creating an init skill to document the architecture and reduce repeated exploration.",
				detectedAt: Date.now(),
			};
		}
		return undefined;
	}

	async #detectSkillUnderutilization(userPrompt: string): Promise<CrossSessionNudge | undefined> {
		// This is a lightweight heuristic: we don't have access to the skill store here,
		// so we rely on episode intents. If the user frequently does the same type of task
		// but episodes show high tool counts (suggesting they don't use skills), nudge them.
		const recentEpisodes = await this.#episodeStore.listRecent(20);
		if (recentEpisodes.length < 3) return undefined;

		// Check if recent similar-prompt episodes had high tool call counts
		const promptWords = userPrompt
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 3);

		const similarEpisodes = recentEpisodes.filter(e => {
			const epWords = e.userPrompt
				.toLowerCase()
				.split(/\W+/)
				.filter(w => w.length > 3);
			const common = promptWords.filter(w => epWords.includes(w));
			return common.length >= 2;
		});

		if (similarEpisodes.length >= 3) {
			const avgToolCalls = similarEpisodes.reduce((sum, e) => sum + e.toolCallCount, 0) / similarEpisodes.length;
			if (avgToolCalls >= 10) {
				return {
					type: "cross-session-skill-underutilization",
					severity: "info",
					message: `You've performed similar tasks multiple times with high tool usage.`,
					suggestion: "Consider extracting a skill for this workflow to reduce repetition in future sessions.",
					detectedAt: Date.now(),
				};
			}
		}
		return undefined;
	}
}
