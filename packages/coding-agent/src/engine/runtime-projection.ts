import type { SQL } from "bun";
import { type EngineEvent, EngineTargetError } from "./contracts";
import { recordRuntimeMessage } from "./runtime-messages";
import {
	type RuntimeAccess,
	type RuntimeChange,
	type RuntimeRemainingWork,
	type RuntimeWork,
	runtimeLimits,
	validateRuntimeValue,
} from "./runtime-protocol";

export type RuntimeSql = InstanceType<typeof SQL>;
export const RUNTIME_PROJECTION_SCHEMA = [
	"ALTER TABLE engine_agent_identity ADD COLUMN root_agent_instance_ref TEXT NOT NULL DEFAULT ''",
	"ALTER TABLE engine_agent_identity ADD COLUMN summary_revision INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE engine_agent_identity ADD COLUMN summary_json TEXT",
	"ALTER TABLE engine_agent_identity ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE engine_attempts ADD COLUMN detail_revision INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE engine_attempts ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE engine_attempts ADD COLUMN message_revision INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE engine_event_outbox ADD COLUMN summary_payload TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN membership_payload TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN projection_payload TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN detail_payload TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN projection_kinds INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE engine_event_outbox ADD COLUMN projection_principal TEXT NOT NULL DEFAULT ''",
	"ALTER TABLE engine_event_outbox ADD COLUMN projection_root TEXT NOT NULL DEFAULT ''",
	"CREATE INDEX engine_runtime_summary_cursor_idx ON engine_event_outbox(projection_principal,event_id) WHERE summary_payload IS NOT NULL",
	"CREATE INDEX engine_runtime_summary_agent_idx ON engine_event_outbox(agent_instance_id,event_id) WHERE summary_payload IS NOT NULL",
	"CREATE INDEX engine_runtime_detail_attempt_idx ON engine_event_outbox(attempt_id,event_id) WHERE detail_payload IS NOT NULL",
	"CREATE INDEX engine_runtime_membership_cursor_idx ON engine_event_outbox(projection_root,event_id) WHERE membership_payload IS NOT NULL",
	"CREATE TABLE engine_runtime_inputs(attempt_id TEXT NOT NULL,input_id TEXT NOT NULL,kind TEXT NOT NULL,created_event_id INTEGER NOT NULL,resolved_event_id INTEGER,PRIMARY KEY(attempt_id,input_id))",
	"CREATE INDEX engine_runtime_input_pending_idx ON engine_runtime_inputs(attempt_id,created_event_id) WHERE resolved_event_id IS NULL",
	"ALTER TABLE engine_event_outbox ADD COLUMN input_body TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN input_preview TEXT",
	"CREATE INDEX engine_runtime_branch_cursor_idx ON engine_event_outbox(projection_root,event_id)",
	"CREATE INDEX engine_runtime_projection_cursor_idx ON engine_event_outbox(agent_instance_id,event_id) WHERE projection_kinds<>0",
	"CREATE INDEX engine_runtime_identity_ref_idx ON engine_agent_identity(agent_instance_ref)",
	"CREATE INDEX engine_runtime_root_idx ON engine_agent_identity(root_agent_instance_ref,agent_instance_id)",
	"CREATE INDEX engine_runtime_pending_start_idx ON engine_commands(agent_instance_id,received_at) WHERE operation='start' AND state='received'",
] as const;

const TERMINAL = new Set(["completed", "cancelled", "failed", "interrupted"]);
const SUMMARY_EVENTS = new Set([
	"agent_registered",
	"holds_changed",
	"command_receipt",
	"accepted",
	"rejected",
	"running",
	"pause_requested",
	"paused",
	"resumed",
	"cancel_requested",
	"completed",
	"cancelled",
	"failed",
	"interrupted",
	"reconciled",
	"input_requested",
	"input_resolved",
	"tool_approval_requested",
	"tool_approval_resolved",
	"inbox_changed",
]);

export interface RuntimeIdentityRow {
	agent_instance_id: string;
	agent_instance_ref: string;
	parent_agent_instance_id: string | null;
	parent_agent_instance_ref: string | null;
	principal_id: string;
	authority_generation: number;
	intent_revision: number;
	queue_revision: number;
	root_agent_instance_ref: string;
	summary_revision: number;
	summary_json: string | null;
	membership_revision: number;
}

export interface RuntimeTargetRow {
	attempt_id: string;
	execution_id: string;
	authority_generation: number;
	engine_generation: number;
	binding_id: string;
	binding_generation: number;
	state: string;
	transcript_session_id: string | null;
	transcript_leaf_entry_id: string | null;
	detail_revision: number;
	input_revision: number;
	message_revision: number;
}

export const RUNTIME_KIND_MASK = {
	assistant: 1,
	tool: 2,
	state: 4,
	queue: 8,
	input: 16,
	history: 32,
	usage: 64,
} as const;

export async function runtimeHolds(
	sql: RuntimeSql,
	agentId: string,
	limit: number,
): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		`WITH RECURSIVE ancestors(id) AS (
		SELECT ? UNION SELECT i.parent_agent_instance_id FROM engine_agent_identity i JOIN ancestors a ON i.agent_instance_id=a.id
		WHERE i.parent_agent_instance_id IS NOT NULL)
		SELECT i.agent_instance_ref,h.command_id,h.generation,h.kind FROM engine_branch_holds h
		JOIN ancestors a ON h.source_agent_instance_id=a.id JOIN engine_agent_identity i ON i.agent_instance_id=h.source_agent_instance_id
		ORDER BY h.source_agent_instance_id,h.kind LIMIT ?`,
		[agentId, limit],
	)) as Array<{ agent_instance_ref: string; command_id: string; generation: number; kind: string }>;
	return rows.map(row => ({
		sourceAgentInstanceRef: row.agent_instance_ref,
		commandId: row.command_id,
		generation: Number(row.generation),
		kind: row.kind,
	}));
}

export async function runtimeDetail(
	sql: RuntimeSql,
	identity: RuntimeIdentityRow,
	attempt: RuntimeTargetRow | undefined,
	revision: number,
): Promise<Record<string, unknown>> {
	const holds = await runtimeHolds(sql, identity.agent_instance_id, runtimeLimits.httpPageRecords + 1);
	const queue = (await sql.unsafe(
		"SELECT COUNT(*) AS count FROM engine_inbox_items WHERE agent_instance_id=? AND disposition='pending'",
		[identity.agent_instance_id],
	)) as Array<{ count: number }>;
	const inputs =
		attempt && !TERMINAL.has(attempt.state)
			? ((await sql.unsafe(
					"SELECT input_id,kind,created_event_id FROM engine_runtime_inputs WHERE attempt_id=? AND resolved_event_id IS NULL ORDER BY created_event_id LIMIT ?",
					[attempt.attempt_id, runtimeLimits.httpPageRecords + 1],
				)) as Array<{ input_id: string; kind: string; created_event_id: number }>)
			: [];
	const heldPage = boundedItems(holds, runtimeLimits.bulkPreviewBytes * 2, runtimeLimits.httpPageRecords);
	const inputPage = boundedItems(
		inputs.map(row => ({ inputId: row.input_id, revision: Number(row.created_event_id), kind: row.kind })),
		runtimeLimits.bulkPreviewBytes * 2,
		runtimeLimits.httpPageRecords,
	);
	return {
		agentInstanceRef: identity.agent_instance_ref,
		attemptId: attempt?.attempt_id ?? null,
		revision,
		target: {
			agentInstanceRef: identity.agent_instance_ref,
			intentRevision: Number(identity.intent_revision),
			authorityGeneration: Number(attempt?.authority_generation ?? identity.authority_generation),
			...(attempt ? { attemptId: attempt.attempt_id, executionId: attempt.execution_id } : {}),
		},
		state: attempt?.state ?? "registered",
		manualHold: holds.length > 0,
		holds: heldPage,
		holdsHasMore: holds.length > heldPage.length,
		queue: {
			revision: Number(identity.queue_revision),
			pendingCount: Number(queue[0].count),
			hasMore: Number(queue[0].count) > 0,
		},
		pendingInputs: inputPage,
		inputsHasMore: inputs.length > inputPage.length,
		history: {
			sessionId: attempt?.transcript_session_id ?? null,
			revision: attempt?.transcript_leaf_entry_id ?? null,
			leafEntryId: attempt?.transcript_leaf_entry_id ?? null,
			settled: Boolean(attempt && TERMINAL.has(attempt.state)),
		},
		messages: [],
		messagesHasMore: false,
	};
}

export function boundedItems<T>(items: T[], maxBytes: number, maxItems: number): T[] {
	const selected: T[] = [];
	let bytes = 2;
	for (const item of items) {
		const size = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (selected.length === maxItems || bytes + size > maxBytes) break;
		selected.push(item);
		bytes += size;
	}
	return selected;
}

export function runtimeInputBody(event: EngineEvent): Record<string, unknown> {
	const payload = event.payload ?? {};
	if (event.kind === "tool_approval_requested")
		return {
			kind: "tool_approval",
			inputId: String(payload.approvalId),
			revision: event.eventId,
			requestedAt: new Date(event.createdAt).toISOString(),
			prompt: `Разрешить вызов ${String(payload.toolName ?? "tool")}?`,
			tool: {
				name: String(payload.toolName ?? "tool"),
				...(typeof payload.inputHash === "string" ? { inputHash: payload.inputHash } : {}),
			},
			options: ["approve", "deny"],
		};
	const questions = payload.questions;
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > runtimeLimits.inputMaxQuestions)
		throw new EngineTargetError("invalid_request", "Input question count is outside the owner limit");
	const projected = questions.map((question: Record<string, unknown>) => ({
		id: question.id,
		question: question.question,
		...(question.header !== undefined ? { header: question.header } : {}),
		options: Array.isArray(question.options)
			? question.options.map((option: Record<string, unknown>) => ({
					label: option.label,
					...(option.description !== undefined ? { description: option.description } : {}),
				}))
			: [],
		...(question.multi !== undefined ? { multi: question.multi } : {}),
		...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
	}));
	if (new Set(projected.map(question => question.id)).size !== projected.length)
		throw new EngineTargetError("invalid_request", "Input question IDs must be unique");
	// Validate fields without applying a transport-frame cap to the retained full body.
	for (const question of projected) {
		if (question.options.length > runtimeLimits.inputMaxOptions)
			throw new EngineTargetError("invalid_request", "Input option count exceeds the owner limit");
		if (
			question.recommended !== undefined &&
			(!Number.isSafeInteger(question.recommended) || Number(question.recommended) >= question.options.length)
		)
			throw new EngineTargetError("invalid_request", "Recommended input option does not exist");
		for (const options of [[], ...question.options.map(option => [option])])
			validateRuntimeValue("pendingInput", {
				kind: "question",
				inputId: String(payload.inputId),
				revision: event.eventId,
				questions: [{ ...question, options }],
			});
	}
	return {
		kind: "question",
		inputId: String(payload.inputId),
		revision: event.eventId,
		requestedAt: new Date(event.createdAt).toISOString(),
		questions: projected,
	};
}

export function runtimeInputPreview(body: Record<string, unknown>): Record<string, unknown> {
	if (Buffer.byteLength(JSON.stringify(body)) <= runtimeLimits.inputPreviewBytes) return body;
	for (let length = 128; length >= 1; length = Math.floor(length / 2)) {
		const questions = body.questions as Array<Record<string, unknown>> | undefined;
		const preview = questions
			? {
					...body,
					questions: questions.map(question => ({
						...question,
						question: String(question.question).slice(0, length).toWellFormed(),
						...(question.header ? { header: String(question.header).slice(0, length).toWellFormed() } : {}),
						options: (question.options as Array<{ label: string }>).map(option => ({
							label: option.label.slice(0, length).toWellFormed(),
						})),
					})),
				}
			: { ...body, prompt: String(body.prompt).slice(0, length).toWellFormed() };
		if (Buffer.byteLength(JSON.stringify(preview)) <= runtimeLimits.inputPreviewBytes) return preview;
	}
	throw new EngineTargetError("invalid_request", "Input IDs and option shape exceed the bounded control overview");
}

interface PendingTargetRow {
	command_id: string;
	attempt_id: string;
	execution_id: string;
	engine_generation: number;
	authority_generation: number;
}

export interface RuntimeTargetRequest extends RuntimeAccess {
	agentInstanceRef: string;
	attemptId?: string;
	executionId?: string;
	rootAgentInstanceRef?: string;
}

export class RuntimeQueryError extends EngineTargetError {
	constructor(
		code: "retention_gap" | "epoch_changed" | "projection_changed" | "restore_budget",
		message: string,
		readonly work: RuntimeWork,
	) {
		super(code, message);
	}
}

export class RuntimeQueryWork {
	readonly value: RuntimeWork = { bytes: 0, changes: 0, scannedRows: 0, materializedBytes: 0, elapsedMs: 0 };
	readonly #started = performance.now();

	constructor(readonly remaining: RuntimeRemainingWork) {}

	check(): void {
		this.value.elapsedMs = Math.ceil(performance.now() - this.#started);
		if (
			this.value.scannedRows > this.remaining.scannedRows ||
			this.value.materializedBytes > this.remaining.materializedBytes ||
			this.value.elapsedMs > this.remaining.timeMs
		) {
			throw new RuntimeQueryError("restore_budget", "Owner query work budget exceeded", { ...this.value });
		}
	}

	rows(count: number): void {
		this.value.scannedRows += count;
		this.check();
	}

	decode<T>(json: string): T {
		const bytes = Buffer.byteLength(json);
		if (this.value.materializedBytes + bytes > this.remaining.materializedBytes) {
			throw new RuntimeQueryError("restore_budget", "Owner materialization budget exhausted", { ...this.value });
		}
		this.value.materializedBytes += bytes;
		this.check();
		return JSON.parse(json) as T;
	}

	finish(value: unknown, changes: number): RuntimeWork {
		this.value.changes = changes;
		this.check();
		for (;;) {
			const bytes = Buffer.byteLength(JSON.stringify(value));
			if (bytes === this.value.bytes) break;
			this.value.bytes = bytes;
		}
		if (this.value.bytes > this.remaining.bytes || changes > this.remaining.changes) {
			throw new RuntimeQueryError("restore_budget", "Owner result budget exceeded", { ...this.value });
		}
		return { ...this.value };
	}
}

export async function runtimeMeta(sql: RuntimeSql): Promise<{ epoch: string; generation: number; watermark: number }> {
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

export function runtimeAuthorized(identity: RuntimeIdentityRow, access: RuntimeAccess): boolean {
	return (
		identity.principal_id === access.principalId ||
		(identity.principal_id === "" &&
			Boolean(access.authorizedAgentInstanceRefs?.includes(identity.agent_instance_ref)))
	);
}

export async function runtimeIdentity(
	sql: RuntimeSql,
	agentInstanceRef: string,
	access: RuntimeAccess,
): Promise<RuntimeIdentityRow> {
	const rows = (await sql.unsafe("SELECT * FROM engine_agent_identity WHERE agent_instance_ref=?", [
		agentInstanceRef,
	])) as RuntimeIdentityRow[];
	const identity = rows[0];
	if (!access.principalId || !identity || !runtimeAuthorized(identity, access)) {
		throw new EngineTargetError("agent_not_found", "Unknown authorized AgentInstance");
	}
	return identity;
}

export async function runtimeNativeTarget(
	sql: RuntimeSql,
	request: RuntimeTargetRequest,
): Promise<Record<string, unknown>> {
	validateRuntimeValue("nativeTargetRequest", request);
	const identity = await runtimeIdentity(sql, request.agentInstanceRef, request);
	if (request.rootAgentInstanceRef && identity.root_agent_instance_ref !== request.rootAgentInstanceRef) {
		throw new EngineTargetError("stale_target", "Target is not a member of the authorized root");
	}
	const meta = await runtimeMeta(sql);
	const common = {
		agentInstanceRef: identity.agent_instance_ref,
		agentInstanceId: identity.agent_instance_id,
		currentEngineGeneration: meta.generation,
		intentRevision: Number(identity.intent_revision),
		authorityGeneration: Number(identity.authority_generation),
	};
	const attempts = (await sql.unsafe(
		`SELECT a.* FROM engine_attempts a
		LEFT JOIN engine_runtime_bindings b ON b.agent_instance_id=a.agent_instance_id
		WHERE a.agent_instance_id=? AND ${request.attemptId ? "a.attempt_id=?" : "a.attempt_id=b.attempt_id"} LIMIT 1`,
		[identity.agent_instance_id, ...(request.attemptId ? [request.attemptId] : [])],
	)) as RuntimeTargetRow[];
	const attempt = attempts[0];
	if (attempt) {
		if (request.executionId && request.executionId !== attempt.execution_id)
			throw new EngineTargetError("stale_target", "Execution no longer matches the exact Attempt");
		const starts = (await sql.unsafe(
			"SELECT command_id,json_extract(serialized_command,'$.payload.expectedIntentRevision') AS expected FROM engine_commands WHERE operation='start' AND attempt_id=? AND agent_instance_id=? LIMIT 1",
			[attempt.attempt_id, identity.agent_instance_id],
		)) as Array<{ command_id: string; expected: number | null }>;
		const start = starts[0];
		return {
			kind: "bound",
			...common,
			attemptId: attempt.attempt_id,
			executionId: attempt.execution_id,
			authorityGeneration: Number(attempt.authority_generation),
			targetEngineGeneration: Number(attempt.engine_generation),
			bindingId: attempt.binding_id,
			bindingGeneration: Number(attempt.binding_generation),
			...(start && Number.isSafeInteger(start.expected) && Number(start.expected) >= 0
				? { startCommandId: start.command_id, startExpectedIntentRevision: Number(start.expected) }
				: {}),
		};
	}
	const pending = (await sql.unsafe(
		`SELECT command_id,attempt_id,execution_id,engine_generation,authority_generation
		FROM engine_commands WHERE agent_instance_id=? AND operation='start' AND state='received'
		${request.attemptId ? "AND attempt_id=?" : ""} ORDER BY received_at DESC LIMIT 1`,
		[identity.agent_instance_id, ...(request.attemptId ? [request.attemptId] : [])],
	)) as PendingTargetRow[];
	if (pending[0]) {
		const target = pending[0];
		const starts = (await sql.unsafe(
			"SELECT json_extract(serialized_command,'$.payload.expectedIntentRevision') AS expected FROM engine_commands WHERE command_id=?",
			[target.command_id],
		)) as Array<{ expected: number | null }>;
		if (request.executionId && request.executionId !== target.execution_id)
			throw new EngineTargetError("stale_target", "Pending execution does not match");
		return {
			kind: "pending",
			...common,
			commandId: target.command_id,
			attemptId: target.attempt_id,
			executionId: target.execution_id,
			authorityGeneration: Number(target.authority_generation),
			targetEngineGeneration: Number(target.engine_generation),
			...(Number.isSafeInteger(starts[0]?.expected) && Number(starts[0].expected) >= 0
				? { startExpectedIntentRevision: Number(starts[0].expected) }
				: {}),
		};
	}
	if (request.attemptId || request.executionId)
		throw new EngineTargetError("stale_target", "Exact Attempt is not present");
	return { kind: "registered", ...common };
}

async function summaryValue(
	sql: RuntimeSql,
	identity: RuntimeIdentityRow,
	revision: number,
): Promise<Record<string, unknown>> {
	const meta = await runtimeMeta(sql);
	const attempts = (await sql.unsafe(
		`SELECT a.* FROM engine_runtime_bindings b JOIN engine_attempts a ON a.attempt_id=b.attempt_id
		WHERE b.agent_instance_id=?`,
		[identity.agent_instance_id],
	)) as RuntimeTargetRow[];
	const attempt = attempts[0];
	const pending = (await sql.unsafe(
		`SELECT command_id,attempt_id,execution_id,engine_generation,authority_generation FROM engine_commands
		WHERE agent_instance_id=? AND operation='start' AND state='received'
		AND NOT EXISTS (SELECT 1 FROM engine_attempts a WHERE a.attempt_id=engine_commands.attempt_id)
		ORDER BY received_at DESC LIMIT 1`,
		[identity.agent_instance_id],
	)) as PendingTargetRow[];
	const held = await sql.unsafe(
		`WITH RECURSIVE ancestors(id) AS (
		SELECT ? UNION SELECT i.parent_agent_instance_id FROM engine_agent_identity i JOIN ancestors a ON i.agent_instance_id=a.id
		WHERE i.parent_agent_instance_id IS NOT NULL)
		SELECT 1 FROM engine_branch_holds h JOIN ancestors a ON h.source_agent_instance_id=a.id LIMIT 1`,
		[identity.agent_instance_id],
	);
	const queue = await sql.unsafe(
		"SELECT 1 FROM engine_inbox_items WHERE agent_instance_id=? AND disposition='pending' LIMIT 1",
		[identity.agent_instance_id],
	);
	const authority = Number(attempt?.authority_generation ?? identity.authority_generation);
	return {
		agentInstanceRef: identity.agent_instance_ref,
		rootAgentInstanceRef: identity.root_agent_instance_ref,
		parentAgentInstanceRef: identity.parent_agent_instance_ref,
		revision,
		engineGeneration: meta.generation,
		authorityGeneration: authority,
		state: attempt?.state ?? "registered",
		target: {
			agentInstanceRef: identity.agent_instance_ref,
			intentRevision: Number(identity.intent_revision),
			authorityGeneration: authority,
			...(attempt ? { attemptId: attempt.attempt_id, executionId: attempt.execution_id } : {}),
		},
		pendingStart: pending[0]
			? {
					agentInstanceRef: identity.agent_instance_ref,
					intentRevision: Number(identity.intent_revision),
					authorityGeneration: Number(pending[0].authority_generation),
					attemptId: pending[0].attempt_id,
					executionId: pending[0].execution_id,
				}
			: null,
		outcome: attempt && TERMINAL.has(attempt.state) ? attempt.state : null,
		attention: {
			held: held.length > 0,
			needsInput: attempt?.state === "waiting_input",
			queuePending: queue.length > 0,
		},
	};
}

export async function recordRuntimeProjection(sql: RuntimeSql, event: EngineEvent): Promise<boolean> {
	const rows = (await sql.unsafe("SELECT * FROM engine_agent_identity WHERE agent_instance_id=?", [
		event.agentInstanceId,
	])) as RuntimeIdentityRow[];
	const identity = rows[0];
	if (!identity?.agent_instance_ref) return false;
	if (event.kind === "input_requested" || event.kind === "tool_approval_requested") {
		const body = runtimeInputBody(event);
		const preview = runtimeInputPreview(body);
		await sql.unsafe(
			"INSERT INTO engine_runtime_inputs(attempt_id,input_id,kind,created_event_id) VALUES (?,?,?,?)",
			[event.attemptId, String(body.inputId), String(body.kind), event.eventId],
		);
		await sql.unsafe("UPDATE engine_event_outbox SET input_body=?,input_preview=? WHERE event_id=?", [
			JSON.stringify(body),
			JSON.stringify(preview),
			event.eventId,
		]);
		await sql.unsafe("UPDATE engine_attempts SET input_revision=? WHERE attempt_id=?", [
			event.eventId,
			event.attemptId,
		]);
	} else if (event.kind === "input_resolved" || event.kind === "tool_approval_resolved") {
		await sql.unsafe(
			"UPDATE engine_runtime_inputs SET resolved_event_id=? WHERE attempt_id=? AND input_id=? AND resolved_event_id IS NULL",
			[event.eventId, event.attemptId, String(event.payload?.inputId ?? event.payload?.approvalId)],
		);
		await sql.unsafe("UPDATE engine_attempts SET input_revision=? WHERE attempt_id=?", [
			event.eventId,
			event.attemptId,
		]);
	}
	let membership: Record<string, unknown> | undefined;
	if (!identity.root_agent_instance_ref || !identity.membership_revision) {
		const parents = identity.parent_agent_instance_id
			? ((await sql.unsafe(
					"SELECT agent_instance_ref,root_agent_instance_ref FROM engine_agent_identity WHERE agent_instance_id=?",
					[identity.parent_agent_instance_id],
				)) as Array<{ agent_instance_ref: string; root_agent_instance_ref: string }>)
			: [];
		identity.parent_agent_instance_ref = parents[0]?.agent_instance_ref || identity.parent_agent_instance_ref;
		if (identity.parent_agent_instance_ref && !parents[0]?.root_agent_instance_ref) {
			throw new EngineTargetError("stale_target", "Parent ancestry must be enrolled before child projection");
		}
		identity.root_agent_instance_ref = parents[0]?.root_agent_instance_ref || identity.agent_instance_ref;
		identity.membership_revision = event.eventId;
		await sql.unsafe(
			`UPDATE engine_agent_identity SET root_agent_instance_ref=?,parent_agent_instance_ref=?,membership_revision=? WHERE agent_instance_id=?`,
			[
				identity.root_agent_instance_ref,
				identity.parent_agent_instance_ref,
				event.eventId,
				identity.agent_instance_id,
			],
		);
		membership = {
			agentInstanceRef: identity.agent_instance_ref,
			rootAgentInstanceRef: identity.root_agent_instance_ref,
			parentAgentInstanceRef: identity.parent_agent_instance_ref,
			revision: event.eventId,
		};
		validateRuntimeValue("membership", membership);
	}
	let summary: Record<string, unknown> | undefined;
	if (SUMMARY_EVENTS.has(event.kind) || !identity.summary_json) {
		const current = await summaryValue(sql, identity, Math.max(1, Number(identity.summary_revision)));
		if (!identity.summary_json || JSON.stringify(current) !== identity.summary_json) {
			summary = { ...current, revision: event.eventId };
			validateRuntimeValue("agentSummary", summary);
			await sql.unsafe(
				"UPDATE engine_agent_identity SET summary_revision=?,summary_json=? WHERE agent_instance_id=?",
				[event.eventId, JSON.stringify(summary), identity.agent_instance_id],
			);
		}
	}
	const changes: RuntimeChange[] = [];
	let detail: Record<string, unknown> | undefined;
	let kinds = 0;
	if (event.kind === "message_updated") {
		const value = await recordRuntimeMessage(sql, event, identity.agent_instance_ref);
		changes.push(
			projectionChange(
				"assistant",
				identity.agent_instance_ref,
				event.eventId,
				Number(value.revision),
				value,
				event.attemptId,
			),
		);
		kinds |= RUNTIME_KIND_MASK.assistant;
	}
	if (SUMMARY_EVENTS.has(event.kind)) {
		const attempts = (await sql.unsafe("SELECT * FROM engine_attempts WHERE attempt_id=? AND agent_instance_id=?", [
			event.attemptId,
			identity.agent_instance_id,
		])) as RuntimeTargetRow[];
		detail = await runtimeDetail(sql, identity, attempts[0], event.eventId);
		validateRuntimeValue("detailState", detail);
		if (attempts[0]) {
			await sql.unsafe("UPDATE engine_attempts SET detail_revision=? WHERE attempt_id=?", [
				event.eventId,
				event.attemptId,
			]);
		}
		changes.push(projectionChange("state", identity.agent_instance_ref, event.eventId, event.eventId, detail));
		kinds |= RUNTIME_KIND_MASK.state;
	}
	const resource =
		event.kind === "inbox_changed"
			? "queue"
			: event.kind.startsWith("input_") || event.kind.startsWith("tool_approval_")
				? "input"
				: event.kind === "holds_changed"
					? "holds"
					: undefined;
	if (resource && (detail?.attemptId || resource === "queue" || resource === "holds")) {
		const revision =
			resource === "queue"
				? Number(identity.queue_revision)
				: resource === "holds"
					? Number(identity.intent_revision)
					: event.eventId;
		changes.push(
			projectionChange(
				"invalidate",
				identity.agent_instance_ref,
				event.eventId,
				event.eventId,
				{ resource, revision },
				resource === "input" ? event.attemptId : undefined,
			),
		);
		kinds |=
			resource === "queue"
				? RUNTIME_KIND_MASK.queue
				: resource === "input"
					? RUNTIME_KIND_MASK.input
					: RUNTIME_KIND_MASK.state;
	}
	await sql.unsafe(
		`UPDATE engine_event_outbox SET summary_payload=?,membership_payload=?,detail_payload=?,projection_payload=?,projection_kinds=?,projection_principal=?,projection_root=? WHERE event_id=?`,
		[
			summary ? JSON.stringify(summary) : null,
			membership ? JSON.stringify(membership) : null,
			detail ? JSON.stringify(detail) : null,
			changes.length ? JSON.stringify(changes) : null,
			kinds,
			identity.principal_id,
			identity.root_agent_instance_ref,
			event.eventId,
		],
	);
	return Boolean(summary);
}

export function projectionChange(
	kind: RuntimeChange["kind"],
	agentInstanceRef: string,
	cursor: number,
	revision: number,
	value: Record<string, unknown>,
	attemptId?: string,
): RuntimeChange {
	const change: RuntimeChange = {
		kind,
		agentInstanceRef,
		cursor,
		revision,
		value,
		...(attemptId ? { attemptId } : {}),
	};
	validateRuntimeValue("change", change);
	return change;
}
