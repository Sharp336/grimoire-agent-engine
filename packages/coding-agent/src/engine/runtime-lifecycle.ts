import { type EngineEvent, EngineTargetError } from "./contracts";
import { RuntimeQueryWork, type RuntimeSql } from "./runtime-projection";
import { type RuntimeRemainingWork, runtimeLimits, validateRuntimeValue } from "./runtime-protocol";

const lifecycleKinds = {
	running: ["started", "Attempt started"],
	paused: ["paused", "Paused"],
	resumed: ["running", "Resumed"],
	input_requested: ["waiting", "Needs input"],
	input_resolved: ["running", "Input received"],
	retry_scheduled: ["waiting", "Retry scheduled"],
	retry_settled: ["settled", "Retry settled"],
	interrupted: ["failed", "Interrupted"],
	completed: ["succeeded", "Completed"],
	cancelled: ["cancelled", "Stopped"],
	failed: ["failed", "Failed"],
	rejected: ["failed", "Command rejected"],
} as const;
const kindsSql = Object.keys(lifecycleKinds)
	.map(kind => `'${kind}'`)
	.join(",");
const summarySql =
	"substr(CASE WHEN json_type(payload,'$.retry')='object' THEN trim(CASE WHEN json_type(payload,'$.retry.attempt')='integer' THEN 'attempt '||json_extract(payload,'$.retry.attempt')||'/'||COALESCE(json_extract(payload,'$.retry.maxAttempts'),'undefined')||' · ' ELSE '' END||CASE WHEN json_type(payload,'$.retry.route')='text' THEN substr(json_extract(payload,'$.retry.route'),1,300)||' · ' ELSE '' END||COALESCE(json_extract(payload,'$.retry.error'),''),' · ') ELSE COALESCE(json_extract(payload,'$.error.message'),CASE WHEN json_type(payload,'$.error')='text' THEN json_extract(payload,'$.error') END,'') END,1,500)";

export const RUNTIME_LIFECYCLE_SCHEMA = [
	"ALTER TABLE engine_history_entries ADD COLUMN source_command_id TEXT",
	"ALTER TABLE engine_history_entries ADD COLUMN assistant_message_id TEXT",
	"UPDATE engine_history_entries SET source_command_id=json_extract(entry_json,'$.sourceCommandId'),assistant_message_id=json_extract(entry_json,'$.assistantMessageId') WHERE entry_type='message'",
	"CREATE TRIGGER engine_history_identity_insert AFTER INSERT ON engine_history_entries WHEN NEW.entry_type='message' BEGIN UPDATE engine_history_entries SET source_command_id=json_extract(NEW.entry_json,'$.sourceCommandId'),assistant_message_id=json_extract(NEW.entry_json,'$.assistantMessageId') WHERE session_path=NEW.session_path AND entry_id=NEW.entry_id; END",
	"CREATE TRIGGER engine_history_identity_update AFTER UPDATE OF entry_json ON engine_history_entries WHEN NEW.entry_type='message' BEGIN UPDATE engine_history_entries SET source_command_id=json_extract(NEW.entry_json,'$.sourceCommandId'),assistant_message_id=json_extract(NEW.entry_json,'$.assistantMessageId') WHERE session_path=NEW.session_path AND entry_id=NEW.entry_id; END",
	"ALTER TABLE engine_event_outbox ADD COLUMN lifecycle_summary TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN history_assistant_id TEXT",
	`UPDATE engine_event_outbox SET lifecycle_summary=${summarySql} WHERE kind IN (${kindsSql}) AND payload IS NOT NULL`,
	"UPDATE engine_event_outbox SET history_assistant_id=json_extract(payload,'$.assistantMessageId') WHERE kind='assistant_snapshot' AND payload IS NOT NULL",
	`CREATE INDEX engine_lifecycle_page_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE kind IN (${kindsSql})`,
	"CREATE INDEX engine_history_command_event_idx ON engine_event_outbox(agent_instance_id,causation_command_id,event_id)",
	"CREATE INDEX engine_history_assistant_event_idx ON engine_event_outbox(agent_instance_id,history_assistant_id,event_id) WHERE history_assistant_id IS NOT NULL",
	"CREATE INDEX engine_history_message_owner_idx ON engine_runtime_messages(agent_instance_id,message_id)",
] as const;

export function lifecycleSummary(event: Pick<EngineEvent, "kind" | "payload">): string | null {
	if (!Object.hasOwn(lifecycleKinds, event.kind)) return null;
	const value = event.payload ?? {};
	const retry = value.retry as { attempt?: number; maxAttempts?: number; route?: string; error?: string } | undefined;
	if (retry)
		return [
			retry.attempt === undefined ? "" : `attempt ${retry.attempt}/${retry.maxAttempts}`,
			retry.route,
			retry.error,
		]
			.filter(Boolean)
			.join(" · ")
			.slice(0, 500);
	const error = value.error;
	return (
		typeof error === "string"
			? error
			: error && typeof error === "object" && "message" in error
				? String(error.message)
				: ""
	).slice(0, 500);
}

export interface HistoryLifecycleContext {
	agentInstanceId: string;
	sessionPath: string;
	sessionId: string;
	lineage: string;
	anchor: string | null;
	first: string | null;
	count: number;
	currentAttemptId: string | null;
	targetAttemptId: string | null;
	watermark: number;
}

interface LifecycleCursor {
	kind: "lifecycle";
	context: HistoryLifecycleContext;
	before: number;
}

function continuation(context: HistoryLifecycleContext, before: number): string {
	return Buffer.from(JSON.stringify({ kind: "lifecycle", context, before } satisfies LifecycleCursor)).toString(
		"base64url",
	);
}

export function readLifecycleCursor(cursor: string): LifecycleCursor {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as LifecycleCursor;
		if (
			value.kind !== "lifecycle" ||
			!value.context ||
			![
				value.context.agentInstanceId,
				value.context.sessionPath,
				value.context.sessionId,
				value.context.lineage,
			].every(field => typeof field === "string" && field.length > 0 && field.length <= 4000) ||
			![
				value.context.anchor,
				value.context.first,
				value.context.currentAttemptId,
				value.context.targetAttemptId,
			].every(field => field === null || (typeof field === "string" && field.length > 0 && field.length <= 200)) ||
			(value.context.targetAttemptId !== null && value.context.targetAttemptId !== value.context.currentAttemptId) ||
			(value.context.count > 0 && value.context.first === null) ||
			!Number.isSafeInteger(value.before) ||
			value.before < 1 ||
			!Number.isSafeInteger(value.context.count) ||
			value.context.count < 0 ||
			value.context.count > runtimeLimits.httpPageRecords ||
			!Number.isSafeInteger(value.context.watermark) ||
			value.context.watermark < 0 ||
			value.before > value.context.watermark + 1
		)
			throw new Error("Invalid lifecycle cursor");
		return value;
	} catch {
		throw new EngineTargetError("stale_target", "Invalid lifecycle continuation");
	}
}

interface HistoryIdentityRow {
	entry_id: string;
	parent_entry_id: string | null;
	entry_role: string | null;
	source_command_id: string | null;
	assistant_message_id: string | null;
}
interface LifecycleRow {
	event_id: number;
	seq: number;
	attempt_id: string;
	execution_id: string;
	causation_command_id: string;
	kind: keyof typeof lifecycleKinds;
	created_at: number;
	lifecycle_summary: string | null;
}

export async function readHistoryLifecycle(
	sql: RuntimeSql,
	agentInstanceRef: string,
	context: HistoryLifecycleContext,
	limit: number,
	before = context.watermark + 1,
	maxBytes = runtimeLimits.httpPageBytes,
	remaining?: RuntimeRemainingWork,
): Promise<{
	activities: Record<string, unknown>[];
	activityNextCursor: string | null;
	work: RuntimeQueryWork["value"];
}> {
	const work = new RuntimeQueryWork(
		remaining ?? {
			bytes: runtimeLimits.httpPageBytes,
			changes: runtimeLimits.httpPageRecords,
			scannedRows: runtimeLimits.bootstrapScannedRows,
			materializedBytes: runtimeLimits.bootstrapMaterializedBytes,
			timeMs: runtimeLimits.bootstrapTimeoutMs,
		},
	);
	// The native entry page may consume the initial record/work allowance. Keep a
	// pinned continuation instead of starting a second, unbounded traversal.
	if (limit === 0) {
		const result = { activities: [], activityNextCursor: continuation(context, before) };
		work.finish(result, 0);
		return { ...result, work: work.value };
	}
	const sessions = (await sql.unsafe(
		"SELECT h.entry_id,f.history_lineage FROM engine_history_entries h JOIN omp_session_files f ON f.path=h.session_path WHERE h.session_path=? AND h.entry_type='session' ORDER BY ordinal LIMIT 1",
		[context.sessionPath],
	)) as Array<{ entry_id: string; history_lineage: string }>;
	work.rows(sessions.length);
	if (sessions[0]?.entry_id !== context.sessionId || sessions[0]?.history_lineage !== context.lineage)
		throw new EngineTargetError("stale_target", "Lifecycle session lineage changed");
	if (context.anchor) {
		const anchor = await sql.unsafe(
			"SELECT entry_id FROM engine_history_entries WHERE session_path=? AND entry_id=?",
			[context.sessionPath, context.anchor],
		);
		work.rows(anchor.length);
		if (!anchor.length) throw new EngineTargetError("history_expired", "Pinned lifecycle history anchor expired");
	}
	const rows =
		context.first && context.count
			? ((await sql.unsafe(
					`WITH RECURSIVE branch(entry_id,parent_entry_id,entry_role,source_command_id,assistant_message_id,depth) AS (
		SELECT entry_id,parent_entry_id,entry_role,source_command_id,assistant_message_id,1 FROM engine_history_entries WHERE session_path=? AND entry_id=?
		UNION ALL SELECT h.entry_id,h.parent_entry_id,h.entry_role,h.source_command_id,h.assistant_message_id,b.depth+1 FROM engine_history_entries h JOIN branch b ON h.entry_id=b.parent_entry_id WHERE h.session_path=? AND b.depth<?)
		SELECT * FROM branch ORDER BY depth DESC`,
					[context.sessionPath, context.first, context.sessionPath, context.count],
				)) as HistoryIdentityRow[])
			: [];
	work.rows(rows.length);
	work.value.materializedBytes += Buffer.byteLength(JSON.stringify(rows));
	work.check();
	const anchors = new Map<string, string[]>();
	if (context.currentAttemptId) anchors.set(context.currentAttemptId, []);
	for (const row of rows) {
		let matches: Array<{ attempt_id: string }> = [];
		if (row.source_command_id)
			matches = (await sql.unsafe(
				"SELECT attempt_id FROM engine_event_outbox WHERE agent_instance_id=? AND causation_command_id=? AND event_id<=? AND attempt_id<>'' ORDER BY event_id DESC LIMIT 1",
				[context.agentInstanceId, row.source_command_id, context.watermark],
			)) as Array<{ attempt_id: string }>;
		else if (row.assistant_message_id) {
			matches = (await sql.unsafe(
				"SELECT attempt_id FROM engine_runtime_messages WHERE agent_instance_id=? AND message_id=? AND created_event_id<=? LIMIT 1",
				[context.agentInstanceId, row.assistant_message_id, context.watermark],
			)) as Array<{ attempt_id: string }>;
			if (!matches.length)
				matches = (await sql.unsafe(
					"SELECT attempt_id FROM engine_event_outbox WHERE agent_instance_id=? AND history_assistant_id=? AND event_id<=? ORDER BY event_id DESC LIMIT 1",
					[context.agentInstanceId, row.assistant_message_id, context.watermark],
				)) as Array<{ attempt_id: string }>;
		}
		work.rows(matches.length);
		work.value.materializedBytes += Buffer.byteLength(JSON.stringify(matches));
		work.check();
		const attempt = matches[0]?.attempt_id;
		if (!attempt) continue;
		const entries = anchors.get(attempt) ?? [];
		if (row.entry_role === "user" || row.entry_role === "assistant") entries.push(row.entry_id);
		anchors.set(attempt, entries);
	}
	const readEvent = async (attempt: string, prior: number): Promise<LifecycleRow | undefined> => {
		const rows = (await sql.unsafe(
			`SELECT event_id,seq,attempt_id,execution_id,causation_command_id,kind,created_at,lifecycle_summary FROM engine_event_outbox WHERE agent_instance_id=? AND attempt_id=? AND kind IN (${kindsSql}) AND event_id<? ORDER BY event_id DESC LIMIT 1`,
			[context.agentInstanceId, attempt, prior],
		)) as LifecycleRow[];
		work.rows(rows.length);
		work.value.materializedBytes += Buffer.byteLength(JSON.stringify(rows));
		work.check();
		return rows[0];
	};
	const pending: LifecycleRow[] = [];
	for (const attempt of anchors.keys()) {
		const row = await readEvent(attempt, before);
		if (row) pending.push(row);
	}
	const activities: Record<string, unknown>[] = [];
	let nextBefore = before;
	let emittedBytes = 0;
	while (pending.length && activities.length < limit) {
		pending.sort((left, right) => Number(right.event_id) - Number(left.event_id));
		const row = pending.shift()!;
		const mapped = lifecycleKinds[row.kind];
		const entryIds = anchors.get(row.attempt_id) ?? [];
		const anchor = row.kind === "running" ? entryIds[0] : entryIds.at(-1);
		const activity = {
			id: `engine:${context.sessionId}:${agentInstanceRef}:${row.attempt_id}:${row.event_id}`,
			kind: "lifecycle",
			source: "engine",
			sessionId: context.sessionId,
			agentInstanceRef,
			attemptId: row.attempt_id,
			executionId: row.execution_id,
			eventId: String(row.event_id),
			seq: Number(row.seq),
			status: mapped[0],
			label: mapped[1],
			at: Number(row.created_at),
			...(row.causation_command_id ? { causationCommandId: row.causation_command_id } : {}),
			...(row.lifecycle_summary ? { summary: row.lifecycle_summary } : {}),
			...(anchor ? { afterEntryId: anchor } : {}),
		};
		work.value.materializedBytes += Buffer.byteLength(JSON.stringify(activity));
		work.check();
		validateRuntimeValue("lifecycleActivity", activity);
		const bytes = Buffer.byteLength(JSON.stringify(activity));
		if (emittedBytes + bytes > maxBytes) {
			pending.unshift(row);
			break;
		}
		emittedBytes += bytes;
		nextBefore = Number(row.event_id);
		activities.push(activity);
		const next = await readEvent(row.attempt_id, nextBefore);
		if (next) pending.push(next);
	}
	const result = {
		activities: activities.reverse(),
		activityNextCursor: pending.length ? continuation(context, nextBefore) : null,
	};
	work.finish(result, activities.length);
	return { ...result, work: work.value };
}
