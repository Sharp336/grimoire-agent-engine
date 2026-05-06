# Self-Evolution v2.0: Intent Modeling + User Profiling

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Transform self-evolution from a session memo into an intent-aware, profile-driven experience system. Episodes carry semantic intent labels, skills represent reusable workflow patterns, and prompt injection adapts to the user's demonstrated preferences.

**Architecture:** Hybrid classification (rule-based common patterns + LLM fallback) for intent labeling, statistical profiling for user preference vectors, and context-aware injection that filters episodes by intent relevance and re-ranks by profile match.

**Tech Stack:** SQLite (existing) + FTS5 + custom tables, `bun:sqlite`, `@oh-my-pi/pi-ai` for LLM fallback calls, existing `callBackgroundLlm` utility.

---

## 1. Problem Statement

v1 records *what* happened (tool calls, files, prompts) but not *why* or *how the user prefers to work*. This limits:
- **Retrieval quality**: Keyword matching cannot distinguish "fix a bug" from "refactor a function" from "add a feature".
- **Skill reusability**: Extracted skills are just tool lists, not reusable workflow patterns.
- **Injection noise**: Every episode is injected regardless of whether it helps the current task type.
- **Personalization**: The system treats every user identically, ignoring individual work styles.

## 2. Design Overview

### 2.1 Intent Modeling

Each episode gets classified into an **intent category** with a confidence score.

| Intent | Description | Primary Rule Signals |
|---|---|---|
| `refactoring` | Restructure without behavior change | `ast_edit`, prompt: "refactor", "rename", "extract" |
| `bugfix` | Fix errors or bugs | `errorCount > 0` or `hadRecovery`, prompt: "fix", "bug", "broken" |
| `feature-add` | Add new functionality | New files created, prompt: "add", "implement", "create" |
| `testing` | Write or fix tests | Test runner tools, prompt: "test", "spec" |
| `documentation` | Write docs, comments | `.md` modifications, prompt: "doc", "README" |
| `configuration` | Config, CI/CD, tooling | Config file extensions, prompt: "config", "CI" |
| `exploration` | Read code to understand | `toolCallCount == 0` or mostly `read`/`search` |
| `optimization` | Performance improvements | Prompt: "optimize", "performance", "speed" |
| `integration` | Connect systems/APIs | Prompt: "connect", "integrate", "API", package manager |

**Classification pipeline:**
1. Rule engine scores each intent (0-100) based on prompt keywords + tool signals
2. If top score >= 70 and gap to second >= 15 → accept rule result
3. Else → LLM fallback (`callBackgroundLlm` with classification prompt)
4. Store in `episode_intents(intent TEXT, confidence REAL, source TEXT)`

**Workflow pattern mining:**
- Extract the tool sequence from each episode (deduplicated consecutive identical tools)
- Hash the sequence to a pattern ID
- Count frequency per intent category
- Patterns with >= 3 occurrences become "workflow templates"

### 2.2 User Profiling

A per-project user profile tracks behavioral patterns across sessions.

| Dimension | Tracked Signal | Usage |
|---|---|---|
| **Tool Preference** | Tool usage frequency and ordering | When recommending next steps, prefer user's habitual tools |
| **Work Style** | Step size (files per session), error tolerance | Inject episodes from users with similar granularity |
| **Domain Knowledge** | File types, frameworks, languages encountered | Weight episodes from matching tech stack higher |
| **Interaction Preference** | Detail level in responses | Tune injection verbosity |

**Profile representation:** A JSON object stored in the `user_profiles` table, updated incrementally after each episode. Example structure:

```json
{
  "toolFrequency": { "read": 45, "edit": 30, "ast_edit": 12, "search": 28 },
  "toolTransitions": { "read→edit": 25, "search→edit": 18, "edit→test": 20 },
  "intentDistribution": { "bugfix": 15, "refactoring": 22, "feature-add": 35 },
  "avgToolCallsPerSession": 4.2,
  "avgFilesModifiedPerSession": 2.1,
  "errorRate": 0.08,
  "recoveryRate": 0.67,
  "preferredLanguages": ["typescript", "rust"],
  "responseStyle": "concise"
}
```

### 2.3 Context-Aware Prompt Injection (v2)

**Before (v1):** Inject top-3 recent episodes by keyword match, regardless of intent.

**After (v2):**
1. Classify the *current* user prompt into an intent
2. Retrieve candidate episodes matching that intent (priority)
3. Rerank by: intent match > profile similarity > recency > success rate
4. Inject only the top N with a relevance threshold (score >= 40)
5. Format injection as structured experience cards, not raw summaries

**Injection format:**
```
## Relevant Past Experience

[refactoring] Renamed variables in auth module
Approach: Used ast_edit for batch renaming, then read to verify.
Pitfall: Forgot to update references in test files.

[bugfix] Fixed null pointer in user service
Approach: Added defensive check after read of config file.
Pitfall: The error only manifested with empty user data.
```

### 2.4 Feedback Loop

Track whether injected episodes actually helped:
- If the current task succeeds with no recovery, increment `successCount` for injected episodes
- If the current task has errors or recovery, increment `failureCount`
- Use this to weight future retrieval (successful episodes rank higher)

## 3. Data Model

### New Tables

```sql
-- Episode-intent junction (one episode can have multiple intents)
CREATE TABLE episode_intents (
    episode_id TEXT NOT NULL,
    intent TEXT NOT NULL,
    confidence REAL NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('rule', 'llm')),
    PRIMARY KEY (episode_id, intent),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

-- Workflow patterns mined from tool sequences
CREATE TABLE workflow_patterns (
    id TEXT PRIMARY KEY,
    intent TEXT NOT NULL,
    tool_sequence TEXT NOT NULL,  -- JSON array
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    avg_quality_score REAL,
    last_seen_at INTEGER NOT NULL
);

-- User behavioral profile (per project)
CREATE TABLE user_profiles (
    id TEXT PRIMARY KEY DEFAULT 'default',
    profile_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Episode effectiveness tracking for feedback loop
CREATE TABLE episode_effectiveness (
    episode_id TEXT PRIMARY KEY,
    times_injected INTEGER NOT NULL DEFAULT 0,
    times_helped INTEGER NOT NULL DEFAULT 0,
    times_failed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
```

### Modified Tables

- `episodes` table: no schema changes needed (intents stored in junction table)
- `skills` table: add `intent TEXT` column to link skills to their primary intent

## 4. Components

### 4.1 `IntentClassifier` (new)
- `classify(prompt: string, trace: SessionTrace): IntentResult`
- Rule-based scoring engine
- LLM fallback for ambiguous cases

### 4.2 `WorkflowMiner` (new)
- `mine(trace: SessionTrace, intent: string): WorkflowPattern | undefined`
- Extracts deduplicated tool sequence
- Updates frequency counters in `workflow_patterns`

### 4.3 `UserProfiler` (new)
- `updateProfile(trace: SessionTrace, intent: string): void`
- Incrementally updates JSON profile after each episode
- `getProfile(): UserProfile`

### 4.4 `ContextAwareRetriever` (modifies `EpisodeRetriever`)
- `retrieve(query: string, currentIntent: string, profile: UserProfile): RerankedEpisode[]`
- Intent-first filtering
- Profile-aware reranking

### 4.5 `FeedbackTracker` (new)
- `trackInjection(episodeIds: string[]): void`
- `recordOutcome(episodeIds: string[], succeeded: boolean): void`
- Updates `episode_effectiveness`

## 5. Integration Points

### `agent_end` handler (modified)
1. Classify current episode's intent (IntentClassifier)
2. Store intent classification in `episode_intents`
3. Mine workflow pattern (WorkflowMiner)
4. Update user profile (UserProfiler)
5. Record feedback for previously injected episodes (FeedbackTracker)

### `before_agent_start` handler (modified)
1. Classify current prompt intent
2. Retrieve context-aware episodes (ContextAwareRetriever)
3. Track which episodes are being injected (FeedbackTracker)
4. Format structured injection cards

## 6. Testing Plan

### Unit Tests
- `IntentClassifier`: test rule-based classification for all 9 intents
- `IntentClassifier`: test LLM fallback triggers correctly
- `WorkflowMiner`: test sequence deduplication and hashing
- `UserProfiler`: test incremental profile updates
- `FeedbackTracker`: test success/failure counting

### Integration Tests
- End-to-end: send task → classify intent → verify `episode_intents` row
- End-to-end: send 3 similar tasks → verify workflow pattern frequency >= 3
- End-to-end: send task after profile exists → verify injection is intent-filtered

### Contract Tests
- `IntentClassifier.classify` always returns result with intent + confidence
- `UserProfiler` profile JSON is always valid and parseable
- `ContextAwareRetriever` never returns episodes with different intent when `intentFilter` is set

## 7. Phases

| Phase | Focus | Deliverable |
|---|---|---|
| Phase 1 | Intent Classification + DB schema | `IntentClassifier`, schema migrations, tests |
| Phase 2 | User Profiling + Workflow Mining | `UserProfiler`, `WorkflowMiner`, feedback loop |
| Phase 3 | Context-Aware Retrieval + Injection | `ContextAwareRetriever`, injection v2, integration tests |

## 8. Migration Notes

- v1 episodes have no intent classification → backfill with lazy classification on first retrieval
- v1 skills have no intent column → default to `exploration` on first access
- New tables are additive; no data loss

## 9. Success Criteria

- [ ] Intent classification accuracy >= 80% on manual test set of 20 diverse tasks
- [ ] User profile converges (stabilizes) after 10+ sessions
- [ ] Context-aware retrieval shows measurable improvement over v1 keyword retrieval
- [ ] Feedback loop reduces injection of unhelpful episodes by >= 30%
