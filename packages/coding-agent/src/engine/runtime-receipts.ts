import type { EngineInboxItem } from "./contracts";
import type { RuntimeSql } from "./runtime-projection";
import { runtimeLimits, validateRuntimeValue } from "./runtime-protocol";
import { publicRuntimeQueueItem, readRuntimeQueue } from "./runtime-queue";

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
	authority_generation: number;
	intent_revision: number | null;
	receipt: string | null;
	settled_at: number | null;
	receipt_bytes: number;
	queue_id: string | null;
	queue_revision: number | null;
	outcome: string | null;
}

export async function readRuntimeReceipt(sql: RuntimeSql, commandId: string): Promise<RuntimeReceiptRow | undefined> {
	const rows = (await sql.unsafe(
		`SELECT c.command_id,c.operation,c.agent_instance_id,c.agent_instance_ref,c.attempt_id,c.execution_id,c.principal_id,c.state,
		c.browser_payload_hash,json_extract(c.serialized_command,'$.browserTarget') AS browser_target,c.authority_generation,
		CASE WHEN LENGTH(CAST(c.receipt AS BLOB))<=${runtimeLimits.liveChangeBytes} THEN c.receipt ELSE NULL END AS receipt,
		LENGTH(CAST(c.receipt AS BLOB)) AS receipt_bytes,c.outcome,c.settled_at,i.intent_revision,
		CASE WHEN LENGTH(CAST(c.receipt AS BLOB))>${runtimeLimits.liveChangeBytes} AND c.operation IN ('enqueue','queue_edit','queue_remove','queue_annotate','queue_defer')
		THEN SUBSTR(COALESCE(json_extract(c.receipt,'$.detail.item.queueId'),json_extract(c.receipt,'$.detail.queueId')),1,${runtimeLimits.bulkPreviewBytes}) END AS queue_id,
		CASE WHEN LENGTH(CAST(c.receipt AS BLOB))>${runtimeLimits.liveChangeBytes} AND c.operation IN ('enqueue','queue_edit','queue_remove','queue_annotate','queue_defer')
		THEN COALESCE(json_extract(c.receipt,'$.detail.item.revision'),json_extract(c.receipt,'$.detail.revision')) END AS queue_revision,
		CASE WHEN c.outcome='rejected' THEN 'rejected' WHEN c.state<>'settled' THEN 'engine_accepted'
		WHEN c.operation='start' AND a.state IN ('completed','cancelled','failed','interrupted') THEN 'execution_terminal' ELSE 'applied' END AS stage
		FROM engine_commands c LEFT JOIN engine_agent_identity i ON i.agent_instance_id=c.agent_instance_id
		LEFT JOIN engine_attempts a ON a.attempt_id=c.attempt_id WHERE c.command_id=?`,
		[commandId],
	)) as RuntimeReceiptRow[];
	const row = rows[0];
	if (row && row.receipt_bytes > runtimeLimits.liveChangeBytes) {
		let detail: Record<string, unknown> = { partial: true, unavailable: "legacy_result_exceeds_projection_limit" };
		if (row.queue_id && row.agent_instance_ref && row.principal_id) {
			const page = await readRuntimeQueue(sql, {
				agentInstanceRef: row.agent_instance_ref,
				principalId: row.principal_id,
				queueId: row.queue_id,
			});
			const item = (page.items as Record<string, unknown>[])[0];
			detail =
				item?.revision === row.queue_revision
					? { item }
					: {
							partial: true,
							unavailable: "legacy_queue_revision_not_retained",
							queueId: row.queue_id,
							revision: row.queue_revision,
						};
		}
		row.receipt = JSON.stringify({ outcome: row.outcome, detail });
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
	if (!row.browser_payload_hash || !row.agent_instance_ref) return undefined;
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
