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
- **Intent classification** (v2): Hybrid rule/LLM classification of user intent per episode
- **User profiling** (v2): Behavioral profiling — tool frequency, intent distribution, error patterns
- **Workflow mining** (v2): Extracts reusable tool-sequence patterns from successful sessions
- **Feedback tracking** (v2): Records episode injection outcomes to learn what helps
- **Context-aware retrieval** (v2): Multi-factor scoring (intent match, recency, success rate) for better episode ranking

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
# Space syntax (required by omp)
omp --self-evolution-skill-threshold 2

# Equals syntax is NOT supported
# omp --self-evolution-skill-threshold=2
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
| `/evolution-profile` (v2) | Display current user behavioral profile |
| `/evolution-workflows` (v2) | List mined workflow patterns by intent

## Agent Tools

The plugin registers three tools that the LLM can call during sessions:

- `query_episodic_memory` — Search past experiences by keyword
- `list_evolved_skills` — Browse the skill library with filtering
- `optimize_skill_prompt` — Run GEPA-style optimization on a skill

## Learning Loop

User task
    |
    v
TraceRecorder captures events (tool calls, errors, messages, user prompt)
    |
    v
agent_end:
  - evaluate session -> archive as Episode
  - classify intent -> store in episode_intents
  - mine workflow pattern -> store in workflow_patterns
  - update user profile -> store in user_profiles
  - if episodes were injected: record effectiveness in episode_effectiveness
    |
    v
If significant (tool calls >= threshold): extract Skill
    |
    v
before_agent_start next session:
  - classify current intent
  - retrieve relevant Episodes (intent-aware + context-aware scoring)
  - inject into system prompt
  - track injected episode IDs for feedback

## Storage

All data is stored project-local under `<project-root>/.omp/self-evolution/`:

.omp/self-evolution/
├── evolution.db          # SQLite with WAL + FTS5
│   ├── episodes          # Session archives
│   ├── episodes_fts      # Full-text search virtual table
│   ├── skills            # Current skill versions
│   ├── skill_versions    # Historical snapshots
│   ├── stats             # Counters
│   ├── episode_intents   # (v2) Per-episode intent classification
│   ├── workflow_patterns # (v2) Reusable tool-sequence patterns
│   ├── user_profiles     # (v2) Behavioral profiles
│   └── episode_effectiveness # (v2) Injection outcome tracking
└── activity.log          # JSONL audit log

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
| `intent-classifier.ts` (v2) | Hybrid rule/LLM intent classification |
| `user-profiler.ts` (v2) | Incremental behavioral profiling |
| `workflow-miner.ts` (v2) | Tool-sequence pattern extraction |
| `feedback-tracker.ts` (v2) | Episode injection outcome tracking |
| `context-aware-retriever.ts` (v2) | Multi-factor episode scoring |
| `storage/*.ts` | SQLite persistence layer |
| `logging/activity-logger.ts` | JSONL structured logging |

## License

MIT
