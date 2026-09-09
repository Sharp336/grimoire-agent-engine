import { dlopen, FFIType as F, type Library, type Pointer, ptr, read } from "bun:ffi";
import * as path from "node:path";
import { EngineTargetError } from "./contracts";
import type { RuntimeQueryWork, RuntimeSql } from "./runtime-projection";
import { runtimeLimits } from "./runtime-protocol";

// SUBSTR(CAST(TEXT AS BLOB)) loads the whole SQLite cell before slicing it. The
// OS incremental reader keeps the existing canonical tables and reads only a range.
const symbols = {
	sqlite3_open_v2: { args: [F.ptr, F.ptr, F.i32, F.ptr], returns: F.i32 },
	sqlite3_close_v2: { args: [F.ptr], returns: F.i32 },
	sqlite3_exec: { args: [F.ptr, F.ptr, F.ptr, F.ptr, F.ptr], returns: F.i32 },
	sqlite3_prepare_v2: { args: [F.ptr, F.ptr, F.i32, F.ptr, F.ptr], returns: F.i32 },
	sqlite3_bind_text: { args: [F.ptr, F.i32, F.ptr, F.i32, F.ptr], returns: F.i32 },
	sqlite3_bind_int64: { args: [F.ptr, F.i32, F.i64], returns: F.i32 },
	sqlite3_step: { args: [F.ptr], returns: F.i32 },
	sqlite3_column_int64: { args: [F.ptr, F.i32], returns: F.i64 },
	sqlite3_column_type: { args: [F.ptr, F.i32], returns: F.i32 },
	sqlite3_finalize: { args: [F.ptr], returns: F.i32 },
	sqlite3_blob_open: { args: [F.ptr, F.ptr, F.ptr, F.ptr, F.i64, F.i32, F.ptr], returns: F.i32 },
	sqlite3_blob_read: { args: [F.ptr, F.ptr, F.i32, F.i32], returns: F.i32 },
	sqlite3_blob_bytes: { args: [F.ptr], returns: F.i32 },
	sqlite3_blob_close: { args: [F.ptr], returns: F.i32 },
} as const;
let library: Library<typeof symbols> | undefined;

function systemSqlite(): Library<typeof symbols> {
	if (library) return library;
	const filename =
		process.platform === "win32"
			? path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "winsqlite3.dll")
			: process.platform === "darwin"
				? "/usr/lib/libsqlite3.dylib"
				: process.platform === "linux"
					? "libsqlite3.so.0"
					: null;
	if (!filename || !["x64", "arm64"].includes(process.arch))
		throw new EngineTargetError("source_unavailable", "Bounded native text reads are unsupported on this platform");
	try {
		library = dlopen(filename, symbols);
		return library;
	} catch {
		throw new EngineTargetError("source_unavailable", "The system SQLite incremental reader is unavailable");
	}
}

type TextTable = "engine_inbox_items" | "engine_inbox_sources" | "engine_event_outbox" | "engine_history_entries";
export type RuntimeQueueTextField = "deliveryPayload" | "annotation" | "sender";
const queueColumns = { deliveryPayload: "delivery_payload", annotation: "annotation", sender: "sender" } as const;

interface TextIdentity {
	agent_instance_ref: string;
	principal_id: string;
	authority_generation: number;
	database_id: string;
	engine_generation: string;
}

const terminated = (value: string) => Buffer.from(`${value}\0`);

/** One synchronous, readonly native snapshot. No handle is retained across HTTP reads. */
export class RuntimeTextReader {
	#db: Pointer | null = null;
	#native: Library<typeof symbols>["symbols"];

	private constructor(
		file: string,
		readonly agentInstanceId: string,
		identity: TextIdentity,
		readonly work?: RuntimeQueryWork,
	) {
		this.#native = systemSqlite().symbols;
		const output = Buffer.alloc(8);
		const filename = terminated(file);
		const status = this.#native.sqlite3_open_v2(ptr(filename), ptr(output), 1, null); // SQLITE_OPEN_READONLY
		this.#db = (read.ptr(ptr(output)) as Pointer) || null;
		try {
			this.#check(status);
			// Native page cache is finite; mmap cannot hide the full file in this path.
			const settings = terminated(
				`PRAGMA mmap_size=0; PRAGMA cache_size=-${Math.floor(runtimeLimits.bootstrapMaterializedBytes / 4096)}; BEGIN;`,
			);
			this.#check(this.#native.sqlite3_exec(this.#db, ptr(settings), null, null, null));
			const matched = this.#one(
				`SELECT 1 FROM engine_agent_identity i
				JOIN engine_metadata d ON d.key='database_id' JOIN engine_metadata g ON g.key='engine_generation'
				WHERE i.agent_instance_id=? AND i.agent_instance_ref=? AND i.principal_id=? AND i.authority_generation=?
				AND d.value=? AND g.value=?`,
				[
					agentInstanceId,
					identity.agent_instance_ref,
					identity.principal_id,
					Number(identity.authority_generation),
					identity.database_id,
					identity.engine_generation,
				],
				1,
				3,
			);
			if (!matched) throw new EngineTargetError("stale_target", "Native text owner or generation changed");
		} catch (error) {
			this.close();
			throw error;
		}
	}

	static async open(sql: RuntimeSql, agentInstanceId: string, work?: RuntimeQueryWork): Promise<RuntimeTextReader> {
		const files = (await sql.unsafe("PRAGMA database_list")) as Array<{ name: string; file: string }>;
		const identities = (await sql.unsafe(
			`SELECT i.agent_instance_ref,i.principal_id,i.authority_generation,d.value AS database_id,g.value AS engine_generation
			FROM engine_agent_identity i JOIN engine_metadata d ON d.key='database_id'
			JOIN engine_metadata g ON g.key='engine_generation' WHERE i.agent_instance_id=?`,
			[agentInstanceId],
		)) as TextIdentity[];
		work?.rows(files.length + 3);
		if (work) work.value.materializedBytes += Buffer.byteLength(JSON.stringify([files, identities]));
		work?.check();
		const file = files.find(row => row.name === "main")?.file;
		if (!file || !identities[0]) throw new EngineTargetError("stale_target", "Native text owner is not retained");
		return new RuntimeTextReader(file, agentInstanceId, identities[0], work);
	}

	close(): void {
		if (!this.#db) return;
		const db = this.#db;
		this.#db = null;
		this.#check(this.#native.sqlite3_close_v2(db));
	}

	queue(
		queueId: string,
		revision: number,
		fields: Partial<Record<RuntimeQueueTextField, number | null>>,
		offset: number,
		limit: number,
	): Partial<Record<RuntimeQueueTextField, Buffer | null>> {
		const row = this.#one(
			`SELECT i.rowid,s.rowid FROM engine_inbox_items i JOIN engine_inbox_sources s ON s.source_event_id=i.source_event_id
			WHERE i.agent_instance_id=? AND i.queue_id=? AND i.revision=?`,
			[this.agentInstanceId, queueId, revision],
			2,
			2,
		);
		if (!row) throw new EngineTargetError("stale_target", "Native queue revision changed");
		const result: Partial<Record<RuntimeQueueTextField, Buffer | null>> = {};
		for (const field of Object.keys(fields) as RuntimeQueueTextField[]) {
			const size = fields[field];
			result[field] =
				size === null
					? null
					: this.#range(
							field === "sender" ? "engine_inbox_sources" : "engine_inbox_items",
							queueColumns[field],
							row[field === "sender" ? 1 : 0]!,
							Number(size),
							offset,
							limit,
						);
		}
		return result;
	}

	input(attemptId: string, inputId: string, revision: number, bytes: number, offset: number, limit: number): Buffer {
		const row = this.#one(
			`SELECT e.rowid FROM engine_runtime_inputs p JOIN engine_event_outbox e ON e.event_id=p.created_event_id
			WHERE e.agent_instance_id=? AND p.attempt_id=? AND e.attempt_id=p.attempt_id AND p.input_id=? AND p.created_event_id=?`,
			[this.agentInstanceId, attemptId, inputId, revision],
			1,
			2,
		);
		if (!row) throw new EngineTargetError("stale_target", "Native input identity changed");
		return this.#range("engine_event_outbox", "input_body", row[0]!, bytes, offset, limit);
	}

	history(
		sessionPath: string,
		sessionId: string,
		entryId: string,
		revision: string,
		bytes: number,
		offset: number,
		limit: number,
		attemptId?: string,
	): Buffer {
		const ownership = attemptId
			? "EXISTS(SELECT 1 FROM engine_attempts a WHERE a.agent_instance_id=? AND a.attempt_id=? AND a.transcript_session_id=? AND a.transcript_path=f.path)"
			: "(EXISTS(SELECT 1 FROM engine_attempts a WHERE a.agent_instance_id=? AND a.transcript_session_id=? AND a.transcript_path=f.path) OR EXISTS(SELECT 1 FROM engine_runtime_bindings b WHERE b.agent_instance_id=? AND b.session_file=f.path))";
		const row = this.#one(
			`SELECT h.rowid FROM engine_history_entries h JOIN omp_session_files f ON f.path=h.session_path
			WHERE h.session_path=? AND h.entry_id=? AND h.entry_bytes=? AND f.history_lineage=?
			AND EXISTS(SELECT 1 FROM engine_history_entries header WHERE header.session_path=f.path AND header.entry_id=? AND header.entry_type='session')
			AND ${ownership}`,
			[
				sessionPath,
				entryId,
				bytes,
				revision,
				sessionId,
				this.agentInstanceId,
				...(attemptId ? [attemptId, sessionId] : [sessionId, this.agentInstanceId]),
			],
			1,
			5,
		);
		if (!row) throw new EngineTargetError("stale_target", "Native history session, owner or lineage changed");
		return this.#range("engine_history_entries", "entry_json", row[0]!, bytes, offset, limit);
	}

	#one(statement: string, values: Array<string | number>, columns: number, rows: number): Array<bigint | null> | null {
		if (!this.#db) throw new EngineTargetError("source_unavailable", "Native text reader is closed");
		const output = Buffer.alloc(8);
		const query = terminated(statement);
		const status = this.#native.sqlite3_prepare_v2(this.#db, ptr(query), -1, ptr(output), null);
		const prepared = read.ptr(ptr(output)) as Pointer;
		if (status !== 0) {
			if (prepared) this.#native.sqlite3_finalize(prepared);
			this.#check(status);
		}
		// SQLITE_STATIC: retain every bound UTF-8 buffer until after finalize.
		const buffers = values.map(value => (typeof value === "string" ? terminated(value) : null));
		try {
			for (let index = 0; index < values.length; index++) {
				const value = values[index];
				const buffer = buffers[index];
				this.#check(
					buffer
						? this.#native.sqlite3_bind_text(prepared, index + 1, ptr(buffer), buffer.length - 1, null)
						: this.#native.sqlite3_bind_int64(prepared, index + 1, BigInt(value)),
				);
			}
			const status = this.#native.sqlite3_step(prepared);
			this.work?.rows(rows);
			if (status === 101) return null; // SQLITE_DONE
			this.#check(status, 100); // SQLITE_ROW; all queries use exact indexed identities.
			return Array.from({ length: columns }, (_, index) =>
				this.#native.sqlite3_column_type(prepared, index) === 5
					? null
					: BigInt(this.#native.sqlite3_column_int64(prepared, index)),
			);
		} finally {
			this.#native.sqlite3_finalize(prepared);
			buffers.length = 0;
		}
	}

	#range(table: TextTable, column: string, row: bigint, size: number, offset: number, limit: number): Buffer {
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			offset > size ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > runtimeLimits.httpRangeBytes
		)
			throw new EngineTargetError("invalid_request", "Native text range exceeds its byte bound");
		const count = Math.min(limit, size - offset);
		if (this.work) {
			this.work.value.materializedBytes += count;
			this.work.check();
		}
		const dbName = terminated("main");
		const tableName = terminated(table);
		const columnName = terminated(column);
		const output = Buffer.alloc(8);
		this.#check(
			this.#native.sqlite3_blob_open(this.#db, ptr(dbName), ptr(tableName), ptr(columnName), row, 0, ptr(output)),
		);
		const blob = read.ptr(ptr(output)) as Pointer;
		try {
			if (this.#native.sqlite3_blob_bytes(blob) !== size)
				throw new EngineTargetError("stale_target", "Native text size changed");
			const result = Buffer.alloc(count);
			if (count) this.#check(this.#native.sqlite3_blob_read(blob, ptr(result), count, offset));
			this.work?.check();
			return result;
		} finally {
			this.#native.sqlite3_blob_close(blob);
		}
	}

	#check(status: number, expected = 0): void {
		if (status !== expected)
			throw new EngineTargetError("source_unavailable", `Native SQLite bounded read failed (${status})`);
	}
}
