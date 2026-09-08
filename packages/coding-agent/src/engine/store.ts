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
	EngineTarget,
	EngineToolPolicy,
} from "./contracts";
import { EngineTargetError } from "./contracts";
import { engineAgentId } from "./route";
import { ENGINE_HISTORY_INDEX_SCHEMA, type EngineNativeHistoryPage } from "./runtime-history";
import { RUNTIME_MESSAGE_SCHEMA } from "./runtime-messages";
import {
	claimLegacyOwnership,
	type LegacyOwnershipCandidate,
	type LegacyOwnershipProof,
	legacyOwnershipPage,
	ownershipProofMatches,
	RUNTIME_OWNERSHIP_SCHEMA,
} from "./runtime-ownership";
import {
	RUNTIME_PROJECTION_SCHEMA,
	type RuntimeTargetRequest,
	recordRuntimeProjection,
	runtimeNativeTarget,
} from "./runtime-projection";
import {
	ENGINE_CONTROL_OPS,
	type RuntimeAccess,
	type RuntimeEventBatch,
	type RuntimeEventsRequest,
	type RuntimeScope,
	type RuntimeWork,
	runtimeLimits,
} from "./runtime-protocol";
import { RUNTIME_QUEUE_SCHEMA, type RuntimeQueueRequest, readRuntimeQueue } from "./runtime-queue";
import { type RuntimeSnapshot, readRuntimeEvents, readRuntimeSnapshot, readRuntimeSummary } from "./runtime-read";
import { canonicalRuntimeReceipt, readRuntimeReceipt } from "./runtime-receipts";
import {
	type RuntimePageRequest,
	type RuntimeResourceRequest,
	readRuntimeHolds,
	readRuntimeInput,
	readRuntimeMessages,
	readRuntimeResource,
} from "./runtime-resources";
import {
	cancelIntentRevision,
	type EnginePendingStartTarget,
	readTargetStart,
	START_FENCE_SCHEMA,
	startCancellation,
	validateStartFence,
	writeStartCancellation,
} from "./start-fence";

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

export interface RetainedDirectChildHistory {
	agentInstanceId: string;
	agentInstanceRef: string;
	engineAgentId: string;
	sessionFile: string;
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
	parentAgentInstanceRef?: string;
	bindingId?: string;
	bindingGeneration?: number;
	executionId?: string;
	attemptId?: string;
	authorityGeneration: number;
	payloadHash: string;
	canonicalHash: string;
	principalId?: string;
	browserPayloadHash?: string;
	serializedCommand?: string;
}

export interface EngineBranchHold {
	sourceAgentInstanceId: string;
	sourceAgentInstanceRef: string;
	commandId: string;
	generation: number;
	kind: "pause" | "stop" | "recovery";
}

export interface EngineRuntimeSnapshot {
	version: "1.0";
	scope: RuntimeScope;
	epoch: string;
	generation: number;
	watermark: number;
	agents: Record<string, unknown>[];
	nextCursor: string | null;
}

export interface EngineRuntimeEvents {
	epoch: string;
	generation: number;
	throughCursor: number;
	events: EngineEvent[];
	resyncRequired: boolean;
	reason?: "epoch_changed" | "retention_gap" | "projection_changed";
	hasMore: boolean;
}

export type EngineStartConversationIdentity = Pick<
	EngineCommandIdentity,
	"operation" | "agentInstanceId" | "agentInstanceRef" | "parentAgentInstanceId" | "authorityGeneration"
>;

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

const CONVERSATION_IDENTITY_COLUMNS = [["engine_runtime_bindings", "conversation_identity_digest", "TEXT"]] as const;

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
	{ version: 11, statements: [], requiredColumns: CONVERSATION_IDENTITY_COLUMNS },
	{
		version: 12,
		statements: [
			...ENGINE_HISTORY_INDEX_SCHEMA,
			`CREATE TABLE engine_agent_identity (
			 agent_instance_id TEXT PRIMARY KEY, agent_instance_ref TEXT NOT NULL DEFAULT '',
			 parent_agent_instance_id TEXT, parent_agent_instance_ref TEXT, principal_id TEXT NOT NULL DEFAULT '',
			 authority_generation INTEGER NOT NULL DEFAULT 0, intent_revision INTEGER NOT NULL DEFAULT 0,
			 queue_revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
			`CREATE INDEX engine_agent_parent_idx ON engine_agent_identity(parent_agent_instance_id)`,
			`CREATE INDEX engine_agent_principal_idx ON engine_agent_identity(principal_id, agent_instance_id)`,
			`CREATE TABLE engine_branch_holds (
			 source_agent_instance_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('pause','stop','recovery')),
			 command_id TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL,
			 PRIMARY KEY(source_agent_instance_id, kind))`,
			`CREATE INDEX engine_outbox_agent_idx ON engine_event_outbox(agent_instance_id,event_id)`,
			`CREATE INDEX engine_outbox_attempt_idx ON engine_event_outbox(attempt_id,event_id)`,
			`INSERT INTO engine_agent_identity(agent_instance_id,agent_instance_ref,parent_agent_instance_id,authority_generation,intent_revision,created_at,updated_at)
			 SELECT b.agent_instance_id,COALESCE(c.agent_instance_ref,''),c.parent_agent_instance_id,b.authority_generation,b.intent_revision,b.updated_at,b.updated_at
			 FROM engine_runtime_bindings b LEFT JOIN engine_commands c ON c.command_id=b.command_id`,
			`INSERT OR IGNORE INTO engine_agent_identity(agent_instance_id,agent_instance_ref,parent_agent_instance_id,authority_generation,created_at,updated_at)
			 SELECT agent_instance_id,COALESCE(agent_instance_ref,''),parent_agent_instance_id,authority_generation,received_at,updated_at FROM engine_commands ORDER BY received_at`,
			`INSERT INTO engine_branch_holds(source_agent_instance_id,kind,command_id,generation,created_at)
			 SELECT agent_instance_id,'pause',COALESCE(intent_command_id,command_id),intent_revision,updated_at FROM engine_runtime_bindings WHERE manual_hold=1`,
		],
		requiredColumns: [
			["engine_commands", "principal_id", "TEXT NOT NULL DEFAULT ''"],
			["engine_attempts", "result_payload", "TEXT"],
			["engine_commands", "browser_payload_hash", "TEXT"],
			["engine_commands", "payload_bytes", "INTEGER NOT NULL DEFAULT 0"],
			["engine_commands", "serialized_command", "TEXT"],
		] as const,
	},
	{ version: 13, statements: RUNTIME_PROJECTION_SCHEMA, requiredColumns: [] },
	{ version: 14, statements: RUNTIME_MESSAGE_SCHEMA, requiredColumns: [] },
	{ version: 15, statements: START_FENCE_SCHEMA, requiredColumns: [] },
	{ version: 16, statements: RUNTIME_OWNERSHIP_SCHEMA, requiredColumns: [] },
	{ version: 17, statements: RUNTIME_QUEUE_SCHEMA, requiredColumns: [] },
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

function assertSchemaHistory(applied: MigrationRow[]): void {
	if (applied.some(row => Number(row.version) > CURRENT_SCHEMA_VERSION))
		throw new Error(`Engine database schema is newer than this binary (max ${CURRENT_SCHEMA_VERSION})`);
	for (const [index, row] of applied.entries()) {
		const migration = SCHEMA_MIGRATIONS[index];
		if (!migration || Number(row.version) !== migration.version)
			throw new Error("Engine database migration history is not a contiguous supported prefix");
		if (row.checksum !== migrationChecksum(migration))
			throw new Error(`Engine database migration ${migration.version} checksum does not match this binary`);
	}
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
		assertSchemaHistory(applied);
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
	#change = Promise.withResolvers<void>();
	#summaryChange = Promise.withResolvers<void>();
	#summaryRevision = 0;
	#closed = false;
	#changeRevision = 0;

	changeSignal(): Promise<void> {
		return this.#change.promise;
	}

	async registerAgent(
		identity: Pick<
			EngineCommandIdentity,
			| "agentInstanceId"
			| "agentInstanceRef"
			| "parentAgentInstanceId"
			| "parentAgentInstanceRef"
			| "principalId"
			| "authorityGeneration"
		>,
	): Promise<void> {
		await this.#transaction(sql => this.#registerAgent(sql, identity));
	}

	async runtimeTarget(request: RuntimeTargetRequest): Promise<Record<string, unknown>> {
		return await this.#transaction(sql => runtimeNativeTarget(sql, request));
	}

	async reconcileLegacyOwnershipPage(deviceId: string, engineId: string, after?: string) {
		return await this.#transaction(async sql => {
			const page = await legacyOwnershipPage(sql, deviceId, engineId, after);
			let inherited = 0;
			for (const row of page.inherited) {
				const outcome = await claimLegacyOwnership(sql, row.agentInstanceId, row.agentInstanceRef, row.principalId);
				if (outcome !== "enrolled") continue;
				await this.#identityEvent(
					sql,
					row.agentInstanceId,
					`ownership:${row.agentInstanceId}`,
					"agent_registered",
					{},
				);
				inherited++;
			}
			return { candidates: page.candidates, unresolved: page.unresolved, inherited, nextCursor: page.nextCursor };
		});
	}

	async recordOwnershipMigration(status: "complete" | "incomplete" | "unavailable", unresolved: number | null) {
		await this.#transaction(async sql => {
			await sql.unsafe(
				"INSERT INTO engine_metadata(key,value) VALUES ('ownership_migration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
				[JSON.stringify({ status, unresolved, checkedAt: Date.now() })],
			);
		});
	}

	async ownershipMigrationStatus(): Promise<Record<string, unknown>> {
		const missing = await this.#client.unsafe("SELECT 1 FROM engine_agent_identity WHERE principal_id='' LIMIT 1");
		if (!missing.length) return { status: "complete", unresolved: 0 };
		const rows = (await this.#client.unsafe(
			"SELECT value FROM engine_metadata WHERE key='ownership_migration'",
		)) as MetadataRow[];
		const current = rows[0] ? (JSON.parse(rows[0].value) as Record<string, unknown>) : undefined;
		return current?.status !== "complete" && current ? current : { status: "pending", unresolved: null };
	}

	async enrollLegacyOwnership(candidates: LegacyOwnershipCandidate[], proofs: LegacyOwnershipProof[]) {
		if (
			candidates.length > runtimeLimits.httpPageRecords ||
			proofs.length !== candidates.length ||
			new Set(candidates.map(candidate => candidate.agentInstanceRef)).size !== candidates.length ||
			proofs.some(
				(proof, index) =>
					proof.agentInstanceRef !== candidates[index].agentInstanceRef ||
					!ownershipProofMatches(candidates[index], proof) ||
					!["verified", "missing", "conflict", "deferred"].includes(proof.status) ||
					(proof.status === "verified" && (typeof proof.principalId !== "string" || !proof.principalId.trim())),
			)
		)
			throw new EngineTargetError(
				"invalid_request",
				"Legacy ownership proofs do not match the exact requested page",
			);
		return await this.#transaction(async sql => {
			const results: Array<{ agentInstanceRef: string; status: string }> = [];
			for (const [index, proof] of proofs.entries()) {
				const candidate = candidates[index];
				const outcome =
					proof.status === "verified"
						? await claimLegacyOwnership(
								sql,
								candidate.agentInstanceId,
								candidate.agentInstanceRef,
								proof.principalId!,
								candidate,
							)
						: proof.status;
				if (outcome === "enrolled")
					await this.#identityEvent(
						sql,
						candidate.agentInstanceId,
						`ownership:${candidate.kind === "canonical_agi" ? candidate.agentInstanceId : candidate.sourceCommandId}`,
						"agent_registered",
						{ ownershipProof: { ...candidate, kind: proof.proofSource ?? "retained_job" } },
					);
				results.push({ agentInstanceRef: candidate.agentInstanceRef, status: outcome });
			}
			return results;
		});
	}

	async nativeSessionHeader(target: EngineTarget): Promise<{ sessionId: string; cwd: string | null }> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`SELECT COALESCE(a.transcript_path,b.session_file) AS session_path FROM engine_attempts a
				LEFT JOIN engine_runtime_bindings b ON b.attempt_id=a.attempt_id WHERE a.agent_instance_id=? AND a.attempt_id=? AND a.execution_id=?
				AND a.binding_id=? AND a.binding_generation=? AND a.engine_generation=? AND a.authority_generation=?`,
				[
					target.agentInstanceId,
					target.attemptId,
					target.executionId,
					target.bindingId,
					target.bindingGeneration,
					target.engineGeneration,
					target.authorityGeneration,
				],
			)) as Array<{ session_path: string | null }>;
			if (!rows[0]?.session_path)
				throw new EngineTargetError("stale_target", "Exact native session path is not retained");
			const headers = (await sql.unsafe(
				"SELECT entry_id,json_extract(entry_json,'$.cwd') AS cwd FROM engine_history_entries WHERE session_path=? AND entry_type='session' ORDER BY ordinal LIMIT 1",
				[rows[0].session_path],
			)) as Array<{ entry_id: string; cwd: string | null }>;
			if (!headers[0]) throw new EngineTargetError("history_expired", "Native session header is not retained");
			return { sessionId: headers[0].entry_id, cwd: headers[0].cwd };
		});
	}

	async runtimeSummary(request: RuntimeAccess & { agentInstanceRef: string }): Promise<Record<string, unknown>> {
		return await this.#transaction(sql => readRuntimeSummary(sql, request));
	}

	async runtimeInput(request: RuntimePageRequest): Promise<Record<string, unknown>> {
		return await this.#transaction(sql => readRuntimeInput(sql, request));
	}
	async runtimeHolds(request: RuntimePageRequest): Promise<Record<string, unknown>> {
		return await this.#transaction(sql => readRuntimeHolds(sql, request));
	}
	async runtimeResource(request: RuntimeResourceRequest): Promise<Record<string, unknown>> {
		return await this.#transaction(sql => readRuntimeResource(sql, request));
	}
	async runtimeMessages(request: RuntimePageRequest): Promise<Record<string, unknown>> {
		return await this.#transaction(sql => readRuntimeMessages(sql, request));
	}

	async intent(
		agentInstanceId: string,
	): Promise<{ intentRevision: number; manualHold: boolean; holds: EngineBranchHold[] }> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe("SELECT intent_revision FROM engine_agent_identity WHERE agent_instance_id=?", [
				agentInstanceId,
			])) as Array<{ intent_revision: number }>;
			const holds = await this.#effectiveHolds(sql, agentInstanceId);
			return { intentRevision: Number(rows[0]?.intent_revision ?? 0), manualHold: holds.length > 0, holds };
		});
	}

	async assertIntent(agentInstanceId: string, expectedRevision?: number, unheld = false): Promise<void> {
		await this.#transaction(sql => this.#assertIntent(sql, agentInstanceId, expectedRevision, unheld));
	}

	async branchIntent(
		agentInstanceId: string,
		commandId: string,
		action: "pause" | "resume" | "stop" | "continue",
		expectedRevision?: number,
		startFence?: EnginePendingStartTarget,
	): Promise<{ agentIds: string[]; events: EngineEvent[]; intentRevision: number }> {
		return await this.#transaction(async sql => {
			if (startFence) {
				if (action !== "stop" || !(await readTargetStart(sql, startFence)))
					throw new EngineTargetError("stale_target", "Cancellation requires its exact admitted Start");
				expectedRevision = await cancelIntentRevision(sql, startFence);
			}
			return await this.#branchIntent(sql, agentInstanceId, commandId, action, expectedRevision);
		});
	}

	async #branchIntent(
		sql: SqlClient,
		agentInstanceId: string,
		commandId: string,
		action: "pause" | "resume" | "stop" | "continue",
		expectedRevision?: number,
	): Promise<{ agentIds: string[]; events: EngineEvent[]; intentRevision: number }> {
		await this.#assertIntent(sql, agentInstanceId, expectedRevision);
		const rows = (await sql.unsafe("SELECT intent_revision FROM engine_agent_identity WHERE agent_instance_id=?", [
			agentInstanceId,
		])) as Array<{ intent_revision: number }>;
		if (!rows[0]) throw new EngineTargetError("agent_not_found", "Unknown branch root");
		const revision = Number(rows[0].intent_revision) + 1;
		if (action === "resume" || action === "continue") {
			await sql.unsafe(
				`DELETE FROM engine_branch_holds WHERE source_agent_instance_id=? AND ${action === "resume" ? "kind='pause'" : "kind IN ('pause','stop','recovery')"}`,
				[agentInstanceId],
			);
		} else {
			await sql.unsafe(
				`INSERT INTO engine_branch_holds(source_agent_instance_id,kind,command_id,generation,created_at) VALUES (?,?,?,?,?) ON CONFLICT(source_agent_instance_id,kind) DO UPDATE SET command_id=excluded.command_id,generation=excluded.generation,created_at=excluded.created_at`,
				[agentInstanceId, action === "stop" ? "stop" : "pause", commandId, revision, Date.now()],
			);
		}
		const descendants = (await sql.unsafe(
			`WITH RECURSIVE branch(id) AS (SELECT ? UNION SELECT i.agent_instance_id FROM engine_agent_identity i JOIN branch b ON i.parent_agent_instance_id=b.id) SELECT id FROM branch ORDER BY id`,
			[agentInstanceId],
		)) as Array<{ id: string }>;
		const events: EngineEvent[] = [];
		for (const { id } of descendants) {
			const holds = await this.#effectiveHolds(sql, id);
			await sql.unsafe(
				"UPDATE engine_agent_identity SET intent_revision=intent_revision+1,updated_at=? WHERE agent_instance_id=?",
				[Date.now(), id],
			);
			await sql.unsafe(
				"UPDATE engine_runtime_bindings SET manual_hold=?,intent_revision=(SELECT intent_revision FROM engine_agent_identity WHERE agent_instance_id=?),intent_command_id=?,updated_at=? WHERE agent_instance_id=?",
				[holds.length > 0 ? 1 : 0, id, commandId, Date.now(), id],
			);
			events.push(
				await this.#identityEvent(sql, id, commandId, "holds_changed", {
					action,
					sourceAgentInstanceId: agentInstanceId,
					holds,
				}),
			);
		}
		return { agentIds: descendants.map(row => row.id), events, intentRevision: revision };
	}

	async #assertIntent(
		sql: SqlClient,
		agentInstanceId: string,
		expectedRevision?: number,
		unheld = false,
	): Promise<void> {
		const rows = (await sql.unsafe("SELECT intent_revision FROM engine_agent_identity WHERE agent_instance_id=?", [
			agentInstanceId,
		])) as Array<{ intent_revision: number }>;
		if (expectedRevision !== undefined && Number(rows[0]?.intent_revision ?? 0) !== expectedRevision)
			throw new EngineTargetError("stale_target", "AgentInstance intent revision changed");
		if (unheld && (await this.#effectiveHolds(sql, agentInstanceId)).length > 0)
			throw new EngineTargetError("agent_busy", "AgentInstance branch is held");
	}

	async #registerAgent(
		sql: SqlClient,
		identity: Pick<
			EngineCommandIdentity,
			| "agentInstanceId"
			| "agentInstanceRef"
			| "parentAgentInstanceId"
			| "parentAgentInstanceRef"
			| "principalId"
			| "authorityGeneration"
		>,
	): Promise<void> {
		if (identity.agentInstanceRef) {
			const aliases = await sql.unsafe(
				"SELECT agent_instance_id FROM engine_agent_identity WHERE agent_instance_ref=? AND agent_instance_id<>? LIMIT 1",
				[identity.agentInstanceRef, identity.agentInstanceId],
			);
			if (aliases.length)
				throw new EngineTargetError(
					"stale_target",
					"Canonical AgentInstance already has a different native identity",
				);
		}
		if (identity.parentAgentInstanceId) {
			const parents = (await sql.unsafe("SELECT principal_id FROM engine_agent_identity WHERE agent_instance_id=?", [
				identity.parentAgentInstanceId,
			])) as Array<{ principal_id: string }>;
			if (parents[0]?.principal_id) {
				if (identity.principalId && identity.principalId !== parents[0].principal_id)
					throw new EngineTargetError("stale_target", "Child ownership must match its canonical parent");
				identity = { ...identity, principalId: parents[0].principal_id };
			}
		}
		if (identity.parentAgentInstanceId === identity.agentInstanceId)
			throw new EngineTargetError("invalid_request", "AgentInstance cannot be its own parent");
		const rows = (await sql.unsafe(
			"SELECT agent_instance_ref,parent_agent_instance_id,principal_id,membership_revision FROM engine_agent_identity WHERE agent_instance_id=?",
			[identity.agentInstanceId],
		)) as Array<{
			agent_instance_ref: string;
			parent_agent_instance_id: string | null;
			principal_id: string;
			membership_revision: number;
		}>;
		const existing = rows[0];
		if (existing && !existing.principal_id && identity.principalId)
			throw new EngineTargetError("stale_target", "Legacy ownership requires a verified source proof");
		if (
			existing &&
			((identity.agentInstanceRef &&
				existing.agent_instance_ref &&
				identity.agentInstanceRef !== existing.agent_instance_ref) ||
				(identity.parentAgentInstanceId &&
					(existing.parent_agent_instance_id || existing.membership_revision) &&
					identity.parentAgentInstanceId !== existing.parent_agent_instance_id) ||
				(identity.principalId && existing.principal_id && identity.principalId !== existing.principal_id))
		)
			throw new EngineTargetError("stale_target", "AgentInstance identity is immutable");
		if (identity.parentAgentInstanceId) {
			const parents = (await sql.unsafe(
				`WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT i.parent_agent_instance_id FROM engine_agent_identity i JOIN ancestors a ON i.agent_instance_id=a.id WHERE i.parent_agent_instance_id IS NOT NULL) SELECT id FROM ancestors WHERE id=?`,
				[identity.parentAgentInstanceId, identity.agentInstanceId],
			)) as Array<{ id: string }>;
			if (parents.length) throw new EngineTargetError("invalid_request", "AgentInstance ancestry cycle");
		}
		await sql.unsafe(
			`INSERT INTO engine_agent_identity(agent_instance_id,agent_instance_ref,parent_agent_instance_id,parent_agent_instance_ref,principal_id,authority_generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(agent_instance_id) DO UPDATE SET agent_instance_ref=CASE WHEN engine_agent_identity.agent_instance_ref='' THEN excluded.agent_instance_ref ELSE engine_agent_identity.agent_instance_ref END,parent_agent_instance_id=COALESCE(engine_agent_identity.parent_agent_instance_id,excluded.parent_agent_instance_id),parent_agent_instance_ref=COALESCE(engine_agent_identity.parent_agent_instance_ref,excluded.parent_agent_instance_ref),principal_id=CASE WHEN engine_agent_identity.principal_id='' THEN excluded.principal_id ELSE engine_agent_identity.principal_id END,authority_generation=MAX(engine_agent_identity.authority_generation,excluded.authority_generation),updated_at=excluded.updated_at`,
			[
				identity.agentInstanceId,
				identity.agentInstanceRef ?? "",
				identity.parentAgentInstanceId ?? null,
				identity.parentAgentInstanceRef ?? null,
				identity.principalId ?? "",
				identity.authorityGeneration,
				Date.now(),
				Date.now(),
			],
		);
		if (!existing && identity.agentInstanceRef)
			await this.#identityEvent(
				sql,
				identity.agentInstanceId,
				"register:" + identity.agentInstanceId,
				"agent_registered",
				{},
			);
	}

	async #identityEvent(
		sql: SqlClient,
		agentInstanceId: string,
		commandId: string,
		kind: EngineEvent["kind"],
		payload: Record<string, unknown>,
	): Promise<EngineEvent> {
		const rows = (await sql.unsafe("SELECT * FROM engine_runtime_bindings WHERE agent_instance_id=?", [
			agentInstanceId,
		])) as BindingRow[];
		const binding = rows[0];
		const meta = await this.#runtimeMeta(sql);
		return await this.#appendEvent(sql, {
			agentInstanceId,
			causationCommandId: commandId,
			executionId: binding?.execution_id ?? "",
			attemptId: binding?.attempt_id ?? "",
			bindingId: binding?.binding_id ?? "",
			engineGeneration: meta.generation,
			bindingGeneration: Number(binding?.binding_generation ?? 0),
			authorityGeneration: Number(binding?.authority_generation ?? 0),
			kind,
			payload,
		});
	}

	async #assertPendingBudget(
		sql: SqlClient,
		agentInstanceId: string,
		bytes: number,
		control = false,
		excludingCommandId = "",
		recordsDelta = 1,
	): Promise<void> {
		const controls = [...ENGINE_CONTROL_OPS];
		const commandWhere = `state='received' AND command_id<>? AND operation ${control ? "IN" : "NOT IN"} (${controls.map(() => "?").join(",")})`;
		const commands = (await sql.unsafe(
			`SELECT COUNT(*) AS records,COALESCE(SUM(payload_bytes),0) AS bytes FROM engine_commands WHERE ${commandWhere}`,
			[excludingCommandId, ...controls],
		)) as Array<{ records: number; bytes: number }>;
		const inbox = control
			? [{ records: 0, bytes: 0 }]
			: ((await sql.unsafe(
					"SELECT COUNT(*) AS records,COALESCE(SUM(length(CAST(delivery_payload AS BLOB))+length(CAST(COALESCE(annotation,'') AS BLOB))),0) AS bytes FROM engine_inbox_items WHERE disposition='pending'",
				)) as Array<{ records: number; bytes: number }>);
		if (
			Number(commands[0].records) + Number(inbox[0].records) + recordsDelta >
				(control ? runtimeLimits.controlPendingRecords : runtimeLimits.devicePendingRecords) ||
			Number(commands[0].bytes) + Number(inbox[0].bytes) + bytes >
				(control ? runtimeLimits.controlPendingBytes : runtimeLimits.devicePendingBytes)
		)
			throw new EngineTargetError("queue_full", "Device pending admission budget is full");
		if (control) return;
		const agentCommands = (await sql.unsafe(
			`SELECT COUNT(*) AS records,COALESCE(SUM(payload_bytes),0) AS bytes FROM engine_commands WHERE ${commandWhere} AND agent_instance_id=?`,
			[excludingCommandId, ...controls, agentInstanceId],
		)) as Array<{ records: number; bytes: number }>;
		const agentInbox = (await sql.unsafe(
			"SELECT COUNT(*) AS records,COALESCE(SUM(length(CAST(delivery_payload AS BLOB))+length(CAST(COALESCE(annotation,'') AS BLOB))),0) AS bytes FROM engine_inbox_items WHERE disposition='pending' AND agent_instance_id=?",
			[agentInstanceId],
		)) as Array<{ records: number; bytes: number }>;
		if (
			Number(agentCommands[0].records) + Number(agentInbox[0].records) + recordsDelta >
				runtimeLimits.agentPendingRecords ||
			Number(agentCommands[0].bytes) + Number(agentInbox[0].bytes) + bytes > runtimeLimits.agentPendingBytes
		)
			throw new EngineTargetError("queue_full", "AgentInstance pending admission budget is full");
	}

	async runtimeSnapshot(
		scope: RuntimeScope,
		access: RuntimeAccess,
		cursor?: string,
		limit = runtimeLimits.httpPageRecords,
		maxBytes = runtimeLimits.httpPageBytes,
	): Promise<RuntimeSnapshot> {
		return await this.#transaction(sql => readRuntimeSnapshot(sql, scope, access, cursor, limit, maxBytes));
	}

	async runtimeEvents(request: RuntimeEventsRequest): Promise<RuntimeEventBatch> {
		return await this.#transaction(sql => readRuntimeEvents(sql, request));
	}

	async waitRuntimeEvents(request: RuntimeEventsRequest, signal?: AbortSignal): Promise<RuntimeEventBatch> {
		const deadline =
			Date.now() +
			Math.min(
				request.timeoutMs,
				request.scope.kind === "catalog" ? runtimeLimits.appCursorHeartbeatMs : runtimeLimits.eventWaitMs,
			);
		const total: RuntimeWork = { bytes: 0, changes: 0, scannedRows: 0, materializedBytes: 0, elapsedMs: 0 };
		let afterCursor = request.afterCursor;
		for (;;) {
			// Register before the consistent read. Token-only commits do not wake the app writer.
			const changed = request.scope.kind === "catalog" ? this.#summaryChange.promise : this.changeSignal();
			const remaining = {
				...request.remainingWork,
				scannedRows: request.remainingWork.scannedRows - total.scannedRows,
				materializedBytes: request.remainingWork.materializedBytes - total.materializedBytes,
				timeMs: request.remainingWork.timeMs - total.elapsedMs,
			};
			const result = await this.runtimeEvents({ ...request, afterCursor, remainingWork: remaining });
			total.scannedRows += result.work.scannedRows;
			total.materializedBytes += result.work.materializedBytes;
			total.elapsedMs += result.work.elapsedMs;
			if (
				result.changes.length ||
				result.hasMore ||
				request.untilCursor !== undefined ||
				this.#closed ||
				signal?.aborted ||
				Date.now() >= deadline
			) {
				Object.assign(result.work, total, { changes: result.changes.length });
				for (;;) {
					const bytes = Buffer.byteLength(JSON.stringify(result));
					if (bytes === result.work.bytes) break;
					result.work.bytes = bytes;
				}
				return result;
			}
			afterCursor = result.throughCursor;
			const wake = Promise.withResolvers<void>();
			const abort = () => wake.resolve();
			signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
			try {
				await Promise.race([changed, wake.promise]);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			}
		}
	}

	async runtimeCommand(
		commandId: string,
		access?: RuntimeAccess,
		browserPayloadHash?: string,
	): Promise<Record<string, unknown>> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				"SELECT command_id,agent_instance_id,agent_instance_ref,attempt_id,execution_id,principal_id,browser_payload_hash,canonical_hash,state,operation,settled_at FROM engine_commands WHERE command_id=?",
				[commandId],
			)) as Array<Record<string, unknown>>;
			const row = rows[0];
			if (!row)
				return {
					commandId,
					lookup: "outcome_unknown",
					dedupHorizonMs: runtimeLimits.dedupHorizonMs,
					retention: "indefinite",
				};
			if (
				access &&
				row.principal_id !== access.principalId &&
				!(row.principal_id === "" && access.authorizedAgentInstanceRefs?.includes(String(row.agent_instance_ref)))
			)
				throw new EngineTargetError("agent_not_found", "Unknown authorized command");
			if (browserPayloadHash && row.browser_payload_hash !== browserPayloadHash)
				throw new EngineCommandConflictError(commandId);
			const canonicalRow = await readRuntimeReceipt(sql, commandId);
			const receipt = canonicalRow?.receipt ? (JSON.parse(canonicalRow.receipt) as EngineCommandReceipt) : undefined;
			const canonical = canonicalRow && canonicalRuntimeReceipt(canonicalRow);
			const attempt = row.attempt_id
				? ((await sql.unsafe("SELECT state FROM engine_attempts WHERE attempt_id=?", [row.attempt_id]))[0] as
						| { state: EngineAttemptState }
						| undefined)
				: undefined;
			return {
				commandId,
				lookup: row.state === "settled" ? "known" : "pending",
				stage:
					receipt?.outcome === "rejected"
						? "rejected"
						: row.state !== "settled"
							? "engine_accepted"
							: row.operation === "start" && attempt && TERMINAL_ATTEMPT_STATES.has(attempt.state)
								? "execution_terminal"
								: "applied",
				receipt,
				rawCanonicalHash: row.canonical_hash,
				browserPayloadHash: row.browser_payload_hash,
				target: {
					agentInstanceRef: row.agent_instance_ref,
					agentInstanceId: row.agent_instance_id,
					attemptId: row.attempt_id,
					executionId: row.execution_id,
				},
				dedupHorizonMs: runtimeLimits.dedupHorizonMs,
				dedupUntil: row.settled_at ? Number(row.settled_at) + runtimeLimits.dedupHorizonMs : null,
				retention: "indefinite",
				...canonical,
			};
		});
	}

	async isNativeUnadmittedEvent(
		event: Pick<EngineEvent, "eventId" | "agentInstanceId" | "attemptId" | "engineGeneration" | "causationCommandId">,
	): Promise<boolean> {
		return (
			(
				await this.#client.unsafe(
					`SELECT 1 FROM engine_event_outbox e WHERE event_id=? AND agent_instance_id=? AND attempt_id=? AND engine_generation=? AND causation_command_id=?
		AND NOT EXISTS(SELECT 1 FROM engine_commands c WHERE c.command_id=e.causation_command_id)`,
					[
						event.eventId,
						event.agentInstanceId,
						event.attemptId,
						event.engineGeneration,
						event.causationCommandId,
					],
				)
			).length > 0
		);
	}

	async runtimeQueue(request: RuntimeQueueRequest): Promise<Record<string, unknown>> {
		return await this.#transaction(sql => readRuntimeQueue(sql, request));
	}

	async nativeHistoryPage(
		agentInstanceId: string,
		cursor?: string,
		limit = runtimeLimits.httpPageRecords,
		attemptId?: string,
	): Promise<EngineNativeHistoryPage> {
		return await this.#transaction(async sql => {
			const started = performance.now();
			const bindings = (await sql.unsafe(
				"SELECT session_file FROM engine_runtime_bindings WHERE agent_instance_id=?",
				[agentInstanceId],
			)) as Array<{ session_file: string | null }>;
			const attempts = attemptId
				? ((await sql.unsafe(
						"SELECT transcript_path,transcript_leaf_entry_id,state FROM engine_attempts WHERE attempt_id=? AND agent_instance_id=?",
						[attemptId, agentInstanceId],
					)) as Array<{
						transcript_path: string | null;
						transcript_leaf_entry_id: string | null;
						state: EngineAttemptState;
					}>)
				: [];
			if (attemptId && !attempts[0])
				throw new EngineTargetError("stale_target", "History Attempt is not owned by this AgentInstance");
			const sessionPath = attemptId ? attempts[0].transcript_path : bindings[0]?.session_file;
			if (!sessionPath) throw new EngineTargetError("history_expired", "Native history is not retained");
			const headers = (await sql.unsafe(
				"SELECT entry_id FROM engine_history_entries WHERE session_path=? AND entry_type='session' ORDER BY ordinal LIMIT 1",
				[sessionPath],
			)) as Array<{ entry_id: string }>;
			const heads = (await sql.unsafe(
				"SELECT entry_id FROM engine_history_entries WHERE session_path=? AND entry_type<>'session' ORDER BY ordinal DESC LIMIT 1",
				[sessionPath],
			)) as Array<{ entry_id: string }>;
			const sessionId = headers[0]?.entry_id;
			if (!sessionId) throw new EngineTargetError("history_expired", "Native history index is unavailable");
			const anchor =
				attempts[0] && TERMINAL_ATTEMPT_STATES.has(attempts[0].state)
					? attempts[0].transcript_leaf_entry_id
					: (heads[0]?.entry_id ?? null);
			const revision = anchor ?? "empty";
			let first = anchor;
			if (cursor) {
				let parsed: { agentInstanceId: string; sessionId: string; revision: string; first: string };
				try {
					parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
				} catch {
					throw new EngineTargetError("stale_target", "Invalid history cursor");
				}
				if (
					parsed.agentInstanceId !== agentInstanceId ||
					parsed.sessionId !== sessionId ||
					parsed.revision !== revision
				)
					throw new EngineTargetError("stale_target", "History changed; reacquire its anchor");
				first = parsed.first;
			}
			const rows = first
				? ((await sql.unsafe(
						`WITH RECURSIVE branch(entry_id,parent_entry_id,entry_bytes,depth) AS (SELECT entry_id,parent_entry_id,entry_bytes,0 FROM engine_history_entries WHERE session_path=? AND entry_id=? UNION ALL SELECT h.entry_id,h.parent_entry_id,h.entry_bytes,b.depth+1 FROM engine_history_entries h JOIN branch b ON h.entry_id=b.parent_entry_id WHERE h.session_path=? AND b.depth<?) SELECT * FROM branch ORDER BY depth`,
						[sessionPath, first, sessionPath, Math.min(limit, runtimeLimits.httpPageRecords)],
					)) as Array<{ entry_id: string; parent_entry_id: string | null; entry_bytes: number; depth: number }>)
				: [];
			const selected: typeof rows = [];
			let readBytes = 0;
			let entryRef: EngineNativeHistoryPage["entryRef"];
			for (const row of rows.slice(0, limit)) {
				const bytes = Number(row.entry_bytes);
				if (bytes > runtimeLimits.httpPageBytes - 4096) {
					if (selected.length) break;
					entryRef = { entryId: row.entry_id, revision, bytes, method: "runtime.history.entry" };
					selected.push(row);
					break;
				}
				if (readBytes + bytes > runtimeLimits.httpPageBytes - 4096) break;
				selected.push(row);
				readBytes += bytes;
			}
			const entries =
				selected.length && !entryRef
					? ((await sql.unsafe(
							`SELECT entry_json FROM engine_history_entries WHERE session_path=? AND entry_id IN (${selected.map(() => "?").join(",")}) ORDER BY ordinal`,
							[sessionPath, ...selected.map(row => row.entry_id)],
						)) as Array<{ entry_json: string }>)
					: [];
			const nativeEntries = entries.map(row => JSON.parse(row.entry_json) as Record<string, unknown>);
			const calls: string[] = [];
			for (const entry of nativeEntries) {
				const message = entry.message as
					| { role?: string; content?: Array<{ type?: string; id?: string }> }
					| undefined;
				if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
				for (const part of message.content)
					if (part.type === "toolCall" && part.id && calls.length < runtimeLimits.httpPageRecords)
						calls.push(part.id);
			}
			const resultRows = calls.length
				? ((await sql.unsafe(
						`SELECT entry_id,entry_bytes,tool_call_id FROM engine_history_entries WHERE session_path=? AND tool_call_id IN (${calls.map(() => "?").join(",")}) ORDER BY ordinal LIMIT ?`,
						[sessionPath, ...calls, runtimeLimits.httpPageRecords],
					)) as Array<{ entry_id: string; entry_bytes: number; tool_call_id: string }>)
				: [];
			const resultIds: string[] = [];
			const activityRefs: NonNullable<EngineNativeHistoryPage["activityRefs"]> = [];
			for (const row of resultRows) {
				if (selected.some(item => item.entry_id === row.entry_id)) continue;
				const bytes = Number(row.entry_bytes);
				if (readBytes + bytes > runtimeLimits.httpPageBytes - 8192) {
					activityRefs.push({
						toolCallId: row.tool_call_id,
						entryId: row.entry_id,
						revision,
						bytes,
						method: "runtime.history.entry",
					});
					continue;
				}
				readBytes += bytes;
				resultIds.push(row.entry_id);
			}
			if (resultIds.length) {
				const results = (await sql.unsafe(
					`SELECT entry_json FROM engine_history_entries WHERE session_path=? AND entry_id IN (${resultIds.map(() => "?").join(",")}) ORDER BY ordinal`,
					[sessionPath, ...resultIds],
				)) as Array<{ entry_json: string }>;
				nativeEntries.push(...results.map(row => JSON.parse(row.entry_json) as Record<string, unknown>));
			}
			const next = selected.at(-1)?.parent_entry_id ?? null;
			return {
				sessionId,
				revision,
				anchor,
				entries: nativeEntries,
				...(activityRefs.length ? { activityRefs } : {}),
				nextCursor: next
					? Buffer.from(JSON.stringify({ agentInstanceId, sessionId, revision, first: next })).toString(
							"base64url",
						)
					: null,
				...(entryRef ? { entryRef } : {}),
				visitedRecords:
					rows.length +
					resultRows.length +
					entries.length +
					resultIds.length +
					bindings.length +
					attempts.length +
					headers.length +
					heads.length,
				readBytes,
				elapsedMs: Math.ceil(performance.now() - started),
			};
		});
	}

	async nativeHistoryEntry(
		agentInstanceId: string,
		entryId: string,
		revision: string,
		offset = 0,
		limit = runtimeLimits.deliveryBatchBytes,
		expectedSessionId?: string,
	): Promise<Record<string, unknown>> {
		return await this.#transaction(async sql => {
			const bindings = (await sql.unsafe(
				"SELECT session_file FROM engine_runtime_bindings WHERE agent_instance_id=?",
				[agentInstanceId],
			)) as Array<{ session_file: string | null }>;
			const sessionPath = bindings[0]?.session_file;
			if (!sessionPath) throw new EngineTargetError("history_expired", "Native history expired");
			const sessions = (await sql.unsafe(
				"SELECT entry_id FROM engine_history_entries WHERE session_path=? AND entry_type='session' ORDER BY ordinal LIMIT 1",
				[sessionPath],
			)) as Array<{ entry_id: string }>;
			const sessionId = sessions[0]?.entry_id;
			if (!sessionId || (expectedSessionId && expectedSessionId !== sessionId))
				throw new EngineTargetError("stale_target", "History session changed");
			const heads = (await sql.unsafe(
				"SELECT entry_id FROM engine_history_entries WHERE session_path=? AND entry_type<>'session' ORDER BY ordinal DESC LIMIT 1",
				[sessionPath],
			)) as Array<{ entry_id: string }>;
			if ((heads[0]?.entry_id ?? "empty") !== revision)
				throw new EngineTargetError("stale_target", "History revision changed");
			const rows = (await sql.unsafe(
				"SELECT entry_bytes,substr(CAST(entry_json AS BLOB),?,?) AS chunk FROM engine_history_entries WHERE session_path=? AND entry_id=?",
				[offset + 1, Math.min(limit, runtimeLimits.deliveryBatchBytes), sessionPath, entryId],
			)) as Array<{ entry_bytes: number; chunk: Uint8Array }>;
			if (!rows[0]) throw new EngineTargetError("history_expired", "Native history entry expired");
			const bytes = Buffer.from(rows[0].chunk);
			const total = Number(rows[0].entry_bytes);
			return {
				sessionId,
				entryId,
				revision,
				offset,
				totalBytes: total,
				contentBase64: bytes.toString("base64"),
				nextOffset: offset + bytes.length < total ? offset + bytes.length : null,
			};
		});
	}

	async waitAttemptResult(
		agentInstanceId: string,
		commandId: string,
		attemptId?: string,
		signal?: AbortSignal,
	): Promise<{ attemptId?: string; state: EngineAttemptState; payload: Record<string, unknown> }> {
		let pinnedAttempt = attemptId;
		for (;;) {
			signal?.throwIfAborted();
			if (this.#closed) throw new EngineTargetError("interrupted", "Engine store closed during child wait");
			const changed = this.changeSignal();
			const result = await this.#transaction(async sql => {
				const commands = (await sql.unsafe(
					"SELECT agent_instance_id,attempt_id,receipt FROM engine_commands WHERE command_id=?",
					[commandId],
				)) as Array<{ agent_instance_id: string; attempt_id: string | null; receipt: string | null }>;
				const command = commands[0];
				if (command && command.agent_instance_id !== agentInstanceId)
					throw new EngineTargetError("stale_target", "Child command belongs to another AgentInstance");
				if (command?.attempt_id) {
					if (pinnedAttempt && pinnedAttempt !== command.attempt_id)
						throw new EngineTargetError("stale_target", "Child Attempt identity changed");
					pinnedAttempt = command.attempt_id;
				}
				const receipt = command?.receipt ? (JSON.parse(command.receipt) as EngineCommandReceipt) : undefined;
				const attempts = pinnedAttempt
					? ((await sql.unsafe(
							"SELECT command_id,state,result_payload FROM engine_attempts WHERE attempt_id=? AND agent_instance_id=?",
							[pinnedAttempt, agentInstanceId],
						)) as Array<{ command_id: string; state: EngineAttemptState; result_payload: string | null }>)
					: [];
				const attempt = attempts[0];
				if (attempt && attempt.command_id !== commandId)
					throw new EngineTargetError("stale_target", "Child Attempt belongs to another launch command");
				if (attempt && TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
					const events = attempt.result_payload
						? []
						: ((await sql.unsafe(
								"SELECT payload FROM engine_event_outbox WHERE attempt_id=? AND kind IN ('completed','cancelled','failed','interrupted') ORDER BY event_id DESC LIMIT 1",
								[pinnedAttempt],
							)) as Array<{ payload: string | null }>);
					if (!attempt.result_payload && !events[0]) return undefined;
					return {
						attemptId: pinnedAttempt,
						state: attempt.state,
						payload: JSON.parse(attempt.result_payload ?? events[0].payload ?? "{}") as Record<string, unknown>,
					};
				}
				if (receipt?.outcome === "rejected")
					return {
						attemptId: pinnedAttempt,
						state: "failed" as const,
						payload: { error: receipt.detail?.message ?? receipt.detail?.code ?? "Child launch rejected" },
					};
				return undefined;
			});
			if (result) return result;
			const cancelled = Promise.withResolvers<void>();
			const abort = () => cancelled.resolve();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			try {
				await Promise.race([changed, cancelled.promise]);
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		}
	}

	async #runtimeMeta(sql: SqlClient): Promise<{ epoch: string; generation: number; watermark: number }> {
		const rows = (await sql.unsafe(
			"SELECT key,value FROM engine_metadata WHERE key IN ('database_id','engine_generation')",
		)) as Array<{ key: string; value: string }>;
		const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
		const cursor = (await sql.unsafe(
			"SELECT COALESCE(MAX(event_id),0) AS watermark FROM engine_event_outbox",
		)) as Array<{ watermark: number }>;
		return {
			epoch: values.database_id,
			generation: Number(values.engine_generation ?? 0),
			watermark: Number(cursor[0].watermark),
		};
	}

	async #assertInputRevision(sql: SqlClient, attemptId: string, inputId: string, revision: number): Promise<void> {
		const rows = (await sql.unsafe(
			`SELECT event_id FROM engine_event_outbox WHERE attempt_id=? AND kind IN ('input_requested','tool_approval_requested') AND COALESCE(json_extract(payload,'$.inputId'),json_extract(payload,'$.approvalId'))=? ORDER BY event_id DESC LIMIT 1`,
			[attemptId, inputId],
		)) as Array<{ event_id: number }>;
		if (Number(rows[0]?.event_id) !== revision)
			throw new EngineTargetError("stale_target", "Pending input revision changed");
	}

	async #effectiveHolds(sql: SqlClient, agentId: string): Promise<EngineBranchHold[]> {
		const rows = (await sql.unsafe(
			`WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT i.parent_agent_instance_id FROM engine_agent_identity i JOIN ancestors a ON i.agent_instance_id=a.id WHERE i.parent_agent_instance_id IS NOT NULL)
		 SELECT h.*,i.agent_instance_ref FROM engine_branch_holds h JOIN ancestors a ON h.source_agent_instance_id=a.id LEFT JOIN engine_agent_identity i ON i.agent_instance_id=h.source_agent_instance_id ORDER BY h.created_at,h.source_agent_instance_id,h.kind`,
			[agentId],
		)) as Array<{
			source_agent_instance_id: string;
			agent_instance_ref: string;
			command_id: string;
			generation: number;
			kind: EngineBranchHold["kind"];
		}>;
		return rows.map(row => ({
			sourceAgentInstanceId: row.source_agent_instance_id,
			sourceAgentInstanceRef: row.agent_instance_ref,
			commandId: row.command_id,
			generation: Number(row.generation),
			kind: row.kind,
		}));
	}

	private constructor(client: SqlClient, sessionStorage: SqlSessionStorage) {
		this.#client = client;
		this.sessionStorage = sessionStorage;
	}

	static async open(databasePath: string): Promise<EngineStore> {
		const resolved = path.resolve(databasePath);
		await fs.mkdir(path.dirname(resolved), { recursive: true });
		const client = new SQL(`sqlite:${resolved.replaceAll("\\", "/")}`);
		try {
			const schema = await client.unsafe(
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_schema_migrations'",
			);
			if (schema.length) {
				const applied = (await client.unsafe(
					"SELECT version,checksum FROM engine_schema_migrations ORDER BY version",
				)) as MigrationRow[];
				assertSchemaHistory(applied);
			}
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
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`INSERT INTO engine_metadata(key, value) VALUES ('engine_generation', '1')
			 ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
			 RETURNING value`,
			)) as MetadataRow[];
			const generation = Number(rows[0]?.value ?? 1);
			const identities = (await sql.unsafe(`WITH RECURSIVE tree(id,depth) AS (
			SELECT agent_instance_id,0 FROM engine_agent_identity WHERE parent_agent_instance_id IS NULL
			UNION ALL SELECT i.agent_instance_id,t.depth+1 FROM engine_agent_identity i JOIN tree t ON i.parent_agent_instance_id=t.id
		) SELECT i.agent_instance_id FROM tree t JOIN engine_agent_identity i ON i.agent_instance_id=t.id
		WHERE i.agent_instance_ref<>'' ORDER BY t.depth,i.agent_instance_id`)) as Array<{ agent_instance_id: string }>;
			for (const identity of identities) {
				await this.#identityEvent(sql, identity.agent_instance_id, `generation:${generation}`, "reconciled", {
					reason: "engine_generation",
					requiresExplicitContinue: true,
				});
			}
			return generation;
		});
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
		expectedIntentRevision?: number,
		commandId = source.sourceEventId,
	): Promise<{ item: EngineInboxItem; created: boolean }> {
		if (!source.sourceEventId.trim() || !source.body.trim()) {
			throw new EngineInboxConflictError("Inbox sourceEventId and body must be non-empty");
		}
		if (source.createdAt !== undefined && (!Number.isSafeInteger(source.createdAt) || source.createdAt < 0)) {
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
					(source.createdAt !== undefined && Number(existingSource.created_at) !== source.createdAt))
			) {
				throw new EngineInboxConflictError(`Inbox source ${source.sourceEventId} has different immutable content`);
			}
			if (!existingSource) {
				const createdAt = source.createdAt ?? Date.now();
				await sql.unsafe(
					`INSERT INTO engine_inbox_sources(source_event_id, source_type, sender, body, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
					[source.sourceEventId, source.sourceType, source.sender ?? null, source.body, createdAt],
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
			await this.#assertIntent(sql, target.agentInstanceId, expectedIntentRevision);
			await this.#assertPendingBudget(sql, target.agentInstanceId, Buffer.byteLength(source.body), false, commandId);
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

	async getInboxItemByQueueId(queueId: string): Promise<EngineInboxItem | undefined> {
		const rows = (await this.#client.unsafe(`${this.#inboxSelect()} WHERE i.queue_id=?`, [
			queueId,
		])) as InboxItemRow[];
		return rows[0] ? inboxItemFromRow(rows[0]) : undefined;
	}

	async rearmInboxWake(queueId: string, expectedRevision: number): Promise<boolean> {
		return await this.#transaction(async sql => {
			const rows = await sql.unsafe(
				`UPDATE engine_inbox_items SET wake_delivered_at=NULL, revision=revision+1, updated_at=?
				 WHERE queue_id=? AND disposition='pending' AND wake_intent=1
				 AND wake_delivered_at IS NOT NULL AND revision=? RETURNING queue_id`,
				[Date.now(), queueId, expectedRevision],
			);
			return rows.length > 0;
		});
	}

	async mutateInboxItem(target: EngineInboxTarget, mutation: EngineInboxMutation): Promise<EngineInboxItem> {
		return (await this.mutateInboxItemWithEvent(target, mutation)).item;
	}

	async mutateInboxItemWithEvent(
		target: EngineInboxTarget,
		mutation: EngineInboxMutation,
	): Promise<{ item: EngineInboxItem; event?: EngineEvent }> {
		if (!mutation.mutationId.trim() || !mutation.queueId.trim()) {
			throw new EngineInboxConflictError("Inbox mutationId and queueId must be non-empty");
		}
		return await this.#transaction(sql => this.#mutateInboxItem(sql, target, mutation));
	}

	async reorderInboxItems(
		target: EngineInboxTarget,
		mutationId: string,
		expectedOrder: readonly string[],
		desiredOrder: readonly string[],
	): Promise<EngineInboxItem[]> {
		return (await this.reorderInboxItemsWithEvent(target, mutationId, expectedOrder, desiredOrder)).items;
	}

	async reorderInboxItemsWithEvent(
		target: EngineInboxTarget,
		mutationId: string,
		expectedOrder: readonly string[],
		desiredOrder: readonly string[],
		expectedQueueRevision?: number,
	): Promise<{ items: EngineInboxItem[]; event?: EngineEvent }> {
		if (!mutationId.trim() || new Set(desiredOrder).size !== desiredOrder.length) {
			throw new EngineInboxConflictError("Inbox reorder identity and queue IDs must be unique");
		}
		return await this.#transaction(async sql => {
			if (expectedQueueRevision !== undefined) {
				const revisions = (await sql.unsafe(
					"SELECT queue_revision FROM engine_agent_identity WHERE agent_instance_id=?",
					[target.agentInstanceId],
				)) as Array<{ queue_revision: number }>;
				if (Number(revisions[0]?.queue_revision ?? 0) !== expectedQueueRevision)
					throw new EngineInboxConflictError("Queue revision changed");
			}
			const rows = (await sql.unsafe(
				`${this.#inboxSelect()} WHERE i.session_id=? AND i.disposition='pending' ORDER BY i.position, i.queue_id`,
				[target.sessionId],
			)) as InboxItemRow[];
			for (const row of rows) this.#assertInboxTarget(row, target);
			const current = rows.map(row => row.queue_id);
			if (sameStrings(current, desiredOrder)) return { items: rows.map(inboxItemFromRow) };
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
					`UPDATE engine_inbox_items SET position=?, wake_delivered_at=NULL,
					 revision=revision+1, updated_at=? WHERE queue_id=?`,
					[(index + 1) * 1024, now, queueId],
				);
			}
			const event = await this.#appendInboxEvent(sql, target, mutationId, "reorder", 1);
			const reordered = (await sql.unsafe(
				`${this.#inboxSelect()} WHERE i.session_id=? AND i.disposition='pending' ORDER BY i.position, i.queue_id`,
				[target.sessionId],
			)) as InboxItemRow[];
			return { items: reordered.map(inboxItemFromRow), event };
		});
	}

	async nextInboxWakeAt(engineGeneration: number): Promise<number | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT MIN(COALESCE(i.deliver_at, i.created_at)) AS deliver_at FROM engine_inbox_items i
			 JOIN engine_runtime_bindings b ON b.agent_instance_id=i.agent_instance_id
			  AND b.binding_id=i.binding_id AND b.engine_generation=i.engine_generation
			  AND b.binding_generation=i.binding_generation
			 WHERE i.engine_generation<=? AND i.disposition='pending' AND i.wake_intent=1
			 AND i.wake_delivered_at IS NULL AND b.manual_hold=0 AND b.state IN ('idle', 'released')
			 AND NOT EXISTS (
			  SELECT 1 FROM engine_inbox_items h WHERE h.session_id=i.session_id AND h.disposition='pending'
			  AND (h.position<i.position OR (h.position=i.position AND h.queue_id<i.queue_id))
			 )`,
			[engineGeneration],
		)) as Array<{ deliver_at: number | null }>;
		return rows[0]?.deliver_at === null || rows[0]?.deliver_at === undefined ? undefined : Number(rows[0].deliver_at);
	}

	async claimDueInboxWakes(engineGeneration: number, now = Date.now()): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			const rows = (await sql.unsafe(
				`SELECT q.*, b.intent_revision FROM (${this.#inboxSelect()}) q
				 JOIN engine_runtime_bindings b ON b.agent_instance_id=q.agent_instance_id
				  AND b.binding_id=q.binding_id AND b.engine_generation=q.engine_generation
				  AND b.binding_generation=q.binding_generation
				 WHERE q.engine_generation<=? AND q.disposition='pending' AND b.manual_hold=0
				 AND b.state IN ('idle', 'released')
				 AND q.wake_intent=1 AND q.wake_delivered_at IS NULL AND COALESCE(q.deliver_at, q.created_at)<=?
				 AND NOT EXISTS (
				  SELECT 1 FROM engine_inbox_items h WHERE h.session_id=q.session_id AND h.disposition='pending'
				  AND (h.position<q.position OR (h.position=q.position AND h.queue_id<q.queue_id))
				 )
				 ORDER BY COALESCE(q.deliver_at, q.created_at), q.position, q.queue_id LIMIT 100`,
				[engineGeneration, now],
			)) as Array<InboxItemRow & { intent_revision: number }>;
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
						{ intentRevision: Number(row.intent_revision), manualHold: false },
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
				if (existing.processor_generation !== null || command.engineGeneration < processorGeneration) {
					const receipt: EngineCommandReceipt = {
						outcome: "rejected",
						detail: {
							code: "interrupted",
							message: "Command admission was interrupted; explicit Continue is required",
							requiresExplicitContinue: true,
						},
					};
					await this.#settleAdmittedCommand(sql, command.commandId, receipt, command.canonicalHash, true);
					return { status: "replay", receipt };
				}
				await sql.unsafe(
					`UPDATE engine_commands SET processor_generation=?, updated_at=?
					 WHERE command_id=? AND state='received'`,
					[processorGeneration, Date.now(), command.commandId],
				);
				return { status: "claimed" };
			}

			const now = Date.now();
			const payloadBytes = Buffer.byteLength(command.serializedCommand ?? "");
			await this.#assertPendingBudget(
				sql,
				command.agentInstanceId,
				payloadBytes,
				ENGINE_CONTROL_OPS.has(command.operation),
			);
			await this.#registerAgent(sql, command);
			await sql.unsafe(
				`INSERT INTO engine_commands(
				 command_id, operation, device_id, engine_id, engine_generation, agent_instance_id,
				 agent_instance_ref, parent_agent_instance_id, binding_id, binding_generation,
				 execution_id, attempt_id, authority_generation, payload_hash, canonical_hash,
				 state, processor_generation, received_at, updated_at,principal_id,browser_payload_hash,payload_bytes,serialized_command
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?,?,?,?,?)`,
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
					command.principalId ?? "",
					command.browserPayloadHash ?? null,
					payloadBytes,
					command.serializedCommand ?? null,
				],
			);
			if (command.operation === "start") {
				const start = await readTargetStart(sql, {
					agentInstanceId: command.agentInstanceId,
					executionId: command.executionId!,
					attemptId: command.attemptId!,
					authorityGeneration: command.authorityGeneration,
					engineGeneration: command.engineGeneration,
					pendingStartCommandId: command.commandId,
				});
				const cancelledBy = start && (await startCancellation(sql, start));
				if (cancelledBy) {
					const receipt: EngineCommandReceipt = {
						outcome: "rejected",
						detail: {
							code: "cancelled",
							message: "Start was cancelled before delivery",
							cancellationCommandId: cancelledBy,
						},
					};
					await this.#settleAdmittedCommand(sql, command.commandId, receipt, command.canonicalHash, true);
					return { status: "replay", receipt };
				}
			}
			if (command.browserPayloadHash) await this.#commandReceiptEvent(sql, command.commandId);
			if (command.engineGeneration < processorGeneration) {
				const receipt: EngineCommandReceipt = {
					outcome: "rejected",
					detail: {
						code: "interrupted",
						message: "Command belongs to a previous Engine generation",
						requiresExplicitContinue: true,
					},
				};
				await this.#settleAdmittedCommand(sql, command.commandId, receipt, command.canonicalHash, true);
				return { status: "replay", receipt };
			}
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
		target: EnginePendingStartTarget,
		cancellationCommandId: string,
	): Promise<EnginePendingStartCancellation> {
		return await this.#transaction(async sql => {
			const fenced = validateStartFence(target);
			const start = await readTargetStart(sql, target);
			if (!start && !fenced) return { status: "not_found" };
			if (start?.state === "settled") {
				const receipt = start.receipt ? (JSON.parse(start.receipt) as EngineCommandReceipt) : undefined;
				if (receipt?.outcome !== "rejected" || receipt.detail?.code !== "cancelled") {
					return { status: "too_late" };
				}
			}

			if (start?.state === "settled") {
				const rows = (await sql.unsafe(
					"SELECT intent_revision FROM engine_agent_identity WHERE agent_instance_id=?",
					[target.agentInstanceId],
				)) as Array<{ intent_revision: number }>;
				return { status: "already_cancelled", intentRevision: Number(rows[0]?.intent_revision ?? 0) };
			}
			const expected = await cancelIntentRevision(sql, target);
			await writeStartCancellation(sql, target, cancellationCommandId);
			const held = await this.#branchIntent(sql, target.agentInstanceId, cancellationCommandId, "stop", expected);
			const intentRevision = held.intentRevision;
			if (!start) return { status: "cancelled", intentRevision };

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

	async getStartConversationIdentity(commandId: string): Promise<EngineStartConversationIdentity | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT operation, agent_instance_id, agent_instance_ref, parent_agent_instance_id, authority_generation
			 FROM engine_commands WHERE command_id = ?`,
			[commandId],
		)) as Array<{
			operation: string;
			agent_instance_id: string;
			agent_instance_ref: string | null;
			parent_agent_instance_id: string | null;
			authority_generation: number;
		}>;
		const row = rows[0];
		if (!row) return undefined;
		return {
			operation: row.operation,
			agentInstanceId: row.agent_instance_id,
			...(row.agent_instance_ref ? { agentInstanceRef: row.agent_instance_ref } : {}),
			...(row.parent_agent_instance_id ? { parentAgentInstanceId: row.parent_agent_instance_id } : {}),
			authorityGeneration: Number(row.authority_generation),
		};
	}

	async getBindingConversationIdentity(agentInstanceId: string): Promise<string | undefined> {
		const rows = (await this.#client.unsafe(
			"SELECT conversation_identity_digest FROM engine_runtime_bindings WHERE agent_instance_id = ?",
			[agentInstanceId],
		)) as Array<{ conversation_identity_digest: string | null }>;
		return rows[0]?.conversation_identity_digest ?? undefined;
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

	async listRetainedDirectChildHistory(parentAgentInstanceId: string): Promise<RetainedDirectChildHistory[]> {
		const rows = (await this.#client.unsafe(
			`SELECT b.agent_instance_id, c.agent_instance_ref, b.engine_agent_id, b.session_file
			 FROM engine_runtime_bindings b
			 JOIN engine_attempts a ON a.attempt_id=b.attempt_id
			 JOIN engine_commands c ON c.command_id=b.command_id
			 WHERE c.operation='start' AND c.parent_agent_instance_id=? AND c.agent_instance_ref IS NOT NULL
			 AND b.state='released' AND b.session_file IS NOT NULL
			 AND a.state IN ('completed', 'cancelled', 'failed', 'interrupted')
			 ORDER BY a.updated_at, b.agent_instance_id`,
			[parentAgentInstanceId],
		)) as Array<{
			agent_instance_id: string;
			agent_instance_ref: string;
			engine_agent_id: string;
			session_file: string;
		}>;
		return rows.map(row => ({
			agentInstanceId: row.agent_instance_id,
			agentInstanceRef: row.agent_instance_ref,
			engineAgentId: row.engine_agent_id,
			sessionFile: row.session_file,
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
		await this.#transaction(sql => this.#putBinding(sql, binding));
	}

	async putAttempt(binding: EngineBindingSnapshot, state: EngineAttemptState, cause?: string): Promise<boolean> {
		return await this.#transaction(sql => this.#putAttempt(sql, binding, state, cause));
	}

	async commitAttemptTransition(
		binding: EngineBindingSnapshot,
		state: EngineAttemptState,
		events: readonly EngineTransitionEvent[],
		options: {
			cause?: string;
			terminalResult?: Record<string, unknown>;
			intentGuard?: { expectedRevision?: number; requireUnheld?: boolean; inputId?: string; inputRevision?: number };
			startIntent?: {
				expectedRevision?: number;
				explicitContinue?: boolean;
				allowInheritedHold?: boolean;
				sourceAgentInstanceId?: string;
				sourceRevision?: number;
			};
			settleCommandId?: string;
			settleCommandReceipt?: EngineCommandReceipt;
			expectedStates?: readonly EngineAttemptState[];
			requireNew?: boolean;
			transcriptCheckpoint?: SessionDurabilityCheckpoint;
			inboxSessionId?: string;
			inboxMutation?: EngineInboxMutation;
			inboxMutationCausationCommandId?: string;
			conversationIdentityDigest?: string;
			previousInboxSessionId?: string;
			pendingInboxSourceSessionId?: string;
		} = {},
	): Promise<EngineEvent[]> {
		return await this.#transaction(async sql => {
			if (options.intentGuard) {
				await this.#assertIntent(
					sql,
					binding.agentInstanceId,
					options.intentGuard.expectedRevision,
					options.intentGuard.requireUnheld,
				);
				if (options.intentGuard.inputId && options.intentGuard.inputRevision !== undefined)
					await this.#assertInputRevision(
						sql,
						binding.attemptId,
						options.intentGuard.inputId,
						options.intentGuard.inputRevision,
					);
			}
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
			const committed: EngineEvent[] = [];
			if (options.startIntent) {
				const intent = options.startIntent;
				await this.#assertIntent(sql, binding.agentInstanceId, intent.expectedRevision);
				if (intent.sourceAgentInstanceId)
					await this.#assertIntent(sql, intent.sourceAgentInstanceId, intent.sourceRevision);
				if (intent.explicitContinue) {
					if (intent.expectedRevision === undefined)
						await this.#assertIntent(sql, binding.agentInstanceId, undefined, true);
					else
						committed.push(
							...(
								await this.#branchIntent(
									sql,
									binding.agentInstanceId,
									binding.commandId,
									"continue",
									intent.expectedRevision,
								)
							).events,
						);
				} else if (!intent.allowInheritedHold)
					await this.#assertIntent(sql, binding.agentInstanceId, intent.expectedRevision, true);
			}
			await this.#putBinding(sql, binding, options.conversationIdentityDigest);
			if (options.startIntent)
				await sql.unsafe(
					"UPDATE engine_commands SET start_applied_intent_revision=(SELECT intent_revision FROM engine_agent_identity WHERE agent_instance_id=?) WHERE command_id=? AND operation='start' AND state='received'",
					[binding.agentInstanceId, binding.commandId],
				);
			if (!(await this.#putAttempt(sql, binding, state, options.cause, transcriptCheckpoint))) {
				throw new EngineAttemptConflictError(binding.attemptId);
			}
			if (options.terminalResult)
				await sql.unsafe("UPDATE engine_attempts SET result_payload=? WHERE attempt_id=?", [
					JSON.stringify(options.terminalResult),
					binding.attemptId,
				]);
			if (options.inboxSessionId) {
				await sql.unsafe(
					"UPDATE engine_inbox_items SET session_id=? WHERE session_id=? AND agent_instance_id=? AND disposition='pending'",
					[options.inboxSessionId, `pending:${binding.agentInstanceId}`, binding.agentInstanceId],
				);
				if (options.previousInboxSessionId && options.previousInboxSessionId !== options.inboxSessionId) {
					await sql.unsafe(
						`UPDATE engine_inbox_items SET session_id=?, updated_at=?
						 WHERE session_id=? AND agent_instance_id=?`,
						[options.inboxSessionId, Date.now(), options.previousInboxSessionId, binding.agentInstanceId],
					);
				}
				if (options.pendingInboxSourceSessionId && options.pendingInboxSourceSessionId !== options.inboxSessionId) {
					await sql.unsafe(
						`UPDATE engine_inbox_items SET session_id=?, wake_delivered_at=NULL, updated_at=?
						 WHERE session_id=? AND agent_instance_id=? AND disposition='pending'`,
						[options.inboxSessionId, Date.now(), options.pendingInboxSourceSessionId, binding.agentInstanceId],
					);
				}
				await sql.unsafe(
					`UPDATE engine_inbox_items SET execution_id=?, attempt_id=?, binding_id=?, engine_generation=?,
					 binding_generation=?, authority_generation=?, wake_delivered_at=NULL, updated_at=?
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
			if (options.inboxMutation) {
				if (!options.inboxSessionId) throw new Error("Inbox mutation requires its session identity");
				const result = await this.#mutateInboxItem(
					sql,
					{ ...binding, sessionId: options.inboxSessionId },
					options.inboxMutation,
					options.inboxMutationCausationCommandId,
				);
				if (result.event) committed.push(result.event);
			}
			for (const event of events) {
				committed.push(
					await this.#appendTransitionEvent(sql, binding, {
						...event,
						...(transcriptCheckpoint ? { payload: { ...event.payload, transcriptCheckpoint } } : {}),
					}),
				);
			}
			if (options.settleCommandId) {
				await this.#settleAdmittedCommand(
					sql,
					options.settleCommandId,
					options.settleCommandReceipt ?? { outcome: "applied" },
				);
			}
			if (TERMINAL_ATTEMPT_STATES.has(state)) await this.#commandReceiptEvent(sql, binding.commandId);
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

	/** Atomically persist a binding-only intent change, its public event, and command receipt. */
	async commitBindingEvent(
		binding: EngineBindingSnapshot,
		event: EngineTransitionEvent,
		settleCommandId: string,
		settleReceipt: EngineCommandReceipt,
	): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			await this.#putBinding(sql, binding);
			const committed = await this.#appendTransitionEvent(sql, binding, event);
			await this.#settleAdmittedCommand(sql, settleCommandId, settleReceipt);
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
			await this.#assertIntent(sql, target.agentInstanceId, undefined, true);
			await this.#insertToolEffect(sql, target, effect, "started");
			return await this.#appendTransitionEvent(sql, target, {
				kind: "tool_started",
				payload: toolEffectPayload(effect),
			});
		});
	}

	async startModelEffect(target: EngineEventTarget, effect: EngineModelEffectInput): Promise<EngineEvent> {
		return await this.#transaction(async sql => {
			await this.#assertIntent(sql, target.agentInstanceId, undefined, true);
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
			await this.#assertIntent(sql, target.agentInstanceId, undefined, true);
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
		options: {
			reason?: string;
			causationCommandId?: string;
			settleCommandId?: string;
			expectedIntentRevision?: number;
			expectedInputRevision?: number;
		} = {},
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
			if (decision !== "cancelled") {
				await this.#assertIntent(
					sql,
					target.agentInstanceId,
					options.expectedIntentRevision,
					decision === "approve",
				);
				if (options.expectedInputRevision !== undefined)
					await this.#assertInputRevision(sql, target.attemptId, approvalId, options.expectedInputRevision);
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

	async isInboxNotificationAcknowledgement(event: EngineEvent): Promise<boolean> {
		if (
			event.kind !== "inbox_changed" ||
			event.payload?.action !== "acknowledge" ||
			!Number.isSafeInteger(event.eventId) ||
			event.eventId < 1 ||
			typeof event.payload.queueId !== "string" ||
			!event.payload.queueId.trim() ||
			!Number.isSafeInteger(event.payload.revision) ||
			Number(event.payload.revision) < 1
		)
			return false;
		const [stored] = await this.eventsAfter(event.attemptId, event.eventId - 1, 1);
		if (!stored) return false;
		for (const key of [
			"eventId",
			"seq",
			"causationCommandId",
			"agentInstanceId",
			"executionId",
			"attemptId",
			"bindingId",
			"engineGeneration",
			"bindingGeneration",
			"authorityGeneration",
			"kind",
			"createdAt",
		] as const) {
			if (stored[key] !== event[key]) return false;
		}
		for (const key of ["action", "queueId", "revision", "sourceEventId"] as const) {
			if (stored.payload?.[key] !== event.payload?.[key]) return false;
		}
		// Legacy query/tool mutation IDs also occur in retained outbox events. Only actual
		// admitted commands have hosted receipts; never infer that distinction from ID shape.
		const commands = await this.#client.unsafe("SELECT command_id FROM engine_commands WHERE command_id=? LIMIT 1", [
			event.causationCommandId,
		]);
		return commands.length === 0;
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
			const recovery = (await sql.unsafe(
				`SELECT i.agent_instance_id FROM engine_agent_identity i WHERE EXISTS(SELECT 1 FROM engine_runtime_bindings b WHERE b.agent_instance_id=i.agent_instance_id AND b.engine_generation<? AND b.state='running') OR EXISTS(SELECT 1 FROM engine_inbox_items q WHERE q.agent_instance_id=i.agent_instance_id AND q.disposition='pending') OR EXISTS(SELECT 1 FROM engine_commands c WHERE c.agent_instance_id=i.agent_instance_id AND c.engine_generation<? AND c.state='received')`,
				[engineGeneration, engineGeneration],
			)) as Array<{ agent_instance_id: string }>;
			for (const row of recovery) {
				await sql.unsafe(
					"UPDATE engine_agent_identity SET intent_revision=intent_revision+1,updated_at=? WHERE agent_instance_id=?",
					[Date.now(), row.agent_instance_id],
				);
				await sql.unsafe(
					`INSERT INTO engine_branch_holds(source_agent_instance_id,kind,command_id,generation,created_at) SELECT agent_instance_id,'recovery',?,intent_revision,? FROM engine_agent_identity WHERE agent_instance_id=? ON CONFLICT(source_agent_instance_id,kind) DO UPDATE SET command_id=excluded.command_id,generation=excluded.generation,created_at=excluded.created_at`,
					[`recovery:${engineGeneration}`, Date.now(), row.agent_instance_id],
				);
			}
			const pending = (await sql.unsafe(
				"SELECT command_id,canonical_hash FROM engine_commands WHERE engine_generation<? AND state='received'",
				[engineGeneration],
			)) as Array<{ command_id: string; canonical_hash: string }>;
			for (const command of pending)
				await this.#settleAdmittedCommand(
					sql,
					command.command_id,
					{
						outcome: "rejected",
						detail: {
							code: "interrupted",
							message: "Engine restarted before command application",
							requiresExplicitContinue: true,
						},
					},
					command.canonical_hash,
					true,
				);
			await sql.unsafe(
				`UPDATE engine_runtime_bindings SET manual_hold=1,intent_revision=(SELECT intent_revision FROM engine_agent_identity i WHERE i.agent_instance_id=engine_runtime_bindings.agent_instance_id) WHERE agent_instance_id IN (SELECT source_agent_instance_id FROM engine_branch_holds WHERE kind='recovery')`,
			);
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
			for (const row of recovery)
				events.push(
					await this.#identityEvent(sql, row.agent_instance_id, `recovery:${engineGeneration}`, "holds_changed", {
						action: "recovery",
						requiresExplicitContinue: true,
					}),
				);
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
								error: "engine_lost",
								lostEngineGeneration: Number(attempt.engine_generation),
								...(transcriptCheckpoint
									? { transcriptRef: `history://${engineAgentId(attempt.agent_instance_id)}` }
									: {}),
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
		this.#closed = true;
		this.#change.resolve();
		this.#summaryChange.resolve();
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
		causationCommandId = mutation.mutationId,
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
		if (desired.disposition === "pending")
			await this.#assertPendingBudget(
				sql,
				target.agentInstanceId,
				Buffer.byteLength(desired.deliveryPayload) +
					Buffer.byteLength(desired.annotation ?? "") -
					Buffer.byteLength(item.deliveryPayload) -
					Buffer.byteLength(item.annotation ?? ""),
				false,
				causationCommandId,
				0,
			);
		const now = Date.now();
		await sql.unsafe(
			`UPDATE engine_inbox_items SET delivery_payload=?, annotation=?, deliver_at=?, wake_intent=?, wake_delivered_at=NULL,
			 disposition=?, revision=?, updated_at=?
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
			causationCommandId,
			mutation.op,
			revision,
			mutation.queueId,
			mutation.op === "acknowledge" ? { sourceEventId: item.sourceEventId } : {},
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

	async #appendInboxEvent(
		sql: SqlClient,
		target: EngineInboxTarget,
		causationCommandId: string,
		action: string,
		revision: number,
		queueId = causationCommandId,
		extraPayload: Record<string, unknown> = {},
	): Promise<EngineEvent> {
		await sql.unsafe(
			"UPDATE engine_agent_identity SET queue_revision=queue_revision+1,updated_at=? WHERE agent_instance_id=?",
			[Date.now(), target.agentInstanceId],
		);
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
			payload: { action, queueId, revision, ...extraPayload },
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

	async #putBinding(
		sql: SqlClient,
		binding: EngineBindingSnapshot,
		conversationIdentityDigest?: string,
	): Promise<void> {
		await this.#registerAgent(sql, {
			agentInstanceId: binding.agentInstanceId,
			authorityGeneration: binding.authorityGeneration,
		});
		await sql.unsafe(
			"UPDATE engine_agent_identity SET intent_revision=MAX(intent_revision,?),updated_at=? WHERE agent_instance_id=?",
			[binding.intentRevision ?? 0, Date.now(), binding.agentInstanceId],
		);
		const holds = await this.#effectiveHolds(sql, binding.agentInstanceId);
		await sql.unsafe(
			`INSERT INTO engine_runtime_bindings(
			 binding_id, command_id, agent_instance_id, execution_id, attempt_id, engine_agent_id, session_file,
			 profile_digest, conversation_identity_digest, state, engine_generation, binding_generation, authority_generation,
			 manual_hold, intent_revision, intent_command_id, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(agent_instance_id) DO UPDATE SET
			 binding_id=excluded.binding_id, command_id=excluded.command_id,
			 execution_id=excluded.execution_id, attempt_id=excluded.attempt_id,
			 engine_agent_id=excluded.engine_agent_id, session_file=excluded.session_file,
			 profile_digest=excluded.profile_digest,
			 conversation_identity_digest=COALESCE(excluded.conversation_identity_digest, engine_runtime_bindings.conversation_identity_digest),
			 state=excluded.state,
			 engine_generation=excluded.engine_generation, binding_generation=excluded.binding_generation,
				 authority_generation=excluded.authority_generation,
				 manual_hold=excluded.manual_hold, intent_revision=MAX(engine_runtime_bindings.intent_revision,excluded.intent_revision),
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
				conversationIdentityDigest ?? null,
				binding.state,
				binding.engineGeneration,
				binding.bindingGeneration,
				binding.authorityGeneration,
				binding.manualHold || holds.length > 0 ? 1 : 0,
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
		if (await recordRuntimeProjection(sql, { ...event, eventId: Number(rows[0]?.event_id), seq, createdAt }))
			this.#summaryRevision++;
		this.#changeRevision++;
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
		if (
			receipt.outcome === "rejected" &&
			receipt.detail?.code === "interrupted" &&
			receipt.detail.requiresExplicitContinue === true
		) {
			const commands = (await sql.unsafe(
				`SELECT agent_instance_id,execution_id,attempt_id,binding_id,binding_generation,authority_generation,
				(SELECT value FROM engine_metadata WHERE key='engine_generation') AS generation FROM engine_commands WHERE command_id=?`,
				[commandId],
			)) as Array<{
				agent_instance_id: string;
				execution_id: string | null;
				attempt_id: string | null;
				binding_id: string | null;
				binding_generation: number | null;
				authority_generation: number;
				generation: string;
			}>;
			const command = commands[0];
			await this.#appendEvent(sql, {
				causationCommandId: commandId,
				agentInstanceId: command.agent_instance_id,
				executionId: command.execution_id ?? "",
				attemptId: command.attempt_id ?? "",
				bindingId: command.binding_id ?? "",
				bindingGeneration: Number(command.binding_generation ?? 0),
				authorityGeneration: Number(command.authority_generation),
				engineGeneration: Number(command.generation),
				kind: "rejected",
				payload: receipt.detail,
			});
		}
		await this.#commandReceiptEvent(sql, commandId);
	}

	async #commandReceiptEvent(sql: SqlClient, commandId: string): Promise<void> {
		const row = await readRuntimeReceipt(sql, commandId);
		const value = row && canonicalRuntimeReceipt(row);
		if (!row || !value) return;
		await this.#identityEvent(sql, row.agent_instance_id, commandId, "command_receipt", { value });
		const target = value.target as { agentInstanceRef: string };
		if (target.agentInstanceRef !== row.agent_instance_ref) {
			const source = await sql.unsafe(
				"SELECT agent_instance_id FROM engine_agent_identity WHERE agent_instance_ref=? AND principal_id=?",
				[target.agentInstanceRef, row.principal_id],
			);
			if (!source[0])
				throw new EngineTargetError(
					"stale_target",
					"Receipt source identity is not owned by the command principal",
				);
			await this.#identityEvent(sql, String(source[0].agent_instance_id), commandId, "command_receipt", { value });
		}
	}

	#transaction<T>(work: (sql: SqlClient) => Promise<T>): Promise<T> {
		const run = this.#transactionTail.then(async () => {
			const revision = this.#changeRevision;
			const summaryRevision = this.#summaryRevision;
			const result = await this.#client.begin("IMMEDIATE", work);
			if (this.#changeRevision !== revision) {
				const previous = this.#change;
				this.#change = Promise.withResolvers<void>();
				previous.resolve();
			}
			if (this.#summaryRevision !== summaryRevision) {
				const previous = this.#summaryChange;
				this.#summaryChange = Promise.withResolvers<void>();
				previous.resolve();
			}
			return result;
		});
		this.#transactionTail = run.then(
			() => {},
			() => {},
		);
		return run;
	}
}
