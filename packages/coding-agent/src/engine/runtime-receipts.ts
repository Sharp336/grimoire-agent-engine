import type { EngineInboxItem } from "./contracts";
import type { RuntimeSql } from "./runtime-projection";
import { runtimeLimits, validateRuntimeValue } from "./runtime-protocol";
import { publicRuntimeQueueItem } from "./runtime-queue";
import type { EngineCommandReceipt } from "./store";

export interface StoredReceiptRow {
	receipt: string | null;
	receipt_bytes: number;
	outcome: EngineCommandReceipt["outcome"] | null;
}

export function boundedStoredReceipt(row: StoredReceiptRow): EngineCommandReceipt | undefined {
	if (row.receipt_bytes > runtimeLimits.liveChangeBytes) {
		if (row.outcome !== "applied" && row.outcome !== "rejected") throw new Error("Invalid durable receipt outcome");
		return { outcome: row.outcome, detail: { partial: true, unavailable: "legacy_result_exceeds_projection_limit" } };
	}
	return row.receipt ? (JSON.parse(row.receipt) as EngineCommandReceipt) : undefined;
}

export interface RuntimeReceiptRow {
	command_id: string;
	operation: string;
	agent_instance_id: string;
	agent_instance_ref: string | null;
	attempt_id: string | null;
	execution_id: string | null;
	principal_id: string;
	stage: string;
	state: string;
	browser_payload_hash: string | null;
	browser_target: string | null;
	target_unavailable: number;
	authority_generation: number;
	intent_revision: number | null;
	receipt: string | null;
	settled_at: number | null;
	receipt_bytes: number;
	outcome: EngineCommandReceipt["outcome"] | null;
}

export async function readRuntimeReceipt(sql: RuntimeSql, commandId: string): Promise<RuntimeReceiptRow | undefined> {
	const sourceBytes =
		runtimeLimits.bootstrapMaterializedBytes - runtimeLimits.liveChangeBytes - runtimeLimits.bulkPreviewBytes;
	const rows = (await sql.unsafe(
		`SELECT c.command_id,c.operation,c.agent_instance_id,c.agent_instance_ref,c.attempt_id,c.execution_id,c.principal_id,c.state,
		c.browser_payload_hash,CASE WHEN OCTET_LENGTH(c.serialized_command)<=${sourceBytes} THEN json_extract(c.serialized_command,'$.browserTarget') END AS browser_target,
		COALESCE(OCTET_LENGTH(c.serialized_command),0)>${sourceBytes} AS target_unavailable,c.authority_generation,
		CASE WHEN OCTET_LENGTH(c.receipt)<=${runtimeLimits.liveChangeBytes} THEN c.receipt ELSE NULL END AS receipt,
		OCTET_LENGTH(c.receipt) AS receipt_bytes,c.outcome,c.settled_at,i.intent_revision,
		CASE WHEN c.outcome='rejected' THEN 'rejected' WHEN c.state<>'settled' THEN 'engine_accepted'
		WHEN c.operation='start' AND a.state IN ('completed','cancelled','failed','interrupted') THEN 'execution_terminal' ELSE 'applied' END AS stage
		FROM engine_commands c LEFT JOIN engine_agent_identity i ON i.agent_instance_id=c.agent_instance_id
		LEFT JOIN engine_attempts a ON a.attempt_id=c.attempt_id WHERE c.command_id=?`,
		[commandId],
	)) as RuntimeReceiptRow[];
	const row = rows[0];
	if (row && row.receipt_bytes > runtimeLimits.liveChangeBytes) {
		// Do not extract even a small JSON property from an oversized legacy cell.
		// Its exact queue revision may no longer exist; outcome is separately durable.
		row.receipt = JSON.stringify(boundedStoredReceipt(row));
	}
	if (row?.receipt && row.agent_instance_ref && (row.operation.startsWith("queue_") || row.operation === "enqueue")) {
		const receipt = JSON.parse(row.receipt) as { outcome: string; detail?: Record<string, unknown> };
		const detail = receipt.detail;
		if (receipt.outcome === "applied" && detail) {
			const item = (detail.item ?? (detail.queueId ? detail : undefined)) as Record<string, unknown> | undefined;
			if (item?.queueId) {
				if (typeof item.partial !== "boolean") {
					const projected = publicRuntimeQueueItem(row.agent_instance_ref, item as unknown as EngineInboxItem);
					receipt.detail = detail.item ? { ...detail, item: projected } : { item: projected };
				}
			} else if (Array.isArray(detail.items)) receipt.detail = { reordered: detail.items.length };
		}
		row.receipt = JSON.stringify(receipt);
	}
	return row;
}

export function canonicalRuntimeReceipt(row: RuntimeReceiptRow): Record<string, unknown> | undefined {
	if (!row.browser_payload_hash || !row.agent_instance_ref || row.target_unavailable) return undefined;
	const receipt = row.receipt
		? (JSON.parse(row.receipt) as { outcome: string; detail?: Record<string, unknown> })
		: undefined;
	const target = row.browser_target
		? (JSON.parse(row.browser_target) as Record<string, unknown>)
		: {
				agentInstanceRef: row.agent_instance_ref,
				...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
				...(row.execution_id ? { executionId: row.execution_id } : {}),
			};
	const value = {
		version: "1.0",
		commandId: row.command_id,
		payloadHash: row.browser_payload_hash,
		target,
		stage: row.stage,
		lookup: row.state === "settled" ? "known" : "pending",
		dedupUntil: row.settled_at === null ? null : Number(row.settled_at) + runtimeLimits.dedupHorizonMs,
		result: {
			...(receipt?.outcome === "applied" ? receipt.detail : {}),
			target: {
				agentInstanceRef: row.agent_instance_ref,
				...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
				...(row.execution_id ? { executionId: row.execution_id } : {}),
				authorityGeneration: Number(row.authority_generation),
				intentRevision: Number(receipt?.detail?.intentRevision ?? row.intent_revision ?? 0),
			},
		},
		...(receipt?.outcome === "rejected"
			? {
					error: {
						code: String(receipt.detail?.code ?? "rejected").slice(0, 100),
						retryable: false,
						admission: "engine_accepted",
						commandId: row.command_id,
					},
				}
			: {}),
	};
	validateRuntimeValue("receipt", value);
	return value;
}
