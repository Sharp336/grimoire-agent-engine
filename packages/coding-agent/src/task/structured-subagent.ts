/**
 * Shared policy resolution and execution for task and eval subagents.
 *
 * The two public frontends deliberately retain their presentation concerns, but
 * every decision that affects what a child may run lives here.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { $env, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { resolveAgentModelSelection } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { MCPManager } from "../mcp/manager";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { TaskEffort } from "../thinking";
import type { ToolSession } from "../tools";
import { isIrcEnabled } from "../tools/hub";
import { buildOutputValidator } from "../tools/output-schema-validator";
import { trackLateCleanup } from "../utils/late-cleanup";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { type ExecutorOptions, runSubprocess } from "./executor";
import {
	applyEligibleNestedPatches,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "./isolation-runner";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { classifyContractFailure } from "./routing/contract-failure";
import { routeWorker } from "./routing/router";
import { seededRandom } from "./routing/select";
import {
	buildRoutingSnapshot,
	getRoutingPolicyFromSettings,
	resolveParentPoolIdentity,
	resolveProviderPool,
	selectorProvider,
} from "./routing/snapshot";
import type {
	ResourcePoolIdentity,
	RoutingCandidateInput,
	RoutingDecision,
	RoutingPolicy,
	RoutingRequest,
	RoutingRequirements,
} from "./routing/types";
import { resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	type RoutingIntent,
	type SingleResult,
	type StructuredSubagentOutput,
	type TaskRoutingOptions,
} from "./types";
import { type NestedRepoPatch, parseIsolationMode } from "./worktree";
/** Validation behavior requested for an effective output schema. */
export type StructuredSubagentSchemaMode = "permissive" | "strict";

/** Where an effective output schema came from. */
export type StructuredSubagentSchemaSource = "caller" | "agent" | "session" | "none";

/** Final structured completion metadata returned for a schema-bearing run. */
export type StructuredSubagentSchemaResult = StructuredSubagentOutput;

/** A schema validation or extraction error attached to structured completion metadata. */
export type StructuredSubagentSchemaError = NonNullable<StructuredSubagentOutput["error"]>;

/** A selected schema paired with its source and enforcement mode. */
export interface StructuredSubagentSchemaResolution {
	schema: unknown;
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	outputSchemaOverridesAgent: boolean;
}

/** Isolation controls shared by the task and eval surfaces. */
export interface StructuredSubagentIsolationControls {
	requested?: boolean;
	merge?: "patch" | "branch";
	apply?: boolean;
}

/** Identity and presentation metadata supplied by the calling surface. */
export interface StructuredSubagentIdentity {
	/** A previously reserved output/registry id. */
	id?: string;
	/** Stable user-facing label used when allocating a new id. */
	label?: string;
}

/** One normalized child invocation. */
export interface StructuredSubagentRequest {
	session: ToolSession;
	invocationKind: "task" | "eval";
	assignment: string;
	context?: string;
	agent?: string;
	model?: string | string[];
	/** Presence, rather than truthiness, makes this the highest-priority schema. */
	outputSchema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	/** Per-spawn thinking effort mapped onto the resolved model's supported range; overrides the agent's default selector. */
	effort?: TaskEffort;
	identity?: StructuredSubagentIdentity;
	index?: number;
	parentToolCallId?: string;
	detached?: boolean;
	invokedAt?: number;
	acquiredAt?: number;
	isolation?: StructuredSubagentIsolationControls;
	/** The parent agent name forbidden from recursively spawning itself. */
	blockedAgent?: string;
	/** Preserve a completed temporary artifacts directory for an agent:// handle. */
	retainArtifacts?: boolean;
	/** Task UI agents keep live registry references; eval one-shots normally do not. */
	keepAlive?: boolean;
	/** Task subagents share their parent's eval kernel; eval bridge children must not. */
	shareEvalSession?: boolean;
	/** Task frontends may inherit LSP; eval frontends normally set this false. */
	enableLsp?: boolean;
	/** Explicitly pass false for plan mode or invocation kinds that must not use IRC. */
	enableIrc?: boolean;
	/** `0` disables executor wall-clock timeout. Undefined inherits settings. */
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	/** Routing intent for this spawn (per-item override). */
	intent?: RoutingIntent;
	/** Batch-level routing constraints for this spawn. */
	routing?: TaskRoutingOptions;
	/** Sibling pool keys already chosen for in-flight siblings. */
	siblingPools?: readonly string[];
	/** Exact selectors that 404'd earlier this run — must be suppressed. */
	deadSelectors?: readonly string[];
}
/** A normalized preflight result, reusable by tests and adapters. */
export interface EffectiveSubagentPolicy {
	discovery: DiscoveryResult;
	agentName: string;
	agent: AgentDefinition;
	effectiveAgent: AgentDefinition;
	modelOverride?: string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	parentActiveModelPattern?: string;
	schema: StructuredSubagentSchemaResolution;
	planMode: boolean;
	isIsolated: boolean;
	mergeMode: "patch" | "branch";
	applyChanges: boolean;
	enableLsp: boolean;
	enableIrc: boolean;
	/** Routing intent resolved for this spawn. */
	routingIntent?: RoutingIntent;
	/** Resource pool label chosen by routing (human readable). */
	resourcePool?: string;
	/** Pool key for sibling diversity (provider\0baseUrl\0accountKey). */
	routingPoolKey?: string;
	/** Concise routing reason for normal UI. */
	routingReason?: string;
	/** Whether parent-pool anti-affinity was applied. */
	routingAntiAffinity?: boolean;
	/** Whether chosen pool is parent pool despite avoidParentPool. */
	routingParentPoolFallback?: boolean;
	/** Whether usage/headroom influenced selection. */
	routingUsageInfluenced?: boolean;
	/** Why routing was bypassed (explicit pin / operator override). */
	routingBypassReason?: string;
	/** Bounded contract-reroute history. */
	routingReroutes?: { from: string; to: string; reason: string }[];
	/** Full routing decision for reroute logic (not surfaced directly). */
	routingDecision?: RoutingDecision;
	/** Candidate inputs used for routing (for reroute peer lookup). */
	routingCandidates?: RoutingCandidateInput[];
	/** Parent pool identity used for routing. */
	routingParentPool?: ResourcePoolIdentity;
}

/** Settled child execution plus data needed by the frontends' own rendering. */
export interface StructuredSubagentResult {
	result: SingleResult;
	policy: EffectiveSubagentPolicy;
	mergeSummary: string;
	changesApplied: boolean | null;
	artifactsDir: string;
	temporaryArtifacts: boolean;
}

/** Machine-readable failure category so adapters can retain their native errors. */
export class StructuredSubagentError extends Error {
	readonly kind: "preflight" | "isolation" | "execution";

	constructor(kind: "preflight" | "isolation" | "execution", message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StructuredSubagentError";
		this.kind = kind;
	}
}

const PLAN_MODE_TOOLS = ["read", "grep", "glob", "web_search"] as const;

function renderSubagentPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, { assignment: assignment.trim() });
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function sanitizeAgentId(value: string | undefined): string | undefined {
	const trimmed = trimToUndefined(value);
	const sanitized = trimmed?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || undefined;
}

function resolveSchema(request: StructuredSubagentRequest, agent: AgentDefinition): StructuredSubagentSchemaResolution {
	const mode = request.schemaMode ?? request.session.outputSchemaMode ?? "permissive";
	if (Object.hasOwn(request, "outputSchema")) {
		return { schema: request.outputSchema, source: "caller", mode, outputSchemaOverridesAgent: true };
	}
	if (agent.output !== undefined) {
		return { schema: agent.output, source: "agent", mode, outputSchemaOverridesAgent: false };
	}
	if (request.session.outputSchema !== undefined) {
		return { schema: request.session.outputSchema, source: "session", mode, outputSchemaOverridesAgent: false };
	}
	return { schema: undefined, source: "none", mode, outputSchemaOverridesAgent: false };
}

function createPlanModeAgent(agent: AgentDefinition): AgentDefinition {
	const tools = [...PLAN_MODE_TOOLS, ...(agent.tools ?? []).filter(tool => tool === "ast_grep")];
	return {
		...agent,
		systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
		tools,
		spawns: undefined,
		prewalk: undefined,
	};
}

function assertPlanControlsAllowed(request: StructuredSubagentRequest, planMode: boolean): void {
	if (!planMode) return;
	const isolation = request.isolation;
	if (
		isolation &&
		(Object.hasOwn(isolation, "requested") || Object.hasOwn(isolation, "apply") || Object.hasOwn(isolation, "merge"))
	) {
		throw new StructuredSubagentError(
			"preflight",
			"Subagent isolation, apply, and merge controls are unavailable in plan mode.",
		);
	}
}

function assertDepthAndSpawnAllowed(request: StructuredSubagentRequest, agentName: string): void {
	const taskDepth = request.session.taskDepth ?? 0;
	const maxDepth = request.session.settings.get("task.maxRecursionDepth") ?? 2;
	if (!canSpawnAtDepth(maxDepth, taskDepth)) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn another agent at task depth ${taskDepth}; maximum depth is ${maxDepth}.`,
		);
	}
	const blockedAgent = request.blockedAgent ?? $env.PI_BLOCKED_AGENT;
	if (blockedAgent && blockedAgent === agentName) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn ${blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
		);
	}
	const spawnPolicy = resolveSpawnPolicy(request.session.getSessionSpawns());
	if (!spawnPolicy.enabled || (spawnPolicy.allowedAgents !== null && !spawnPolicy.allowedAgents.includes(agentName))) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn '${agentName}'. Allowed: ${spawnPolicy.allowedErrorText}`,
		);
	}
}

/**
 * Resolve every policy shared by task and eval before allocating artifacts or
 * dispatching work. Callers translate {@link StructuredSubagentError} into
 * their own wire-level error surface.
 */
export async function resolveEffectiveSubagentPolicy(
	request: StructuredSubagentRequest,
): Promise<EffectiveSubagentPolicy> {
	const spawnPolicy = resolveSpawnPolicy(request.session.getSessionSpawns());
	const agentName = request.agent?.trim() || spawnPolicy.defaultAgent;
	const planMode = request.session.getPlanModeState?.()?.enabled === true;
	assertPlanControlsAllowed(request, planMode);
	assertDepthAndSpawnAllowed(request, agentName);

	const discovery = await discoverAgents(request.session.cwd);
	const agent = getAgent(discovery.agents, agentName);
	if (!agent) {
		const available = discovery.agents.map(candidate => candidate.name).join(", ") || "none";
		const evalModelHint =
			request.invocationKind === "eval"
				? " In eval agent(), `agent` selects a capability. If this looks like a model selector, use `model: <selector>` alongside a valid agent."
				: "";
		throw new StructuredSubagentError(
			"preflight",
			`Unknown agent "${agentName}". Available: ${available}.${evalModelHint}`,
		);
	}
	const disabledAgents = request.session.settings.get("task.disabledAgents") as string[];
	if (disabledAgents.includes(agentName)) {
		const enabled = discovery.agents
			.filter(candidate => !disabledAgents.includes(candidate.name))
			.map(candidate => candidate.name);
		throw new StructuredSubagentError(
			"preflight",
			`Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
		);
	}

	const effectiveAgent = planMode ? createPlanModeAgent(agent) : agent;
	const schema = resolveSchema(request, effectiveAgent);
	if (schema.source === "caller" || (schema.source !== "none" && schema.mode === "strict")) {
		const { error } = buildOutputValidator(schema.schema);
		if (error) {
			const scope =
				schema.source === "caller" ? (schema.mode === "strict" ? "strict caller" : "caller") : "strict effective";
			throw new StructuredSubagentError("preflight", `Invalid ${scope} output schema: ${error}`);
		}
	}
	const agentModelOverrides = request.session.settings.get("task.agentModelOverrides");
	const parentActiveModelPattern = request.session.getActiveModelString?.();
	const modelResolution = {
		requestModel: request.model,
		settingsOverride: agentModelOverrides[agentName],
		agentModel: effectiveAgent.model,
		settings: request.session.settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: request.session.getModelString?.(),
	};
	// Role identity and patterns come from one call so they cannot be derived
	// from different sources: the expansion below discards the alias, and the
	// child's inherited retry-fallback chain is keyed off the role.
	const { patterns: initialPatterns, role: modelRole } = resolveAgentModelSelection(modelResolution);
	let modelOverride: string[] | undefined = initialPatterns.length > 0 ? initialPatterns : undefined;

	// Routing intent resolution: per-item → agentIntents[agent] → "default"
	const rawIntent =
		request.intent ?? request.session.settings.get("task.routing.agentIntents")[agentName] ?? "default";
	const validIntents = new Set(["default", "cheap", "normal", "strong", "vision", "large-context", "same-pool-ok"]);
	const routingIntent: RoutingIntent = validIntents.has(rawIntent) ? (rawIntent as RoutingIntent) : "default";

	const requirements: RoutingRequirements = {};
	if (schema.source !== "none") requirements.structuredOutput = true;

	let resourcePool: string | undefined;
	let routingPoolKey: string | undefined;
	let routingReason: string | undefined;
	let routingAntiAffinity: boolean | undefined;
	let routingParentPoolFallback: boolean | undefined;
	let routingUsageInfluenced: boolean | undefined;
	let routingBypassReason: string | undefined;
	const routingReroutes: { from: string; to: string; reason: string }[] = [];
	let routingDecision: RoutingDecision | undefined;
	let routingCandidates: RoutingCandidateInput[] | undefined;
	let routingParentPool: ResourcePoolIdentity | undefined;
	// Only a per-invocation pin (`agent(..., model)` / eval bridge) bypasses the
	// router. `task.agentModelOverrides` is an agent *default*, not a hard pin:
	// treating it as one would re-bind every ordinary capability to one model and
	// defeat pool protection, so it enters routing as a preference instead.
	const hasExplicitPin =
		request.model !== undefined &&
		(Array.isArray(request.model) ? request.model.length > 0 : request.model.trim().length > 0);

	if (hasExplicitPin) {
		routingBypassReason = "explicit model pin";
		const pinSelector = modelOverride?.[0];
		const pinProvider = pinSelector === undefined ? undefined : selectorProvider(pinSelector);
		if (pinSelector && pinProvider) {
			routingParentPool = resolveParentPoolIdentity(request.session);
			const pinPool = resolveProviderPool(request.session, pinProvider);
			resourcePool = pinPool?.label;
			routingPoolKey = pinPool?.key;
			const poolSuffix = pinPool ? `${pinPool.label} pool; ` : "";
			if (pinPool !== undefined && pinPool.key === routingParentPool?.key) {
				routingParentPoolFallback = true;
				routingAntiAffinity = false;
				routingReason = `${pinSelector} (${poolSuffix}${routingBypassReason} intentionally overrides parent-pool protection)`;
			} else {
				routingReason = `${pinSelector} (${poolSuffix}${routingBypassReason})`;
			}
		}
	} else {
		const policyFromSettings = getRoutingPolicyFromSettings(request.session);
		const policy: RoutingPolicy = {
			enabled: policyFromSettings.enabled,
			avoidParentPool: policyFromSettings.avoidParentPool,
			parentPoolFallback: policyFromSettings.parentPoolFallback,
			excludePools: [...policyFromSettings.excludePools],
			preferPools: [...policyFromSettings.preferPools],
		};
		if (request.routing) {
			if (request.routing.excludePools)
				policy.excludePools = [...policy.excludePools, ...request.routing.excludePools];
			if (request.routing.preferPools) policy.preferPools = [...policy.preferPools, ...request.routing.preferPools];
			if (request.routing.allowParentPool !== undefined) {
				policy.avoidParentPool = !request.routing.allowParentPool;
				policy.parentPoolFallback = request.routing.allowParentPool ? "allow" : "deny";
			}
		}
		try {
			const snapshot = await buildRoutingSnapshot(request.session);
			routingCandidates = snapshot.candidates;
			routingParentPool = snapshot.parentPool;
			const preferredSelector = modelOverride?.[0];
			if (preferredSelector) {
				for (const cand of routingCandidates) {
					if (cand.selector === preferredSelector) {
						cand.preferredRank = 0;
						break;
					}
				}
			}
			const routingRequest: RoutingRequest = {
				agent: agentName,
				intent: routingIntent,
				requirements,
				parentPool: routingParentPool,
				siblingPools: request.siblingPools,
				deadSelectors: request.deadSelectors,
				policy,
				candidates: routingCandidates,
				// Batch preflight and dispatch each resolve routing for the same spawn;
				// seeding from fields both calls share keeps them on the same candidate.
				random: seededRandom(`${agentName}\u0000${request.assignment}`),
			};
			const outcome = routeWorker(routingRequest);
			if (!outcome.ok) {
				if (outcome.code === "routing_disabled" || outcome.code === "no_viable_candidate") {
					logger.debug("Routing fallback to configured model", {
						agent: agentName,
						reason: outcome.reason,
						trace: outcome.trace.join("; "),
					});
					routingReason = outcome.reason;
				} else if (outcome.code === "parent_pool_fail_closed") {
					logger.debug("Routing parent_pool_fail_closed", { agent: agentName, trace: outcome.trace.join("; ") });
					throw new StructuredSubagentError(
						"preflight",
						`Routing: parent pool is protected and no external candidate is viable for ${agentName} (${outcome.reason})`,
					);
				}
			} else {
				routingDecision = outcome;
				modelOverride = outcome.selectors;
				resourcePool = outcome.pool.label;
				routingPoolKey = outcome.pool.key;
				routingReason = outcome.reason;
				routingAntiAffinity = outcome.antiAffinityApplied;
				routingParentPoolFallback = outcome.parentPoolFallback;
				routingUsageInfluenced = outcome.usageInfluenced;
				logger.debug("Routing decision", {
					agent: agentName,
					reason: outcome.reason,
					trace: outcome.trace.join("; "),
				});
				if (outcome.trace.length > 0) {
					logger.debug("Routing trace", { trace: outcome.trace });
				}
			}
		} catch (error) {
			if (error instanceof StructuredSubagentError) throw error;
			logger.warn("Routing snapshot failed, falling back to configured model", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const isolationMode = request.session.settings.get("task.isolation.mode");
	const isIsolated = request.isolation?.requested === true;
	if (isIsolated && isolationMode === "none") {
		throw new StructuredSubagentError(
			"preflight",
			`Subagent isolated execution requires task.isolation.mode to be set; current mode is "none".`,
		);
	}
	return {
		discovery,
		agentName,
		agent,
		effectiveAgent,
		modelOverride,
		modelRole,
		parentActiveModelPattern,
		schema,
		planMode,
		isIsolated,
		mergeMode: request.isolation?.merge ?? request.session.settings.get("task.isolation.merge"),
		applyChanges:
			request.isolation?.apply ??
			(request.invocationKind === "task" ? request.session.settings.get("task.isolation.apply") : true),
		enableLsp:
			!planMode &&
			(request.enableLsp ?? ((request.session.enableLsp ?? true) && request.session.settings.get("task.enableLsp"))),
		enableIrc:
			!planMode &&
			(request.enableIrc ??
				(request.session.enableIrc !== false &&
					isIrcEnabled(request.session.settings, request.session.taskDepth ?? 0))),
		routingIntent,
		resourcePool,
		routingPoolKey,
		routingReason,
		routingAntiAffinity,
		routingParentPoolFallback,
		routingUsageInfluenced,
		routingBypassReason,
		routingReroutes: routingReroutes.length > 0 ? routingReroutes : undefined,
		routingDecision,
		routingCandidates,
		routingParentPool,
	};
}

/** Reserve a session-global agent id only after preflight has succeeded. */
export async function reserveStructuredSubagentId(
	session: ToolSession,
	identity: StructuredSubagentIdentity | undefined,
): Promise<string> {
	if (identity?.id) return identity.id;
	const manager = session.agentOutputManager ?? new AgentOutputManager(session.getArtifactsDir ?? (() => null));
	session.agentOutputManager ??= manager;
	return manager.allocate(sanitizeAgentId(identity?.label) ?? generateTaskName());
}

interface ArtifactLease {
	sessionFile: string | null;
	artifactsDir: string;
	temporary: boolean;
	unregister: (() => void) | undefined;
}

async function leaseArtifacts(
	session: ToolSession,
	invocationKind: StructuredSubagentRequest["invocationKind"],
): Promise<ArtifactLease> {
	const sessionFile = session.getSessionFile();
	if (sessionFile) {
		const artifactsDir = sessionFile.slice(0, -6);
		await fs.mkdir(artifactsDir, { recursive: true });
		return { sessionFile, artifactsDir, temporary: false, unregister: undefined };
	}
	const artifactsDir = path.join(
		os.tmpdir(),
		`${invocationKind === "eval" ? "omp-eval-agent" : "omp-task"}-${Snowflake.next()}`,
	);
	await fs.mkdir(artifactsDir, { recursive: true });
	return { sessionFile: null, artifactsDir, temporary: true, unregister: registerArtifactsDir(artifactsDir) };
}

function resolveAutoloadSkills(session: ToolSession, agent: AgentDefinition) {
	const skills = [...(session.skills ?? [])];
	const autoloadSkills = agent.autoloadSkills?.length
		? agent.autoloadSkills.map(name => skills.find(skill => skill.name === name)).filter(skill => skill !== undefined)
		: [];
	return { skills, autoloadSkills };
}

function buildExecutorOptions(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
	lease: ArtifactLease,
	id: string,
): ExecutorOptions {
	const { session } = request;
	const { skills, autoloadSkills } = resolveAutoloadSkills(session, policy.agent);
	const localProtocolOptions: LocalProtocolOptions = session.localProtocolOptions ?? {
		getArtifactsDir: session.getArtifactsDir ?? (() => null),
		getSessionId: session.getSessionId ?? (() => null),
	};
	const restrictToolNames = policy.planMode || session.restrictToolNames === true;
	const enableMCP = !restrictToolNames && (session.enableMCP ?? true);
	return {
		cwd: session.cwd,
		additionalDirectories: session.additionalDirectories,
		getApiKey: session.getApiKey,
		agent: policy.effectiveAgent,
		task: renderSubagentPrompt(request.assignment),
		assignment: request.assignment.trim(),
		context: request.context?.trim() || undefined,
		planReference: undefined,
		description: trimToUndefined(request.identity?.label),
		index: request.index ?? 0,
		parentToolCallId: request.parentToolCallId,
		detached: request.detached,
		id,
		taskDepth: session.taskDepth ?? 0,
		invokedAt: request.invokedAt,
		acquiredAt: request.acquiredAt,
		modelOverride: policy.modelOverride,
		modelRole: policy.modelRole,
		parentActiveModelPattern: policy.parentActiveModelPattern,
		thinkingLevel: policy.effectiveAgent.thinkingLevel,
		effort: request.effort,
		routingIntent: policy.routingIntent,
		resourcePool: policy.resourcePool,
		routingReason: policy.routingReason,
		routingAntiAffinity: policy.routingAntiAffinity,
		routingParentPoolFallback: policy.routingParentPoolFallback,
		routingUsageInfluenced: policy.routingUsageInfluenced,
		routingBypassReason: policy.routingBypassReason,
		routingReroutes: policy.routingReroutes,
		...(policy.schema.source === "none"
			? {}
			: {
					outputSchemaSource: policy.schema.source,
					outputSchema: policy.schema.schema,
					outputSchemaOverridesAgent: policy.schema.outputSchemaOverridesAgent,
					outputSchemaMode: policy.schema.mode,
				}),
		sessionFile: lease.sessionFile,
		persistArtifacts: !lease.temporary,
		artifactsDir: lease.artifactsDir,
		enableLsp: policy.enableLsp,
		enableIrc: policy.enableIrc,
		maxRuntimeMs: request.maxRuntimeMs,
		restrictToolNames,
		keepAlive: request.keepAlive,
		signal: request.signal,
		eventBus: session.eventBus,
		onProgress: request.onProgress,
		authStorage: session.authStorage,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		mcpManager: enableMCP ? (session.mcpManager ?? MCPManager.instance()) : undefined,
		enableMCP,
		contextFiles: session.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md"),
		skills,
		autoloadSkills,
		workspaceTree: session.workspaceTree,
		promptTemplates: session.promptTemplates,
		rules: session.rules,
		preloadedExtensionPaths: restrictToolNames ? [] : session.extensionPaths,
		preloadedCustomToolPaths: restrictToolNames ? [] : session.customToolPaths,
		localProtocolOptions,
		parentArtifactManager: session.getArtifactManager?.() ?? undefined,
		parentHindsightSessionState: session.getHindsightSessionState?.(),
		parentMnemopiSessionState: session.getMnemopiSessionState?.(),
		parentTelemetry: session.getTelemetry?.(),
		parentEvalSessionId: request.shareEvalSession === false ? undefined : (session.getEvalSessionId?.() ?? undefined),
		parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
		parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
	};
}

async function loadPlanReference(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
): Promise<{ path: string; content: string } | undefined> {
	if (policy.planMode) return undefined;
	const localProtocolOptions: LocalProtocolOptions = request.session.localProtocolOptions ?? {
		getArtifactsDir: request.session.getArtifactsDir ?? (() => null),
		getSessionId: request.session.getSessionId ?? (() => null),
	};
	return loadOverallPlanReference(request.session.getPlanReferencePath?.() ?? "local://PLAN.md", localProtocolOptions);
}

function buildFailureResult(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
	id: string,
	startedAt: number,
) {
	return (error: unknown): SingleResult => {
		const message = error instanceof Error ? error.message : String(error);
		return {
			index: request.index ?? 0,
			id,
			agent: policy.agent.name,
			agentSource: policy.agent.source,
			task: renderSubagentPrompt(request.assignment),
			assignment: request.assignment.trim(),
			description: trimToUndefined(request.identity?.label),
			exitCode: 1,
			output: "",
			stderr: message,
			truncated: false,
			durationMs: Date.now() - startedAt,
			tokens: 0,
			requests: 0,
			modelOverride: policy.modelOverride,
			modelRole: policy.modelRole,
			error: message,
		};
	};
}

async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: NestedRepoPatch[],
): Promise<string[]> {
	const saved: string[] = [];
	for (const [index, nestedPatch] of nestedPatches.entries()) {
		const destination = path.join(
			artifactsDir,
			`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
		);
		try {
			await fs.writeFile(destination, nestedPatch.patch);
			saved.push(destination);
		} catch {}
	}
	return saved;
}

async function isolationRecoveryHint(result: SingleResult, artifactsDir: string): Promise<string> {
	const hints: string[] = [];
	if (result.patchPath) hints.push(`Captured patch preserved at ${result.patchPath}.`);
	for (const nestedPath of await persistNestedPatches(artifactsDir, result.id, result.nestedPatches ?? [])) {
		hints.push(`Captured nested patch preserved at ${nestedPath}.`);
	}
	if (result.branchName) hints.push(`Captured branch preserved as ${result.branchName}.`);
	return hints.length > 0 ? ` ${hints.join(" ")}` : "";
}

function attachStructuredOutputMetadata(result: SingleResult, schema: StructuredSubagentSchemaResolution): void {
	if (schema.source === "none") {
		delete result.structuredOutput;
		return;
	}
	if (result.structuredOutput) return;
	let fallbackData: unknown = result.output;
	try {
		fallbackData = JSON.parse(result.output);
	} catch {}
	const output: StructuredSubagentOutput = {
		source: schema.source,
		mode: schema.mode,
		status: result.exitCode === 0 ? "valid" : "invalid",
		data: fallbackData,
		...(result.error ? { error: result.error } : {}),
	};
	result.structuredOutput = output;
}

/**
 * Execute a validated subagent. Preflight errors occur before any artifact
 * lease or child dispatch; callers keep responsibility for their result text.
 */
export async function runStructuredSubagent(request: StructuredSubagentRequest): Promise<StructuredSubagentResult> {
	let policy = await resolveEffectiveSubagentPolicy(request);
	const lease = await leaseArtifacts(request.session, request.invocationKind);
	let changesApplied: boolean | null = null;
	let mergeSummary = "";
	let requiresRecoveryArtifacts = false;
	let completedSuccessfully = false;
	let deferredCleanup: Promise<void> | undefined;
	try {
		const id = await reserveStructuredSubagentId(request.session, {
			...request.identity,
			label: request.identity?.label ?? (request.invocationKind === "eval" ? "EvalAgent" : undefined),
		});
		const baseOptions = buildExecutorOptions(request, policy, lease, id);
		baseOptions.onCleanupDeferred = completion => {
			deferredCleanup = completion;
		};
		baseOptions.planReference = await loadPlanReference(request, policy);
		let isolationContext: IsolationContext | null = null;
		if (policy.isIsolated) {
			try {
				isolationContext = await prepareIsolationContext(request.session.cwd);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new StructuredSubagentError(
					"isolation",
					`Isolated subagent execution requires a git repository. ${message}`,
					{ cause: error },
				);
			}
		}
		let result = !isolationContext
			? await runSubprocess(baseOptions)
			: await runIsolatedSubprocess({
					baseOptions,
					context: isolationContext,
					preferredBackend: parseIsolationMode(request.session.settings.get("task.isolation.mode")),
					agentId: id,
					mergeMode: policy.mergeMode,
					artifactsDir: lease.artifactsDir,
					description: trimToUndefined(request.identity?.label),
					buildCommitMessage: makeIsolationCommitMessage(request.session),
					buildFailureResult: buildFailureResult(request, policy, id, Date.now()),
				});
		attachStructuredOutputMetadata(result, policy.schema);
		// Bounded contract-failure reroute: on structured-output contract failure, try next eligible pool
		{
			let currentResult = result;
			let currentPolicy = policy;
			let currentBaseOptions = baseOptions;
			const maxReroutes = request.session.settings.get("task.routing.maxContractReroutes");
			let attempts = 0;
			const accumulatedReroutes: { from: string; to: string; reason: string }[] = [
				...(currentPolicy.routingReroutes ?? []),
			];
			while (attempts < maxReroutes) {
				const classification = classifyContractFailure(currentResult);
				if (!classification.isContractFailure) break;
				const decision = currentPolicy.routingDecision;
				const candidates = currentPolicy.routingCandidates;
				if (!decision || !candidates || decision.selectors.length <= 1) break;
				// The auth/retry chain may have moved on from modelOverride[0], so the
				// authoritative failed route is whatever actually ran.
				const failedSelector = currentResult.resolvedModel ?? currentPolicy.modelOverride?.[0];
				if (!failedSelector) break;
				const failedCand = candidates.find(c => c.selector === failedSelector);
				const failedPoolKey = failedCand?.pool.key ?? decision.pool.key;
				let nextSelector: string | undefined;
				let nextIdx = -1;
				for (let i = 0; i < decision.selectors.length; i++) {
					const sel = decision.selectors[i];
					if (sel === failedSelector) continue;
					const cand = candidates.find(c => c.selector === sel);
					if (!cand) continue;
					if (cand.pool.key !== failedPoolKey) {
						nextSelector = sel;
						nextIdx = i;
						break;
					}
				}
				if (!nextSelector) break;
				accumulatedReroutes.push({ from: failedSelector, to: nextSelector, reason: classification.reason });
				logger.warn(
					`Routing contract failure reroute ${failedSelector} -> ${nextSelector}: ${classification.reason}`,
					{
						agent: currentPolicy.agentName,
						from: failedSelector,
						to: nextSelector,
					},
				);
				const remainingSelectors = decision.selectors.slice(nextIdx);
				currentPolicy = {
					...currentPolicy,
					modelOverride: remainingSelectors,
					routingReroutes: [...accumulatedReroutes],
					resourcePool:
						candidates.find(c => c.selector === nextSelector)?.pool.label ?? currentPolicy.resourcePool,
					routingReason: `reroute ${failedSelector} -> ${nextSelector}: ${classification.reason}`,
				};
				policy = currentPolicy;
				currentBaseOptions = buildExecutorOptions(request, currentPolicy, lease, id);
				currentBaseOptions.onCleanupDeferred = completion => {
					deferredCleanup = completion;
				};
				currentBaseOptions.planReference = await loadPlanReference(request, currentPolicy);
				try {
					const nextResult = !isolationContext
						? await runSubprocess(currentBaseOptions)
						: await runIsolatedSubprocess({
								baseOptions: currentBaseOptions,
								context: isolationContext,
								preferredBackend: parseIsolationMode(request.session.settings.get("task.isolation.mode")),
								agentId: id,
								mergeMode: currentPolicy.mergeMode,
								artifactsDir: lease.artifactsDir,
								description: trimToUndefined(request.identity?.label),
								buildCommitMessage: makeIsolationCommitMessage(request.session),
								buildFailureResult: buildFailureResult(request, currentPolicy, id, Date.now()),
							});
					attachStructuredOutputMetadata(nextResult, currentPolicy.schema);
					// Propagate accumulated reroutes onto the result for observability (executor also carries them via progress)
					nextResult.routingReroutes = [...accumulatedReroutes];
					nextResult.routingIntent = currentPolicy.routingIntent;
					nextResult.resourcePool = currentPolicy.resourcePool;
					nextResult.routingReason = currentPolicy.routingReason;
					nextResult.routingAntiAffinity = currentPolicy.routingAntiAffinity;
					nextResult.routingParentPoolFallback = currentPolicy.routingParentPoolFallback;
					nextResult.routingUsageInfluenced = currentPolicy.routingUsageInfluenced;
					nextResult.routingBypassReason = currentPolicy.routingBypassReason;
					currentResult = nextResult;
					attempts++;
				} catch (rerouteError) {
					logger.warn("Reroute execution failed", {
						error: rerouteError instanceof Error ? rerouteError.message : String(rerouteError),
					});
					break;
				}
			}
			result = currentResult;
			// Ensure final result carries accumulated reroutes even if loop exited via break before updating result
			if (accumulatedReroutes.length > 0 && (!result.routingReroutes || result.routingReroutes.length === 0)) {
				result.routingReroutes = [...accumulatedReroutes];
			}
		}
		requiresRecoveryArtifacts =
			policy.isIsolated &&
			(result.exitCode !== 0 || result.error !== undefined || result.aborted === true) &&
			(result.patchPath !== undefined || result.branchName !== undefined || (result.nestedPatches?.length ?? 0) > 0);

		if (
			policy.isIsolated &&
			isolationContext &&
			policy.applyChanges &&
			result.exitCode === 0 &&
			!result.error &&
			!result.aborted
		) {
			const outcome = await mergeIsolatedChanges({
				result,
				repoRoot: isolationContext.repoRoot,
				mergeMode: policy.mergeMode,
			});
			mergeSummary = outcome.summary;
			changesApplied = outcome.changesApplied;
			if (outcome.changesApplied !== false) {
				const nestedPatchSummary = await applyEligibleNestedPatches({
					result,
					repoRoot: isolationContext.repoRoot,
					mergeMode: policy.mergeMode,
					changesApplied: outcome.changesApplied,
					mergedBranchForNestedPatches: outcome.mergedBranchForNestedPatches,
					commitMessage: makeIsolationCommitMessage(request.session)(),
				});
				mergeSummary += nestedPatchSummary;
				requiresRecoveryArtifacts ||=
					nestedPatchSummary.includes("<system-notification>") && (result.nestedPatches?.length ?? 0) > 0;
			}
		} else if (policy.isIsolated && isolationContext && !policy.applyChanges) {
			if (result.branchName)
				mergeSummary = `\n\nIsolation: changes captured on branch \`${result.branchName}\` (apply=false). Not merged.`;
			else if (result.patchPath)
				mergeSummary = `\n\nIsolation: changes captured at \`${result.patchPath}\` (apply=false). Not applied.`;
			else if ((result.nestedPatches?.length ?? 0) > 0)
				mergeSummary = `\n\nIsolation: changes captured for ${result.nestedPatches?.length} nested ${(result.nestedPatches?.length ?? 0) === 1 ? "repository" : "repositories"} (apply=false). Not applied.`;
			else mergeSummary = "\n\nIsolation: no changes captured.";
		}

		completedSuccessfully = result.exitCode === 0 && !result.error && !result.aborted;
		return {
			result,
			policy,
			mergeSummary,
			changesApplied,
			artifactsDir: lease.artifactsDir,
			temporaryArtifacts: lease.temporary,
		};
	} catch (error) {
		if (error instanceof StructuredSubagentError) throw error;
		throw new StructuredSubagentError(
			"execution",
			`Subagent execution failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		const shouldRetainArtifacts =
			(request.retainArtifacts && completedSuccessfully) ||
			(policy.isIsolated && (!policy.applyChanges || changesApplied === false || requiresRecoveryArtifacts));
		const shouldCleanup = lease.temporary && !shouldRetainArtifacts;
		if (shouldCleanup) {
			const cleanupArtifacts = async (): Promise<void> => {
				await fs.rm(lease.artifactsDir, { recursive: true, force: true });
				lease.unregister?.();
			};
			if (deferredCleanup) {
				trackLateCleanup(deferredCleanup.then(cleanupArtifacts), {
					resource: "artifacts",
					artifactsDir: lease.artifactsDir,
				});
			} else {
				await cleanupArtifacts();
			}
		}
	}
}

/** Build the recovery suffix used by adapters after an isolated failure. */
export async function buildStructuredSubagentRecoveryHint(result: SingleResult, artifactsDir: string): Promise<string> {
	return isolationRecoveryHint(result, artifactsDir);
}
