import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { EngineStore } from "@oh-my-pi/pi-coding-agent/engine/store";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

describe("EngineStore", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});

	it("reconciles unfinished attempts from an earlier engine generation", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const first = await EngineStore.open(databasePath);
		const generation = await first.nextEngineGeneration();
		const binding = {
			bindingId: "binding-1",
			commandId: "command-1",
			agentInstanceId: "agent-1",
			executionId: "execution-1",
			attemptId: "attempt-1",
			engineAgentId: "Engine-1",
			profileDigest: "profile-1",
			state: "running" as const,
			engineGeneration: generation,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		await first.putBinding(binding);
		await first.putAttempt(binding, "running");
		await first.close();

		const runtime = await EngineRuntime.create({ databasePath });
		expect(runtime.engineGeneration).toBe(generation + 1);
		expect((await runtime.store.getBinding("agent-1"))?.state).toBe("released");
		const events = await runtime.store.pendingEvents();
		expect(events.map(event => event.kind)).toEqual(["interrupted"]);
		expect(events[0]?.engineGeneration).toBe(runtime.engineGeneration);
		expect(events[0]?.payload).toEqual({ cause: "engine_lost", lostEngineGeneration: generation });
		await runtime.dispose();
	});

	it("upgrades a legacy Engine database once and rejects changed migration history", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-migrate-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const legacy = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await legacy.unsafe(`CREATE TABLE engine_runtime_bindings (
			binding_id TEXT PRIMARY KEY,
			agent_instance_id TEXT NOT NULL UNIQUE,
			execution_id TEXT NOT NULL,
			attempt_id TEXT NOT NULL,
			engine_agent_id TEXT NOT NULL,
			session_file TEXT,
			profile_digest TEXT NOT NULL,
			state TEXT NOT NULL,
			engine_generation INTEGER NOT NULL,
			binding_generation INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		await legacy.unsafe(
			"CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL)",
		);
		await legacy.unsafe("INSERT INTO omp_session_files(path, content, mtime_ms) VALUES (?, ?, ?)", [
			"legacy-session.jsonl",
			'{"type":"session"}\n',
			1,
		]);
		await legacy.end();

		const store = await EngineStore.open(databasePath);
		expect(await store.sessionStorage.readText("legacy-session.jsonl")).toBe('{"type":"session"}\n');
		await store.putBinding({
			bindingId: "binding-migrated",
			commandId: "command-migrated",
			agentInstanceId: "agent-migrated",
			executionId: "execution-migrated",
			attemptId: "attempt-migrated",
			engineAgentId: "Engine-migrated",
			profileDigest: "profile-migrated",
			state: "running",
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 7,
		});
		expect(await store.getBinding("agent-migrated")).toMatchObject({
			commandId: "command-migrated",
			authorityGeneration: 7,
		});
		await store.close();
		const reopened = await EngineStore.open(databasePath);
		expect((await reopened.getBinding("agent-migrated"))?.attemptId).toBe("attempt-migrated");
		await reopened.close();

		const tamper = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await tamper.unsafe("UPDATE engine_schema_migrations SET checksum='changed' WHERE version=1");
		await tamper.end();
		await expect(EngineStore.open(databasePath)).rejects.toThrow("migration 1 checksum does not match");
	});

	it("rejects a database created by a newer Engine schema", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-newer-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const newer = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await newer.unsafe(
			"CREATE TABLE engine_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
		);
		await newer.unsafe(
			"INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (999, 'future', ?)",
			[Date.now()],
		);
		await newer.end();
		await expect(EngineStore.open(databasePath)).rejects.toThrow("schema is newer than this binary");
	});

	it("rolls back a migration that cannot apply cleanly", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-rollback-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const incompatible = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await incompatible.unsafe("CREATE VIEW engine_attempts AS SELECT 1 AS incompatible");
		await incompatible.end();

		await expect(EngineStore.open(databasePath)).rejects.toThrow();
		const inspect = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		const rows = (await inspect.unsafe(
			"SELECT name FROM sqlite_master WHERE name IN ('engine_schema_migrations', 'engine_metadata') ORDER BY name",
		)) as Array<{ name: string }>;
		await inspect.end();
		expect(rows).toEqual([]);
	});
});
