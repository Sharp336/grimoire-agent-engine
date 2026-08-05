Starts a persistent worker session — a full coding agent (edit, bash, grep, everything) that you drive by conversation. Pick the CLI flavor per task:

- `fast`: low-latency model for mechanical, well-specified work (renames, boilerplate, running tests, data collection).
- `good`: strong model for hard work (design, debugging, multi-file changes, judgment calls).

`prompt` is the session's first instruction. The worker does not inherit the parent conversation. It does receive the normal system prompt and discovered repository context, including applicable `AGENTS.md`; include turn-specific goals, constraints, and acceptance criteria. `name` (optional) labels the session; otherwise one is generated. `maxRequests` and `timeout` bound each turn; request defaults: 100 (`fast`) or 200 (`good`); timeout default: 1200 seconds.

Returns immediately with the session id; the turn's preview is delivered automatically when the worker finishes. Every settled turn has an immutable `agent://<id>/turn-<n>` full-output URL; `agent://<id>` remains the latest-output alias. Do not wait unless blocked — keep directing other sessions.

The session persists after the turn: it remembers the whole conversation. Continue it with `vibe_send`; never spawn a second session for a follow-up on the same workstream.
