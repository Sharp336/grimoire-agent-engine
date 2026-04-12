---
name: flow-editor
description: Instructions for editing the live flow definition from inside the `flow_editor` sub-flow.
---

# Flow editor

You are inside the `flow_editor` sub-flow. You have two tools:

- **`read_flow`** — returns the whole live flow (every node, edge, trigger) plus the current call stack.
- **`flow_edit`** — mutates the flow. Accepts a list of `ops`. Each op is one of:
  - `{ kind: "add_node", node_id, node }` — create or replace a node. A node is `{ description?, env?, available_tools?, onEnter?, onLeave?, onError? }`.
  - `{ kind: "remove_node", node_id }` — delete a node and any edges touching it.
  - `{ kind: "add_edge", edge }` — add a directed edge `{ from, to, when? }`. `when` is `{ kind: "always" | "tool_call" | "ret" | "error" | "custom", name?, expr? }`.
  - `{ kind: "remove_edge", from, to }` — remove an edge.
  - `{ kind: "add_trigger", trigger }` — add an auto-push trigger `{ when, match }`. `when` is one of `before_tool_call | after_tool_call | on_user_message | on_flow_enter | on_flow_leave`. `match` can filter by `tool`, `path`, `flow`, or `expr`.
  - `{ kind: "remove_trigger", index }` — remove a trigger by its position.

## Node shape

```json
{
  "description": "what this node represents",
  "available_tools": ["name", "!name"],
  "onEnter": [{ "tool": "read", "args": { "path": "skill://name" } }],
  "onLeave": [],
  "onError": []
}
```

### `available_tools` filter

List of entries processed in order. Each entry is either `"name"` (allow) or `"!name"` (deny). The effective tool set is the parent scope intersected with this filter.

- Empty or omitted → inherit the parent scope as-is.
- Deny-only (`["!bash"]`) → parent scope minus the denied tools.
- Any allow entry flips it into allow-mode: start empty, add what's allowed.
- Wildcards `*` are supported (`"mcp_gitea_*"`).
- A node id that appears in the filter and matches an existing node is exposed as a **node-as-tool**: calling it pushes a new frame on that node.

### Lifecycle hooks

`onEnter` / `onLeave` / `onError` are lists of hardcoded tool calls the runtime executes automatically at the corresponding lifecycle boundary. They are NOT things the model calls — they are side effects owned by the flow. Typical uses:

- Load a skill file when entering a node: `{ "tool": "read", "args": { "path": "skill://frontend-rules" } }`
- Run a build check on leave: `{ "tool": "bash", "args": { "command": "cargo build" } }`

## Workflow

1. If you need to understand the current state, call `read_flow` first. It returns `{ flowId, flow: { nodes, edges, triggers }, currentNode, stack }`.
2. Plan the mutation. Prefer extending an existing node over creating a near-duplicate.
3. Call `flow_edit` with a batch of `ops`. Mutations persist immediately to `<cwd>/.omp/flow.json`.
4. When satisfied, respond with plain text. That closes the frame and returns control to the caller (usually `chat`).

## Style

- Be concise.
- Do not paste the current flow back into your reply to the user — the scene block already tells you where you are.
- Prefer small, targeted edits. If an op touches a node currently on the stack, the runtime will supersede affected frames and re-enter the edited version automatically.
