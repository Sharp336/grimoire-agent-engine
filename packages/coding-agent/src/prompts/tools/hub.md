Parent-side background-job control and supervised long-running processes. Create subagents with the `task` tool; use Hub to observe, wait for, or cancel asynchronous work.

# Jobs

Background jobs auto-deliver when they finish. You do not need to poll while other useful work remains.

- **`wait`**: use only when completely blocked. A bare wait watches every running job; `ids` narrows it to specific jobs. It returns when the first watched job settles or the wait window expires.
- **`cancel`**: stop background jobs by `ids` when they have hung, stalled, or are no longer needed.
- **`jobs`**: read a status snapshot of every background job, plus running subagents that no longer have a job row.
- Job rows are process-local and expire after settlement. Use `agent://<id>` or `history://<id>` for retained task output.
- `completed` means the job exited successfully, not that its claimed changes are correct. Verify results.

# Processes

Project-scoped long-running processes are shared by every omp instance in the same directory. A service, watcher, debugger, REPL, or process needing later input must use `op:"start"`, not `bash`.

- **`start`** launches `application` plus `args` directly. `cwd` defaults to the session directory; `pty` defaults true.
  - `ready.log` is a regex and `ready.port` is a TCP port. When both are supplied, both must pass.
  - Names are unique per project directory. Stop or restart an existing live name before reusing it.
  - `restart` defaults to `no`; `on-failure` and `always` use bounded backoff.
  - `persist: true` survives the last omp client; `detached: true` also survives broker shutdown and disables PTY input.
- **`ps`**, **`logs`**, **`wait`** with `name`, **`send`** with `name`, **`stop`**, **`restart`**, and **`describe`** address the stable process name.
- **`logs`** defaults to the last 100 lines. `head`, `grep`, `follow`, and `cursor` refine output.
- **`wait`** with `name` blocks until readiness, exit, a matching `pattern`, or timeout.
- **`send`** with `name` writes process stdin or terminal keys, or sends a process-tree signal.
- **`stop`** performs graceful process-tree termination before hard kill. Never kill an unverified PID through bash.
