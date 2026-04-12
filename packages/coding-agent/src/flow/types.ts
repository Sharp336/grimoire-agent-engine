/**
 * Flow agent shared types.
 *
 * Flow definition itself lives in `flow-types.ts`. This module holds the
 * runtime-only types that are not part of the static DSL: call frames,
 * pocket entries, and the custom-message envelope used to persist runtime
 * state in the conversation history.
 */

import type { NodeId } from "./flow-types";

export type { NodeId };

/**
 * A live call frame on the runtime stack. Each frame represents one in-flight
 * sub-flow call. Conceptually identical to an assembly call frame: parentId
 * points at the caller, status moves open → returned, returnValue carries
 * the result back up the stack.
 *
 * Every message in the session is stamped with `flowFrameId` = the top
 * frame id at creation time (via session manager's flowState snapshot).
 * `transformContext` checks each message's frameId against the set of open
 * frames — if the frame is closed, the message is excluded.
 */
export type CallFrame = {
	id: string;
	parentId: string | null;
	nodeId: NodeId;
	purpose: string;
	status: "open" | "returned" | "superseded";
	returnValue?: string;
	openedAt: number;
	closedAt?: number;
	supersededBy?: string;
	/** Reason provided by the model when entering this sub-flow. */
	reason?: string;
};

/**
 * Runtime state of a flow execution. Serialized into the conversation history
 * as a CustomMessage with customType "flow-state" so it rides along with the
 * conversation for free: branching, undo, export, and replay all work.
 */
export type FlowState = {
	version: 2;
	flowId: string;
	cursor: NodeId;
	frameStack: CallFrame[];
	executionLog: CallFrame[];
	/** Tool attachments per node id. Persisted so fork/resume restores them. */
	attachments?: Record<string, string[]>;
	/** Sub-flows that completed (ret) this conversation. Rendered in <scene>. */
	completedSubFlows?: { nodeId: string; result: string }[];
};

/**
 * Custom message type used to serialize FlowState into the conversation
 * history. We reuse the existing `custom` role rather than registering a new
 * one so we don't touch coding-agent/src/session/messages.ts.
 */
export const FLOW_STATE_CUSTOM_TYPE = "flow-state";
