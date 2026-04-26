import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { TSchema } from "@sinclair/typebox";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { Theme } from "../modes/theme/theme";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import type { ToolSession } from "../tools/index";
import { formatBytes, formatDuration } from "../tools/render-utils";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { commitDirtyRepos } from "./auto-commit";
import { discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import { resolveIsolationBackendForTaskExecution } from "./isolation-backend";
import { resolveTaskIsolation, resolveTaskMergeMode } from "./orchestrator-mode";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { getTaskSimpleModeCapabilities, type TaskSimpleMode } from "./simple-mode";
import { renderTemplate } from "./template";
import {
	type AgentDefinition,
	type AgentProgress,
	getTaskSchema,
	type SingleResult,
	type TaskParams,
	type TaskToolDetails,
} from "./types";
import {
	applyBaseline,
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupProjfsOverlay,
	cleanupReflinkSnapshot,
	cleanupTaskBranches,
	cleanupWorktree,
	commitDeltaToBranch,
	ensureProjfsOverlay,
	ensureReflinkSnapshot,
	ensureWorktree,
	getOutermostRepoRoot,
	getRepoRoot,
	mergeSingleBranch,
	type NestedRepoPatch,
	type WorktreeBaseline,
	writeBranchDeltaArtifacts,
} from "./worktree";

/**
 * Commit dirty state in the parent worktree before an isolated task is dispatched.
 *
 * Without this step, `mergeSingleBranch` must stash the orchestrator's uncommitted edits
 * around the cherry-pick and pop them afterwards — a stash pop that overlaps the task's delta
 * fails and preserves the task branch for manual reconciliation. Committing first eliminates
 * the race entirely.
 *
 * Failures are logged but do not abort dispatch: the cherry-pick path still works on a dirty
 * parent (it just has a stash-pop failure mode we now mostly avoid). Missing modelRegistry is
 * logged and skipped so tests and sessions without a model can still dispatch tasks.
 */
async function autoCommitBeforeTask(repoRoot: string, session: ToolSession): Promise<void> {
	if (!session.modelRegistry) {
		logger.debug("autoCommitBeforeTask: no model registry; skipping pre-task auto-commit", { repoRoot });
		return;
	}
	try {
		const entries = await commitDirtyRepos({
			cwd: repoRoot,
			modelRegistry: session.modelRegistry,
			settings: session.settings,
			sessionId: session.getSessionId?.() ?? undefined,
		});
		const committed = entries.filter(e => e.status === "committed");
		const failed = entries.filter(e => e.status === "failed");
		if (committed.length > 0) {
			logger.debug("autoCommitBeforeTask: committed parent dirty state", {
				repos: committed.map(e => ({ path: e.repoPath, sha: e.sha, files: e.filesChanged })),
			});
		}
		if (failed.length > 0) {
			logger.warn("autoCommitBeforeTask: some repos failed to commit; proceeding with dispatch", {
				failures: failed.map(e => ({ path: e.repoPath, error: e.error })),
			});
		}
	} catch (err) {
		logger.warn("autoCommitBeforeTask: unable to pre-commit parent dirty state; proceeding", {
			repoRoot,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

/**
 * Apply a single task's nested-repo patches against the parent checkout.
 * Each patch is attempted independently so that a failure in one nested repo
 * does not block siblings. Returns a concise error message when any patch
 * failed — the caller attaches it to the owning task's `error`.
 */
async function applyTaskNestedPatches(
	repoRoot: string,
	taskId: string,
	description: string | undefined,
	patches: NestedRepoPatch[],
	commitMsg?: (diff: string) => Promise<string | null>,
): Promise<string | undefined> {
	const tagged = patches.map(np => ({ ...np, taskId, description }));
	const result = await applyNestedPatches(repoRoot, tagged, commitMsg);
	if (result.failed.length === 0) return undefined;
	const details = result.failed.map(o => `${o.patch.relativePath}: ${o.error ?? "unknown"}`).join("; ");
	const plural = result.failed.length === 1 ? "" : "es";
	return `Nested repo patch${plural} failed: ${details}. Reconcile manually in the main session.`;
}

/**
 * Render the tool description from a cached agent list and current settings.
 */
function renderDescription(
	agents: AgentDefinition[],
	maxConcurrency: number,
	isolationEnabled: boolean,
	asyncEnabled: boolean,
	disabledAgents: string[],
	simpleMode: TaskSimpleMode,
	branchMode: boolean,
): string {
	const filteredAgents = disabledAgents.length > 0 ? agents.filter(a => !disabledAgents.includes(a.name)) : agents;
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	return prompt.render(taskDescriptionTemplate, {
		agents: filteredAgents,
		MAX_CONCURRENCY: maxConcurrency,
		isolationEnabled,
		asyncEnabled,
		contextEnabled,
		customSchemaEnabled,
		defaultMode: simpleMode === "default",
		schemaFreeMode: simpleMode === "schema-free",
		independentMode: simpleMode === "independent",
		branchMode,
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

function validateTaskModeParams(simpleMode: TaskSimpleMode, params: TaskParams): string | undefined {
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	const disallowedFields: string[] = [];
	if (!contextEnabled && params.context !== undefined) {
		disallowedFields.push("context");
	}
	if (!customSchemaEnabled && params.schema !== undefined) {
		disallowedFields.push("schema");
	}
	if (disallowedFields.length === 0) {
		return undefined;
	}

	if (simpleMode === "schema-free") {
		return "task.simple is set to schema-free, so the task tool does not accept `schema`. Remove it and rely on the selected agent definition or inherited session schema.";
	}

	if (disallowedFields.length === 1) {
		return `task.simple is set to independent, so the task tool does not accept \`${disallowedFields[0]}\`. Put everything the subagent needs inside each task assignment.`;
	}

	return "task.simple is set to independent, so the task tool does not accept `context` or `schema`. Put all required background and output expectations inside each task assignment or the selected agent definition.";
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Requires async initialization to discover available agents.
 * Use `TaskTool.create(session)` to instantiate.
 */
export class TaskTool implements AgentTool<TSchema, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly label = "Task";
	readonly strict = true;
	readonly renderResult = renderResult;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;

	get parameters(): TSchema {
		const isolationEnabled = this.session.settings.get("task.isolation.mode") !== "none";
		return getTaskSchema({
			isolationEnabled,
			simpleMode: this.#getTaskSimpleMode(),
			orchestratorMode: this.session.orchestratorMode === true,
			taskDepth: this.session.taskDepth ?? 0,
		});
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(args as TaskParams, options, theme);
	}

	/** Dynamic description that reflects current disabled-agent settings */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const orchestratorMode = this.session.orchestratorMode === true;
		// Branch mode activates for top-level orchestrator sessions. In this mode,
		// each task's changes land as a dedicated git commit rather than a patch artifact.
		const branchMode =
			resolveTaskMergeMode({
				configuredMode: this.session.settings.get("task.isolation.merge"),
				orchestratorMode,
				taskDepth: 0,
			}) === "branch";
		return renderDescription(
			this.#discoveredAgents,
			maxConcurrency,
			!orchestratorMode && isolationMode !== "none",
			this.session.settings.get("async.enabled"),
			disabledAgents,
			this.#getTaskSimpleMode(),
			branchMode,
		);
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	#getTaskSimpleMode(): TaskSimpleMode {
		return this.session.settings.get("task.simple");
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgents(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		_toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params = rawParams as TaskParams;
		const simpleMode = this.#getTaskSimpleMode();
		const validationError = validateTaskModeParams(simpleMode, params);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const taskItems = params.tasks ?? [];
		const asyncEnabled = this.session.settings.get("async.enabled");
		const selectedAgent = this.#discoveredAgents.find(agent => agent.name === params.agent);
		if (!asyncEnabled || selectedAgent?.blocking === true) {
			return this.#executeSync(_toolCallId, params, signal, onUpdate);
		}
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is enabled but no async job manager is available." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}
		if (taskItems.length === 0) {
			return this.#executeSync(_toolCallId, params, signal, onUpdate);
		}

		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const uniqueIds = await outputManager.allocateBatch(taskItems.map(t => t.id));
		const fallbackAgentSource =
			this.#discoveredAgents.find(agent => agent.name === params.agent)?.source ?? "bundled";
		const { contextEnabled } = getTaskSimpleModeCapabilities(simpleMode);
		const sharedContext = contextEnabled ? params.context : undefined;
		const renderedTasks = taskItems.map(taskItem => renderTemplate(sharedContext, taskItem, simpleMode));
		const progressByTaskId = new Map<string, AgentProgress>();
		for (let index = 0; index < renderedTasks.length; index++) {
			const renderedTask = renderedTasks[index];
			progressByTaskId.set(renderedTask.id, {
				index,
				id: renderedTask.id,
				agent: params.agent,
				agentSource: fallbackAgentSource,
				status: "pending",
				task: renderedTask.task,
				assignment: renderedTask.assignment,
				description: renderedTask.description,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
			});
		}

		const _startedJobs: Array<{ jobId: string; taskId: string }> = [];
		const _failedSchedules: string[] = [];
		const _completedJobs = 0;
		const _failedJobs = 0;

		const getProgressSnapshot = (): AgentProgress[] => {
			return Array.from(progressByTaskId.values())
				.sort((a, b) => a.index - b.index)
				.map(progress => structuredClone(progress));
		};

		const buildAsyncDetails = (
			state: "running" | "completed" | "failed",
			jobId: string,
			totalDurationMs = 0,
		): TaskToolDetails => ({
			projectAgentsDir: null,
			results: [],
			totalDurationMs,
			progress: getProgressSnapshot(),
			async: { state, jobId, type: "task" },
		});
		const batchLabel = `${params.agent} (${taskItems.length} task${taskItems.length === 1 ? "" : "s"})`;

		let batchJobId = "task";
		try {
			batchJobId = manager.register(
				"task",
				batchLabel,
				async ({ jobId, signal: runSignal, reportProgress }) => {
					const result = await this.#executeSync(
						_toolCallId,
						params,
						runSignal,
						async update => {
							const text = update.content.find(part => part.type === "text")?.text ?? "Running task batch...";
							const details =
								(update.details as TaskToolDetails | undefined) ?? buildAsyncDetails("running", jobId);
							await reportProgress(text, details as unknown as Record<string, unknown>);
						},
						uniqueIds,
					);
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					return finalText;
				},
				{
					onProgress: (text, details) => {
						const progressDetails =
							(details as TaskToolDetails | undefined) ?? buildAsyncDetails("running", batchJobId);
						onUpdate?.({ content: [{ type: "text", text }], details: progressDetails });
					},
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Failed to start background task batch: ${message}` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 0,
					progress: getProgressSnapshot(),
				},
			};
		}

		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Launching background task batch with ${taskItems.length} task${taskItems.length === 1 ? "" : "s"}...`,
				},
			],
			details: buildAsyncDetails("running", batchJobId),
		});

		return {
			content: [
				{
					type: "text",
					text: `Started background task batch using ${params.agent} (${taskItems.length} task${taskItems.length === 1 ? "" : "s"}). Results will be delivered when complete.`,
				},
			],
			details: buildAsyncDetails("running", batchJobId),
		};
	}

	async #executeSync(
		_toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedIds?: string[],
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const { agent: agentName, context, schema: outputSchema } = params;
		const simpleMode = this.#getTaskSimpleMode();
		const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
		const sharedContext = contextEnabled ? context : undefined;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		// Nested tasks (depth > 0) cannot open a fresh isolation layer on top of their parent;
		// the schema hides the field there, but ignore a stray argument defensively as well.
		const isolationRequested =
			(this.session.taskDepth ?? 0) === 0 && "isolated" in params ? params.isolated === true : false;
		const timeout = (params as { timeout?: number }).timeout;
		let isIsolated = false;
		const taskDepth = this.session.taskDepth ?? 0;
		const mergeMode = resolveTaskMergeMode({
			configuredMode: this.session.settings.get("task.isolation.merge"),
			orchestratorMode: this.session.orchestratorMode === true,
			taskDepth,
		});
		const commitStyle = this.session.settings.get("task.isolation.commits");
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");

		// Validate agent exists
		let agent = getAgent(agents, agentName);
		if (!agent) {
			const available = agents.map(a => a.name).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Unknown agent "${agentName}". Available: ${available}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		// Check if agent is disabled in settings
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		if (disabledAgents.length > 0 && disabledAgents.includes(agentName)) {
			const enabled = agents.filter(a => !disabledAgents.includes(a.name)).map(a => a.name);
			return {
				content: [
					{
						type: "text",
						text: `Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const planModeState = this.session.getPlanModeState?.();
		const planModeTools = ["read", "grep", "find", "ls", "lsp", "web_search"];
		const effectiveAgent: typeof agent = planModeState?.enabled
			? {
					...agent,
					systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
					tools: planModeTools,
					spawns: undefined,
				}
			: agent;
		agent = effectiveAgent;
		const { taskIsolationMode } = resolveTaskIsolation({
			configuredMode: isolationMode,
			isolationRequested,
			orchestratorMode: this.session.orchestratorMode === true,
			agent: effectiveAgent,
			taskDepth,
		});
		if (taskIsolationMode === "none" && isolationRequested) {
			return {
				content: [
					{
						type: "text",
						text: "Task isolation is disabled. Remove the isolated argument or set task.isolation.mode to 'worktree', 'reflink', or 'fuse-projfs'.",
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}
		isIsolated = taskIsolationMode !== "none";

		// Apply per-agent model override from settings (highest priority)
		const agentModelOverrides = this.session.settings.get("task.agentModelOverrides");
		const settingsModelOverride = agentModelOverrides[agentName];
		const modelOverride = resolveAgentModelPatterns({
			settingsOverride: settingsModelOverride,
			agentModel: effectiveAgent.model,
			settings: this.session.settings,
			activeModelPattern: this.session.getActiveModelString?.(),
			fallbackModelPattern: this.session.getModelString?.(),
		});
		const thinkingLevelOverride = effectiveAgent.thinkingLevel;

		// Output schema priority: task call > agent frontmatter > inherited parent session.
		// task.simple can disable the task-call override while leaving agent/session schemas intact.
		const effectiveOutputSchema = customSchemaEnabled
			? (outputSchema ?? effectiveAgent.output ?? this.session.outputSchema)
			: (effectiveAgent.output ?? this.session.outputSchema);

		// Handle empty or missing tasks
		if (!params.tasks || params.tasks.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: contextEnabled
							? "No tasks provided. Use: { agent, context?, tasks: [{ id, description, assignment }, ...] }"
							: "No tasks provided. Use: { agent, tasks: [{ id, description, assignment }, ...] }",
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const tasks = params.tasks;
		const missingTaskIndexes: number[] = [];
		const idIndexes = new Map<string, number[]>();

		for (let i = 0; i < tasks.length; i++) {
			const id = tasks[i]?.id;
			if (typeof id !== "string" || id.trim() === "") {
				missingTaskIndexes.push(i);
				continue;
			}
			const normalizedId = id.toLowerCase();
			const indexes = idIndexes.get(normalizedId);
			if (indexes) {
				indexes.push(i);
			} else {
				idIndexes.set(normalizedId, [i]);
			}
		}

		const duplicateIds: Array<{ id: string; indexes: number[] }> = [];
		for (const [normalizedId, indexes] of idIndexes.entries()) {
			if (indexes.length > 1) {
				duplicateIds.push({
					id: tasks[indexes[0]]?.id ?? normalizedId,
					indexes,
				});
			}
		}

		if (missingTaskIndexes.length > 0 || duplicateIds.length > 0) {
			const problems: string[] = [];
			if (missingTaskIndexes.length > 0) {
				problems.push(`Missing task ids at indexes: ${missingTaskIndexes.join(", ")}`);
			}
			if (duplicateIds.length > 0) {
				const details = duplicateIds.map(entry => `${entry.id} (indexes ${entry.indexes.join(", ")})`).join("; ");
				problems.push(`Duplicate task ids detected (case-insensitive): ${details}`);
			}
			return {
				content: [{ type: "text", text: `Invalid tasks: ${problems.join(". ")}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		let repoRoot: string | null = null;
		let baseline: WorktreeBaseline | null = null;
		let effectiveIsolationMode = taskIsolationMode;
		let isolationBackendWarning = "";
		if (isIsolated) {
			try {
				repoRoot = await getRepoRoot(this.session.cwd);
				const resolvedIsolation = await resolveIsolationBackendForTaskExecution(
					taskIsolationMode,
					isIsolated,
					repoRoot,
				);
				effectiveIsolationMode = resolvedIsolation.effectiveIsolationMode;
				isolationBackendWarning = resolvedIsolation.warning;
				// Worktree isolation covers the outermost enclosing git root so the
				// worktree spans the full workspace (e.g. Cargo/npm workspaces).
				// Overlay modes mount from the immediate git root only.
				if (effectiveIsolationMode === "worktree") {
					repoRoot = await getOutermostRepoRoot(this.session.cwd);
				}
				// Commit any dirty state in the parent worktree before capturing the baseline.
				// Cherry-picking a task branch onto a dirty parent has to stash + pop — and when the
				// task's delta touches the same lines as the dirty state, stash pop conflicts. Baselining
				// from a committed HEAD collapses that hazard: cherry-pick lands on clean parent and the
				// subagent's changes end up in a distinct commit, on top of the orchestrator's commit.
				// Only top-level sessions reach this branch (nested tasks can't request isolation).
				await autoCommitBeforeTask(repoRoot, this.session);
				baseline = await captureBaseline(repoRoot);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Isolated task execution requires a git repository. ${message}`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}
		}

		// Derive artifacts directory
		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `omp-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		// Initialize progress tracking
		const progressMap = new Map<number, AgentProgress>();

		// Update callback
		const emitProgress = () => {
			const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
			onUpdate?.({
				content: [{ type: "text", text: `Running ${params.tasks.length} agents...` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress,
				},
			});
		};

		try {
			// Check self-recursion prevention
			if (this.#blockedAgent && agentName === this.#blockedAgent) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot spawn ${this.#blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Check spawn restrictions from parent
			const parentSpawns = this.session.getSessionSpawns() ?? "*";
			const allowedSpawns = parentSpawns.split(",").map(s => s.trim());
			const isSpawnAllowed = (): boolean => {
				if (parentSpawns === "") return false; // Empty = deny all
				if (parentSpawns === "*") return true; // Wildcard = allow all
				return allowedSpawns.includes(agentName);
			};

			if (!isSpawnAllowed()) {
				const allowed = parentSpawns === "" ? "none (spawns disabled for this agent)" : parentSpawns;
				return {
					content: [{ type: "text", text: `Cannot spawn '${agentName}'. Allowed: ${allowed}` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Write parent conversation context for subagents
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });
			const compactContext = this.session.getCompactContext?.();
			let contextFilePath: string | undefined;
			if (compactContext) {
				contextFilePath = path.join(effectiveArtifactsDir, "context.md");
				await Bun.write(contextFilePath, compactContext);
			}

			// Build full prompts with context prepended
			// Allocate unique IDs across the session to prevent artifact collisions
			let uniqueIds: string[];
			if (preAllocatedIds && preAllocatedIds.length === tasks.length) {
				uniqueIds = preAllocatedIds;
			} else {
				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				uniqueIds = await outputManager.allocateBatch(tasks.map(t => t.id));
			}
			const tasksWithUniqueIds = tasks.map((t, i) => ({ ...t, id: uniqueIds[i] }));

			// Build full prompts using shared context only when the current task mode allows it.
			const tasksWithContext = tasksWithUniqueIds.map(t => renderTemplate(sharedContext, t, simpleMode));
			const availableSkills = [...(this.session.skills ?? [])];
			const contextFiles = this.session.contextFiles?.filter(
				file => path.basename(file.path).toLowerCase() !== "agents.md",
			);
			const promptTemplates = this.session.promptTemplates;

			// Initialize progress for all tasks
			for (let i = 0; i < tasksWithContext.length; i++) {
				const t = tasksWithContext[i];
				progressMap.set(i, {
					index: i,
					id: t.id,
					agent: agentName,
					agentSource: agent.source,
					status: "pending",
					task: t.task,
					assignment: t.assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					durationMs: 0,
					modelOverride,
					description: t.description,
				});
			}
			emitProgress();

			// Serializes parent-repo integration across concurrent tasks. `commitToBranch`
			// and `captureDeltaPatch` operate only on the isolation dir and can run in parallel,
			// but cherry-pick / git apply / nested-patch application touch the parent repo's
			// HEAD, index, and stash — those must happen one at a time.
			const mergeLock = new Semaphore(1);
			const commitMsgFn =
				commitStyle === "ai" && this.session.modelRegistry
					? async (diff: string) =>
							generateCommitMessage(
								diff,
								this.session.modelRegistry!,
								this.session.settings,
								this.session.getSessionId?.() ?? undefined,
							)
					: undefined;
			const runTask = async (task: (typeof tasksWithContext)[number], index: number) => {
				const taskSignal =
					timeout != null && timeout > 0
						? signal
							? AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000)])
							: AbortSignal.timeout(timeout * 1000)
						: signal;
				if (!isIsolated) {
					return runSubprocess({
						cwd: this.session.cwd,
						agent,
						task: task.task,
						assignment: task.assignment,
						description: task.description,
						index,
						id: task.id,
						taskDepth,
						modelOverride,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						contextFile: contextFilePath,
						enableLsp: false,
						signal: taskSignal,
						eventBus: this.session.eventBus,
						onProgress: progress => {
							progressMap.set(index, {
								...structuredClone(progress),
							});
							emitProgress();
						},
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						settings: this.session.settings,
						mcpManager: this.session.mcpManager,
						contextFiles,
						skills: availableSkills,
						promptTemplates,
					});
				}

				const taskStart = Date.now();
				let isolationDir: string | undefined;
				try {
					if (!repoRoot || !baseline) {
						throw new Error("Isolated task execution not initialized.");
					}
					const taskBaseline = structuredClone(baseline);

					if (effectiveIsolationMode === "reflink") {
						isolationDir = await ensureReflinkSnapshot(repoRoot, task.id);
					} else if (effectiveIsolationMode === "fuse-projfs") {
						isolationDir = await ensureProjfsOverlay(repoRoot, task.id);
					} else {
						isolationDir = await ensureWorktree(repoRoot, task.id, taskBaseline.root.headCommit);
						await applyBaseline(isolationDir, taskBaseline);
					}

					const result = await runSubprocess({
						cwd: this.session.cwd,
						worktree: isolationDir,
						agent,
						task: task.task,
						assignment: task.assignment,
						description: task.description,
						index,
						id: task.id,
						taskDepth,
						modelOverride,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						contextFile: contextFilePath,
						enableLsp: false,
						signal: taskSignal,
						eventBus: this.session.eventBus,
						onProgress: progress => {
							progressMap.set(index, {
								...structuredClone(progress),
							});
							emitProgress();
						},
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						settings: this.session.settings,
						mcpManager: this.session.mcpManager,
						contextFiles,
						skills: availableSkills,
						promptTemplates,
					});

					// Surface that the agent finished but integration is still pending so the
					// TUI doesn't falsely report `completed` during the capture+merge window.
					const markMerging = () => {
						const prev = progressMap.get(index);
						if (prev) {
							progressMap.set(index, { ...prev, status: "merging" });
							emitProgress();
						}
					};
					const markMergeOutcome = (error: string | undefined) => {
						const prev = progressMap.get(index);
						if (prev) {
							progressMap.set(index, {
								...prev,
								status: error ? "merge_failed" : "completed",
							});
							emitProgress();
						}
					};
					if (isIsolated && result.exitCode === 0 && !result.aborted) markMerging();

					// Phase 1: capture the task's changes out of the isolation dir.
					// Branch mode → commit to `omp/task/<id>`. Patch mode → write a patch file.
					// Nothing here touches the parent repo's working tree, so captures can
					// run in parallel.
					let captured: SingleResult;
					if (result.exitCode === 0 && !result.aborted) {
						if (mergeMode === "branch") {
							// Capture the delta and persist it as a recovery artifact BEFORE attempting
							// the branch commit. If `git apply` succeeds but `git commit` fails (e.g. the
							// patch applied as a no-op against a drifted baseline), the captured patch on
							// disk + the partially-created `omp/task/<id>` branch are the only way to
							// recover the subagent's work. Previous behavior dropped both, silently losing
							// the entire task on any commit failure.
							let artifactPaths: string[] = [];
							try {
								const delta = await captureDeltaPatch(isolationDir, taskBaseline);
								artifactPaths = await writeBranchDeltaArtifacts(effectiveArtifactsDir, task.id, delta);
								const commitResult = await commitDeltaToBranch(
									delta,
									taskBaseline,
									task.id,
									task.description,
									commitMsgFn,
								);
								captured = {
									...result,
									branchName: commitResult?.branchName,
									nestedBranches: commitResult?.nestedBranches,
								};
							} catch (commitErr) {
								// Preserve any partially-created `omp/task/<id>` branches (root + nested)
								// for manual reconciliation; deleting them here would destroy the only
								// remaining trace of the subagent's work besides the patch artifacts.
								const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
								const recoveryHint =
									artifactPaths.length > 0
										? ` Captured delta preserved at: ${artifactPaths.join(", ")}.`
										: " No delta artifacts were written (capture failed before disk persist).";
								captured = { ...result, error: `Branch commit failed: ${msg}.${recoveryHint}` };
							}
						} else {
							try {
								const delta = await captureDeltaPatch(isolationDir, taskBaseline);
								const patchPath = path.join(effectiveArtifactsDir, `${task.id}.patch`);
								await Bun.write(patchPath, delta.rootPatch);
								captured = {
									...result,
									patchPath,
									nestedPatches: delta.nestedPatches,
								};
							} catch (patchErr) {
								const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
								captured = { ...result, error: `Patch capture failed: ${msg}` };
							}
						}
					} else {
						captured = result;
						// Recovery: preserve the subagent's in-progress work before the isolation
						// worktree is torn down in `finally`. Without this, connection hiccups or
						// user aborts silently destroy minutes/hours of subagent edits.
						if (isIsolated && isolationDir && effectiveArtifactsDir && result.aborted) {
							try {
								const delta = await captureDeltaPatch(isolationDir, taskBaseline);
								const paths = await writeBranchDeltaArtifacts(effectiveArtifactsDir, task.id, delta);
								if (paths.length > 0) {
									captured = { ...captured, recoveryArtifacts: paths };
								}
							} catch (recoveryErr) {
								const msg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
								logger.warn("Aborted-task recovery capture failed", { taskId: task.id, error: msg });
							}
						}
					}

					// Phase 2: integrate into the parent repo. Serialized because cherry-pick,
					// git apply, and stash operate on shared parent-repo state. A failure here
					// is attributed to this task only — sibling tasks still get their own attempt.
					if (isIsolated && repoRoot && captured.exitCode === 0 && !captured.aborted && !captured.error) {
						await mergeLock.acquire();
						try {
							if (mergeMode === "branch") {
								// Merge root + each nested branch independently. Preserve branches
								// on any failure so the main session can reconcile manually.
								const targets: Array<{ repo: string; branchName: string; label: string }> = [];
								if (captured.branchName) {
									targets.push({ repo: repoRoot, branchName: captured.branchName, label: "root" });
								}
								for (const nb of captured.nestedBranches ?? []) {
									targets.push({
										repo: path.join(repoRoot, nb.relativePath),
										branchName: nb.branchName,
										label: nb.relativePath,
									});
								}
								const preserved: string[] = [];
								const conflicts: string[] = [];
								const aggressiveMerges: Array<{ label: string; files: string[] }> = [];
								for (const t of targets) {
									const merged = await mergeSingleBranch(t.repo, {
										branchName: t.branchName,
										taskId: task.id,
										description: task.description,
									});
									if (merged.ok) {
										await cleanupTaskBranches(t.repo, [t.branchName]);
										if (merged.aggressive) {
											aggressiveMerges.push({ label: t.label, files: merged.aggressive.files });
										}
									} else {
										preserved.push(`\`${t.branchName}\` in ${t.label}`);
										conflicts.push(`${t.label}: ${merged.conflict ?? "unknown"}`);
									}
								}
								if (preserved.length > 0) {
									captured.error = `Branch merge failed; preserved for manual reconciliation: ${preserved.join(", ")}. Conflicts: ${conflicts.join("; ")}`;
								}
								if (aggressiveMerges.length > 0) {
									captured.aggressiveMerges = aggressiveMerges;
								}
							} else if (mergeMode === "patch" && captured.patchPath) {
								const patchText = await Bun.file(captured.patchPath).text();
								if (patchText.trim()) {
									const canApply = await git.patch.canApplyText(repoRoot, patchText);
									if (!canApply) {
										const localChangesPresent = (await git.status(repoRoot)).trim().length > 0;
										const causePart = localChangesPresent
											? " The parent working tree has local edits that conflict with this patch."
											: "";
										captured.error = `Patch could not be applied cleanly.${causePart} Patch preserved at ${captured.patchPath}.`;
									} else {
										try {
											await git.patch.applyText(repoRoot, patchText);
										} catch (err) {
											const msg = err instanceof Error ? err.message : String(err);
											logger.error("Patch apply failed despite canApply check", { error: msg });
											captured.error = `Patch apply failed: ${msg}. Patch preserved at ${captured.patchPath}.`;
										}
									}
								}
								if (!captured.error && captured.nestedPatches && captured.nestedPatches.length > 0) {
									const err = await applyTaskNestedPatches(
										repoRoot,
										task.id,
										task.description,
										captured.nestedPatches,
										commitMsgFn,
									);
									if (err) captured.error = err;
								}
							}
						} finally {
							mergeLock.release();
						}
					}

					if (isIsolated && captured.exitCode === 0 && !captured.aborted) {
						markMergeOutcome(captured.error);
					}
					return captured;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						index,
						id: task.id,
						agent: agent.name,
						agentSource: agent.source,
						task: task.task,
						assignment: task.assignment,
						description: task.description,
						exitCode: 1,
						output: "",
						stderr: message,
						truncated: false,
						durationMs: Date.now() - taskStart,
						tokens: 0,
						modelOverride,
						error: message,
					};
				} finally {
					if (isolationDir) {
						try {
							if (effectiveIsolationMode === "reflink") {
								await cleanupReflinkSnapshot(isolationDir);
							} else if (effectiveIsolationMode === "fuse-projfs") {
								await cleanupProjfsOverlay(isolationDir);
							} else {
								await cleanupWorktree(isolationDir);
							}
						} catch (cleanupErr) {
							const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
							logger.warn("Worktree cleanup failed", { isolationDir, error: msg });
						}
					}
				}
			};

			// Execute in parallel with concurrency limit
			const { results: partialResults, aborted } = await mapWithConcurrencyLimit(
				tasksWithContext,
				maxConcurrency,
				runTask,
				signal,
			);

			// Fill in skipped tasks (undefined entries from abort) with placeholder results
			const results: SingleResult[] = partialResults.map((result, index) => {
				if (result !== undefined) {
					return result;
				}
				const task = tasksWithContext[index];
				return {
					index,
					id: task.id,
					agent: agentName,
					agentSource: agent.source,
					task: task.task,
					assignment: task.assignment,
					description: task.description,
					exitCode: 1,
					output: "",
					stderr: "Skipped (cancelled before start)",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					modelOverride,
					error: "Cancelled before start",
					aborted: true,
					abortReason: "Cancelled before start",
				};
			});

			// Aggregate usage from executor results (already accumulated incrementally)
			const aggregatedUsage = createUsageTotals();
			let hasAggregatedUsage = false;
			for (const result of results) {
				if (result.usage) {
					addUsageTotals(aggregatedUsage, result.usage);
					hasAggregatedUsage = true;
				}
			}

			// Collect output paths (artifacts already written by executor in real-time)
			const outputPaths: string[] = [];
			const patchPaths: string[] = [];
			for (const result of results) {
				if (result.outputPath) {
					outputPaths.push(result.outputPath);
				}
				if (result.patchPath) {
					patchPaths.push(result.patchPath);
				}
			}

			// Per-task merge already ran inside each `runTask` under `mergeLock`. Anything
			// that failed to integrate is recorded as `r.error` on the owning result.
			// Here we only assemble the top-level summary of preserved artifacts so the
			// main session can reconcile them manually.
			let mergeSummary = "";
			const preservedBranchTasks = results.filter(
				r =>
					r.error &&
					r.exitCode === 0 &&
					!r.aborted &&
					(r.branchName || (r.nestedBranches && r.nestedBranches.length > 0)),
			);
			const preservedPatches = results.filter(r => r.patchPath && r.error && r.exitCode === 0 && !r.aborted);
			if (preservedBranchTasks.length > 0) {
				const lines: string[] = [];
				for (const r of preservedBranchTasks) {
					const label = r.description ? `${r.id} — ${r.description}` : r.id;
					if (r.branchName) lines.push(`- ${r.branchName} in root (${label})`);
					for (const nb of r.nestedBranches ?? []) {
						lines.push(`- ${nb.branchName} in ${nb.relativePath} (${label})`);
					}
				}
				const plural = lines.length === 1 ? "" : "es";
				mergeSummary += `\n\n<system-notification>${lines.length} task branch${plural} preserved for manual reconciliation in the main session. Each owning task is marked \`merge failed\` above with its specific conflict.\nPreserved branches:\n${lines.join("\n")}</system-notification>`;
			}
			if (preservedPatches.length > 0) {
				const lines = preservedPatches.map(r => `- ${r.patchPath} (${r.id})`);
				const plural = preservedPatches.length === 1 ? "" : "es";
				mergeSummary += `\n\n<system-notification>${preservedPatches.length} patch${plural} preserved for manual review. Each owning task is marked \`merge failed\` above.\nPatch artifacts:\n${lines.join("\n")}</system-notification>`;
			}
			const aggressiveTasks = results.filter(r => r.aggressiveMerges && r.aggressiveMerges.length > 0);
			if (aggressiveTasks.length > 0) {
				const lines: string[] = [];
				for (const r of aggressiveTasks) {
					const label = r.description ? `${r.id} — ${r.description}` : r.id;
					for (const entry of r.aggressiveMerges ?? []) {
						const files = entry.files.length > 0 ? entry.files.join(", ") : "(no file list captured)";
						lines.push(`- ${label} in ${entry.label}: ${files}`);
					}
				}
				mergeSummary += `\n\n<system-notification>Aggressive merge applied: ${lines.length} repo/task pair${lines.length === 1 ? "" : "s"} had cherry-pick conflicts that were force-resolved with \`-X theirs\` (the picked branch's content won). Review these files — parallel tasks wrote divergent content and one side was silently overridden:\n${lines.join("\n")}</system-notification>`;
			}
			const recoveredTasks = results.filter(r => r.recoveryArtifacts && r.recoveryArtifacts.length > 0);
			if (recoveredTasks.length > 0) {
				const lines: string[] = [];
				for (const r of recoveredTasks) {
					const label = r.description ? `${r.id} — ${r.description}` : r.id;
					lines.push(`- ${label}: ${(r.recoveryArtifacts ?? []).join(", ")}`);
				}
				const plural = recoveredTasks.length === 1 ? "" : "s";
				mergeSummary += `\n\n<system-notification>${recoveredTasks.length} aborted task${plural} preserved as recovery patches. The isolation worktree was torn down but the in-progress edits survive on disk.\n\nRecovery patches:\n${lines.join("\n")}\n\nTo resume: dispatch a follow-up \`task\` with the **same original assignment** plus a \`## Resume\` section pointing at the patch path. Tell the subagent to \`git apply <path>\` first (the patch is against the original baseline, so it applies cleanly onto the fresh isolation worktree), then continue from where the previous attempt stopped. Do NOT restart from scratch — the patch contains the prior progress.</system-notification>`;
			}

			// Build final output - match plugin format
			const cancelledCount = results.filter(r => r.aborted).length;
			const successCount = results.filter(r => r.exitCode === 0 && !r.error && !r.aborted).length;
			const totalDuration = Date.now() - startTime;

			const summaries = results.map(r => {
				const status = r.aborted
					? "cancelled"
					: r.exitCode === 0 && r.error
						? "merge failed"
						: r.exitCode === 0
							? "completed"
							: `failed (exit ${r.exitCode})`;
				const output = r.output.trim() || r.stderr.trim() || "(no output)";
				const outputCharCount = r.outputMeta?.charCount ?? output.length;
				const fullOutputThreshold = 5000;
				let preview = output;
				let truncated = false;
				if (outputCharCount > fullOutputThreshold) {
					const slice = output.slice(0, fullOutputThreshold);
					const lastNewline = slice.lastIndexOf("\n");
					preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
					truncated = true;
				}
				return {
					agent: r.agent,
					status,
					id: r.id,
					branch: r.branchName,
					errorDetail: r.exitCode === 0 && r.error ? r.error : undefined,
					preview,
					truncated,
					meta: r.outputMeta
						? {
								lineCount: r.outputMeta.lineCount,
								charSize: formatBytes(r.outputMeta.charCount),
							}
						: undefined,
				};
			});

			const outputIds = results.filter(r => !r.aborted || r.output.trim()).map(r => `agent://${r.id}`);
			const backendSummaryPrefix = isolationBackendWarning ? `\n\n${isolationBackendWarning}` : "";
			const summary = prompt.render(taskSummaryTemplate, {
				successCount,
				totalCount: results.length,
				cancelledCount,
				hasCancelledNote: aborted && cancelledCount > 0,
				duration: formatDuration(totalDuration),
				summaries,
				outputIds,
				agentName,
				mergeSummary: `${backendSummaryPrefix}${mergeSummary}`,
			});

			// Cleanup temp directory if used
			// Keep the temp artifacts dir if any isolated task left a preserved patch;
			// the patch path inside points into this dir and the main session needs it.
			const hasPreservedPatchArtifact = isIsolated && preservedPatches.length > 0;
			const shouldCleanupTempArtifacts = tempArtifactsDir && !hasPreservedPatchArtifact;
			if (shouldCleanupTempArtifacts) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			return {
				content: [{ type: "text", text: summary }],
				details: {
					projectAgentsDir,
					results: results,
					totalDurationMs: totalDuration,
					usage: hasAggregatedUsage ? aggregatedUsage : undefined,
					outputPaths,
				},
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}
	}
}
