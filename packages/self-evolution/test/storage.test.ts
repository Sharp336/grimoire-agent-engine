import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initSchema } from "../src/storage/db";
import { SqliteEpisodeStore } from "../src/storage/episodes";
import { SqliteSkillStore, SqliteSkillVersionStore, SqliteStatsStore } from "../src/storage/skills";
import type { Episode, EvolvedSkill, SkillVersion } from "../src/types";

describe("Storage", () => {
	let db: Database;
	let episodeStore: SqliteEpisodeStore;
	let skillStore: SqliteSkillStore;
	let versionStore: SqliteSkillVersionStore;
	let statsStore: SqliteStatsStore;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		episodeStore = new SqliteEpisodeStore(db);
		skillStore = new SqliteSkillStore(db);
		versionStore = new SqliteSkillVersionStore(db);
		statsStore = new SqliteStatsStore(db);
	});

	afterEach(() => {
		db.close();
	});

	test("episode insert and listRecent", async () => {
		const episode: Episode = {
			id: "e1",
			sessionId: "s1",
			cwd: "/test",
			userPrompt: "fix bug",
			timestamp: 1000,
			durationMs: 500,
			toolCallCount: 3,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
			summary: "fixed bug",
			toolsUsed: ["read", "edit"],
			filesModified: ["a.ts"],
		};
		await episodeStore.insert(episode);
		const recent = await episodeStore.listRecent(10);
		expect(recent.length).toBe(1);
		expect(recent[0]!.id).toBe("e1");
		expect(recent[0]!.toolsUsed).toEqual(["read", "edit"]);
	});

	test("episode deleteOld", async () => {
		for (let i = 0; i < 5; i++) {
			await episodeStore.insert({
				id: `e${i}`,
				sessionId: "s1",
				cwd: "/test",
				userPrompt: "task",
				timestamp: i,
				durationMs: 1,
				toolCallCount: 1,
				errorCount: 0,
				hadRecovery: false,
				completedSuccessfully: true,
				summary: "done",
				toolsUsed: [],
				filesModified: [],
			});
		}
		const deleted = await episodeStore.deleteOld(2);
		expect(deleted).toBe(3);
		const count = await episodeStore.count();
		expect(count).toBe(2);
	});

	test("skill upsert and get", async () => {
		const skill: EvolvedSkill = {
			name: "test-skill",
			description: "desc",
			taskPattern: "pattern",
			approach: "approach",
			tools: ["read"],
			pitfalls: [],
			createdAt: 0,
			usageCount: 1,
			lastUsedAt: 0,
			successCount: 1,
			failureCount: 0,
			version: 1,
		};
		await skillStore.upsert(skill);
		const got = await skillStore.get("test-skill");
		expect(got).toBeDefined();
		expect(got!.name).toBe("test-skill");
		expect(got!.tools).toEqual(["read"]);
	});

	test("skill version record and history", async () => {
		const skill: EvolvedSkill = {
			name: "test-skill",
			description: "desc",
			taskPattern: "pattern",
			approach: "approach",
			tools: [],
			pitfalls: [],
			createdAt: 0,
			usageCount: 1,
			lastUsedAt: 0,
			successCount: 1,
			failureCount: 0,
			version: 1,
		};
		const version: SkillVersion = {
			name: "test-skill",
			version: 1,
			skill,
			changedAt: 0,
			changeType: "extracted",
		};
		await versionStore.record(version);
		const history = await versionStore.getHistory("test-skill");
		expect(history.length).toBe(1);
		expect(history[0]!.version).toBe(1);
	});

	test("stats increment", async () => {
		await statsStore.increment("foo", 3);
		await statsStore.increment("foo", 2);
		const value = await statsStore.get("foo");
		expect(value).toBe(5);
	});
});
