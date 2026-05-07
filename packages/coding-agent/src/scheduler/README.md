# Persistent Cron Scheduler

A lightweight background scheduler for omp that runs tasks on cron, interval, or one-shot schedules, persists state in SQLite, and survives process restarts.

## Overview

The scheduler module adds task scheduling to omp. Unlike in-process timers that vanish when the CLI exits, this scheduler uses a standalone daemon that:

- Persists tasks in `~/.omp/scheduler.db` (SQLite with WAL mode)
- Runs a lightweight background process via `omp daemon start`
- Spawns `sh -c "<command>"` child processes when tasks are due (same path as `omp schedule run`)
- Tracks execution history (stdout, stderr, exit code)

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   omp daemon    │────▶│  SchedulerDaemon │────▶│   SQLite DB     │
│   (background)  │     │  (croner engine) │     │  ~/.omp/        │
└─────────────────┘     └─────────────────┘     │  scheduler.db   │
         │                                        └─────────────────┘
         │                                               │
         ▼                                               ▼
┌─────────────────┐                           ┌─────────────────┐
│  sh -c "cmd"    │                           │   tasks table   │
│  (child process)│                           │  executions table│
└─────────────────┘                           └─────────────────┘
```

### Components

| File | Responsibility |
|------|--------------|
| `types.ts` | Core types: `ScheduledTask`, `TaskExecution`, `parseSchedule` |
| `storage.ts` | `SchedulerDbStorage` — SQLite CRUD with prepared statements |
| `engine.ts` | `SchedulerEngine` — croner + setInterval + setTimeout scheduling |
| `executor.ts` | `executeScheduledCommand` — unified shell/agent execution with timeout |
| `daemon.ts` | `SchedulerDaemon` — daemon lifecycle, child process spawning |
| `index.ts` | Public API re-exports |

## CLI Commands

### `omp schedule` — Task Management

```bash
# Cron — daily at 9:00 AM
omp schedule add daily-report "0 9 * * *" "bun run scripts/report.ts"

# Interval — every 5 minutes
omp schedule add health-check "5m" --type shell "curl -f http://localhost/health"

# One-shot — relative time
omp schedule add remind "+30m" --type agent "review open PRs and summarize"

# One-shot — absolute time
omp schedule add meeting "2026-05-10T09:00:00Z" --type agent "prepare meeting notes"

# Agent task with custom timeout (default for agent is 120s)
omp schedule add review "0 9 * * 1" --type agent --timeout 300000 "weekly code review"

# List all tasks (with next run time)
omp schedule list

# Run a task immediately (one-shot)
omp schedule run daily-report

# Disable a task without removing it
omp schedule disable daily-report

# Re-enable a disabled task
omp schedule enable daily-report

# View last 20 executions
omp schedule logs daily-report --json

# Remove a task permanently
omp schedule remove daily-report
```

### `omp daemon` — Daemon Management

```bash
# Start daemon in background
omp daemon start

# Start in foreground (for debugging)
omp daemon start --foreground

# Check if daemon is running
omp daemon status

# Stop the daemon
omp daemon stop

# Restart
omp daemon restart
```

## Schedule Formats

The `schedule` argument accepts multiple formats. The scheduler auto-detects the type:

| Format | Example | Type | Description |
|--------|---------|------|-------------|
| Cron | `0 9 * * *` | cron | Standard 5-field cron (minute hour day month weekday) |
| Interval | `5m`, `1h`, `30s` | interval | Repeats at fixed interval |
| Relative | `+30m`, `+2h`, `+1d` | once | Runs once after the specified delay |
| ISO timestamp | `2026-05-10T09:00:00Z` | once | Runs once at exact time |

### Examples

```bash
# Every 15 minutes
omp schedule add check "*/15 * * * *" "echo checking..."

# Every 5 minutes (interval syntax)
omp schedule add poll "5m" "curl http://api/status"

# In 30 minutes (one-shot)
omp schedule add remind "+30m" --type agent "follow up on the issue"

# At a specific time (one-shot)
omp schedule add launch "2026-06-01T10:00:00+08:00" "echo product launch"
```

## Task Types

Tasks can run in two modes, selected via `--type`:

| Type | Execution | Use Case |
|------|-----------|----------|
| `shell` (default) | `sh -c "<command>"` | Scripts, curl, data processing |
| `agent` | `omp --print "<prompt>"` | AI-driven tasks, MCP tool calls |

```bash
# Shell task — executes directly
omp schedule add backup "0 2 * * *" --type shell "bun run scripts/backup.ts"

# Agent task — omp interprets the prompt and may call tools
omp schedule add review "0 9 * * 1" --type agent "review src/ for security issues"
```

## Task Schema

```typescript
interface ScheduledTask {
  id: string;              // generated UUID
  name: string;            // unique human identifier
  description?: string;
  cron: string;            // schedule expression (any format)
  command: string;         // shell command or agent prompt
  status: "active" | "paused" | "disabled";
  scheduleType?: "cron" | "interval" | "once";
  taskType?: "shell" | "agent";
  timeoutMs?: number;      // execution timeout in milliseconds
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  failCount: number;
}
```

## Execution History

Every task run is recorded:

```typescript
interface TaskExecution {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  output?: string;         // captured stdout
  stderr?: string;         // captured stderr
  status: "running" | "success" | "failure";
}
```

On timeout, `exitCode` is `124` and output is prefixed with `[TIMED OUT after Nms]`.

## Storage

- **Path**: `~/.omp/scheduler.db`
- **Mode**: SQLite with WAL, foreign keys enabled
- **Tables**: `tasks`, `executions`
- **Indexes**: `idx_executions_task_id`, `idx_executions_started_at`
- **Migration**: New columns (`schedule_type`, `task_type`, `timeout_ms`) are added automatically via `ALTER TABLE` on existing databases.

## Timeout

All task executions are bounded by a timeout:

| Task Type | Default Timeout | Overridable |
|-----------|-----------------|-------------|
| `shell` | 30 seconds | `--timeout <ms>` |
| `agent` | 120 seconds | `--timeout <ms>` |

Agent tasks need a longer default because `omp --print` must initialize MCP servers, LSP servers, and connect to the model before executing the prompt.

```bash
# Shell task with 10-second timeout
omp schedule add quick "*/5 * * * *" --timeout 10000 "fast-check.sh"

# Agent task with 5-minute timeout
omp schedule add deep "0 2 * * *" --type agent --timeout 300000 "full codebase audit"
```

## Safety

### Recursion Prevention

Scheduled tasks cannot create new schedules. If a task tries to run `omp schedule add`, it is blocked:

```
Cannot create schedules from within a scheduled task execution.
```

This prevents infinite loops where a scheduled task schedules itself.

### One-Shot Auto-Disable

One-shot (`type: "once"`) tasks are automatically disabled after execution. They remain in the task list with `status: "disabled"` for historical reference.

## Daemon Behavior

- On start: loads all `active` tasks from DB and registers jobs
  - Cron tasks: `Cron` from `croner`
  - Interval tasks: `setInterval`
  - One-shot tasks: `setTimeout`
- On trigger: spawns `sh -c "<command>"` (or `omp --print` for agent tasks), captures output
- Every 30s: refreshes DB to pick up new/modified tasks without restart
- On SIGTERM: graceful shutdown, closes DB, removes PID file

## PID & Log Files

| File | Path | Purpose |
|------|------|---------|
| PID | `~/.omp/scheduler.pid` | Tracks running daemon |
| Log | `~/.omp/scheduler.log` | Daemon stdout/stderr |

## Dependencies

- `croner` — cron parsing and scheduling engine
- `bun:sqlite` — embedded SQLite

## Testing

```bash
# CRUD tests
bun test packages/coding-agent/test/scheduler/storage.test.ts

# Scheduling tests (cron, interval, one-shot)
bun test packages/coding-agent/test/scheduler/engine.test.ts

# New feature tests (parseSchedule, executor, timeout)
bun test packages/coding-agent/test/scheduler/enhanced-scheduler.test.ts

# Run all scheduler tests
bun test packages/coding-agent/test/scheduler/*.test.ts
```

## Future Work

- Task output delivery to messaging channels (Discord/Slack)
- Task retry with exponential backoff
- Task dependency chains
- Webhook notifications on failure
- Task templates (common patterns like "daily backup", "weekly report")
- macOS `launchd` / Linux `systemd` integration for auto-start
- Concurrency limits (max parallel tasks)
- Task output size limits and rotation

## License

MIT — same as oh-my-pi.
