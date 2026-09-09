import { dlopen, FFIType as F, ptr } from "bun:ffi";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SQL } from "bun";
import type { EngineInboxTarget } from "../src/engine/contracts";
import { RuntimeQueryWork } from "../src/engine/runtime-projection";
import { runtimeLimits } from "../src/engine/runtime-protocol";
import { RuntimeTextReader } from "../src/engine/runtime-text";
import { EngineStore } from "../src/engine/store";

describe("bounded native text resources", () => {
	let directory: string;
	let store: EngineStore | undefined;
	let sql: SQL | undefined;
	afterEach(async () => {
		await sql?.end();
		await store?.close();
		sql = undefined;
		store = undefined;
		if (directory) fs.rmSync(directory, { recursive: true });
	});

	it("pins owner and revision with its bytes and releases the WAL snapshot on success or rejection", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "engine-native-text-"));
		const filename = path.join(directory, "engine.sqlite");
		store = await EngineStore.open(filename);
		await store.nextEngineGeneration();
		const identity = {
			agentInstanceId: "native-text",
			agentInstanceRef: "grimoire://tasks/grimoire/native-text/agents/owner",
			principalId: "owner",
			authorityGeneration: 1,
		};
		await store.registerAgent(identity);
		const target: EngineInboxTarget = {
			agentInstanceId: identity.agentInstanceId,
			attemptId: "attempt",
			executionId: "execution",
			sessionId: "session",
			bindingId: "binding",
			authorityGeneration: 1,
			engineGeneration: 1,
			bindingGeneration: 1,
		};
		const queued = await store.enqueueInboxItem(target, {
			sourceEventId: "source",
			sourceType: "user",
			body: "seed",
		});
		sql = new SQL(`sqlite:${filename.replaceAll("\\", "/")}`);
		const body = Buffer.from("я😀\u0000\n".repeat(1_000_000));
		await sql.unsafe("UPDATE engine_inbox_items SET delivery_payload=? WHERE queue_id=?", [
			body.toString(),
			queued.item.queueId,
		]);
		const work = new RuntimeQueryWork({
			bytes: 1_048_576,
			changes: 100,
			scannedRows: 500,
			materializedBytes: 4_194_304,
			timeMs: 5000,
		});
		const reader = await RuntimeTextReader.open(sql, identity.agentInstanceId, work);
		try {
			await sql.unsafe(
				"UPDATE engine_inbox_items SET delivery_payload='replacement',revision=revision+1 WHERE queue_id=?",
				[queued.item.queueId],
			);
			for (const offset of [0, 7, body.length - runtimeLimits.httpRangeBytes]) {
				const read = reader.queue(
					queued.item.queueId,
					queued.item.revision,
					{ deliveryPayload: body.length },
					offset,
					runtimeLimits.httpRangeBytes,
				);
				expect(read.deliveryPayload).toEqual(body.subarray(offset, offset + runtimeLimits.httpRangeBytes));
			}
			expect(() => reader.queue(queued.item.queueId, 900, { deliveryPayload: body.length }, 0, 10)).toThrow(
				"revision",
			);
			expect(work.value.materializedBytes).toBeLessThan(4 * runtimeLimits.httpRangeBytes);
		} finally {
			reader.close();
		}
		expect(() => reader.queue(queued.item.queueId, 1, { deliveryPayload: body.length }, 0, 10)).toThrow("closed");
		const checkpoint = (await sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)")) as Array<{ busy: number }>;
		expect(checkpoint[0].busy).toBe(0);
		const current = await RuntimeTextReader.open(sql, identity.agentInstanceId);
		try {
			expect(() => current.queue(queued.item.queueId, 1, { deliveryPayload: body.length }, 0, 10)).toThrow(
				"revision",
			);
			expect(current.queue(queued.item.queueId, 2, { deliveryPayload: 11 }, 0, 20).deliveryPayload?.toString()).toBe(
				"replacement",
			);
		} finally {
			current.close();
		}

		// A transfer after the first connection's metadata read must fail the native
		// guard, before any body is read. SQL still performs the real reads/writes.
		const unsafe = sql.unsafe.bind(sql);
		const intercepted = spyOn(sql, "unsafe").mockImplementation((statement, values) => {
			const query = unsafe(statement, values);
			if (!statement.startsWith("SELECT i.agent_instance_ref,i.principal_id")) return query;
			return query.then(async rows => {
				await unsafe("UPDATE engine_agent_identity SET principal_id='different-owner' WHERE agent_instance_id=?", [
					identity.agentInstanceId,
				]);
				return rows;
			}) as typeof query;
		});
		try {
			const rejected = await RuntimeTextReader.open(sql, identity.agentInstanceId).then(
				() => undefined,
				error => error,
			);
			expect(rejected).toMatchObject({ code: "stale_target" });
		} finally {
			intercepted.mockRestore();
		}
		expect(((await sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)")) as Array<{ busy: number }>)[0].busy).toBe(0);
	});

	it.skipIf(process.platform !== "win32")(
		"keeps native SQLite allocation below the owner budget for an 8 MiB TEXT cell",
		async () => {
			directory = fs.mkdtempSync(path.join(os.tmpdir(), "engine-native-allocation-"));
			const filename = path.join(directory, "engine.sqlite");
			store = await EngineStore.open(filename);
			await store.nextEngineGeneration();
			await store.registerAgent({
				agentInstanceId: "memory",
				agentInstanceRef: "grimoire://tasks/grimoire/native-text/agents/memory",
				principalId: "owner",
				authorityGeneration: 1,
			});
			sql = new SQL(`sqlite:${filename.replaceAll("\\", "/")}`);
			// Retained input data exercises the actual canonical table; no production endpoint seeds it.
			const target = {
				agentInstanceId: "memory",
				bindingId: "binding",
				commandId: "command",
				executionId: "execution",
				attemptId: "attempt",
				engineAgentId: "memory",
				profileDigest: "profile",
				state: "running" as const,
				engineGeneration: 1,
				bindingGeneration: 1,
				authorityGeneration: 1,
			};
			const [event] = await store.commitAttemptTransition(target, "waiting_input", [
				{
					kind: "input_requested",
					payload: { inputId: "input", questions: [{ id: "q", question: "Question", options: [] }] },
				},
			]);
			const body = JSON.stringify({
				inputId: "input",
				questions: [{ id: "q", question: "x".repeat(8 * 1024 * 1024), options: [] }],
			});
			await sql.unsafe("UPDATE engine_event_outbox SET input_body=? WHERE event_id=?", [body, event.eventId]);
			const counters = dlopen(
				path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "winsqlite3.dll"),
				{ sqlite3_status64: { args: [F.i32, F.ptr, F.ptr, F.i32], returns: F.i32 } },
			);
			const current = Buffer.alloc(8);
			const peak = Buffer.alloc(8);
			try {
				expect(counters.symbols.sqlite3_status64(0, ptr(current), ptr(peak), 1)).toBe(0);
				const reader = await RuntimeTextReader.open(sql, "memory");
				try {
					expect(
						reader.input("attempt", "input", event.eventId, body.length, body.length - 65536, 65536).length,
					).toBe(65536);
					expect(counters.symbols.sqlite3_status64(0, ptr(current), ptr(peak), 0)).toBe(0);
					expect(Number(peak.readBigInt64LE()) + 65536).toBeLessThan(runtimeLimits.bootstrapMaterializedBytes);
				} finally {
					reader.close();
				}
			} finally {
				counters.close();
			}
		},
	);

	it("migrates legacy history bytes, indexes and triggers atomically and keeps the old prefix after failure", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "engine-history-rowid-"));
		const filename = path.join(directory, "engine.sqlite");
		const legacy = new Database(filename, { create: true });
		legacy.exec(await Bun.file(path.join(import.meta.dir, "fixtures", "engine-schema-v22.sql")).text());
		const dataSql = "SELECT * FROM engine_history_entries ORDER BY session_path,entry_id";
		const schemaSql =
			"SELECT name,sql FROM sqlite_master WHERE (tbl_name='engine_history_entries' OR name LIKE 'engine_history_%') ORDER BY name";
		const prefixSql = "SELECT version,checksum FROM engine_schema_migrations ORDER BY version";
		const before = legacy.query(dataSql).all();
		const schema = legacy.query(schemaSql).all();
		const prefix = legacy.query(prefixSql).all();
		expect(before.length).toBeGreaterThan(0);
		// Fail after the table replacement, so rollback must restore both data and DDL.
		legacy.exec("CREATE INDEX engine_history_header_idx ON engine_metadata(key)");
		legacy.close();
		const failed = await EngineStore.open(filename).then(
			() => undefined,
			error => error,
		);
		expect(failed).toBeInstanceOf(Error);
		const inspect = new Database(filename);
		inspect.exec("DROP INDEX engine_history_header_idx");
		expect(inspect.query(dataSql).all()).toEqual(before);
		expect(inspect.query(schemaSql).all()).toEqual(schema);
		expect(inspect.query(prefixSql).all()).toEqual(prefix);
		inspect.close();
		store = await EngineStore.open(filename);
		const migrated = new Database(filename);
		try {
			expect(migrated.query(dataSql).all()).toEqual(before);
			expect(
				migrated
					.query("SELECT version,checksum FROM engine_schema_migrations WHERE version<=22 ORDER BY version")
					.all(),
			).toEqual(prefix);
			expect(migrated.query("SELECT sql FROM sqlite_master WHERE name='engine_history_entries'").get()).not.toEqual(
				expect.objectContaining({ sql: expect.stringContaining("WITHOUT ROWID") }),
			);
			for (const row of schema as Array<{ name: string; sql: string }>) {
				if (row.name === "engine_history_entries" || row.name.startsWith("sqlite_autoindex")) continue;
				expect(migrated.query("SELECT sql FROM sqlite_master WHERE name=?").get(row.name)).toEqual({
					sql: row.sql,
				});
			}
			const sessionPath = "/rowid-migration.jsonl";
			const header = JSON.stringify({ id: "session", type: "session", cwd: "/migration" });
			const entry = JSON.stringify({
				id: "message",
				type: "message",
				parentId: null,
				sourceCommandId: "source",
				assistantMessageId: "assistant",
				message: { role: "assistant", content: "text" },
			});
			await store.sessionStorage.writeText(sessionPath, `${header}\n${entry}\n`);
			expect(
				migrated
					.query(
						"SELECT source_command_id,assistant_message_id FROM engine_history_entries WHERE session_path=? AND entry_id='message'",
					)
					.get(sessionPath),
			).toEqual({ source_command_id: "source", assistant_message_id: "assistant" });
			const writer = store.sessionStorage.openWriter(sessionPath);
			await writer.append(`${entry.replace('"id":"message"', '"id":"next"')}\n`);
			await writer.close();
			expect(
				migrated
					.query("SELECT COUNT(*) AS count FROM engine_history_entries WHERE session_path=?")
					.get(sessionPath),
			).toEqual({ count: 3 });
			migrated.query("UPDATE omp_session_files SET path=? WHERE path=?").run("/moved.jsonl", sessionPath);
			expect(
				migrated
					.query("SELECT COUNT(*) AS count FROM engine_history_entries WHERE session_path='/moved.jsonl'")
					.get(),
			).toEqual({ count: 3 });
			await store.sessionStorage.writeText("/moved.jsonl", `${header}\n`);
			expect(
				migrated
					.query("SELECT COUNT(*) AS count FROM engine_history_entries WHERE session_path='/moved.jsonl'")
					.get(),
			).toEqual({ count: 1 });
			migrated.exec("DELETE FROM omp_session_files WHERE path='/moved.jsonl'");
			expect(migrated.query(dataSql).all()).toEqual(before);
		} finally {
			migrated.close();
		}
		await store.close();
		store = await EngineStore.open(filename);
		const reopened = new Database(filename, { readonly: true });
		try {
			expect(reopened.query(dataSql).all()).toEqual(before);
		} finally {
			reopened.close();
		}
	});
});
