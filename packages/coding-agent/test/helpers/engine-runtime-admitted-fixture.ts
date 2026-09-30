import type {
	ApprovalRequest,
	EngineExecutionConfiguration,
	EngineSemanticBindingSnapshot,
	EngineTarget,
	EngineStartRequest,
	EngineStartResult,
} from "@oh-my-pi/pi-coding-agent/engine/contracts";
import { EngineBindingPendingError, EngineTargetError, validateStartRequest } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import type { ApprovalDecision } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import type { EngineRuntime, EngineRuntimeOptions } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { type EngineCommandEnvelope, engineCommandIdentity } from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ResolvedEngineExecution } from "@oh-my-pi/pi-coding-agent/engine/execution-resolver";
import { storageCanonicalJson } from "@oh-my-pi/pi-coding-agent/session/storage-client";
import { validateRuntimeValue } from "@oh-my-pi/pi-coding-agent/engine/runtime-protocol";
import { semanticBinding } from "./runtime-v1-rocks-fixture";

const hash = (value: unknown) => `sha256:${Bun.SHA256.hash(storageCanonicalJson(value), "hex")}`;
const fixtures = new WeakMap<EngineExecutionConfiguration, AdmittedExecutionFixture>();

export interface AdmittedExecutionFixture {
	/** Complete admitted typed execution; every Start consumes it read-only. */
	config: EngineExecutionConfiguration;
	dispatchRef: string;
	dispatchHash: string;
	taskRef: string;
	/** Origin receipts captured per Start command for the fixture origin verifier. */
	receipts: Map<string, EngineCommandEnvelope>;
	/** Approval decisions captured per decision command for the fixture approval verifier. */
	decisions: Map<string, ApprovalDecision>;
	setModelOverride(override: Record<string, unknown>): void;
	captureCommand(command: EngineCommandEnvelope): EngineCommandEnvelope;
	optionsFor(runtimeOptions: {
		deviceId?: string;
		sessionDefaults?: EngineRuntimeOptions["sessionDefaults"];
	}): Pick<
		EngineRuntimeOptions,
		"deviceId" | "sessionDefaults" | "resolveExecution" | "verifyOriginReceipt" | "verifyApprovalReceipt"
	>;
}

const spawnOff = { allowed: "no", max_depth: 0, max_children: 0, on_exceed: "deny" } as const;
const unlimitedLimits = { timeout_seconds: null, max_iterations: null };

function continuation(
	overrides: Partial<EngineExecutionConfiguration["continuationConfiguration"]> = {},
): EngineExecutionConfiguration["continuationConfiguration"] {
	return {
		systemPrompt: "",
		toolNames: [],
		restrictToolNames: false,
		toolPolicies: {},
		enableMCP: false,
		enableLsp: false,
		lspShared: false,
		disabledCapabilityProviders: [],
		outputSchema: null,
		requireYieldTool: false,
		spawn: spawnOff,
		limits: unlimitedLimits,
		tools_permit: [],
		tools_on_request: "none",
		providerPromptCacheKey: null,
		...overrides,
	};
}

/**
 * One admitted typed execution for an ordinary Agent on a Task: a frozen single-route roster
 * materialized locally by the test resolver, origin receipts captured per Start command, and
 * canonical instruction_sources. Mirrors the common native proof fixture without reading it.
 */
export function admittedExecution(
	model: Model,
	modelRegistry: ModelRegistry,
	options: {
		taskRef?: string;
		continuation?: Partial<EngineExecutionConfiguration["continuationConfiguration"]>;
		spawn?: EngineExecutionConfiguration["dispatch"]["spawn"];
		continuationPolicy?: "exact" | "fresh";
		fallbackModel?: Model | null;
		scopeAgents?: number;
		dispatch?: EngineExecutionConfiguration["dispatch"];
		rules?: EngineExecutionConfiguration["instruction_sources"]["rules"];
		stableDependencyDigest?: string;
	} = {},
): AdmittedExecutionFixture {
	const taskRef = options.taskRef ?? "grimoire://tasks/grimoire/runtime-test";
	const dispatchRef = "gctx:cccccccccccccccc";
	const primaryRouteRef = "gctx:bbbbbbbbbbbbbbbb";
	const fallbackRouteRef = "gctx:dddddddddddddddd";
	type FixtureRoute = EngineExecutionConfiguration["routes"]["routes"][number];
	const route = (routeRef: string, candidate: Model): FixtureRoute => ({
		model_id: candidate.id, route_ref: routeRef, account_ref: "gctx:aaaaaaaaaaaaaaaa",
		effort: "none", service_tier: "standard", billing_pool_id: "engine-runtime-test-pool",
		billing_pool_basis: "expected", tier: 0, provider_id: candidate.provider, quota_window_ids: [],
		shadow_cost: null, price_source: "unknown", estimated: false, record_revisions: {},
		provider: candidate.provider, modelId: candidate.id,
		billing_pools: [{
			pool_id: "engine-runtime-test-pool", kind: "balance", valuation: 1, reserve: 0,
			price_multiplier: 1, service_tier_multipliers: { standard: 1, priority: 1, flex: 1 },
			quota_windows: [], window_seconds: null, cap: null,
		}],
		quota_windows: [],
		execution: {
			api: "openai-completions",
			base_url: "http://127.0.0.1:1/v1",
			provider_model_id: candidate.id,
			context_window: candidate.contextWindow,
			max_output_tokens: candidate.maxTokens,
			input_modalities: [...candidate.input],
			supports_tools: true, supports_reasoning: false, header_refs: [], compat: null,
			route_content_hash: hash({ route: routeRef }), account_content_hash: hash({ account: routeRef }),
			display_name: `Engine runtime test route ${routeRef}`, efforts: ["none"] as ["none"], trusted: true,
			credential: { method: "none", local_ref: null, hosted_ref: null, generation: 1 },
			account_binding_id: null,
		},
		family: null, tags: [], efforts: ["none"] as ["none"], hard_quota_window_ids: [], order_match: null,
	});
	const routes: EngineExecutionConfiguration["routes"]["routes"] = [route(primaryRouteRef, model)];
	if (options.fallbackModel) routes.push(route(fallbackRouteRef, options.fallbackModel));
	const spawn = options.spawn ?? spawnOff;
	const scopeAgents = options.scopeAgents ?? 4;
	const config: EngineExecutionConfiguration = {
		dispatch: options.dispatch ?? {
			schema: "grimoire.dispatch.v2", execution_kind: "ordinary", special_ref: null,
			dispatch_id: "engine-runtime-test-dispatch",
			target: { task_ref: taskRef, work_step_id: null },
			prompt: "Engine runtime test", instructions: "", skill_refs: [],
			display_name: null, preset: null, tools: null, tools_permit: [],
			tools_on_request: "none", spawn,
			requirement: {
				min_tier: 0, required: [], required_tags: [], preferred_tags: [], models: null,
				exclude: { models: [], families: [], agent_instances: [] },
				min_context: null, min_output: null, latency_ceiling_ms: null, min_effort: null,
				service_tier: "standard", downgrade: "forbidden", pin: null,
				require_trusted_provider: true,
				fallback_mode: options.fallbackModel ? "scope" : "none",
			},
			output_schema: null, limits: unlimitedLimits,
		},
		routes: { routes },
		continuationPolicy: options.continuationPolicy ?? "exact",
		continuationConfiguration: continuation({ spawn, limits: unlimitedLimits, ...options.continuation }),
		stableDependencyDigest: options.stableDependencyDigest ?? hash("engine-runtime-test-dependency"),
		sessionDefaults: {},
		instruction_sources: {
			facts: { binding: options.dispatch?.execution_kind === "consultation" ? "consultation" :
				options.dispatch?.execution_kind === "automation" ? "automation" : "task",
				scope: options.dispatch?.target === null ? [] : [taskRef], os: null, runtime: "artel-engine", engine_version: null },
			rules: options.rules ?? [], skills: [],
		},
		record_revisions: {},
		routingLimits: {
			scopes: options.dispatch?.target === null ? [] : [{ scope_ref: taskRef, agents: scopeAgents, by_tier: [], consultations: scopeAgents }],
			accounts: { "gctx:aaaaaaaaaaaaaaaa": scopeAgents },
			providers: Object.fromEntries(routes.map(route => [route.provider_id, scopeAgents])),
		},
		scope_revision: hash("engine-runtime-test-scope"),
		roster_revision: hash("engine-runtime-test-roster"),
		roster_complete: true,
	};
	const dispatchHash = hash(config.dispatch);
	const receipts = new Map<string, EngineCommandEnvelope>();
	const decisions = new Map<string, ApprovalDecision>();
	const captureCommand = (value: EngineCommandEnvelope): EngineCommandEnvelope => {
		const command = JSON.parse(JSON.stringify(value)) as EngineCommandEnvelope;
		const receiptId = command.payload.originReceiptId;
		if (typeof receiptId !== "string") throw new EngineTargetError("invalid_request", "Fixture command needs its origin receipt");
		const retained = receipts.get(receiptId);
		if (retained && storageCanonicalJson(retained) !== storageCanonicalJson(command))
			throw new EngineTargetError("stale_target", "Fixture origin receipt is immutable");
		receipts.set(receiptId, structuredClone(command));
		return command;
	};
	let modelOverride: Record<string, unknown> = {};
	const optionsFor = (runtimeOptions: {
		deviceId?: string;
		sessionDefaults?: EngineRuntimeOptions["sessionDefaults"];
	}): Pick<
		EngineRuntimeOptions,
		"deviceId" | "sessionDefaults" | "resolveExecution" | "verifyOriginReceipt" | "verifyApprovalReceipt"
	> => ({
		deviceId: runtimeOptions.deviceId ?? "engine-runtime-test-device",
		...(runtimeOptions.sessionDefaults ? { sessionDefaults: runtimeOptions.sessionDefaults } : {}),
		resolveExecution: async (execution, frozen): Promise<ResolvedEngineExecution> => {
			if (hash(execution.dispatch) !== dispatchHash ||
				frozen.some(candidate => !routes.some(route => candidate.route_ref === route.route_ref)))
				throw new EngineTargetError("stale_target", "Fixture route differs from admitted execution");
			const selected = [model, options.fallbackModel].find(candidate =>
				candidate?.id === frozen[0]?.model_id && candidate?.provider === frozen[0]?.provider_id);
			if (!selected) throw new EngineTargetError("stale_target", "Fixture selected model is outside its frozen roster");
			return {
				options: {
					model: selected, modelRegistry,
					...(runtimeOptions.sessionDefaults?.settings
						? { settings: runtimeOptions.sessionDefaults.settings }
						: {}),
					...modelOverride,
				},
				selectors: frozen.map(candidate => `${candidate.provider}/${candidate.modelId}`),
				verifyCandidate: async index => {
					if (index < 0 || index >= frozen.length) throw new EngineTargetError("stale_target", "Unknown fixture route");
					return { billing_pool_id: frozen[index].billing_pool_id, billing_pool_basis: frozen[index].billing_pool_basis };
				},
				activateCandidate: () => {},
				setBillingPoolChanged: () => {}, // Fixture routes execute locally, without hosted billing material.
				dispose: () => {},
			};
		},
		verifyOriginReceipt: async identity => {
			const command = receipts.get(identity.originReceiptId);
			if (!command || command.commandId !== identity.commandId ||
				command.agentInstanceRef !== identity.agentInstanceRef ||
				command.attemptId !== identity.attemptId || command.principalId !== identity.principalId)
				throw new EngineTargetError("stale_target", "Origin differs from the exact fixture command");
			// Return the exact captured binding snapshot, never a synthesized one.
			if (command.op === "start" && !command.bindingSnapshot)
				throw new EngineTargetError("invalid_request", "Fixture Start command has no captured binding snapshot");
			const { originReceiptId: _receipt, ...payload } = command.payload;
			return {
				verified: true, dispatchHash: command.op === "start" ? String(command.payload.dispatchHash) : undefined,
				bindingSnapshot: command.bindingSnapshot,
				commandHash: hash({ ...command, payload }),
				authContextId: "engine-runtime-test-auth", approvalSettings: null, specialApproval: null,
			};
		},
		verifyApprovalReceipt: async identity => {
			const decision = decisions.get(identity.originReceiptId);
			if (!decision || decision.command_id !== identity.commandId)
				throw new EngineTargetError("stale_target", "Approval decision differs from its submitted command");
			const inputRevision = receipts.get(identity.originReceiptId)?.payload.expectedInputRevision;
			return { verified: true, approvalDecision: decision, expectedInputRevision: typeof inputRevision === "number" ? inputRevision : null };
		},
	});
	const fixture: AdmittedExecutionFixture = {
		config, dispatchRef, dispatchHash, taskRef, receipts, decisions,
		captureCommand,
		setModelOverride: override => {
			modelOverride = override;
		},
		optionsFor,
	};
	fixtures.set(config, fixture);
	return fixture;
}

/** An approval decision carrying the exact command identity the fixture verifier captured. */
export function approvalDecisionFor(
	execution: AdmittedExecutionFixture,
	target: EngineTarget & { principalId?: string },
	commandId: string,
	request: ApprovalRequest,
	decision: "approve" | "deny",
	reason?: string,
): ApprovalDecision {
	const approvalDecisionValue: ApprovalDecision = {
		schema: "grimoire.approval_decision.v1",
		request_id: request.id,
		expected_address_revision: request.address_revision,
		expected_decision_revision: request.decision_revision,
		command_id: commandId,
		decision,
		reason: reason ?? null,
		origin_receipt_id: `origin:${commandId}`,
		decided_by: { kind: "human", principal_id: target.principalId ?? "owner" },
		authority: {
			ceiling_hash: hash(execution.config.continuationConfiguration.tools_permit),
			subject_hash: hash(request.subject),
			dispatch_hash: request.dispatch_hash,
		},
		decided_at: new Date().toISOString(),
	};
	execution.decisions.set(approvalDecisionValue.origin_receipt_id, approvalDecisionValue);
	return approvalDecisionValue;
}

/** A typed Start request against one admitted execution. */
export function startRequest(
	execution: AdmittedExecutionFixture,
	identity: {
		commandId: string;
		agentInstanceId: string;
		agentInstanceRef: string;
		executionId: string;
		attemptId: string;
	},
	payload: {
		cwd: string;
		principalId: string;
		input?: string;
		parentAgentInstanceId?: string;
		historyEdit?: EngineStartRequest["historyEdit"];
		attachmentUploadIds?: string[];
		clientMessageId?: string;
		context?: string;
		displayName?: string;
		delegationHint?: string;
		queueId?: string;
		expectedRevision?: number;
		mutationId?: string;
		expectedIntentRevision?: number;
		explicitContinue?: boolean;
		bindingSnapshot?: EngineSemanticBindingSnapshot;
		parentAgentInstanceRef?: string;
	},
): EngineStartRequest {
	const originReceiptId = `origin:${identity.commandId}`;
	const { principalId: _p, cwd: _c, bindingSnapshot, ...rest } = payload;
	const special = execution.config.dispatch.special_ref;
	const specialRef = special ? {
		definitionRef: special.definition_ref,
		revision: special.definition_revision,
		occurrenceOrCallId: "occurrence_id" in special ? special.occurrence_id : special.call_id,
	} : null;
	if (specialRef) validateRuntimeValue("startSpecialRef", specialRef);
	return {
		...rest,
		commandId: identity.commandId,
		principalId: payload.principalId,
		executionConfiguration: execution.config,
		dispatchRef: execution.dispatchRef,
		dispatchHash: execution.dispatchHash,
		executionKind: execution.config.dispatch.execution_kind,
		specialRef: specialRef as EngineStartRequest["specialRef"],
		originReceiptId,
		agentInstanceId: identity.agentInstanceId,
		agentInstanceRef: identity.agentInstanceRef,
		bindingSnapshot: bindingSnapshot ?? semanticBinding(identity.agentInstanceRef, execution.taskRef),
		executionId: identity.executionId,
		attemptId: identity.attemptId,
		authorityGeneration: 1,
		cwd: payload.cwd,
	};
}

/** Capture the exact transport envelope; duplicates retain their original generation and timestamp. */
export function startEnvelope(runtime: Pick<EngineRuntime, "engineGeneration">, execution: AdmittedExecutionFixture, request: EngineStartRequest,
	transport = { deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine" }): EngineCommandEnvelope {
	const { commandId, agentInstanceId, agentInstanceRef, bindingSnapshot, parentAgentInstanceId, parentAgentInstanceRef,
		executionId, attemptId, authorityGeneration, principalId, ...payload } = request;
	const prior = execution.receipts.get(request.originReceiptId);
	const command: EngineCommandEnvelope = {
		schema: "grimoire.engine.command.v1", op: "start", commandId,
		deviceId: transport.deviceId, engineId: transport.engineId,
		engineGeneration: prior?.engineGeneration ?? runtime.engineGeneration,
		issuedAt: prior?.issuedAt ?? Date.now(), agentInstanceId, agentInstanceRef, bindingSnapshot,
		parentAgentInstanceId, parentAgentInstanceRef, executionId, attemptId, authorityGeneration, principalId, payload,
	};
	return execution.captureCommand(command);
}

/** The same native admission followed by Start that the Engine command transports perform. */
export async function admitStart(runtime: EngineRuntime, execution: AdmittedExecutionFixture, request: EngineStartRequest,
	transport?: { deviceId: string; engineId: string }): Promise<EngineStartResult> {
	validateStartRequest(request);
	const command = startEnvelope(runtime, execution, request, transport);
	const admission = await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration);
	if (admission.status === "binding_pending") throw new EngineBindingPendingError();
	if (admission.status === "replay" && admission.receipt.outcome === "rejected")
		throw Object.assign(new Error(String(admission.receipt.detail?.message ?? "Start was rejected")), {
			code: admission.receipt.detail?.code ?? "invalid_request",
		});
	return runtime.start(request);
}

/** Admit a typed request created from a registered fixture, without monkeypatching the Runtime API. */
export function admitRequest(runtime: EngineRuntime, request: EngineStartRequest): Promise<EngineStartResult> {
	const execution = fixtures.get(request.executionConfiguration);
	if (!execution) throw new EngineTargetError("invalid_request", "Start uses an unregistered fixture configuration");
	return admitStart(runtime, execution, request);
}
