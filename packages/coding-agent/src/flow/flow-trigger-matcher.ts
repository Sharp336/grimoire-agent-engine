/**
 * Flow trigger matcher.
 *
 * Pure function: scan every node in the flow for triggers whose `when`
 * phase equals the event phase AND whose `match` fields all agree with the
 * event payload. Returns a list of node ids that should be auto-pushed.
 *
 * Matching rules:
 *   - `tool`: glob over the event.tool name (`*` wildcard).
 *   - `path`: glob over the event.args.path (simple minimatch-lite, supports
 *              `*` single segment and `**` recursive segment).
 *   - `flow`: exact match on event.flowId.
 *   - `expr`: not supported here; treated as no-match (pure).
 *
 * All specified fields must match. A trigger with an empty `match` object
 * fires on every event of its phase.
 */

import type { Flow, NodeId, TriggerWhen } from "./flow-types";

export interface TriggerEvent {
	phase: TriggerWhen;
	tool?: string;
	args?: Record<string, unknown>;
	flowId?: string;
}

/** Compile a glob with `*` and `**` to a regex. */
export function pathGlobToRegex(glob: string): RegExp {
	// Split on `/` and translate each segment; `**` matches any number of
	// path segments, `*` matches anything except `/` in the current segment.
	const segments = glob.split("/");
	const parts: string[] = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg === "**") {
			parts.push("(?:.*)");
			continue;
		}
		// Escape regex metacharacters except `*`, then replace `*` with `[^/]*`.
		const escaped = seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
		parts.push(escaped);
	}
	// Join with `/`, but collapse `(?:.*)/` at boundaries so `**/foo` also
	// matches `foo` at the root.
	let joined = parts.join("/");
	joined = joined.replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
	joined = joined.replace(/\/\(\?:\.\*\)/g, "(?:/.*)?");
	return new RegExp(`^${joined}$`);
}

export function simpleNameGlob(pattern: string, value: string): boolean {
	if (!pattern.includes("*")) return pattern === value;
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

export function matchTriggers(flow: Flow, event: TriggerEvent): NodeId[] {
	const triggers = flow.triggers ?? [];
	const matchedFlowLevel = triggers.some(t => t.when === event.phase && triggerMatches(t.match, event));
	// Flow-level triggers are the primary mechanism, but we also scan every
	// node for triggers (if a future extension stores triggers on nodes).
	// The spec keeps triggers at the flow level, so we only resolve
	// which nodes to push when flow-level triggers match. Convention: the
	// flow's `id` matches a node id with the same id, else no-op.
	if (!matchedFlowLevel) return [];
	const nodeId = flow.id;
	if (flow.nodes[nodeId]) return [nodeId];
	// Fall back to the first node if the flow id is not itself a node.
	const first = Object.keys(flow.nodes)[0];
	return first ? [first] : [];
}

function triggerMatches(match: { tool?: string; path?: string; flow?: string; expr?: string }, event: TriggerEvent): boolean {
	if (match.expr !== undefined) return false; // pure resolver cannot evaluate
	if (match.tool !== undefined) {
		if (!event.tool) return false;
		if (!simpleNameGlob(match.tool, event.tool)) return false;
	}
	if (match.path !== undefined) {
		const p = event.args?.path;
		if (typeof p !== "string") return false;
		if (!pathGlobToRegex(match.path).test(p)) return false;
	}
	if (match.flow !== undefined) {
		if (event.flowId !== match.flow) return false;
	}
	return true;
}
