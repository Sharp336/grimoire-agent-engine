# @oh-my-pi/self-evolution

Self-evolution plugin for oh-my-pi. Automatically extracts reusable skills from agent sessions, learns project conventions, detects inefficiency patterns in real time, and retrieves relevant past experiences to improve future task performance.

## Features

### Core Loop

- **Automatic skill extraction**: Identifies reusable patterns from completed sessions (rule-based + optional LLM refinement)
- **Episodic memory**: Archives session traces with full-text search (FTS5) for cross-session recall
- **Experience injection**: Injects relevant past episodes, skills, and conventions into the system prompt before each session
- **Skill versioning**: Keeps historical snapshots with rollback support and GEPA-style prompt optimization
- **Heuristic quality scoring**: 0-100 multi-dimensional evaluation (success rate, tool diversity, pitfall coverage, description quality, user rating)

### Behavioral Intelligence (v2)

- **Intent classification**: Hybrid rule/LLM classification — 9 categories (refactoring, bugfix, feature-add, testing, documentation, configuration, exploration, optimization, integration)
- **User profiling**: Incremental behavioral profile — tool frequency, tool transitions, intent distribution, error/recovery rates, preferred languages
- **Workflow mining**: Extracts reusable tool-sequence patterns from successful sessions, grouped by intent
- **Feedback tracking**: Records injection outcomes (times helped / failed) to learn which episodes are actually useful
- **Context-aware retrieval**: Multi-factor scoring — intent match (0-40), keyword match (0-30), success boost (0-15), recovery (0-5), recency (0-10), profile affinity (0-15), effectiveness feedback (0-20). Optional LLM rerank for final selection.

### Real-Time Nudge System

- **NudgeDetector**: Monitors tool execution results in real time, detects inefficiency patterns with causal root-cause attribution:
  - Cascading read-verify failures after broken edits
  - Edit-verify path mismatches
  - Search-misled read attempts
  - Error cascades (3+ consecutive failures with root-cause hints)
  - Redundant search loops (3+ consecutive searches without modification)
  - Slow loops (high tool count, no file modifications — possible spinning)
  - Read-only after write (multiple reads after last modification, suggesting verification is complete)
- **NudgeDeliverer**: Shows in-session hints with cooldown (30s) to prevent spam

### Convention System (v2.5)

- **Convention extraction**: Extracts project-specific rules from user dialogue — 5 types: `negative_rule`, `positive_rule`, `preference`, `project_fact`, `procedural_rule`
- **Convention compliance**: Heuristic checker verifies whether the agent followed injected conventions during a session (file modification checks, tool usage checks)
- **Convention feedback loop**: Tracks compliance/violation per session, surfaces violations in daily/audit reports

### Effectiveness Analysis (v2.5)

- **EffectivenessAnalyzer**: Multi-dimensional scoring of injection outcomes:
  - Explicit correction detection ("不对", "错了", "incorrect" etc.)
  - Explicit approval detection ("好的", "thanks", "perfect" etc.)
  - Redundancy via Jaccard overlap of prompts
  - Error avoidance (whether the same tools errored as in the injected episode)
  - Tool efficiency comparison
  - Success bonus
- **InjectionOutcome**: Per-episode helpfulness score [-1, 1] with 6 signal dimensions

### Reporting & Diagnostics

- **Daily Report** (`/evolution report`): Session breakdown with success/failure/empty/partial counts, top error patterns, key moments (error/recovery/success/correction), new conventions, top tools
- **Audit Report** (`/evolution audit`): System health check — episode capacity, success rate, skill quality, injection help rate, intent distribution, workflow meaningfulness, convention coverage, user profile summary, auto-generated issues and recommendations
- **Fit Evaluation** (`/evolution fit`): "懂我程度" scoring across 5 dimensions — 个人记忆留存 (memory), 思维模式适配 (thinking), 输出风格贴合 (style), 隐含需求预判 (prediction), 历史对话联动 (history). Total 0-100 with trend tracking and verdict (明显更懂我 → 明显不懂我)
- **Trace Analyzer** (v2.6): Causal tool-chain diagnosis — read failure classification, cascade pattern detection, tool efficiency metrics, cross-session trend analysis

### Agent Tools

The plugin registers three tools the LLM can call during sessions:

| Tool | Description |
|---|---|
| `query_episodic_memory` | Search past experiences by keyword (FTS5 + context-aware scoring) |
| `list_evolved_skills` | Browse the skill library with quality/deprecation filtering |
| `optimize_skill_prompt` | Run GEPA-style optimization on a skill's approach text |

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

All commands are consolidated under `/evolution <subcommand>`. Old flat commands (e.g. `/evolution-status`) are deprecated but still work with a redirect hint.

| Subcommand | Description |
|---|---|
| `/evolution status` | Show statistics: episodes, skills, versions, sessions archived |
| `/evolution skills [--detail]` | List evolved skills with quality, success rate, user rating; `--detail` shows score breakdown |
| `/evolution rate <name> <1-5>` | Rate a skill 1-5 stars (affects quality score) |
| `/evolution clear` | Clear all self-evolution data (requires manual directory deletion) |
| `/evolution archive` | Archive low-quality skills (quality < 30, unused) |
| `/evolution history <name>` | View version history for a skill |
| `/evolution rollback <name> <version>` | Rollback a skill to a specific version |
| `/evolution profile` | Display current user behavioral profile |
| `/evolution workflows [intent]` | List mined workflow patterns, optionally filtered by intent |
| `/evolution audit` | Generate system health report with issues and recommendations |
| `/evolution report` | Generate daily session report |
| `/evolution fit` | Run "懂我程度" evaluation |

## Learning Loop

```
User task
    |
    v
TraceRecorder captures events (tool calls, errors, messages, user prompt)
    |
    v
tool_execution_end → NudgeDetector checks for inefficiency patterns → NudgeDeliverer shows hint (if any)
    |
    v
agent_end:
  - evaluate session → archive as Episode
  - classify intent → store in episode_intents
  - mine workflow pattern → store in workflow_patterns
  - update user profile → store in user_profiles
  - extract conventions from dialogue → store in conventions
  - check convention compliance for this session → store in convention_feedback
  - if episodes were injected: analyze effectiveness → store in episode_effectiveness / skill_effectiveness
    |
    v
If significant (tool calls >= threshold): extract Skill (rule + optional LLM)
    |
    v
before_agent_start next session:
  - classify current intent
  - retrieve relevant Episodes (context-aware scoring: intent + keyword + success + profile + effectiveness)
  - retrieve relevant Skills and Conventions
  - inject into system prompt
  - track injected episode/skill/convention IDs for feedback
```

## Storage

All data is stored project-local under `<project-root>/.omp/self-evolution/`:

```
.omp/self-evolution/
├── evolution.db          # SQLite with WAL + FTS5
│   ├── episodes          # Session archives
│   ├── episodes_fts      # Full-text search virtual table
│   ├── skills            # Current skill versions (with user_rating)
│   ├── skill_versions    # Historical snapshots
│   ├── stats             # Counters
│   ├── episode_intents   # Per-episode intent classification
│   ├── workflow_patterns # Reusable tool-sequence patterns
│   ├── user_profiles     # Behavioral profiles
│   ├── episode_effectiveness # Episode injection outcome tracking
│   ├── skill_effectiveness # Skill injection outcome tracking
│   ├── conventions       # Project-specific rules extracted from dialogue
│   ├── convention_feedback # Per-session convention compliance records
│   ├── episode_detailed_outcomes # Detailed outcome analysis
│   ├── nudge_history     # Cross-session nudge records
│   └── fit_scores        # "懂我程度" evaluation history
└── activity.log          # JSONL audit log
```

This design ensures **project isolation**: skills learned in a React project never leak into a Python project.

### Database Schema Overview

| Table | Purpose |
|---|---|
| `episodes` | Core session records — prompt, tool count, error count, summary, tools used, files modified |
| `episodes_fts` | FTS5 virtual table for semantic search |
| `skills` | Current skill state — name, description, approach, tools, pitfalls, quality score, user rating |
| `skill_versions` | Version history — snapshots with change type and reason |
| `episode_intents` | Intent classification results per episode (9 categories, confidence, source) |
| `workflow_patterns` | Mined tool sequences per intent (occurrence count, avg quality) |
| `user_profiles` | Aggregated behavioral profile (tool frequency, transitions, intent distribution) |
| `episode_effectiveness` | Injection tracking — times injected, helped, failed per episode |
| `skill_effectiveness` | Injection tracking — times injected, helped, failed per skill |
| `conventions` | Project rules — type, content, confidence, violation counters |
| `convention_feedback` | Compliance records — per-session complied/violated with details |
| `nudge_history` | Real-time nudge records — type, severity, message, suggestion |
| `fit_scores` | Fit evaluation history — 5 dimension scores, verdict, trend |

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

# Skills with user ratings
sqlite3 .omp/self-evolution/evolution.db \
  "SELECT name, version, quality_score, user_rating, tools FROM skills;"

# Convention compliance
sqlite3 .omp/self-evolution/evolution.db \
  "SELECT c.type, c.content, COUNT(cf.complied) as checks, SUM(CAST(cf.complied AS INT)) as complied FROM conventions c LEFT JOIN convention_feedback cf ON c.id = cf.convention_id GROUP BY c.id;"

# Fit score trend
sqlite3 .omp/self-evolution/evolution.db \
  "SELECT date, total_score, verdict FROM fit_scores ORDER BY date DESC LIMIT 5;"
```

## Architecture

| Module | Purpose |
|---|---|
| `trace.ts` | In-memory session trace recording |
| `extractor.ts` | Rule + LLM skill extraction |
| `evaluator.ts` | Heuristic quality scoring (0-100, 10 dimensions including user rating) |
| `manager.ts` | Skill lifecycle: merge, deprecate, rollback, archive |
| `retrieval.ts` | Keyword recall + optional LLM rerank (legacy) |
| `context-aware-retriever.ts` | Multi-factor episode scoring with intent, profile, effectiveness |
| `optimizer.ts` | GEPA-style prompt optimization |
| `intent-classifier.ts` | Hybrid rule/LLM intent classification (9 categories) |
| `user-profiler.ts` | Incremental behavioral profiling |
| `workflow-miner.ts` | Tool-sequence pattern extraction |
| `feedback-tracker.ts` | Episode injection outcome tracking |
| `effectiveness-analyzer.ts` | Multi-dimensional injection outcome scoring (6 signals) |
| `convention-extractor.ts` | Project-specific rule extraction from dialogue |
| `convention-compliance.ts` | Heuristic convention adherence checking |
| `nudge-detector.ts` | Real-time inefficiency pattern detection with causal attribution |
| `nudge-deliverer.ts` | In-session nudge delivery with cooldown |
| `trace-analyzer.ts` | Causal tool-chain diagnosis, read failure classification |
| `daily-report.ts` | Daily session report generation |
| `audit-report.ts` | System health check with auto-generated issues and recommendations |
| `eval/fit-evaluator.ts` | "懂我程度" evaluation orchestration |
| `eval/fit-scorer.ts` | Per-dimension scoring and report building |
| `eval/fit-test-tasks.ts` | Test task definitions for each fit dimension |
| `storage/*.ts` | SQLite persistence layer |
| `logging/activity-logger.ts` | JSONL structured logging |
| `commands.ts` | Consolidated `/evolution` command hub with subcommands |

## License

MIT
