import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SQL } from "bun";
import { SqlSessionStorage } from "../session/sql-session-storage";
import type { EngineAttemptState, EngineBindingSnapshot, EngineEvent } from "./contracts";

interface MetadataRow {
	value: string;
}

interface BindingRow {
	binding_id: string;
	command_id: string;
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	engine_agent_id: string;
	session_file: string | null;
	profile_digest: string;
	state: EngineBindingSnapshot["state"];
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
}

export interface EngineAttemptRow {
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	command_id: string;
	binding_id: string;
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
	state: EngineAttemptState;
}

interface SeqRow {
	seq: number;
}

interface EventRow {
	event_id: number;
	seq: number;
	causation_command_id: string;
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	binding_id: string;
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
	kind: EngineEvent["kind"];
	payload: string | null;
	created_at: number;
}

export interface EngineCommandIdentity {
	commandId: string;
	operation: string;
	deviceId: string;
	engineId: string;
	engineGeneration: number;
	agentInstanceId: string;
	agentInstanceRef?: string;
	parentAgentInstanceId?: string;
	bindingId?: string;
	bindingGeneration?: number;
	executionId?: string;
	attemptId?: string;
	authorityGeneration: number;
	payloadHash: string;
	canonicalHash: string;
}

export interface EngineCommandReceipt {
	outcome: "applied" | "rejected";
	detail?: Record<string, unknown>;
}

export interface EngineTransitionEvent {
	kind: EngineEvent["kind"];
	payload?: Record<string, unknown>;
	causationCommandId?: string;
}

export type EngineCommandAdmission =
	| { status: "claimed" }
	| { status: "in_progress" }
	| { status: "replay"; receipt: EngineCommandReceipt };

interface CommandRow {
	canonical_hash: string;
	state: "received" | "settled";
	processor_generation: number | null;
	receipt: string | null;
}

export class EngineCommandConflictError extends Error {
	constructor(commandId: string) {
		super(`Command ${commandId} was already admitted with different canonical content`);
		this.name = "EngineCommandConflictError";
	}
}

export class EngineAttemptConflictError extends Error {
	constructor(attemptId: string) {
		super(`Attempt ${attemptId} is already bound to another runtime identity`);
		this.name = "EngineAttemptConflictError";
	}
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS engine_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS omp_session_files (
		path TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		mtime_ms INTEGER NOT NULL,
		title TEXT,
		title_source TEXT,
		title_updated_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS engine_runtime_bindings (
		binding_id TEXT PRIMARY KEY,
		command_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL UNIQUE,
		execution_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		engine_agent_id TEXT NOT NULL,
		session_file TEXT,
		profile_digest TEXT NOT NULL,
		state TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS engine_attempts (
		attempt_id TEXT PRIMARY KEY,
		command_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL,
		execution_id TEXT NOT NULL,
		binding_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		state TEXT NOT NULL,
		cause TEXT,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS engine_agent_seq (
		agent_instance_id TEXT PRIMARY KEY,
		seq INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS engine_event_outbox (
		event_id INTEGER PRIMARY KEY AUTOINCREMENT,
		seq INTEGER NOT NULL,
		causation_command_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL,
		execution_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		binding_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		kind TEXT NOT NULL,
		payload TEXT,
		created_at INTEGER NOT NULL,
		published_at INTEGER,
		UNIQUE(agent_instance_id, seq)
	)`,
	`CREATE INDEX IF NOT EXISTS engine_attempt_state_idx ON engine_attempts(state, engine_generation)`,
	`CREATE INDEX IF NOT EXISTS engine_outbox_pending_idx ON engine_event_outbox(published_at, event_id)`,
];

const REQUIRED_COLUMNS = [
	["engine_runtime_bindings", "command_id", "TEXT NOT NULL DEFAULT ''"],
	["engine_runtime_bindings", "authority_generation", "INTEGER NOT NULL DEFAULT 0"],
	["engine_attempts", "command_id", "TEXT NOT NULL DEFAULT ''"],
	["engine_attempts", "authority_generation", "INTEGER NOT NULL DEFAULT 0"],
	["engine_event_outbox", "causation_command_id", "TEXT NOT NULL DEFAULT ''"],
	["engine_event_outbox", "binding_id", "TEXT NOT NULL DEFAULT ''"],
	["engine_event_outbox", "authority_generation", "INTEGER NOT NULL DEFAULT 0"],
	["omp_session_files", "title", "TEXT"],
	["omp_session_files", "title_source", "TEXT"],
	["omp_session_files", "title_updated_at", "TEXT"],
] as const;

const COMMAND_INBOX_SCHEMA = [
	`CREATE TABLE engine_commands (
		command_id TEXT PRIMARY KEY,
		operation TEXT NOT NULL,
		device_id TEXT NOT NULL,
		engine_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		agent_instance_id TEXT NOT NULL,
		agent_instance_ref TEXT,
		parent_agent_instance_id TEXT,
		binding_id TEXT,
		binding_generation INTEGER,
		execution_id TEXT,
		attempt_id TEXT,
		authority_generation INTEGER NOT NULL,
		payload_hash TEXT NOT NULL,
		canonical_hash TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('received', 'settled')),
		processor_generation INTEGER,
		outcome TEXT CHECK(outcome IN ('applied', 'rejected')),
		receipt TEXT,
		received_at INTEGER NOT NULL,
		settled_at INTEGER,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE INDEX engine_commands_state_idx ON engine_commands(state, processor_generation, updated_at)`,
] as const;

const SCHEMA_MIGRATIONS = [
	{ version: 1, statements: SCHEMA, requiredColumns: [] },
	{ version: 2, statements: [], requiredColumns: REQUIRED_COLUMNS },
	{ version: 3, statements: COMMAND_INBOX_SCHEMA, requiredColumns: [] },
] as const;

const CURRENT_SCHEMA_VERSION = SCHEMA_MIGRATIONS.at(-1)!.version;

type SqlClient = InstanceType<typeof SQL>;

interface MigrationRow {
	version: number;
	checksum: string;
}

function migrationChecksum(migration: (typeof SCHEMA_MIGRATIONS)[number]): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify({ statements: migration.statements, requiredColumns: migration.requiredColumns }))
		.digest("hex");
}

async function applySchemaMigrations(client: SqlClient): Promise<void> {
	await client.unsafe("BEGIN IMMEDIATE");
	try {
		await client.unsafe(
			`CREATE TABLE IF NOT EXISTS engine_schema_migrations (
				version INTEGER PRIMARY KEY,
				checksum TEXT NOT NULL,
				applied_at INTEGER NOT NULL
			)`,
		);
		const applied = (await client.unsafe(
			"SELECT version, checksum FROM engine_schema_migrations ORDER BY version",
		)) as MigrationRow[];
		if (applied.some(row => Number(row.version) > CURRENT_SCHEMA_VERSION)) {
			throw new Error(`Engine database schema is newer than this binary (max ${CURRENT_SCHEMA_VERSION})`);
		}
		for (const [index, row] of applied.entries()) {
			const migration = SCHEMA_MIGRATIONS[index];
			if (!migration || Number(row.version) !== migration.version) {
				throw new Error("Engine database migration history is not a contiguous supported prefix");
			}
			if (row.checksum !== migrationChecksum(migration)) {
				throw new Error(`Engine database migration ${migration.version} checksum does not match this binary`);
			}
		}
		for (const migration of SCHEMA_MIGRATIONS.slice(applied.length)) {
			for (const statement of migration.statements) await client.unsafe(statement);
			for (const [table, column, definition] of migration.requiredColumns) {
				const columns = (await client.unsafe(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
				if (!columns.some(candidate => candidate.name === column)) {
					await client.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
				}
			}
			await client.unsafe("INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)", [
				migration.version,
				migrationChecksum(migration),
				Date.now(),
			]);
		}
		await client.unsafe("INSERT OR IGNORE INTO engine_metadata(key, value) VALUES ('database_id', ?)", [
			crypto.randomUUID(),
		]);
		await client.unsafe("COMMIT");
	} catch (error) {
		await client.unsafe("ROLLBACK").catch(() => {});
		throw error;
	}
}

export class EngineStore {
	readonly #client: SqlClient;
	readonly sessionStorage: SqlSessionStorage;
	#transactionTail: Promise<void> = Promise.resolve();

	private constructor(client: SqlClient, sessionStorage: SqlSessionStorage) {
		this.#client = client;
		this.sessionStorage = sessionStorage;
	}

	static async open(databasePath: string): Promise<EngineStore> {
		const resolved = path.resolve(databasePath);
		await fs.mkdir(path.dirname(resolved), { recursive: true });
		const client = new SQL(`sqlite:${resolved.replaceAll("\\", "/")}`);
		try {
			await client.unsafe("PRAGMA journal_mode=WAL");
			await client.unsafe("PRAGMA foreign_keys=ON");
			await client.unsafe("PRAGMA synchronous=FULL");
			await client.unsafe("PRAGMA busy_timeout=5000");
			await applySchemaMigrations(client);
			const sessionStorage = await SqlSessionStorage.create({
				client,
				table: "omp_session_files",
				createTable: false,
			});
			return new EngineStore(client, sessionStorage);
		} catch (error) {
			await client.end().catch(() => {});
			throw error;
		}
	}

	async nextEngineGeneration(): Promise<number> {
		const rows = (await this.#client.unsafe(
			`INSERT INTO engine_metadata(key, value) VALUES ('engine_generation', '1')
			 ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
			 RETURNING value`,
		)) as MetadataRow[];
		return Number(rows[0]?.value ?? 1);
	}

	async isCurrentEngineGeneration(engineGeneration: number): Promise<boolean> {
		const rows = (await this.#client.unsafe(
			`SELECT value FROM engine_metadata WHERE key='engine_generation'`,
		)) as MetadataRow[];
		return Number(rows[0]?.value) === engineGeneration;
	}

	async admitCommand(command: EngineCommandIdentity, processorGeneration: number): Promise<EngineCommandAdmission> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`SELECT canonical_hash, state, processor_generation, receipt
				 FROM engine_commands WHERE command_id = ?`,
				[command.commandId],
			)) as CommandRow[];
			const existing = rows[0];
			if (existing) {
				if (existing.canonical_hash !== command.canonicalHash) {
					throw new EngineCommandConflictError(command.commandId);
				}
				if (existing.state === "settled") {
					if (!existing.receipt) throw new Error(`Settled command ${command.commandId} has no receipt`);
					return { status: "replay", receipt: JSON.parse(existing.receipt) as EngineCommandReceipt };
				}
				if (Number(existing.processor_generation) === processorGeneration) return { status: "in_progress" };
				await sql.unsafe(
					`UPDATE engine_commands SET processor_generation=?, updated_at=?
					 WHERE command_id=? AND state='received'`,
					[processorGeneration, Date.now(), command.commandId],
				);
				return { status: "claimed" };
			}

			const now = Date.now();
			await sql.unsafe(
				`INSERT INTO engine_commands(
				 command_id, operation, device_id, engine_id, engine_generation, agent_instance_id,
				 agent_instance_ref, parent_agent_instance_id, binding_id, binding_generation,
				 execution_id, attempt_id, authority_generation, payload_hash, canonical_hash,
				 state, processor_generation, received_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)`,
				[
					command.commandId,
					command.operation,
					command.deviceId,
					command.engineId,
					command.engineGeneration,
					command.agentInstanceId,
					command.agentInstanceRef ?? null,
					command.parentAgentInstanceId ?? null,
					command.bindingId ?? null,
					command.bindingGeneration ?? null,
					command.executionId ?? null,
					command.attemptId ?? null,
					command.authorityGeneration,
					command.payloadHash,
					command.canonicalHash,
					processorGeneration,
					now,
					now,
				],
			);
			return { status: "claimed" };
		});
	}

	async releaseCommand(commandId: string, canonicalHash: string, processorGeneration: number): Promise<void> {
		await this.#transaction(async sql => {
			await sql.unsafe(
				`UPDATE engine_commands SET processor_generation=NULL, updated_at=?
				 WHERE command_id=? AND canonical_hash=? AND state='received' AND processor_generation=?`,
				[Date.now(), commandId, canonicalHash, processorGeneration],
			);
		});
	}

	async settleCommand(commandId: string, canonicalHash: string, receipt: EngineCommandReceipt): Promise<void> {
		await this.#transaction(sql => this.#settleAdmittedCommand(sql, commandId, receipt, canonicalHash, true));
	}

	async getBinding(agentInstanceId: string): Promise<EngineBindingSnapshot | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT binding_id, command_id, agent_instance_id, execution_id, attempt_id, engine_agent_id, session_file,
			 profile_digest, state, engine_generation, binding_generation, authority_generation
			 FROM engine_runtime_bindings WHERE agent_instance_id = ?`,
			[agentInstanceId],
		)) as BindingRow[];
		const row = rows[0];
		if (!row) return undefined;
		return {
			bindingId: row.binding_id,
			commandId: row.command_id,
			agentInstanceId: row.agent_instance_id,
			executionId: row.execution_id,
			attemptId: row.attempt_id,
			engineAgentId: row.engine_agent_id,
			sessionFile: row.session_file ?? undefined,
			profileDigest: row.profile_digest,
			state: row.state,
			engineGeneration: Number(row.engine_generation),
			bindingGeneration: Number(row.binding_generation),
			authorityGeneration: Number(row.authority_generation),
		};
	}

	async putBinding(binding: EngineBindingSnapshot): Promise<void> {
		await this.#putBinding(this.#client, binding);
	}

	async putAttempt(binding: EngineBindingSnapshot, state: EngineAttemptState, cause?: string): Promise<boolean> {
		return await this.#putAttempt(this.#client, binding, state, cause);
	}

	async commitAttemptTransition(
		binding: EngineBindingSnapshot,
		state: EngineAttemptState,
		events: readonly EngineTransitionEvent[],
		options: {
			cause?: string;
			settleCommandId?: string;
			expectedStates?: readonly EngineAttemptState[];
			requireNew?: boolean;
		} = {},
	): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe("SELECT state FROM engine_attempts WHERE attempt_id=?", [
				binding.attemptId,
			])) as Array<{ state: EngineAttemptState }>;
			const current = rows[0]?.state;
			if (
				(options.requireNew && current !== undefined) ||
				(options.expectedStates && (current === undefined || !options.expectedStates.includes(current)))
			) {
				throw new EngineAttemptConflictError(binding.attemptId);
			}
			await this.#putBinding(sql, binding);
			if (!(await this.#putAttempt(sql, binding, state, options.cause))) {
				throw new EngineAttemptConflictError(binding.attemptId);
			}
			const committed: EngineEvent[] = [];
			for (const event of events) committed.push(await this.#appendTransitionEvent(sql, binding, event));
			if (options.settleCommandId) {
				await this.#settleAdmittedCommand(sql, options.settleCommandId, { outcome: "applied" });
			}
			return committed;
		});
	}

	async commitEvent(
		target: Pick<
			EngineBindingSnapshot,
			| "commandId"
			| "agentInstanceId"
			| "executionId"
			| "attemptId"
			| "engineGeneration"
			| "bindingId"
			| "bindingGeneration"
			| "authorityGeneration"
		>,
		event: EngineTransitionEvent,
		settleCommandId?: string,
		settleOutcome: EngineCommandReceipt["outcome"] = "applied",
	): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			const committed = await this.#appendTransitionEvent(sql, target, event);
			if (settleCommandId) await this.#settleAdmittedCommand(sql, settleCommandId, { outcome: settleOutcome });
			return committed;
		});
	}

	async getAttempt(attemptId: string): Promise<EngineAttemptRow | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT agent_instance_id, execution_id, attempt_id, command_id, binding_id, engine_generation, binding_generation,
			 authority_generation, state
			 FROM engine_attempts WHERE attempt_id = ?`,
			[attemptId],
		)) as EngineAttemptRow[];
		return rows[0];
	}

	async interruptGeneration(engineGeneration: number): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			const active = (await sql.unsafe(
				`SELECT agent_instance_id, execution_id, attempt_id, command_id, binding_id, engine_generation, binding_generation,
				 authority_generation, state
				 FROM engine_attempts
				 WHERE engine_generation < ? AND state IN ('accepted', 'running', 'pause_requested', 'paused', 'waiting_input', 'cancel_requested')`,
				[engineGeneration],
			)) as EngineAttemptRow[];
			const now = Date.now();
			await sql.unsafe(
				`UPDATE engine_attempts SET state='interrupted', cause='engine_lost', updated_at=?
				 WHERE engine_generation < ? AND state IN ('accepted', 'running', 'pause_requested', 'paused', 'waiting_input', 'cancel_requested')`,
				[now, engineGeneration],
			);
			await sql.unsafe(
				`UPDATE engine_runtime_bindings SET state='released', updated_at=?
				 WHERE engine_generation < ? AND state <> 'released'`,
				[now, engineGeneration],
			);
			const events: EngineEvent[] = [];
			for (const attempt of active) {
				events.push(
					await this.#appendTransitionEvent(
						sql,
						{
							commandId: attempt.command_id,
							agentInstanceId: attempt.agent_instance_id,
							executionId: attempt.execution_id,
							attemptId: attempt.attempt_id,
							engineGeneration,
							bindingId: attempt.binding_id,
							bindingGeneration: Number(attempt.binding_generation),
							authorityGeneration: Number(attempt.authority_generation),
						},
						{
							kind: "interrupted",
							payload: { cause: "engine_lost", lostEngineGeneration: Number(attempt.engine_generation) },
						},
					),
				);
			}
			return events;
		});
	}

	async appendEvent(event: Omit<EngineEvent, "eventId" | "seq" | "createdAt">): Promise<EngineEvent> {
		return await this.#transaction(sql => this.#appendEvent(sql, event));
	}

	async pendingEvents(limit = 100): Promise<EngineEvent[]> {
		const rows = (await this.#client.unsafe(
			`SELECT event_id, seq, causation_command_id, agent_instance_id, execution_id, attempt_id, binding_id, engine_generation,
			 binding_generation, authority_generation, kind, payload, created_at
			 FROM engine_event_outbox WHERE published_at IS NULL ORDER BY event_id LIMIT ?`,
			[Math.max(1, Math.min(1000, Math.floor(limit)))],
		)) as EventRow[];
		return rows.map(row => ({
			eventId: Number(row.event_id),
			seq: Number(row.seq),
			causationCommandId: row.causation_command_id,
			agentInstanceId: row.agent_instance_id,
			executionId: row.execution_id,
			attemptId: row.attempt_id,
			bindingId: row.binding_id,
			engineGeneration: Number(row.engine_generation),
			bindingGeneration: Number(row.binding_generation),
			authorityGeneration: Number(row.authority_generation),
			kind: row.kind,
			payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined,
			createdAt: Number(row.created_at),
		}));
	}

	async markEventPublished(eventId: number): Promise<void> {
		await this.#client.unsafe(`UPDATE engine_event_outbox SET published_at=? WHERE event_id=?`, [
			Date.now(),
			eventId,
		]);
	}

	async drain(): Promise<void> {
		await this.#transactionTail;
		await this.sessionStorage.drain();
	}

	async close(): Promise<void> {
		await this.drain();
		await this.#client.end();
	}

	async #putBinding(sql: SqlClient, binding: EngineBindingSnapshot): Promise<void> {
		await sql.unsafe(
			`INSERT INTO engine_runtime_bindings(
			 binding_id, command_id, agent_instance_id, execution_id, attempt_id, engine_agent_id, session_file,
			 profile_digest, state, engine_generation, binding_generation, authority_generation, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(agent_instance_id) DO UPDATE SET
			 binding_id=excluded.binding_id, command_id=excluded.command_id,
			 execution_id=excluded.execution_id, attempt_id=excluded.attempt_id,
			 engine_agent_id=excluded.engine_agent_id, session_file=excluded.session_file,
			 profile_digest=excluded.profile_digest, state=excluded.state,
			 engine_generation=excluded.engine_generation, binding_generation=excluded.binding_generation,
			 authority_generation=excluded.authority_generation,
			 updated_at=excluded.updated_at`,
			[
				binding.bindingId,
				binding.commandId,
				binding.agentInstanceId,
				binding.executionId,
				binding.attemptId,
				binding.engineAgentId,
				binding.sessionFile ?? null,
				binding.profileDigest,
				binding.state,
				binding.engineGeneration,
				binding.bindingGeneration,
				binding.authorityGeneration,
				Date.now(),
			],
		);
	}

	async #putAttempt(
		sql: SqlClient,
		binding: EngineBindingSnapshot,
		state: EngineAttemptState,
		cause?: string,
	): Promise<boolean> {
		const rows = (await sql.unsafe(
			`INSERT INTO engine_attempts(
			 attempt_id, command_id, agent_instance_id, execution_id, binding_id, engine_generation,
			 binding_generation, authority_generation, state, cause, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(attempt_id) DO UPDATE SET state=excluded.state, cause=excluded.cause,
			 updated_at=excluded.updated_at
			 WHERE engine_attempts.agent_instance_id=excluded.agent_instance_id
			   AND engine_attempts.execution_id=excluded.execution_id
			   AND engine_attempts.binding_id=excluded.binding_id
			   AND engine_attempts.engine_generation=excluded.engine_generation
			   AND engine_attempts.binding_generation=excluded.binding_generation
			   AND engine_attempts.authority_generation=excluded.authority_generation
			 RETURNING attempt_id`,
			[
				binding.attemptId,
				binding.commandId,
				binding.agentInstanceId,
				binding.executionId,
				binding.bindingId,
				binding.engineGeneration,
				binding.bindingGeneration,
				binding.authorityGeneration,
				state,
				cause ?? null,
				Date.now(),
			],
		)) as Array<{ attempt_id: string }>;
		return rows.length === 1;
	}

	#appendTransitionEvent(
		sql: SqlClient,
		target: Pick<
			EngineBindingSnapshot,
			| "commandId"
			| "agentInstanceId"
			| "executionId"
			| "attemptId"
			| "engineGeneration"
			| "bindingId"
			| "bindingGeneration"
			| "authorityGeneration"
		>,
		event: EngineTransitionEvent,
	): Promise<EngineEvent> {
		const { commandId: _, ...eventTarget } = target;
		return this.#appendEvent(sql, {
			...eventTarget,
			causationCommandId: event.causationCommandId ?? target.commandId,
			kind: event.kind,
			payload: event.payload,
		});
	}

	async #appendEvent(sql: SqlClient, event: Omit<EngineEvent, "eventId" | "seq" | "createdAt">): Promise<EngineEvent> {
		const seqRows = (await sql.unsafe(
			`INSERT INTO engine_agent_seq(agent_instance_id, seq) VALUES (?, 1)
			 ON CONFLICT(agent_instance_id) DO UPDATE SET seq=seq+1 RETURNING seq`,
			[event.agentInstanceId],
		)) as SeqRow[];
		const seq = Number(seqRows[0]?.seq ?? 1);
		const createdAt = Date.now();
		const rows = (await sql.unsafe(
			`INSERT INTO engine_event_outbox(
			 seq, causation_command_id, agent_instance_id, execution_id, attempt_id, binding_id, engine_generation,
			 binding_generation, authority_generation, kind, payload, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING event_id`,
			[
				seq,
				event.causationCommandId,
				event.agentInstanceId,
				event.executionId,
				event.attemptId,
				event.bindingId,
				event.engineGeneration,
				event.bindingGeneration,
				event.authorityGeneration,
				event.kind,
				event.payload ? JSON.stringify(event.payload) : null,
				createdAt,
			],
		)) as Array<{ event_id: number }>;
		return { ...event, eventId: Number(rows[0]?.event_id), seq, createdAt };
	}

	async #settleAdmittedCommand(
		sql: SqlClient,
		commandId: string,
		receipt: EngineCommandReceipt,
		expectedCanonicalHash?: string,
		required = false,
	): Promise<void> {
		const rows = (await sql.unsafe(
			"SELECT canonical_hash, state, processor_generation, receipt FROM engine_commands WHERE command_id = ?",
			[commandId],
		)) as CommandRow[];
		const existing = rows[0];
		if (!existing) {
			if (required) throw new Error(`Command ${commandId} was not admitted`);
			return;
		}
		if (expectedCanonicalHash && existing.canonical_hash !== expectedCanonicalHash) {
			throw new EngineCommandConflictError(commandId);
		}
		const serialized = JSON.stringify(receipt);
		if (existing.state === "settled") {
			if (existing.receipt !== serialized) throw new Error(`Command ${commandId} already has another receipt`);
			return;
		}
		const now = Date.now();
		await sql.unsafe(
			`UPDATE engine_commands
			 SET state='settled', processor_generation=NULL, outcome=?, receipt=?, settled_at=?, updated_at=?
			 WHERE command_id=? AND state='received'`,
			[receipt.outcome, serialized, now, now, commandId],
		);
	}

	#transaction<T>(work: (sql: SqlClient) => Promise<T>): Promise<T> {
		const run = this.#transactionTail.then(() => this.#client.begin("IMMEDIATE", work));
		this.#transactionTail = run.then(
			() => {},
			() => {},
		);
		return run;
	}
}
