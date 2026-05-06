# @oh-my-pi/self-evolution

Self-evolution plugin for oh-my-pi. Automatically extracts reusable skills from agent sessions and retrieves relevant past experiences to improve future task performance.

## Features

- **Automatic skill extraction**: Identifies reusable patterns from completed tasks
- **Episodic memory**: Archives session traces with full-text search (FTS5)
- **Experience injection**: Injects relevant past episodes into the system prompt
- **Skill versioning**: Keeps historical snapshots with rollback support
- **Activity logging**: Structured JSONL audit log for debugging and analysis
- **Heuristic quality scoring**: 0-100 multi-dimensional skill evaluation
- **LLM refinement (optional)**: Uses background LLM calls to improve skill quality

## Installation

This plugin is bundled with `pi-coding-agent` and loads automatically as an inline extension. No separate installation is required.

## Configuration

### CLI Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--self-evolution` | boolean | `true` | Master toggle |
| `--no-self-evolution` | — | — | Disable the plugin entirely |
| `--self-evolution-skill-threshold` | string | `"5"` | Minimum tool calls to trigger skill extraction |
| `--self-evolution-max-episodes` | string | `"100"` | Maximum episodes to retain |
| `--no-self-evolution-enable-prompt-injection` | — | — | Disable experience injection into system prompt |
| `--no-self-evolution-llm-refinement` | — | — | Use rule-only skill extraction (no LLM) |
| `--no-self-evolution-llm-rerank` | — | — | Use keyword-only retrieval (no LLM rerank) |
| `--no-self-evolution-enable-versioning` | — | — | Disable skill version snapshots |
| `--no-self-evolution-enable-activity-log` | — | — | Disable JSONL activity logging |

Example:
```bash
omp --self-evolution-skill-threshold=2
```

## Slash Commands

Type `/` in interactive mode to see all commands.

| Command | Description |
|---|---|
| `/evolution-status` | Show statistics: episodes, skills, versions |
| `/evolution-skills` | List all evolved skills with quality and success rate |
| `/evolution-archive` | Archive low-quality skills (quality < 30, unused) |
| `/evolution-skill-history <name>` | View version history for a skill |
| `/evolution-rollback <name> <version>` | Rollback a skill to a specific version |

## Agent Tools

The plugin registers three tools that the LLM can call during sessions:

- `query_episodic_memory` — Search past experiences by keyword
- `list_evolved_skills` — Browse the skill library with filtering
- `optimize_skill_prompt` — Run GEPA-style optimization on a skill

## Learning Loop

```
User task
    |
    v
TraceRecorder captures events (tool calls, errors, messages)
    |
    v
agent_end: evaluate session -> archive as Episode
    |
    v
If significant (tool calls >= threshold): extract Skill
    |
    v
before_agent_start next session: retrieve relevant Episodes -> inject into system prompt
```

## Storage

All data is stored project-local under `<project-root>/.omp/self-evolution/`:

```
.omp/self-evolution/
├── evolution.db          # SQLite with WAL + FTS5
│   ├── episodes          # Session archives
│   ├── episodes_fts      # Full-text search virtual table
│   ├── skills            # Current skill versions
│   ├── skill_versions    # Historical snapshots
│   └── stats             # Counters
└── activity.log          # JSONL audit log
```

This design ensures **project isolation**: skills learned in a React project never leak into a Python project.

## Activity Log

View recent operations:

```bash
# All events
cat .omp/self-evolution/activity.log

# Last 20 events
tail -20 .omp/self-evolution/activity.log

# Pretty-print
cat .omp/self-evolution/activity.log | jq .
```

Log rotates automatically at 10MB (keeps 3 files).

## Database Queries

Inspect stored data directly:

```bash
# Recent episodes
sqlite3 .omp/self-evolution/evolution.db \
  "SELECT user_prompt, tool_call_count, completed_successfully FROM episodes ORDER BY timestamp DESC LIMIT 5;"

# Skills
sqlite3 .omp/self-evolution/evolution.db \
  "SELECT name, version, quality_score, tools FROM skills;"

# Version history
sqlite3 .omp/self-evolution/evolution.db \
  "SELECT name, version, change_type FROM skill_versions ORDER BY changed_at DESC;"
```

## Architecture

| Module | Purpose |
|---|---|
| `trace.ts` | In-memory session trace recording |
| `extractor.ts` | Rule + LLM skill extraction |
| `evaluator.ts` | Heuristic quality scoring (0-100) |
| `manager.ts` | Skill lifecycle: merge, deprecate, rollback |
| `retrieval.ts` | Keyword recall + optional LLM rerank |
| `optimizer.ts` | GEPA-style prompt optimization |
| `storage/*.ts` | SQLite persistence layer |
| `logging/activity-logger.ts` | JSONL structured logging |

## License

MIT
