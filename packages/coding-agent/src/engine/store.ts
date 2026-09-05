import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SQL } from "bun";
import type { SessionDurabilityCheckpoint } from "../session/session-manager";
import { SqlSessionStorage } from "../session/sql-session-storage";
import type {
	EngineAttemptState,
	EngineBindingSnapshot,
	EngineEvent,
	EngineInboxItem,
	EngineInboxMutation,
	EngineInboxSource,
	EngineInboxTarget,
	EngineRetryOutcome,
	EngineRetryState,
	EngineToolPolicy,
} from "./contracts";

interface MetadataRow {
	value: string;
}

function toolEffectPayload(effect: EngineToolEffectInput): Record<string, unknown> {
	return {
		invocationId: effect.effectId,
		toolCallId: effect.toolCallId,
		toolName: effect.toolName,
		policy: effect.policy,
		inputHash: effect.inputHash,
	};
}

function effectInputFromRow(row: EngineEffectRow): EngineToolEffectInput {
	return {
		effectId: row.effect_id,
		toolCallId: row.tool_call_id,
		toolName: row.tool_name,
		policy: row.policy,
		inputHash: row.input_hash,
	};
}

function modelEffectPayload(effectId: string, modelCallId: string): Record<string, unknown> {
	return { effectId, modelCallId };
}

function eventFromRow(row: EventRow): EngineEvent {
	return {
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
	};
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
	manual_hold: number;
	intent_revision: number;
	intent_command_id: string | null;
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
	transcript_session_id: string | null;
	transcript_path: string | null;
	transcript_leaf_entry_id: string | null;
	transcript_byte_boundary: number | null;
	transcript_revision: number;
	retry_attempt: number;
	retry_max_attempts: number;
	retry_route: string | null;
	retry_delay_ms: number | null;
	retry_scheduled_at: number | null;
	retry_outcome: EngineRetryOutcome | null;
	retry_error: string | null;
}

export interface EngineAttemptRecord extends EngineAttemptRow {
	row_id: number;
	cause: string | null;
	updated_at: number;
}

export interface ExpiredChildHistory {
	agentInstanceId: string;
	agentInstanceRef: string;
	attemptId: string;
	sessionFile: string;
	terminalAt: number;
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

interface InboxItemRow {
	queue_id: string;
	session_id: string;
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	binding_id: string;
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
	source_event_id: string;
	source_type: EngineInboxItem["sourceType"];
	sender: string | null;
	source_body: string;
	delivery_payload: string;
	annotation: string | null;
	deliver_at: number | null;
	wake_intent: number;
	wake_delivered_at: number | null;
	position: number;
	disposition: EngineInboxItem["disposition"];
	revision: number;
	created_at: number;
	updated_at: number;
}

function inboxItemFromRow(row: InboxItemRow): EngineInboxItem {
	return {
		queueId: row.queue_id,
		sessionId: row.session_id,
		agentInstanceId: row.agent_instance_id,
		attemptId: row.attempt_id,
		sourceEventId: row.source_event_id,
		sourceType: row.source_type,
		...(row.sender ? { sender: row.sender } : {}),
		sourceBody: row.source_body,
		deliveryPayload: row.delivery_payload,
		...(row.annotation !== null ? { annotation: row.annotation } : {}),
		...(row.deliver_at !== null ? { deliverAt: Number(row.deliver_at) } : {}),
		wakeIntent: Boolean(row.wake_intent),
		...(row.wake_delivered_at !== null ? { wakeDeliveredAt: Number(row.wake_delivered_at) } : {}),
		position: Number(row.position),
		disposition: row.disposition,
		revision: Number(row.revision),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	const values = new Set(left);
	return values.size === right.length && right.every(value => values.has(value));
}

type EngineEventTarget = Pick<
	EngineBindingSnapshot,
	| "commandId"
	| "agentInstanceId"
	| "executionId"
	| "attemptId"
	| "engineGeneration"
	| "bindingId"
	| "bindingGeneration"
	| "authorityGeneration"
>;

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

export interface EnginePendingStartCancellation {
	status: "cancelled" | "already_cancelled" | "too_late" | "not_found";
	event?: EngineEvent;
	intentRevision?: number;
}

export interface EngineTransitionEvent {
	kind: EngineEvent["kind"];
	payload?: Record<string, unknown>;
	causationCommandId?: string;
}

export interface EngineTranscriptCheckpoint extends SessionDurabilityCheckpoint {
	revision: number;
}

export interface EngineToolEffectInput {
	effectId: string;
	toolCallId: string;
	toolName: string;
	policy: EngineToolPolicy;
	inputHash: string;
}

export interface EngineModelEffectInput {
	effectId: string;
	modelCallId: string;
	inputHash: string;
}

export interface EngineEffectRow {
	effect_id: string;
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	binding_id: string;
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
	tool_call_id: string;
	tool_name: string;
	policy: EngineToolPolicy;
	input_hash: string;
	effect_kind: "tool" | "model";
	state: "planned" | "started" | "settled" | "unknown";
	outcome: "completed" | "failed" | "cancelled" | "denied" | "unknown" | null;
}

interface EngineEffectRecordRow extends EngineEffectRow {
	command_id: string;
}

interface EngineRecoveryEffectRow extends EngineEffectRecordRow {
	approval_id: string | null;
	approval_state: "pending" | "resolved" | null;
}

export interface EngineApprovalRow {
	approval_id: string;
	effect_id: string;
	state: "pending" | "resolved";
	decision: "approve" | "deny" | "cancelled" | null;
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

export class EngineEffectConflictError extends Error {
	constructor(effectId: string) {
		super(`Tool effect ${effectId} is not in the expected durable state`);
		this.name = "EngineEffectConflictError";
	}
}

export class EngineInboxConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngineInboxConflictError";
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

const TRANSCRIPT_CHECKPOINT_COLUMNS = [
	["engine_attempts", "transcript_session_id", "TEXT"],
	["engine_attempts", "transcript_path", "TEXT"],
	["engine_attempts", "transcript_leaf_entry_id", "TEXT"],
	["engine_attempts", "transcript_byte_boundary", "INTEGER"],
	["engine_attempts", "transcript_revision", "INTEGER NOT NULL DEFAULT 0"],
] as const;

const ATTEMPT_RETRY_COLUMNS = [
	["engine_attempts", "retry_attempt", "INTEGER NOT NULL DEFAULT 0"],
	["engine_attempts", "retry_max_attempts", "INTEGER NOT NULL DEFAULT 0"],
	["engine_attempts", "retry_route", "TEXT"],
	["engine_attempts", "retry_delay_ms", "INTEGER"],
	["engine_attempts", "retry_scheduled_at", "INTEGER"],
	["engine_attempts", "retry_outcome", "TEXT"],
	["engine_attempts", "retry_error", "TEXT"],
] as const;

const EFFECT_APPROVAL_SCHEMA = [
	`CREATE TABLE engine_effects (
		effect_id TEXT PRIMARY KEY,
		command_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL,
		execution_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		binding_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		tool_call_id TEXT NOT NULL,
		tool_name TEXT NOT NULL,
		policy TEXT NOT NULL CHECK(policy IN ('unrestricted', 'tracked', 'permit')),
		input_hash TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('planned', 'started', 'settled', 'unknown')),
		outcome TEXT CHECK(outcome IN ('completed', 'failed', 'cancelled', 'denied', 'unknown')),
		error TEXT,
		job_ids TEXT,
		created_at INTEGER NOT NULL,
		started_at INTEGER,
		settled_at INTEGER,
		updated_at INTEGER NOT NULL,
		UNIQUE(attempt_id, tool_call_id)
	)`,
	`CREATE INDEX engine_effects_recovery_idx ON engine_effects(engine_generation, state)`,
	`CREATE TABLE engine_approvals (
		approval_id TEXT PRIMARY KEY,
		effect_id TEXT NOT NULL UNIQUE REFERENCES engine_effects(effect_id),
		request_command_id TEXT NOT NULL,
		resolved_command_id TEXT,
		state TEXT NOT NULL CHECK(state IN ('pending', 'resolved')),
		decision TEXT CHECK(decision IN ('approve', 'deny', 'cancelled')),
		reason TEXT,
		requested_at INTEGER NOT NULL,
		resolved_at INTEGER,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE INDEX engine_approvals_state_idx ON engine_approvals(state, updated_at)`,
] as const;

const EFFECT_KIND_COLUMN = [
	["engine_effects", "effect_kind", "TEXT NOT NULL DEFAULT 'tool' CHECK(effect_kind IN ('tool', 'model'))"],
] as const;

const EVENT_DELIVERY_SCHEMA = [
	`CREATE TABLE engine_event_deliveries (
		event_id INTEGER NOT NULL REFERENCES engine_event_outbox(event_id),
		sink_id TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('pending', 'delivered')),
		attempts INTEGER NOT NULL DEFAULT 0,
		last_error TEXT,
		delivered_at INTEGER,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY(event_id, sink_id)
	)`,
	`CREATE INDEX engine_event_deliveries_pending_idx ON engine_event_deliveries(sink_id, state, event_id)`,
] as const;

const AGENT_INBOX_SCHEMA = [
	`CREATE TABLE engine_inbox_sources (
		source_event_id TEXT PRIMARY KEY,
		source_type TEXT NOT NULL CHECK(source_type IN ('user', 'agent', 'runtime')),
		sender TEXT,
		body TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`,
	`CREATE TABLE engine_inbox_items (
		queue_id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL,
		execution_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		binding_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		source_event_id TEXT NOT NULL UNIQUE REFERENCES engine_inbox_sources(source_event_id),
		delivery_payload TEXT NOT NULL,
		annotation TEXT,
		deliver_at INTEGER,
		wake_intent INTEGER NOT NULL CHECK(wake_intent IN (0, 1)),
		wake_delivered_at INTEGER,
		position INTEGER NOT NULL,
		disposition TEXT NOT NULL CHECK(disposition IN ('pending', 'acknowledged', 'dropped')),
		revision INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE INDEX engine_inbox_session_idx
	 ON engine_inbox_items(session_id, disposition, deliver_at, position, queue_id)`,
] as const;

const SCHEMA_MIGRATIONS = [
	{ version: 1, statements: SCHEMA, requiredColumns: [] },
	{ version: 2, statements: [], requiredColumns: REQUIRED_COLUMNS },
	{ version: 3, statements: COMMAND_INBOX_SCHEMA, requiredColumns: [] },
	{ version: 4, statements: [], requiredColumns: TRANSCRIPT_CHECKPOINT_COLUMNS },
	{ version: 5, statements: EFFECT_APPROVAL_SCHEMA, requiredColumns: [] },
	{ version: 6, statements: [], requiredColumns: EFFECT_KIND_COLUMN },
	{ version: 7, statements: EVENT_DELIVERY_SCHEMA, requiredColumns: [] },
	{ version: 8, statements: AGENT_INBOX_SCHEMA, requiredColumns: [] },
	{
		version: 9,
		statements: [],
		requiredColumns: [
			["engine_runtime_bindings", "manual_hold", "INTEGER NOT NULL DEFAULT 0 CHECK(manual_hold IN (0, 1))"],
			["engine_runtime_bindings", "intent_revision", "INTEGER NOT NULL DEFAULT 0"],
			["engine_runtime_bindings", "intent_command_id", "TEXT"],
		] as const,
	},
	{ version: 10, statements: [], requiredColumns: ATTEMPT_RETRY_COLUMNS },
] as const;

const CURRENT_SCHEMA_VERSION = SCHEMA_MIGRATIONS.at(-1)!.version;
const TERMINAL_ATTEMPT_STATES = new Set<EngineAttemptState>(["completed", "cancelled", "failed", "interrupted"]);

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

	async getStoreEpoch(): Promise<string> {
		const rows = (await this.#client.unsafe(
			`SELECT value FROM engine_metadata WHERE key='database_id'`,
		)) as MetadataRow[];
		const value = rows[0]?.value;
		if (!value) throw new Error("Engine database has no stable identity");
		return value;
	}

	async enqueueInboxItem(
		target: EngineInboxTarget,
		source: EngineInboxSource,
	): Promise<{ item: EngineInboxItem; created: boolean }> {
		if (!source.sourceEventId.trim() || !source.body.trim()) {
			throw new EngineInboxConflictError("Inbox sourceEventId and body must be non-empty");
		}
		if (!Number.isSafeInteger(source.createdAt) || source.createdAt < 0) {
			throw new EngineInboxConflictError("Inbox createdAt must be a non-negative safe integer");
		}
		return await this.#transaction(async sql => {
			const sourceRows = (await sql.unsafe(
				`SELECT source_type, sender, body, created_at FROM engine_inbox_sources WHERE source_event_id=?`,
				[source.sourceEventId],
			)) as Array<{ source_type: string; sender: string | null; body: string; created_at: number }>;
			const existingSource = sourceRows[0];
			if (
				existingSource &&
				(existingSource.source_type !== source.sourceType ||
					existingSource.sender !== (source.sender ?? null) ||
					existingSource.body !== source.body ||
					Number(existingSource.created_at) !== source.createdAt)
			) {
				throw new EngineInboxConflictError(`Inbox source ${source.sourceEventId} has different immutable content`);
			}
			if (!existingSource) {
				await sql.unsafe(
					`INSERT INTO engine_inbox_sources(source_event_id, source_type, sender, body, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
					[source.sourceEventId, source.sourceType, source.sender ?? null, source.body, source.createdAt],
				);
			}
			const existing = await this.#inboxItem(sql, target.sessionId, source.sourceEventId);
			if (existing) {
				this.#assertInboxTarget(existing, target);
				return { item: inboxItemFromRow(existing), created: false };
			}
			const positions = (await sql.unsafe(
				`SELECT COALESCE(MAX(position), 0) AS position FROM engine_inbox_items
				 WHERE session_id=? AND disposition='pending'`,
				[target.sessionId],
			)) as Array<{ position: number }>;
			const now = Date.now();
			await sql.unsafe(
				`INSERT INTO engine_inbox_items(
				 queue_id, session_id, agent_instance_id, execution_id, attempt_id, binding_id,
				 engine_generation, binding_generation, authority_generation, source_event_id,
				 delivery_payload, deliver_at, wake_intent, position, disposition, revision, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
				[
					source.sourceEventId,
					target.sessionId,
					target.agentInstanceId,
					target.executionId,
					target.attemptId,
					target.bindingId,
					target.engineGeneration,
					target.bindingGeneration,
					target.authorityGeneration,
					source.sourceEventId,
					source.body,
					source.deliverAt ?? null,
					source.wakeIntent ? 1 : 0,
					Number(positions[0]?.position ?? 0) + 1024,
					now,
					now,
				],
			);
			await this.#appendInboxEvent(sql, target, source.sourceEventId, "queued", 1);
			const created = await this.#inboxItem(sql, target.sessionId, source.sourceEventId);
			if (!created) throw new Error("Engine inbox insert was not readable");
			return { item: inboxItemFromRow(created), created: true };
		});
	}

	async listInboxItems(sessionId: string, includeTerminal = false): Promise<EngineInboxItem[]> {
		if (!sessionId.trim()) throw new EngineInboxConflictError("Inbox sessionId must be non-empty");
		const rows = (await this.#client.unsafe(
			`${this.#inboxSelect()} WHERE i.session_id=?${includeTerminal ? "" : " AND i.disposition='pending'"}
			 ORDER BY i.position, i.queue_id`,
			[sessionId],
		)) as InboxItemRow[];
		return rows.map(inboxItemFromRow);
	}

	async getInboxItem(sessionId: string, queueId: string): Promise<EngineInboxItem | undefined> {
		const row = await this.#inboxItem(this.#client, sessionId, queueId);
		return row ? inboxItemFromRow(row) : undefined;
	}

	async mutateInboxItem(target: EngineInboxTarget, mutation: EngineInboxMutation): Promise<EngineInboxItem> {
		if (!mutation.mutationId.trim() || !mutation.queueId.trim()) {
			throw new EngineInboxConflictError("Inbox mutationId and queueId must be non-empty");
		}
		return await this.#transaction(async sql => {
			return (await this.#mutateInboxItem(sql, target, mutation)).item;
		});
	}

	async reorderInboxItems(
		target: EngineInboxTarget,
		mutationId: string,
		expectedOrder: readonly string[],
		desiredOrder: readonly string[],
	): Promise<EngineInboxItem[]> {
		if (!mutationId.trim() || new Set(desiredOrder).size !== desiredOrder.length) {
			throw new EngineInboxConflictError("Inbox reorder identity and queue IDs must be unique");
		}
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`${this.#inboxSelect()} WHERE i.session_id=? AND i.disposition='pending' ORDER BY i.position, i.queue_id`,
				[target.sessionId],
			)) as InboxItemRow[];
			for (const row of rows) this.#assertInboxTarget(row, target);
			const current = rows.map(row => row.queue_id);
			if (sameStrings(current, desiredOrder)) return rows.map(inboxItemFromRow);
			if (!sameStrings(current, expectedOrder) || !sameStringSet(current, desiredOrder)) {
				throw new EngineInboxConflictError(
					"Inbox order changed or desiredOrder does not contain every pending item",
				);
			}
			const byId = new Map(rows.map(row => [row.queue_id, row]));
			const now = Date.now();
			for (const [index, queueId] of desiredOrder.entries()) {
				const row = byId.get(queueId);
				if (!row) throw new EngineInboxConflictError(`Inbox item ${queueId} does not exist`);
				await sql.unsafe(
					`UPDATE engine_inbox_items SET position=?, revision=revision+1, updated_at=? WHERE queue_id=?`,
					[(index + 1) * 1024, now, queueId],
				);
			}
			await this.#appendInboxEvent(sql, target, mutationId, "reorder", 1);
			const reordered = (await sql.unsafe(
				`${this.#inboxSelect()} WHERE i.session_id=? AND i.disposition='pending' ORDER BY i.position, i.queue_id`,
				[target.sessionId],
			)) as InboxItemRow[];
			return reordered.map(inboxItemFromRow);
		});
	}

	async nextInboxWakeAt(engineGeneration: number): Promise<number | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT MIN(i.deliver_at) AS deliver_at FROM engine_inbox_items i
			 JOIN engine_runtime_bindings b ON b.agent_instance_id=i.agent_instance_id
			 WHERE i.engine_generation=? AND i.disposition='pending' AND i.wake_intent=1
			 AND i.wake_delivered_at IS NULL AND i.deliver_at IS NOT NULL AND b.manual_hold=0`,
			[engineGeneration],
		)) as Array<{ deliver_at: number | null }>;
		return rows[0]?.deliver_at === null || rows[0]?.deliver_at === undefined ? undefined : Number(rows[0].deliver_at);
	}

	async claimDueInboxWakes(engineGeneration: number, now = Date.now()): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`${this.#inboxSelect()} JOIN engine_runtime_bindings b ON b.agent_instance_id=i.agent_instance_id
				 WHERE i.engine_generation=? AND i.disposition='pending' AND b.manual_hold=0
				 AND i.wake_intent=1 AND i.wake_delivered_at IS NULL AND i.deliver_at<=?
				 ORDER BY i.deliver_at, i.position, i.queue_id LIMIT 100`,
				[engineGeneration, now],
			)) as InboxItemRow[];
			const events: EngineEvent[] = [];
			for (const row of rows) {
				const revision = Number(row.revision) + 1;
				await sql.unsafe(
					`UPDATE engine_inbox_items SET wake_delivered_at=?, revision=?, updated_at=?
					 WHERE queue_id=? AND wake_delivered_at IS NULL`,
					[now, revision, now, row.queue_id],
				);
				events.push(
					await this.#appendInboxEvent(
						sql,
						{
							sessionId: row.session_id,
							agentInstanceId: row.agent_instance_id,
							executionId: row.execution_id,
							attemptId: row.attempt_id,
							bindingId: row.binding_id,
							engineGeneration: Number(row.engine_generation),
							bindingGeneration: Number(row.binding_generation),
							authorityGeneration: Number(row.authority_generation),
						},
						`inbox-wake:${row.queue_id}:${revision}`,
						"wake_due",
						revision,
						row.queue_id,
					),
				);
			}
			return events;
		});
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

	async cancelPendingStart(
		target: Pick<
			EngineCommandIdentity,
			"agentInstanceId" | "executionId" | "attemptId" | "authorityGeneration" | "engineGeneration"
		>,
		cancellationCommandId: string,
	): Promise<EnginePendingStartCancellation> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`SELECT command_id, canonical_hash, state, processor_generation, receipt
				 FROM engine_commands
				 WHERE operation='start' AND agent_instance_id=? AND execution_id=? AND attempt_id=?
				   AND authority_generation=? AND engine_generation=?
				 ORDER BY received_at DESC LIMIT 1`,
				[
					target.agentInstanceId,
					target.executionId,
					target.attemptId,
					target.authorityGeneration,
					target.engineGeneration,
				],
			)) as Array<CommandRow & { command_id: string }>;
			const start = rows[0];
			if (!start) return { status: "not_found" };
			if (start.state === "settled") {
				const receipt = start.receipt ? (JSON.parse(start.receipt) as EngineCommandReceipt) : undefined;
				if (receipt?.outcome !== "rejected" || receipt.detail?.code !== "cancelled") {
					return { status: "too_late" };
				}
			}

			const intentRows = (await sql.unsafe(
				`UPDATE engine_runtime_bindings
				 SET manual_hold=1,
				     intent_revision=CASE WHEN intent_command_id=? THEN intent_revision ELSE intent_revision+1 END,
				     intent_command_id=?, updated_at=?
				 WHERE agent_instance_id=? AND authority_generation=?
				 RETURNING intent_revision`,
				[
					cancellationCommandId,
					cancellationCommandId,
					Date.now(),
					target.agentInstanceId,
					target.authorityGeneration,
				],
			)) as Array<{ intent_revision: number }>;
			const intentRevision = intentRows[0] ? Number(intentRows[0].intent_revision) : undefined;
			if (start.state === "settled") return { status: "already_cancelled", intentRevision };

			const message = "Attempt cancelled before Engine session initialization";
			await this.#settleAdmittedCommand(
				sql,
				start.command_id,
				{ outcome: "rejected", detail: { code: "cancelled", message, cancellationCommandId } },
				start.canonical_hash,
				true,
			);
			const event = await this.#appendEvent(sql, {
				causationCommandId: start.command_id,
				agentInstanceId: target.agentInstanceId,
				executionId: target.executionId!,
				attemptId: target.attemptId!,
				bindingId: "",
				engineGeneration: target.engineGeneration,
				bindingGeneration: 0,
				authorityGeneration: target.authorityGeneration,
				kind: "rejected",
				payload: { code: "cancelled", message, cancellationCommandId },
			});
			return { status: "cancelled", event, intentRevision };
		});
	}

	async getBinding(agentInstanceId: string): Promise<EngineBindingSnapshot | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT binding_id, command_id, agent_instance_id, execution_id, attempt_id, engine_agent_id, session_file,
			 profile_digest, state, engine_generation, binding_generation, authority_generation,
			 manual_hold, intent_revision, intent_command_id
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
			manualHold: Boolean(row.manual_hold),
			intentRevision: Number(row.intent_revision),
			...(row.intent_command_id ? { intentCommandId: row.intent_command_id } : {}),
		};
	}

	async listExpiredChildHistory(cutoff: number, limit = 100): Promise<ExpiredChildHistory[]> {
		const rows = (await this.#client.unsafe(
			`SELECT b.agent_instance_id, c.agent_instance_ref, b.attempt_id, b.session_file, a.updated_at
			 FROM engine_runtime_bindings b
			 JOIN engine_attempts a ON a.attempt_id=b.attempt_id
			 JOIN engine_commands c ON c.command_id=(
				SELECT child.command_id FROM engine_commands child
				WHERE child.agent_instance_id=b.agent_instance_id AND child.operation='start'
				AND child.parent_agent_instance_id IS NOT NULL AND child.agent_instance_ref IS NOT NULL
				ORDER BY child.received_at, child.command_id LIMIT 1
			 )
			 WHERE b.session_file IS NOT NULL
			 AND a.state IN ('completed', 'cancelled', 'failed', 'interrupted') AND a.updated_at<=?
			 ORDER BY a.updated_at, b.agent_instance_id LIMIT ?`,
			[Math.max(0, Math.floor(cutoff)), Math.max(1, Math.min(1000, Math.floor(limit)))],
		)) as Array<{
			agent_instance_id: string;
			agent_instance_ref: string;
			attempt_id: string;
			session_file: string;
			updated_at: number;
		}>;
		return rows.map(row => ({
			agentInstanceId: row.agent_instance_id,
			agentInstanceRef: row.agent_instance_ref,
			attemptId: row.attempt_id,
			sessionFile: row.session_file,
			terminalAt: Number(row.updated_at),
		}));
	}

	async clearBindingSession(agentInstanceId: string, attemptId: string, sessionFile: string): Promise<void> {
		await this.#client.unsafe(
			`UPDATE engine_runtime_bindings SET session_file=NULL, updated_at=?
			 WHERE agent_instance_id=? AND attempt_id=? AND session_file=?`,
			[Date.now(), agentInstanceId, attemptId, sessionFile],
		);
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
			settleCommandReceipt?: EngineCommandReceipt;
			expectedStates?: readonly EngineAttemptState[];
			requireNew?: boolean;
			transcriptCheckpoint?: SessionDurabilityCheckpoint;
			inboxSessionId?: string;
			inboxMutation?: EngineInboxMutation;
		} = {},
	): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe("SELECT state, transcript_revision FROM engine_attempts WHERE attempt_id=?", [
				binding.attemptId,
			])) as Array<{ state: EngineAttemptState; transcript_revision: number }>;
			const currentRow = rows[0];
			const current = currentRow?.state;
			if (
				(options.requireNew && current !== undefined) ||
				(options.expectedStates && (current === undefined || !options.expectedStates.includes(current)))
			) {
				throw new EngineAttemptConflictError(binding.attemptId);
			}
			if (TERMINAL_ATTEMPT_STATES.has(state)) {
				const openEffects = await sql.unsafe(
					`SELECT effect_id FROM engine_effects
					 WHERE attempt_id=? AND binding_id=? AND state IN ('planned', 'started') LIMIT 1`,
					[binding.attemptId, binding.bindingId],
				);
				if (openEffects.length > 0) throw new EngineEffectConflictError(String(openEffects[0]?.effect_id));
			}
			const transcriptCheckpoint = options.transcriptCheckpoint
				? { ...options.transcriptCheckpoint, revision: Number(currentRow?.transcript_revision ?? 0) + 1 }
				: undefined;
			await this.#putBinding(sql, binding);
			if (!(await this.#putAttempt(sql, binding, state, options.cause, transcriptCheckpoint))) {
				throw new EngineAttemptConflictError(binding.attemptId);
			}
			if (options.inboxSessionId) {
				await sql.unsafe(
					`UPDATE engine_inbox_items SET execution_id=?, attempt_id=?, binding_id=?, engine_generation=?,
					 binding_generation=?, authority_generation=?, updated_at=?
					 WHERE session_id=? AND agent_instance_id=? AND disposition='pending'`,
					[
						binding.executionId,
						binding.attemptId,
						binding.bindingId,
						binding.engineGeneration,
						binding.bindingGeneration,
						binding.authorityGeneration,
						Date.now(),
						options.inboxSessionId,
						binding.agentInstanceId,
					],
				);
			}
			const committed: EngineEvent[] = [];
			for (const event of events) {
				committed.push(
					await this.#appendTransitionEvent(sql, binding, {
						...event,
						...(transcriptCheckpoint ? { payload: { ...event.payload, transcriptCheckpoint } } : {}),
					}),
				);
			}
			if (options.inboxMutation) {
				if (!options.inboxSessionId) throw new Error("Inbox mutation requires its session identity");
				const result = await this.#mutateInboxItem(
					sql,
					{ ...binding, sessionId: options.inboxSessionId },
					options.inboxMutation,
				);
				if (result.event) committed.push(result.event);
			}
			if (options.settleCommandId) {
				await this.#settleAdmittedCommand(
					sql,
					options.settleCommandId,
					options.settleCommandReceipt ?? { outcome: "applied" },
				);
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
		settleReceipt: EngineCommandReceipt | EngineCommandReceipt["outcome"] = "applied",
	): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			const committed = await this.#appendTransitionEvent(sql, target, event);
			if (settleCommandId) {
				await this.#settleAdmittedCommand(
					sql,
					settleCommandId,
					typeof settleReceipt === "string" ? { outcome: settleReceipt } : settleReceipt,
				);
			}
			return committed;
		});
	}

	/** Atomically persist retry progress on the Attempt and append its public event. */
	async commitAttemptRetry(
		target: EngineBindingSnapshot,
		retry: EngineRetryState,
		event: EngineTransitionEvent,
	): Promise<EngineEvent | undefined> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`UPDATE engine_attempts SET retry_attempt=?, retry_max_attempts=?,
				 retry_route=COALESCE(?, retry_route), retry_delay_ms=COALESCE(?, retry_delay_ms),
				 retry_scheduled_at=COALESCE(?, retry_scheduled_at), retry_outcome=?, retry_error=?, updated_at=?
				 WHERE attempt_id=? AND agent_instance_id=? AND execution_id=? AND binding_id=?
				 AND engine_generation=? AND binding_generation=? AND authority_generation=?
				 AND state IN ('running', 'pause_requested', 'paused', 'cancel_requested')
				 RETURNING attempt_id`,
				[
					retry.attempt,
					retry.maxAttempts,
					retry.route ?? null,
					retry.delayMs ?? null,
					retry.scheduledAt ?? null,
					retry.outcome ?? null,
					retry.error ?? null,
					Date.now(),
					target.attemptId,
					target.agentInstanceId,
					target.executionId,
					target.bindingId,
					target.engineGeneration,
					target.bindingGeneration,
					target.authorityGeneration,
				],
			)) as Array<{ attempt_id: string }>;
			if (rows.length === 0) return undefined;
			return await this.#appendTransitionEvent(sql, target, event);
		});
	}

	async startToolEffect(target: EngineEventTarget, effect: EngineToolEffectInput): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			await this.#insertToolEffect(sql, target, effect, "started");
			return await this.#appendTransitionEvent(sql, target, {
				kind: "tool_started",
				payload: toolEffectPayload(effect),
			});
		});
	}

	async startModelEffect(target: EngineEventTarget, effect: EngineModelEffectInput): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			const now = Date.now();
			await sql.unsafe(
				`INSERT INTO engine_effects(
				 effect_id, command_id, agent_instance_id, execution_id, attempt_id, binding_id,
				 engine_generation, binding_generation, authority_generation, tool_call_id, tool_name,
				 policy, input_hash, effect_kind, state, created_at, started_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'model_dispatch', 'unrestricted', ?, 'model', 'started', ?, ?, ?)`,
				[
					effect.effectId,
					target.commandId,
					target.agentInstanceId,
					target.executionId,
					target.attemptId,
					target.bindingId,
					target.engineGeneration,
					target.bindingGeneration,
					target.authorityGeneration,
					effect.modelCallId,
					effect.inputHash,
					now,
					now,
					now,
				],
			);
			return await this.#appendTransitionEvent(sql, target, {
				kind: "model_started",
				payload: modelEffectPayload(effect.effectId, effect.modelCallId),
			});
		});
	}

	async requestToolApproval(target: EngineEventTarget, effect: EngineToolEffectInput): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			await this.#insertToolEffect(sql, target, effect, "planned");
			const now = Date.now();
			await sql.unsafe(
				`INSERT INTO engine_approvals(
				 approval_id, effect_id, request_command_id, state, requested_at, updated_at
				 ) VALUES (?, ?, ?, 'pending', ?, ?)`,
				[effect.effectId, effect.effectId, target.commandId, now, now],
			);
			return await this.#appendTransitionEvent(sql, target, {
				kind: "tool_approval_requested",
				payload: { ...toolEffectPayload(effect), approvalId: effect.effectId },
			});
		});
	}

	async resolveToolApproval(
		target: EngineEventTarget,
		approvalId: string,
		decision: "approve" | "deny" | "cancelled",
		options: { reason?: string; causationCommandId?: string; settleCommandId?: string } = {},
	): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`SELECT e.effect_id, e.command_id, e.agent_instance_id, e.execution_id, e.attempt_id, e.binding_id,
				 e.engine_generation, e.binding_generation, e.authority_generation, e.tool_call_id, e.tool_name,
				 e.policy, e.input_hash, e.effect_kind, e.state, e.outcome, a.state AS approval_state, a.decision
				 FROM engine_approvals a JOIN engine_effects e ON e.effect_id=a.effect_id
				 WHERE a.approval_id=? AND e.agent_instance_id=? AND e.execution_id=? AND e.attempt_id=?
				 AND e.binding_id=? AND e.engine_generation=? AND e.binding_generation=? AND e.authority_generation=?`,
				[
					approvalId,
					target.agentInstanceId,
					target.executionId,
					target.attemptId,
					target.bindingId,
					target.engineGeneration,
					target.bindingGeneration,
					target.authorityGeneration,
				],
			)) as Array<EngineEffectRecordRow & { approval_state: "pending" | "resolved"; decision: string | null }>;
			const row = rows[0];
			if (row?.approval_state !== "pending" || row.state !== "planned") {
				throw new EngineEffectConflictError(approvalId);
			}
			const now = Date.now();
			await sql.unsafe(
				`UPDATE engine_approvals SET state='resolved', decision=?, reason=?, resolved_command_id=?,
				 resolved_at=?, updated_at=? WHERE approval_id=? AND state='pending'`,
				[decision, options.reason ?? null, options.causationCommandId ?? null, now, now, approvalId],
			);
			if (decision === "approve") {
				await sql.unsafe(
					`UPDATE engine_effects SET state='started', started_at=?, updated_at=?
					 WHERE effect_id=? AND state='planned'`,
					[now, now, row.effect_id],
				);
			} else {
				await sql.unsafe(
					`UPDATE engine_effects SET state='settled', outcome=?, error=?, settled_at=?, updated_at=?
					 WHERE effect_id=? AND state='planned'`,
					[decision === "deny" ? "denied" : "cancelled", options.reason ?? null, now, now, row.effect_id],
				);
			}
			const effect = effectInputFromRow(row);
			const causationCommandId = options.causationCommandId ?? target.commandId;
			const events = [
				await this.#appendTransitionEvent(sql, target, {
					kind: "tool_approval_resolved",
					causationCommandId,
					payload: {
						approvalId,
						decision,
						...(options.reason ? { reason: options.reason } : {}),
					},
				}),
				await this.#appendTransitionEvent(sql, target, {
					kind: decision === "approve" ? "tool_started" : "tool_settled",
					causationCommandId,
					payload:
						decision === "approve"
							? toolEffectPayload(effect)
							: {
									...toolEffectPayload(effect),
									status: decision === "deny" ? "denied" : "cancelled",
									...(options.reason ? { error: options.reason } : {}),
								},
				}),
			];
			if (options.settleCommandId) {
				await this.#settleAdmittedCommand(sql, options.settleCommandId, { outcome: "applied" });
			}
			return events;
		});
	}

	async settleToolEffect(
		target: EngineEventTarget,
		effectId: string,
		outcome: "completed" | "failed" | "cancelled",
		options: { error?: string; jobIds?: string[] } = {},
	): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`UPDATE engine_effects SET state='settled', outcome=?, error=?, job_ids=?, settled_at=?, updated_at=?
				 WHERE effect_id=? AND agent_instance_id=? AND execution_id=? AND attempt_id=? AND binding_id=?
				 AND engine_generation=? AND binding_generation=? AND authority_generation=? AND state='started'
				 RETURNING effect_id, command_id, agent_instance_id, execution_id, attempt_id, binding_id,
				 engine_generation, binding_generation, authority_generation, tool_call_id, tool_name,
				 policy, input_hash, effect_kind, state, outcome`,
				[
					outcome,
					options.error ?? null,
					options.jobIds?.length ? JSON.stringify(options.jobIds) : null,
					Date.now(),
					Date.now(),
					effectId,
					target.agentInstanceId,
					target.executionId,
					target.attemptId,
					target.bindingId,
					target.engineGeneration,
					target.bindingGeneration,
					target.authorityGeneration,
				],
			)) as EngineEffectRecordRow[];
			const row = rows[0];
			if (!row) throw new EngineEffectConflictError(effectId);
			return await this.#appendTransitionEvent(sql, target, {
				kind: "tool_settled",
				payload: {
					...toolEffectPayload(effectInputFromRow(row)),
					status: outcome,
					...(options.error ? { error: options.error } : {}),
					...(options.jobIds?.length ? { jobIds: options.jobIds } : {}),
				},
			});
		});
	}

	async settleModelEffect(
		target: EngineEventTarget,
		effect: EngineModelEffectInput,
		outcome: "completed" | "failed",
		error?: string,
	): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			const rows = await sql.unsafe(
				`UPDATE engine_effects SET state='settled', outcome=?, error=?, settled_at=?, updated_at=?
				 WHERE effect_id=? AND agent_instance_id=? AND execution_id=? AND attempt_id=? AND binding_id=?
				 AND engine_generation=? AND binding_generation=? AND authority_generation=?
				 AND effect_kind='model' AND state='started' RETURNING effect_id`,
				[
					outcome,
					error ?? null,
					Date.now(),
					Date.now(),
					effect.effectId,
					target.agentInstanceId,
					target.executionId,
					target.attemptId,
					target.bindingId,
					target.engineGeneration,
					target.bindingGeneration,
					target.authorityGeneration,
				],
			);
			if (rows.length === 0) throw new EngineEffectConflictError(effect.effectId);
			return await this.#appendTransitionEvent(sql, target, {
				kind: "model_settled",
				payload: {
					...modelEffectPayload(effect.effectId, effect.modelCallId),
					status: outcome,
					...(error ? { error } : {}),
				},
			});
		});
	}

	async getEffect(effectId: string): Promise<EngineEffectRow | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT effect_id, agent_instance_id, execution_id, attempt_id, binding_id, engine_generation,
			 binding_generation, authority_generation, tool_call_id, tool_name, policy, input_hash, effect_kind, state, outcome
			 FROM engine_effects WHERE effect_id=?`,
			[effectId],
		)) as EngineEffectRow[];
		return rows[0];
	}

	async getApproval(approvalId: string): Promise<EngineApprovalRow | undefined> {
		const rows = (await this.#client.unsafe(
			"SELECT approval_id, effect_id, state, decision FROM engine_approvals WHERE approval_id=?",
			[approvalId],
		)) as EngineApprovalRow[];
		return rows[0];
	}

	async getAttempt(attemptId: string): Promise<EngineAttemptRecord | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT rowid AS row_id, agent_instance_id, execution_id, attempt_id, command_id, binding_id,
			 engine_generation, binding_generation, authority_generation, state, cause, updated_at,
			 transcript_session_id, transcript_path, transcript_leaf_entry_id,
			 transcript_byte_boundary, transcript_revision, retry_attempt, retry_max_attempts,
			 retry_route, retry_delay_ms, retry_scheduled_at, retry_outcome, retry_error
			 FROM engine_attempts WHERE attempt_id = ?`,
			[attemptId],
		)) as EngineAttemptRecord[];
		return rows[0];
	}

	async listAttempts(afterRowId = 0, limit = 100): Promise<EngineAttemptRecord[]> {
		const rows = (await this.#client.unsafe(
			`SELECT rowid AS row_id, agent_instance_id, execution_id, attempt_id, command_id, binding_id,
			 engine_generation, binding_generation, authority_generation, state, cause, updated_at,
			 transcript_session_id, transcript_path, transcript_leaf_entry_id, transcript_byte_boundary,
			 transcript_revision, retry_attempt, retry_max_attempts, retry_route, retry_delay_ms,
			 retry_scheduled_at, retry_outcome, retry_error
			 FROM engine_attempts WHERE rowid > ? ORDER BY rowid LIMIT ?`,
			[Math.max(0, Math.floor(afterRowId)), Math.max(1, Math.min(1000, Math.floor(limit)))],
		)) as EngineAttemptRecord[];
		return rows;
	}

	async eventsAfter(attemptId: string, afterEventId = 0, limit = 100): Promise<EngineEvent[]> {
		const rows = (await this.#client.unsafe(
			`SELECT event_id, seq, causation_command_id, agent_instance_id, execution_id, attempt_id, binding_id,
			 engine_generation, binding_generation, authority_generation, kind, payload, created_at
			 FROM engine_event_outbox WHERE attempt_id=? AND event_id>? ORDER BY event_id LIMIT ?`,
			[attemptId, Math.max(0, Math.floor(afterEventId)), Math.max(1, Math.min(1000, Math.floor(limit)))],
		)) as EventRow[];
		return rows.map(eventFromRow);
	}

	async eventBounds(attemptId: string): Promise<{ first: number; last: number }> {
		const rows = (await this.#client.unsafe(
			"SELECT MIN(event_id) AS first, MAX(event_id) AS last FROM engine_event_outbox WHERE attempt_id=?",
			[attemptId],
		)) as Array<{ first: number | null; last: number | null }>;
		return { first: Number(rows[0]?.first ?? 0), last: Number(rows[0]?.last ?? 0) };
	}

	async terminalEvent(attemptId: string): Promise<EngineEvent | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT event_id, seq, causation_command_id, agent_instance_id, execution_id, attempt_id, binding_id,
			 engine_generation, binding_generation, authority_generation, kind, payload, created_at
			 FROM engine_event_outbox WHERE attempt_id=?
			 AND kind IN ('completed', 'cancelled', 'failed', 'interrupted') ORDER BY event_id DESC LIMIT 1`,
			[attemptId],
		)) as EventRow[];
		return rows[0] ? eventFromRow(rows[0]) : undefined;
	}

	async interruptGeneration(engineGeneration: number): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			const active = (await sql.unsafe(
				`SELECT agent_instance_id, execution_id, attempt_id, command_id, binding_id, engine_generation, binding_generation,
				 authority_generation, state, transcript_session_id, transcript_path, transcript_leaf_entry_id,
				 transcript_byte_boundary, transcript_revision, retry_attempt, retry_max_attempts,
				 retry_route, retry_delay_ms, retry_scheduled_at, retry_outcome, retry_error
				 FROM engine_attempts
				 WHERE engine_generation < ? AND state IN ('accepted', 'running', 'pause_requested', 'paused', 'waiting_input', 'cancel_requested')`,
				[engineGeneration],
			)) as EngineAttemptRow[];
			const abandonedEffects = (await sql.unsafe(
				`SELECT e.effect_id, e.command_id, e.agent_instance_id, e.execution_id, e.attempt_id, e.binding_id,
				 e.engine_generation, e.binding_generation, e.authority_generation, e.tool_call_id, e.tool_name,
				 e.policy, e.input_hash, e.effect_kind, e.state, e.outcome, a.approval_id, a.state AS approval_state
				 FROM engine_effects e LEFT JOIN engine_approvals a ON a.effect_id=e.effect_id
				 WHERE e.engine_generation < ? AND e.state IN ('planned', 'started')
				 ORDER BY e.created_at, e.effect_id`,
				[engineGeneration],
			)) as EngineRecoveryEffectRow[];
			const now = Date.now();
			await sql.unsafe(
				`UPDATE engine_effects SET state='unknown', outcome='unknown', error='engine_lost', settled_at=?, updated_at=?
				 WHERE engine_generation < ? AND state='started'`,
				[now, now, engineGeneration],
			);
			await sql.unsafe(
				`UPDATE engine_effects SET state='settled', outcome='cancelled', error='engine_lost', settled_at=?, updated_at=?
				 WHERE engine_generation < ? AND state='planned'`,
				[now, now, engineGeneration],
			);
			await sql.unsafe(
				`UPDATE engine_approvals SET state='resolved', decision='cancelled', reason='engine_lost',
				 resolved_at=?, updated_at=? WHERE state='pending' AND effect_id IN (
				 SELECT effect_id FROM engine_effects WHERE engine_generation < ?
				 )`,
				[now, now, engineGeneration],
			);
			await sql.unsafe(
				`UPDATE engine_attempts SET state='interrupted', cause='engine_lost',
				 retry_outcome=CASE WHEN retry_outcome='waiting' THEN 'interrupted' ELSE retry_outcome END,
				 updated_at=?
				 WHERE engine_generation < ? AND state IN ('accepted', 'running', 'pause_requested', 'paused', 'waiting_input', 'cancel_requested')`,
				[now, engineGeneration],
			);
			await sql.unsafe(
				`UPDATE engine_runtime_bindings SET state='released', updated_at=?
				 WHERE engine_generation < ? AND state <> 'released'`,
				[now, engineGeneration],
			);
			const events: EngineEvent[] = [];
			for (const effect of abandonedEffects) {
				const target = {
					commandId: effect.command_id,
					agentInstanceId: effect.agent_instance_id,
					executionId: effect.execution_id,
					attemptId: effect.attempt_id,
					engineGeneration,
					bindingId: effect.binding_id,
					bindingGeneration: Number(effect.binding_generation),
					authorityGeneration: Number(effect.authority_generation),
				};
				if (effect.state === "planned" && effect.approval_id && effect.approval_state === "pending") {
					events.push(
						await this.#appendTransitionEvent(sql, target, {
							kind: "tool_approval_resolved",
							payload: { approvalId: effect.approval_id, decision: "cancelled", reason: "engine_lost" },
						}),
					);
				}
				events.push(
					await this.#appendTransitionEvent(sql, target, {
						kind: effect.effect_kind === "model" ? "model_settled" : "tool_settled",
						payload: {
							...(effect.effect_kind === "model"
								? modelEffectPayload(effect.effect_id, effect.tool_call_id)
								: toolEffectPayload(effectInputFromRow(effect))),
							status: effect.state === "started" ? "unknown" : "cancelled",
							error: "engine_lost",
						},
					}),
				);
			}
			for (const attempt of active) {
				const transcriptCheckpoint =
					Number(attempt.transcript_revision) > 0 &&
					attempt.transcript_session_id &&
					attempt.transcript_path &&
					attempt.transcript_leaf_entry_id &&
					attempt.transcript_byte_boundary !== null
						? {
								sessionId: attempt.transcript_session_id,
								sessionPath: attempt.transcript_path,
								leafEntryId: attempt.transcript_leaf_entry_id,
								byteBoundary: Number(attempt.transcript_byte_boundary),
								revision: Number(attempt.transcript_revision),
							}
						: undefined;
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
							payload: {
								cause: "engine_lost",
								lostEngineGeneration: Number(attempt.engine_generation),
								...(transcriptCheckpoint ? { transcriptCheckpoint } : {}),
							},
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
		return rows.map(eventFromRow);
	}

	async pendingEventsForSink(sinkId: string, limit = 100): Promise<EngineEvent[]> {
		if (!sinkId.trim()) throw new Error("Event sink ID must be non-empty");
		const rows = (await this.#client.unsafe(
			`SELECT e.event_id, e.seq, e.causation_command_id, e.agent_instance_id, e.execution_id, e.attempt_id,
			 e.binding_id, e.engine_generation, e.binding_generation, e.authority_generation, e.kind, e.payload, e.created_at
			 FROM engine_event_outbox e
			 LEFT JOIN engine_event_deliveries d ON d.event_id=e.event_id AND d.sink_id=?
			 WHERE d.event_id IS NULL OR d.state='pending'
			 ORDER BY e.event_id LIMIT ?`,
			[sinkId, Math.max(1, Math.min(1000, Math.floor(limit)))],
		)) as EventRow[];
		return rows.map(eventFromRow);
	}

	async markEventDeliveryFailed(eventId: number, sinkId: string, error: string): Promise<void> {
		if (!sinkId.trim()) throw new Error("Event sink ID must be non-empty");
		await this.#transaction(sql =>
			sql.unsafe(
				`INSERT INTO engine_event_deliveries(event_id, sink_id, state, attempts, last_error, updated_at)
			 VALUES (?, ?, 'pending', 1, ?, ?)
			 ON CONFLICT(event_id, sink_id) DO UPDATE SET attempts=attempts+1,
			 last_error=excluded.last_error, updated_at=excluded.updated_at
			 WHERE engine_event_deliveries.state='pending'`,
				[eventId, sinkId, error.slice(0, 2_048), Date.now()],
			),
		);
	}

	async markEventDelivered(eventId: number, sinkId: string): Promise<void> {
		if (!sinkId.trim()) throw new Error("Event sink ID must be non-empty");
		const now = Date.now();
		await this.#transaction(sql =>
			sql.unsafe(
				`INSERT INTO engine_event_deliveries(event_id, sink_id, state, attempts, delivered_at, updated_at)
			 VALUES (?, ?, 'delivered', 1, ?, ?)
			 ON CONFLICT(event_id, sink_id) DO UPDATE SET state='delivered', attempts=attempts+1,
			 last_error=NULL, delivered_at=excluded.delivered_at, updated_at=excluded.updated_at`,
				[eventId, sinkId, now, now],
			),
		);
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

	#inboxSelect(): string {
		return `SELECT i.queue_id, i.session_id, i.agent_instance_id, i.execution_id, i.attempt_id,
		 i.binding_id, i.engine_generation, i.binding_generation, i.authority_generation,
		 i.source_event_id, s.source_type, s.sender, s.body AS source_body,
		 i.delivery_payload, i.annotation, i.deliver_at, i.wake_intent, i.wake_delivered_at, i.position,
		 i.disposition, i.revision, i.created_at, i.updated_at
		 FROM engine_inbox_items i JOIN engine_inbox_sources s ON s.source_event_id=i.source_event_id`;
	}

	async #inboxItem(sql: SqlClient, sessionId: string, queueId: string): Promise<InboxItemRow | undefined> {
		const rows = (await sql.unsafe(`${this.#inboxSelect()} WHERE i.session_id=? AND i.queue_id=?`, [
			sessionId,
			queueId,
		])) as InboxItemRow[];
		return rows[0];
	}

	async #mutateInboxItem(
		sql: SqlClient,
		target: EngineInboxTarget,
		mutation: EngineInboxMutation,
	): Promise<{ item: EngineInboxItem; event?: EngineEvent }> {
		const row = await this.#inboxItem(sql, target.sessionId, mutation.queueId);
		if (!row) throw new EngineInboxConflictError(`Inbox item ${mutation.queueId} does not exist`);
		this.#assertInboxTarget(row, target);
		const item = inboxItemFromRow(row);
		const desired = this.#applyInboxMutation(item, mutation);
		if (desired === item) return { item };
		if (item.disposition !== "pending") {
			throw new EngineInboxConflictError(`Inbox item ${mutation.queueId} is already ${item.disposition}`);
		}
		if (mutation.expectedRevision !== item.revision) {
			throw new EngineInboxConflictError(
				`Inbox item ${mutation.queueId} revision ${item.revision} does not match ${mutation.expectedRevision}`,
			);
		}
		const revision = item.revision + 1;
		const now = Date.now();
		await sql.unsafe(
			`UPDATE engine_inbox_items SET delivery_payload=?, annotation=?, deliver_at=?, wake_intent=?, disposition=?, revision=?, updated_at=?
			 WHERE queue_id=?`,
			[
				desired.deliveryPayload,
				desired.annotation ?? null,
				desired.deliverAt ?? null,
				desired.wakeIntent ? 1 : 0,
				desired.disposition,
				revision,
				now,
				mutation.queueId,
			],
		);
		const event = await this.#appendInboxEvent(
			sql,
			target,
			mutation.mutationId,
			mutation.op,
			revision,
			mutation.queueId,
		);
		return { item: { ...desired, revision, updatedAt: now }, event };
	}

	#assertInboxTarget(row: InboxItemRow, target: EngineInboxTarget): void {
		if (
			row.session_id !== target.sessionId ||
			row.agent_instance_id !== target.agentInstanceId ||
			row.execution_id !== target.executionId ||
			row.attempt_id !== target.attemptId ||
			row.binding_id !== target.bindingId ||
			Number(row.engine_generation) !== target.engineGeneration ||
			Number(row.binding_generation) !== target.bindingGeneration ||
			Number(row.authority_generation) !== target.authorityGeneration
		) {
			throw new EngineInboxConflictError(`Inbox item ${row.queue_id} belongs to another fenced session`);
		}
	}

	#applyInboxMutation(item: EngineInboxItem, mutation: EngineInboxMutation): EngineInboxItem {
		switch (mutation.op) {
			case "edit": {
				if (typeof mutation.value !== "string" || !mutation.value.trim()) {
					throw new EngineInboxConflictError("Inbox delivery payload must be a non-empty string");
				}
				return mutation.value === item.deliveryPayload ? item : { ...item, deliveryPayload: mutation.value };
			}
			case "annotate": {
				if (mutation.value !== null && typeof mutation.value !== "string") {
					throw new EngineInboxConflictError("Inbox annotation must be a string or null");
				}
				const annotation = mutation.value?.trim() || undefined;
				return annotation === item.annotation ? item : { ...item, annotation };
			}
			case "defer": {
				if (
					mutation.value !== null &&
					(typeof mutation.value !== "number" || !Number.isSafeInteger(mutation.value) || mutation.value < 0)
				) {
					throw new EngineInboxConflictError("Inbox deliverAt must be a non-negative safe integer or null");
				}
				const deliverAt = mutation.value ?? undefined;
				return deliverAt === item.deliverAt && item.wakeIntent ? item : { ...item, deliverAt, wakeIntent: true };
			}
			case "acknowledge":
				if (item.disposition === "acknowledged") return item;
				if (item.disposition !== "pending") {
					throw new EngineInboxConflictError(`Inbox item ${item.queueId} is already ${item.disposition}`);
				}
				return { ...item, disposition: "acknowledged" };
			case "drop":
				if (item.disposition === "dropped") return item;
				if (item.disposition !== "pending") {
					throw new EngineInboxConflictError(`Inbox item ${item.queueId} is already ${item.disposition}`);
				}
				return { ...item, disposition: "dropped" };
		}
	}

	#appendInboxEvent(
		sql: SqlClient,
		target: EngineInboxTarget,
		causationCommandId: string,
		action: string,
		revision: number,
		queueId = causationCommandId,
	): Promise<EngineEvent> {
		return this.#appendEvent(sql, {
			agentInstanceId: target.agentInstanceId,
			executionId: target.executionId,
			attemptId: target.attemptId,
			bindingId: target.bindingId,
			engineGeneration: target.engineGeneration,
			bindingGeneration: target.bindingGeneration,
			authorityGeneration: target.authorityGeneration,
			causationCommandId,
			kind: "inbox_changed",
			payload: { action, queueId, revision },
		});
	}

	async #insertToolEffect(
		sql: SqlClient,
		target: EngineEventTarget,
		effect: EngineToolEffectInput,
		state: "planned" | "started",
	): Promise<void> {
		const now = Date.now();
		await sql.unsafe(
			`INSERT INTO engine_effects(
			 effect_id, command_id, agent_instance_id, execution_id, attempt_id, binding_id,
			 engine_generation, binding_generation, authority_generation, tool_call_id, tool_name,
			 policy, input_hash, state, created_at, started_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				effect.effectId,
				target.commandId,
				target.agentInstanceId,
				target.executionId,
				target.attemptId,
				target.bindingId,
				target.engineGeneration,
				target.bindingGeneration,
				target.authorityGeneration,
				effect.toolCallId,
				effect.toolName,
				effect.policy,
				effect.inputHash,
				state,
				now,
				state === "started" ? now : null,
				now,
			],
		);
	}

	async #putBinding(sql: SqlClient, binding: EngineBindingSnapshot): Promise<void> {
		await sql.unsafe(
			`INSERT INTO engine_runtime_bindings(
			 binding_id, command_id, agent_instance_id, execution_id, attempt_id, engine_agent_id, session_file,
			 profile_digest, state, engine_generation, binding_generation, authority_generation,
			 manual_hold, intent_revision, intent_command_id, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(agent_instance_id) DO UPDATE SET
			 binding_id=excluded.binding_id, command_id=excluded.command_id,
			 execution_id=excluded.execution_id, attempt_id=excluded.attempt_id,
			 engine_agent_id=excluded.engine_agent_id, session_file=excluded.session_file,
			 profile_digest=excluded.profile_digest, state=excluded.state,
			 engine_generation=excluded.engine_generation, binding_generation=excluded.binding_generation,
				 authority_generation=excluded.authority_generation,
				 manual_hold=excluded.manual_hold, intent_revision=excluded.intent_revision,
				 intent_command_id=excluded.intent_command_id,
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
				binding.manualHold ? 1 : 0,
				binding.intentRevision ?? 0,
				binding.intentCommandId ?? null,
				Date.now(),
			],
		);
	}

	async #putAttempt(
		sql: SqlClient,
		binding: EngineBindingSnapshot,
		state: EngineAttemptState,
		cause?: string,
		checkpoint?: EngineTranscriptCheckpoint,
	): Promise<boolean> {
		const rows = (await sql.unsafe(
			`INSERT INTO engine_attempts(
			 attempt_id, command_id, agent_instance_id, execution_id, binding_id, engine_generation,
			 binding_generation, authority_generation, state, cause, updated_at,
			 transcript_session_id, transcript_path, transcript_leaf_entry_id, transcript_byte_boundary, transcript_revision
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(attempt_id) DO UPDATE SET state=excluded.state, cause=excluded.cause,
			 updated_at=excluded.updated_at,
			 retry_outcome=CASE
				WHEN engine_attempts.retry_outcome='waiting' AND excluded.state='completed' THEN 'succeeded'
				WHEN engine_attempts.retry_outcome='waiting' AND excluded.state='cancelled' THEN 'cancelled'
				WHEN engine_attempts.retry_outcome='waiting' AND excluded.state='interrupted' THEN 'interrupted'
				WHEN engine_attempts.retry_outcome='waiting' AND excluded.state='failed' THEN 'failed'
				ELSE engine_attempts.retry_outcome END,
			 transcript_session_id=COALESCE(excluded.transcript_session_id, engine_attempts.transcript_session_id),
			 transcript_path=COALESCE(excluded.transcript_path, engine_attempts.transcript_path),
			 transcript_leaf_entry_id=COALESCE(excluded.transcript_leaf_entry_id, engine_attempts.transcript_leaf_entry_id),
			 transcript_byte_boundary=COALESCE(excluded.transcript_byte_boundary, engine_attempts.transcript_byte_boundary),
			 transcript_revision=CASE WHEN excluded.transcript_revision > 0
				THEN excluded.transcript_revision ELSE engine_attempts.transcript_revision END
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
				checkpoint?.sessionId ?? null,
				checkpoint?.sessionPath ?? null,
				checkpoint?.leafEntryId ?? null,
				checkpoint?.byteBoundary ?? null,
				checkpoint?.revision ?? 0,
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
