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
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {}
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
