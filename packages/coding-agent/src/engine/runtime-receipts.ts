import { runtimeLimits, validateRuntimeValue } from "./runtime-protocol";
import type { EngineCommandReceipt } from "./store";

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
