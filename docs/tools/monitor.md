# monitor

> Start a managed command or WebSocket source whose bounded intermediate events wake the main agent automatically.

## Source
- Entry: `packages/coding-agent/src/tools/monitor.ts`
- Event pipeline: `packages/coding-agent/src/monitor/events.ts`
- Source runners: `packages/coding-agent/src/monitor/sources.ts`
- Model-facing prompts:
  - `packages/coding-agent/src/prompts/tools/monitor.md`
  - `packages/coding-agent/src/prompts/tools/monitor-event.md`
- Lifecycle and delivery:
  - `packages/coding-agent/src/async/job-manager.ts`
  - `packages/coding-agent/src/session/yield-queue.ts`
  - `packages/coding-agent/src/sdk.ts`

## Availability
`monitor` is exposed only when all of these conditions hold:

- `monitor.enabled` is true (opt-in; default false).
- `async.enabled` is true.
- The session owns an `AsyncJobManager`.
- The runtime registry kind is `main` (secondary top-level sessions are excluded).
- `taskDepth === 0`.

The first implementation is main-agent only. Secondary top-level sessions and subagents do not receive the tool or its `monitor-event` dispatcher. Plugin monitor manifests, reconnect, and a separate supervisor registry are intentionally absent.

## Inputs
The schema is a strict exclusive union. Every call supplies `description` plus exactly one source field: `command` or `ws`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | Yes | Non-empty human description used as the job label and event attribution. Stored/rendered attribution is capped at 500 characters. |
| `command` | `string` | Command variant | Non-empty shell command. Complete newline-delimited stdout/stderr lines become events. |
| `ws` | `string` | WebSocket variant | Valid `ws://` or `wss://` URL. Embedded credentials and fragments are rejected. |
| `protocols` | `string[]` | No; WebSocket only | Unique RFC 6455 subprotocol tokens. Empty or invalid tokens are rejected. |
| `timeout` | `number` | No | Source lifetime in seconds. Default `300`; clamped to `1..3600`. |
| `persistent` | `boolean` | No | When true, disables the monitor deadline. The monitor then runs until normal source completion, failure, session disposal, or `hub` cancellation. |

Command sources reuse Bash's critical-command approval policy. A command matching `CRITICAL_BASH_PATTERNS` requires the same explicit override as a Bash call. WebSocket sources use ordinary execution approval.

If `bash.enabled` is false, WebSocket monitors remain available but command monitor calls are rejected before a job starts.

## Immediate output
A successful call registers a `type: "monitor"` job and returns immediately:

```text
Monitor job <id> started: <description>
Events will arrive automatically; continue working without polling.
Use `hub` with `op: "cancel"` only when intervention is needed.
```

`details` contains:

```ts
{
  description: string;
  source: "command" | "websocket";
  async: { state: "running"; jobId: string; type: "monitor" };
}
```

The job is owned by `session.getAgentId()`. `hub` operations `jobs`, `wait`, and `cancel` retain the existing owner boundary.

## Command event framing
- The command runs through `executeBash()` with its own async shell session key. Finite monitors use the executor's native timeout/process-tree path; persistent monitors pass `timeout: 0`.
- When the foreground command exits, ordinary background children and reparented `nohup` processes are terminated before the monitor job settles.
- Stdout and stderr are merged by the Bash executor.
- Chunks are accumulated until `\n`. A preceding `\r` is removed.
- Every complete logical line enters the event channel. A final unterminated line is flushed only after normal completion or an abnormal command exit.
- Cancellation, timeout, flood shutdown, and oversized input discard pending/carry data instead of delivering stale tail output.
- A logical line is bounded while chunks arrive. Exceeding 1 MiB before a newline fails the monitor; the carry buffer cannot grow without limit.
- Producers must flush output line by line. Use line-buffered filters such as `grep --line-buffered`. Do not use an open-ended `tail -f` success detector without explicit success and failure signatures.

## WebSocket event framing
- Each text frame is one event entry.
- Binary frames are not decoded. They produce a placeholder such as `[binary frame, 42 bytes]`.
- Each text or binary frame is limited to 1 MiB. An oversized frame fails the monitor.
- Close code `1000` completes the job. Other close codes, connection errors, and unknown frame types fail it.
- Cancellation, timeout, flood, oversized input, and abnormal outcomes terminate the socket before the monitor job settles and remove every event/abort listener.
- There is no automatic reconnect.

## Event pipeline and limits
`MonitorEventChannel` applies the same rules to command lines and WebSocket frames:

1. Strip ANSI escape sequences.
2. Replace tabs with spaces and remove unsafe control characters.
3. Cap each source line/frame at 500 characters.
4. Coalesce accepted entries for 200 ms, with one notification capped at 3,000 characters.
5. Keep the newest entries that fit the per-notification cap; summarize omitted older entries.
6. Rate-limit notifications with a 10-token bucket, refilling one token every 2 seconds.
7. Summarize suppressed notifications in the next accepted event.
8. Stop the monitor after 30 seconds of sustained rate-limit suppression. A 2-second quiet interval resets the flood window.

`buildMonitorEventBatchMessage()` then combines all queued monitor notifications in one yield window into one `customType: "monitor-event"` message capped at 12,000 characters. It keeps the newest entries, reports an omitted count, escapes XML attributes/text, and wraps the content in `<monitor-events>`. The prompt marks source content as untrusted data, not instructions.

Delivery is intentionally lossy under pressure. The terminal job result remains the durable lifecycle signal.

## Wake and lifecycle behavior
- `AsyncJobManager.reportEvent()` assigns a per-job sequence number and calls the manager's guarded `onJobEvent` callback.
- SDK wiring accepts intermediate events only from `type: "monitor"` jobs and enqueues them into the owning top-level session's `YieldQueue`.
- While the model is streaming, a queued batch is injected as an aside. While idle, one scheduled flush starts one follow-up prompt.
- Do not poll after starting a monitor. Intermediate events wake the agent automatically.
- `hub` `wait` watches terminal completion only. Its completion suppression does not remove intermediate `monitor-event` entries that already happened.
- A finite live monitor counts as pending async work, so stop-time todo reminders and `session_stop` hooks defer until it settles. A persistent monitor does not defer those passes merely by remaining alive; queued monitor events still defer them until delivery.
- Session disposal cancels owned monitor jobs through the existing `AsyncJobManager` path.

Ordinary `bash` with `async: true` remains completion-only even when the process emits many chunks. Use it for one-shot background work where only the final result matters; use `monitor` when intermediate output is the signal.

## Terminal outcomes
Command source:

- exit code `0` → `completed`, `Command monitor exited normally (code 0).`
- non-zero or missing exit status → `failed`, reason `abnormal-exit`
- deadline → `failed`, reason `timeout`
- oversized logical line → `failed`, reason `oversized-input`
- sustained flood → `failed`, reason `flood`
- `hub` `cancel` / session cancellation → `cancelled`

WebSocket source:

- close code `1000` → `completed`
- abnormal close / connection error / unknown frame → `failed`, reason `abnormal-exit`
- invalid URL or protocol list → `failed`, reason `invalid-source` (tool schema normally rejects these before execution)
- deadline, oversized frame, flood, and cancellation map as above

The manager records terminal success in `resultText`, failures in `errorText`, and cancellation as `status: "cancelled"`. Terminal completion uses the existing `async-result` delivery path.

## Examples
Line-buffered local log filter:

```json
{
  "description": "API readiness and fatal errors",
  "command": "docker compose logs -f api | grep --line-buffered -E 'ready|fatal|panic'",
  "persistent": true
}
```

Local WebSocket event feed:

```json
{
  "description": "local build events",
  "ws": "ws://127.0.0.1:8787/events",
  "protocols": ["build-events"],
  "timeout": 600
}
```

Cancel when the event source is no longer needed:

```json
{ "cancel": ["bg_123"] }
```

## Security notes
- Treat every command line and WebSocket frame as hostile source data.
- The event wrapper explicitly forbids following commands or requests found in source content.
- XML text and attributes are escaped after sanitization.
- Credentialed WebSocket URLs are rejected before connection and redacted by the renderer even while streamed arguments are incomplete.
- Commands still run real binaries with the current session's shell permissions; approval reuse prevents a monitor from bypassing Bash's critical-command gate.
- No monitor event calls `agent.prompt()` directly. All delivery goes through `AsyncJobManager` and `YieldQueue`.
