/**
 * Flow meta tools — `read_flow` and `flow_edit`.
 *
 * These are always-available tools the model uses to inspect and mutate
 * the live flow definition. Both tools close over a `FlowInterpreter`
 * instance; mutations go through the interpreter so that:
 *   1. The in-memory flow is updated atomically.
 *   2. The runtime's shim scene table is kept in sync so new node ids
 *      can be pushed immediately.
 *   3. The host strategy can persist the flow to disk via FlowStore.
 *
 * The v1 scene-action generator and the toolbox tool were removed —
 * Uses triggers + `available_tools` to control tool surfacing.
 */

import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { FlowInterpreter } from "./flow-interpreter";
import type { Flow as FlowV2, FlowEdge, FlowNode, FlowTrigger, NodeId } from "./flow-types";

export const FLOW_EDIT_TOOL_NAME = "flow_edit";
export const FLOW_INSPECT_TOOL_NAME = "read_flow";

const FLOW_OWNED_NAMES = new Set<string>([FLOW_EDIT_TOOL_NAME, FLOW_INSPECT_TOOL_NAME]);

export function isFlowOwnedToolName(name: string): boolean {
	return FLOW_OWNED_NAMES.has(name);
}

// ──────────────────────────────────────────────────────────────────────────
// read_flow
// ──────────────────────────────────────────────────────────────────────────

const inspectSchema = Type.Object({});

export interface FlowInspectDetails {
	flowId: string;
	flow: FlowV2;
	currentNode: string | null;
	stack: Array<{ id: string; nodeId: string; purpose: string }>;
}

export function createFlowInspectTool(
	interpreter: FlowInterpreter,
): AgentTool<typeof inspectSchema, FlowInspectDetails> {
	return {
		name: FLOW_INSPECT_TOOL_NAME,
		label: "ReadFlow",
		description:
			"Read the whole live flow (nodes, edges, triggers) plus the current frame stack and the current node. Call this before `flow_edit` whenever you need to see what already exists so you can extend it instead of duplicating.",
		parameters: inspectSchema,
		strict: true,
		concurrency: "shared",
		async execute(): Promise<AgentToolResult<FlowInspectDetails>> {
			const flow = interpreter.flow;
			const details: FlowInspectDetails = {
				flowId: flow.id,
				flow,
				currentNode: interpreter.currentNodeId ?? null,
				stack: interpreter.frameStack.map(f => ({ id: f.id, nodeId: f.nodeId, purpose: f.purpose })),
			};
			return {
				content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
				details,
			};
		},
	};
}

// ──────────────────────────────────────────────────────────────────────────
// flow_edit
// ──────────────────────────────────────────────────────────────────────────

const nodeShape = Type.Object({
	description: Type.Optional(Type.String()),
	prompt: Type.Optional(Type.String({ description: "Instructions injected into the system prompt when this frame is active." })),
	available_tools: Type.Optional(Type.Array(Type.String())),
	onEnter: Type.Optional(Type.Array(Type.Object({ tool: Type.String(), args: Type.Optional(Type.Object({}, { additionalProperties: true })) }))),
	onLeave: Type.Optional(Type.Array(Type.Object({ tool: Type.String(), args: Type.Optional(Type.Object({}, { additionalProperties: true })) }))),
	onError: Type.Optional(Type.Array(Type.Object({ tool: Type.String(), args: Type.Optional(Type.Object({}, { additionalProperties: true })) }))),
	env: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

const edgeShape = Type.Object({
	from: Type.String(),
	to: Type.String(),
	when: Type.Optional(
		Type.Object({
			kind: Type.String(),
			name: Type.Optional(Type.String()),
			expr: Type.Optional(Type.String()),
		}),
	),
});

const triggerShape = Type.Object({
	when: Type.String(),
	match: Type.Object({
		tool: Type.Optional(Type.String()),
		path: Type.Optional(Type.String()),
		flow: Type.Optional(Type.String()),
		expr: Type.Optional(Type.String()),
	}),
});

const editOpSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("add_node"),
		node_id: Type.String({ description: "Unique identifier for the new node (e.g. 'scout', 'backend_editor'). This is a SIBLING of 'node', not inside it." }),
		node: Type.Intersect([nodeShape], { description: "Node definition: {description?, available_tools?, onEnter?, onLeave?, onError?, env?}. Do NOT put node_id here." }),
	}),
	Type.Object({ kind: Type.Literal("remove_node"), node_id: Type.String() }),
	Type.Object({ kind: Type.Literal("add_edge"), edge: edgeShape }),
	Type.Object({
		kind: Type.Literal("remove_edge"),
		from: Type.String(),
		to: Type.String(),
	}),
	Type.Object({ kind: Type.Literal("add_trigger"), trigger: triggerShape }),
	Type.Object({ kind: Type.Literal("remove_trigger"), index: Type.Number() }),
]);

const editSchema = Type.Object({
	ops: Type.Array(editOpSchema, { minItems: 1 }),
});

export type FlowV2EditOp =
	| { kind: "add_node"; node_id: NodeId; node: FlowNode }
	| { kind: "remove_node"; node_id: NodeId }
	| { kind: "add_edge"; edge: FlowEdge }
	| { kind: "remove_edge"; from: NodeId; to: NodeId }
	| { kind: "add_trigger"; trigger: FlowTrigger }
	| { kind: "remove_trigger"; index: number };

export interface FlowEditDetails {
	applied: number;
}

/**
 * Apply a list of edit operations to a flow, returning a new flow.
 * Pure: the input is not mutated. Exported for tests.
 */
export function applyV2EditOps(flow: FlowV2, ops: readonly FlowV2EditOp[]): FlowV2 {
	const next: FlowV2 = JSON.parse(JSON.stringify(flow));
	for (const op of ops) {
		switch (op.kind) {
			case "add_node":
				next.nodes[op.node_id] = op.node;
				break;
			case "remove_node":
				delete next.nodes[op.node_id];
				next.edges = next.edges.filter(e => e.from !== op.node_id && e.to !== op.node_id);
				break;
			case "add_edge":
				next.edges.push(op.edge);
				break;
			case "remove_edge":
				next.edges = next.edges.filter(e => !(e.from === op.from && e.to === op.to));
				break;
			case "add_trigger":
				next.triggers = [...(next.triggers ?? []), op.trigger];
				break;
			case "remove_trigger":
				next.triggers = (next.triggers ?? []).filter((_, i) => i !== op.index);
				break;
		}
	}
	return next;
}

export type FlowEditPersistFn = (flow: FlowV2) => void;

export function createFlowEditTool(
	interpreter: FlowInterpreter,
	persist?: FlowEditPersistFn,
): AgentTool<typeof editSchema, FlowEditDetails> {
	return {
		name: FLOW_EDIT_TOOL_NAME,
		label: "FlowEdit",
		description: [
			"Mutate the live flow: add/remove nodes, add/remove edges, add/remove triggers.",
			"",
			"Ops:",
			"  - add_node    { node_id, node }",
			"  - remove_node { node_id }",
			"  - add_edge    { edge: { from, to, when? } }",
			"  - remove_edge { from, to }",
			"  - add_trigger { trigger: { when, match } }",
			"  - remove_trigger { index }",
		].join("\n"),
		parameters: editSchema,
		strict: true,
		concurrency: "exclusive",
		async execute(_id: string, params: Static<typeof editSchema>): Promise<AgentToolResult<FlowEditDetails>> {
			const ops = params.ops as unknown as FlowV2EditOp[];
			const nextFlow = applyV2EditOps(interpreter.flow, ops);
			interpreter.replaceFlow(nextFlow);
			persist?.(nextFlow);
			return {
				content: [{ type: "text", text: `Applied ${ops.length} op(s) to flow.` }],
				details: { applied: ops.length },
			};
		},
	};
}
