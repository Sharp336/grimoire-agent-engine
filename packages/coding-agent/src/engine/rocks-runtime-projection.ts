import type { StorageRuntimeIndex, StorageRuntimeKey } from "../session/storage-protocol";
import type { SessionDurabilityCheckpoint } from "../session/session-manager";
import { canonicalRuntimeJson } from "./runtime-protocol.mjs";
import {
	type EngineEvent,
	type EngineBindingGate,
	type EngineInboxItem,
	type EngineRetryState,
	type EngineTarget,
	sameSemanticBinding,
	EngineTargetError,
} from "./contracts";
import { safeEngineErrorDetail } from "./public-error";
import { encodeCursor } from "./rocks-runtime-cursor";
import type {
	RocksAttempt,
	RocksBinding,
	RocksCommand,
	RocksEffect,
	RocksEvent,
	RocksHold,
	RocksIdentity,
} from "./rocks-runtime-rows";
import { lifecycleSummary } from "./runtime-lifecycle";
import { utf8Tail } from "./runtime-messages";
import {
	boundedItems,
	projectionChange,
	type RuntimeQueryWork,
	runtimeInputBody,
	runtimeInputPreview,
	runtimeInputQuestions,
} from "./runtime-projection";
import { type RuntimeChange, runtimeLimits, runtimeToolPageRecords, validateRuntimeValue } from "./runtime-protocol";
import { publicRuntimeQueueItem } from "./runtime-queue";
import { canonicalRuntimeReceipt, type RuntimeReceiptRow } from "./runtime-receipts";
import type { RuntimeRecords, RuntimeTransaction } from "./runtime-records";
import type { EngineApprovalRow, EngineCommandReceipt, EngineTransitionEvent } from "./store";

export const terminal = new Set(["completed", "cancelled", "failed", "interrupted"]);
const summaryEvents = new Set([
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
	"request_waiting",
	"tool_approval_requested",
	"tool_approval_resolved",
	"inbox_changed",
]);
const approvalEvent = (kind: string) =>
	kind.endsWith("_approval_requested") || kind.endsWith("_approval_resolved") ||
	kind === "approval_escalated" || kind === "approval_timed_out";
export const projectionId = (subtype: string, ...parts: string[]) =>
	`projection_${new Bun.CryptoHasher("sha256").update(JSON.stringify([subtype, ...parts])).digest("hex")}`;
/** An input request payload up to this size stays whole in its event and projection rows. */
const INLINE_INPUT_BYTES = 64 * 1024;
/** Base64 of one part (192 KiB) fits one 256 KiB owner record; four parts fit one 1 MiB owner request. */
export const INPUT_PART_BYTES = 144 * 1024;
const INPUT_PARTS_PER_WRITE = 4;
export const inputPartId = (attemptId: string, hash: string, index: number) =>
	projectionId("input_part", attemptId, hash, String(index));
/** Questions JSON of an oversized input, which lives in parts of `hash`; the input's rows keep a preview. */
export interface InputParts {
	hash: string;
	bytes: number;
}
function oversizedQuestions(payload: Record<string, unknown>): { json: Buffer; parts: InputParts } | undefined {
	// The raw payload decides: fields the public body drops (option previews) still weigh on the event row.
	if (Buffer.byteLength(JSON.stringify(payload)) <= INLINE_INPUT_BYTES) return undefined;
	const json = Buffer.from(JSON.stringify(runtimeInputQuestions(payload)));
	return { json, parts: { hash: new Bun.CryptoHasher("sha256").update(json).digest("hex"), bytes: json.length } };
}
/** An oversized body is this prefix of its preview, the questions JSON of its parts, then `}`. */
export function inputBodyPrefix(preview: Record<string, unknown>): Buffer {
	// `questions` is the last key of an input body, so the head serializes identically in both.
	const { questions: _, ...head } = preview;
	return Buffer.from(`${JSON.stringify(head).slice(0, -1)},"questions":`);
}
/**
 * Write the questions of an oversized input request in bounded parts before the event that requests it: one
 * owner write holds neither the whole body nor the event beside it. Parts are content-addressed and immutable,
 * so a retry rewrites the same bytes. A request whose event then fails leaves parts nothing names; they go with
 * the chat's other runtime rows.
 */
export async function retainInputParts(
	records: RuntimeRecords,
	target: { agentInstanceId: string; attemptId: string },
	payload: Record<string, unknown>,
): Promise<void> {
	const oversized = oversizedQuestions(payload);
	if (!oversized) return;
	const { json, parts } = oversized;
	const count = Math.ceil(parts.bytes / INPUT_PART_BYTES);
	for (let first = 0; first < count; first += INPUT_PARTS_PER_WRITE)
		await records.mutate(target.agentInstanceId, async tx => {
			const indexes = Array.from({ length: Math.min(INPUT_PARTS_PER_WRITE, count - first) }, (_, n) => first + n);
			await tx.prefetch(
				indexes.map(index => ({ kind: "projection", id: inputPartId(target.attemptId, parts.hash, index) })),
			);
			for (const index of indexes)
				await tx.put("projection", inputPartId(target.attemptId, parts.hash, index), {
					subtype: "input",
					// A part is no pending control: `resolved` keeps it out of the input indexes, while
					// `agent_instance_id` lets chat deletion reclaim it with the other runtime rows.
					resolved: true,
					agent_instance_id: target.agentInstanceId,
					attempt_id: target.attemptId,
					position: index,
					value: { hash: parts.hash, index },
					part: json.subarray(index * INPUT_PART_BYTES, (index + 1) * INPUT_PART_BYTES).toString("base64"),
				} satisfies RocksProjection);
		});
}
/**
 * The payload an input request event retains: an oversized request keeps its exact bounded preview and names
 * its parts, which must already be retained, so neither the event nor its projection exceeds one owner record.
 */
export async function retainedInputPayload(
	tx: RuntimeTransaction,
	event: EngineEvent,
): Promise<Record<string, unknown> | undefined> {
	const oversized = event.kind === "input_requested" && event.payload && oversizedQuestions(event.payload);
	if (!oversized) return event.payload;
	const { hash, bytes } = oversized.parts;
	if (!(await tx.get("projection", inputPartId(event.attemptId, hash, Math.ceil(bytes / INPUT_PART_BYTES) - 1))))
		throw new EngineTargetError("payload_too_large", "Oversized input must retain its parts before its event");
	return {
		...event.payload,
		questions: runtimeInputPreview(runtimeInputBody(event)).questions,
		inputParts: oversized.parts,
	};
}
/** Rows `projectEvent` reads for this event whatever their values, so one owner round trip loads them. */
export function eventReadKeys(
	event: Pick<EngineEvent, "agentInstanceId" | "attemptId" | "kind" | "payload" | "causationCommandId">,
): StorageRuntimeKey[] {
	const agent = event.agentInstanceId;
	const keys: StorageRuntimeKey[] = [{ kind: "identity", id: agent }];
	if (event.attemptId)
		keys.push(
			{ kind: "attempt", id: event.attemptId },
			{ kind: "projection", id: projectionId("ownership", "events", event.attemptId) },
		);
	if (event.causationCommandId)
		keys.push({ kind: "projection", id: projectionId("ownership", "command", event.causationCommandId) });
	if (event.kind === "message_updated") {
		const value = event.payload ?? {};
		const message = String("messageId" in value ? value.messageId : undefined);
		keys.push(
			{
				kind: "projection",
				id: projectionId("message", event.attemptId, message,
					String("blockId" in value ? value.blockId : undefined),
					String("stream" in value ? value.stream : undefined)),
			},
			{ kind: "projection", id: projectionId("ownership", agent, message) },
		);
	}
	if (event.kind === "assistant_snapshot" && event.payload &&
		"assistantMessageId" in event.payload && typeof event.payload.assistantMessageId === "string")
		keys.push({ kind: "projection", id: projectionId("ownership", agent, event.payload.assistantMessageId) });
	if (summaryEvents.has(event.kind) || approvalEvent(event.kind))
		keys.push(
			{ kind: "metadata", id: "engine" },
			{ kind: "binding", id: agent },
			{ kind: "metadata", id: `budget:ordinary:${agent}` },
			{ kind: "metadata", id: "budget:control:device" },
			...["pause", "stop", "recovery"].map(hold => ({ kind: "hold" as const, id: `${agent}:${hold}` })),
		);
	return keys;
}
export interface RequestConsumption {
	input_revision: number;
	tool_call_id: string;
	tool_result_entry_id: string;
	result_hash: string;
	checkpoint: Pick<SessionDurabilityCheckpoint, "sessionId" | "leafEntryId" | "native">;
}

export interface RocksProjection {
	subtype: string;
	agent_instance_id: string;
	attempt_id: string;
	position: number;
	value: Record<string, unknown>;
	resolved?: boolean;
	body?: Record<string, unknown>;
	result?: Record<string, unknown>;
	result_consumption?: RequestConsumption;
	continuation_claimed?: boolean;
	/** Set when `body` is the preview of an oversized input. */
	parts?: InputParts;
	/** Base64 bytes of one input part. */
	part?: string;
}

export function requestResultHash(result: Record<string, unknown>): string {
	const value = { status: result.status, ...(Object.hasOwn(result, "result") ? { result: result.result } : {}) };
	return `sha256:${new Bun.CryptoHasher("sha256").update(canonicalRuntimeJson(value)).digest("hex")}`;
}

export function requestConsumptionMatches(row: RocksProjection): boolean {
	const proof = row.result_consumption;
	return proof !== undefined && row.resolved === true && row.result !== undefined &&
		proof.input_revision === row.value.revision && proof.result_hash === requestResultHash(row.result);
}
export type ProjectedEvent = RocksEvent & {
	projection_principal: string;
	projection_root: string;
	summary_payload: Record<string, unknown> | null;
	membership_payload: Record<string, unknown> | null;
	detail_payload: Record<string, unknown> | null;
	projection_payload: RuntimeChange[];
	message_content_id?: string;
	message_revision?: number;
	message_offset?: number;
	message_end_offset?: number;
	message_snapshot?: Record<string, unknown>;
	lifecycle_summary?: string | null;
};

function merged<T extends object>(
	tx: RuntimeTransaction,
	kind: "projection" | "command" | "effect",
	rows: T[],
	id: (value: T) => string,
	matches: (value: T) => boolean,
): T[] {
	const values = new Map(rows.map(row => [id(row), row]));
	for (const staged of tx.staged<T>(kind)) {
		if (!staged.value || !matches(staged.value)) values.delete(staged.id);
		else values.set(staged.id, staged.value);
	}
	return [...values.values()].filter(matches);
}

async function pendingStartCommand(tx: RuntimeTransaction, agent: string, currentAttemptId?: string) {
	// The identity and aggregate predicates fence this bounded observation without
	// adding every pending command to the 100-record atomic mutation read set.
	await tx.get("identity", agent);
	await tx.get("metadata", `budget:ordinary:${agent}`);
	await tx.get("metadata", "budget:control:device");
	const rows: RocksCommand[] = [];
	let cursor: string | undefined;
	let bytes = 0;
	do {
		const page = await tx.records.query("command_agent_pending", [agent], cursor, 100, undefined, tx.control);
		for (const row of page.records) {
			if (!row.value) continue;
			bytes += Buffer.byteLength(JSON.stringify(row.value));
			rows.push(row.value as unknown as RocksCommand);
		}
		if (
			rows.length > runtimeLimits.agentPendingRecords + runtimeLimits.controlPendingRecords ||
			bytes > (runtimeLimits.agentPendingBytes + runtimeLimits.controlPendingBytes) * 2
		)
			throw new EngineTargetError("queue_full", "Pending summary observation exceeds its bounded budget");
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	const pending = merged(
		tx,
		"command",
		rows,
		row => row.command_id,
		row =>
			row.agent_instance_id === agent &&
			row.state === "received" &&
			row.operation === "start" &&
			row.identity.attemptId !== currentAttemptId,
	)
		.sort((a, b) => a.received_at - b.received_at || a.command_id.localeCompare(b.command_id))
		.at(-1);
	if (pending) await tx.get("command", pending.command_id);
	return pending;
}
export async function messageRows(tx: RuntimeTransaction, attemptId: string): Promise<RocksProjection[]> {
	const rows = await tx.query<RocksProjection>("projection_attempt" as StorageRuntimeIndex, ["message", attemptId]);
	return merged(
		tx,
		"projection",
		rows,
		row =>
			projectionId(
				"message",
				attemptId,
				String(row.value.messageId),
				String(row.value.blockId),
				String(row.value.stream),
			),
		row => row.subtype === "message" && row.attempt_id === attemptId,
	);
}
export async function settleRuntimeMessages(
	tx: RuntimeTransaction,
	target: EngineTarget & { commandId: string },
	status: "settled" | "cancelled" | "interrupted",
	append: (
		tx: RuntimeTransaction,
		target: EngineTarget & { commandId: string },
		event: EngineTransitionEvent,
	) => Promise<EngineEvent>,
): Promise<EngineEvent[]> {
	const events: EngineEvent[] = [];
	for (const row of await messageRows(tx, target.attemptId)) {
		const value = row.value;
		if (value.status !== "streaming") continue;
		events.push(
			await append(tx, target, {
				kind: "message_updated",
				payload: {
					mode: "append",
					messageId: value.messageId,
					blockId: value.blockId,
					stream: value.stream,
					contentId: value.contentId,
					baseRevision: value.revision,
					revision: Number(value.revision) + 1,
					offset: value.totalBytes,
					endOffset: value.totalBytes,
					totalBytes: value.totalBytes,
					text: "",
					status,
				},
			}),
		);
	}
	return events;
}
/** A retained receipt beyond one live change replays and projects as an explicit partial marker. */
export function boundedReceipt(receipt: EngineCommandReceipt): EngineCommandReceipt {
	return Buffer.byteLength(JSON.stringify(receipt)) > runtimeLimits.liveChangeBytes
		? { outcome: receipt.outcome, detail: { partial: true, unavailable: "result_exceeds_projection_limit" } }
		: receipt;
}

/** The public retained receipt: queue items keep only public fields and an oversized result is a bounded marker. */
export function projectedReceipt(row: RocksCommand): EngineCommandReceipt | null {
	const command = row.identity;
	const receipt = row.receipt ? structuredClone(row.receipt) : null;
	if (
		receipt?.outcome === "applied" &&
		receipt.detail &&
		command.agentInstanceRef &&
		(row.operation.startsWith("queue_") || row.operation === "enqueue")
	) {
		const detail = receipt.detail;
		const item = (detail.item ?? (detail.queueId ? detail : undefined)) as Record<string, unknown> | undefined;
		if (item?.queueId && typeof item.partial !== "boolean") {
			const projected = publicRuntimeQueueItem(command.agentInstanceRef, item as unknown as EngineInboxItem);
			receipt.detail = detail.item ? { ...detail, item: projected } : { item: projected };
		} else if (Array.isArray(detail.items)) receipt.detail = { reordered: detail.items.length };
	}
	return receipt && boundedReceipt(receipt);
}

function commandReceiptStage(row: RocksCommand, attempt: RocksAttempt | undefined): string {
	return row.receipt?.outcome === "rejected"
		? "rejected"
		: row.state !== "settled"
			? "engine_accepted"
			: row.operation === "start" && attempt && terminal.has(attempt.state)
				? "execution_terminal"
				: "applied";
}

/** Native delivery identity shared by the command query and durable hosted receipts, not a browser receipt. */
export function nativeCommandReceipt(
	row: RocksCommand,
	attempt: RocksAttempt | undefined,
): Record<string, unknown> {
	const command = row.identity;
	return {
		commandId: row.command_id,
		lookup: row.state === "settled" ? "known" : "pending",
		stage: commandReceiptStage(row, attempt),
		receipt: projectedReceipt(row) ?? undefined,
		rawCanonicalHash: row.canonical_hash,
		target: {
			agentInstanceRef: command.agentInstanceRef,
			agentInstanceId: row.agent_instance_id,
			attemptId: command.attemptId,
			executionId: command.executionId,
		},
	};
}

export function runtimeReceipt(
	row: RocksCommand,
	identity: RocksIdentity | undefined,
	attempt: RocksAttempt | undefined,
): Record<string, unknown> | undefined {
	const command = row.identity;
	const payload = command.serializedCommand
		? (JSON.parse(command.serializedCommand) as { browserTarget?: unknown })
		: undefined;
	const stage = commandReceiptStage(row, attempt);
	const receipt = projectedReceipt(row);
	const canonical: RuntimeReceiptRow = {
		command_id: row.command_id,
		operation: row.operation,
		agent_instance_id: row.agent_instance_id,
		agent_instance_ref: command.agentInstanceRef ?? null,
		attempt_id: command.attemptId ?? null,
		execution_id: command.executionId ?? null,
		principal_id: command.principalId ?? "",
		stage,
		state: row.state,
		browser_payload_hash: command.browserPayloadHash ?? null,
		browser_target: payload?.browserTarget ? JSON.stringify(payload.browserTarget) : null,
		target_unavailable: 0,
		authority_generation: command.authorityGeneration,
		intent_revision: identity?.intent_revision ?? 0,
		receipt: receipt ? JSON.stringify(receipt) : null,
		settled_at: row.state === "settled" ? row.updated_at : null,
		receipt_bytes: receipt ? Buffer.byteLength(JSON.stringify(receipt)) : 0,
		outcome: row.receipt?.outcome ?? null,
	};
	return canonicalRuntimeReceipt(canonical);
}

export async function projectedHolds(
	tx: RuntimeTransaction,
	identity: RocksIdentity,
	work?: RuntimeQueryWork,
): Promise<Record<string, unknown>[]> {
	const holds: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	let current: RocksIdentity | undefined = identity;
	while (current) {
		if (seen.has(current.agent_instance_id) || seen.size >= runtimeLimits.ancestorRecords)
			throw new EngineTargetError("restore_budget", "Ancestor projection exceeds its bounded acyclic path");
		seen.add(current.agent_instance_id);
		const agent = current.agent_instance_id;
		// One owner round trip per ancestor level: its holds and its parent.
		await tx.prefetch([
			...["pause", "stop", "recovery"].map(hold => ({ kind: "hold" as const, id: `${agent}:${hold}` })),
			...(current.parent_agent_instance_id
				? [{ kind: "identity" as const, id: current.parent_agent_instance_id }]
				: []),
		]);
		for (const kind of ["pause", "stop", "recovery"]) {
			const hold = await tx.get<RocksHold>("hold", `${current.agent_instance_id}:${kind}`);
			if (work) {
				work.rows(1);
				work.value.materializedBytes += Buffer.byteLength(JSON.stringify(hold ?? null));
				work.check();
			}
			if (hold && (hold.local_only !== true || current.agent_instance_id === identity.agent_instance_id))
				holds.push({
					sourceAgentInstanceRef: current.agent_instance_ref,
					commandId: hold.command_id,
					generation: hold.generation,
					kind: hold.kind,
				});
		}
		const hasParent = Boolean(current.parent_agent_instance_id);
		current = current.parent_agent_instance_id
			? await tx.get<RocksIdentity>("identity", current.parent_agent_instance_id)
			: undefined;
		if (work && hasParent) {
			work.rows(1);
			work.value.materializedBytes += Buffer.byteLength(JSON.stringify(current ?? null));
			work.check();
		}
	}
	return holds;
}

export function toolSnapshot(row: RocksEffect): Record<string, unknown> {
	const item = {
		toolCallId: row.tool_call_id,
		name: row.tool_name,
		...(row.assistant_message_id && row.assistant_block_id
			? { origin: { messageId: row.assistant_message_id, blockId: row.assistant_block_id } }
			: {}),
		phase: row.state === "unknown" ? "unknown" : "started",
		revision: row.runtime_event_id,
	};
	validateRuntimeValue("toolSnapshot", item);
	return item;
}
async function projectedTools(
	tx: RuntimeTransaction,
	identity: RocksIdentity,
	attempt: RocksAttempt | undefined,
): Promise<{ tools: Record<string, unknown>[]; toolsNextCursor: string | null }> {
	if (!attempt) return { tools: [], toolsNextCursor: null };
	const tools: Record<string, unknown>[] = [];
	const meta = await tx.get<{ store_epoch: string; generation: number }>("metadata", "engine");
	const scope = [
		"tools",
		meta?.store_epoch ?? "",
		meta?.generation ?? 0,
		identity.agent_instance_ref,
		attempt.attempt_id,
		attempt.tool_revision,
	];
	for (const [stateIndex, state] of ["started", "unknown"].entries()) {
		const rows = merged(
			tx,
			"effect",
			await tx.query<RocksEffect>("effect_attempt", [attempt.attempt_id, state]),
			row => row.effect_id,
			row => row.attempt_id === attempt.attempt_id && row.state === state && row.effect_kind === "tool",
		).sort((a, b) => a.effect_id.localeCompare(b.effect_id));
		let after: string | undefined;
		for (const row of rows) {
			const item = toolSnapshot(row);
			if (
				tools.length >= runtimeToolPageRecords ||
				Buffer.byteLength(JSON.stringify([...tools, item])) > runtimeLimits.bulkPreviewBytes * 2
			)
				return { tools, toolsNextCursor: encodeCursor(scope, { state: stateIndex, after }) };
			tools.push(item);
			after = row.effect_id;
		}
	}
	return { tools, toolsNextCursor: null };
}

export function retryFromAttempt(attempt: RocksAttempt): EngineRetryState | undefined {
	if (attempt.retry_attempt == null || attempt.retry_attempt <= 0) return undefined;
	return {
		attempt: Number(attempt.retry_attempt),
		maxAttempts: Number(attempt.retry_max_attempts),
		...(attempt.retry_route ? { route: attempt.retry_route } : {}),
		...(attempt.retry_delay_ms == null ? {} : { delayMs: Math.ceil(Number(attempt.retry_delay_ms)) }),
		...(attempt.retry_scheduled_at == null ? {} : { scheduledAt: Math.ceil(Number(attempt.retry_scheduled_at)) }),
		...(attempt.retry_outcome ? { outcome: attempt.retry_outcome } : {}),
		...(attempt.retry_error ? { error: safeEngineErrorDetail(attempt.retry_error) } : {}),
	};
}

export async function projectedDetail(
	tx: RuntimeTransaction,
	identity: RocksIdentity,
	attempt: RocksAttempt | undefined,
	revision: number,
): Promise<Record<string, unknown>> {
	const holds = await projectedHolds(tx, identity);
	const inputs =
		attempt && !terminal.has(attempt.state)
			? merged(
					tx,
					"projection",
					await tx.query<RocksProjection>("projection_attempt" as StorageRuntimeIndex, [
						"input",
						attempt.attempt_id,
					]),
					row => projectionId("input", attempt.attempt_id, String(row.value.inputId)),
					row => row.subtype === "input" && row.attempt_id === attempt.attempt_id && !row.resolved,
				).map(row => row.value)
			: [];
	let executorRoute: Record<string, unknown> | undefined;
	if (attempt?.executor_route_state) {
		if (Buffer.byteLength(attempt.executor_route_state) > runtimeLimits.bulkPreviewBytes)
			throw new EngineTargetError("source_unavailable", "Executor route exceeds its metadata budget");
		const state = JSON.parse(attempt.executor_route_state) as Record<string, unknown>;
		executorRoute = {
			state,
			eventSeq: state.eventSeq,
			target: {
				agentInstanceId: identity.agent_instance_id,
				attemptId: attempt.attempt_id,
				executionId: attempt.execution_id,
				runtimeBindingId: attempt.binding_id,
				engineGeneration: attempt.engine_generation,
				bindingGeneration: attempt.binding_generation,
				authorityGeneration: attempt.authority_generation,
			},
		};
		validateRuntimeValue("executorRoute", executorRoute);
	}
	const heldPage = boundedItems(holds, runtimeLimits.bulkPreviewBytes * 2, runtimeLimits.httpPageRecords);
	const inputPage = boundedItems(inputs, runtimeLimits.bulkPreviewBytes * 2, runtimeLimits.httpPageRecords);
	return {
		agentInstanceRef: identity.agent_instance_ref,
		...(attempt?.binding_snapshot ? { bindingSnapshot: attempt.binding_snapshot } : {}),
		attemptId: attempt?.attempt_id ?? null,
		revision,
		target: {
			agentInstanceRef: identity.agent_instance_ref,
			intentRevision: identity.intent_revision,
			authorityGeneration: attempt?.authority_generation ?? identity.authority_generation,
			...(attempt ? { attemptId: attempt.attempt_id, executionId: attempt.execution_id } : {}),
		},
		state: attempt?.state ?? "registered",
		retry: attempt ? (retryFromAttempt(attempt) ?? null) : null,
		...(executorRoute ? { executorRoute } : {}),
		executorChoice: attempt?.execution?.executor_choice ?? null,
		executionDigest: attempt?.execution?.execution_digest ?? null,
		continuationDigest: attempt?.execution?.continuation_digest ?? null,
		manualHold: holds.length > 0,
		holds: heldPage,
		holdsHasMore: holds.length > heldPage.length,
		queue: {
			revision: identity.queue_revision,
			pendingCount: identity.queue_pending_count,
			hasMore: identity.queue_pending_count > 0,
		},
		pendingInputs: inputPage,
		inputsHasMore: inputs.length > inputPage.length,
		history: {
			sessionId: attempt?.transcript_session_id ?? null,
			revision: attempt?.transcript_leaf_entry_id ?? null,
			leafEntryId: attempt?.transcript_leaf_entry_id ?? null,
			settled: Boolean(attempt && terminal.has(attempt.state)),
		},
		messages: [],
		messagesHasMore: false,
		...(await projectedTools(tx, identity, attempt)),
	};
}

async function putProjection(
	tx: RuntimeTransaction,
	event: EngineEvent,
	subtype: string,
	id: string,
	value: Record<string, unknown>,
	extra: Partial<RocksProjection> = {},
): Promise<void> {
	await tx.put("projection", id, {
		subtype,
		agent_instance_id: event.agentInstanceId,
		attempt_id: event.attemptId,
		position: event.eventId,
		value,
		...extra,
	});
}

/** Called before the mutation is committed: event, projections and guards share one Rocks batch. */
export async function projectEvent(tx: RuntimeTransaction, event: EngineEvent): Promise<void> {
	const identity = await tx.get<RocksIdentity>("identity", event.agentInstanceId);
	if (!identity?.agent_instance_ref) return;
	const stored = await tx.get<ProjectedEvent>("event", String(event.eventId));
	if (!stored) throw new EngineTargetError("stale_target", "Projection event must be staged in the same mutation");
	const attempt = event.attemptId ? await tx.get<RocksAttempt>("attempt", event.attemptId) : undefined;
	if (event.attemptId) {
		const id = projectionId("ownership", "events", event.attemptId);
		const previous = await tx.get<RocksProjection>("projection", id);
		await putProjection(tx, event, "ownership", id, {
			first: previous?.value.first ?? event.eventId,
			last: event.eventId,
			terminal: terminal.has(event.kind) ? event.eventId : (previous?.value.terminal ?? null),
		});
	}
	const changes: RuntimeChange[] = [];
	const toolEvent = event.kind === "tool_started" || event.kind === "tool_settled";
	if (toolEvent && attempt) {
		const effect = await tx.get<RocksEffect>("effect", String(event.payload?.invocationId));
		if (effect && effect.attempt_id === event.attemptId && effect.effect_kind === "tool")
			await tx.put("effect", effect.effect_id, { ...effect, runtime_event_id: event.eventId });
		attempt.tool_revision = event.eventId;
	}
	if (event.kind.startsWith("input_") || approvalEvent(event.kind)) {
		const payload = event.payload;
		const inputId = String(event.kind === "input_requested" || event.kind === "input_resolved"
			? event.payload?.inputId
			: payload && ("id" in payload ? payload.id : "request_id" in payload ? payload.request_id : undefined));
		const id = projectionId("input", event.attemptId, inputId);
		if (event.kind.endsWith("requested")) {
			// An oversized question already carries its preview; approvals retain their exact request.
			const body = runtimeInputBody(event);
			const parts = event.kind === "input_requested" ? event.payload?.inputParts as InputParts | undefined : undefined;
			await putProjection(
				tx,
				event,
				"input",
				id,
				{ inputId, kind: body.kind, revision: event.eventId },
				{ body, resolved: false, ...(parts ? { parts } : {}) },
			);
		} else {
			const previous = await tx.get<RocksProjection>("projection", id);
			if (previous && event.kind.endsWith("resolved")) {
				const approval = event.kind === "input_resolved" ? undefined : await tx.get<EngineApprovalRow>("approval", inputId);
				const { result_consumption: _oldProof, ...unconsumed } = previous;
				let result: Record<string, unknown>;
				if (event.kind === "input_resolved") {
					result = { status: event.payload?.status ?? "answered",
						...(event.payload?.result ? { result: event.payload.result } : {}) };
				} else {
					if (!payload || !("outcome" in payload) || !approval?.decision)
						throw new EngineTargetError("stale_target", "Resolved approval lost its decision");
					result = { status: payload.outcome, result: { decision: approval.decision,
						...(approval.decision_record?.reason ? { reason: approval.decision_record.reason } : {}) } };
				}
				await tx.put("projection", id, { ...unconsumed, resolved: true,
					value: { ...previous.value, revision: event.eventId },
					result,
				});
			} else if (previous && (event.kind === "approval_escalated" || event.kind === "approval_timed_out")) {
				const approval = await tx.get<EngineApprovalRow>("approval", inputId);
				if (!approval) throw new EngineTargetError("stale_target", "Readdressed approval lost its request");
				const body = runtimeInputBody({ ...event, kind: `${approval.request.kind}_approval_requested`, payload: approval.request });
				await tx.put("projection", id, { ...previous,
					value: { ...previous.value, revision: event.eventId },
					body,
				});
			}
		}
		if (attempt) attempt.input_revision = event.eventId;
	}
	if (attempt && terminal.has(event.kind)) {
		const inputs = merged(
			tx,
			"projection",
			await tx.query<RocksProjection>("projection_attempt" as StorageRuntimeIndex, ["input", attempt.attempt_id]),
			row => projectionId("input", attempt.attempt_id, String(row.value.inputId)),
			row => row.subtype === "input" && row.attempt_id === attempt.attempt_id && !row.resolved,
		);
		for (const input of inputs)
			await tx.put("projection", projectionId("input", attempt.attempt_id, String(input.value.inputId)), {
				...input,
				resolved: true,
			});
		if (inputs.length) attempt.input_revision = event.eventId;
	}
	if (event.causationCommandId) {
		const id = projectionId("ownership", "command", event.causationCommandId);
		if (!(await tx.get<RocksProjection>("projection", id)))
			await putProjection(tx, event, "ownership", id, { eventId: event.eventId });
	}
	let membership: Record<string, unknown> | null = null;
	if (!identity.root_agent_instance_ref || !identity.membership_revision) {
		const parent = identity.parent_agent_instance_id
			? await tx.get<RocksIdentity>("identity", identity.parent_agent_instance_id)
			: undefined;
		if ((identity.parent_agent_instance_id || identity.parent_agent_instance_ref) && !parent?.root_agent_instance_ref)
			throw new EngineTargetError("stale_target", "Parent ancestry must be enrolled before child projection");
		identity.parent_agent_instance_ref = parent?.agent_instance_ref || identity.parent_agent_instance_ref;
		identity.root_agent_instance_ref = parent?.root_agent_instance_ref || identity.agent_instance_ref;
		identity.membership_revision = event.eventId;
		membership = {
			agentInstanceRef: identity.agent_instance_ref,
			rootAgentInstanceRef: identity.root_agent_instance_ref,
			parentAgentInstanceRef: identity.parent_agent_instance_ref,
			revision: event.eventId,
		};
		validateRuntimeValue("membership", membership);
		await putProjection(tx, event, "membership", projectionId("membership", event.agentInstanceId), membership);
	}
	let summary: Record<string, unknown> | null = null;
	if (summaryEvents.has(event.kind) || approvalEvent(event.kind) || !identity.summary_json) {
		const binding = await tx.get<RocksBinding>("binding", event.agentInstanceId);
		const gate = identity.agent_instance_ref?.startsWith("grimoire://agents/~u/")
			? (await tx.get<{ gate: EngineBindingGate }>("metadata", `semantic-binding:${event.agentInstanceId}`))?.gate
			: undefined;
		let current = binding
			? binding.attempt_id === attempt?.attempt_id
				? attempt
				: await tx.get<RocksAttempt>("attempt", binding.attempt_id)
			: undefined;
		if (gate && !sameSemanticBinding(current?.binding_snapshot, gate.committedTarget ?? gate.bindingSnapshot))
			current = undefined;
		const pending = await pendingStartCommand(tx, event.agentInstanceId, current?.attempt_id);
		const detail = await projectedDetail(tx, identity, current, event.eventId);
		const value = {
			agentInstanceRef: identity.agent_instance_ref,
			...(gate ? {
				bindingSnapshot: gate.committedTarget ?? gate.bindingSnapshot,
				bindingPhase: gate.phase === "open" ? "active" : gate.phase === "preparing" ? "preparing" : "committed_await_adopt",
				bindingOperationId: gate.operationId,
			} : binding?.binding_snapshot ? { bindingSnapshot: binding.binding_snapshot } : {}),
			rootAgentInstanceRef: identity.root_agent_instance_ref,
			parentAgentInstanceRef: identity.parent_agent_instance_ref,
			revision: Math.max(1, identity.summary_revision),
			engineGeneration: event.engineGeneration,
			authorityGeneration: current?.authority_generation ?? identity.authority_generation,
			state: current?.state ?? "registered",
			target: detail.target,
			pendingStart: pending
				? {
						agentInstanceRef: identity.agent_instance_ref,
						intentRevision: identity.intent_revision,
						authorityGeneration: pending.identity.authorityGeneration,
						attemptId: pending.identity.attemptId,
						executionId: pending.identity.executionId,
					}
				: null,
			outcome: current && terminal.has(current.state) ? current.state : null,
			attention: {
				held: detail.manualHold,
				needsInput: (detail.pendingInputs as unknown[]).length > 0,
				queuePending: identity.queue_pending_count > 0,
			},
		};
		if (JSON.stringify(value) !== identity.summary_json) {
			summary = { ...value, revision: event.eventId };
			validateRuntimeValue("agentSummary", summary);
			identity.summary_revision = event.eventId;
			identity.summary_json = JSON.stringify(summary);
			await putProjection(tx, event, "summary", projectionId("summary", event.agentInstanceId), summary);
		}
	}
	if (event.kind === "command_receipt") {
		const command = await tx.get<RocksCommand>(
			"command",
			String(event.payload?.commandId ?? event.causationCommandId),
		);
		// A copy routed to the browser's source agent still reports the command agent's own revision.
		const owner =
			command && command.agent_instance_id !== event.agentInstanceId
				? await tx.get<RocksIdentity>("identity", command.agent_instance_id)
				: identity;
		const value = command
			? runtimeReceipt(
					command,
					owner,
					command.identity.attemptId
						? await tx.get<RocksAttempt>("attempt", command.identity.attemptId)
						: undefined,
				)
			: undefined;
		if (value)
			changes.push(projectionChange("receipt", identity.agent_instance_ref, event.eventId, event.eventId, value));
	}
	if (event.kind === "assistant_snapshot" && typeof event.payload?.assistantMessageId === "string") {
		// Empty failures and tool-only responses stream no text: their snapshot alone anchors the native entry.
		const messageId = event.payload.assistantMessageId;
		const ownerId = projectionId("ownership", event.agentInstanceId, messageId);
		const owner = await tx.get<RocksProjection>("projection", ownerId);
		if (owner && (owner.subtype !== "ownership" || owner.agent_instance_id !== event.agentInstanceId ||
			owner.attempt_id !== event.attemptId || owner.value.messageId !== messageId))
			throw new EngineTargetError("stale_target", "Assistant snapshot changed its message owner or Attempt");
		const historyEntryId = event.payload.status === "settled" &&
			typeof event.payload.historyEntryId === "string" ? event.payload.historyEntryId : undefined;
		if (historyEntryId === "")
			throw new EngineTargetError("stale_target", "Assistant snapshot has no native history entry ID");
		if (historyEntryId && owner?.value.historyEntryId && owner.value.historyEntryId !== historyEntryId)
			throw new EngineTargetError("stale_target", "Assistant snapshot changed its native history entry");
		if (!owner)
			await putProjection(tx, event, "ownership", ownerId, {
				messageId, ...(historyEntryId ? { historyEntryId } : {}),
			});
		else if (historyEntryId && !owner.value.historyEntryId)
			await tx.put("projection", ownerId, {
				...owner, value: { ...owner.value, historyEntryId },
			});
	}
	if (event.kind === "message_updated") {
		const value = event.payload ?? {};
		validateRuntimeValue("textUpdate", value);
		const id = projectionId(
			"message",
			event.attemptId,
			String(value.messageId),
			String(value.blockId),
			String(value.stream),
		);
		const previous = await tx.get<RocksProjection>("projection", id);
		if (value.mode === "append") {
			if (
				!previous ||
				previous.value.contentId !== value.contentId ||
				previous.value.revision !== value.baseRevision ||
				previous.value.totalBytes !== value.offset
			)
				throw new EngineTargetError("stale_target", "Message append lost its exact revision or UTF-8 offset");
		} else if (
			value.offset !== 0 ||
			value.partial !== false ||
			value.endOffset !== value.totalBytes ||
			previous?.value.contentId === value.contentId
		)
			throw new EngineTargetError("invalid_request", "A new message lineage requires a complete initial prefix");
		const text = utf8Tail(
			(value.mode === "append" ? String(previous!.value.text) : "") + String(value.text),
			runtimeLimits.bulkPreviewBytes,
		);
		const totalBytes = Number(value.totalBytes);
		const partial = Buffer.byteLength(text) !== totalBytes;
		const snapshot = {
			mode: "snapshot",
			messageId: value.messageId,
			blockId: value.blockId,
			stream: value.stream,
			contentId: value.contentId,
			revision: value.revision,
			offset: totalBytes - Buffer.byteLength(text),
			endOffset: totalBytes,
			totalBytes,
			text,
			status: value.status,
			partial,
			...(partial
				? {
						resource: {
							kind: "message",
							agentInstanceRef: identity.agent_instance_ref,
							attemptId: event.attemptId,
							messageId: value.messageId,
							blockId: value.blockId,
							stream: value.stream,
							contentId: value.contentId,
							revision: value.revision,
							mediaType: "text/plain; charset=utf-8",
							bytes: totalBytes,
						},
					}
				: {}),
		};
		validateRuntimeValue("textSnapshot", snapshot);
		const ownerId = projectionId("ownership", event.agentInstanceId, String(value.messageId));
		if (!(await tx.get("projection", ownerId)))
			await putProjection(tx, event, "ownership", ownerId, { messageId: value.messageId });
		await putProjection(tx, event, "message", id, snapshot, { position: previous?.position ?? event.eventId });
		Object.assign(stored, {
			message_content_id: value.contentId,
			message_revision: value.revision,
			message_offset: value.offset,
			message_end_offset: value.endOffset,
			message_snapshot: snapshot,
		});
		if (attempt) attempt.message_revision = event.eventId;
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
	}
	if (toolEvent)
		changes.push(
			projectionChange(
				"tool",
				identity.agent_instance_ref,
				event.eventId,
				event.eventId,
				{
					toolCallId: event.payload?.toolCallId,
					name: event.payload?.toolName,
					...(event.payload?.origin ? { origin: event.payload.origin } : {}),
					phase:
						event.kind === "tool_started"
							? "started"
							: event.payload?.status === "completed"
								? "finished"
								: event.payload?.status,
				},
				event.attemptId,
			),
		);
	// The detail reports the route this event made durable, so its sequence is known before projecting.
	if (event.kind === "executor_route_changed" && attempt) {
		// The route state and immutable choice transition are already staged in the same batch.
		const state = attempt.executor_route_state && JSON.parse(attempt.executor_route_state) as Record<string, unknown>;
		if (state) attempt.executor_route_state = JSON.stringify({ ...state, eventSeq: event.seq });
	}
	let detail: Record<string, unknown> | null = null;
	if (
		summaryEvents.has(event.kind) ||
		toolEvent ||
		event.kind === "executor_route_changed" ||
		event.kind === "retry_scheduled" ||
		event.kind === "retry_settled"
	) {
		detail = await projectedDetail(tx, identity, attempt, event.eventId);
		validateRuntimeValue("detailState", detail);
		await putProjection(tx, event, "detail", projectionId("detail", event.agentInstanceId, event.attemptId), detail);
		if (attempt) attempt.detail_revision = event.eventId;
		if (!toolEvent)
			changes.push(projectionChange("state", identity.agent_instance_ref, event.eventId, event.eventId, detail));
	}
	const invalidations: string[] = [];
	if (event.kind === "model_settled" || event.kind === "executor_route_changed" || terminal.has(event.kind))
		invalidations.push("usage", "context");
	if (event.kind === "inbox_changed") invalidations.push("queue");
	if (event.kind === "holds_changed") invalidations.push("holds");
	if ((event.kind.startsWith("input_") || approvalEvent(event.kind)) && attempt)
		invalidations.push("input");
	const checkpoint = event.payload && "transcriptCheckpoint" in event.payload
		? event.payload.transcriptCheckpoint : undefined;
	const checkpointRevision = checkpoint && typeof checkpoint === "object" &&
		"revision" in checkpoint ? checkpoint.revision : undefined;
	if (checkpoint && (typeof checkpointRevision !== "number" || !Number.isSafeInteger(checkpointRevision)))
		throw new EngineTargetError("invalid_request", "Transcript checkpoint has no valid revision");
	if (checkpoint && event.attemptId) invalidations.push("history");
	for (const resource of invalidations) {
		const revision =
			resource === "queue"
				? identity.queue_revision
				: resource === "holds"
					? identity.intent_revision
					: resource === "history"
						? checkpointRevision ?? event.eventId
						: event.eventId;
		changes.push(
			projectionChange(
				"invalidate",
				identity.agent_instance_ref,
				event.eventId,
				event.eventId,
				{ resource, revision },
				resource === "queue" || resource === "holds" ? undefined : event.attemptId,
			),
		);
	}
	await tx.put("identity", event.agentInstanceId, identity);
	if (attempt) {
		if (terminal.has(attempt.state)) {
			const effects = await tx.get<{ count: number }>(
				"metadata",
				`effects:${attempt.attempt_id}:${attempt.binding_id}`,
			);
			if (effects?.count) throw new EngineTargetError("agent_busy", "Terminal attempt still has open effects");
		}
		await tx.put("attempt", attempt.attempt_id, attempt);
	}
	await tx.put("event", String(event.eventId), {
		...stored,
		projection_principal: identity.principal_id,
		projection_root: identity.root_agent_instance_ref,
		summary_payload: summary,
		membership_payload: membership,
		detail_payload: detail,
		projection_payload: changes,
		lifecycle_summary: lifecycleSummary(event),
	});
}
