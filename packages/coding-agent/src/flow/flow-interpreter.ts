/**
 * Flow interpreter — runtime for data-driven flows.
 *
 * Wraps a `FlowRuntime` (which owns the frame stack) and layers the
 * flow semantics on top: tool filter, node-as-tool exposure, edges,
 * triggers, and lifecycle hooks.
 *
 * Callers drive the interpreter from the strategy:
 *
 *   const interp = new FlowInterpreter(flow);
 *   await interp.pushNode("chat", ctx);
 *   ...
 *   interp.resolveTools(parentScope);   // effective scope for current frame
 *   interp.handleEvent({kind:"tool_call", name:"..."}, ctx);  // drive edges
 *   await interp.popNode("done", ctx);
 */

import type { AgentMessage, AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { FlowRuntime } from "./flow-runtime";
import { type FlowEvent, resolveEdge } from "./flow-edge-resolver";
import { type HookExecutorContext, runHooks } from "./flow-hook-executor";
import { applyToolFilter } from "./flow-tool-filter";
import { matchTriggers, type TriggerEvent } from "./flow-trigger-matcher";
import type { Flow as FlowV2, FlowNode, NodeId } from "./flow-types";
import type { CallFrame } from "./types";

export interface InterpreterContext {
	/** Tool table visible at the outermost scope; used to resolve hook tool names. */
	tools: readonly AgentTool<any>[];
	/** Called whenever the interpreter wants to persist a message into the current frame. */
	appendMessage?: (message: AgentMessage) => void;
}

export class FlowInterpreter {
	#flow: FlowV2;
	#runtime: FlowRuntime;
	/** Current node id per frame, keyed by frame.id. Edge transitions mutate this without popping. */
	#nodeByFrame: Map<string, NodeId> = new Map();

	constructor(flow: FlowV2, runtime?: FlowRuntime) {
		this.#flow = flow;
		this.#runtime = runtime ?? new FlowRuntime(flow);
	}

	get flow(): FlowV2 {
		return this.#flow;
	}

	get runtime(): FlowRuntime {
		return this.#runtime;
	}

	get currentNodeId(): NodeId | undefined {
		const top = this.#runtime.topFrame;
		if (!top) return undefined;
		return this.#nodeByFrame.get(top.id) ?? top.nodeId;
	}

	get currentNode(): FlowNode | undefined {
		const id = this.currentNodeId;
		return id ? this.#flow.nodes[id] : undefined;
	}

	get frameStack(): readonly CallFrame[] {
		return this.#runtime.frameStack;
	}

	get isStackEmpty(): boolean {
		return this.#runtime.isStackEmpty;
	}

	/**
	 * Replace the in-memory flow definition (used by flow_edit). Also
	 * refreshes the runtime's node table so new node ids can be pushed.
	 */
	replaceFlow(flow: FlowV2): void {
		this.#flow = flow;
		this.#runtime.replaceNodes(flow.nodes);
	}

	/**
	 * Compute the effective tool list for the current frame by:
	 *  1. Applying the current node's `available_tools` filter over the
	 *     parent scope (which is the base tools provided by the agent).
	 *  2. Adding one exposed "node-as-tool" per node id that appears in the
	 *     filter and exists in `flow.nodes` but is NOT already in the base
	 *     scope. Calling that tool pushes a new frame on that node.
	 *
	 * If the stack is empty or the current node is unknown, returns the
	 * parent scope unchanged.
	 */
	resolveTools(parentScope: readonly AgentTool<any>[]): AgentTool<any>[] {
		const node = this.currentNode;
		if (!node) return [...parentScope];
		const filtered = applyToolFilter(parentScope, node.available_tools);

		// Expose any node id mentioned (positively) in the filter as a tool.
		const filter = node.available_tools ?? [];
		for (const entry of filter) {
			if (entry.startsWith("!")) continue;
			if (entry.includes("*")) continue;
			if (this.#flow.nodes[entry] && !filtered.some(t => t.name === entry)) {
				filtered.push(this.makeNodeEntryTool(entry, () => parentScope));
			}
		}
		return filtered;
	}

	/**
	 * Build an AgentTool the model can call to push a new frame on the
	 * given node id. The tool name/label/description mirror the node
	 * definition. `ctxTools` supplies the tool catalog handed to onEnter
	 * hooks at push time — the strategy passes the live parent-frame
	 * catalog so hooks can reach the same tools the model sees.
	 */
	makeNodeEntryTool(
		nodeId: NodeId,
		ctxTools: () => readonly AgentTool<any>[],
		overrides?: { description?: string; label?: string; appendMessage?: () => ((msg: AgentMessage) => void) | undefined },
	): AgentTool<any> {
		const interp = this;
		const node = this.#flow.nodes[nodeId];
		const getAppend = overrides?.appendMessage;
		return {
			name: nodeId,
			label: overrides?.label ?? nodeId,
			description: overrides?.description ?? node?.description ?? `Enter sub-flow ${nodeId}`,
			parameters: Type.Object({
				reason: Type.String({
					minLength: 1,
					description: "REQUIRED — brief description of why you are entering this sub-flow, based on the user request or current task.",
				}),
			}),
			strict: false,
			concurrency: "exclusive",
			async execute(_id: string, params: { reason?: string }): Promise<AgentToolResult> {
				const reason = params?.reason ?? nodeId;
				await interp.pushNode(nodeId, { tools: ctxTools(), appendMessage: getAppend?.() });
				return { content: [{ type: "text", text: `Entered ${nodeId}: ${reason}` }] };
			},
		};
	}

	/**
	 * Push a new frame on the given node id. Runs `onEnter` hooks as real
	 * tool calls against the provided context and seeds the frame pocket
	 * with their rendered results. If the node has a `prompt` field, it
	 * is appended as a user message *after* the hooks — the model sees
	 * the loaded context first, then the instructions.
	 */
	async pushNode(nodeId: NodeId, ctx: InterpreterContext): Promise<CallFrame> {
		const node = this.#flow.nodes[nodeId];
		if (!node) {
			throw new Error(`FlowInterpreter: unknown node "${nodeId}"`);
		}
		const frame = this.#runtime.openFrame(nodeId, node.description ?? `frame at ${nodeId}`);
		this.#nodeByFrame.set(frame.id, nodeId);
		await this.#runHooks(node.onEnter, node.onError, ctx, frame);

		const prompt = node.prompt?.trim();
		if (prompt && ctx.appendMessage) {
			ctx.appendMessage({
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			} as unknown as AgentMessage);
		}

		return frame;
	}

	/**
	 * Pop the top frame. Runs `onLeave` hooks first. Returns the closed
	 * frame with its return value.
	 */
	async popNode(returnValue: string | undefined, ctx: InterpreterContext): Promise<CallFrame | undefined> {
		const top = this.#runtime.topFrame;
		if (!top) return undefined;
		const currentId = this.#nodeByFrame.get(top.id) ?? top.nodeId;
		const node = this.#flow.nodes[currentId];
		await this.#runHooks(node?.onLeave, node?.onError, ctx, top);
		const closed = this.#runtime.closeFrame(returnValue ?? "");
		this.#nodeByFrame.delete(top.id);
		return closed;
	}

	/**
	 * Drive an event through the current frame. If an outgoing edge from
	 * the current node matches, transition:
	 *   - `ret` edge → pop the frame
	 *   - anything else → mutate the frame's active node under the frame
	 *                    (same frame, different node)
	 * Returns the new current node id (or null if no transition).
	 */
	async handleEvent(event: FlowEvent, ctx: InterpreterContext): Promise<NodeId | null> {
		const top = this.#runtime.topFrame;
		if (!top) return null;
		const currentId = this.#nodeByFrame.get(top.id) ?? top.nodeId;
		const next = resolveEdge(this.#flow, currentId, event);
		if (!next) return null;

		// A `ret` edge or an edge whose target is an ancestor: pop.
		const wantsPop = event.kind === "ret";
		if (wantsPop) {
			await this.popNode(next, ctx);
			return next;
		}

		// In-frame transition: swap the current node without popping.
		const newNode = this.#flow.nodes[next];
		if (newNode) {
			this.#nodeByFrame.set(top.id, next);
			await this.#runHooks(newNode.onEnter, newNode.onError, ctx, top);
		}
		return next;
	}

	/**
	 * Scan flow-level triggers and auto-push any node whose trigger fires
	 * for this event. Returns the ids of nodes that were pushed.
	 */
	async runTriggers(event: TriggerEvent, ctx: InterpreterContext): Promise<NodeId[] > {
		const ids = matchTriggers(this.#flow, event);
		for (const id of ids) {
			await this.pushNode(id, ctx);
		}
		return ids;
	}

	async #runHooks(
		hooks: FlowNode["onEnter"],
		onError: FlowNode["onError"],
		ctx: InterpreterContext,
		frame: CallFrame,
	): Promise<void> {
		if (!hooks || hooks.length === 0) return;
		const hookCtx: HookExecutorContext = {
			tools: ctx.tools,
			appendMessage: (msg: AgentMessage) => {
				// Append into the frame's pocket. Also invoke the outer sink
				// if provided so the strategy can mirror hooks into its own
				// pocketRefs tracking.
				this.#runtime.appendToCurrentFrame(msg);
				ctx.appendMessage?.(msg);
			},
		};
		try {
			await runHooks(hooks, hookCtx, onError);
		} catch {
			// Hook errors are surfaced via the pocket message trail; the
			// frame stays open so the model can observe and recover.
		}
		void frame;
	}
}
