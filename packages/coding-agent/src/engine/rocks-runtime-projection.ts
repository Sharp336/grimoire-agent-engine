import type { StorageRuntimeIndex, StorageRuntimeKey } from "../session/storage-protocol";
import { type EngineEvent, type EngineInboxItem, type EngineTarget, EngineTargetError } from "./contracts";
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
import { boundedItems, projectionChange, type RuntimeQueryWork, runtimeInputBody } from "./runtime-projection";
import { type RuntimeChange, runtimeLimits, runtimeToolPageRecords, validateRuntimeValue } from "./runtime-protocol";
import { publicRuntimeQueueItem } from "./runtime-queue";
import { canonicalRuntimeReceipt, type RuntimeReceiptRow } from "./runtime-receipts";
import type { RuntimeTransaction } from "./runtime-records";
import type { EngineCommandReceipt, EngineTransitionEvent } from "./store";

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
	"tool_approval_requested",
	"tool_approval_resolved",
	"inbox_changed",
]);
export const projectionId = (subtype: string, ...parts: string[]) =>
	`projection_${new Bun.CryptoHasher("sha256").update(JSON.stringify([subtype, ...parts])).digest("hex")}`;
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
		const message = String(value.messageId);
		keys.push(
			{
				kind: "projection",
				id: projectionId("message", event.attemptId, message, String(value.blockId), String(value.stream)),
			},
			{ kind: "projection", id: projectionId("ownership", agent, message) },
		);
	}
	if (summaryEvents.has(event.kind))
		keys.push(
			{ kind: "metadata", id: "engine" },
			{ kind: "binding", id: agent },
			{ kind: "metadata", id: `budget:ordinary:${agent}` },
			{ kind: "metadata", id: "budget:control:device" },
			...["pause", "stop", "recovery"].map(hold => ({ kind: "hold" as const, id: `${agent}:${hold}` })),
		);
	return keys;
}
export interface RocksProjection {
	subtype: string;
	agent_instance_id: string;
	attempt_id: string;
	position: number;
	value: Record<string, unknown>;
	resolved?: boolean;
	body?: Record<string, unknown>;
}
export interface ProjectedEvent extends RocksEvent {
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
}

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

export function runtimeReceipt(
	row: RocksCommand,
	identity: RocksIdentity | undefined,
	attempt: RocksAttempt | undefined,
): Record<string, unknown> | undefined {
	const command = row.identity;
	const payload = command.serializedCommand
		? (JSON.parse(command.serializedCommand) as { browserTarget?: unknown })
		: undefined;
	const stage =
		row.receipt?.outcome === "rejected"
			? "rejected"
			: row.state !== "settled"
				? "engine_accepted"
				: row.operation === "start" && attempt && terminal.has(attempt.state)
					? "execution_terminal"
					: "applied";
	let receipt = row.receipt ? structuredClone(row.receipt) : null;
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
	if (receipt) receipt = boundedReceipt(receipt);
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
			if (hold)
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
	let profileRoute: Record<string, unknown> | undefined;
	if (attempt?.profile_route_state) {
		if (Buffer.byteLength(attempt.profile_route_state) > runtimeLimits.bulkPreviewBytes)
			throw new EngineTargetError("source_unavailable", "Retained profile route exceeds its metadata budget");
		const { eventSeq, ...state } = JSON.parse(attempt.profile_route_state) as Record<string, unknown>;
		profileRoute = {
			state,
			eventSeq: eventSeq ?? 0,
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
		validateRuntimeValue("profileRoute", profileRoute);
	}
	const heldPage = boundedItems(holds, runtimeLimits.bulkPreviewBytes * 2, runtimeLimits.httpPageRecords);
	const inputPage = boundedItems(inputs, runtimeLimits.bulkPreviewBytes * 2, runtimeLimits.httpPageRecords);
	return {
		agentInstanceRef: identity.agent_instance_ref,
		attemptId: attempt?.attempt_id ?? null,
		revision,
		target: {
			agentInstanceRef: identity.agent_instance_ref,
			intentRevision: identity.intent_revision,
			authorityGeneration: attempt?.authority_generation ?? identity.authority_generation,
			...(attempt ? { attemptId: attempt.attempt_id, executionId: attempt.execution_id } : {}),
		},
		state: attempt?.state ?? "registered",
		...(profileRoute ? { profileRoute } : {}),
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
	if (event.kind.startsWith("input_") || event.kind.startsWith("tool_approval_")) {
		const inputId = String(event.payload?.inputId ?? event.payload?.approvalId);
		const id = projectionId("input", event.attemptId, inputId);
		if (event.kind.endsWith("requested")) {
			const body = runtimeInputBody(event);
			await putProjection(
				tx,
				event,
				"input",
				id,
				{ inputId, kind: body.kind, revision: event.eventId },
				{ body, resolved: false },
			);
		} else if (event.kind.endsWith("resolved")) {
			const previous = await tx.get<RocksProjection>("projection", id);
			if (previous) await tx.put("projection", id, { ...previous, resolved: true });
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
	if (summaryEvents.has(event.kind) || !identity.summary_json) {
		const binding = await tx.get<RocksBinding>("binding", event.agentInstanceId);
		const current = binding
			? binding.attempt_id === attempt?.attempt_id
				? attempt
				: await tx.get<RocksAttempt>("attempt", binding.attempt_id)
			: undefined;
		const pending = await pendingStartCommand(tx, event.agentInstanceId, current?.attempt_id);
		const detail = await projectedDetail(tx, identity, current, event.eventId);
		const value = {
			agentInstanceRef: identity.agent_instance_ref,
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
		const value = command
			? runtimeReceipt(
					command,
					identity,
					command.identity.attemptId
						? await tx.get<RocksAttempt>("attempt", command.identity.attemptId)
						: undefined,
				)
			: undefined;
		if (value)
			changes.push(projectionChange("receipt", identity.agent_instance_ref, event.eventId, event.eventId, value));
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
	let detail: Record<string, unknown> | null = null;
	if (summaryEvents.has(event.kind) || toolEvent || event.kind === "profile_route_changed") {
		detail = await projectedDetail(tx, identity, attempt, event.eventId);
		validateRuntimeValue("detailState", detail);
		await putProjection(tx, event, "detail", projectionId("detail", event.agentInstanceId, event.attemptId), detail);
		if (attempt) attempt.detail_revision = event.eventId;
		if (!toolEvent)
			changes.push(projectionChange("state", identity.agent_instance_ref, event.eventId, event.eventId, detail));
	}
	const invalidations: string[] = [];
	if (event.kind === "model_settled" || event.kind === "profile_route_changed" || terminal.has(event.kind))
		invalidations.push("usage", "context");
	if (event.kind === "inbox_changed") invalidations.push("queue");
	if (event.kind === "holds_changed") invalidations.push("holds");
	if ((event.kind.startsWith("input_") || event.kind.startsWith("tool_approval_")) && attempt)
		invalidations.push("input");
	if (event.payload?.transcriptCheckpoint && event.attemptId) invalidations.push("history");
	for (const resource of invalidations) {
		const revision =
			resource === "queue"
				? identity.queue_revision
				: resource === "holds"
					? identity.intent_revision
					: resource === "history"
						? (event.payload!.transcriptCheckpoint as { revision: number }).revision
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
