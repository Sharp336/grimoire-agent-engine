/**
 * Self-evolution extension factory.
 *
 * Registers event handlers, commands, tools, and flags for automatic
 * skill extraction and episodic memory retrieval.
 */
import type { Database } from "bun:sqlite";
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { FilePersonaStore } from "@oh-my-pi/pi-coding-agent/persona/store";
import { SchedulerDbStorage } from "@oh-my-pi/pi-coding-agent/scheduler/storage";
import { getNextRun, getSchedulerDbPath } from "@oh-my-pi/pi-coding-agent/scheduler/types";
import { logger } from "@oh-my-pi/pi-utils";
import { registerSelfEvolutionCommands } from "./commands";
import { ContextAwareRetriever } from "./context-aware-retriever";
import { ConventionComplianceChecker } from "./convention-compliance";
import { ConventionExtractor } from "./convention-extractor";
import { CrossSessionNudgeEngine } from "./cross-session-nudge";
import { EffectivenessAnalyzer } from "./effectiveness-analyzer";
import { ErrorPatternExtractor } from "./error-pattern-extractor";
import type { SkillExtractor } from "./extractor";
import { FeedbackTracker } from "./feedback-tracker";
import { InjectionFormatter } from "./injection-formatter";
import { IntentClassifier } from "./intent-classifier";
import { type ActivityLogger, closeActivityLogger, getActivityLogger } from "./logging/activity-logger";
import { SkillManager } from "./manager";
import { NudgeDeliverer } from "./nudge-deliverer";
import { EpisodeRetriever } from "./retrieval";
import { SqliteConventionFeedbackStore } from "./storage/convention-feedback";
import { SqliteConventionStore } from "./storage/conventions";
import { closeEvolutionDb, getEvolutionDb } from "./storage/db";
import { SqliteDetailedOutcomeStore } from "./storage/detailed-outcomes";
import { SqliteEpisodeDiagnosisStore } from "./storage/diagnoses";
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
import { TraceAnalyzer } from "./trace-analyzer";
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
		default: "500",
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
		default: true,
		description: "Use a global store shared across all projects (instead of per-project isolation)",
	});

	let flags = parseFlags(api);
	if (!flags.enabled) {
		logger.debug("Self-evolution extension disabled by flag");
		return;
	}

	// Lazily initialize per-session state. Variables are declared here
	// and populated by ensureInit when first needed (event handler or command).
	let traceAnalyzer: TraceAnalyzer | undefined;
	let diagnosisStore: SqliteEpisodeDiagnosisStore | undefined;
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

	let conventionStore: SqliteConventionStore | undefined;
	let conventionExtractor: ConventionExtractor | undefined;
	let effectivenessAnalyzer: EffectivenessAnalyzer | undefined;
	let injectionFormatter: InjectionFormatter | undefined;
	let errorPatternExtractor: ErrorPatternExtractor | undefined;
	let detailedOutcomeStore: SqliteDetailedOutcomeStore | undefined;
	let conventionFeedbackStore: import("./storage/convention-feedback").SqliteConventionFeedbackStore | undefined;
	let conventionComplianceChecker: import("./convention-compliance").ConventionComplianceChecker | undefined;
	let db: Database | undefined;
	function _ensureInit(cwd: string): void {
		if (recorder) return;
		flags = parseFlags(api);
		traceAnalyzer = new TraceAnalyzer();
		recorder = new TraceRecorder();
		activityLogger = getActivityLogger(cwd, flags.globalStore);
		const evolutionDb = getEvolutionDb(cwd, flags.globalStore);
		db = evolutionDb;
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
		contextAwareRetriever = new ContextAwareRetriever(episodeStore, intentStore, effectivenessStore);
		episodeRetriever = new EpisodeRetriever(episodeStore);
		intentClassifier = new IntentClassifier();
		workflowMiner = new WorkflowMiner();
		const savedProfile = profileStore
			.get("default")
			.then(p => p ?? undefined)
			.catch(() => undefined);
		// userProfiler must be initialized here — it was dead code before (issue #1)
		userProfiler = new UserProfiler();
		savedProfile
			.then(p => {
				if (p) userProfiler = UserProfiler.deserialize(JSON.stringify(p));
			})
			.catch(() => {});
		detailedOutcomeStore = new SqliteDetailedOutcomeStore(db);
		feedbackTracker = new FeedbackTracker(effectivenessStore, skillEffectivenessStore, detailedOutcomeStore);
		nudgeHistoryStore = new SqliteNudgeHistoryStore(db);
		crossSessionNudgeEngine = new CrossSessionNudgeEngine(
			nudgeHistoryStore,
			episodeStore,
			profileStore,
			diagnosisStore,
		);
		conventionStore = new SqliteConventionStore(db);
		conventionFeedbackStore = new SqliteConventionFeedbackStore(db);
		conventionComplianceChecker = new ConventionComplianceChecker();
		conventionExtractor = new ConventionExtractor();
		effectivenessAnalyzer = new EffectivenessAnalyzer();
		injectionFormatter = new InjectionFormatter();
		errorPatternExtractor = new ErrorPatternExtractor();
		diagnosisStore = new SqliteEpisodeDiagnosisStore(db);

		// Auto-register daily audit scheduled task if not present
		try {
			const schedulerStorage = new SchedulerDbStorage(getSchedulerDbPath());
			const existing = schedulerStorage.getTaskByName("evolution-audit");
			if (!existing) {
				const cron = "0 9 * * *"; // Daily at 9 AM
				const nextRun = getNextRun(cron);
				schedulerStorage.addTask({
					name: "evolution-audit",
					description: "Daily self-evolution health audit",
					cron,
					command:
						"Analyze the self-evolution database at ./.omp/self-evolution/evolution.db. " +
						"Query the episodes, skills, effectiveness, episode_intents, workflow_patterns, and conventions tables to assess the health of the learning system. " +
						"Calculate key metrics: episode count, skill extraction rate, average success rate, error rate, intent distribution, and convention coverage. " +
						"Identify data quality issues (e.g., low skill extraction rate, poor episode success rate, stale conventions, workflow pattern noise). " +
						"Suggest concrete, actionable improvements. Report findings in a concise summary.",
					scheduleType: "cron",
					taskType: "agent",
					timeoutMs: 300_000,
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					nextRunAt: nextRun ? nextRun.getTime() : undefined,
					runCount: 0,
					failCount: 0,
				});
				logger.debug("Auto-registered evolution-audit scheduled task");
			}
			schedulerStorage.close();
		} catch {
			// Scheduler DB may not be available; ignore
		}

		// Auto-register fit evaluation scheduled task (every 3 days at 10 AM)
		try {
			const schedulerStorage = new SchedulerDbStorage(getSchedulerDbPath());
			const existing = schedulerStorage.getTaskByName("evolution-fit");
			if (!existing) {
				const cron = "0 10 */3 * *"; // Every 3 days at 10 AM
				const nextRun = getNextRun(cron);
				schedulerStorage.addTask({
					name: "evolution-fit",
					description: "Agent '懂我程度' fit evaluation",
					cron,
					command:
						"Run the '懂我程度' (agent understanding me) fit evaluation. " +
						"Execute each test prompt from the fit-test-tasks dataset (20 prompts across 5 dimensions: memory, thinking, style, prediction, history). " +
						"For each prompt, respond naturally as you would in a real session. " +
						"After responding to all prompts, run '/evolution-fit' to generate the score report. " +
						"The report should show total score out of 100, per-dimension scores, trend vs. last evaluation, and improvement suggestions. " +
						"Output the report directly — no preamble, no explanation.",
					scheduleType: "cron",
					taskType: "agent",
					timeoutMs: 600_000,
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					nextRunAt: nextRun ? nextRun.getTime() : undefined,
					runCount: 0,
					failCount: 0,
				});
				logger.debug("Auto-registered evolution-fit scheduled task");
			}
			schedulerStorage.close();
		} catch {
			// Scheduler DB may not be available; ignore
		}
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
		conventionStore: () => conventionStore!,
		effectivenessStore: () => effectivenessStore!,
		db: () => db!,
		flags: () => flags,
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

			// Deep causal diagnosis (LLM-enhanced when model is available)
			const diagnosis = await traceAnalyzer?.analyzeWithLlm(trace, ctx.model);
			if (diagnosis) {
				// Align diagnosis sessionId with episode id for FK constraint
				diagnosis.sessionId = episode.id;
				await activityLogger?.log("trace_diagnosed", {
					sessionId: trace.sessionId,
					readFailureCount: diagnosis.readFailures.length,
					cascadePatternCount: diagnosis.cascadePatterns.length,
					dominantErrorTool: diagnosis.dominantErrorTool,
					suggestedAction: diagnosis.suggestedAction,
				});
			}

			if (diagnosis) {
				await diagnosisStore?.insert(diagnosis);
			}
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

			// Extract conventions from user dialogue (enhanced with causal diagnosis)
			if (conventionExtractor && conventionStore) {
				const conventions = conventionExtractor.extract(trace);
				let diagnosisConventions: import("./types").Convention[] = [];
				for (const c of conventions) {
					await conventionStore.insert(c);
					await conventionStore.updateStats(c.id, true, false);
				}
				if (diagnosis) {
					diagnosisConventions = conventionExtractor.extractFromDiagnosis(diagnosis);
					for (const c of diagnosisConventions) {
						await conventionStore.insert(c);
						await conventionStore.updateStats(c.id, true, false);
					}
					if (diagnosisConventions.length > 0) {
						await activityLogger?.log("diagnosis_conventions_extracted", { count: diagnosisConventions.length });
					}
				}
				const total = conventions.length + diagnosisConventions.length;
				if (total > 0) {
					await activityLogger?.log("conventions_extracted", { count: total });
				}
			}

			// Extract error patterns from this session
			if (errorPatternExtractor && conventionStore) {
				const patterns = errorPatternExtractor.extract(trace);
				for (const p of patterns) {
					for (const convention of p.extractedConventions) {
						const c = {
							id: `${p.id}-convention`,
							type: "negative_rule" as const,
							content: convention,
							sourceEpisodeId: trace.sessionId,
							confidence: 60,
							timesApplied: 0,
							timesViolated: 0,
							createdAt: Date.now(),
							lastSeenAt: Date.now(),
						};
						// insert() handles deduplication and confidence boost
						await conventionStore.insert(c);
						await conventionStore.updateStats(c.id, true, false);
					}
				}
				if (patterns.length > 0) {
					await activityLogger?.log("error_patterns_detected", {
						count: patterns.length,
						sessionId: trace.sessionId,
					});
				}
			}

			// Record feedback for previously injected episodes using multi-dimensional analysis
			const prevInjected = trace.injectedEpisodeIds;
			if (prevInjected && prevInjected.length > 0 && feedbackTracker && effectivenessAnalyzer && episodeStore) {
				const outcomes = [];
				for (const id of prevInjected) {
					const episode = await episodeStore.get(id);
					if (episode) {
						const outcome = effectivenessAnalyzer.analyze(trace, episode);
						outcomes.push(outcome);
					}
				}
				if (outcomes.length > 0) {
					await feedbackTracker.recordDetailedOutcome(outcomes);
				}
			}
			// Record feedback for previously injected skills
			const prevInjectedSkills = trace.injectedSkillNames;
			if (prevInjectedSkills && prevInjectedSkills.length > 0 && feedbackTracker) {
				const succeeded = trace.completedSuccessfully && trace.errorCount === 0;
				await feedbackTracker.recordSkillOutcome(prevInjectedSkills, trace);
				if (succeeded && skillManager) {
					for (const name of prevInjectedSkills) {
						await skillManager.recordSkillUsage(name, true);
					}
				}
			}

			// Extract skill if significant (enhanced with causal diagnosis)
			if (extractor) {
				const extracted = await extractor.extract(
					trace,
					{
						skillThreshold: flags.skillThreshold,
						llmRefinement: flags.llmRefinement,
						model: ctx.model,
					},
					diagnosis ?? undefined,
				);
				if (extracted && skillManager) {
					await skillManager.integrate(extracted, ctx.model);
				}
			}

			// Check convention compliance for injected conventions
			const prevInjectedConventions = trace.injectedConventionIds;
			if (
				prevInjectedConventions &&
				prevInjectedConventions.length > 0 &&
				conventionComplianceChecker &&
				conventionStore &&
				conventionFeedbackStore
			) {
				const injectedConventions = [];
				for (const id of prevInjectedConventions) {
					const c = await conventionStore.get(id);
					if (c) injectedConventions.push(c);
				}
				if (injectedConventions.length > 0) {
					const feedback = conventionComplianceChecker.check(trace, injectedConventions);
					for (const fb of feedback) {
						await conventionFeedbackStore.record(fb);
						if (!fb.complied) {
							// Update convention stats to reflect violation
							await conventionStore.updateStats(fb.conventionId, false, true);
						}
					}
					const violations = feedback.filter(f => !f.complied);
					if (violations.length > 0) {
						await activityLogger?.log("conventions_violated", {
							sessionId: trace.sessionId,
							count: violations.length,
							conventionIds: violations.map(v => v.conventionId),
						});
					}
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
			const persona = await new FilePersonaStore().load();
			const episodes = await contextAwareRetriever.retrieve(event.prompt, {
				maxEpisodes: flags.maxEpisodes,
				llmRerank: flags.llmRerank,
				model: ctx.model,
				currentIntent: intentResult?.intent,
				profile: profile ?? undefined,
			});
			const relevantSkills = await _retrieveRelevantSkills(event.prompt);
			const conventions = ((await conventionStore?.listAll()) ?? [])
				.filter(c => c.confidence >= 60)
				.sort((a, b) => b.confidence - a.confidence)
				.slice(0, 10);
			if (episodes.length === 0 && relevantSkills.length === 0 && conventions.length === 0 && !profile && !persona)
				return;

			// Track injected episodes for feedback
			recorder?.setInjectedEpisodes(episodes.map(e => e.episode.id));
			await feedbackTracker?.trackInjection(episodes.map(e => e.episode.id));

			// Track injected skills for feedback
			recorder?.setInjectedSkills(relevantSkills.map(s => s.name));
			await feedbackTracker?.trackSkillInjection(relevantSkills.map(s => s.name));

			// Track injected conventions for compliance checking
			recorder?.setInjectedConventions(conventions.map(c => c.id));

			// Cross-session nudge analysis
			const crossNudge = await crossSessionNudgeEngine?.analyze(ctx.cwd, event.prompt);
			if (crossNudge && ctx.hasUI) {
				ctx.ui.notify(
					`[Cross-Session ${crossNudge.severity === "warn" ? "Warning" : "Tip"}] ${crossNudge.message}\nSuggestion: ${crossNudge.suggestion}`,
					crossNudge.severity === "warn" ? "warning" : "info",
				);
				// Record cross-session nudge to history for feedback loop
				await nudgeHistoryStore?.insert({
					id: `${ctx.sessionManager.getSessionId()}-${crossNudge.type}-${Date.now()}`,
					sessionId: ctx.sessionManager.getSessionId(),
					project: ctx.cwd,
					type: crossNudge.type,
					severity: crossNudge.severity,
					message: crossNudge.message,
					suggestion: crossNudge.suggestion,
					detectedAt: Date.now(),
				});
			}
			// Build injection using formatter
			let injection = "";
			if (injectionFormatter) {
				injection = injectionFormatter.formatInjection(
					episodes,
					conventions,
					relevantSkills,
					profile ?? undefined,
					persona ?? undefined,
				);
			} else {
				// Fallback: old inline formatting
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
				if (injection.length > 2000) {
					injection = injection.slice(0, 2000);
				}
			}

			if (!injection) return;

			await activityLogger?.log("prompt_injected", {
				sessionId: ctx.sessionManager.getSessionId(),
				episodeIds: episodes.map(e => e.episode.id),
				skillNames: relevantSkills.map(s => s.name),
				conventionCount: conventions.length,
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
			traceAnalyzer = undefined;
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
			conventionStore = undefined;
			conventionExtractor = undefined;
			effectivenessAnalyzer = undefined;
			injectionFormatter = undefined;
			errorPatternExtractor = undefined;
			diagnosisStore = undefined;
			detailedOutcomeStore = undefined;

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
