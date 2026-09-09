import { EngineTargetError } from "./contracts";
import type { RuntimeSql } from "./runtime-projection";
import { runtimeLimits } from "./runtime-protocol";

/** A trusted delivery reference to one immutable Start, never a replacement for general intent CAS. */
export interface EngineStartFence {
	pendingStartCommandId?: string;
	expectedStartIntentRevision?: number;
	principalId?: string;
}

export interface EnginePendingStartTarget extends EngineStartFence {
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	authorityGeneration: number;
	engineGeneration: number;
	expectedIntentRevision?: number;
}

export interface EngineStartRow {
	command_id: string;
	canonical_hash: string;
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	authority_generation: number;
	engine_generation: number;
	principal_id: string;
	expected: number | null;
	start_applied_intent_revision: number | null;
	state: "received" | "settled";
	receipt: string | null;
	receipt_bytes: number;
	source_unavailable: number;
	source_bytes: number;
}

const startSourceBytes =
	runtimeLimits.bootstrapMaterializedBytes - runtimeLimits.liveChangeBytes - runtimeLimits.bulkPreviewBytes;

export async function readStartExpectedRevision(sql: RuntimeSql, commandId: string): Promise<number | null> {
	const rows = (await sql.unsafe(
		`SELECT CASE WHEN OCTET_LENGTH(serialized_command)<=${startSourceBytes} THEN json_extract(serialized_command,'$.payload.expectedIntentRevision') END AS expected,
		 COALESCE(OCTET_LENGTH(serialized_command),0)>${startSourceBytes} AS source_unavailable FROM engine_commands WHERE command_id=?`,
		[commandId],
	)) as Array<{ expected: number | null; source_unavailable: number }>;
	if (rows[0]?.source_unavailable)
		throw new EngineTargetError("source_unavailable", "Exact Start revision exceeds its native read budget");
	return rows[0]?.expected ?? null;
}

export const START_FENCE_SCHEMA = [
	"ALTER TABLE engine_commands ADD COLUMN start_applied_intent_revision INTEGER",
	`CREATE TABLE engine_start_cancellations(
	 start_command_id TEXT PRIMARY KEY,agent_instance_id TEXT NOT NULL,execution_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
	 authority_generation INTEGER NOT NULL,principal_id TEXT NOT NULL,expected_start_intent_revision INTEGER NOT NULL,
	 cancellation_command_id TEXT NOT NULL,created_at INTEGER NOT NULL)`,
] as const;

export function validateStartFence(target: EngineStartFence): boolean {
	const hasId = target.pendingStartCommandId !== undefined;
	const hasRevision = target.expectedStartIntentRevision !== undefined;
	if (
		hasId !== hasRevision ||
		(hasId &&
			(!target.pendingStartCommandId?.trim() ||
				!Number.isSafeInteger(target.expectedStartIntentRevision) ||
				target.expectedStartIntentRevision! < 0))
	)
		throw new EngineTargetError("invalid_request", "Start cancellation reference requires both command and revision");
	return hasId;
}

export async function readTargetStart(
	sql: RuntimeSql,
	target: EnginePendingStartTarget,
	sourceBudgetBytes = startSourceBytes,
): Promise<EngineStartRow | undefined> {
	const sourceLimit = Math.max(0, Math.min(startSourceBytes, sourceBudgetBytes));
	const rows = (await sql.unsafe(
		`SELECT command_id,canonical_hash,agent_instance_id,execution_id,attempt_id,authority_generation,engine_generation,
		principal_id,CASE WHEN OCTET_LENGTH(serialized_command)<=${sourceLimit} THEN json_extract(serialized_command,'$.payload.expectedIntentRevision') END AS expected,
		COALESCE(OCTET_LENGTH(serialized_command),0)>${sourceLimit} AS source_unavailable,
		COALESCE(OCTET_LENGTH(serialized_command),0) AS source_bytes,
		start_applied_intent_revision,state,OCTET_LENGTH(receipt) AS receipt_bytes,
		CASE WHEN OCTET_LENGTH(receipt)<=${runtimeLimits.liveChangeBytes} THEN receipt END AS receipt FROM engine_commands
		WHERE operation='start' AND ${target.pendingStartCommandId ? "command_id=?" : "agent_instance_id=? AND execution_id=? AND attempt_id=?"}
		ORDER BY received_at DESC LIMIT 1`,
		target.pendingStartCommandId
			? [target.pendingStartCommandId]
			: [target.agentInstanceId, target.executionId, target.attemptId],
	)) as EngineStartRow[];
	const start = rows[0];
	if (start) {
		if (
			start.agent_instance_id !== target.agentInstanceId ||
			start.execution_id !== target.executionId ||
			start.attempt_id !== target.attemptId ||
			Number(start.authority_generation) !== target.authorityGeneration ||
			Number(start.engine_generation) > target.engineGeneration ||
			(target.principalId !== undefined && start.principal_id !== target.principalId)
		)
			throw new EngineTargetError(
				"stale_target",
				"Start cancellation reference does not match its immutable target",
			);
		if (start.source_unavailable)
			throw new EngineTargetError("source_unavailable", "Exact Start revision exceeds its native read budget");
		if (target.expectedStartIntentRevision !== undefined && start.expected !== target.expectedStartIntentRevision)
			throw new EngineTargetError(
				"stale_target",
				"Start cancellation reference does not match its immutable target",
			);
	}
	return start;
}

export async function cancelIntentRevision(
	sql: RuntimeSql,
	target: EnginePendingStartTarget,
	knownStart?: EngineStartRow | null,
): Promise<number | undefined> {
	if (!validateStartFence(target)) return target.expectedIntentRevision;
	const start = knownStart === undefined ? await readTargetStart(sql, target) : knownStart;
	const rows = (await sql.unsafe("SELECT intent_revision FROM engine_agent_identity WHERE agent_instance_id=?", [
		target.agentInstanceId,
	])) as Array<{ intent_revision: number }>;
	const current = Number(rows[0]?.intent_revision ?? -1);
	if (target.expectedIntentRevision === current) return current;
	if (
		start &&
		target.expectedIntentRevision === target.expectedStartIntentRevision &&
		start.start_applied_intent_revision !== null &&
		current === Number(start.start_applied_intent_revision)
	)
		return current;
	throw new EngineTargetError("stale_target", "Intent changed after the exact Start admission");
}

export async function writeStartCancellation(
	sql: RuntimeSql,
	target: EnginePendingStartTarget,
	cancellationCommandId: string,
): Promise<void> {
	if (!validateStartFence(target)) return;
	const existing = await sql.unsafe("SELECT * FROM engine_start_cancellations WHERE start_command_id=?", [
		target.pendingStartCommandId!,
	]);
	if (
		existing[0] &&
		(existing[0].agent_instance_id !== target.agentInstanceId ||
			existing[0].execution_id !== target.executionId ||
			existing[0].attempt_id !== target.attemptId ||
			Number(existing[0].authority_generation) !== target.authorityGeneration ||
			existing[0].principal_id !== (target.principalId ?? "") ||
			Number(existing[0].expected_start_intent_revision) !== target.expectedStartIntentRevision)
	)
		throw new EngineTargetError("stale_target", "Start cancellation reference was already bound to another target");
	await sql.unsafe(
		`INSERT INTO engine_start_cancellations(start_command_id,agent_instance_id,execution_id,attempt_id,authority_generation,
		principal_id,expected_start_intent_revision,cancellation_command_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT(start_command_id) DO NOTHING`,
		[
			target.pendingStartCommandId!,
			target.agentInstanceId,
			target.executionId,
			target.attemptId,
			target.authorityGeneration,
			target.principalId ?? "",
			target.expectedStartIntentRevision!,
			cancellationCommandId,
			Date.now(),
		],
	);
}

export async function startCancellation(sql: RuntimeSql, start: EngineStartRow): Promise<string | undefined> {
	const rows = (await sql.unsafe("SELECT * FROM engine_start_cancellations WHERE start_command_id=?", [
		start.command_id,
	])) as Array<{
		agent_instance_id: string;
		execution_id: string;
		attempt_id: string;
		authority_generation: number;
		principal_id: string;
		expected_start_intent_revision: number;
		cancellation_command_id: string;
	}>;
	const fence = rows[0];
	if (!fence) return undefined;
	if (
		fence.agent_instance_id !== start.agent_instance_id ||
		fence.execution_id !== start.execution_id ||
		fence.attempt_id !== start.attempt_id ||
		Number(fence.authority_generation) !== Number(start.authority_generation) ||
		fence.principal_id !== start.principal_id ||
		fence.expected_start_intent_revision !== start.expected
	)
		throw new EngineTargetError("stale_target", "Start conflicts with its durable cancellation reference");
	return fence.cancellation_command_id;
}
