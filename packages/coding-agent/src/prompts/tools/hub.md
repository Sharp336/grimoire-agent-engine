Agent coordination: peer messaging, background-job control, and supervised long-running processes. Main agent is `Main`; subagents inherit task ID.
Use `op: "list"` to discover peers. Address peers by exact roster ID — NEVER invent names.

# Messaging & Jobs

Background jobs auto-deliver when they finish. Do not call `jobs`/`wait` merely to watch them; if either observes a settled job first, that snapshot is the delivery and suppresses duplicate `async-result`.

- **`send`** (with `to`): fire-and-forget, NEVER blocks. Delivery receipts (`delivered`/`failed`) immediate; `failed` → peer gone, don't retry.
  Sending wakes `idle`/`parked` peers. Answering: lead with answer, NEVER quote, set `replyTo`.
- **Format**: plain prose ONLY. No JSON status objects. Share paths via `local://`/`artifact://` URLs, not pasted blobs.
- **`wait`**: use ONLY when completely blocked with no other work. Returns on the FIRST of: an incoming message, a watched job finishing, the wait window elapsing, or a steering interrupt — NOT when all jobs finish; re-issue to keep waiting.
  - Bare `wait` watches every running job AND incoming messages. NEVER pass an array of every running ID; `ids` narrows to specific jobs, `from` to one peer (or use `await: true` on send).
- **`inbox`**: drain queued messages without blocking.
- **`cancel`**: kill background jobs by `ids` when they have hung, stalled, or are no longer needed. Returns immediately.
- **`jobs`**: status snapshot of every job without waiting. A settled row consumes auto-delivery. Also names running subagents with no job entry — coordinate with those via `send`.
- Job rows are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `send`, `agent://<id>`, or `history://<id>`.
- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
- NEVER use shell tools, grep, or read other sessions' files to figure out what a peer is doing. Message them directly.
- NEVER use hub messaging for something a tool can answer (e.g., grepping codebase, running a build).

# Processes

Project-scoped long-running processes shared by every omp instance in the same directory. A long-running service, watcher, debugger, REPL, or process needing later input MUST use `op:"start"`, not `bash`.

- **`start`** launches `application` + `args` directly. `cwd` defaults to the session directory; `pty` defaults true.
  - `ready.log` is a regex; `ready.port` is a TCP port. Both supplied? BOTH MUST pass. `ready.timeout` is seconds. Readiness MUST be observed; process creation alone is not readiness.
  - Names are unique per project directory. A completed name MAY be started again; a live name MUST be stopped or restarted.
  - `restart` policy defaults `no`; `on-failure` and `always` use bounded backoff.
  - `persist: true` opts out of last-omp teardown; `detached: true` survives broker shutdown and all omp exits (implies persist, disables PTY input). Omit both unless their survival guarantees are required.
  - For actionable output, set `progress: "wake"`. Every complete non-empty merged output line becomes an event (first and last 250 characters when oversized); a final partial line is flushed before completion. Events use 200 ms batches and a 10-event burst, then regain one rate-limit permit every 2 seconds. Permitted events emitted while busy arrive together in order. `progress: "ambient"` waits for an active turn and never wakes.
  - Suppressed inline events remain in the monitor's full `artifact://<id>` capture; model previews are capped at 3,000 bytes/process.
- `progress` on `start` stays attached. Use **`monitor`** only to attach later, retune, or detach (`progress: "off"`). Monitoring starts with future output; it does not replay logs.
- If progress is noisy, lower source verbosity or filter to actionable lines on a safe relaunch. To keep it running, switch its monitor to `ambient` or `off`. Every fifth suppression report repeats this guidance.
- Monitoring and process lifetime are independent. `persist`/`detached` govern survival; monitoring never keeps a process alive. Detached processes cannot be live-monitored.
- Progress and completion are separate. NEVER call `wait`, follow logs, or block to receive progress or keep the turn alive; use async progress and end the turn instead.
- **`ps`**, **`logs`**, **`wait`** (with `name`), **`send`** (with `name`), **`stop`**, **`restart`**, **`describe`**, and **`monitor`** address the stable `name`.
- **`logs`** defaults to the last 100 lines. `head: true` reads the beginning. `grep` is a regex. `follow: true` waits for output after `cursor`; reuse the returned cursor on the next call.
- **`wait`** with `name` blocks until readiness/exit/`pattern` or `timeout` (seconds).
- **`send`** with `name`: `text` writes stdin (`enter` defaults true); `keys` supports ENTER, TAB, ESCAPE, CTRL_C, CTRL_D, UP, DOWN, LEFT, RIGHT; `signal` supports SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGKILL. PTY input is serialized; writes share one input stream.
- **`stop`** performs graceful process-tree termination before hard-kill; NEVER kill an unverified PID through bash. **`restart`** reuses the retained launch spec.
