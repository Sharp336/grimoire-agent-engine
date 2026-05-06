import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
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
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {}
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
