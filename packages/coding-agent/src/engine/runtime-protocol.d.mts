export const runtimeProtocol: { $defs: Record<string, unknown>; 'x-artel': { version: string; contractRevision: number; limits: Record<string, number>; controlActions: string[]; methods: Record<string, string>; nativeMethods: Record<string, { request: string; response: string }>; rules: Record<string, string> } };
export const runtimeLimits: Record<string, number>;
export class RuntimeProtocolError extends Error { code: string; retryable: boolean; admission: string; constructor(code: string, message: string, admission?: string); }
export function canonicalRuntimeJson(value: unknown): string;
export function validateRuntimeValue<T>(name: string, value: T): T;
export function runtimeCommandHash(command: unknown): Promise<string>;
export function runtimeProjectionHash(scope: unknown): Promise<string>;
export function validateRuntimeChannelScope<T>(channel: unknown, scope: T): T;

export const RUNTIME_PROTOCOL_REVISION: 17;

/** Runtime17 types derived from the strict shared JSON Schema. */
export type AttachmentUploadIds = Array<Id>;

export type Id = string;

export type Agi = string;

export type TaskRef = string;

export type BindingSnapshot = {
	"agentInstanceRef": Agi;
	"taskRef": TaskRef | null;
	"workStepId": Id | null;
	"bindingRevision": number;
	"installationId": InstallationId | null;
	"parentAgentInstanceRef": Agi | null;
	"parentAttemptId": Id | null;
	"parentBindingRevision": number | null;
};

export type InstallationId = string;

export type Hash = string;

export type IndexedQuestionAnswer = {
	"id": Id;
	"selectedOptionIndexes": Array<number>;
	"customInput"?: string;
	"note"?: string;
};

export type ArtifactRef = string;
export type AutomationRef = `grimoire://automations/${string}/${string}`;

export type Revision = number;

export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ServiceTier = "standard" | "priority" | "flex";

export type WorkTarget = {
	"task_ref": TaskRef;
	"work_step_id": string | null;
};

export type AcceptanceCriteria = Array<string>;

export type RequestedExecution = {
	"parent_attempt_id": Id | null;
	"parent_binding_revision": number | null;
	"one_writer_scope": Array<string>;
	"owner_thread_ref": string | null;
};

export type DispatchSpawn = {
	"allowed": "auto" | "no";
	"max_depth": number;
	"max_children": number;
	"on_exceed": "approve" | "deny";
};

export type DispatchLimits = {
	"timeout_seconds": number | null;
	"max_iterations": number | null;
};

export type DispatchPin = {
	"model_id": string;
	"effort": Effort;
	"route_ref": ArtifactRef | null;
	"reason": string;
};

export type DispatchRequirement = {
	"min_tier": number;
	"required": Array<"tools" | "image">;
	"required_tags": Array<string>;
	"preferred_tags": Array<string>;
	"models": Array<string> | null;
	"exclude": {
		"models": Array<string>;
		"families": Array<string>;
		"agent_instances": Array<Agi>;
	};
	"min_context": number | null;
	"min_output": number | null;
	"latency_ceiling_ms": number | null;
	"min_effort": Effort | null;
	"service_tier": ServiceTier;
	"downgrade": "forbidden" | "approval" | "allowed";
	"pin": DispatchPin | null;
	"require_trusted_provider": boolean;
	"fallback_mode": "none" | "same_model" | "scope";
};

export type DispatchSkill = {
	"ref": string;
	"level": "l0" | "l1" | "l2";
};

export type PresetReference = {
	"ref": ArtifactRef;
	"revision": number;
};

export type SpecialRef = {
	"kind": "automation";
	"definition_ref": AutomationRef;
	"definition_revision": number;
	"occurrence_id": string;
} | {
	"kind": "consultation";
	"definition_ref": ArtifactRef;
	"definition_revision": number;
	"call_id": string;
};

export type DispatchRequest = {
	"dispatch_id": string;
	"target": WorkTarget;
	"prompt": string;
	"instructions"?: string;
	"skill_refs"?: Array<DispatchSkill>;
	"display_name"?: string | null;
	"preset"?: PresetReference | null;
	"tools"?: Array<string> | null;
	"tools_permit"?: Array<string>;
	"tools_on_request"?: "auto" | "none";
	"spawn"?: DispatchSpawnRequest;
	"requirement"?: DispatchRequirementRequest;
	"output_schema"?: Record<string, unknown> | null;
	"limits"?: DispatchLimitsRequest;
};

export type DispatchDerivedPromptRequest = {
	"dispatch_id": string;
	"target": WorkTarget;
	"instructions"?: string;
	"skill_refs"?: Array<DispatchSkill>;
	"display_name"?: string | null;
	"preset"?: PresetReference | null;
	"tools"?: Array<string> | null;
	"tools_permit"?: Array<string>;
	"tools_on_request"?: "auto" | "none";
	"spawn"?: DispatchSpawnRequest;
	"requirement"?: DispatchRequirementRequest;
	"output_schema"?: Record<string, unknown> | null;
	"limits"?: DispatchLimitsRequest;
};

export type DispatchBranchRequest = {
	"dispatch_id": string;
	"target": WorkTarget;
	"prompt"?: string;
	"instructions"?: string;
	"skill_refs"?: Array<DispatchSkill>;
	"display_name"?: string | null;
	"preset"?: PresetReference | null;
	"tools"?: Array<string> | null;
	"tools_permit"?: Array<string>;
	"tools_on_request"?: "auto" | "none";
	"spawn"?: DispatchSpawnRequest;
	"requirement"?: DispatchRequirementRequest;
	"output_schema"?: Record<string, unknown> | null;
	"limits"?: DispatchLimitsRequest;
};

export type Dispatch = {
	"dispatch_id": string;
	"target": WorkTarget;
	"prompt": string;
	"instructions": string;
	"skill_refs": Array<DispatchSkill>;
	"display_name": string | null;
	"preset": PresetReference | null;
	"tools": Array<string> | null;
	"tools_permit": Array<string>;
	"tools_on_request": "auto" | "none";
	"spawn": DispatchSpawn;
	"requirement": DispatchRequirement;
	"output_schema": Record<string, unknown> | null;
	"limits": DispatchLimits;
	"schema": "grimoire.dispatch.v2";
	"execution_kind": "ordinary";
	"special_ref": null;
} | {
	"dispatch_id": string;
	"target": WorkTarget | null;
	"prompt": string;
	"instructions": string;
	"skill_refs": Array<DispatchSkill>;
	"display_name": string | null;
	"preset": PresetReference | null;
	"tools": Array<string> | null;
	"tools_permit": Array<string>;
	"tools_on_request": "auto" | "none";
	"spawn": DispatchSpawn;
	"requirement": DispatchRequirement;
	"output_schema": Record<string, unknown> | null;
	"limits": DispatchLimits;
	"schema": "grimoire.dispatch.v2";
	"execution_kind": "automation";
	"special_ref": {
		"kind": "automation";
		"definition_ref": AutomationRef;
		"definition_revision": number;
		"occurrence_id": string;
	};
} | {
	"dispatch_id": string;
	"target": WorkTarget | null;
	"prompt": string;
	"instructions": string;
	"skill_refs": Array<DispatchSkill>;
	"display_name": string | null;
	"preset": PresetReference | null;
	"tools": Array<string> | null;
	"tools_permit": Array<string>;
	"tools_on_request": "auto" | "none";
	"spawn": DispatchSpawn;
	"requirement": DispatchRequirement;
	"output_schema": Record<string, unknown> | null;
	"limits": DispatchLimits;
	"schema": "grimoire.dispatch.v2";
	"execution_kind": "consultation";
	"special_ref": {
		"kind": "consultation";
		"definition_ref": ArtifactRef;
		"definition_revision": number;
		"call_id": string;
	};
};

export type BillingPool = {
	"pool_id": string;
	"kind": "window" | "corp_quota" | "balance" | "payg";
	"valuation": number;
	"reserve": number;
	"price_multiplier": number;
	"service_tier_multipliers": {
		"standard": number;
		"priority": number;
		"flex": number;
	};
	"quota_windows": Array<string>;
	"window_seconds": number | null;
	"cap": {
		"provider": number | null;
		"user": number | null;
	} | null;
};

export type QuotaWindow = {
	"window_id": string;
	"window_seconds": number;
	"unit": "tokens" | "requests" | "currency" | "fraction";
	"limit": number;
	"reserve_fraction": number;
};

export type Price = {
	"currency": "USD";
	"input_per_1m": number;
	"output_per_1m": number;
	"cached_input_per_1m": number | null;
	"confirmed": boolean;
	"observed_at": string | null;
	"source_ref": string | null;
};

export type CandidateIdentity = {
	"model_id": string;
	"route_ref": ArtifactRef;
	"account_ref": ArtifactRef;
	"effort": Effort;
	"service_tier": ServiceTier;
	"billing_pool_id": string;
	"billing_pool_basis": "expected" | "observed";
};

export type RecordRevisions = Record<string, number>;

export type Candidate = {
	"model_id": string;
	"route_ref": ArtifactRef;
	"account_ref": ArtifactRef;
	"effort": Effort;
	"service_tier": ServiceTier;
	"billing_pool_id": string;
	"billing_pool_basis": "expected" | "observed";
	"tier": number | null;
	"provider_id": string;
	"quota_window_ids": Array<string>;
	"shadow_cost": number | null;
	"price_source": "account" | "list" | "tier_estimate" | "unknown";
	"estimated": boolean;
	"record_revisions": RecordRevisions;
};

export type SelectedExecutor = {
	"model_id": string;
	"route_ref": ArtifactRef;
	"account_ref": ArtifactRef;
	"effort": Effort;
	"service_tier": ServiceTier;
	"billing_pool_id": string;
	"billing_pool_basis": "expected" | "observed";
	"basis": "rank" | "pin" | "order" | "user";
	"order_match": {
		"scope_ref": string;
		"index": number;
		"for_tags": Array<string>;
	} | null;
};

export type ChoiceTransition = {
	"seq": number;
	"event_id": string;
	"from": CandidateIdentity;
	"to": CandidateIdentity;
	"reason": string;
	"at": string;
	"lease_revision": number;
	"from_execution_digest": Hash;
	"to_execution_digest": Hash;
};

export type ChoiceProvenance = {
	"ref": string;
	"revision": number | null;
	"content_hash": Hash;
};

export type InstructionRule = {
	"ref": ArtifactRef;
	"revision": number;
	"content_hash": Hash;
	"content": string;
	"route_refs": Array<ArtifactRef> | null;
};

export type InstructionFacts = {
	"binding": "task" | "step" | "consultation" | "automation";
	"scope": Array<string>;
	"os": "windows" | "linux" | "darwin" | null;
	"runtime": "artel-engine";
	"engine_version": string | null;
	"provider"?: string | null;
	"family"?: string | null;
	"model"?: string | null;
};

export type InstructionSources = {
	"facts": InstructionFacts;
	"rules": Array<InstructionRule>;
	"skills": Array<ChoiceProvenance>;
};

export type UsageProbeBindingGet = {
	"principalId": string;
	"accountRef": string;
};

export type UsageProbeBindingSet = {
	"principalId": string;
	"accountRef": string;
	"expectedRevision": number;
	"modulePath": string | null;
};

export type UsageProbeBindingResult = {
	"accountRef": string;
	"modulePath": string | null;
	"revision": number;
};

export type UsageProbeRun = {
	"principalId": string;
	"accountRef": string;
	"kind": "builtin" | "module";
	"account": Record<string, unknown>;
	"credential": Record<string, unknown> | null;
};

export type UsageProbeRunResult = {
	"status": string;
	"observations": Array<unknown>;
};

export type ActualCost = {
	"input_tokens": number | null;
	"output_tokens": number | null;
	"cached_input_tokens": number | null;
	"currency": string;
	"amount": number | null;
	"source": string;
	"observed_at": string;
};

export type ExecutorChoice = {
	"schema": "grimoire.executor_choice.v1";
	"dispatch_hash": Hash;
	"preset_ref": ArtifactRef | null;
	"effective_requirement": DispatchRequirement;
	"scope_revision": Hash;
	"candidates": Array<Candidate>;
	"filtered_counts": Record<string, number>;
	"selected": SelectedExecutor;
	"execution_digest": Hash;
	"shadow_cost_estimate": number | null;
	"rules": Array<ChoiceProvenance>;
	"skills": Array<ChoiceProvenance>;
	"transitions": Array<ChoiceTransition>;
	"actual_cost": ActualCost | null;
	"grants_used": Array<{
		"receipt_ref": string;
		"dispatch_hash": Hash;
		"scope_ref": string | null;
	}>;
};

export type DispatchDefaults = {
	"requirement": DispatchRequirement;
	"tools": Array<string> | null;
	"tools_permit": Array<string>;
	"tools_on_request": "auto" | "none";
	"spawn": DispatchSpawn;
	"limits": DispatchLimits;
};

export type ExecutorGlobalSettings = {
	"schema": "grimoire.executor_global_settings.v1";
	"owner_principal_id": string;
	"preset_mode": "off" | "on" | "auto";
	"auto_max_tier_on": number;
	"approval_timeout_seconds": number;
	"dispatch_defaults": DispatchDefaults;
	"revision": number;
};

export type SourceCopy = {
	"ref": ArtifactRef;
	"revision": number;
	"content_hash": Hash;
};

export type DispatchPreset = {
	"schema": "grimoire.dispatch_preset.v1";
	"preset_id": string;
	"display_name": string;
	"description": string;
	"fields": {
		"prompt"?: string;
		"instructions"?: string;
		"skill_refs"?: Array<DispatchSkill>;
		"display_name"?: string | null;
		"preset"?: PresetReference | null;
		"tools"?: Array<string> | null;
		"tools_permit"?: Array<string>;
		"tools_on_request"?: "auto" | "none";
		"spawn"?: DispatchSpawnRequest;
		"requirement"?: DispatchRequirementRequest;
		"output_schema"?: Record<string, unknown> | null;
		"limits"?: DispatchLimitsRequest;
	};
	"revision": number;
	"source": SourceCopy | null;
};

export type ApprovalAddressee = {
	"kind": "attempt";
	"agent_ref": Agi;
	"attempt_id": string;
} | {
	"kind": "human";
	"principal_id": string;
};

export type ApprovalDecider = {
	"kind": "human";
	"principal_id": string;
} | {
	"kind": "agent";
	"principal_id": string;
	"agent_ref": Agi;
	"attempt_id": string;
};

export type ToolApprovalSubject = {
	"tool_name": string;
	"call_hash": Hash;
	"ceiling_hash": Hash;
};

export type SpawnApprovalSubject = {
	"child_dispatch_hash": Hash;
	"admission_id": string;
	"requested_depth": number;
	"requested_child_ordinal": number;
	"exceeded": Array<"max_depth" | "max_children">;
	"ceiling_hash": Hash;
};

export type EscalationApprovalSubject = {
	"kind": "premium_once";
	"dispatch_hash": Hash;
	"model_id": string;
} | {
	"kind": "scope_grant";
	"scope_ref": string;
	"model_id": string;
	"expected_revision": number;
	"mutation_hash": Hash;
} | ScopeLimitSubject | {
	"kind": "selection_gate_change";
	"object_ref": ArtifactRef;
	"expected_revision": number;
	"mutation_hash": Hash;
	"before_effective_hash": Hash;
	"after_effective_hash": Hash;
};

export type ConsultantApprovalSubject = {
	"call_id": string;
	"definition_ref": ArtifactRef;
	"definition_revision": number;
	"dispatch_hash": Hash;
	"unavailable_pin": ConsultantPin;
	"proposed_reselection_hash": Hash;
};

export type ApprovalRequest = {
	"schema": "grimoire.approval_request.v1";
	"id": string;
	"principal_id": string;
	"requester_agent_ref": Agi;
	"requester_attempt_id": string;
	"requester_binding_revision": number;
	"dispatch_hash": Hash;
	"effect_id": string;
	"name": string;
	"requires_human": boolean;
	"reason": string;
	"created_at": string;
	"addressed_to": ApprovalAddressee;
	"addressed_at": string;
	"expires_at": string | null;
	"address_revision": number;
	"decision_revision": number;
	"status": "pending" | "waiting_human_paused" | "approved" | "denied" | "cancelled";
	"timeout_seconds": number;
	"settings_revision": number;
	"settings_hash": Hash;
	"kind": "tool";
	"subject": ToolApprovalSubject;
} | {
	"schema": "grimoire.approval_request.v1";
	"id": string;
	"principal_id": string;
	"requester_agent_ref": Agi;
	"requester_attempt_id": string;
	"requester_binding_revision": number;
	"dispatch_hash": Hash;
	"effect_id": string;
	"name": string;
	"requires_human": boolean;
	"reason": string;
	"created_at": string;
	"addressed_to": ApprovalAddressee;
	"addressed_at": string;
	"expires_at": string | null;
	"address_revision": number;
	"decision_revision": number;
	"status": "pending" | "waiting_human_paused" | "approved" | "denied" | "cancelled";
	"timeout_seconds": number;
	"settings_revision": number;
	"settings_hash": Hash;
	"kind": "spawn";
	"subject": SpawnApprovalSubject;
} | {
	"schema": "grimoire.approval_request.v1";
	"id": string;
	"principal_id": string;
	"requester_agent_ref": Agi;
	"requester_attempt_id": string;
	"requester_binding_revision": number;
	"dispatch_hash": Hash;
	"effect_id": string;
	"name": string;
	"requires_human": true;
	"reason": string;
	"created_at": string;
	"addressed_to": ApprovalAddressee;
	"addressed_at": string;
	"expires_at": string | null;
	"address_revision": number;
	"decision_revision": number;
	"status": "pending" | "waiting_human_paused" | "approved" | "denied" | "cancelled";
	"timeout_seconds": number;
	"settings_revision": number;
	"settings_hash": Hash;
	"kind": "escalation";
	"subject": EscalationApprovalSubject;
} | {
	"schema": "grimoire.approval_request.v1";
	"id": string;
	"principal_id": string;
	"requester_agent_ref": Agi;
	"requester_attempt_id": string;
	"requester_binding_revision": number;
	"dispatch_hash": Hash;
	"effect_id": string;
	"name": string;
	"requires_human": boolean;
	"reason": string;
	"created_at": string;
	"addressed_to": ApprovalAddressee;
	"addressed_at": string;
	"expires_at": string | null;
	"address_revision": number;
	"decision_revision": number;
	"status": "pending" | "waiting_human_paused" | "approved" | "denied" | "cancelled";
	"timeout_seconds": number;
	"settings_revision": number;
	"settings_hash": Hash;
	"kind": "consultant";
	"subject": ConsultantApprovalSubject;
};

export type ApprovalDecisionInput = {
	"request_id": string;
	"expected_address_revision": number;
	"expected_decision_revision": number;
	"command_id": string;
	"decision": "approve" | "approve_always" | "deny";
	"reason"?: string | null;
};

export type ApprovalDecision = {
	"request_id": string;
	"expected_address_revision": number;
	"expected_decision_revision": number;
	"command_id": string;
	"decision": "approve" | "approve_always" | "deny";
	"reason": string | null;
	"schema": "grimoire.approval_decision.v1";
	"origin_receipt_id": string;
	"decided_by": ApprovalDecider;
	"authority": {
		"ceiling_hash": Hash;
		"subject_hash": Hash;
		"dispatch_hash": Hash;
	};
	"decided_at": string;
};

export type ExecutorRouteState = {
	"dispatchHash": Hash;
	"selected": CandidateIdentity | null;
	"pending": CandidateIdentity | null;
	"fallback": boolean;
	"phase": "loading" | "active" | "exhausted";
	"eventSeq": number;
};

export type ExecutorRoute = {
	"state": ExecutorRouteState;
	"target": {
		"agentInstanceId": Id;
		"executionId": Id;
		"attemptId": Id;
		"runtimeBindingId": Id;
		"engineGeneration": number;
		"bindingGeneration": number;
		"authorityGeneration": number;
	};
	"eventSeq": number;
};

export type EngineExecutionRoute = {
	"model_id": string;
	"route_ref": ArtifactRef;
	"account_ref": ArtifactRef;
	"effort": Effort;
	"service_tier": ServiceTier;
	"billing_pool_id": string;
	"billing_pool_basis": "expected" | "observed";
	"tier": number | null;
	"provider_id": string;
	"quota_window_ids": Array<string>;
	"shadow_cost": number | null;
	"price_source": "account" | "list" | "tier_estimate" | "unknown";
	"estimated": boolean;
	"record_revisions": RecordRevisions;
	"provider": string;
	"modelId": string;
	"billing_pools": Array<BillingPool>;
	"quota_windows": Array<QuotaWindow>;
	"execution": ExecutionDescriptor;
	"family": string | null;
	"tags": Array<string>;
	"efforts": Array<Effort>;
	"hard_quota_window_ids": Array<string>;
	"order_match": {
		"scope_ref": string;
		"index": number;
		"for_tags": Array<string>;
	} | null;
};

export type EngineExecutionRoutes = {
	"routes": Array<EngineExecutionRoute>;
};

export type ContinuationConfiguration = {
	"systemPrompt": string;
	"toolNames": Array<string>;
	"restrictToolNames": boolean;
	"toolPolicies": Record<string, "unrestricted" | "tracked" | "permit">;
	"enableMCP": boolean;
	"enableLsp": boolean;
	"lspShared": boolean;
	"disabledCapabilityProviders": Array<string>;
	"outputSchema": Record<string, unknown> | null;
	"requireYieldTool": boolean;
	"spawn": DispatchSpawn;
	"limits": DispatchLimits;
	"tools_permit": Array<string>;
	"tools_on_request": "auto" | "none";
	"providerPromptCacheKey": string | null;
};

export type SessionDefaults = {
	"additionalDirectories"?: Array<string>;
};

export type EngineExecutionConfiguration = {
	"dispatch": Dispatch;
	"routes": EngineExecutionRoutes;
	"continuationPolicy": "exact" | "fresh";
	"continuationConfiguration": ContinuationConfiguration;
	"stableDependencyDigest": Hash;
	"instruction_sources": InstructionSources;
	"sessionDefaults": SessionDefaults;
	"record_revisions": RecordRevisions;
	"routingLimits": RoutingLimits;
	"scope_revision": Hash;
	"roster_revision": Hash;
	"roster_complete": true;
};

export type ContinuationDigestInput = {
	"schema": "artel.continuation.v2";
	"agentInstanceRef": Agi;
	"parentAgentInstanceRef": Agi | null;
	"authorityGeneration": number;
	"canonicalCwd": string;
	"continuationPolicy": "exact" | "fresh";
	"continuationConfiguration": ContinuationConfiguration;
	"stableDependencyDigest": Hash;
	"sessionDefaults": SessionDefaults;
};

export type ExecutionDigestInput = {
	"schema": "artel.execution.v2";
	"dispatchHash": Hash;
	"executionConfiguration": EngineExecutionConfiguration;
	"record_revisions": RecordRevisions;
	"scope_revision": Hash;
	"candidates": Array<Candidate>;
	"selected": SelectedExecutor;
};

export type StartSpecialRef = {
	"definitionRef": AutomationRef | `gctx:${string}`;
	"revision": number;
	"occurrenceOrCallId": string;
};

export type ImmutableAttemptStart = {
	"commandId": string;
	"agentInstanceId": string;
	"agentInstanceRef": Agi;
	"executionId": string;
	"attemptId": string;
	"principalId": string;
	"authorityGeneration": number;
	"engineGeneration": number;
	"bindingGeneration": number;
	"cwd": string;
	"bindingSnapshot": BindingSnapshot;
	"dispatchRef": ArtifactRef;
	"dispatchHash": Hash;
	"executionKind": "ordinary" | "automation" | "consultation";
	"specialRef": StartSpecialRef | null;
	"executionDigest": Hash;
	"continuationDigest": Hash;
	"originReceiptId": string;
	"executionConfiguration": EngineExecutionConfiguration;
	"bindingId": string;
};

export type DispatchRequirementRequest = {
	"min_tier"?: number;
	"required"?: Array<"tools" | "image">;
	"required_tags"?: Array<string>;
	"preferred_tags"?: Array<string>;
	"models"?: Array<string> | null;
	"exclude"?: {
		"models"?: Array<string>;
		"families"?: Array<string>;
		"agent_instances"?: Array<Agi>;
	};
	"min_context"?: number | null;
	"min_output"?: number | null;
	"latency_ceiling_ms"?: number | null;
	"min_effort"?: Effort | null;
	"service_tier"?: ServiceTier;
	"downgrade"?: "forbidden" | "approval" | "allowed";
	"pin"?: DispatchPin | null;
	"require_trusted_provider"?: boolean;
	"fallback_mode"?: "none" | "same_model" | "scope";
};

export type DispatchSpawnRequest = {
	"allowed"?: "auto" | "no";
	"max_depth"?: number;
	"max_children"?: number;
	"on_exceed"?: "approve" | "deny";
};

export type DispatchLimitsRequest = {
	"timeout_seconds"?: number | null;
	"max_iterations"?: number | null;
};

export type RoutingLimits = {
	"scopes": Array<{
		"scope_ref": string;
		"agents": number | null;
		"by_tier": Array<{
			"tier": number;
			"value": number | null;
			"mode": "exact" | "cumulative";
		}>;
		"consultations": number | null;
	}>;
	"accounts": Record<string, number | null>;
	"providers": Record<string, number | null>;
};

export type ScopeLimitSubject = {
	"kind": "scope_limit";
	"scope_ref": string;
	"field": "agents";
	"proposed_value": number | null;
	"expected_revision": number;
	"mutation_hash": Hash;
} | {
	"kind": "scope_limit";
	"scope_ref": string;
	"field": "consultations" | "max_depth" | "max_children";
	"proposed_value": number;
	"expected_revision": number;
	"mutation_hash": Hash;
} | {
	"kind": "scope_limit";
	"scope_ref": string;
	"field": "by_tier";
	"proposed_value": Array<{
		"tier": number;
		"value": number | null;
		"mode": "exact" | "cumulative";
	}>;
	"expected_revision": number;
	"mutation_hash": Hash;
};

export type ConsultantPin = {
	"route_ref": ArtifactRef;
	"effort": Effort;
	"reason": string;
};

export type AutomationExecution = {
	"requirement": DispatchRequirement;
	"tools": Array<string> | null;
	"tools_permit": Array<string>;
	"tools_on_request": "auto" | "none";
	"spawn": DispatchSpawn;
	"skill_refs": Array<DispatchSkill>;
	"instructions": string;
	"output_schema": Record<string, unknown> | null;
	"limits": DispatchLimits;
	"preset": PresetReference | null;
};

export type WorkStep = {
	"id": string;
	"title": string;
	"status": "planned" | "active" | "waiting" | "blocked" | "completed" | "cancelled";
	"objective": string;
	"summary": string;
	"skill_refs": Array<string>;
	"context_refs": Array<string>;
	"children": Array<WorkStep>;
	"kind"?: "analysis" | "implementation" | "defect";
	"acceptance_criteria": AcceptanceCriteria;
};

export type TaskWork = {
	"current_step_id": string | null;
	"steps": Array<WorkStep>;
	"tracking"?: {
		"enabled": boolean;
		"source_ref"?: string;
	};
	"kind"?: "analysis" | "implementation" | "defect";
};

export type TaskHead = {
	"grimoire_uri": string;
	"content_hash": Hash | null;
	"created_at": string | null;
	"updated_at": string | null;
	"provenance": Record<string, unknown>;
	"freshness": Record<string, unknown>;
	"schema": "grimoire.task.v5";
	"object_kind": "task";
	"project_id": string | null;
	"task_id": string;
	"title": string;
	"objective": string;
	"status": "active" | "waiting" | "blocked" | "completed" | "cancelled";
	"user_feedback": Array<string>;
	"work": TaskWork;
	"parent_task_ref": TaskRef | null;
	"dependency_refs": Array<string>;
	"repo_refs": Array<string>;
	"accepted_result_ref": string | null;
	"responsible_agent_ref": Agi | null;
	"acceptance_criteria": AcceptanceCriteria;
	"planned_start_at": string | null;
	"planned_duration_minutes": number | null;
	"archived_at": string | null;
	"archive_bundle_ref": string | null;
	"archive_operation_id": string | null;
	"owner_principal_id": string;
	"revision": number;
	"decisions": Array<string>;
	"checks": Array<string>;
	"risks": Array<string>;
};

export type AgentHead = {
	"grimoire_uri": string;
	"content_hash": Hash | null;
	"created_at": string | null;
	"updated_at": string | null;
	"provenance": Record<string, unknown>;
	"freshness": Record<string, unknown>;
	"schema": "grimoire.agent_instance.v4";
	"object_kind": "agent_instance";
	"agent_instance_id": string;
	"agent_instance_ref": Agi;
	"project_id": string | null;
	"task_id": string | null;
	"task_ref": TaskRef | null;
	"scope_ref": string | null;
	"binding_revision": number;
	"binding_mode": "legacy_immutable" | "installation_owned";
	"execution_owner_installation_id": InstallationId | null;
	"binding_phase": "active" | "preparing" | "committed_await_adopt";
	"binding_operation_id": string | null;
	"parent_agent_ref": Agi | null;
	"work_step_id": string | null;
	"objective": string;
	"current_focus": string;
	"display_name": string;
	"delegation_hint": string;
	"name_source": string;
	"status": "active" | "waiting" | "blocked" | "completed" | "failed" | "cancelled";
	"blockers": Array<Record<string, unknown>>;
	"skill_refs": Array<string>;
	"context_refs": Array<string>;
	"output_refs": Array<string>;
	"requested_execution": RequestedExecution;
	"dispatch_ref": ArtifactRef | null;
	"visibility": "public" | "private";
	"owner_principal_id": string;
	"archived_at": string | null;
	"archived_by": string | null;
	"archive_task_operation_id": string | null;
	"revision": number;
};

export type AutomationExecutionRequest = {
	"requirement"?: DispatchRequirementRequest;
	"tools"?: Array<string> | null;
	"tools_permit"?: Array<string>;
	"tools_on_request"?: "auto" | "none";
	"spawn"?: DispatchSpawnRequest;
	"skill_refs"?: Array<DispatchSkill>;
	"instructions"?: string;
	"output_schema"?: Record<string, unknown> | null;
	"limits"?: DispatchLimitsRequest;
	"preset"?: PresetReference | null;
};

export type NativeCompatibilityDelta = {
	"supportsStore"?: boolean;
	"supportsDeveloperRole"?: boolean;
	"supportsMultipleSystemMessages"?: boolean;
	"supportsReasoningEffort"?: boolean;
	"supportsUsageInStreaming"?: boolean;
	"requiresToolResultName"?: boolean;
	"requiresAssistantAfterToolResult"?: boolean;
	"requiresThinkingAsText"?: boolean;
	"requiresMistralToolIds"?: boolean;
	"omitReasoningEffort"?: boolean;
	"includeEncryptedReasoning"?: boolean;
	"filterReasoningHistory"?: boolean;
	"requiresReasoningContentForToolCalls"?: boolean;
	"requiresReasoningContentForAllAssistantTurns"?: boolean;
	"allowsSyntheticReasoningContentForToolCalls"?: boolean;
	"replayReasoningContent"?: boolean;
	"qwenPreserveThinking"?: boolean;
	"qwenTemplateReasoningEffort"?: boolean;
	"requiresAssistantContentForToolCalls"?: boolean;
	"supportsToolChoice"?: boolean;
	"supportsForcedToolChoice"?: boolean;
	"supportsNamedToolChoice"?: boolean;
	"disableReasoningOnForcedToolChoice"?: boolean;
	"disableReasoningOnToolChoice"?: boolean;
	"supportsPromptCacheBreakpoints"?: boolean;
	"supportsStrictMode"?: boolean;
	"supportsLongPromptCacheRetention"?: boolean;
	"supportsReasoningParams"?: boolean;
	"supportsSamplingParams"?: boolean;
	"supportsPenaltyAndStopParams"?: boolean;
	"alwaysSendMaxTokens"?: boolean;
	"strictResponsesPairing"?: boolean;
	"supportsImageDetailOriginal"?: boolean;
	"reasoningDeltasMayBeCumulative"?: boolean;
	"stripDeepseekSpecialTokens"?: boolean;
	"emptyLengthFinishIsContextError"?: boolean;
	"usesOpenAIToolCallIdLimit"?: boolean;
	"disableAdaptiveThinking"?: boolean;
	"supportsEagerToolInputStreaming"?: boolean;
	"supportsLongCacheRetention"?: boolean;
	"supportsMidConversationSystem"?: boolean;
	"requiresToolResultId"?: boolean;
	"allowAnthropicHeaderOverrides"?: boolean;
	"replayUnsignedThinking"?: boolean;
	"requiresThinkingEnabled"?: boolean;
	"escapeBuiltinToolNames"?: boolean;
	"signingEndpoint"?: boolean;
	"reasoningEffortMap"?: {
		"none"?: string;
		"minimal"?: string;
		"low"?: string;
		"medium"?: string;
		"high"?: string;
		"xhigh"?: string;
		"max"?: string;
	};
	"maxTokensField"?: "max_completion_tokens" | "max_tokens";
	"thinkingFormat"?: "openai" | "openrouter" | "zai" | "kimi" | "qwen" | "qwen-chat-template" | "chat-template";
	"kimiApiFormat"?: "openai" | "anthropic";
	"reasoningDisableMode"?: "omit" | "lowest-effort" | "none-effort" | "openrouter-enabled-false" | "venice-disable-thinking" | "zai-thinking-disabled" | "qwen-enable-thinking-false" | "qwen-template-false" | "chat-template-thinking-false";
	"thinkingKeep"?: "all" | false;
	"reasoningContentField"?: "reasoning_content" | "reasoning" | "reasoning_text";
	"openRouterRouting"?: {
		"only"?: Array<string>;
		"order"?: Array<string>;
	};
	"vercelGatewayRouting"?: {
		"only"?: Array<string>;
		"order"?: Array<string>;
		"caching"?: "auto";
		"cacheAnchorItems"?: number;
		"cacheTtl"?: "5m" | "1h";
	};
	"extraBody"?: Record<string, unknown>;
	"promptCacheSessionHeader"?: "x-grok-conv-id";
	"cacheControlFormat"?: "anthropic";
	"promptCacheBreakpointTtl"?: "30m";
	"toolSchemaFlavor"?: "moonshot-mfjs" | "grammar" | "none";
	"streamFirstEventTimeoutMs"?: number;
	"streamIdleTimeoutMs"?: number;
	"toolStrictMode"?: "all_strict" | "none";
	"streamMarkupHealingPattern"?: "kimi" | "dsml" | "qwen" | "thinking";
	"disable_strict_tools"?: boolean;
};

export type NativeCompatibility = {
	"supportsStore"?: boolean;
	"supportsDeveloperRole"?: boolean;
	"supportsMultipleSystemMessages"?: boolean;
	"supportsReasoningEffort"?: boolean;
	"supportsUsageInStreaming"?: boolean;
	"requiresToolResultName"?: boolean;
	"requiresAssistantAfterToolResult"?: boolean;
	"requiresThinkingAsText"?: boolean;
	"requiresMistralToolIds"?: boolean;
	"omitReasoningEffort"?: boolean;
	"includeEncryptedReasoning"?: boolean;
	"filterReasoningHistory"?: boolean;
	"requiresReasoningContentForToolCalls"?: boolean;
	"requiresReasoningContentForAllAssistantTurns"?: boolean;
	"allowsSyntheticReasoningContentForToolCalls"?: boolean;
	"replayReasoningContent"?: boolean;
	"qwenPreserveThinking"?: boolean;
	"qwenTemplateReasoningEffort"?: boolean;
	"requiresAssistantContentForToolCalls"?: boolean;
	"supportsToolChoice"?: boolean;
	"supportsForcedToolChoice"?: boolean;
	"supportsNamedToolChoice"?: boolean;
	"disableReasoningOnForcedToolChoice"?: boolean;
	"disableReasoningOnToolChoice"?: boolean;
	"supportsPromptCacheBreakpoints"?: boolean;
	"supportsStrictMode"?: boolean;
	"supportsLongPromptCacheRetention"?: boolean;
	"supportsReasoningParams"?: boolean;
	"supportsSamplingParams"?: boolean;
	"supportsPenaltyAndStopParams"?: boolean;
	"alwaysSendMaxTokens"?: boolean;
	"strictResponsesPairing"?: boolean;
	"supportsImageDetailOriginal"?: boolean;
	"reasoningDeltasMayBeCumulative"?: boolean;
	"stripDeepseekSpecialTokens"?: boolean;
	"emptyLengthFinishIsContextError"?: boolean;
	"usesOpenAIToolCallIdLimit"?: boolean;
	"disableAdaptiveThinking"?: boolean;
	"supportsEagerToolInputStreaming"?: boolean;
	"supportsLongCacheRetention"?: boolean;
	"supportsMidConversationSystem"?: boolean;
	"requiresToolResultId"?: boolean;
	"allowAnthropicHeaderOverrides"?: boolean;
	"replayUnsignedThinking"?: boolean;
	"requiresThinkingEnabled"?: boolean;
	"escapeBuiltinToolNames"?: boolean;
	"signingEndpoint"?: boolean;
	"reasoningEffortMap"?: {
		"none"?: string;
		"minimal"?: string;
		"low"?: string;
		"medium"?: string;
		"high"?: string;
		"xhigh"?: string;
		"max"?: string;
	};
	"maxTokensField"?: "max_completion_tokens" | "max_tokens";
	"thinkingFormat"?: "openai" | "openrouter" | "zai" | "kimi" | "qwen" | "qwen-chat-template" | "chat-template";
	"kimiApiFormat"?: "openai" | "anthropic";
	"reasoningDisableMode"?: "omit" | "lowest-effort" | "none-effort" | "openrouter-enabled-false" | "venice-disable-thinking" | "zai-thinking-disabled" | "qwen-enable-thinking-false" | "qwen-template-false" | "chat-template-thinking-false";
	"thinkingKeep"?: "all" | false;
	"reasoningContentField"?: "reasoning_content" | "reasoning" | "reasoning_text";
	"openRouterRouting"?: {
		"only"?: Array<string>;
		"order"?: Array<string>;
	};
	"vercelGatewayRouting"?: {
		"only"?: Array<string>;
		"order"?: Array<string>;
		"caching"?: "auto";
		"cacheAnchorItems"?: number;
		"cacheTtl"?: "5m" | "1h";
	};
	"extraBody"?: Record<string, unknown>;
	"promptCacheSessionHeader"?: "x-grok-conv-id";
	"cacheControlFormat"?: "anthropic";
	"promptCacheBreakpointTtl"?: "30m";
	"toolSchemaFlavor"?: "moonshot-mfjs" | "grammar" | "none";
	"streamFirstEventTimeoutMs"?: number;
	"streamIdleTimeoutMs"?: number;
	"toolStrictMode"?: "all_strict" | "none";
	"streamMarkupHealingPattern"?: "kimi" | "dsml" | "qwen" | "thinking";
	"disable_strict_tools"?: boolean;
	"whenThinking"?: NativeCompatibilityDelta;
};

export type ProviderApi = "openai-completions" | "openai-responses" | "openai-codex-responses" | "azure-openai-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai" | "google-gemini-cli" | "google-vertex" | "cursor-agent";

export type ExecutionDescriptor = {
	"api": ProviderApi;
	"base_url": string;
	"provider_model_id": string;
	"context_window": number | null;
	"max_output_tokens": number | null;
	"input_modalities": Array<"text" | "image">;
	"supports_tools": boolean;
	"supports_reasoning": boolean;
	"header_refs": Array<string>;
	"compat": NativeCompatibility | null;
	"route_content_hash": Hash;
	"account_content_hash": Hash;
	"display_name": string;
	"efforts": Array<Effort>;
	"trusted": boolean;
	"credential": {
		"method": "api_key" | "oauth" | "cli" | "none";
		"local_ref": string | null;
		"hosted_ref": string | null;
		"generation": number;
	};
	"account_binding_id": string | null;
};

export type ApprovalResolved = {
	"request_id": string;
	"decision_revision": number;
	"outcome": "approved" | "denied";
	"decided_by": ApprovalDecider;
} | {
	"request_id": string;
	"decision_revision": number;
	"outcome": "cancelled";
	"decided_by": ApprovalDecider | null;
};

export type ApprovalEscalated = {
	"request_id": string;
	"address_revision": number;
	"from": ApprovalAddressee;
	"to": ApprovalAddressee;
	"expires_at": string | null;
};

export type ApprovalTimedOut = {
	"request_id": string;
	"address_revision": number;
	"status": "pending" | "waiting_human_paused";
};

export type ApprovalEvent = {
	"kind": "tool_approval_requested";
	"payload": ApprovalRequest;
} | {
	"kind": "tool_approval_resolved";
	"payload": ApprovalResolved;
} | {
	"kind": "spawn_approval_requested";
	"payload": ApprovalRequest;
} | {
	"kind": "spawn_approval_resolved";
	"payload": ApprovalResolved;
} | {
	"kind": "escalation_approval_requested";
	"payload": ApprovalRequest;
} | {
	"kind": "escalation_approval_resolved";
	"payload": ApprovalResolved;
} | {
	"kind": "consultant_approval_requested";
	"payload": ApprovalRequest;
} | {
	"kind": "consultant_approval_resolved";
	"payload": ApprovalResolved;
} | {
	"kind": "approval_escalated";
	"payload": ApprovalEscalated;
} | {
	"kind": "approval_timed_out";
	"payload": ApprovalTimedOut;
};

export type EngineNativeTarget = {
	"bindingId": string;
	"agentInstanceId": string;
	"executionId": string;
	"attemptId": string;
	"authorityGeneration": number;
	"engineGeneration": number;
	"bindingGeneration": number;
};

export type EngineHistoryEdit = {
	"expectedSourceIntentRevision"?: number;
	"mode": "edit" | "branch";
	"source": EngineNativeTarget;
	"sourceSessionId": string;
	"expectedLeafEntryId": string;
	"entryId": string;
	"replacementText"?: string;
};

export type EngineControlInitiator = {
	"kind": "human";
} | {
	"kind": "agent";
	"agentInstanceId": string;
	"agentInstanceRef": Agi;
};

export type EngineStartPayload = {
	"executionConfiguration": EngineExecutionConfiguration;
	"dispatchRef": ArtifactRef;
	"dispatchHash": Hash;
	"executionKind": "ordinary" | "automation" | "consultation";
	"specialRef": StartSpecialRef | null;
	"originReceiptId": string;
	"cwd": string;
	"input"?: string;
	"context"?: string;
	"clientMessageId"?: string;
	"attachmentUploadIds"?: AttachmentUploadIds;
	"displayName"?: string;
	"delegationHint"?: string;
	"historyEdit"?: EngineHistoryEdit;
	"restoreCheckpoint"?: {
		"restoreId": string;
		"contentHash": Hash;
	};
	"queueId"?: string;
	"expectedRevision"?: number;
	"mutationId"?: string;
	"expectedIntentRevision"?: number;
	"explicitContinue"?: boolean;
};

export type EngineSteerPayload = {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"text": string;
	"clientMessageId": string;
	"attachmentUploadIds"?: AttachmentUploadIds;
	"context"?: string;
} | {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"queueId": string;
	"expectedRevision": number;
	"mutationId": string;
	"context"?: string;
};

export type EnginePausePayload = {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"initiator": EngineControlInitiator;
};

export type EngineResumePayload = {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"initiator": EngineControlInitiator;
} | {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"initiator": EngineControlInitiator;
	"text": string;
	"clientMessageId": string;
	"attachmentUploadIds"?: AttachmentUploadIds;
	"context"?: string;
};

export type EngineCancelPayload = {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"reason"?: string;
	"pendingStartCommandId"?: string;
	"expectedStartIntentRevision"?: number;
};

export type EngineSimpleControlPayload = {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
};

export type EngineResolveApprovalPayload = {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"expectedInputRevision"?: number;
	"approvalDecision": ApprovalDecision;
};

export type EngineResolveInputPayload = {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"expectedInputRevision"?: number;
	"inputId": string;
	"result": {
		"kind": "chat";
	} | {
		"kind": "submit";
		"results": Array<IndexedQuestionAnswer>;
	};
};

export type EngineEnqueuePayload = {
	"originReceiptId": string;
	"expectedIntentRevision"?: number;
	"text": string;
	"clientMessageId": string;
	"attachmentUploadIds"?: AttachmentUploadIds;
	"deliverAt"?: number;
};

export type EngineQueueTextPayload = {
	"originReceiptId": string;
	"queueId": string;
	"mutationId": string;
	"expectedRevision": number;
	"text": string;
};

export type EngineQueueRemovePayload = {
	"originReceiptId": string;
	"queueId": string;
	"mutationId": string;
	"expectedRevision": number;
};

export type EngineQueueDeferPayload = {
	"originReceiptId": string;
	"queueId": string;
	"mutationId": string;
	"expectedRevision": number;
	"deliverAt": number | null;
};

export type EngineQueueReorderPayload = {
	"originReceiptId": string;
	"mutationId": string;
	"expectedOrder": Array<string>;
	"desiredOrder": Array<string>;
	"expectedQueueRevision": number;
};

export type EngineCommandPayload = {
	"op": "start";
	"payload": EngineStartPayload;
} | {
	"op": "steer";
	"payload": EngineSteerPayload;
} | {
	"op": "pause";
	"payload": EnginePausePayload;
} | {
	"op": "resume";
	"payload": EngineResumePayload;
} | {
	"op": "cancel";
	"payload": EngineCancelPayload;
} | {
	"op": "compact";
	"payload": EngineSimpleControlPayload;
} | {
	"op": "release";
	"payload": EngineSimpleControlPayload;
} | {
	"op": "reconcile";
	"payload": EngineSimpleControlPayload;
} | {
	"op": "resolve_approval";
	"payload": EngineResolveApprovalPayload;
} | {
	"op": "resolve_input";
	"payload": EngineResolveInputPayload;
} | {
	"op": "enqueue";
	"payload": EngineEnqueuePayload;
} | {
	"op": "queue_edit";
	"payload": EngineQueueTextPayload;
} | {
	"op": "queue_remove";
	"payload": EngineQueueRemovePayload;
} | {
	"op": "queue_reorder";
	"payload": EngineQueueReorderPayload;
} | {
	"op": "queue_annotate";
	"payload": EngineQueueTextPayload;
} | {
	"op": "queue_defer";
	"payload": EngineQueueDeferPayload;
};

export type ProviderAccount = {
	"account_ref": string;
	"created_at"?: string;
	"credential": {
		"generation": number;
		"hosted_ref": string | null;
		"local_ref": string | null;
		"method": "api_key" | "oauth" | "cli" | "none";
		"status": "pending" | "ready" | "revoked";
	};
	"display_name": string;
	"external_id"?: string | null;
	"headers"?: Record<string, string>;
	"max_concurrent"?: number | null;
	"owner_principal_id": string;
	"pools": Array<BillingPool>;
	"promoted_from"?: string;
	"provider_id": string;
	"quota_windows": Array<QuotaWindow>;
	"revision": number;
	"schema": "grimoire.provider_account.v2";
	"tags"?: Array<string>;
	"updated_at"?: string;
	"usage_probe": {
		"builtin_id": string | null;
		"interval_seconds"?: number;
		"kind": "manual" | "builtin" | "module";
		"stale_after_seconds"?: number;
	};
};

export type Consultant = {
	"consultant_id": string;
	"created_at"?: string;
	"description"?: string;
	"display_name": string;
	"input": {
		"materializer": {
			"kind": string;
			"maxBytes": number;
		} | null;
		"schema": Record<string, unknown>;
	};
	"instructions": string;
	"limits": DispatchLimits;
	"on_pin_unavailable"?: "reselect" | "ask" | "fail";
	"output": {
		"format": "text" | "json";
		"maxBytes": number;
		"schema": Record<string, unknown> | null;
		"semanticValidator": string | null;
	};
	"owner_principal_id"?: string;
	"pin"?: {
		"effort": "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
		"reason": string;
		"route_ref": string;
	} | null;
	"promoted_from"?: string;
	"requirement": DispatchRequirement;
	"revision": number;
	"schema": "grimoire.consultant.v2";
	"scope"?: {
		"project": string | null;
		"task": string | null;
	} | null;
	"skill_refs": Array<DispatchSkill>;
	"tools": {
		"mode": "none";
	};
	"updated_at"?: string;
};

export type UserModel = {
	"aliases"?: Array<string>;
	"autoselect"?: "auto" | "grant_only" | "manual";
	"content_hash": string;
	"context_window"?: number | null;
	"created_at"?: string;
	"default_effort"?: "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
	"deprecated_reason"?: string;
	"display_name": string;
	"efforts"?: Array<"high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh">;
	"family": string;
	"input_modalities"?: Array<"text" | "image">;
	"list_price"?: Price | null;
	"max_output_tokens"?: number | null;
	"model_id": string;
	"notes"?: string;
	"owner_principal_id": string;
	"promoted_from"?: string;
	"replaced_by"?: string;
	"revision": number;
	"schema": "grimoire.user_model.v1";
	"source"?: {
		"content_hash": string;
		"ref": string;
		"revision": number;
	} | null;
	"status": "active" | "deprecated";
	"supports_tools"?: boolean;
	"tags"?: Array<string>;
	"tier"?: {
		"*"?: number | null;
		"high"?: number | null;
		"low"?: number | null;
		"max"?: number | null;
		"medium"?: number | null;
		"minimal"?: number | null;
		"none"?: number | null;
		"xhigh"?: number | null;
	};
	"updated_at"?: string;
};

export type UserProvider = {
	"api": "anthropic-messages" | "azure-openai-responses" | "bedrock-converse-stream" | "cursor-agent" | "google-gemini-cli" | "google-generative-ai" | "google-vertex" | "openai-codex-responses" | "openai-completions" | "openai-responses";
	"auth_header"?: boolean;
	"auth_methods": Array<"api_key" | "oauth" | "cli" | "none">;
	"base_url": string;
	"compat"?: NativeCompatibility;
	"content_hash": string;
	"created_at"?: string;
	"deprecated_reason"?: string;
	"description"?: string;
	"discovery"?: {
		"inject_v1"?: boolean;
		"timeout_ms"?: number;
		"type": "openai-models-list" | "proxy" | "litellm" | "ollama" | "llama.cpp" | "lm-studio";
	};
	"display_name": string;
	"headers"?: Record<string, string>;
	"max_concurrent"?: number | null;
	"owner_principal_id": string;
	"promoted_from"?: string;
	"provider_id": string;
	"replaced_by"?: string;
	"revision": number;
	"schema": "grimoire.user_provider.v1";
	"source"?: {
		"content_hash": string;
		"ref": string;
		"revision": number;
	} | null;
	"status": "active" | "deprecated";
	"tags"?: Array<string>;
	"trusted": boolean;
	"updated_at"?: string;
};

export type AvailableModelRoute = {
	"account_ref": string;
	"autoselect"?: "auto" | "grant_only" | "manual";
	"compat"?: NativeCompatibility;
	"context_window"?: number | null;
	"created_at"?: string;
	"default_effort"?: "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
	"display_name"?: string;
	"efforts"?: Array<"high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh">;
	"input_modalities"?: Array<"text" | "image">;
	"max_output_tokens"?: number | null;
	"model_id": string;
	"notes"?: string;
	"owner_principal_id": string;
	"pools": Array<string>;
	"price"?: Price | null;
	"promoted_from"?: string;
	"provider_model_id": string;
	"quota_windows"?: Array<string>;
	"revision": number;
	"route_ref": string;
	"schema": "grimoire.available_model_route.v2";
	"service_tiers"?: Array<"standard" | "priority" | "flex">;
	"supports_tools"?: boolean;
	"tags"?: {
		"add": Array<string>;
		"remove": Array<string>;
	};
	"tier_cap"?: number | null;
	"updated_at"?: string;
};

export type Rule = {
	"applies_when": {
		"binding"?: Array<"task" | "step" | "consultation" | "automation">;
		"engine_version"?: Array<string>;
		"family"?: Array<string>;
		"model"?: Array<string>;
		"os"?: Array<string>;
		"provider"?: Array<string>;
		"runtime"?: Array<string>;
		"scope"?: Array<string>;
	};
	"content": string;
	"created_at"?: string;
	"description"?: string;
	"display_name": string;
	"owner_principal_id"?: string;
	"promoted_from"?: string;
	"revision": number;
	"rule_id": string;
	"schema": "grimoire.rule.v1";
	"source"?: {
		"content_hash": string;
		"ref": string;
		"revision": number;
	} | null;
	"status": "active" | "disabled";
	"updated_at"?: string;
};

export type ScopeLimits = {
	"agents"?: number | null;
	"allow"?: Array<{
		"id": string;
		"kind": "provider" | "account" | "model" | "route";
	} | {
		"effort": "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
		"id": string;
		"kind": "model_effort";
	}>;
	"by_tier"?: Array<{
		"mode": "exact" | "cumulative";
		"tier": number;
		"value": number | null;
	}>;
	"consultations"?: number;
	"created_at"?: string;
	"deny"?: Array<{
		"id": string;
		"kind": "provider" | "account" | "model" | "route";
	} | {
		"effort": "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
		"id": string;
		"kind": "model_effort";
	}>;
	"fallback"?: {
		"downgrade": boolean;
		"same_model_other_pool": boolean;
		"same_tier_any_model": boolean;
	};
	"grants"?: Array<string>;
	"max_children"?: number;
	"max_depth"?: number;
	"order"?: Array<{
		"for_tags": Array<string>;
		"target": {
			"id": string;
			"kind": "provider" | "account" | "model" | "route";
		} | {
			"effort": "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
			"id": string;
			"kind": "model_effort";
		};
	}>;
	"owner": string;
	"promoted_from"?: string;
	"revision": number;
	"schema": "grimoire.scope_limits.v1";
	"scope": {
		"project_id": string | null;
		"task_ref": string | null;
	};
	"skill_refs"?: Array<string>;
	"tools_deny"?: Array<string>;
	"updated_at"?: string;
};

export type Tag = {
	"applies_to": Array<"model" | "route" | "provider" | "account">;
	"content_hash"?: string;
	"created_at"?: string;
	"description": string;
	"owner_principal_id"?: string;
	"promoted_from"?: string;
	"revision": number;
	"schema": "grimoire.tag.v1";
	"status": "active" | "deprecated";
	"tag_id": string;
	"updated_at"?: string;
};

export type ExecutorGlobalSettingsRequest = {
	"schema"?: "grimoire.executor_global_settings.v1";
	"owner_principal_id"?: string;
	"preset_mode"?: "off" | "on" | "auto";
	"auto_max_tier_on"?: number;
	"approval_timeout_seconds"?: number;
	"dispatch_defaults"?: DispatchDefaults;
	"revision"?: number;
};

export type ProviderAccountRequest = {
	"account_ref"?: string;
	"created_at"?: string;
	"credential": {
		"generation": number;
		"hosted_ref": string | null;
		"local_ref": string | null;
		"method": "api_key" | "oauth" | "cli" | "none";
		"status": "pending" | "ready" | "revoked";
	};
	"display_name": string;
	"external_id"?: string | null;
	"headers"?: Record<string, string>;
	"max_concurrent"?: number | null;
	"owner_principal_id"?: string;
	"pools": Array<BillingPool>;
	"promoted_from"?: string;
	"provider_id": string;
	"quota_windows": Array<QuotaWindow>;
	"revision"?: number;
	"schema"?: "grimoire.provider_account.v2";
	"tags"?: Array<string>;
	"updated_at"?: string;
	"usage_probe": {
		"builtin_id": string | null;
		"interval_seconds"?: number;
		"kind": "manual" | "builtin" | "module";
		"stale_after_seconds"?: number;
	};
};

export type ConsultantRequest = {
	"consultant_id": string;
	"created_at"?: string;
	"description"?: string;
	"display_name": string;
	"input": {
		"materializer": {
			"kind": string;
			"maxBytes": number;
		} | null;
		"schema": Record<string, unknown>;
	};
	"instructions": string;
	"limits": DispatchLimits;
	"on_pin_unavailable"?: "reselect" | "ask" | "fail";
	"output": {
		"format": "text" | "json";
		"maxBytes": number;
		"schema": Record<string, unknown> | null;
		"semanticValidator": string | null;
	};
	"owner_principal_id"?: string;
	"pin"?: {
		"effort": "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
		"reason": string;
		"route_ref": string;
	} | null;
	"promoted_from"?: string;
	"requirement": DispatchRequirement;
	"revision"?: number;
	"schema"?: "grimoire.consultant.v2";
	"scope"?: {
		"project": string | null;
		"task": string | null;
	} | null;
	"skill_refs": Array<DispatchSkill>;
	"tools": {
		"mode": "none";
	};
	"updated_at"?: string;
};

export type UserModelRequest = {
	"aliases"?: Array<string>;
	"autoselect"?: "auto" | "grant_only" | "manual";
	"content_hash"?: string;
	"context_window"?: number | null;
	"created_at"?: string;
	"default_effort"?: "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
	"deprecated_reason"?: string;
	"display_name": string;
	"efforts"?: Array<"high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh">;
	"family": string;
	"input_modalities"?: Array<"text" | "image">;
	"list_price"?: Price | null;
	"max_output_tokens"?: number | null;
	"model_id": string;
	"notes"?: string;
	"owner_principal_id"?: string;
	"promoted_from"?: string;
	"replaced_by"?: string;
	"revision"?: number;
	"schema"?: "grimoire.user_model.v1";
	"source"?: {
		"content_hash": string;
		"ref": string;
		"revision": number;
	} | null;
	"status": "active" | "deprecated";
	"supports_tools"?: boolean;
	"tags"?: Array<string>;
	"tier"?: {
		"*"?: number | null;
		"high"?: number | null;
		"low"?: number | null;
		"max"?: number | null;
		"medium"?: number | null;
		"minimal"?: number | null;
		"none"?: number | null;
		"xhigh"?: number | null;
	};
	"updated_at"?: string;
};

export type UserProviderRequest = {
	"api": "anthropic-messages" | "azure-openai-responses" | "bedrock-converse-stream" | "cursor-agent" | "google-gemini-cli" | "google-generative-ai" | "google-vertex" | "openai-codex-responses" | "openai-completions" | "openai-responses";
	"auth_header"?: boolean;
	"auth_methods": Array<"api_key" | "oauth" | "cli" | "none">;
	"base_url": string;
	"compat"?: NativeCompatibility;
	"content_hash"?: string;
	"created_at"?: string;
	"deprecated_reason"?: string;
	"description"?: string;
	"discovery"?: {
		"inject_v1"?: boolean;
		"timeout_ms"?: number;
		"type": "openai-models-list" | "proxy" | "litellm" | "ollama" | "llama.cpp" | "lm-studio";
	};
	"display_name": string;
	"headers"?: Record<string, string>;
	"max_concurrent"?: number | null;
	"owner_principal_id"?: string;
	"promoted_from"?: string;
	"provider_id": string;
	"replaced_by"?: string;
	"revision"?: number;
	"schema"?: "grimoire.user_provider.v1";
	"source"?: {
		"content_hash": string;
		"ref": string;
		"revision": number;
	} | null;
	"status": "active" | "deprecated";
	"tags"?: Array<string>;
	"trusted": boolean;
	"updated_at"?: string;
};

export type AvailableModelRouteRequest = {
	"account_ref": string;
	"autoselect"?: "auto" | "grant_only" | "manual";
	"compat"?: NativeCompatibility;
	"context_window"?: number | null;
	"created_at"?: string;
	"default_effort"?: "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
	"display_name"?: string;
	"efforts"?: Array<"high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh">;
	"input_modalities"?: Array<"text" | "image">;
	"max_output_tokens"?: number | null;
	"model_id": string;
	"notes"?: string;
	"owner_principal_id"?: string;
	"pools": Array<string>;
	"price"?: Price | null;
	"promoted_from"?: string;
	"provider_model_id": string;
	"quota_windows"?: Array<string>;
	"revision"?: number;
	"route_ref"?: string;
	"schema"?: "grimoire.available_model_route.v2";
	"service_tiers"?: Array<"standard" | "priority" | "flex">;
	"supports_tools"?: boolean;
	"tags"?: {
		"add": Array<string>;
		"remove": Array<string>;
	};
	"tier_cap"?: number | null;
	"updated_at"?: string;
};

export type RuleRequest = {
	"applies_when": {
		"binding"?: Array<"task" | "step" | "consultation" | "automation">;
		"engine_version"?: Array<string>;
		"family"?: Array<string>;
		"model"?: Array<string>;
		"os"?: Array<string>;
		"provider"?: Array<string>;
		"runtime"?: Array<string>;
		"scope"?: Array<string>;
	};
	"content": string;
	"created_at"?: string;
	"description"?: string;
	"display_name": string;
	"owner_principal_id"?: string;
	"promoted_from"?: string;
	"revision"?: number;
	"rule_id": string;
	"schema"?: "grimoire.rule.v1";
	"source"?: {
		"content_hash": string;
		"ref": string;
		"revision": number;
	} | null;
	"status": "active" | "disabled";
	"updated_at"?: string;
};

export type ScopeLimitsRequest = {
	"agents"?: number | null;
	"allow"?: Array<{
		"id": string;
		"kind": "provider" | "account" | "model" | "route";
	} | {
		"effort": "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
		"id": string;
		"kind": "model_effort";
	}>;
	"by_tier"?: Array<{
		"mode": "exact" | "cumulative";
		"tier": number;
		"value": number | null;
	}>;
	"consultations"?: number;
	"created_at"?: string;
	"deny"?: Array<{
		"id": string;
		"kind": "provider" | "account" | "model" | "route";
	} | {
		"effort": "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
		"id": string;
		"kind": "model_effort";
	}>;
	"fallback"?: {
		"downgrade": boolean;
		"same_model_other_pool": boolean;
		"same_tier_any_model": boolean;
	};
	"grants"?: Array<string>;
	"max_children"?: number;
	"max_depth"?: number;
	"order"?: Array<{
		"for_tags": Array<string>;
		"target": {
			"id": string;
			"kind": "provider" | "account" | "model" | "route";
		} | {
			"effort": "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
			"id": string;
			"kind": "model_effort";
		};
	}>;
	"owner"?: string;
	"promoted_from"?: string;
	"revision"?: number;
	"schema"?: "grimoire.scope_limits.v1";
	"scope": {
		"project_id": string | null;
		"task_ref": string | null;
	};
	"skill_refs"?: Array<string>;
	"tools_deny"?: Array<string>;
	"updated_at"?: string;
};

export type TagRequest = {
	"applies_to": Array<"model" | "route" | "provider" | "account">;
	"content_hash"?: string;
	"created_at"?: string;
	"description": string;
	"owner_principal_id"?: string;
	"promoted_from"?: string;
	"revision"?: number;
	"schema"?: "grimoire.tag.v1";
	"status": "active" | "deprecated";
	"tag_id": string;
	"updated_at"?: string;
};

export type DispatchPresetRequest = {
	"schema"?: "grimoire.dispatch_preset.v1";
	"preset_id": string;
	"display_name": string;
	"description": string;
	"fields": {
		"prompt"?: string;
		"instructions"?: string;
		"skill_refs"?: Array<DispatchSkill>;
		"display_name"?: string | null;
		"preset"?: PresetReference | null;
		"tools"?: Array<string> | null;
		"tools_permit"?: Array<string>;
		"tools_on_request"?: "auto" | "none";
		"spawn"?: DispatchSpawnRequest;
		"requirement"?: DispatchRequirementRequest;
		"output_schema"?: Record<string, unknown> | null;
		"limits"?: DispatchLimitsRequest;
	};
	"revision"?: number;
	"source": SourceCopy | null;
};

export type RosterRequest = {
	"target": WorkTarget | null;
	"project_id": string | null;
	"device_id": string;
};

export type ExecutorSettingsRequest = {
	"kind": "global";
	"action": "list";
} | {
	"kind": "global";
	"action": "get";
	"ref"?: ArtifactRef;
} | {
	"kind": "global";
	"action": "create";
	"id"?: string;
	"data": ExecutorGlobalSettingsRequest;
} | {
	"kind": "global";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": ExecutorGlobalSettingsRequest;
} | {
	"kind": "global";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "account";
	"action": "list";
} | {
	"kind": "account";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "account";
	"action": "create";
	"id"?: string;
	"data": ProviderAccountRequest;
} | {
	"kind": "account";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": ProviderAccountRequest;
} | {
	"kind": "account";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "account";
	"action": "get";
	"id": string;
} | {
	"kind": "account";
	"action": "record_metric";
	"ref": ArtifactRef;
	"observation": {
		"metric": string;
		"dimension": "pool" | "quota_window" | "route";
		"dimension_id": string;
		"value": number | string;
		"unit"?: string | null;
		"observed_at"?: string;
		"resets_at"?: string | null;
		"window_start"?: string | null;
		"window_end"?: string | null;
	};
} | {
	"kind": "consultant";
	"action": "list";
} | {
	"kind": "consultant";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "consultant";
	"action": "create";
	"id"?: string;
	"data": ConsultantRequest;
} | {
	"kind": "consultant";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": ConsultantRequest;
} | {
	"kind": "consultant";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "consultant";
	"action": "get";
	"id": string;
} | {
	"kind": "model";
	"action": "list";
} | {
	"kind": "model";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "model";
	"action": "create";
	"id"?: string;
	"data": UserModelRequest;
} | {
	"kind": "model";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": UserModelRequest;
} | {
	"kind": "model";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "model";
	"action": "get";
	"id": string;
} | {
	"kind": "provider";
	"action": "list";
} | {
	"kind": "provider";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "provider";
	"action": "create";
	"id"?: string;
	"data": UserProviderRequest;
} | {
	"kind": "provider";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": UserProviderRequest;
} | {
	"kind": "provider";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "provider";
	"action": "get";
	"id": string;
} | {
	"kind": "route";
	"action": "list";
} | {
	"kind": "route";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "route";
	"action": "create";
	"id"?: string;
	"data": AvailableModelRouteRequest;
} | {
	"kind": "route";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": AvailableModelRouteRequest;
} | {
	"kind": "route";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "route";
	"action": "get";
	"id": string;
} | {
	"kind": "rule";
	"action": "list";
} | {
	"kind": "rule";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "rule";
	"action": "create";
	"id"?: string;
	"data": RuleRequest;
} | {
	"kind": "rule";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": RuleRequest;
} | {
	"kind": "rule";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "rule";
	"action": "get";
	"id": string;
} | {
	"kind": "scope_limits";
	"action": "list";
} | {
	"kind": "scope_limits";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "scope_limits";
	"action": "create";
	"id"?: string;
	"data": ScopeLimitsRequest;
} | {
	"kind": "scope_limits";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": ScopeLimitsRequest;
} | {
	"kind": "scope_limits";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "scope_limits";
	"action": "get";
	"id": string;
} | {
	"kind": "tag";
	"action": "list";
} | {
	"kind": "tag";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "tag";
	"action": "create";
	"id"?: string;
	"data": TagRequest;
} | {
	"kind": "tag";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": TagRequest;
} | {
	"kind": "tag";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "tag";
	"action": "get";
	"id": string;
} | {
	"kind": "preset";
	"action": "list";
} | {
	"kind": "preset";
	"action": "get";
	"ref": ArtifactRef;
} | {
	"kind": "preset";
	"action": "create";
	"id"?: string;
	"data": DispatchPresetRequest;
} | {
	"kind": "preset";
	"action": "update";
	"ref": ArtifactRef;
	"expected_revision": number;
	"data": DispatchPresetRequest;
} | {
	"kind": "preset";
	"action": "archive";
	"ref": ArtifactRef;
	"expected_revision": number;
} | {
	"kind": "preset";
	"action": "get";
	"id": string;
} | {
	"action": "propose";
	"kind": "preset";
	"ref": ArtifactRef | null;
	"expected_revision": number;
	"change": DispatchPresetRequest;
	"reason": string;
} | {
	"kind": "graph";
	"action": "plan_executor_graph";
	"source_ref": null;
	"source_revision": 0;
	"source_hash": null;
	"payer_principal_id": string;
	"records": Array<{
		"ref": ArtifactRef;
		"expected_revision": number;
		"data": UserProviderRequest | UserModelRequest | ProviderAccountRequest | AvailableModelRouteRequest;
	}>;
} | {
	"kind": "graph";
	"action": "plan_executor_graph";
	"source_ref": ArtifactRef;
	"source_revision": number;
	"source_hash": Hash;
	"payer_principal_id": string;
	"records": Array<{
		"ref": ArtifactRef;
		"expected_revision": number;
		"data": UserProviderRequest | UserModelRequest | ProviderAccountRequest | AvailableModelRouteRequest;
	}>;
} | {
	"kind": "graph";
	"action": "publish_executor_graph";
	"source_ref": null;
	"source_revision": 0;
	"source_hash": null;
	"payer_principal_id": string;
	"records": Array<{
		"ref": ArtifactRef;
		"expected_revision": number;
		"data": UserProviderRequest | UserModelRequest | ProviderAccountRequest | AvailableModelRouteRequest;
	}>;
	"expected_graph_hash": Hash;
	"expected_policy_hash": Hash;
	"expected_after_policy_hash": Hash;
} | {
	"kind": "graph";
	"action": "publish_executor_graph";
	"source_ref": ArtifactRef;
	"source_revision": number;
	"source_hash": Hash;
	"payer_principal_id": string;
	"records": Array<{
		"ref": ArtifactRef;
		"expected_revision": number;
		"data": UserProviderRequest | UserModelRequest | ProviderAccountRequest | AvailableModelRouteRequest;
	}>;
	"expected_graph_hash": Hash;
	"expected_policy_hash": Hash;
	"expected_after_policy_hash": Hash;
};
