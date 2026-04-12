/**
 * Flow edge resolver.
 *
 * Pure function: given the current top node id and the most recent event,
 * find the first outgoing edge from that node whose `when` clause matches
 * the event. Returns the target node id or null if no edge fires.
 *
 * Event kinds:
 *   - `tool_call`: a tool with the given name was called by the model.
 *   - `ret`: the current frame is returning.
 *   - `error`: an error occurred (in a hook, tool, or nested frame).
 *
 * Edge condition `custom` is treated as a no-match at the pure level —
 * higher layers can plug in an expression evaluator if needed.
 */

import type { Flow, NodeId } from "./flow-types";

export type FlowEvent =
	| { kind: "tool_call"; name: string }
	| { kind: "ret" }
	| { kind: "error" };

export function resolveEdge(flow: Flow, currentNodeId: NodeId, event: FlowEvent): NodeId | null {
	for (const edge of flow.edges) {
		if (edge.from !== currentNodeId) continue;
		const when = edge.when ?? { kind: "always" };
		if (edgeMatches(when, event)) return edge.to;
	}
	return null;
}

function edgeMatches(when: NonNullable<Flow["edges"][number]["when"]>, event: FlowEvent): boolean {
	switch (when.kind) {
		case "always":
			return true;
		case "tool_call":
			return event.kind === "tool_call" && when.name === event.name;
		case "ret":
			return event.kind === "ret";
		case "error":
			return event.kind === "error";
		case "custom":
			return false;
	}
}
