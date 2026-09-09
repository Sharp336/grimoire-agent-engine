import { EngineTargetError } from "./contracts";
import type { RuntimeSql } from "./runtime-projection";
import { runtimeLimits } from "./runtime-protocol";

/** Derived admission metadata; canonical commands and inbox items stay in their owner tables. */
export const RUNTIME_PENDING_SCHEMA = [
	"ALTER TABLE engine_agent_identity ADD COLUMN queue_pending_count INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE engine_commands ADD COLUMN control_admission INTEGER NOT NULL DEFAULT 0 CHECK(control_admission IN (0,1))",
	"UPDATE engine_commands SET control_admission=1 WHERE operation IN ('pause','resume','cancel','resolve_input','resolve_tool_approval')",
	"CREATE INDEX engine_pending_command_budget_idx ON engine_commands(control_admission,agent_instance_id,command_id,payload_bytes) WHERE state='received'",
	"CREATE INDEX engine_pending_inbox_budget_idx ON engine_inbox_items(agent_instance_id,queue_id) WHERE disposition='pending'",
	"UPDATE engine_agent_identity SET queue_pending_count=(SELECT COUNT(*) FROM engine_inbox_items WHERE agent_instance_id=engine_agent_identity.agent_instance_id AND disposition='pending')",
	`CREATE TRIGGER engine_pending_identity_insert AFTER INSERT ON engine_agent_identity BEGIN
	 UPDATE engine_agent_identity SET queue_pending_count=(SELECT COUNT(*) FROM engine_inbox_items WHERE agent_instance_id=NEW.agent_instance_id AND disposition='pending') WHERE agent_instance_id=NEW.agent_instance_id; END`,
	`CREATE TRIGGER engine_pending_inbox_insert AFTER INSERT ON engine_inbox_items WHEN NEW.disposition='pending' BEGIN
	 UPDATE engine_agent_identity SET queue_pending_count=queue_pending_count+1 WHERE agent_instance_id=NEW.agent_instance_id; END`,
	`CREATE TRIGGER engine_pending_inbox_delete AFTER DELETE ON engine_inbox_items WHEN OLD.disposition='pending' BEGIN
	 UPDATE engine_agent_identity SET queue_pending_count=queue_pending_count-1 WHERE agent_instance_id=OLD.agent_instance_id; END`,
	`CREATE TRIGGER engine_pending_inbox_update AFTER UPDATE OF disposition,agent_instance_id ON engine_inbox_items
	 WHEN OLD.disposition<>NEW.disposition OR OLD.agent_instance_id<>NEW.agent_instance_id BEGIN
	 UPDATE engine_agent_identity SET queue_pending_count=queue_pending_count-1 WHERE agent_instance_id=OLD.agent_instance_id AND OLD.disposition='pending';
	 UPDATE engine_agent_identity SET queue_pending_count=queue_pending_count+1 WHERE agent_instance_id=NEW.agent_instance_id AND NEW.disposition='pending'; END`,
] as const;

interface PendingTotal {
	records: number;
	bytes: number;
}

async function pendingTotal(
	sql: RuntimeSql,
	control: boolean,
	limit: number,
	excludingCommandId: string,
	agentInstanceId?: string,
): Promise<PendingTotal> {
	const commands = (await sql.unsafe(
		`SELECT COUNT(*) AS records,COALESCE(SUM(payload_bytes),0) AS bytes FROM (
		 SELECT payload_bytes FROM engine_commands INDEXED BY engine_pending_command_budget_idx
		 WHERE state='received' AND control_admission=? AND command_id<>? ${agentInstanceId ? "AND agent_instance_id=?" : ""} LIMIT ?)`,
		[control ? 1 : 0, excludingCommandId, ...(agentInstanceId ? [agentInstanceId] : []), limit + 1],
	)) as PendingTotal[];
	const total = { records: Number(commands[0].records), bytes: Number(commands[0].bytes) };
	if (control || total.records > limit) return total;
	const inbox = (await sql.unsafe(
		`SELECT COUNT(*) AS records,COALESCE(SUM(bytes),0) AS bytes FROM (
		 SELECT octet_length(delivery_payload)+COALESCE(octet_length(annotation),0) AS bytes
		 FROM engine_inbox_items INDEXED BY engine_pending_inbox_budget_idx
		 WHERE disposition='pending' ${agentInstanceId ? "AND agent_instance_id=?" : ""} LIMIT ?)`,
		[...(agentInstanceId ? [agentInstanceId] : []), limit - total.records + 1],
	)) as PendingTotal[];
	return { records: total.records + Number(inbox[0].records), bytes: total.bytes + Number(inbox[0].bytes) };
}

export async function assertRuntimePendingBudget(
	sql: RuntimeSql,
	agentInstanceId: string,
	bytes: number,
	control = false,
	excludingCommandId = "",
	recordsDelta = 1,
): Promise<void> {
	const recordLimit = control ? runtimeLimits.controlPendingRecords : runtimeLimits.devicePendingRecords;
	const device = await pendingTotal(sql, control, recordLimit, excludingCommandId);
	if (
		device.records + recordsDelta > recordLimit ||
		device.bytes + bytes > (control ? runtimeLimits.controlPendingBytes : runtimeLimits.devicePendingBytes)
	)
		throw new EngineTargetError("queue_full", "Device pending admission budget is full");
	if (control) return;
	const agent = await pendingTotal(sql, false, runtimeLimits.agentPendingRecords, excludingCommandId, agentInstanceId);
	if (
		agent.records + recordsDelta > runtimeLimits.agentPendingRecords ||
		agent.bytes + bytes > runtimeLimits.agentPendingBytes
	)
		throw new EngineTargetError("queue_full", "AgentInstance pending admission budget is full");
}
