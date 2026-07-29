import type { StructuredSubagentSchemaMode } from "../task/types";

export const WORKFLOW_DEFINITION_VERSION = 1 as const;
export const WORKFLOW_SNAPSHOT_VERSION = 1 as const;
export const WORKFLOW_FAILURE_POLICY = "block-descendants" as const;
export const WORKFLOW_SESSION_CUSTOM_TYPE = "workflow-state";

export type WorkflowNodeStatus =
	| "pending"
	| "ready"
	| "running"
	| "succeeded"
	| "failed"
	| "blocked"
	| "interrupted"
	| "cancelled";

export type WorkflowStatus =
	| "created"
	| "running"
	| "succeeded"
	| "failed"
	| "interrupted"
	| "cancelling"
	| "cancelled";

export interface WorkflowNode {
	id: string;
	agent: string;
	task: string;
	needs?: string[];
	outputSchema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	isolated?: boolean;
}

export interface WorkflowDefinition {
	version: typeof WORKFLOW_DEFINITION_VERSION;
	id: string;
	objective: string;
	failurePolicy: typeof WORKFLOW_FAILURE_POLICY;
	nodes: WorkflowNode[];
}

export interface WorkflowNodeRun {
	status: WorkflowNodeStatus;
	attempts: number;
	agentId?: string;
	outputRef?: string;
	historyRef?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
}

export interface WorkflowSnapshot {
	version: typeof WORKFLOW_SNAPSHOT_VERSION;
	revision: number;
	definition: WorkflowDefinition;
	status: WorkflowStatus;
	nodes: Record<string, WorkflowNodeRun>;
	createdAt: number;
	updatedAt: number;
}

export interface WorkflowToolDetails {
	op: "create" | "get" | "run" | "resume" | "retry" | "cancel";
	workflow: WorkflowSnapshot | null;
}

export interface WorkflowDraft {
	id?: string;
	objective: string;
	nodes: WorkflowNode[];
}

export function cloneWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
	return structuredClone(snapshot);
}
