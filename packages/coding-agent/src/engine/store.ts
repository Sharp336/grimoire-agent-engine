import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SQL } from "bun";
import type { SessionDurabilityCheckpoint } from "../session/session-manager";
import { SqlSessionStorage } from "../session/sql-session-storage";
import type { EngineAttemptState, EngineBindingSnapshot, EngineEvent, EngineToolPolicy } from "./contracts";

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
	transcript_session_id: string | null;
	transcript_path: string | null;
	transcript_leaf_entry_id: string | null;
	transcript_byte_boundary: number | null;
	transcript_revision: number;
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

const SCHEMA_MIGRATIONS = [
	{ version: 1, statements: SCHEMA, requiredColumns: [] },
	{ version: 2, statements: [], requiredColumns: REQUIRED_COLUMNS },
	{ version: 3, statements: COMMAND_INBOX_SCHEMA, requiredColumns: [] },
	{ version: 4, statements: [], requiredColumns: TRANSCRIPT_CHECKPOINT_COLUMNS },
	{ version: 5, statements: EFFECT_APPROVAL_SCHEMA, requiredColumns: [] },
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
			transcriptCheckpoint?: SessionDurabilityCheckpoint;
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
			const committed: EngineEvent[] = [];
			for (const event of events) {
				committed.push(
					await this.#appendTransitionEvent(sql, binding, {
						...event,
						...(transcriptCheckpoint ? { payload: { ...event.payload, transcriptCheckpoint } } : {}),
					}),
				);
			}
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

	async startToolEffect(target: EngineEventTarget, effect: EngineToolEffectInput): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			await this.#insertToolEffect(sql, target, effect, "started");
			return await this.#appendTransitionEvent(sql, target, {
				kind: "tool_started",
				payload: toolEffectPayload(effect),
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
				 e.policy, e.input_hash, e.state, e.outcome, a.state AS approval_state, a.decision
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
				 policy, input_hash, state, outcome`,
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

	async getEffect(effectId: string): Promise<EngineEffectRow | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT effect_id, agent_instance_id, execution_id, attempt_id, binding_id, engine_generation,
			 binding_generation, authority_generation, tool_call_id, tool_name, policy, input_hash, state, outcome
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

	async getAttempt(attemptId: string): Promise<EngineAttemptRow | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT agent_instance_id, execution_id, attempt_id, command_id, binding_id, engine_generation, binding_generation,
			 authority_generation, state, transcript_session_id, transcript_path, transcript_leaf_entry_id,
			 transcript_byte_boundary, transcript_revision
			 FROM engine_attempts WHERE attempt_id = ?`,
			[attemptId],
		)) as EngineAttemptRow[];
		return rows[0];
	}

	async interruptGeneration(engineGeneration: number): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			const active = (await sql.unsafe(
				`SELECT agent_instance_id, execution_id, attempt_id, command_id, binding_id, engine_generation, binding_generation,
				 authority_generation, state, transcript_session_id, transcript_path, transcript_leaf_entry_id,
				 transcript_byte_boundary, transcript_revision
				 FROM engine_attempts
				 WHERE engine_generation < ? AND state IN ('accepted', 'running', 'pause_requested', 'paused', 'waiting_input', 'cancel_requested')`,
				[engineGeneration],
			)) as EngineAttemptRow[];
			const abandonedEffects = (await sql.unsafe(
				`SELECT e.effect_id, e.command_id, e.agent_instance_id, e.execution_id, e.attempt_id, e.binding_id,
				 e.engine_generation, e.binding_generation, e.authority_generation, e.tool_call_id, e.tool_name,
				 e.policy, e.input_hash, e.state, e.outcome, a.approval_id, a.state AS approval_state
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
						kind: "tool_settled",
						payload: {
							...toolEffectPayload(effectInputFromRow(effect)),
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
