# Persistent Cron Scheduler

A lightweight background scheduler for omp that runs tasks on a cron schedule, persists state in SQLite, and survives process restarts.

## Overview

The scheduler module adds cron-style task scheduling to omp. Unlike in-process timers that vanish when the CLI exits, this scheduler uses a standalone daemon that:

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
ao|┌─────────────────┐                           ┌─────────────────┐
eo|│  sh -c "cmd"    │                           │   tasks table   │
ip|│  (child process)│                           │  executions table│
vo|└─────────────────┘                           └─────────────────┘
um|```
### Components

| File | Responsibility |
|------|--------------|
| `types.ts` | Core types: `ScheduledTask`, `TaskExecution`, helper functions |
| `storage.ts` | `SchedulerDbStorage` — SQLite CRUD with prepared statements |
| `engine.ts` | `SchedulerEngine` — croner-based job scheduling |
| `daemon.ts` | `SchedulerDaemon` — daemon lifecycle, child process spawning |
| `index.ts` | Public API re-exports |

## CLI Commands

### `omp schedule` — Task Management

```bash
# Add a daily backup task
omp schedule add backup "0 2 * * *" "echo hello world"

# List all tasks (with next run time)
omp schedule list

# Run a task immediately (one-shot)
omp schedule run backup

# Disable a task without removing it
omp schedule disable backup

# Re-enable a disabled task
omp schedule enable backup

# View last 20 executions
omp schedule logs backup --json

# Remove a task permanently
omp schedule remove backup
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

## Task Schema

```typescript
interface ScheduledTask {
  id: string;          // generated UUID
  name: string;        // unique human identifier
  description?: string;
  cron: string;        // standard cron expression
  command: string;     // shell command to execute
  status: "active" | "paused" | "disabled";
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
  output?: string;     // captured stdout
  stderr?: string;     // captured stderr
  status: "running" | "success" | "failure";
}
```

## Storage

- **Path**: `~/.omp/scheduler.db`
- **Mode**: SQLite with WAL, foreign keys enabled
- **Tables**: `tasks`, `executions`
- **Indexes**: `idx_executions_task_id`, `idx_executions_started_at`

## Cron Expression Format

Uses standard 5-field cron (minute hour day month weekday):

| Expression | Meaning |
|-----------|---------|
| `0 9 * * *` | Daily at 9:00 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 * * 0` | Weekly on Sunday midnight |
| `0 0 1 * *` | Monthly on the 1st |

## Daemon Behavior

- On start: loads all `active` tasks from DB and registers croner jobs
- On trigger: spawns `sh -c "<command>"`, captures output
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
bun test test/scheduler/storage.test.ts  # CRUD tests
bun test test/scheduler/engine.test.ts   # scheduling tests
```

## Future Work

- Task output delivery to messaging channels (Discord/Slack)
- Task retry with exponential backoff
- Task dependency chains
- Webhook notifications on failure
- Task templates (common patterns like "daily backup", "weekly report")
- macOS `launchd` / Linux `systemd` integration for auto-start
- Task execution timeout and cancellation
- Concurrency limits (max parallel tasks)
- Task output size limits and rotation

## License

MIT — same as oh-my-pi.
