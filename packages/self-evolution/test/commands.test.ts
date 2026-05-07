import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { registerSelfEvolutionCommands } from "../src/commands";
import { SqliteConventionStore } from "../src/storage/conventions";
import { initSchema } from "../src/storage/db";
import { SqliteEffectivenessStore } from "../src/storage/effectiveness";
import { SqliteEpisodeStore } from "../src/storage/episodes";
import { SqliteProfileStore } from "../src/storage/profiles";
import { SqliteSkillStore, SqliteSkillVersionStore, SqliteStatsStore } from "../src/storage/skills";
import { SqliteWorkflowPatternStore } from "../src/storage/workflow-patterns";
import type { UserProfile, WorkflowPattern } from "../src/types";

describe("Self-evolution commands", () => {
	let db: Database;
	let profileStore: SqliteProfileStore;
	let workflowPatternStore: SqliteWorkflowPatternStore;
	let episodeStore: SqliteEpisodeStore;
	let skillStore: SqliteSkillStore;
	let versionStore: SqliteSkillVersionStore;
	let statsStore: SqliteStatsStore;
	let conventionStore: SqliteConventionStore;
	let effectivenessStore: SqliteEffectivenessStore;
	let notified: Array<{ message: string; type?: string }>;
	let commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
	let ensureInitCalled: boolean;

	function makeCtx(cwd = "/test") {
		return {
			cwd,
			ui: {
				notify: (message: string, type?: string) => {
					notified.push({ message, type });
				},
			},
		};
	}

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		profileStore = new SqliteProfileStore(db);
		workflowPatternStore = new SqliteWorkflowPatternStore(db);
		episodeStore = new SqliteEpisodeStore(db);
		skillStore = new SqliteSkillStore(db);
		versionStore = new SqliteSkillVersionStore(db);
		statsStore = new SqliteStatsStore(db);
		conventionStore = new SqliteConventionStore(db);
		effectivenessStore = new SqliteEffectivenessStore(db);
		notified = [];
		ensureInitCalled = false;
		commands = new Map();

		const api = {
			registerCommand: (
				name: string,
				options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
			) => {
				commands.set(name, options);
			},
		};

		registerSelfEvolutionCommands(api as never, {
			ensureInit: () => {
				ensureInitCalled = true;
			},
			episodeStore: () => episodeStore,
			skillStore: () => skillStore,
			versionStore: () => versionStore,
			statsStore: () => statsStore,
			skillManager: () =>
				({
					archiveLowQuality: async () => 0,
					rollback: async () => undefined,
					getHistory: async () => [],
				}) as never,
			activityLogger: () => ({ log: async () => {} }) as never,
			profileStore: () => profileStore,
			workflowPatternStore: () => workflowPatternStore,
			conventionStore: () => conventionStore,
			effectivenessStore: () => effectivenessStore,
		});
	});

	describe("evolution-profile", () => {
		test("displays formatted profile when data exists", async () => {
			const profile: UserProfile = {
				toolFrequency: { read: 5, bash: 3 },
				toolTransitions: { "read→bash": 2 },
				intentDistribution: { refactoring: 2, bugfix: 1 },
				avgToolCallsPerSession: 4.5,
				avgFilesModifiedPerSession: 1.2,
				errorRate: 0.1,
				recoveryRate: 0.5,
				preferredLanguages: ["typescript", "rust"],
				sessionCount: 3,
				updatedAt: Date.now(),
			};
			await profileStore.upsert("default", profile);

			const cmd = commands.get("evolution-profile");
			expect(cmd).toBeDefined();
			await cmd!.handler("", makeCtx());

			expect(ensureInitCalled).toBe(true);
			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Sessions: 3");
			expect(notified[0]!.message).toContain("Tool calls/session: 4.5");
			expect(notified[0]!.message).toContain("Error rate: 10%");
			expect(notified[0]!.message).toContain("Recovery rate: 50%");
			expect(notified[0]!.message).toContain("Preferred languages: typescript, rust");
			expect(notified[0]!.message).toContain("Top tools: read(5), bash(3)");
			expect(notified[0]!.message).toContain("Intent distribution: refactoring(2), bugfix(1)");
		});

		test("notifies when no profile data exists", async () => {
			const cmd = commands.get("evolution-profile");
			expect(cmd).toBeDefined();
			await cmd!.handler("", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No profile data yet");
		});

		test("notifies error when store throws", async () => {
			const cmd = commands.get("evolution-profile");
			expect(cmd).toBeDefined();

			// Force an error by closing the DB
			db.close();
			await cmd!.handler("", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to load profile");
		});
	});

	describe("evolution-workflows", () => {
		test("lists all workflow patterns when no filter is provided", async () => {
			const pattern1: WorkflowPattern = {
				id: "p1",
				intent: "refactoring",
				toolSequence: ["read", "edit", "test"],
				occurrenceCount: 3,
				avgQualityScore: 0.8,
				lastSeenAt: Date.now(),
			};
			const pattern2: WorkflowPattern = {
				id: "p2",
				intent: "bugfix",
				toolSequence: ["search", "read", "edit"],
				occurrenceCount: 2,
				avgQualityScore: 0.7,
				lastSeenAt: Date.now(),
			};
			await workflowPatternStore.upsert(pattern1);
			await workflowPatternStore.upsert(pattern2);

			const cmd = commands.get("evolution-workflows");
			expect(cmd).toBeDefined();
			await cmd!.handler("", makeCtx());

			expect(ensureInitCalled).toBe(true);
			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("refactoring: read → edit → test (seen 3x)");
			expect(notified[0]!.message).toContain("bugfix: search → read → edit (seen 2x)");
		});

		test("filters workflow patterns by intent", async () => {
			const pattern: WorkflowPattern = {
				id: "p1",
				intent: "refactoring",
				toolSequence: ["read", "edit"],
				occurrenceCount: 1,
				avgQualityScore: 0,
				lastSeenAt: Date.now(),
			};
			await workflowPatternStore.upsert(pattern);

			const cmd = commands.get("evolution-workflows");
			await cmd!.handler("refactoring", makeCtx());

			expect(notified[0]!.message).toContain("refactoring: read → edit (seen 1x)");
		});

		test("notifies when no workflow patterns exist", async () => {
			const cmd = commands.get("evolution-workflows");
			await cmd!.handler("", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No workflow patterns mined yet");
		});

		test("notifies when filtered intent has no patterns", async () => {
			const cmd = commands.get("evolution-workflows");
			await cmd!.handler("nonexistent", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain('No workflow patterns found for intent "nonexistent"');
		});

		test("notifies error when store throws", async () => {
			const cmd = commands.get("evolution-workflows");
			db.close();
			await cmd!.handler("", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to list workflow patterns");
		});
	});

	describe("evolution-status regression", () => {
		test("shows statistics when stores are empty", async () => {
			const cmd = commands.get("evolution-status");
			expect(cmd).toBeDefined();
			await cmd!.handler("", makeCtx());

			expect(ensureInitCalled).toBe(true);
			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Episodes: 0");
			expect(notified[0]!.message).toContain("Skills: 0");
			expect(notified[0]!.message).toContain("Versions: 0");
		});
	});
});
