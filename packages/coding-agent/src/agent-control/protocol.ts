import type { ChildControlSendResult, ControlGeneration } from "./control";

export const AGENT_CONTROL_PROTOCOL_VERSION = 1 as const;

export type ChildAvailability = "running" | "idle" | "parked" | "aborted" | "unavailable";
export type ChildSendCapability = "send" | "transcript_only";

export interface ChildSnapshotDTO {
	version: typeof AGENT_CONTROL_PROTOCOL_VERSION;
	generation: ControlGeneration;
	id: string;
	label: string;
	availability: ChildAvailability;
	capability: ChildSendCapability;
	lastOutcome?: "completed" | "failed" | "aborted";
	updatedAt: number;
}

export interface TranscriptEntryDTO {
	id: string;
	type: "message" | "custom_message" | "branch_summary" | "compaction_summary";
	role?: "user" | "assistant" | "toolResult" | "custom";
	text: string;
	toolName?: string;
	isError?: boolean;
}

export interface TranscriptPageDTO {
	version: typeof AGENT_CONTROL_PROTOCOL_VERSION;
	generation: ControlGeneration;
	childId: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: TranscriptEntryDTO[];
}

export interface ChildInvalidationDTO {
	version: typeof AGENT_CONTROL_PROTOCOL_VERSION;
	generation: ControlGeneration;
	childId: string;
	kind: "state" | "transcript" | "generation_closed";
}

export interface SendRequestDTO {
	version: typeof AGENT_CONTROL_PROTOCOL_VERSION;
	commandId: string;
	prompt: string;
}

export interface SendResultDTO {
	version: typeof AGENT_CONTROL_PROTOCOL_VERSION;
	generation: ControlGeneration;
	childId: string;
	commandId: string;
	result: ChildControlSendResult;
}

export interface ChildPermissionSet {
	version: typeof AGENT_CONTROL_PROTOCOL_VERSION;
	generation: ControlGeneration;
	childId: string;
	endpoint: string;
	token: string;
}
