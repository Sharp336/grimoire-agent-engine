# Self-Evolution v2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement intent classification, user profiling, and context-aware retrieval for the self-evolution plugin.

**Architecture:** Hybrid rule/LLM intent classification, statistical user profiling, intent-filtered + profile-ranked episode retrieval.

**Tech Stack:** `bun:sqlite`, TypeScript, `@oh-my-pi/pi-ai` for LLM fallback, existing `callBackgroundLlm` utility.

---

## Phase 1: Intent Classification + Database Schema

### Task 1.1: Add new types for intent classification

**Files:**
- Create: `packages/self-evolution/src/types.ts` (modify existing)

- [ ] **Step 1: Write the type additions**

Add these types to `packages/self-evolution/src/types.ts` (append to the end of the file):

```typescript
// ============================================================================
// Intent Classification (v2)
// ============================================================================

export type IntentCategory =
	| "refactoring"
	| "bugfix"
	| "feature-add"
	| "testing"
	| "documentation"
	| "configuration"
	| "exploration"
	| "optimization"
	| "integration";

export interface IntentResult {
	intent: IntentCategory;
	confidence: number;
	source: "rule" | "llm";
	allScores: Record<IntentCategory, number>;
}

export interface EpisodeIntent {
	episodeId: string;
	intent: IntentCategory;
	confidence: number;
	source: "rule" | "llm";
}

// ============================================================================
// Workflow Patterns (v2)
// ============================================================================

export interface WorkflowPattern {
	id: string;
	intent: IntentCategory;
	toolSequence: string[];
	occurrenceCount: number;
	avgQualityScore: number;
	lastSeenAt: number;
}

// ============================================================================
// User Profile (v2)
// ============================================================================

export interface UserProfile {
	toolFrequency: Record<string, number>;
	toolTransitions: Record<string, number>;
	intentDistribution: Record<string, number>;
	avgToolCallsPerSession: number;
	avgFilesModifiedPerSession: number;
	errorRate: number;
	recoveryRate: number;
	preferredLanguages: string[];
	sessionCount: number;
	updatedAt: number;
}

// ============================================================================
// Episode Effectiveness (v2)
// ============================================================================

export interface EpisodeEffectiveness {
	episodeId: string;
	timesInjected: number;
	timesHelped: number;
	timesFailed: number;
}
```

- [ ] **Step 2: Run type check**

Run: `cd packages/self-evolution && bun run check`

Expected: PASS (types compile, no errors)

- [ ] **Step 3: Commit**

```bash
git add packages/self-evolution/src/types.ts
git commit -m "feat(self-evolution): add v2 intent, workflow, profile, effectiveness types"
```

---

### Task 1.2: Write failing test for IntentClassifier

**Files:**
- Create: `packages/self-evolution/tests/intent-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { IntentClassifier } from "../src/intent-classifier";
import type { SessionTrace } from "../src/types";

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	return {
		sessionId: "test-session",
		cwd: "/tmp",
		userPrompt: overrides.userPrompt ?? "test",
		startTime: Date.now(),
		endTime: Date.now(),
		toolCallCount: overrides.toolCallCount ?? 0,
		errorCount: overrides.errorCount ?? 0,
		hadRecovery: overrides.hadRecovery ?? false,
		completedSuccessfully: overrides.completedSuccessfully ?? true,
		entries: overrides.entries ?? [],
	};
}

describe("IntentClassifier.ruleClassify", () => {
	test("classifies refactoring from ast_edit tool", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({
			userPrompt: "refactor this function",
			entries: [{ type: "tool_call", timestamp: Date.now(), toolName: "ast_edit", args: {} }],
		});
		const result = classifier.ruleClassify(trace);
		expect(result.intent).toBe("refactoring");
		expect(result.confidence).toBeGreaterThanOrEqual(70);
		expect(result.source).toBe("rule");
	});

	test("classifies bugfix from errorCount > 0", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({
			userPrompt: "fix the broken login",
			errorCount: 2,
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
			],
		});
		const result = classifier.ruleClassify(trace);
		expect(result.intent).toBe("bugfix");
		expect(result.confidence).toBeGreaterThanOrEqual(70);
	});

	test("classifies feature-add from prompt keywords", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({
			userPrompt: "add a new OAuth provider",
		});
		const result = classifier.ruleClassify(trace);
		expect(result.intent).toBe("feature-add");
	});

	test("returns exploration when no signals", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({ userPrompt: "hello" });
		const result = classifier.ruleClassify(trace);
		expect(result.intent).toBe("exploration");
		expect(result.confidence).toBeLessThan(70);
	});

	test("allScores sums all intent categories", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({ userPrompt: "test" });
		const result = classifier.ruleClassify(trace);
		const categories = [
			"refactoring", "bugfix", "feature-add", "testing",
			"documentation", "configuration", "exploration", "optimization", "integration",
		];
		for (const cat of categories) {
			expect(result.allScores[cat as keyof typeof result.allScores]).toBeDefined();
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/self-evolution && bun test tests/intent-classifier.test.ts`

Expected: FAIL with "IntentClassifier is not defined" or import errors

- [ ] **Step 3: Commit test file**

```bash
git add packages/self-evolution/tests/intent-classifier.test.ts
git commit -m "test(self-evolution): add IntentClassifier rule-based tests"
```

---

### Task 1.3: Implement IntentClassifier with rule-based engine

**Files:**
- Create: `packages/self-evolution/src/intent-classifier.ts`

- [ ] **Step 1: Write the implementation**

```typescript
/**
 * IntentClassifier: hybrid rule-based + LLM fallback intent classification.
 */
import classifyIntentTemplate from "./prompts/classify-intent.md" with { type: "text" };
import type { IntentCategory, IntentResult, SessionTrace } from "./types";
import { callBackgroundLlm } from "./utils/llm";
import type { Model } from "@oh-my-pi/pi-ai";

const INTENT_KEYWORDS: Record<IntentCategory, string[]> = {
	refactoring: ["refactor", "rename", "extract", "restructure", "clean up", "clean-up", "simplify"],
	bugfix: ["fix", "bug", "broken", "error", "crash", "repair", "resolve issue", "debug"],
	"feature-add": ["add", "implement", "create", "introduce", "build", "new feature"],
	testing: ["test", "spec", "assertion", "coverage", "unit test", "e2e"],
	documentation: ["doc", "readme", "comment", "document", "explain", "guide"],
	configuration: ["config", "ci", "cd", "setup", "tooling", "eslint", "prettier", "webpack"],
	exploration: ["explore", "understand", "investigate", "look at", "check", "review"],
	optimization: ["optimize", "performance", "speed", "fast", "cache", "memory", "efficient"],
	integration: ["connect", "integrate", "api", "endpoint", "hook", "adapter", "bridge"],
};

const INTENT_TOOL_SIGNALS: Record<IntentCategory, string[]> = {
	refactoring: ["ast_edit"],
	bugfix: [],
	"feature-add": ["write"],
	testing: [],
	documentation: [],
	configuration: [],
	exploration: [],
	optimization: [],
	integration: [],
};

const CONFIDENCE_THRESHOLD = 70;
const GAP_THRESHOLD = 15;

export class IntentClassifier {
	/**
	 * Classify intent using rule-based scoring. Returns result with all scores.
	 */
	ruleClassify(trace: SessionTrace): IntentResult {
		const prompt = trace.userPrompt.toLowerCase();
		const scores: Record<string, number> = {};

		for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
			let score = 0;

			// Keyword matching: 15 points per keyword, cap at 45
			for (const kw of keywords) {
				if (prompt.includes(kw)) score += 15;
			}
			score = Math.min(45, score);

			// Tool signals: 25 points per matching tool, cap at 25
			const toolSignals = INTENT_TOOL_SIGNALS[intent as IntentCategory];
			if (toolSignals.length > 0) {
				const toolsUsed = new Set(
					trace.entries.filter(e => e.type === "tool_call" && e.toolName).map(e => e.toolName!),
				);
				for (const tool of toolSignals) {
					if (toolsUsed.has(tool)) score += 25;
				}
				score = Math.min(70, score); // cap keyword + tool combined
			}

			// Error/recovery signals for bugfix
			if (intent === "bugfix") {
				if (trace.errorCount > 0) score += 30;
				if (trace.hadRecovery) score += 10;
				score = Math.min(70, score);
			}

			// Success signals for feature-add
			if (intent === "feature-add" && trace.completedSuccessfully) {
				score += 10;
			}

			scores[intent] = score;
		}

		// Find best intent
		const entries = Object.entries(scores);
		entries.sort((a, b) => b[1] - a[1]);
		const [bestIntent, bestScore] = entries[0]!;
		const secondScore = entries[1]![1];

		const confidence = bestScore;
		const isConfident = confidence >= CONFIDENCE_THRESHOLD && confidence - secondScore >= GAP_THRESHOLD;

		return {
			intent: bestIntent as IntentCategory,
			confidence,
			source: isConfident ? "rule" : "rule", // source is rule even if low conf; LLM is separate call
			allScores: scores as Record<IntentCategory, number>,
		};
	}

	/**
	 * Full classify with LLM fallback for ambiguous cases.
	 */
	async classify(trace: SessionTrace, model?: Model): Promise<IntentResult> {
		const ruleResult = this.ruleClassify(trace);

		// If rule is confident, use it
		if (ruleResult.confidence >= CONFIDENCE_THRESHOLD) {
			return { ...ruleResult, source: "rule" };
		}

		// Otherwise, try LLM fallback
		if (!model) {
			return { ...ruleResult, source: "rule" };
		}

		const llmResult = await this.#llmClassify(trace, model);
		if (llmResult) {
			return llmResult;
		}

		return { ...ruleResult, source: "rule" };
	}

	async #llmClassify(trace: SessionTrace, model: Model): Promise<IntentResult | undefined> {
		const toolsUsed = trace.entries
			.filter(e => e.type === "tool_call" && e.toolName)
			.map(e => e.toolName)
			.join(", ");

		const userPrompt = `Task: "${trace.userPrompt}"\nTools used: ${toolsUsed || "none"}\nErrors: ${trace.errorCount}\nRecovered: ${trace.hadRecovery ? "yes" : "no"}\nCompleted: ${trace.completedSuccessfully ? "yes" : "no"}`;

		const response = await callBackgroundLlm(model, classifyIntentTemplate, userPrompt);
		if (!response) return undefined;

		try {
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			const json = jsonMatch ? jsonMatch[0] : response;
			const parsed = JSON.parse(json) as { intent?: string; confidence?: number };

			const intent = parsed.intent as IntentCategory;
			if (!intent || !INTENT_KEYWORDS[intent]) return undefined;

			return {
				intent,
				confidence: Math.min(100, Math.max(0, parsed.confidence ?? 50)),
				source: "llm",
				allScores: { ...ruleResult.allScores, [intent]: parsed.confidence ?? 50 },
			};
		} catch {
			return undefined;
		}
	}
}
```

Wait — the `#llmClassify` method references `ruleResult` which is not in scope. Need to pass it as parameter. Let me fix:

```typescript
	async #llmClassify(trace: SessionTrace, model: Model, ruleScores: Record<IntentCategory, number>): Promise<IntentResult | undefined> {
```

And in `classify`:
```typescript
		const llmResult = await this.#llmClassify(trace, model, ruleResult.allScores);
```

Also need to create the prompt file.

- [ ] **Step 2: Create classification prompt**

Create `packages/self-evolution/src/prompts/classify-intent.md`:

```markdown
You are an intent classification assistant for a coding agent.

Classify the user's task into exactly one of these categories:
- refactoring: Restructuring code without behavior change
- bugfix: Fixing errors or bugs
- feature-add: Adding new functionality
- testing: Writing or fixing tests
- documentation: Writing docs, comments, README
- configuration: Config, CI/CD, tooling setup
- exploration: Reading code to understand it
- optimization: Performance improvements
- integration: Connecting systems or APIs

Return ONLY a JSON object: {"intent": "category", "confidence": 0-100}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd packages/self-evolution && bun test tests/intent-classifier.test.ts`

Expected: All 5 tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/self-evolution/src/intent-classifier.ts packages/self-evolution/src/prompts/classify-intent.md packages/self-evolution/tests/intent-classifier.test.ts
git commit -m "feat(self-evolution): implement IntentClassifier with rule-based engine"
```

---

### Task 1.4: Add database schema migration for v2 tables

**Files:**
- Modify: `packages/self-evolution/src/storage/db.ts`

- [ ] **Step 1: Write failing test for schema**

Create `packages/self-evolution/tests/schema.test.ts`:

```typescript
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as os from "node:os";
import { initSchema } from "../src/storage/db";

describe("v2 schema", () => {
	let db: Database;
	let dbPath: string;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `evolution-test-${Date.now()}.db`);
		db = new Database(dbPath);
		initSchema(db);
	});

	afterAll(() => {
		db.close();
		try { require("node:fs").unlinkSync(dbPath); } catch {}
	});

	test("episode_intents table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_intents'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("episode_intents");
	});

	test("workflow_patterns table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_patterns'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("workflow_patterns");
	});

	test("user_profiles table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_profiles'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("user_profiles");
	});

	test("episode_effectiveness table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_effectiveness'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("episode_effectiveness");
	});

	test("skills table has intent column", () => {
		const stmt = db.prepare("PRAGMA table_info(skills)");
		const rows = stmt.all() as Array<{ name: string }>;
		stmt.finalize();
		const intentCol = rows.find(r => r.name === "intent");
		expect(intentCol).toBeDefined();
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd packages/self-evolution && bun test tests/schema.test.ts`

Expected: 5 FAILs (tables don't exist yet)

- [ ] **Step 3: Implement schema migration**

Modify `packages/self-evolution/src/storage/db.ts`. Add the following SQL blocks inside `initSchema` function, after the existing `stats` table creation:

```typescript
	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_intents (
			episode_id TEXT NOT NULL,
			intent TEXT NOT NULL,
			confidence REAL NOT NULL,
			source TEXT NOT NULL CHECK(source IN ('rule', 'llm')),
			PRIMARY KEY (episode_id, intent),
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_patterns (
			id TEXT PRIMARY KEY,
			intent TEXT NOT NULL,
			tool_sequence TEXT NOT NULL,
			occurrence_count INTEGER NOT NULL DEFAULT 1,
			avg_quality_score REAL,
			last_seen_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS user_profiles (
			id TEXT PRIMARY KEY DEFAULT 'default',
			profile_json TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_effectiveness (
			episode_id TEXT PRIMARY KEY,
			times_injected INTEGER NOT NULL DEFAULT 0,
			times_helped INTEGER NOT NULL DEFAULT 0,
			times_failed INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);

	// Migrate skills table: add intent column if missing
	db.exec(`
		ALTER TABLE skills ADD COLUMN intent TEXT;
	`);
```

Wait — `ALTER TABLE ADD COLUMN` will fail if the column already exists (on second run). Need to guard this. In SQLite, we can use `PRAGMA table_info` to check:

```typescript
	const skillsColumns = db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
	const hasIntentCol = skillsColumns.some(c => c.name === "intent");
	if (!hasIntentCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN intent TEXT;`);
	}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd packages/self-evolution && bun test tests/schema.test.ts`

Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/self-evolution/src/storage/db.ts packages/self-evolution/tests/schema.test.ts
git commit -m "feat(self-evolution): add v2 database schema (intents, patterns, profiles, effectiveness)"
```

---

### Task 1.5: Add storage interfaces and implementations for v2 tables

**Files:**
- Modify: `packages/self-evolution/src/storage/types.ts`
- Create: `packages/self-evolution/src/storage/intents.ts`
- Create: `packages/self-evolution/src/storage/profiles.ts`
- Create: `packages/self-evolution/src/storage/effectiveness.ts`

- [ ] **Step 1: Add interfaces to storage/types.ts**

Append to `packages/self-evolution/src/storage/types.ts`:

```typescript
import type { EpisodeIntent, EpisodeEffectiveness, UserProfile, WorkflowPattern } from "../types";

export interface IntentStore {
	insert(intent: EpisodeIntent): Promise<void>;
	getByEpisode(episodeId: string): Promise<EpisodeIntent[]>;
	getByIntent(intent: string, limit: number): Promise<EpisodeIntent[]>;
}

export interface WorkflowPatternStore {
	upsert(pattern: WorkflowPattern): Promise<void>;
	getByIntent(intent: string, limit: number): Promise<WorkflowPattern[]>;
	getById(id: string): Promise<WorkflowPattern | undefined>;
}

export interface ProfileStore {
	get(id: string): Promise<UserProfile | undefined>;
	upsert(id: string, profile: UserProfile): Promise<void>;
}

export interface EffectivenessStore {
	get(episodeId: string): Promise<EpisodeEffectiveness | undefined>;
	recordInjection(episodeId: string): Promise<void>;
	recordOutcome(episodeId: string, helped: boolean): Promise<void>;
}
```

- [ ] **Step 2: Implement SqliteIntentStore**

Create `packages/self-evolution/src/storage/intents.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { EpisodeIntent } from "../types";
import type { IntentStore } from "./types";

export class SqliteIntentStore implements IntentStore {
	constructor(private db: Database) {}

	async insert(intent: EpisodeIntent): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO episode_intents (episode_id, intent, confidence, source)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(episode_id, intent) DO UPDATE SET
				confidence = excluded.confidence,
				source = excluded.source
		`);
		stmt.run(intent.episodeId, intent.intent, intent.confidence, intent.source);
		stmt.finalize();
	}

	async getByEpisode(episodeId: string): Promise<EpisodeIntent[]> {
		const stmt = this.db.prepare(`SELECT * FROM episode_intents WHERE episode_id = ?`);
		const rows = stmt.all(episodeId) as RawIntentRow[];
		stmt.finalize();
		return rows.map(rowToIntent);
	}

	async getByIntent(intent: string, limit: number): Promise<EpisodeIntent[]> {
		const stmt = this.db.prepare(`SELECT * FROM episode_intents WHERE intent = ? ORDER BY confidence DESC LIMIT ?`);
		const rows = stmt.all(intent, limit) as RawIntentRow[];
		stmt.finalize();
		return rows.map(rowToIntent);
	}
}

interface RawIntentRow {
	episode_id: string;
	intent: string;
	confidence: number;
	source: string;
}

function rowToIntent(row: RawIntentRow): EpisodeIntent {
	return {
		episodeId: row.episode_id,
		intent: row.intent as EpisodeIntent["intent"],
		confidence: row.confidence,
		source: row.source as EpisodeIntent["source"],
	};
}
```

- [ ] **Step 3: Implement SqliteProfileStore**

Create `packages/self-evolution/src/storage/profiles.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { UserProfile } from "../types";
import type { ProfileStore } from "./types";

export class SqliteProfileStore implements ProfileStore {
	constructor(private db: Database) {}

	async get(id: string): Promise<UserProfile | undefined> {
		const stmt = this.db.prepare(`SELECT profile_json FROM user_profiles WHERE id = ?`);
		const row = stmt.get(id) as { profile_json: string } | undefined;
		stmt.finalize();
		if (!row) return undefined;
		try {
			return JSON.parse(row.profile_json) as UserProfile;
		} catch {
			return undefined;
		}
	}

	async upsert(id: string, profile: UserProfile): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO user_profiles (id, profile_json, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				profile_json = excluded.profile_json,
				updated_at = excluded.updated_at
		`);
		stmt.run(id, JSON.stringify(profile), profile.updatedAt);
		stmt.finalize();
	}
}
```

- [ ] **Step 4: Implement SqliteEffectivenessStore**

Create `packages/self-evolution/src/storage/effectiveness.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { EpisodeEffectiveness } from "../types";
import type { EffectivenessStore } from "./types";

export class SqliteEffectivenessStore implements EffectivenessStore {
	constructor(private db: Database) {}

	async get(episodeId: string): Promise<EpisodeEffectiveness | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM episode_effectiveness WHERE episode_id = ?`);
		const row = stmt.get(episodeId) as RawRow | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return rowToEffectiveness(row);
	}

	async recordInjection(episodeId: string): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO episode_effectiveness (episode_id, times_injected, times_helped, times_failed)
			VALUES (?, 1, 0, 0)
			ON CONFLICT(episode_id) DO UPDATE SET
				times_injected = times_injected + 1
		`);
		stmt.run(episodeId);
		stmt.finalize();
	}

	async recordOutcome(episodeId: string, helped: boolean): Promise<void> {
		const column = helped ? "times_helped" : "times_failed";
		const stmt = this.db.prepare(`
			INSERT INTO episode_effectiveness (episode_id, times_injected, times_helped, times_failed)
			VALUES (?, 0, 0, 0)
			ON CONFLICT(episode_id) DO UPDATE SET
				${column} = ${column} + 1
		`);
		stmt.run(episodeId);
		stmt.finalize();
	}
}

interface RawRow {
	episode_id: string;
	times_injected: number;
	times_helped: number;
	times_failed: number;
}

function rowToEffectiveness(row: RawRow): EpisodeEffectiveness {
	return {
		episodeId: row.episode_id,
		timesInjected: row.times_injected,
		timesHelped: row.times_helped,
		timesFailed: row.times_failed,
	};
}
```

- [ ] **Step 5: Run type check**

Run: `cd packages/self-evolution && bun run check`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/self-evolution/src/storage/types.ts packages/self-evolution/src/storage/intents.ts packages/self-evolution/src/storage/profiles.ts packages/self-evolution/src/storage/effectiveness.ts
git commit -m "feat(self-evolution): add v2 storage layer (intents, profiles, effectiveness)"
```

---

## Phase 2: User Profiling + Workflow Mining

### Task 2.1: Write failing test for UserProfiler

**Files:**
- Create: `packages/self-evolution/tests/user-profiler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { UserProfiler } from "../src/user-profiler";
import type { SessionTrace } from "../src/types";

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	return {
		sessionId: "test-session",
		cwd: "/tmp",
		userPrompt: overrides.userPrompt ?? "test",
		startTime: Date.now(),
		endTime: Date.now(),
		toolCallCount: overrides.toolCallCount ?? 0,
		errorCount: overrides.errorCount ?? 0,
		hadRecovery: overrides.hadRecovery ?? false,
		completedSuccessfully: overrides.completedSuccessfully ?? true,
		entries: overrides.entries ?? [],
	};
}

describe("UserProfiler", () => {
	test("initial profile has empty stats", () => {
		const profiler = new UserProfiler();
		const profile = profiler.getProfile();
		expect(profile.sessionCount).toBe(0);
		expect(profile.errorRate).toBe(0);
		expect(Object.keys(profile.toolFrequency)).toHaveLength(0);
	});

	test("updateProfile increments tool frequency", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
			],
		});
		profiler.updateProfile(trace, "refactoring");
		const profile = profiler.getProfile();
		expect(profile.toolFrequency["read"]).toBe(2);
		expect(profile.toolFrequency["edit"]).toBe(1);
		expect(profile.sessionCount).toBe(1);
	});

	test("updateProfile tracks tool transitions", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: {} },
			],
		});
		profiler.updateProfile(trace, "refactoring");
		const profile = profiler.getProfile();
		expect(profile.toolTransitions["read→edit"]).toBe(1);
	});

	test("updateProfile calculates error rate", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(makeTrace({ errorCount: 1 }), "bugfix");
		profiler.updateProfile(makeTrace({ errorCount: 0 }), "feature-add");
		const profile = profiler.getProfile();
		expect(profile.errorRate).toBe(0.5);
	});

	test("updateProfile tracks intent distribution", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(makeTrace(), "refactoring");
		profiler.updateProfile(makeTrace(), "refactoring");
		profiler.updateProfile(makeTrace(), "bugfix");
		const profile = profiler.getProfile();
		expect(profile.intentDistribution["refactoring"]).toBe(2);
		expect(profile.intentDistribution["bugfix"]).toBe(1);
	});

	test("updateProfile detects preferred languages from files", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: { path: "src/auth.ts" } },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: { path: "src/main.rs" } },
			],
		});
		profiler.updateProfile(trace, "feature-add");
		const profile = profiler.getProfile();
		expect(profile.preferredLanguages).toContain("typescript");
		expect(profile.preferredLanguages).toContain("rust");
	});

	test("serialize and deserialize preserves data", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(makeTrace({ entries: [{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} }] }), "exploration");
		const json = profiler.serialize();
		const restored = UserProfiler.deserialize(json);
		expect(restored.getProfile().toolFrequency["read"]).toBe(1);
		expect(restored.getProfile().sessionCount).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd packages/self-evolution && bun test tests/user-profiler.test.ts`

Expected: FAIL (UserProfiler not defined)

- [ ] **Step 3: Commit test file**

```bash
git add packages/self-evolution/tests/user-profiler.test.ts
git commit -m "test(self-evolution): add UserProfiler tests"
```

---

### Task 2.2: Implement UserProfiler

**Files:**
- Create: `packages/self-evolution/src/user-profiler.ts`

- [ ] **Step 1: Write the implementation**

```typescript
/**
 * UserProfiler: incremental user behavioral profiling.
 */
import type { SessionTrace, UserProfile } from "./types";

function getFileExtension(path: string): string | undefined {
	const match = path.match(/\.([a-zA-Z0-9]+)$/);
	return match ? match[1].toLowerCase() : undefined;
}

function extensionToLanguage(ext: string): string | undefined {
	const map: Record<string, string> = {
		ts: "typescript", tsx: "typescript",
		js: "javascript", jsx: "javascript",
		rs: "rust",
		py: "python",
		go: "go",
		java: "java",
		kotlin: "kotlin",
		swift: "swift",
		cpp: "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
		c: "c",
		cs: "csharp",
		rb: "ruby",
		php: "php",
		scala: "scala",
		r: "r",
		sh: "shell", bash: "shell", zsh: "shell",
		md: "markdown",
		yml: "yaml", yaml: "yaml",
		json: "json",
		toml: "toml",
	};
	return map[ext];
}

export class UserProfiler {
	#profile: UserProfile;

	constructor(profile?: UserProfile) {
		this.#profile = profile ?? this.#makeDefaultProfile();
	}

	getProfile(): UserProfile {
		return { ...this.#profile };
	}

	updateProfile(trace: SessionTrace, intent: string): void {
		this.#profile.sessionCount++;
		this.#profile.updatedAt = Date.now();

		// Tool frequency
		const toolCalls = trace.entries.filter(e => e.type === "tool_call" && e.toolName);
		for (const entry of toolCalls) {
			const tool = entry.toolName!;
			this.#profile.toolFrequency[tool] = (this.#profile.toolFrequency[tool] ?? 0) + 1;
		}

		// Tool transitions
		const toolNames = toolCalls.map(e => e.toolName!);
		for (let i = 0; i < toolNames.length - 1; i++) {
			const transition = `${toolNames[i]}→${toolNames[i + 1]}`;
			this.#profile.toolTransitions[transition] = (this.#profile.toolTransitions[transition] ?? 0) + 1;
		}

		// Intent distribution
		this.#profile.intentDistribution[intent] = (this.#profile.intentDistribution[intent] ?? 0) + 1;

		// Averages
		const prevCount = this.#profile.sessionCount - 1;
		this.#profile.avgToolCallsPerSession =
			(this.#profile.avgToolCallsPerSession * prevCount + trace.toolCallCount) / this.#profile.sessionCount;

		const filesModified = new Set<string>();
		for (const entry of toolCalls) {
			if (["write", "edit", "ast_edit"].includes(entry.toolName!)) {
				const p = (entry.args as Record<string, unknown>)?.path;
				if (typeof p === "string") filesModified.add(p);
			}
		}
		this.#profile.avgFilesModifiedPerSession =
			(this.#profile.avgFilesModifiedPerSession * prevCount + filesModified.size) / this.#profile.sessionCount;

		// Error rate
		const totalErrors = this.#profile.errorRate * prevCount + (trace.errorCount > 0 ? 1 : 0);
		this.#profile.errorRate = totalErrors / this.#profile.sessionCount;

		// Recovery rate
		const totalRecoveries = this.#profile.recoveryRate * prevCount + (trace.hadRecovery ? 1 : 0);
		this.#profile.recoveryRate = totalRecoveries / this.#profile.sessionCount;

		// Preferred languages
		for (const file of filesModified) {
			const ext = getFileExtension(file);
			if (ext) {
				const lang = extensionToLanguage(ext);
				if (lang && !this.#profile.preferredLanguages.includes(lang)) {
					this.#profile.preferredLanguages.push(lang);
				}
			}
		}
	}

	serialize(): string {
		return JSON.stringify(this.#profile);
	}

	static deserialize(json: string): UserProfiler {
		const profile = JSON.parse(json) as UserProfile;
		return new UserProfiler(profile);
	}

	#makeDefaultProfile(): UserProfile {
		return {
			toolFrequency: {},
			toolTransitions: {},
			intentDistribution: {},
			avgToolCallsPerSession: 0,
			avgFilesModifiedPerSession: 0,
			errorRate: 0,
			recoveryRate: 0,
			preferredLanguages: [],
			sessionCount: 0,
			updatedAt: Date.now(),
		};
	}
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `cd packages/self-evolution && bun test tests/user-profiler.test.ts`

Expected: All 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/self-evolution/src/user-profiler.ts
git commit -m "feat(self-evolution): implement UserProfiler with incremental updates"
```

---

### Task 2.3: Write failing test for WorkflowMiner

**Files:**
- Create: `packages/self-evolution/tests/workflow-miner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { WorkflowMiner } from "../src/workflow-miner";
import type { SessionTrace } from "../src/types";

function makeTrace(entries: Array<{ toolName: string; args?: Record<string, unknown> }>): SessionTrace {
	return {
		sessionId: "test",
		cwd: "/tmp",
		userPrompt: "test",
		startTime: Date.now(),
		endTime: Date.now(),
		toolCallCount: entries.length,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		entries: entries.map((e, i) => ({
			type: "tool_call" as const,
			timestamp: Date.now() + i,
			toolName: e.toolName,
			args: e.args ?? {},
		})),
	};
}

describe("WorkflowMiner", () => {
	test("extracts deduplicated tool sequence", () => {
		const miner = new WorkflowMiner();
		const trace = makeTrace([
			{ toolName: "read" },
			{ toolName: "read" },
			{ toolName: "edit" },
			{ toolName: "edit" },
			{ toolName: "test" },
		]);
		const pattern = miner.mine(trace, "refactoring");
		expect(pattern).toBeDefined();
		expect(pattern!.toolSequence).toEqual(["read", "edit", "test"]);
	});

	test("returns undefined for empty tool sequence", () => {
		const miner = new WorkflowMiner();
		const trace = makeTrace([]);
		const pattern = miner.mine(trace, "exploration");
		expect(pattern).toBeUndefined();
	});

	test("pattern id is deterministic for same sequence", () => {
		const miner = new WorkflowMiner();
		const trace1 = makeTrace([{ toolName: "read" }, { toolName: "edit" }]);
		const trace2 = makeTrace([{ toolName: "read" }, { toolName: "edit" }]);
		const p1 = miner.mine(trace1, "refactoring");
		const p2 = miner.mine(trace2, "refactoring");
		expect(p1!.id).toBe(p2!.id);
	});

	test("includes intent in pattern", () => {
		const miner = new WorkflowMiner();
		const trace = makeTrace([{ toolName: "read" }]);
		const pattern = miner.mine(trace, "bugfix");
		expect(pattern!.intent).toBe("bugfix");
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd packages/self-evolution && bun test tests/workflow-miner.test.ts`

Expected: FAIL

- [ ] **Step 3: Commit test file**

```bash
git add packages/self-evolution/tests/workflow-miner.test.ts
git commit -m "test(self-evolution): add WorkflowMiner tests"
```

---

### Task 2.4: Implement WorkflowMiner

**Files:**
- Create: `packages/self-evolution/src/workflow-miner.ts`

- [ ] **Step 1: Write the implementation**

```typescript
/**
 * WorkflowMiner: extracts deduplicated tool sequences as workflow patterns.
 */
import type { SessionTrace, WorkflowPattern } from "./types";

export class WorkflowMiner {
	/**
	 * Extract a workflow pattern from a session trace.
	 * Returns undefined if no tool calls exist.
	 */
	mine(trace: SessionTrace, intent: string): WorkflowPattern | undefined {
		const toolCalls = trace.entries.filter(e => e.type === "tool_call" && e.toolName);
		if (toolCalls.length === 0) return undefined;

		// Deduplicate consecutive identical tools
		const sequence: string[] = [];
		for (const entry of toolCalls) {
			const tool = entry.toolName!;
			if (sequence.length === 0 || sequence[sequence.length - 1] !== tool) {
				sequence.push(tool);
			}
		}

		const id = this.#hashSequence(sequence);

		return {
			id,
			intent: intent as WorkflowPattern["intent"],
			toolSequence: sequence,
			occurrenceCount: 1,
			avgQualityScore: 0,
			lastSeenAt: Date.now(),
		};
	}

	#hashSequence(sequence: string[]): string {
		// Simple deterministic hash: intent + sequence joined
		return sequence.join("→");
	}
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `cd packages/self-evolution && bun test tests/workflow-miner.test.ts`

Expected: All 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/self-evolution/src/workflow-miner.ts
git commit -m "feat(self-evolution): implement WorkflowMiner with deduplication"
```

---

### Task 2.5: Implement FeedbackTracker

**Files:**
- Create: `packages/self-evolution/src/feedback-tracker.ts`
- Create: `packages/self-evolution/tests/feedback-tracker.test.ts`

- [ ] **Step 1: Write the test first**

```typescript
import { describe, expect, test } from "bun:test";
import { FeedbackTracker } from "../src/feedback-tracker";
import type { EffectivenessStore } from "../src/storage/types";

class MockEffectivenessStore implements EffectivenessStore {
	#data = new Map<string, { injected: number; helped: number; failed: number }>();

	async get(episodeId: string) {
		const d = this.#data.get(episodeId);
		if (!d) return undefined;
		return {
			episodeId,
			timesInjected: d.injected,
			timesHelped: d.helped,
			timesFailed: d.failed,
		};
	}

	async recordInjection(episodeId: string): Promise<void> {
		const d = this.#data.get(episodeId) ?? { injected: 0, helped: 0, failed: 0 };
		d.injected++;
		this.#data.set(episodeId, d);
	}

	async recordOutcome(episodeId: string, helped: boolean): Promise<void> {
		const d = this.#data.get(episodeId) ?? { injected: 0, helped: 0, failed: 0 };
		if (helped) d.helped++;
		else d.failed++;
		this.#data.set(episodeId, d);
	}
}

describe("FeedbackTracker", () => {
	test("trackInjection records all episode IDs", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store);
		await tracker.trackInjection(["ep1", "ep2"]);
		const e1 = await store.get("ep1");
		const e2 = await store.get("ep2");
		expect(e1?.timesInjected).toBe(1);
		expect(e2?.timesInjected).toBe(1);
	});

	test("recordOutcome marks episodes as helped on success", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store);
		await tracker.trackInjection(["ep1"]);
		await tracker.recordOutcome(["ep1"], true);
		const e1 = await store.get("ep1");
		expect(e1?.timesHelped).toBe(1);
		expect(e1?.timesFailed).toBe(0);
	});

	test("recordOutcome marks episodes as failed on failure", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store);
		await tracker.trackInjection(["ep1"]);
		await tracker.recordOutcome(["ep1"], false);
		const e1 = await store.get("ep1");
		expect(e1?.timesHelped).toBe(0);
		expect(e1?.timesFailed).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd packages/self-evolution && bun test tests/feedback-tracker.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement FeedbackTracker**

Create `packages/self-evolution/src/feedback-tracker.ts`:

```typescript
/**
 * FeedbackTracker: tracks whether injected episodes were helpful.
 */
import type { EffectivenessStore } from "./storage/types";

export class FeedbackTracker {
	#store: EffectivenessStore;

	constructor(store: EffectivenessStore) {
		this.#store = store;
	}

	async trackInjection(episodeIds: string[]): Promise<void> {
		for (const id of episodeIds) {
			await this.#store.recordInjection(id);
		}
	}

	async recordOutcome(episodeIds: string[], succeeded: boolean): Promise<void> {
		for (const id of episodeIds) {
			await this.#store.recordOutcome(id, succeeded);
		}
	}
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd packages/self-evolution && bun test tests/feedback-tracker.test.ts`

Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/self-evolution/src/feedback-tracker.ts packages/self-evolution/tests/feedback-tracker.test.ts
git commit -m "feat(self-evolution): implement FeedbackTracker for episode effectiveness"
```

---

## Phase 3: Context-Aware Retrieval + Integration

### Task 3.1: Write failing test for ContextAwareRetriever

**Files:**
- Create: `packages/self-evolution/tests/context-aware-retriever.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { ContextAwareRetriever } from "../src/context-aware-retriever";
import type { Episode, EpisodeStore, IntentStore, UserProfile } from "../src/types";

class MockEpisodeStore implements EpisodeStore {
	#episodes: Episode[] = [];

	setEpisodes(episodes: Episode[]) {
		this.#episodes = episodes;
	}

	async insert(): Promise<void> {}
	async listRecent(limit: number): Promise<Episode[]> {
		return this.#episodes.slice(0, limit);
	}
	async searchByKeyword(): Promise<Episode[]> { return []; }
	async deleteOld(): Promise<number> { return 0; }
	async count(): Promise<number> { return this.#episodes.length; }
}

class MockIntentStore implements IntentStore {
	#intents = new Map<string, { intent: string; confidence: number }[]>();

	setIntents(episodeId: string, intents: { intent: string; confidence: number }[]) {
		this.#intents.set(episodeId, intents);
	}

	async insert(): Promise<void> {}
	async getByEpisode(episodeId: string) {
		const data = this.#intents.get(episodeId) ?? [];
		return data.map(d => ({ episodeId, intent: d.intent as any, confidence: d.confidence, source: "rule" as const }));
	}
	async getByIntent(intent: string, limit: number) {
		const results: any[] = [];
		for (const [epId, intents] of this.#intents) {
			const match = intents.find(i => i.intent === intent);
			if (match) results.push({ episodeId: epId, intent: match.intent, confidence: match.confidence, source: "rule" });
		}
		return results.slice(0, limit);
	}
}

function makeEpisode(id: string, prompt: string, toolCallCount: number = 2): Episode {
	return {
		id,
		sessionId: "s1",
		cwd: "/tmp",
		userPrompt: prompt,
		timestamp: Date.now(),
		durationMs: 1000,
		toolCallCount,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		summary: `Task: ${prompt} | Tools: read, edit | Outcome: completed successfully`,
		toolsUsed: ["read", "edit"],
		filesModified: [],
	};
}

describe("ContextAwareRetriever", () => {
	test("filters by intent when current intent is provided", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "refactor the auth module");
		const ep2 = makeEpisode("ep2", "fix the login bug");
		episodeStore.setEpisodes([ep1, ep2]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 85 }]);
		intentStore.setIntents("ep2", [{ intent: "bugfix", confidence: 90 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore);
		const results = await retriever.retrieve("refactor something", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		expect(results.length).toBe(1);
		expect(results[0]!.episode.id).toBe("ep1");
	});

	test("falls back to all episodes when no intent filter matches", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "do something");
		episodeStore.setEpisodes([ep1]);
		intentStore.setIntents("ep1", [{ intent: "exploration", confidence: 60 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore);
		const results = await retriever.retrieve("test", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		// Should still return something via fallback keyword scoring
		expect(results.length).toBeGreaterThan(0);
	});

	test("ranks successful episodes higher", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "refactor code");
		ep1.completedSuccessfully = false;
		ep1.errorCount = 1;

		const ep2 = makeEpisode("ep2", "refactor code better");
		ep2.completedSuccessfully = true;

		episodeStore.setEpisodes([ep1, ep2]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 80 }]);
		intentStore.setIntents("ep2", [{ intent: "refactoring", confidence: 80 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore);
		const results = await retriever.retrieve("refactor", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		expect(results[0]!.episode.id).toBe("ep2");
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd packages/self-evolution && bun test tests/context-aware-retriever.test.ts`

Expected: FAIL

- [ ] **Step 3: Commit test file**

```bash
git add packages/self-evolution/tests/context-aware-retriever.test.ts
git commit -m "test(self-evolution): add ContextAwareRetriever tests"
```

---

### Task 3.2: Implement ContextAwareRetriever

**Files:**
- Create: `packages/self-evolution/src/context-aware-retriever.ts`

- [ ] **Step 1: Write the implementation**

```typescript
/**
 * ContextAwareRetriever: intent-filtered + profile-ranked episode retrieval.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Model } from "@oh-my-pi/pi-ai";
import type { Episode, EpisodeStore, IntentStore, RerankedEpisode, UserProfile } from "./types";
import { callBackgroundLlm } from "./utils/llm";
import rerankEpisodesTemplate from "./prompts/rerank-episodes.md" with { type: "text" };

export interface ContextRetrievalOptions {
	maxEpisodes: number;
	llmRerank: boolean;
	model?: Model;
	currentIntent?: string;
	profile?: UserProfile;
}

export class ContextAwareRetriever {
	#episodeStore: EpisodeStore;
	#intentStore: IntentStore;

	constructor(episodeStore: EpisodeStore, intentStore: IntentStore) {
		this.#episodeStore = episodeStore;
		this.#intentStore = intentStore;
	}

	async retrieve(query: string, options: ContextRetrievalOptions): Promise<RerankedEpisode[]> {
		// Load recent episodes
		const recent = await this.#episodeStore.listRecent(options.maxEpisodes * 2);
		if (recent.length === 0) return [];

		// Score all candidates
		const candidates = await this.#scoreCandidates(recent, query, options);
		candidates.sort((a, b) => b.score - a.score);

		// Filter by relevance threshold
		const relevant = candidates.filter(c => c.score >= 30);
		if (relevant.length === 0) {
			// Fallback: return top keyword matches regardless of intent
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: "fallback keyword match",
			}));
		}

		// Take top for potential LLM reranking
		const topCandidates = relevant.slice(0, 10);

		if (!options.llmRerank || !options.model || topCandidates.length <= 3) {
			return topCandidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: c.reason,
			}));
		}

		return this.#llmRerank(topCandidates, query, options.model);
	}

	async #scoreCandidates(
		 episodes: Episode[],
		 query: string,
		 options: ContextRetrievalOptions,
	): Promise<Array<{ episode: Episode; score: number; reason: string }>> {
		const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);

		return Promise.all(
			episodes.map(async episode => {
				let score = 0;
				const reasons: string[] = [];

				// 1. Intent match (0-40 points)
				if (options.currentIntent) {
					const intents = await this.#intentStore.getByEpisode(episode.id);
					const match = intents.find(i => i.intent === options.currentIntent);
					if (match) {
						score += Math.min(40, match.confidence * 0.4);
						reasons.push("intent match");
					}
				}

				// 2. Keyword match (0-30 points)
				const text = `${episode.userPrompt} ${episode.summary} ${episode.toolsUsed.join(" ")}`.toLowerCase();
				let keywordMatches = 0;
				for (const word of queryWords) {
					if (text.includes(word)) keywordMatches++;
				}
				if (queryWords.length > 0) {
					score += (keywordMatches / queryWords.length) * 30;
					if (keywordMatches > 0) reasons.push("keyword match");
				}

				// 3. Success boost (0-15 points)
				if (episode.completedSuccessfully) {
					score += 15;
					reasons.push("successful");
				}

				// 4. Recovery experience (0-5 points)
				if (episode.hadRecovery) {
					score += 5;
					reasons.push("recovery experience");
				}

				// 5. Recency boost (0-10 points)
				const daysAgo = Math.floor((Date.now() - episode.timestamp) / 86400000);
				score += Math.max(0, 10 - daysAgo);

				return {
					episode,
					score: Math.min(100, Math.round(score)),
					reason: reasons.join(", ") || "recent episode",
				};
			}),
		);
	}

	async #llmRerank(
		candidates: Array<{ episode: Episode; score: number; reason: string }>,
		query: string,
		model: Model,
	): Promise<RerankedEpisode[]> {
		const episodesBlock = candidates
			.map(
				(c, i) =>
					`[${i + 1}] ID: ${c.episode.id}\nSummary: ${c.episode.summary}\nTools: ${c.episode.toolsUsed.join(", ")}\nSuccess: ${c.episode.completedSuccessfully}\n`,
			)
			.join("\n");

		const userPrompt = `Current task: "${query}"\n\nCandidate episodes:\n${episodesBlock}\n\nSelect the most relevant episodes. Return a JSON array: [{"episodeId": "...", "relevanceScore": 0-100, "reason": "..."}]`;

		const response = await callBackgroundLlm(model, rerankEpisodesTemplate, userPrompt);
		if (!response) {
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: "LLM rerank failed, using scored ranking",
			}));
		}

		try {
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			const json = jsonMatch ? jsonMatch[0] : response;
			const parsed = JSON.parse(json) as Array<{ episodeId?: string; relevanceScore?: number; reason?: string }>;

			const result: RerankedEpisode[] = [];
			for (const item of parsed) {
				if (!item.episodeId) continue;
				const candidate = candidates.find(c => c.episode.id === item.episodeId);
				if (candidate) {
					result.push({
						episode: candidate.episode,
						relevanceScore: Math.min(100, Math.max(0, item.relevanceScore ?? 50)),
						reason: item.reason || "LLM selected",
					});
				}
			}
			return result.length > 0
				? result
				: candidates.slice(0, 3).map(c => ({
						episode: c.episode,
						relevanceScore: c.score,
						reason: "LLM returned no valid matches",
					}));
		} catch (err) {
			logger.warn("LLM context-aware rerank parse failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return candidates.slice(0, 3).map(c => ({
				episode: c.episode,
				relevanceScore: c.score,
				reason: "LLM rerank parse failed",
			}));
		}
	}
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `cd packages/self-evolution && bun test tests/context-aware-retriever.test.ts`

Expected: All 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/self-evolution/src/context-aware-retriever.ts
git commit -m "feat(self-evolution): implement ContextAwareRetriever with intent filtering"
```

---

### Task 3.3: Wire up all v2 components in index.ts

**Files:**
- Modify: `packages/self-evolution/src/index.ts`

- [ ] **Step 1: Update imports and initialization**

Add imports at the top of `packages/self-evolution/src/index.ts`:

```typescript
import { IntentClassifier } from "./intent-classifier";
import { WorkflowMiner } from "./workflow-miner";
import { UserProfiler } from "./user-profiler";
import { FeedbackTracker } from "./feedback-tracker";
import { ContextAwareRetriever } from "./context-aware-retriever";
import { SqliteIntentStore } from "./storage/intents";
import { SqliteProfileStore } from "./storage/profiles";
import { SqliteEffectivenessStore } from "./storage/effectiveness";
```

Add new lazy variables in `createSelfEvolutionExtension`:

```typescript
	let intentStore: SqliteIntentStore | undefined;
	let profileStore: SqliteProfileStore | undefined;
	let effectivenessStore: SqliteEffectivenessStore | undefined;
	let intentClassifier: IntentClassifier | undefined;
	let workflowMiner: WorkflowMiner | undefined;
	let userProfiler: UserProfiler | undefined;
	let feedbackTracker: FeedbackTracker | undefined;
	let contextAwareRetriever: ContextAwareRetriever | undefined;
```

Update `ensureInit`:

```typescript
	function ensureInit(cwd: string): void {
		if (recorder) return;
		flags = parseFlags(api);
		recorder = new TraceRecorder();
		activityLogger = new ActivityLogger(cwd);
		const db = getEvolutionDb(cwd);
		episodeStore = new SqliteEpisodeStore(db);
		skillStore = new SqliteSkillStore(db);
		versionStore = new SqliteSkillVersionStore(db);
		statsStore = new SqliteStatsStore(db);
		intentStore = new SqliteIntentStore(db);
		profileStore = new SqliteProfileStore(db);
		effectivenessStore = new SqliteEffectivenessStore(db);
		skillManager = new SkillManager(skillStore, versionStore, activityLogger, {
			enableVersioning: flags.enableVersioning,
			maxVersions: 20,
		});
		episodeRetriever = new EpisodeRetriever(episodeStore);
		contextAwareRetriever = new ContextAwareRetriever(episodeStore, intentStore);
		extractor = new SkillExtractor();
		intentClassifier = new IntentClassifier();
		workflowMiner = new WorkflowMiner();
		userProfiler = new UserProfiler();
		feedbackTracker = new FeedbackTracker(effectivenessStore);
	}
```

- [ ] **Step 2: Update agent_end handler**

Replace the `agent_end` handler's skill extraction section with the full v2 pipeline:

```typescript
			// Extract intent
			const intentResult = await intentClassifier?.classify(trace, ctx.model);
			if (intentResult) {
				await intentStore?.insert({
					episodeId: episode.id,
					intent: intentResult.intent,
					confidence: intentResult.confidence,
					source: intentResult.source,
				});
				await activityLogger?.log("intent_classified", {
					episodeId: episode.id,
					intent: intentResult.intent,
					confidence: intentResult.confidence,
					source: intentResult.source,
				});
			}

			// Mine workflow pattern
			const pattern = workflowMiner?.mine(trace, intentResult?.intent ?? "exploration");
			if (pattern) {
				await activityLogger?.log("workflow_mined", {
					patternId: pattern.id,
					intent: pattern.intent,
					sequence: pattern.toolSequence,
				});
			}

			// Update user profile
			if (userProfiler && intentResult) {
				userProfiler.updateProfile(trace, intentResult.intent);
				const profile = userProfiler.getProfile();
				await profileStore?.upsert("default", profile);
				await activityLogger?.log("profile_updated", {
					sessionCount: profile.sessionCount,
					topIntent: Object.entries(profile.intentDistribution)
						.sort((a, b) => b[1] - a[1])[0]?.[0],
				});
			}

			// Record feedback for previously injected episodes
			const prevInjected = trace.injectedEpisodeIds;
			if (prevInjected && prevInjected.length > 0 && feedbackTracker) {
				const succeeded = trace.completedSuccessfully && trace.errorCount === 0;
				await feedbackTracker.recordOutcome(prevInjected, succeeded);
			}

			// Extract skill if significant (existing code, keep as-is)
```

Wait — `trace.injectedEpisodeIds` doesn't exist on `SessionTrace`. I need to add it to the type. Let me update the `SessionTrace` type:

In `packages/self-evolution/src/types.ts`, add to `SessionTrace`:

```typescript
	injectedEpisodeIds?: string[];
```

And in the `before_agent_start` handler, set it on the recorder's trace. But the trace doesn't exist yet at `before_agent_start` time... We need to track this differently.

Better approach: store `injectedEpisodeIds` in the `TraceRecorder` as a separate field, and include it when building the trace.

Add to `TraceRecorder`:
```typescript
	#injectedEpisodeIds: string[] = [];

	setInjectedEpisodes(ids: string[]): void {
		this.#injectedEpisodeIds = ids;
	}
```

And in `onAgentEnd`:
```typescript
		this.#trace.injectedEpisodeIds = this.#injectedEpisodeIds;
```

Then in `before_agent_start`, after retrieving episodes:
```typescript
			recorder?.setInjectedEpisodes(episodes.map(e => e.episode.id));
```

Let me add these changes.

- [ ] **Step 3: Add injectedEpisodeIds tracking to TraceRecorder**

Modify `packages/self-evolution/src/trace.ts`:

Add field:
```typescript
	#injectedEpisodeIds: string[] = [];
```

Add method:
```typescript
	setInjectedEpisodes(ids: string[]): void {
		this.#injectedEpisodeIds = ids;
	}
```

In `onAgentEnd`, before returning:
```typescript
		this.#trace.injectedEpisodeIds = this.#injectedEpisodeIds;
		this.#injectedEpisodeIds = [];
```

Add to `reset()`:
```typescript
		this.#injectedEpisodeIds = [];
```

- [ ] **Step 4: Update before_agent_start handler**

Modify `before_agent_start` to use `ContextAwareRetriever`:

```typescript
	api.on("before_agent_start", async (event, ctx) => {
		try {
			ensureInit(ctx.cwd);
			recorder?.seedPrompt(event.prompt);
			if (!flags.enablePromptInjection) return;
			if (!contextAwareRetriever || !recorder) return;

			// Classify current intent for filtering
			const currentIntent = await intentClassifier?.classify(
				{ ...recorder.getTrace() ?? { sessionId: "", cwd: ctx.cwd, userPrompt: event.prompt, startTime: Date.now(), endTime: 0, entries: [], toolCallCount: 0, errorCount: 0, hadRecovery: false, completedSuccessfully: false } },
				ctx.model,
			);

			const profile = await profileStore?.get("default");

			const episodes = await contextAwareRetriever.retrieve(event.prompt, {
				maxEpisodes: flags.maxEpisodes,
				llmRerank: flags.llmRerank,
				model: ctx.model,
				currentIntent: currentIntent?.intent,
				profile: profile ?? undefined,
			});
			if (episodes.length === 0) return;

			// Track injected episodes for feedback
			recorder?.setInjectedEpisodes(episodes.map(e => e.episode.id));
			await feedbackTracker?.trackInjection(episodes.map(e => e.episode.id));

			let injection = "\n\n## Relevant Past Experience\n\n";
			for (const e of episodes) {
				const text = e.episode.summary.slice(0, 200);
				injection += `[${e.episode.id}] ${text} (${e.reason})\n`;
			}

			if (injection.length > 2000) {
				injection = injection.slice(0, 2000);
			}

			await activityLogger?.log("prompt_injected", {
				sessionId: ctx.sessionManager.getSessionId(),
				episodeIds: episodes.map(e => e.episode.id),
				tokenCount: Math.ceil(injection.length / 4),
				intent: currentIntent?.intent,
			});

			return {
				systemPrompt: event.systemPrompt + injection,
			};
		} catch (err) {
			logger.error("Self-evolution before_agent_start handler failed", { error: String(err) });
		}
	});
```

- [ ] **Step 5: Update session_shutdown cleanup**

Add new variables to cleanup:
```typescript
			intentStore = undefined;
			profileStore = undefined;
			effectivenessStore = undefined;
			intentClassifier = undefined;
			workflowMiner = undefined;
			userProfiler = undefined;
			feedbackTracker = undefined;
			contextAwareRetriever = undefined;
```

- [ ] **Step 6: Run full type check**

Run: `cd packages/self-evolution && bun run check`

Expected: PASS

- [ ] **Step 7: Run all tests**

Run: `cd packages/self-evolution && bun test`

Expected: All tests PASS (existing + new)

- [ ] **Step 8: Commit**

```bash
git add packages/self-evolution/src/index.ts packages/self-evolution/src/trace.ts packages/self-evolution/src/types.ts
git commit -m "feat(self-evolution): wire up v2 components (intent, profile, workflow, feedback)"
```

---

### Task 3.4: End-to-end integration test

**Files:**
- Create: `packages/self-evolution/tests/integration-v2.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as os from "node:os";
import { initSchema } from "../src/storage/db";
import { SqliteEpisodeStore } from "../src/storage/episodes";
import { SqliteIntentStore } from "../src/storage/intents";
import { SqliteProfileStore } from "../src/storage/profiles";
import { SqliteEffectivenessStore } from "../src/storage/effectiveness";
import { IntentClassifier } from "../src/intent-classifier";
import { UserProfiler } from "../src/user-profiler";
import { WorkflowMiner } from "../src/workflow-miner";
import { FeedbackTracker } from "../src/feedback-tracker";
import { ContextAwareRetriever } from "../src/context-aware-retriever";
import type { SessionTrace } from "../src/types";

describe("v2 end-to-end", () => {
	let db: Database;
	let dbPath: string;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `evolution-v2-test-${Date.now()}.db`);
		db = new Database(dbPath);
		initSchema(db);
	});

	afterAll(() => {
		db.close();
		try { require("node:fs").unlinkSync(dbPath); } catch {}
	});

	test("full pipeline: classify -> store intent -> update profile -> retrieve context-aware", async () => {
		// Setup stores
		const episodeStore = new SqliteEpisodeStore(db);
		const intentStore = new SqliteIntentStore(db);
		const profileStore = new SqliteProfileStore(db);
		const effectivenessStore = new SqliteEffectivenessStore(db);

		// Create a trace
		const trace: SessionTrace = {
			sessionId: "session-1",
			cwd: "/tmp/project",
			userPrompt: "refactor the auth module to use async",
			startTime: Date.now(),
			endTime: Date.now() + 5000,
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: { path: "src/auth.ts" } },
				{ type: "tool_call", timestamp: Date.now() + 1000, toolName: "ast_edit", args: {} },
				{ type: "tool_call", timestamp: Date.now() + 2000, toolName: "test", args: {} },
			],
			toolCallCount: 3,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
		};

		// 1. Classify intent
		const classifier = new IntentClassifier();
		const intentResult = classifier.ruleClassify(trace);
		expect(intentResult.intent).toBe("refactoring");

		// 2. Store episode
		const episode = {
			id: `${trace.sessionId}-${trace.startTime}`,
			sessionId: trace.sessionId,
			cwd: trace.cwd,
			userPrompt: trace.userPrompt,
			timestamp: trace.startTime,
			durationMs: trace.endTime - trace.startTime,
			toolCallCount: trace.toolCallCount,
			errorCount: trace.errorCount,
			hadRecovery: trace.hadRecovery,
			completedSuccessfully: trace.completedSuccessfully,
			summary: `Task: ${trace.userPrompt} | Tools: read, ast_edit, test | Outcome: completed successfully`,
			toolsUsed: ["read", "ast_edit", "test"],
			filesModified: ["src/auth.ts"],
		};
		await episodeStore.insert(episode);

		// 3. Store intent
		await intentStore.insert({
			episodeId: episode.id,
			intent: intentResult.intent,
			confidence: intentResult.confidence,
			source: intentResult.source,
		});

		// 4. Update profile
		const profiler = new UserProfiler();
		profiler.updateProfile(trace, intentResult.intent);
		const profile = profiler.getProfile();
		expect(profile.sessionCount).toBe(1);
		expect(profile.toolFrequency["read"]).toBe(1);
		await profileStore.upsert("default", profile);

		// 5. Mine workflow
		const miner = new WorkflowMiner();
		const pattern = miner.mine(trace, intentResult.intent);
		expect(pattern).toBeDefined();
		expect(pattern!.toolSequence).toEqual(["read", "ast_edit", "test"]);

		// 6. Context-aware retrieval
		const retriever = new ContextAwareRetriever(episodeStore, intentStore);
		const results = await retriever.retrieve("refactor auth", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
			profile,
		});
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.episode.id).toBe(episode.id);

		// 7. Feedback tracking
		const tracker = new FeedbackTracker(effectivenessStore);
		await tracker.trackInjection([episode.id]);
		await tracker.recordOutcome([episode.id], true);
		const eff = await effectivenessStore.get(episode.id);
		expect(eff?.timesInjected).toBe(1);
		expect(eff?.timesHelped).toBe(1);
	});
});
```

- [ ] **Step 2: Run integration test**

Run: `cd packages/self-evolution && bun test tests/integration-v2.test.ts`

Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd packages/self-evolution && bun test`

Expected: All tests PASS

- [ ] **Step 4: Run workspace type check**

Run: `bun run check:ts`

Expected: All packages PASS

- [ ] **Step 5: Commit**

```bash
git add packages/self-evolution/tests/integration-v2.test.ts
git commit -m "test(self-evolution): add v2 end-to-end integration test"
```

---

## Final Verification

- [ ] **Run full test suite one more time**

```bash
cd packages/self-evolution && bun test
```

Expected: All tests PASS

- [ ] **Run workspace type check**

```bash
bun run check:ts
```

Expected: All packages PASS

- [ ] **Final commit**

```bash
git commit --allow-empty -m "feat(self-evolution): v2.0 intent modeling + user profiling complete"
```
