/**
 * Self-evolution extension factory.
 *
 * Registers event handlers, commands, tools, and flags for automatic
 * skill extraction and episodic memory retrieval.
 */
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { logger } from "@oh-my-pi/pi-utils";
import { registerSelfEvolutionCommands } from "./commands";
import { ContextAwareRetriever } from "./context-aware-retriever";
import { CrossSessionNudgeEngine } from "./cross-session-nudge";
import type { SkillExtractor } from "./extractor";
import { FeedbackTracker } from "./feedback-tracker";
import { IntentClassifier } from "./intent-classifier";
import { type ActivityLogger, closeActivityLogger, getActivityLogger } from "./logging/activity-logger";
import { SkillManager } from "./manager";
import { NudgeDeliverer } from "./nudge-deliverer";
import type { EpisodeRetriever } from "./retrieval";
import { closeEvolutionDb, getEvolutionDb } from "./storage/db";
import { SqliteEffectivenessStore } from "./storage/effectiveness";
import { SqliteEpisodeStore } from "./storage/episodes";
import { SqliteIntentStore } from "./storage/intents";
import { SqliteNudgeHistoryStore } from "./storage/nudge-history";
import { SqliteProfileStore } from "./storage/profiles";
import { SqliteSkillEffectivenessStore } from "./storage/skill-effectiveness";
import { SqliteSkillStore, SqliteSkillVersionStore, type SqliteStatsStore } from "./storage/skills";
import { SqliteWorkflowPatternStore } from "./storage/workflow-patterns";
import { registerSelfEvolutionTools } from "./tools";
import { summarizeTrace, TraceRecorder } from "./trace";
import type { SelfEvolutionFlags } from "./types";
import { UserProfiler } from "./user-profiler";
import { WorkflowMiner } from "./workflow-miner";

export type { SelfEvolutionFlags };

export function parseFlags(api: ExtensionAPI): SelfEvolutionFlags {
	return {
		enabled: api.getFlag("self-evolution") !== false,
		skillThreshold: Number(api.getFlag("self-evolution-skill-threshold") ?? "5"),
		maxEpisodes: Number(api.getFlag("self-evolution-max-episodes") ?? "100"),
		enablePromptInjection: api.getFlag("self-evolution-enable-prompt-injection") !== false,
		llmRefinement: api.getFlag("self-evolution-llm-refinement") !== false,
		llmRerank: api.getFlag("self-evolution-llm-rerank") !== false,
		enableVersioning: api.getFlag("self-evolution-enable-versioning") !== false,
		enableActivityLog: api.getFlag("self-evolution-enable-activity-log") !== false,
		globalStore: api.getFlag("self-evolution-global-store") !== false,
	};
}
export const createSelfEvolutionExtension: ExtensionFactory = api => {
	// Register CLI flags
	api.registerFlag("self-evolution", { type: "boolean", default: true, description: "Enable self-evolution plugin" });
	api.registerFlag("self-evolution-skill-threshold", {
		type: "string",
		default: "5",
		description: "Min tool calls to trigger skill extraction",
	});
	api.registerFlag("self-evolution-max-episodes", {
		type: "string",
		default: "100",
		description: "Max episodes to retain for retrieval",
	});
	api.registerFlag("self-evolution-enable-prompt-injection", {
		type: "boolean",
		default: true,
		description: "Inject past experiences into system prompt",
	});
	api.registerFlag("self-evolution-llm-refinement", {
		type: "boolean",
		default: true,
		description: "Use LLM to refine extracted skills",
	});
	api.registerFlag("self-evolution-llm-rerank", {
		type: "boolean",
		default: true,
		description: "Use LLM to rerank retrieved episodes",
	});
	api.registerFlag("self-evolution-enable-versioning", {
		type: "boolean",
		default: true,
		description: "Enable skill version snapshots",
	});
	api.registerFlag("self-evolution-enable-activity-log", {
		type: "boolean",
		default: true,
		description: "Enable JSONL activity logging",
	});
	api.registerFlag("self-evolution-global-store", {
		type: "boolean",
		default: false,
		description: "Use a global store shared across all projects (instead of per-project isolation)",
	});

	let flags = parseFlags(api);
	if (!flags.enabled) {
		logger.debug("Self-evolution extension disabled by flag");
		return;
	}

	// Lazily initialize per-session state. Variables are declared here
	// and populated by ensureInit when first needed (event handler or command).
	let recorder: TraceRecorder | undefined;
	let activityLogger: ActivityLogger | undefined;
	let episodeStore: SqliteEpisodeStore | undefined;
	let skillStore: SqliteSkillStore | undefined;
	let versionStore: SqliteSkillVersionStore | undefined;
	let statsStore: SqliteStatsStore | undefined;
	let skillManager: SkillManager | undefined;
	let intentStore: SqliteIntentStore | undefined;
	let profileStore: SqliteProfileStore | undefined;
	let effectivenessStore: SqliteEffectivenessStore | undefined;
	let skillEffectivenessStore: SqliteSkillEffectivenessStore | undefined;
	let intentClassifier: IntentClassifier | undefined;
	let workflowMiner: WorkflowMiner | undefined;
	let userProfiler: UserProfiler | undefined;
	let workflowPatternStore: SqliteWorkflowPatternStore | undefined;
	let feedbackTracker: FeedbackTracker | undefined;
	let contextAwareRetriever: ContextAwareRetriever | undefined;
	let episodeRetriever: EpisodeRetriever | undefined;
	let extractor: SkillExtractor | undefined;
	let nudgeHistoryStore: SqliteNudgeHistoryStore | undefined;
	let crossSessionNudgeEngine: CrossSessionNudgeEngine | undefined;
	function _ensureInit(cwd: string): void {
		if (recorder) return;
		flags = parseFlags(api);
		recorder = new TraceRecorder();
		activityLogger = getActivityLogger(cwd, flags.globalStore);
		const db = getEvolutionDb(cwd, flags.globalStore);
		episodeStore = new SqliteEpisodeStore(db);
		skillStore = new SqliteSkillStore(db);
		versionStore = new SqliteSkillVersionStore(db);
		skillEffectivenessStore = new SqliteSkillEffectivenessStore(db);
		skillManager = new SkillManager(skillStore, versionStore, activityLogger, skillEffectivenessStore, episodeStore, {
			enableVersioning: flags.enableVersioning,
			maxVersions: 20,
		});

		intentStore = new SqliteIntentStore(db);
		profileStore = new SqliteProfileStore(db);
		workflowPatternStore = new SqliteWorkflowPatternStore(db);
		effectivenessStore = new SqliteEffectivenessStore(db);
		contextAwareRetriever = new ContextAwareRetriever(episodeStore, intentStore);
		intentClassifier = new IntentClassifier();
		workflowMiner = new WorkflowMiner();
		userProfiler = new UserProfiler();
		feedbackTracker = new FeedbackTracker(effectivenessStore, skillEffectivenessStore);
		nudgeHistoryStore = new SqliteNudgeHistoryStore(db);
		crossSessionNudgeEngine = new CrossSessionNudgeEngine(nudgeHistoryStore, episodeStore, intentStore);
	}
	async function _retrieveRelevantSkills(
		query: string,
	): Promise<Array<{ name: string; taskPattern: string; approach: string }>> {
		if (!skillStore) return [];
		const skills = await skillStore.list({ deprecated: false });
		if (skills.length === 0) return [];

		const queryWords = query
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 2);

		const scored = skills.map(skill => {
			const text = `${skill.name} ${skill.description} ${skill.taskPattern} ${skill.approach}`.toLowerCase();
			let matches = 0;
			for (const word of queryWords) {
				if (text.includes(word)) matches++;
			}
			const score = queryWords.length > 0 ? (matches / queryWords.length) * 100 : 50;
			return { skill, score };
		});

		scored.sort((a, b) => b.score - a.score);
		return scored
			.filter(s => s.score >= 30)
			.slice(0, 3)
			.map(s => ({ name: s.skill.name, taskPattern: s.skill.taskPattern, approach: s.skill.approach }));
	}

	// Register commands and tools in the factory body so they are collected
	// by the extension loader. Handlers call ensureInit on demand.
	registerSelfEvolutionCommands(api, {
		ensureInit: _ensureInit,
		episodeStore: () => episodeStore!,
		skillStore: () => skillStore!,
		versionStore: () => versionStore!,
		statsStore: () => statsStore!,
		skillManager: () => skillManager!,
		activityLogger: () => activityLogger!,
		profileStore: () => profileStore!,
		workflowPatternStore: () => workflowPatternStore!,
	});

	registerSelfEvolutionTools(api, {
		ensureInit: _ensureInit,
		episodeRetriever: () => episodeRetriever!,
		skillStore: () => skillStore!,
		skillManager: () => skillManager!,
		activityLogger: () => activityLogger!,
	});

	api.on("agent_start", (event, ctx) => {
		try {
			_ensureInit(ctx.cwd);
			recorder!.onAgentStart(event, ctx);
			crossSessionNudgeEngine?.resetSession();
			activityLogger!
				.log("trace_started", {
					sessionId: ctx.sessionManager.getSessionId(),
					cwd: ctx.cwd,
					userPrompt: "",
				})
				.catch((err: unknown) => logger.warn("activity log failed", { error: String(err) }));
		} catch (err) {
			logger.error("Self-evolution agent_start handler failed", { error: String(err) });
		}
	});

	api.on("input", (event, _ctx) => {
		try {
			recorder?.onInput(event.text);
		} catch (err) {
			logger.error("Self-evolution input handler failed", { error: String(err) });
		}
	});

	api.on("tool_execution_start", (event, _ctx) => {
		try {
			recorder?.onToolExecutionStart(event);
			activityLogger
				?.log("tool_called", {
					sessionId: recorder?.getTrace()?.sessionId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
				})
				.catch((err: unknown) => logger.warn("activity log failed", { error: String(err) }));
		} catch (err) {
			logger.error("Self-evolution tool_execution_start handler failed", { error: String(err) });
		}
	});

	api.on("tool_execution_end", (event, _ctx) => {
		try {
			recorder?.onToolExecutionEnd(event);
			activityLogger
				?.log("tool_result", {
					sessionId: recorder?.getTrace()?.sessionId,
					toolCallId: event.toolCallId,
					isError: event.isError,
				})
				.catch((err: unknown) => logger.warn("activity log failed", { error: String(err) }));

			const nudge = recorder?.checkForNudges();
			if (nudge && _ctx.hasUI) {
				new NudgeDeliverer().deliver(nudge, _ctx);
			}
			if (nudge && nudgeHistoryStore) {
				const trace = recorder?.getTrace();
				nudgeHistoryStore
					.insert({
						id: `${trace?.sessionId ?? "unknown"}-${nudge.type}-${Date.now()}`,
						sessionId: trace?.sessionId ?? "unknown",
						project: trace?.cwd ?? "",
						type: nudge.type,
						severity: nudge.severity,
						message: nudge.message,
						suggestion: nudge.suggestion,
						detectedAt: Date.now(),
					})
					.catch((err: unknown) => logger.warn("nudge history insert failed", { error: String(err) }));
			}
		} catch (err) {
			logger.error("Self-evolution tool_execution_end handler failed", { error: String(err) });
		}
	});

	api.on("message_end", (event, _ctx) => {
		try {
			recorder?.onMessageEnd(event);
		} catch (err) {
			logger.error("Self-evolution message_end handler failed", { error: String(err) });
		}
	});

	api.on("agent_end", async (_event, ctx) => {
		try {
			const trace = recorder?.onAgentEnd(_event);
			if (!trace) return;

			await activityLogger?.log("trace_finalized", {
				sessionId: trace.sessionId,
				toolCallCount: trace.toolCallCount,
				errorCount: trace.errorCount,
				completedSuccessfully: trace.completedSuccessfully,
			});

			// Archive episode
			const { summary, toolsUsed, filesModified } = summarizeTrace(trace);
			const episode = {
				id: `${trace.sessionId}-${trace.startTime}`,
				sessionId: trace.sessionId,
				cwd: trace.cwd,
				userPrompt: trace.userPrompt,
				timestamp: trace.startTime,
				durationMs: trace.endTime - trace.startTime,
				toolCallCount: trace.toolCallCount,
				errorCount: trace.errorCount,
				hadRecovery: trace.hadRecovery,
				completedSuccessfully: trace.completedSuccessfully,
				summary,
				toolsUsed,
				filesModified,
			};
			await episodeStore?.insert(episode);
			await statsStore?.increment("sessions_archived");
			await activityLogger?.log("episode_archived", {
				episodeId: episode.id,
				sessionId: trace.sessionId,
				summary,
				toolCallCount: trace.toolCallCount,
			});

			// Extract intent
			const intentResult = intentClassifier?.ruleClassify(trace);
			if (intentResult) {
				await intentStore?.insert({
					episodeId: episode.id,
					intent: intentResult.intent,
					confidence: intentResult.confidence,
					source: intentResult.source,
				});
				await activityLogger?.log("intent_classified", {
					episodeId: episode.id,
					intent: intentResult.intent,
					confidence: intentResult.confidence,
					source: intentResult.source,
				});
			}

			// Mine workflow pattern
			const pattern = workflowMiner?.mine(trace, intentResult?.intent ?? "exploration");
			if (pattern) {
				await workflowPatternStore?.upsert(pattern);
				await activityLogger?.log("workflow_mined", {
					patternId: pattern.id,
					intent: pattern.intent,
					sequence: pattern.toolSequence,
				});
			}

			// Update user profile
			if (userProfiler && intentResult) {
				userProfiler.updateProfile(trace, intentResult.intent);
				const profile = userProfiler.getProfile();
				await profileStore?.upsert("default", profile);
				await activityLogger?.log("profile_updated", {
					sessionCount: profile.sessionCount,
					topIntent: Object.entries(profile.intentDistribution).sort((a, b) => b[1] - a[1])[0]?.[0],
				});
			}

			// Record feedback for previously injected episodes
			const prevInjected = trace.injectedEpisodeIds;
			if (prevInjected && prevInjected.length > 0 && feedbackTracker) {
				const succeeded = trace.completedSuccessfully && trace.errorCount === 0;
				await feedbackTracker.recordOutcome(prevInjected, succeeded);
			}
			// Record feedback for previously injected skills
			const prevInjectedSkills = trace.injectedSkillNames;
			if (prevInjectedSkills && prevInjectedSkills.length > 0 && feedbackTracker) {
				const succeeded = trace.completedSuccessfully && trace.errorCount === 0;
				await feedbackTracker.recordSkillOutcome(prevInjectedSkills, succeeded);
				if (succeeded && skillManager) {
					for (const name of prevInjectedSkills) {
						await skillManager.recordSkillUsage(name, true);
					}
				}
			}

			// Extract skill if significant
			if (extractor) {
				const extracted = await extractor.extract(trace, {
					skillThreshold: flags.skillThreshold,
					llmRefinement: flags.llmRefinement,
					model: ctx.model,
				});
				if (extracted && skillManager) {
					await skillManager.integrate(extracted, ctx.model);
				}
			}

			// Cleanup old episodes
			await episodeStore?.deleteOld(flags.maxEpisodes);
		} catch (err) {
			logger.error("Self-evolution agent_end handler failed", { error: String(err) });
		}
	});

	api.on("before_agent_start", async (event, ctx) => {
		try {
			// Capture user prompt from before_agent_start before trace exists
			recorder?.seedPrompt(event.prompt);
			if (!flags.enablePromptInjection) return;
			if (!contextAwareRetriever || !recorder) return;

			const intentResult = intentClassifier?.ruleClassify({
				sessionId: "",
				cwd: ctx.cwd,
				userPrompt: event.prompt,
				startTime: Date.now(),
				endTime: 0,
				entries: [],
				toolCallCount: 0,
				errorCount: 0,
				hadRecovery: false,
				completedSuccessfully: false,
			});

			const profile = await profileStore?.get("default");
			const episodes = await contextAwareRetriever.retrieve(event.prompt, {
				maxEpisodes: flags.maxEpisodes,
				llmRerank: flags.llmRerank,
				model: ctx.model,
				currentIntent: intentResult?.intent,
				profile: profile ?? undefined,
			});
			const relevantSkills = await _retrieveRelevantSkills(event.prompt);
			if (episodes.length === 0 && relevantSkills.length === 0) return;

			// Track injected episodes for feedback
			recorder?.setInjectedEpisodes(episodes.map(e => e.episode.id));
			await feedbackTracker?.trackInjection(episodes.map(e => e.episode.id));

			// Track injected skills for feedback
			recorder?.setInjectedSkills(relevantSkills.map(s => s.name));
			await feedbackTracker?.trackSkillInjection(relevantSkills.map(s => s.name));
			// Cross-session nudge analysis
			const crossNudge = await crossSessionNudgeEngine?.analyze(ctx.cwd, event.prompt);
			if (crossNudge && ctx.hasUI) {
				ctx.ui.notify(
					`[Cross-Session ${crossNudge.severity === "warn" ? "Warning" : "Tip"}] ${crossNudge.message}\nSuggestion: ${crossNudge.suggestion}`,
					crossNudge.severity === "warn" ? "warning" : "info",
				);
			}

			let injection = "";
			if (episodes.length > 0) {
				injection += "\n\n## Relevant Past Experience\n\n";
				for (const e of episodes) {
					const text = e.episode.summary.slice(0, 200);
					injection += `[${e.episode.id}] ${text} (${e.reason})\n`;
				}
			}
			if (relevantSkills.length > 0) {
				injection += "\n\n## Relevant Skills\n\n";
				for (const s of relevantSkills) {
					injection += `**${s.name}**: ${s.taskPattern.slice(0, 120)}\n${s.approach.slice(0, 300)}\n\n`;
				}
			}

			// Rough token guard: ~4 chars per token
			if (injection.length > 2000) {
				injection = injection.slice(0, 2000);
			}

			await activityLogger?.log("prompt_injected", {
				sessionId: ctx.sessionManager.getSessionId(),
				episodeIds: episodes.map(e => e.episode.id),
				skillNames: relevantSkills.map(s => s.name),
				tokenCount: Math.ceil(injection.length / 4),
				intent: intentResult?.intent,
			});

			return {
				systemPrompt: event.systemPrompt + injection,
			};
		} catch (err) {
			logger.error("Self-evolution before_agent_start handler failed", { error: String(err) });
		}
	});

	api.on("session_shutdown", async (_event, _ctx) => {
		try {
			closeActivityLogger(_ctx.cwd, flags.globalStore);
			closeEvolutionDb(_ctx.cwd, flags.globalStore);
			recorder = undefined;
			episodeStore = undefined;
			skillStore = undefined;
			versionStore = undefined;
			statsStore = undefined;
			skillManager = undefined;
			episodeRetriever = undefined;
			intentStore = undefined;
			profileStore = undefined;
			effectivenessStore = undefined;
			skillEffectivenessStore = undefined;
			nudgeHistoryStore = undefined;
			crossSessionNudgeEngine = undefined;

			intentClassifier = undefined;
			workflowMiner = undefined;
			userProfiler = undefined;
			feedbackTracker = undefined;
			contextAwareRetriever = undefined;
			extractor = undefined;
		} catch (err) {
			logger.error("Self-evolution session_shutdown handler failed", { error: String(err) });
		}
	});
};
