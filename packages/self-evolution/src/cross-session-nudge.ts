/**
 * CrossSessionNudgeEngine: analyzes historical patterns across ALL sessions
 * and delivers proactive insights before each new session starts.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { EpisodeStore, NudgeHistoryStore, ProfileStore } from "./storage/types";
import type { CrossSessionNudge, UserProfile } from "./types";

const CROSS_SESSION_COOLDOWN_MS = 60_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HIGH_TOOL_CALL_THRESHOLD = 20;
const LOW_SUCCESS_RATE_THRESHOLD = 0.3;
const MIN_EPISODES_FOR_PROJECT_ANALYSIS = 5;

export class CrossSessionNudgeEngine {
	#nudgeHistoryStore: NudgeHistoryStore;
	#episodeStore: EpisodeStore;
	#profileStore: ProfileStore;
	#lastDeliveredAt = 0;
	#deliveredThisSession = false;

	constructor(nudgeHistoryStore: NudgeHistoryStore, episodeStore: EpisodeStore, profileStore: ProfileStore) {
		this.#nudgeHistoryStore = nudgeHistoryStore;
		this.#episodeStore = episodeStore;
		this.#profileStore = profileStore;
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
			const profile = await this.#profileStore.get("default");

			const nudge =
				(await this.#detectHighGlobalErrorRate(profile)) ??
				(await this.#detectRecurringRedundantSearch(last30d)) ??
				(await this.#detectRecurringErrorCascade(last30d)) ??
				(await this.#detectSlowProjectWarmup(project, profile)) ??
				(await this.#detectSkillUnderutilization(userPrompt, profile));

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

	async #detectHighGlobalErrorRate(profile: UserProfile | undefined): Promise<CrossSessionNudge | undefined> {
		if (!profile || profile.sessionCount < 5) return undefined;
		if (profile.errorRate > 0.3) {
			return {
				type: "cross-session-high-error-rate",
				severity: "warn",
				message: `Your recent sessions have a ${(profile.errorRate * 100).toFixed(0)}% error rate.`,
				suggestion: "Review common failure patterns: missing files, permission issues, or incomplete commands.",
				detectedAt: Date.now(),
			};
		}
		return undefined;
	}

	async #detectSlowProjectWarmup(
		project: string,
		profile: UserProfile | undefined,
	): Promise<CrossSessionNudge | undefined> {
		const recentEpisodes = await this.#episodeStore.listRecent(50);
		const projectEpisodes = recentEpisodes.filter(e => e.cwd === project);

		if (projectEpisodes.length < MIN_EPISODES_FOR_PROJECT_ANALYSIS) {
			return undefined;
		}

		const totalToolCalls = projectEpisodes.reduce((sum, e) => sum + e.toolCallCount, 0);
		const avgToolCalls = totalToolCalls / projectEpisodes.length;
		const successCount = projectEpisodes.filter(e => e.completedSuccessfully).length;
		const successRate = successCount / projectEpisodes.length;

		// Use profile baseline if available, otherwise use fixed thresholds
		const baselineToolCalls = profile?.avgToolCallsPerSession ?? HIGH_TOOL_CALL_THRESHOLD;
		const baselineSuccessRate = profile ? 1 - profile.errorRate : 1 - LOW_SUCCESS_RATE_THRESHOLD;

		if (avgToolCalls >= baselineToolCalls * 1.5 && successRate <= baselineSuccessRate * 0.7) {
			return {
				type: "cross-session-slow-warmup",
				severity: "warn",
				message: `This project has a high exploration overhead (${Math.round(avgToolCalls)} avg tool calls vs your baseline ${baselineToolCalls.toFixed(1)}).`,
				suggestion: "Consider creating an init skill to document the architecture and reduce repeated exploration.",
				detectedAt: Date.now(),
			};
		}
		return undefined;
	}

	async #detectSkillUnderutilization(
		userPrompt: string,
		profile: UserProfile | undefined,
	): Promise<CrossSessionNudge | undefined> {
		if (!profile || profile.sessionCount < 3) {
			// Fall back to episode-based heuristic when profile is unavailable
			const recentEpisodes = await this.#episodeStore.listRecent(20);
			if (recentEpisodes.length < 3) return undefined;

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

		// Profile-based heuristic: check if current prompt words match top intents
		const promptWords = userPrompt
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 3);
		const topIntents = Object.entries(profile.intentDistribution)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([i]) => i);

		// Simple heuristic: if prompt contains words related to top intent
		const intentWordMap: Record<string, string[]> = {
			refactoring: ["refactor", "restructure", "rename", "extract", "move"],
			bugfix: ["fix", "bug", "error", "crash", "broken", "repair"],
			"feature-add": ["add", "feature", "implement", "create", "new"],
			testing: ["test", "spec", "coverage", "jest", "vitest"],
			documentation: ["doc", "readme", "comment", "markdown"],
			configuration: ["config", "setup", "env", "dockerfile", "yaml"],
			exploration: ["explore", "investigate", "research", "understand"],
			optimization: ["optimize", "perf", "performance", "cache", "speed"],
			integration: ["integrate", "api", "webhook", "sync", "connect"],
		};

		const matchedTopIntent = topIntents.find(intent => {
			const words = intentWordMap[intent] ?? [];
			return words.some(w => promptWords.includes(w));
		});

		if (matchedTopIntent && profile.avgToolCallsPerSession >= 10) {
			return {
				type: "cross-session-skill-underutilization",
				severity: "info",
				message: `You frequently work on "${matchedTopIntent}" tasks with ${profile.avgToolCallsPerSession.toFixed(1)} avg tool calls per session.`,
				suggestion: `Consider extracting a skill for "${matchedTopIntent}" workflows to reduce repetition.`,
				detectedAt: Date.now(),
			};
		}
		return undefined;
	}
}
