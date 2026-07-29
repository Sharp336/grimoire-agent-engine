# workflow

> Validate, persist, and run one static dependency graph in the current parent session.

Use `workflow` when node dependencies and partial completion must survive another turn or a process restart. For dynamic one-turn orchestration that needs ordinary code between calls, use the `eval` helpers `agent()`, `parallel()`, and `pipeline()` instead.

## Operations

| Operation | Required fields | Behavior |
| --- | --- | --- |
| `create` | `objective`, `nodes` | Validates the complete DAG and persists it without launching agents. An optional branch-unique `id` may contain letters, numbers, `_`, and `-`. |
| `get` | — | Returns the latest workflow snapshot from the active session branch. |
| `run` | — | Runs dependency-ready nodes until the graph succeeds, fails, is interrupted, or is cancelled. |
| `resume` | — | Uses the same scheduler as `run`; succeeded nodes are never rerun. Independent ready branches continue, while interrupted and failed nodes require `retry`. |
| `retry` | `node_id` | Resets one failed or interrupted node, unblocks eligible descendants, and continues the graph. |
| `cancel` | — | Prevents new dispatch and aborts active Task calls through their existing signals. Nodes stopped this way become cancelled. |

Each node has:

```ts
{
  id: string;
  agent: string;             // defaults to "task"
  task: string;
  needs?: string[];
  outputSchema?: unknown;    // JSON Schema object, or a serialized JSON Schema string
  schemaMode?: "permissive" | "strict";
  isolated?: boolean;
}
```

Definitions are static DAGs with at most 100 nodes. Duplicate ids, missing dependencies, self-dependencies, cycles, unavailable agents, invalid structured-output schemas, and unsupported Task policies are rejected before the definition is persisted or any agent launches.

A workflow definition is immutable after `create`. Its id cannot be reused on the same active session branch; after a terminal workflow, create the next definition under a new id. Session fork/rewind naturally selects the workflow history reachable from that branch.

## Execution and recovery

Before the first node launches, every pending node passes the shared Task preflight. Ready nodes then call the same internal Task dispatch service and therefore share its agent discovery, spawn policy, session concurrency limit, structured-output validation, isolation, lifecycle, and artifacts. The workflow layer does not create a second agent executor.

The parent session appends a `workflow-state` snapshot before each ready set launches and after each node settles. A restart reconstructs the newest valid snapshot on the active branch:

- succeeded, failed, blocked, and cancelled nodes retain their state;
- a node left running becomes `interrupted`;
- successful nodes are not automatically rerun;
- failed or interrupted nodes require an explicit `retry`.

A failed node blocks its descendants, but independent branches continue. Strict output-schema validation failure is a node failure.

Each workflow node keeps its declarative node id and receives a deterministic Task agent id per attempt. The latter remains the one-for-one Agent Registry and Hub identity. Successful and failed executions retain `agent://<agent-id>` output and `history://<agent-id>` transcript references. Downstream prompts receive those references with dependency statuses; full upstream transcripts are not copied into every prompt.

## Limits

Version one does not support conditional edges, cycles, automatic retries, human-approval nodes, replay, reusable workflow catalogs, cross-session execution, or distributed workers.
