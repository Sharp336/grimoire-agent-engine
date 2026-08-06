import * as fs from "node:fs/promises";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { isAuthenticated, kNoAuth, type ModelRegistry } from "../config/model-registry";
import * as modelResolver from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import type { StructuredSubagentRequest } from "../task/structured-subagent";
import * as subagents from "../task/structured-subagent";
import type { ConfiguredThinkingLevel } from "../thinking";
import * as thinking from "../thinking";
import type { ToolSession } from "../tools";
import * as git from "../utils/git";
import { type CouncilConfig, type CouncilMember, parseCouncilConfig, resolveCouncilMemberSelector } from "./config";
import * as instructions from "./instructions";
import { getCouncilLens } from "./lenses";
import type { CouncilPublicationTarget } from "./publication";
import * as publication from "./publication";
import { COUNCIL_PLANNER_SCHEMA, COUNCIL_REPORT_SCHEMA } from "./schema";
import type { CouncilInstructionSnapshot } from "./state";

export const COUNCIL_AGENT_TOOLS = ["read", "grep", "glob", "lsp", "ast_grep"] as const;
export const COUNCIL_TASK_CHAR_LIMIT = 40_000;

export type CouncilDispatchErrorCode =
	| "COUNCIL_CONFIG_INVALID"
	| "COUNCIL_TASK_INVALID"
	| "COUNCIL_NO_ENABLED_MEMBERS"
	| "COUNCIL_MEMBER_MODEL_INVALID"
	| "COUNCIL_PLANNER_MODEL_INVALID"
	| "COUNCIL_MAIN_MODEL_INVALID"
	| "COUNCIL_WRITE_TOOL_REQUIRED"
	| "COUNCIL_REPOSITORY_INVALID"
	| "COUNCIL_PUBLICATION_INVALID"
	| "COUNCIL_INSTRUCTIONS_INVALID"
	| "COUNCIL_SUBAGENT_POLICY_INVALID";

/** A dispatch blocker proven before any council model is invoked. */
export class CouncilDispatchError extends Error {
	readonly spending = false;

	constructor(
		readonly code: CouncilDispatchErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CouncilDispatchError";
	}
}

/** Existing live-session surfaces required by preflight. A ToolSession is supplied, never synthesized. */
export interface CouncilPreflightHost {
	toolSession: ToolSession;
	session: Pick<AgentSession, "model" | "thinkingLevel" | "getActiveToolNames">;
	modelRegistry: ModelRegistry;
	settings: Settings;
	sessionManager: Pick<SessionManager, "getCwd" | "getSessionId">;
}

export interface CouncilResolvedMember extends CouncilMember {
	requestedSelector: string;
	resolvedSelector: string;
	model: Model<Api>;
	effort: ConfiguredThinkingLevel | undefined;
	lens: string;
}

export interface CouncilResolvedPlanner {
	role: "slow";
	requestedSelector: string;
	resolvedSelector: string;
	model: Model<Api>;
	effort: ConfiguredThinkingLevel | undefined;
}

export interface CouncilMainDispatchSnapshot {
	selector: string;
	model: Model<Api>;
	effort: ConfiguredThinkingLevel | undefined;
}

export interface CouncilMemberRequestPolicy extends StructuredSubagentRequest {
	agent: "council-member";
}

export interface CouncilDispatchPlan {
	task: string;
	cwd: string;
	repoRoot: string;
	sessionId: string;
	publicationTarget: CouncilPublicationTarget;
	config: CouncilConfig;
	rounds: CouncilConfig["rounds"];
	roster: CouncilConfig["members"];
	members: CouncilResolvedMember[];
	planner: CouncilResolvedPlanner;
	/** Informational only; resume compatibility must not compare this snapshot. */
	main: CouncilMainDispatchSnapshot;
	instructions: CouncilInstructionSnapshot;
	warnings: string[];
	plannerRequest: StructuredSubagentRequest & { agent: "council-planner" };
	memberRequests: CouncilMemberRequestPolicy[];
}

function dispatchError(code: CouncilDispatchErrorCode, message: string, cause?: unknown): CouncilDispatchError {
	return new CouncilDispatchError(code, message, cause === undefined ? undefined : { cause });
}

function resolvedEffort(
	model: Model<Api>,
	configured: ConfiguredThinkingLevel | undefined,
	settings?: Settings,
): ConfiguredThinkingLevel | undefined {
	let preferred = configured;
	if (preferred === undefined && settings !== undefined) {
		preferred =
			model.thinking?.defaultLevel ?? thinking.parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
	}
	const concrete =
		preferred === thinking.AUTO_THINKING
			? thinking.resolveProvisionalAutoLevel(model)
			: thinking.concreteThinkingLevel(preferred);
	return thinking.resolveThinkingLevelForModel(model, concrete);
}
export function resolveCouncilMainEffort(
	model: Model<Api>,
	configured: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel | undefined {
	return resolvedEffort(model, configured);
}

async function assertUsableModelAuth(
	modelRegistry: ModelRegistry,
	model: Model<Api>,
	sessionId: string,
): Promise<boolean> {
	const apiKey = await modelRegistry.getApiKey(model, sessionId);
	return apiKey === kNoAuth || isAuthenticated(apiKey);
}

async function resolvePinnedRole(
	host: CouncilPreflightHost,
	role: string,
	code: "COUNCIL_MEMBER_MODEL_INVALID" | "COUNCIL_PLANNER_MODEL_INVALID",
	sessionId: string,
): Promise<{
	requestedSelector: string;
	resolvedSelector: string;
	model: Model<Api>;
	effort: ConfiguredThinkingLevel | undefined;
}> {
	const memberResolution =
		code === "COUNCIL_MEMBER_MODEL_INVALID" ? resolveCouncilMemberSelector(host.settings, role) : undefined;
	if (memberResolution && memberResolution.kind !== "resolved") {
		throw dispatchError(
			code,
			memberResolution.kind === "unassigned"
				? `Council role ${role} has no configured model selector.`
				: `Council role ${role} must configure exactly one model selector.`,
		);
	}
	const requestedSelector = memberResolution?.kind === "resolved" ? memberResolution.selector : `@${role}`;
	const resolved = modelResolver.resolveCliModel({
		cliModel: requestedSelector,
		modelRegistry: host.modelRegistry,
		settings: host.settings,
		preferences: modelResolver.getModelMatchPreferences(host.settings),
	});
	if (!resolved.model) {
		throw dispatchError(code, `Council role ${role} model is unavailable: ${resolved.error ?? requestedSelector}`);
	}
	if (resolved.model.supportsTools === false) {
		throw dispatchError(
			code,
			`Council role ${role} model ${resolved.model.provider}/${resolved.model.id} does not support tools.`,
		);
	}
	let usable: boolean;
	try {
		usable = await assertUsableModelAuth(host.modelRegistry, resolved.model, sessionId);
	} catch (error) {
		throw dispatchError(
			code,
			`Council role ${role} model credentials could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
	if (!usable) {
		throw dispatchError(
			code,
			`Council role ${role} model ${resolved.model.provider}/${resolved.model.id} has no usable credentials.`,
		);
	}
	const effort = resolvedEffort(resolved.model, resolved.thinkingLevel, host.settings);
	const resolvedSelector = modelResolver.formatModelSelectorValue(
		modelResolver.formatModelStringWithRouting(resolved.model),
		effort,
	);
	return { requestedSelector, resolvedSelector, model: resolved.model, effort };
}

function modelIdentity(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function councilDispatchWarnings(
	members: readonly CouncilResolvedMember[],
	main: CouncilMainDispatchSnapshot,
): string[] {
	const warnings: string[] = [];
	const rolesByModel = new Map<string, string[]>();
	for (const member of members) {
		const identity = modelIdentity(member.model);
		const roles = rolesByModel.get(identity);
		if (roles) roles.push(member.role);
		else rolesByModel.set(identity, [member.role]);
	}
	for (const [identity, roles] of rolesByModel) {
		if (roles.length > 1) {
			warnings.push(`Council roles ${roles.join(", ")} resolve to the same model ${identity}.`);
		}
		if (identity === modelIdentity(main.model)) {
			warnings.push(`Council roles ${roles.join(", ")} resolve to the Main model ${identity}.`);
		}
	}
	return warnings;
}

/** Revalidate the live Main surface immediately before an adjudication turn. */
export async function preflightCouncilMainDispatch(host: CouncilPreflightHost): Promise<CouncilMainDispatchSnapshot> {
	const mainModel = host.session.model;
	if (!mainModel) {
		throw dispatchError("COUNCIL_MAIN_MODEL_INVALID", "Council dispatch requires an active Main model.");
	}
	if (mainModel.supportsTools === false) {
		throw dispatchError(
			"COUNCIL_MAIN_MODEL_INVALID",
			`Council Main model ${mainModel.provider}/${mainModel.id} does not support tools.`,
		);
	}
	let mainUsable: boolean;
	try {
		mainUsable = await assertUsableModelAuth(host.modelRegistry, mainModel, host.sessionManager.getSessionId());
	} catch (error) {
		throw dispatchError(
			"COUNCIL_MAIN_MODEL_INVALID",
			`Council Main model credentials could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
	if (!mainUsable) {
		throw dispatchError(
			"COUNCIL_MAIN_MODEL_INVALID",
			`Council Main model ${mainModel.provider}/${mainModel.id} has no usable credentials.`,
		);
	}
	if (!host.session.getActiveToolNames().includes("write")) {
		throw dispatchError(
			"COUNCIL_WRITE_TOOL_REQUIRED",
			"Council dispatch requires Main's write tool for xd://council.",
		);
	}
	const effort = resolveCouncilMainEffort(mainModel, host.session.thinkingLevel);
	return {
		model: mainModel,
		effort,
		selector: modelResolver.formatModelSelectorValue(modelResolver.formatModelStringWithRouting(mainModel), effort),
	};
}

function requestPolicy<TAgent extends "council-planner" | "council-member">(
	host: CouncilPreflightHost,
	task: string,
	cwd: string,
	agent: TAgent,
	selector: string,
	outputSchema: unknown,
	instructionSnapshot: CouncilInstructionSnapshot,
): StructuredSubagentRequest & { agent: TAgent } {
	return {
		session: host.toolSession,
		cwd,
		invocationKind: "task",
		assignment: task,
		agent,
		model: selector,
		tools: COUNCIL_AGENT_TOOLS,
		restrictToolNames: true,
		inheritContextFiles: true,
		additionalContextFiles: instructionSnapshot.contextFiles,
		skills: [],
		rules: [],
		autoloadSkills: [],
		pinModel: true,
		outputSchema,
		schemaMode: "strict",
		enableIrc: false,
	};
}

export interface CouncilPreflightOptions {
	/** Resume-only: revalidate this immutable promised path instead of allocating a new collision suffix. */
	promisedOutputPath?: string;
}

/**
 * Resolve every deterministic dispatch input and child policy before model spend.
 * This function neither constructs a ToolSession nor allocates council storage/manifest state.
 */
export async function preflightCouncilDispatch(
	host: CouncilPreflightHost,
	task: string,
	options: CouncilPreflightOptions = {},
): Promise<CouncilDispatchPlan> {
	if (task.trim().length === 0) {
		throw dispatchError("COUNCIL_TASK_INVALID", "Council task must contain non-whitespace content.");
	}
	if (task.length > COUNCIL_TASK_CHAR_LIMIT) {
		throw dispatchError(
			"COUNCIL_TASK_INVALID",
			`Council task exceeds the ${COUNCIL_TASK_CHAR_LIMIT}-character preflight limit.`,
		);
	}
	let config: CouncilConfig;
	try {
		config = parseCouncilConfig(host.settings);
	} catch (error) {
		if (error instanceof CouncilDispatchError) throw error;
		throw dispatchError("COUNCIL_CONFIG_INVALID", error instanceof Error ? error.message : String(error), error);
	}
	const enabled = config.members.filter(member => member.enabled);
	if (enabled.length === 0) {
		throw dispatchError("COUNCIL_NO_ENABLED_MEMBERS", "No enabled council members are configured.");
	}
	const sessionId = host.sessionManager.getSessionId();
	const sourceCwd = host.sessionManager.getCwd();

	const members: CouncilResolvedMember[] = [];
	for (const member of enabled) {
		const resolved = await resolvePinnedRole(host, member.role, "COUNCIL_MEMBER_MODEL_INVALID", sessionId);
		members.push({ ...member, ...resolved, lens: getCouncilLens(members.length) });
	}
	const planner = {
		role: "slow" as const,
		...(await resolvePinnedRole(host, "slow", "COUNCIL_PLANNER_MODEL_INVALID", sessionId)),
	};

	const main = await preflightCouncilMainDispatch(host);

	let cwd: string;
	let repoRoot: string;
	try {
		cwd = await fs.realpath(sourceCwd);
		const discoveredRoot = await git.repo.root(cwd);
		repoRoot = await fs.realpath(discoveredRoot ?? cwd);
	} catch (error) {
		throw dispatchError(
			"COUNCIL_REPOSITORY_INVALID",
			`Council repository root is unusable: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}

	let publicationTarget: CouncilPublicationTarget;
	try {
		publicationTarget = options.promisedOutputPath
			? await publication.resolvePromisedCouncilPublicationTarget(repoRoot, options.promisedOutputPath)
			: await publication.resolveCouncilPublicationTarget(repoRoot, task);
	} catch (error) {
		throw dispatchError("COUNCIL_PUBLICATION_INVALID", error instanceof Error ? error.message : String(error), error);
	}
	let instructionSnapshot: CouncilInstructionSnapshot;
	try {
		instructionSnapshot = await instructions.captureCouncilInstructionSnapshot(
			host.toolSession,
			publicationTarget.repoRoot,
		);
	} catch (error) {
		throw dispatchError(
			"COUNCIL_INSTRUCTIONS_INVALID",
			error instanceof Error ? error.message : String(error),
			error,
		);
	}

	const plannerRequest = requestPolicy(
		host,
		task,
		repoRoot,
		"council-planner",
		planner.resolvedSelector,
		COUNCIL_PLANNER_SCHEMA,
		instructionSnapshot,
	);
	try {
		await subagents.resolveEffectiveSubagentPolicy(plannerRequest);
	} catch (error) {
		throw dispatchError(
			"COUNCIL_SUBAGENT_POLICY_INVALID",
			error instanceof Error ? error.message : String(error),
			error,
		);
	}

	const memberRequests: CouncilMemberRequestPolicy[] = [];
	for (const member of members) {
		const request = requestPolicy(
			host,
			task,
			repoRoot,
			"council-member",
			member.resolvedSelector,
			COUNCIL_REPORT_SCHEMA,
			instructionSnapshot,
		);
		try {
			await subagents.resolveEffectiveSubagentPolicy(request);
			memberRequests.push(request);
		} catch (error) {
			throw dispatchError(
				"COUNCIL_SUBAGENT_POLICY_INVALID",
				`Council role ${member.role} cannot dispatch: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
	}

	return {
		task,
		cwd,
		repoRoot: publicationTarget.repoRoot,
		sessionId,
		publicationTarget,
		config,
		rounds: config.rounds,
		roster: config.members,
		members,
		planner,
		main,
		instructions: instructionSnapshot,
		warnings: councilDispatchWarnings(members, main),
		plannerRequest,
		memberRequests,
	};
}
