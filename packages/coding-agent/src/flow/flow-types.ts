/**
 * Flow — data-driven flow definition.
 *
 * Top-level: a flow is `{ version, id, description, nodes, edges, triggers }`.
 *
 * Core idea: every executable unit is a *node*. A node is a pure closure —
 * it does not run anything on its own. What gives a node behavior is its
 * hooks (onEnter / onLeave / onError) and the edges that connect it to
 * other nodes.
 *
 * Hooks are hardcoded tool calls that the runtime executes automatically
 * at the push / pop / error boundaries of a frame. They exist to offload
 * repetitive work off the model: loading rule files, running a build, etc.
 *
 * Tools in `available_tools` are a filter, not a declaration. Use `"name"`
 * to allow a tool and `"!name"` to deny one. The effective set is computed
 * per frame by intersecting the parent scope with the node's filter.
 *
 * Flows can be triggered three ways:
 *   1. Called explicitly: the parent scope sees the flow as a tool and
 *      calls it by id.
 *   2. Auto-pushed by a trigger: the runtime matches a pattern on the
 *      current state (tool call, file path, etc.) and pushes the flow.
 *   3. Chat root: the top-level conversation is itself a flow.
 */

/** Unique id of a node inside a flow. Lowercase snake_case by convention. */
export type NodeId = string;

/**
 * A hardcoded tool invocation the runtime executes automatically. Used in
 * hook lists (onEnter / onLeave / onError).
 *
 * `tool` is the name of a tool available at the parent scope (a builtin,
 * a sub-flow, or an MCP tool). `args` is the fixed argument object passed
 * to that tool. No templating — arguments are static.
 */
export interface HookCall {
	tool: string;
	args?: Record<string, unknown>;
}

/**
 * Tool filter entry. `"name"` allows the tool, `"!name"` denies it. The
 * filter is applied over the parent scope's effective tool set.
 */
export type ToolFilter = string;

/**
 * A single node in a flow. Pure closure: holds description, env, tool
 * filters, and lifecycle hooks. No executor is attached to the node
 * itself — behavior emerges from hooks and the graph structure.
 */
export interface FlowNode {
	/** Optional per-node runtime environment. Scoped to the frame. */
	env?: Record<string, unknown>;

	/** Human-readable description of what this node represents. */
	description?: string;

	/**
	 * Instructions injected into the model context as part of the system
	 * prompt when this frame is active. Use this to give the model
	 * node-specific guidance (what to do, what to avoid, when to ret).
	 */
	prompt?: string;

	/**
	 * Tool filter applied when this frame is on top of the stack. Each
	 * entry is either `"name"` (allow) or `"!name"` (deny). The effective
	 * tool set is `parentScope ∩ filter`. Omit to inherit the parent
	 * scope unchanged.
	 */
	available_tools?: ToolFilter[];

	/** Hardcoded tool calls executed automatically when the frame is pushed. */
	onEnter?: HookCall[];
	/** Hardcoded tool calls executed automatically when the frame is popped. */
	onLeave?: HookCall[];
	/** Hardcoded tool calls executed when a hook or contained node errors. */
	onError?: HookCall[];
}

/**
 * Directed edge between two nodes. The `when` clause is a condition on
 * the current frame's most recent event.
 */
export type EdgeCondition =
	| { kind: "always" }
	| { kind: "tool_call"; name: string }
	| { kind: "ret" }
	| { kind: "error" }
	| { kind: "custom"; expr: string };

export interface FlowEdge {
	from: NodeId;
	to: NodeId;
	when?: EdgeCondition;
}

/**
 * Auto-push trigger for this flow. When the runtime observes an event at
 * any level of the stack that matches `when` and `match`, it pushes this
 * flow onto the stack. The flow's own nodes decide what happens next.
 */
export type TriggerWhen = "before_tool_call" | "after_tool_call" | "on_user_message" | "on_flow_enter" | "on_flow_leave";

export interface TriggerMatch {
	/** Tool name match (exact or glob, e.g. "file_write", "mcp_gitea_*"). */
	tool?: string;
	/** File path glob applied to args.path (e.g. "backend/**\/*.ts"). */
	path?: string;
	/** Match on the id of the flow currently entering/leaving. */
	flow?: string;
	/** Arbitrary JSONPath-like expression on the event payload. Runtime dep. */
	expr?: string;
}

export interface FlowTrigger {
	when: TriggerWhen;
	match: TriggerMatch;
}

/**
 * A flow is a DAG of nodes connected by edges, with optional triggers
 * that cause the flow to be auto-pushed by the runtime.
 */
export interface Flow {
	version: 1;
	id: string;
	description?: string;

	/** All nodes in the flow, keyed by id. Any node may serve as an entry. */
	nodes: Record<NodeId, FlowNode>;

	/** Directed transitions between nodes. */
	edges: FlowEdge[];

	/** Conditions under which the runtime auto-pushes this flow. */
	triggers?: FlowTrigger[];
}
