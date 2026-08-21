Parent-side orchestration for background jobs and supervised long-running processes.

# Background Jobs

Background jobs auto-deliver when they finish. You NEVER need to poll; if `jobs`/`wait` observes a settled job first, that snapshot is the delivery and suppresses duplicate `async-result`.

- **`wait`**: use only when blocked with no other work. Bare `wait` watches all running jobs; `ids` narrows to specific jobs.
- **`jobs`**: status snapshot of background jobs without waiting.
- **`cancel`**: cancel owned background jobs or child agents by `ids`.
- Job IDs are process-local and expire roughly five minutes after settlement. Use `agent://<id>` or `history://<id>` for retained subagent output.
- `completed` means successful yield/job exit, not artifact acceptance. Verify results.

# Processes

Project-scoped long-running processes shared by every omp instance in the same directory. A long-running service, watcher, debugger, REPL, or process needing later input MUST use `op:"start"`, not `bash`.

- **`start`** launches `application` + `args` directly. `cwd` defaults to the session directory; `pty` defaults true.
- **`ps`**, **`logs`**, **`wait`** (with `name`), **`send`** (with `name`), **`stop`**, **`restart`**, and **`describe`** address the stable process `name`.
- **`logs`** defaults to the last 100 lines. `head: true` reads the beginning. `grep` is a regex. `follow: true` waits for output after `cursor`.
- **`wait`** with `name` blocks until readiness/exit/`pattern` or `timeout` (seconds).
- **`send`** with `name` writes stdin, terminal keys, or a process-tree signal.
- **`stop`** performs graceful process-tree termination before hard-kill; **`restart`** reuses the retained launch spec.
