import * as fs from "node:fs";
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

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS engine_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
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
] as const;

export class EngineStore {
	readonly #client: InstanceType<typeof SQL>;
	readonly sessionStorage: SqlSessionStorage;

	private constructor(client: InstanceType<typeof SQL>, sessionStorage: SqlSessionStorage) {
		this.#client = client;
		this.sessionStorage = sessionStorage;
	}

	static async open(databasePath: string): Promise<EngineStore> {
		const resolved = path.resolve(databasePath);
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
		const client = new SQL(`sqlite:${resolved.replaceAll("\\", "/")}`);
		await client.unsafe("PRAGMA journal_mode=WAL");
		await client.unsafe("PRAGMA busy_timeout=5000");
		for (const statement of SCHEMA) await client.unsafe(statement);
		for (const [table, column, definition] of REQUIRED_COLUMNS) {
			const columns = (await client.unsafe(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
			if (!columns.some(candidate => candidate.name === column)) {
				await client.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
			}
		}
		const sessionStorage = await SqlSessionStorage.create({ client, table: "omp_session_files" });
		return new EngineStore(client, sessionStorage);
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
		await this.#client.unsafe(
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

	async putAttempt(binding: EngineBindingSnapshot, state: EngineAttemptState, cause?: string): Promise<boolean> {
		const rows = (await this.#client.unsafe(
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

	async getAttempt(attemptId: string): Promise<EngineAttemptRow | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT agent_instance_id, execution_id, attempt_id, command_id, binding_id, engine_generation, binding_generation,
			 authority_generation, state
			 FROM engine_attempts WHERE attempt_id = ?`,
			[attemptId],
		)) as EngineAttemptRow[];
		return rows[0];
	}

	async reconcileInterrupted(engineGeneration: number): Promise<EngineAttemptRow[]> {
		const active = (await this.#client.unsafe(
			`SELECT agent_instance_id, execution_id, attempt_id, command_id, binding_id, engine_generation, binding_generation,
			 authority_generation, state
			 FROM engine_attempts
			 WHERE engine_generation < ? AND state IN ('accepted', 'running', 'pause_requested', 'paused', 'cancel_requested')`,
			[engineGeneration],
		)) as EngineAttemptRow[];
		const now = Date.now();
		await this.#client.unsafe(
			`UPDATE engine_attempts SET state='interrupted', cause='engine_lost', updated_at=?
			 WHERE engine_generation < ? AND state IN ('accepted', 'running', 'pause_requested', 'paused', 'cancel_requested')`,
			[now, engineGeneration],
		);
		await this.#client.unsafe(
			`UPDATE engine_runtime_bindings SET state='released', updated_at=?
			 WHERE engine_generation < ? AND state <> 'released'`,
			[now, engineGeneration],
		);
		return active;
	}

	async appendEvent(event: Omit<EngineEvent, "eventId" | "seq" | "createdAt">): Promise<EngineEvent> {
		const seqRows = (await this.#client.unsafe(
			`INSERT INTO engine_agent_seq(agent_instance_id, seq) VALUES (?, 1)
			 ON CONFLICT(agent_instance_id) DO UPDATE SET seq=seq+1 RETURNING seq`,
			[event.agentInstanceId],
		)) as SeqRow[];
		const seq = Number(seqRows[0]?.seq ?? 1);
		const createdAt = Date.now();
		const rows = (await this.#client.unsafe(
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
		await this.sessionStorage.drain();
	}

	async close(): Promise<void> {
		await this.drain();
		await this.#client.end();
	}
}
