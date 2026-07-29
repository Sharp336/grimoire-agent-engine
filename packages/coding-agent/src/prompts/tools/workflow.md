Create and control one session-durable static workflow DAG.

Use this tool when dependency state must survive the current turn or process. Use `create` to validate and persist the complete graph before any node launches, then `run` to execute it. Independent ready nodes run concurrently through the existing Task runtime. A node runs only after every `needs` dependency succeeds.

Failure behavior is conservative: a failed node blocks its descendants while independent branches continue. After restart, nodes that were running become interrupted. `resume` never reruns succeeded nodes; use `retry` with `node_id` to explicitly rerun a failed or interrupted node and continue newly unblocked descendants. `cancel` stops a workflow between runs; while `run` is active in the interactive TUI, the host operator can stop it with `/workflow cancel`.

Downstream nodes receive dependency statuses plus `agent://` output and `history://` transcript references, not copied transcripts. Keep graphs static and acyclic. Conditional edges, loops, automatic retries, human approval nodes, and cross-session execution are not supported.

When a node needs structured output, pass `outputSchema` as a JSON Schema object. A string value must contain a serialized JSON Schema document; a type name such as `"string"` is not itself a valid serialized schema.
