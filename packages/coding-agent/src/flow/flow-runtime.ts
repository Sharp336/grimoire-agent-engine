/**
 * FlowRuntime — call stack over LLM.
 *
 * The runtime owns a stack of CallFrames. Each frame is one in-flight pocket
 * call: a sub-conversation between the model and the orchestrator that is
 * invisible to the persisted history. Push a frame to enter a call; pop it
 * (with a return value) to exit. Recursive by construction: while a frame is
 * open, the model can call into another node which pushes a child frame; when
 * the child returns, the parent resumes with the return value as the result
 * of its tool call.
 *
 * Edits to the flow are first-class. The model can rewrite a node mid-call;
 * if the rewritten node corresponds to an open frame, every descendant frame
 * is marked superseded and a fresh frame is pushed at the same nodeId so the
 * call stack re-runs from that point. The original frames stay in the
 * executionLog forever — the audit trail is append-only.
 *
 * The runtime is deliberately framework-free: it does not import from
 * pi-agent-core. The strategy adapts ctx.messages / ctx.tools / pocketMessages
 * at the boundary; the runtime only knows about its own data model.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { previewMessage } from "./flow-message-utils";
import type { Flow, FlowNode, NodeId } from "./flow-types";
import type { CallFrame, FlowState } from "./types";

function newFrameId(): string {
	return `f_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Edit operation produced by the model via the flow_edit tool. `set_node`
 * writes a complete replacement FlowNode; `delete_node` removes one.
 *
 * If the edited node corresponds to a frame currently on the stack, the
 * runtime supersedes that frame (and its descendants) and re-pushes a fresh
 * frame at the same node id so execution restarts from the rewritten point.
 * Superseded frames remain in the execution log with status="superseded".
 */
export type FlowEditOp =
	| { kind: "set_node"; nodeId: NodeId; node: FlowNode }
	| { kind: "delete_node"; nodeId: NodeId };

export interface FlowEditResult {
	applied: FlowEditOp[];
	supersededFrameIds: string[];
	rerunFrameId?: string;
}

export type FlowTraceEvent =
	| { kind: "frame_open"; frameId: string; parentId: string | null; nodeId: NodeId; purpose: string; at: number }
	| { kind: "frame_message"; frameId: string; role: string; preview: string; at: number }
	| { kind: "frame_close"; frameId: string; returnValue: string; at: number }
	| {
			kind: "flow_edit";
			ops: FlowEditOp[];
			supersededFrameIds: string[];
			rerunFrameId?: string;
			at: number;
	  }
	| {
			kind: "model_request";
			at: number;
			systemPrompt: string;
			tools: string[];
			messages: unknown[];
	  };

export type FlowTraceListener = (event: FlowTraceEvent) => void;
export type FlowEditListener = (result: FlowEditResult, flow: Flow) => void;

export class FlowRuntime {
	#flow: Flow;
	#nodes: Record<NodeId, FlowNode>;
	#frameStack: CallFrame[] = [];
	#executionLog: CallFrame[] = [];
	#listener: FlowTraceListener | null = null;
	#editListener: FlowEditListener | null = null;
	/** O(1) index of the most recent executionLog entry for a frame id. */
	#logIndexByFrame: Map<string, number> = new Map();

	constructor(
		flow: Flow,
		initialState?: { frameStack?: readonly CallFrame[]; executionLog?: readonly CallFrame[] },
	) {
		this.#flow = clone(flow);
		this.#nodes = clone(this.#flow.nodes ?? {});
		if (initialState?.frameStack) {
			this.#frameStack = clone([...initialState.frameStack]);
		}
		if (initialState?.executionLog) {
			this.#executionLog = clone([...initialState.executionLog]);
			for (let i = 0; i < this.#executionLog.length; i++) {
				this.#logIndexByFrame.set(this.#executionLog[i].id, i);
			}
		}
	}

	setTraceListener(listener: FlowTraceListener | null): void {
		this.#listener = listener;
	}

	setEditListener(listener: FlowEditListener | null): void {
		this.#editListener = listener;
	}

	/**
	 * Replace the entire node table. Used by the strategy to reload the
	 * flow from disk after an edit is persisted. Does not touch the frame
	 * stack or the execution log.
	 */
	replaceNodes(nodes: Record<NodeId, FlowNode>): void {
		this.#nodes = clone(nodes);
	}

	get flow(): Flow {
		return { ...this.#flow, nodes: this.#nodes };
	}

	get nodes(): Readonly<Record<NodeId, FlowNode>> {
		return this.#nodes;
	}

	getNode(id: NodeId): FlowNode | undefined {
		return this.#nodes[id];
	}

	get currentNode(): FlowNode | undefined {
		const top = this.topFrame;
		return top ? this.#nodes[top.nodeId] : undefined;
	}

	get topFrame(): CallFrame | undefined {
		return this.#frameStack[this.#frameStack.length - 1];
	}

	get frameStack(): readonly CallFrame[] {
		return this.#frameStack;
	}

	get executionLog(): readonly CallFrame[] {
		return this.#executionLog;
	}

	get isStackEmpty(): boolean {
		return this.#frameStack.length === 0;
	}

	/**
	 * Push a fresh frame onto the stack. The new frame becomes the active
	 * frame; subsequent appendToCurrentFrame / closeFrame calls operate on it.
	 *
	 * Throws if nodeId does not exist. Caller is responsible for surfacing
	 * this as a tool error to the model.
	 */
	openFrame(nodeId: NodeId, purpose: string): CallFrame {
		if (!this.#nodes[nodeId]) {
			throw new Error(`FlowRuntime: cannot open frame at unknown node "${nodeId}"`);
		}
		const parent = this.topFrame;
		const frame: CallFrame = {
			id: newFrameId(),
			parentId: parent?.id ?? null,
			nodeId,
			purpose,
			status: "open",
			openedAt: Date.now(),
		};
		this.#frameStack.push(frame);
		this.#executionLog.push(clone(frame));
		this.#logIndexByFrame.set(frame.id, this.#executionLog.length - 1);
		this.#emit({
			kind: "frame_open",
			frameId: frame.id,
			parentId: frame.parentId,
			nodeId: frame.nodeId,
			purpose: frame.purpose,
			at: frame.openedAt,
		});
		return frame;
	}

	/**
	 * Record a message event in the active frame's trace log. The message
	 * itself is NOT stored on the frame — filtering is done via
	 * entryMessageIndex/exitMessageIndex in transformContext.
	 */
	appendToCurrentFrame(message: AgentMessage): void {
		const top = this.topFrame;
		if (!top) {
			throw new Error("FlowRuntime: appendToCurrentFrame called with empty stack");
		}
		this.#emit({
			kind: "frame_message",
			frameId: top.id,
			role: (message as { role?: string }).role ?? "unknown",
			preview: previewMessage(message),
			at: Date.now(),
		});
	}

	/**
	 * Close the active frame with a return value. Pops it off the stack and
	 * mirrors the final state into the execution log. Returns the closed
	 * frame so the caller can use the return value (e.g., to inject it as a
	 * tool result into the parent frame).
	 */
	closeFrame(returnValue: string): CallFrame {
		const top = this.topFrame;
		if (!top) {
			throw new Error("FlowRuntime: closeFrame called with empty stack");
		}
		top.status = "returned";
		top.returnValue = returnValue;
		top.closedAt = Date.now();
		this.#mirrorToLog(top);
		this.#frameStack.pop();
		this.#emit({ kind: "frame_close", frameId: top.id, returnValue, at: top.closedAt });
		return top;
	}

	/**
	 * Apply edit ops to the flow definition. If any edited node corresponds
	 * to a frame currently on the stack, the runtime supersedes that frame
	 * and every descendant above it, then re-pushes a clean frame at the
	 * earliest superseded node so execution restarts from the rewritten
	 * point. The superseded frames stay in the execution log with
	 * status="superseded" and supersededBy pointing at the new frame.
	 */
	editFlow(ops: FlowEditOp[]): FlowEditResult {
		const result: FlowEditResult = { applied: [], supersededFrameIds: [] };
		let earliestAffectedIdx: number | null = null;

		for (const op of ops) {
			if (op.kind === "set_node") {
				this.#nodes[op.nodeId] = clone(op.node);
				result.applied.push(op);
				const idx = this.#frameStack.findIndex(f => f.nodeId === op.nodeId);
				if (idx >= 0 && (earliestAffectedIdx === null || idx < earliestAffectedIdx)) {
					earliestAffectedIdx = idx;
				}
			} else if (op.kind === "delete_node") {
				delete this.#nodes[op.nodeId];
				result.applied.push(op);
				const idx = this.#frameStack.findIndex(f => f.nodeId === op.nodeId);
				if (idx >= 0 && (earliestAffectedIdx === null || idx < earliestAffectedIdx)) {
					earliestAffectedIdx = idx;
				}
			}
		}

		if (earliestAffectedIdx !== null) {
			const targetNodeId = this.#frameStack[earliestAffectedIdx].nodeId;
			const targetPurpose = this.#frameStack[earliestAffectedIdx].purpose;
			const supersededSlice = this.#frameStack.slice(earliestAffectedIdx);
			this.#frameStack.length = earliestAffectedIdx;

			if (this.#nodes[targetNodeId]) {
				const replacement = this.openFrame(targetNodeId, targetPurpose);
				result.rerunFrameId = replacement.id;
				for (const old of supersededSlice) {
					old.status = "superseded";
					old.supersededBy = replacement.id;
					old.closedAt = Date.now();
					this.#mirrorToLog(old);
					result.supersededFrameIds.push(old.id);
				}
			} else {
				for (const old of supersededSlice) {
					old.status = "superseded";
					old.closedAt = Date.now();
					this.#mirrorToLog(old);
					result.supersededFrameIds.push(old.id);
				}
			}
		}

		this.#emit({
			kind: "flow_edit",
			ops: result.applied,
			supersededFrameIds: result.supersededFrameIds,
			rerunFrameId: result.rerunFrameId,
			at: Date.now(),
		});
		if (this.#editListener) {
			try {
				this.#editListener(result, { ...this.#flow, nodes: this.#nodes });
			} catch {
				// listener errors must not break the runtime
			}
		}
		return result;
	}

	/**
	 * Snapshot the runtime into FlowState fields ready for serialization.
	 * Called by the strategy in onAgentEnd before persisting the state
	 * message into the conversation history.
	 */
	snapshot(): Pick<FlowState, "frameStack" | "executionLog"> {
		return {
			frameStack: clone(this.#frameStack),
			executionLog: clone(this.#executionLog),
		};
	}

	#emit(event: FlowTraceEvent): void {
		if (this.#listener) {
			try {
				this.#listener(event);
			} catch {
				// trace errors must never break the runtime
			}
		}
	}

	#mirrorToLog(frame: CallFrame): void {
		const logIdx = this.#logIndexByFrame.get(frame.id);
		if (logIdx !== undefined && this.#executionLog[logIdx]?.id === frame.id) {
			this.#executionLog[logIdx] = clone(frame);
		} else {
			this.#executionLog.push(clone(frame));
			this.#logIndexByFrame.set(frame.id, this.#executionLog.length - 1);
		}
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
