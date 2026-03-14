# XDG Base Directory Migration

Omp stores user data in locations conforming to the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). Data is split across three XDG trees based on semantic category.

## Directory layout

| Path | Category | Default location |
|---|---|---|
| `$XDG_DATA_HOME/omp/agent.db` | Persistent data (settings, auth) | `~/.local/share/omp/agent.db` |
| `$XDG_DATA_HOME/omp/history.db` | Persistent data (session history) | `~/.local/share/omp/history.db` |
| `$XDG_DATA_HOME/omp/models.db` | Persistent data (model cache) | `~/.local/share/omp/models.db` |
| `$XDG_DATA_HOME/omp/sessions/` | Persistent data (session blobs) | `~/.local/share/omp/sessions/` |
| `$XDG_DATA_HOME/omp/blobs/` | Persistent data (content store) | `~/.local/share/omp/blobs/` |
| `$XDG_DATA_HOME/omp/stats.db` | Persistent data (usage stats) | `~/.local/share/omp/stats.db` |
| `$XDG_DATA_HOME/omp/plugins/` | Persistent data (plugins) | `~/.local/share/omp/plugins/` |
| `$XDG_DATA_HOME/omp/remote/` | Persistent data (remote configs) | `~/.local/share/omp/remote/` |
| `$XDG_DATA_HOME/omp/remote-host/` | Persistent data (remote host data) | `~/.local/share/omp/remote-host/` |
| `$XDG_DATA_HOME/omp/python-env/` | Persistent data (Python virtualenv) | `~/.local/share/omp/python-env/` |
| `$XDG_DATA_HOME/omp/wt/` | Persistent data (git worktrees) | `~/.local/share/omp/wt/` |
| `$XDG_STATE_HOME/omp/memories/` | Runtime state (agent memories) | `~/.local/state/omp/memories/` |
| `$XDG_STATE_HOME/omp/terminal-sessions/` | Runtime state | `~/.local/state/omp/terminal-sessions/` |
| `$XDG_STATE_HOME/omp/logs/` | Runtime state (log files) | `~/.local/state/omp/logs/` |
| `$XDG_STATE_HOME/omp/reports/` | Runtime state (reports) | `~/.local/state/omp/reports/` |
| `$XDG_STATE_HOME/omp/ssh-control/` | Runtime state (SSH control sockets) | `~/.local/state/omp/ssh-control/` |
| `$XDG_STATE_HOME/omp/omp-crash.log` | Runtime state (crash log) | `~/.local/state/omp/omp-crash.log` |
| `$XDG_STATE_HOME/omp/omp-debug.log` | Runtime state (debug log) | `~/.local/state/omp/omp-debug.log` |
| `$XDG_CACHE_HOME/omp/puppeteer/` | Cache (browser binaries) | `~/.cache/omp/puppeteer/` |
| `$XDG_CACHE_HOME/omp/gpu_cache.json` | Cache (GPU capability cache) | `~/.cache/omp/gpu_cache.json` |
| `$XDG_CACHE_HOME/omp/natives/` | Cache (compiled native binaries) | `~/.cache/omp/natives/` |

SQLite WAL sidecar files (`-shm`, `-wal`) are migrated alongside their main database file.

Configuration files (MCP config, SSH config, themes, AGENTS.md, etc.) remain under the config root, which defaults to `~/.config/omp` when `PI_CONFIG_DIR=.config/omp` is set, or `~/.omp` otherwise.

## Runtime fallback

Each path accessor in `packages/utils/src/dirs.ts` checks the XDG location first. If the XDG path does not exist on disk (i.e., migration has not been run), it falls back to the legacy location under the config root. This makes migration non-breaking: unmigrated installs continue to work.

```
getAgentDbPath()
  → $XDG_DATA_HOME/omp/agent.db   (if exists)
  → $config_root/agent/agent.db   (fallback)
```

The check is existence-based (`fs.existsSync`), not configuration-based. There is no flag to toggle — the presence of the file at the XDG path is the signal.

Setting XDG environment variables without running the migration has no effect: the fallback fires whenever the XDG path is absent, regardless of environment.

## Migrating

Run the migration command to move all data to XDG locations:

```bash
# Preview what will move
omp config migrate --dry-run

# Execute migration
omp config migrate

# Overwrite conflicting files if target already contains them
omp config migrate --force
```

The command:
1. Builds a plan of all items present at legacy locations
2. For each item, copies to the XDG target
3. Verifies integrity (size + SHA-256 for files; recursive per-entry presence + checksums for directories). In non-force mode, files that were skipped because the target already existed are accepted as-is — size mismatch between source and pre-existing target is treated as intentional and not a failure.
4. Deletes the source only after verification passes
5. Stops on any error — already-copied items remain at the new location, source items are untouched

### Partial migration and merging

Directory items (`sessions/`, `memories/`, `terminal-sessions/`, `logs/`, `reports/`, `plugins/`, `remote/`, `remote-host/`, `python-env/`, `wt/`, `ssh-control/`) are merged rather than replaced. If the target directory already exists:

- Without `--force`, conflicting children are skipped silently; non-conflicting children are always copied.
- With `--force`, conflicting children are overwritten.

This means a migration interrupted halfway (or a target directory pre-populated from another source) can be resumed without `--force` as long as there are no filename collisions.

## Implementation

- Path accessors: `packages/utils/src/dirs.ts` — `getXdgDataPath()` / `getXdgStatePath()` / `getXdgCachePath()` helpers, called by each individual accessor
- Memory root: `packages/coding-agent/src/memories/index.ts` — `getMemoryRoot()` delegates to `getMemoriesDir()` so post-migration reads and writes land in the correct XDG location
- Migration logic: `packages/coding-agent/src/cli/commands/migrate-xdg.ts`
- CLI entry: `omp config migrate` via `packages/coding-agent/src/cli/commands/config.ts`
