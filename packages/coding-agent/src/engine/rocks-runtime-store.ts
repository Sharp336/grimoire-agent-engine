import type { StorageClient } from "../session/storage-client";
import type { StorageRuntimeIndex, StorageRuntimeRecord } from "../session/storage-protocol";
import { type EngineAttemptState, type EngineEvent, type EngineTarget, EngineTargetError } from "./contracts";
import { decodeCursor, encodeCursor } from "./rocks-runtime-cursor";
import {
	nativeHistoryEntry,
	nativeHistoryPage,
	nativeLifecyclePage,
	nativeSessionHeader,
} from "./rocks-runtime-history";
import {
	type ProjectedEvent,
	projectEvent,
	projectedHolds,
	projectionId,
	type RocksProjection,
	runtimeReceipt,
	terminal,
	toolSnapshot,
} from "./rocks-runtime-projection";
import { runtimeResource } from "./rocks-runtime-resources";
import type {
	RocksAttempt,
	RocksBinding,
	RocksCommand,
	RocksEffect,
	RocksIdentity,
	RocksInbox,
} from "./rocks-runtime-rows";
import { RocksEngineMutations } from "./rocks-store";
import type { EngineNativeHistoryPage } from "./runtime-history";
import type { HistoryLifecycleContext } from "./runtime-lifecycle";
import {
	RuntimeQueryError,
	RuntimeQueryWork,
	type RuntimeTargetRequest,
	runtimeAuthorized,
	runtimeInputPreview,
} from "./runtime-projection";
import {
	type RuntimeAccess,
	type RuntimeChange,
	type RuntimeDetailInterest,
	type RuntimeEventBatch,
	type RuntimeEventsRequest,
	type RuntimeRemainingWork,
	type RuntimeScope,
	type RuntimeWork,
	runtimeLimits,
	runtimeProjectionHash,
	runtimeToolPageRecords,
	validateRuntimeValue,
} from "./runtime-protocol";
import { publicRuntimeQueueItem, type RuntimeQueueRequest } from "./runtime-queue";
import type { RuntimeSnapshot } from "./runtime-read";
import { RuntimeTransaction } from "./runtime-records";
import type { RuntimePageRequest, RuntimeResourceRequest } from "./runtime-resources";
import { EngineCommandConflictError, type EngineHistoryArchive, type RetainedDirectChildHistory } from "./store";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export function queryWork(remaining?: RuntimeRemainingWork): RuntimeQueryWork {
	return new RuntimeQueryWork(
		remaining ?? {
			bytes: runtimeLimits.httpPageBytes,
			changes: runtimeLimits.httpPageRecords,
			scannedRows: runtimeLimits.bootstrapScannedRows,
			materializedBytes: runtimeLimits.bootstrapMaterializedBytes,
			timeMs: runtimeLimits.bootstrapTimeoutMs,
		},
	);
}
function account(work: RuntimeQueryWork, rows: unknown[]): void {
	work.rows(rows.length);
	work.value.materializedBytes += size(rows);
	work.check();
}
function finish<T>(
	type: string,
	result: T,
	work: RuntimeQueryWork,
	count: number,
	maxBytes = runtimeLimits.httpPageBytes,
): T {
	work.finish(result, count);
	if (size(result) > maxBytes)
		throw new RuntimeQueryError("restore_budget", "Result exceeds the requested byte budget", work.value);
	validateRuntimeValue(type, result);
	return result;
}
function readRequest(request: RuntimePageRequest | RuntimeQueueRequest, type: string): void {
	const { principalId: _principal, authorizedAgentInstanceRefs: _refs, ...read } = request;
	validateRuntimeValue(type, read);
}

/** Current projections and native history share the owner; this class never opens a legacy database. */
export class RocksEngineStore extends RocksEngineMutations {
	async ownershipMigrationStatus(): Promise<Record<string, unknown>> {
		return { status: "complete", unresolved: 0 };
	}
	async hasOtherSessionBinding(agentId: string, sessionFile: string): Promise<boolean> {
		const page = await this.records.query("binding_session", [sessionFile], undefined, 2);
		return page.records.some(row => row.value?.agent_instance_id !== agentId);
	}
	async isNativeUnadmittedEvent(
		event: Pick<EngineEvent, "eventId" | "agentInstanceId" | "attemptId" | "engineGeneration" | "causationCommandId">,
	): Promise<boolean> {
		const stored = await this.row<EngineEvent>("event", String(event.eventId));
		return Boolean(
			stored &&
				stored.agentInstanceId === event.agentInstanceId &&
				stored.attemptId === event.attemptId &&
				stored.engineGeneration === event.engineGeneration &&
				stored.causationCommandId === event.causationCommandId &&
				!(await this.row<RocksCommand>("command", event.causationCommandId)),
		);
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
		return !(await this.row<RocksCommand>("command", event.causationCommandId));
	}

	async getHistoryArchive(_agentId: string): Promise<EngineHistoryArchive | undefined> {
		return undefined;
	}
	async listRetainedDirectChildHistory(parentAgentId: string): Promise<RetainedDirectChildHistory[]> {
		const cut = await this.meta();
		const page = await this.records.query("identity_parent", [parentAgentId]);
		if (page.nextCursor)
			throw new EngineTargetError("restore_budget", "Direct child history exceeds its bounded read");
		const rows: Array<RetainedDirectChildHistory & { updated: number }> = [];
		for (const record of page.records) {
			const identity = record.value as unknown as RocksIdentity;
			const binding = await this.row<RocksBinding>("binding", identity.agent_instance_id);
			if (binding?.state !== "released" || !binding.session_file) continue;
			const attempt = await this.getAttempt(binding.attempt_id);
			const command = await this.row<RocksCommand>("command", binding.command_id);
			if (
				attempt &&
				terminal.has(attempt.state) &&
				command?.operation === "start" &&
				command.identity.parentAgentInstanceId === parentAgentId &&
				command.identity.agentInstanceRef
			)
				rows.push({
					agentInstanceId: identity.agent_instance_id,
					agentInstanceRef: command.identity.agentInstanceRef,
					engineAgentId: binding.engine_agent_id,
					sessionFile: binding.session_file,
					updated: attempt.updated_at,
				});
		}
		await this.assertCut(cut);
		return rows
			.sort((a, b) => a.updated - b.updated || a.agentInstanceId.localeCompare(b.agentInstanceId))
			.map(({ updated: _updated, ...row }) => row);
	}
	nativeSessionHeader(target: EngineTarget): Promise<{ sessionId: string; cwd: string | null }> {
		return nativeSessionHeader(this, target);
	}
	nativeHistoryPage(
		agentId: string,
		cursor?: string,
		limit = runtimeLimits.httpPageRecords,
		attemptId?: string,
	): Promise<EngineNativeHistoryPage> {
		return nativeHistoryPage(this, agentId, cursor, limit, attemptId);
	}
	nativeHistoryEntry(
		agentId: string,
		entryId: string,
		revision: string,
		offset = 0,
		limit = runtimeLimits.deliveryBatchBytes,
		sessionId?: string,
		attemptId?: string,
	): Promise<Record<string, unknown>> {
		return nativeHistoryEntry(this, agentId, entryId, revision, offset, limit, sessionId, attemptId);
	}
	nativeLifecyclePage(
		agentId: string,
		agentRef: string,
		limit: number,
		attemptId?: string,
		context?: HistoryLifecycleContext,
		cursor?: string,
		maxBytes = runtimeLimits.httpPageBytes,
		remaining?: RuntimeRemainingWork,
	) {
		return nativeLifecyclePage(this, agentId, agentRef, limit, attemptId, context, cursor, maxBytes, remaining);
	}
	runtimeResource(request: RuntimeResourceRequest): Promise<Record<string, unknown>> {
		return runtimeResource(this, request);
	}
	async listAttempts(afterRowId = 0, limit = 100): Promise<RocksAttempt[]> {
		return (
			await this.records.query(
				"attempt_all" as StorageRuntimeIndex,
				[],
				undefined,
				Math.max(1, Math.min(1000, Math.floor(limit))),
				[Math.max(0, Math.floor(afterRowId))],
			)
		).records.map(row => row.value as unknown as RocksAttempt);
	}
	async eventsAfter(attemptId: string, afterEventId = 0, limit = 100): Promise<EngineEvent[]> {
		return (
			await this.records.query(
				"event_attempt",
				[attemptId],
				undefined,
				Math.max(1, Math.min(1000, Math.floor(limit))),
				[Math.max(0, Math.floor(afterEventId))],
			)
		).records.map(row => row.value as unknown as EngineEvent);
	}
	async eventBounds(attemptId: string): Promise<{ first: number; last: number }> {
		const row = await this.row<RocksProjection>("projection", projectionId("ownership", "events", attemptId));
		return { first: Number(row?.value.first ?? 0), last: Number(row?.value.last ?? 0) };
	}
	async terminalEvent(attemptId: string): Promise<EngineEvent | undefined> {
		const row = await this.row<RocksProjection>("projection", projectionId("ownership", "events", attemptId));
		return row?.value.terminal ? this.row<EngineEvent>("event", String(row.value.terminal)) : undefined;
	}
	async waitAttemptResult(
		agentId: string,
		commandId: string,
		attemptId?: string,
		signal?: AbortSignal,
	): Promise<{ attemptId?: string; state: EngineAttemptState; payload: Record<string, unknown> }> {
		let pinned = attemptId;
		for (;;) {
			signal?.throwIfAborted();
			const changed = this.changeSignal();
			const command = await this.row<RocksCommand>("command", commandId);
			if (command && command.agent_instance_id !== agentId)
				throw new EngineTargetError("stale_target", "Child command belongs to another agent");
			if (command?.identity.attemptId) {
				if (pinned && pinned !== command.identity.attemptId)
					throw new EngineTargetError("stale_target", "Child Attempt changed");
				pinned = command.identity.attemptId;
			}
			const attempt = pinned ? await this.getAttempt(pinned) : undefined;
			if (attempt && (attempt.agent_instance_id !== agentId || attempt.command_id !== commandId))
				throw new EngineTargetError("stale_target", "Child Attempt belongs to another launch");
			if (attempt && terminal.has(attempt.state)) {
				const event = attempt.result_payload ? undefined : await this.terminalEvent(attempt.attempt_id);
				if (attempt.result_payload || event)
					return {
						attemptId: pinned,
						state: attempt.state,
						payload: attempt.result_payload ?? event?.payload ?? {},
					};
			}
			if (command?.receipt?.outcome === "rejected")
				return {
					attemptId: pinned,
					state: "failed",
					payload: {
						error: command.receipt.detail?.message ?? command.receipt.detail?.code ?? "Child launch rejected",
					},
				};
			const wake = Promise.withResolvers<void>();
			const abort = () => wake.resolve();
			signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(abort, runtimeLimits.eventWaitMs);
			try {
				await Promise.race([changed, wake.promise]);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			}
		}
	}
	constructor(client: StorageClient) {
		super(client, projectEvent);
	}
	async meta(work?: RuntimeQueryWork): Promise<{ epoch: string; generation: number; watermark: number }> {
		const rows = await Promise.all([this.records.get("metadata", "engine"), this.records.get("metadata", "events")]);
		if (work) account(work, rows);
		return {
			epoch: String(rows[0].value?.store_epoch ?? ""),
			generation: Number(rows[0].value?.generation ?? 0),
			watermark: Number(rows[1].value?.count ?? 0),
		};
	}
	async row<T extends object>(
		kind: StorageRuntimeRecord["kind"],
		id: string,
		work?: RuntimeQueryWork,
	): Promise<T | undefined> {
		const row = await this.records.get(kind, id);
		if (work) account(work, [row]);
		return (row.value as T | null) ?? undefined;
	}
	async identity(ref: string, access: RuntimeAccess, work?: RuntimeQueryWork): Promise<RocksIdentity> {
		const page = await this.records.query("identity_ref", [ref], undefined, 1);
		if (work) account(work, page.records);
		const identity = page.records[0]?.value as unknown as RocksIdentity | undefined;
		if (!access.principalId || !identity || !runtimeAuthorized(identity, access))
			throw new EngineTargetError("agent_not_found", "Unknown authorized AgentInstance");
		return identity;
	}
	async attempt(
		identity: RocksIdentity,
		attemptId?: string,
		work?: RuntimeQueryWork,
	): Promise<RocksAttempt | undefined> {
		const binding = !attemptId
			? await this.row<RocksBinding>("binding", identity.agent_instance_id, work)
			: undefined;
		const id = attemptId ?? binding?.attempt_id;
		const attempt = id ? await this.row<RocksAttempt>("attempt", id, work) : undefined;
		if ((attemptId && !attempt) || (attempt && attempt.agent_instance_id !== identity.agent_instance_id))
			throw new EngineTargetError("stale_target", "Exact Attempt is not owned by this agent");
		return attempt;
	}
	async assertCut(
		cut: { epoch: string; generation: number; watermark: number },
		work?: RuntimeQueryWork,
	): Promise<void> {
		const current = await this.meta(work);
		if (current.epoch !== cut.epoch || current.generation !== cut.generation)
			throw new EngineTargetError("epoch_changed", "Runtime owner generation changed");
		if (current.watermark !== cut.watermark)
			throw new EngineTargetError(
				"projection_changed",
				"Runtime changed during the bounded read; restart the snapshot",
			);
	}
	async runtimeTarget(request: RuntimeTargetRequest): Promise<Record<string, unknown>> {
		validateRuntimeValue("nativeTargetRequest", request);
		const cut = await this.meta();
		const identity = await this.identity(request.agentInstanceRef, request);
		if (request.rootAgentInstanceRef && request.rootAgentInstanceRef !== identity.root_agent_instance_ref)
			throw new EngineTargetError("stale_target", "Target is outside its authorized root");
		const attempt = request.attemptId
			? await this.row<RocksAttempt>("attempt", request.attemptId)
			: await this.attempt(identity);
		if (attempt && attempt.agent_instance_id !== identity.agent_instance_id)
			throw new EngineTargetError("stale_target", "Exact Attempt is not owned by this agent");
		const common = {
			agentInstanceRef: request.agentInstanceRef,
			agentInstanceId: identity.agent_instance_id,
			currentEngineGeneration: cut.generation,
			intentRevision: identity.intent_revision,
			authorityGeneration: identity.authority_generation,
		};
		let result: Record<string, unknown> = { kind: "registered", ...common };
		if (attempt) {
			if (request.executionId && request.executionId !== attempt.execution_id)
				throw new EngineTargetError("stale_target", "Execution no longer matches the exact Attempt");
			const command = await this.row<RocksCommand>("command", attempt.command_id);
			const payload = command?.identity.serializedCommand
				? (JSON.parse(command.identity.serializedCommand) as { expectedIntentRevision?: number })
				: undefined;
			result = {
				kind: "bound",
				...common,
				attemptId: attempt.attempt_id,
				executionId: attempt.execution_id,
				authorityGeneration: attempt.authority_generation,
				targetEngineGeneration: attempt.engine_generation,
				bindingId: attempt.binding_id,
				bindingGeneration: attempt.binding_generation,
				...(payload?.expectedIntentRevision !== undefined
					? { startCommandId: command!.command_id, startExpectedIntentRevision: payload.expectedIntentRevision }
					: {}),
			};
		} else {
			const page = await this.records.query("command_agent_pending", [identity.agent_instance_id]);
			if (page.nextCursor)
				throw new EngineTargetError("restore_budget", "Pending target exceeds the bounded command page");
			const pending = page.records
				.map(row => row.value as unknown as RocksCommand)
				.filter(
					row => row.operation === "start" && (!request.attemptId || row.identity.attemptId === request.attemptId),
				)
				.at(-1);
			if (pending) {
				if (request.executionId && request.executionId !== pending.identity.executionId)
					throw new EngineTargetError("stale_target", "Pending execution changed");
				const command = pending.identity.serializedCommand
					? (JSON.parse(pending.identity.serializedCommand) as { expectedIntentRevision?: number })
					: undefined;
				result = {
					kind: "pending",
					...common,
					commandId: pending.command_id,
					attemptId: pending.identity.attemptId,
					executionId: pending.identity.executionId,
					authorityGeneration: pending.identity.authorityGeneration,
					targetEngineGeneration: pending.engine_generation,
					...(command?.expectedIntentRevision !== undefined
						? { startExpectedIntentRevision: command.expectedIntentRevision }
						: {}),
				};
			} else if (request.attemptId || request.executionId)
				throw new EngineTargetError("stale_target", "Exact Attempt is not present");
		}
		await this.assertCut(cut);
		return result;
	}
	async runtimeSummary(request: RuntimeAccess & { agentInstanceRef: string }): Promise<Record<string, unknown>> {
		validateRuntimeValue("nativeSummaryRequest", request);
		const work = queryWork();
		const cut = await this.meta(work);
		const identity = await this.identity(request.agentInstanceRef, request, work);
		if (!identity.summary_json) throw new EngineTargetError("projection_changed", "Agent summary is not retained");
		const summary = work.decode<Record<string, unknown>>(identity.summary_json);
		await this.assertCut(cut, work);
		return finish("summaryRead", { version: "1.0", ...cut, summary, work: work.value }, work, 1);
	}
	async projectionPage(
		request: RuntimePageRequest,
		subtype: "message" | "input",
		type: string,
	): Promise<Record<string, unknown>> {
		readRequest(request, "detailPageRequest");
		const work = queryWork();
		const cut = await this.meta(work);
		const identity = await this.identity(request.agentInstanceRef, request, work);
		const attempt = await this.attempt(identity, request.attemptId, work);
		if (!attempt) throw new EngineTargetError("stale_target", "An exact Attempt is required");
		const revision = subtype === "message" ? attempt.message_revision : attempt.input_revision;
		if (request.revision !== undefined && request.revision !== revision)
			throw new EngineTargetError("stale_target", "Collection revision changed");
		const scope = [subtype, cut.epoch, cut.generation, request.agentInstanceRef, attempt.attempt_id, revision];
		const start = decodeCursor<string | undefined>(request.cursor, scope, undefined);
		const items: Record<string, unknown>[] = [];
		let cursor = start;
		let next: string | null = null;
		const limit = Math.min(
			request.limit ?? (subtype === "message" ? 16 : runtimeLimits.httpPageRecords),
			subtype === "message" ? 16 : runtimeLimits.httpPageRecords,
		);
		for (let i = 0; i < limit; i++) {
			const page = await this.records.query(
				"projection_attempt" as StorageRuntimeIndex,
				[subtype, attempt.attempt_id],
				cursor,
				1,
			);
			account(work, page.records);
			const row = page.records[0]?.value as unknown as RocksProjection | undefined;
			if (!row) {
				next = page.nextCursor;
				break;
			}
			if (size(items) + size(row.value) > runtimeLimits.httpPageBytes - 4096) {
				next = cursor ?? null;
				if (!items.length) throw new EngineTargetError("restore_budget", "Projection item cannot fit its page");
				break;
			}
			items.push(row.value);
			next = page.nextCursor;
			if (!next) break;
			cursor = next;
		}
		await this.assertCut(cut, work);
		return finish(
			type,
			{
				version: "1.0",
				agentInstanceRef: request.agentInstanceRef,
				attemptId: attempt.attempt_id,
				revision,
				items,
				nextCursor: next ? encodeCursor(scope, next) : null,
				work: work.value,
			},
			work,
			items.length,
		);
	}
	runtimeMessages(request: RuntimePageRequest): Promise<Record<string, unknown>> {
		return this.projectionPage(request, "message", "messagesPage");
	}
	async runtimeInput(request: RuntimePageRequest): Promise<Record<string, unknown>> {
		if (!request.inputId) return this.projectionPage(request, "input", "inputPage");
		readRequest(request, "inputReadRequest");
		const work = queryWork();
		const cut = await this.meta(work);
		const identity = await this.identity(request.agentInstanceRef, request, work);
		await this.attempt(identity, request.attemptId, work);
		const row = await this.row<RocksProjection>(
			"projection",
			projectionId("input", request.attemptId!, request.inputId),
			work,
		);
		if (!row?.body || row.resolved || row.value.revision !== request.revision)
			throw new EngineTargetError("stale_target", "Pending input or its revision changed");
		const bytes = size(row.body);
		const partial = bytes > runtimeLimits.httpPageBytes - runtimeLimits.bulkPreviewBytes;
		const input = partial ? runtimeInputPreview(row.body) : row.body;
		await this.assertCut(cut, work);
		return finish(
			"inputDetail",
			{
				version: "1.0",
				agentInstanceRef: request.agentInstanceRef,
				attemptId: request.attemptId,
				input,
				partial,
				...(partial
					? {
							resource: {
								kind: "input",
								agentInstanceRef: request.agentInstanceRef,
								attemptId: request.attemptId,
								inputId: request.inputId,
								revision: request.revision,
								mediaType: "application/json",
								bytes,
							},
						}
					: {}),
				work: work.value,
			},
			work,
			1,
		);
	}
	async runtimeHolds(request: RuntimePageRequest): Promise<Record<string, unknown>> {
		readRequest(request, "holdsReadRequest");
		const work = queryWork();
		const cut = await this.meta(work);
		const identity = await this.identity(request.agentInstanceRef, request, work);
		if (request.attemptId) {
			const current = await this.attempt(identity, undefined, work);
			if (current?.attempt_id !== request.attemptId)
				throw new EngineTargetError("stale_target", "Hold read no longer names the current Attempt");
		}
		const revision = identity.intent_revision;
		if (request.revision !== undefined && request.revision !== revision)
			throw new EngineTargetError("stale_target", "Hold revision changed");
		const scope = ["holds", cut.epoch, cut.generation, request.agentInstanceRef, request.attemptId, revision];
		const offset = decodeCursor<number>(request.cursor, scope, 0);
		const rows = await projectedHolds(new RuntimeTransaction(this.records), identity, work);
		const items = rows.slice(offset, offset + (request.limit ?? runtimeLimits.httpPageRecords));
		await this.assertCut(cut, work);
		return finish(
			"holdsPage",
			{
				version: "1.0",
				agentInstanceRef: request.agentInstanceRef,
				attemptId: request.attemptId ?? null,
				revision,
				items,
				nextCursor: offset + items.length < rows.length ? encodeCursor(scope, offset + items.length) : null,
				work: work.value,
			},
			work,
			items.length,
		);
	}
	async runtimeQueue(request: RuntimeQueueRequest): Promise<Record<string, unknown>> {
		readRequest(request, "queueReadRequest");
		const work = queryWork();
		const cut = await this.meta(work);
		const identity = await this.identity(request.agentInstanceRef, request, work);
		const scope = ["queue", cut.epoch, cut.generation, request.agentInstanceRef, identity.queue_revision];
		let cursor = decodeCursor<string | undefined>(request.cursor, scope, undefined);
		let next: string | null = null;
		const items: Record<string, unknown>[] = [];
		for (let i = 0; i < (request.queueId ? 1 : (request.limit ?? runtimeLimits.httpPageRecords)); i++) {
			const page = request.queueId
				? { records: [await this.records.get("inbox", request.queueId)], nextCursor: null }
				: await this.records.query(
						"inbox_agent_pending" as StorageRuntimeIndex,
						[identity.agent_instance_id],
						cursor,
						1,
					);
			account(work, page.records);
			const row = page.records[0]?.value as unknown as RocksInbox | undefined;
			if (!row) break;
			if (row.agent_instance_id !== identity.agent_instance_id)
				throw new EngineTargetError("stale_target", "Queue item belongs to another agent");
			const item = publicRuntimeQueueItem(request.agentInstanceRef, row);
			if (size(items) + size(item) > runtimeLimits.httpPageBytes - 4096) {
				next = cursor ?? null;
				if (!items.length) throw new EngineTargetError("restore_budget", "Queue item cannot fit its page");
				break;
			}
			items.push(item);
			next = page.nextCursor;
			if (!next) break;
			cursor = next;
		}
		await this.assertCut(cut, work);
		return finish(
			"queuePage",
			{
				version: "1.0",
				agentInstanceRef: request.agentInstanceRef,
				queueRevision: identity.queue_revision,
				items,
				nextCursor: next ? encodeCursor(scope, next) : null,
				work: work.value,
			},
			work,
			items.length,
		);
	}
	async runtimeTools(request: RuntimePageRequest): Promise<Record<string, unknown>> {
		readRequest(request, "detailPageRequest");
		const work = queryWork();
		const cut = await this.meta(work);
		const identity = await this.identity(request.agentInstanceRef, request, work);
		const attempt = await this.attempt(identity, request.attemptId, work);
		if (!attempt) throw new EngineTargetError("stale_target", "Exact Attempt required");
		const revision = attempt.tool_revision;
		if (request.revision !== undefined && request.revision !== revision)
			throw new EngineTargetError("stale_target", "Tool revision changed");
		const scope = ["tools", cut.epoch, cut.generation, request.agentInstanceRef, attempt.attempt_id, revision];
		let position = decodeCursor(request.cursor, scope, { state: 0, after: undefined as string | undefined });
		const items: Record<string, unknown>[] = [];
		while (
			position.state < 2 &&
			items.length < Math.min(request.limit ?? runtimeToolPageRecords, runtimeToolPageRecords)
		) {
			const page = await this.records.query(
				"effect_attempt",
				[attempt.attempt_id, ["started", "unknown"][position.state]],
				undefined,
				1,
				position.after ? [position.after] : undefined,
			);
			account(work, page.records);
			const row = page.records[0]?.value as unknown as RocksEffect | undefined;
			if (row?.effect_kind === "tool") items.push(toolSnapshot(row));
			position =
				page.nextCursor && row
					? { state: position.state, after: row.effect_id }
					: { state: position.state + 1, after: undefined };
		}
		await this.assertCut(cut, work);
		return finish(
			"toolsPage",
			{
				version: "1.0",
				agentInstanceRef: request.agentInstanceRef,
				attemptId: attempt.attempt_id,
				revision,
				items,
				nextCursor: position.state < 2 ? encodeCursor(scope, position) : null,
				work: work.value,
			},
			work,
			items.length,
		);
	}
	async detail(
		interest: RuntimeDetailInterest,
		access: RuntimeAccess,
		work: RuntimeQueryWork,
		root?: string,
	): Promise<Record<string, unknown>> {
		const identity = await this.identity(interest.agentInstanceRef, access, work);
		if (root && identity.root_agent_instance_ref !== root)
			throw new EngineTargetError("stale_target", "Selected detail is outside its root");
		const attempt = await this.attempt(identity, interest.kind === "attempt" ? interest.attemptId : undefined, work);
		const row = await this.row<RocksProjection>(
			"projection",
			projectionId("detail", identity.agent_instance_id, attempt?.attempt_id ?? ""),
			work,
		);
		let detail = row?.value;
		if (!detail) throw new EngineTargetError("projection_changed", "Detail projection is not retained");
		if (!interest.kinds.includes("tool")) detail = { ...detail, tools: [], toolsNextCursor: null };
		if (!interest.kinds.includes("input"))
			detail = {
				...detail,
				pendingInputs: [],
				inputsHasMore: Boolean((detail.pendingInputs as unknown[]).length || detail.inputsHasMore),
			};
		if (attempt && interest.kinds.includes("assistant")) {
			const messages = await this.runtimeMessages({
				...access,
				agentInstanceRef: interest.agentInstanceRef,
				attemptId: attempt.attempt_id,
				limit: 16,
			});
			const messageWork = messages.work as RuntimeWork;
			work.value.scannedRows += messageWork.scannedRows;
			work.value.materializedBytes += messageWork.materializedBytes;
			work.check();
			const selected: unknown[] = [];
			for (const message of messages.items as unknown[]) {
				if (size({ ...detail, messages: [...selected, message] }) > runtimeLimits.detailStateBytes) break;
				selected.push(message);
			}
			detail = {
				...detail,
				messages: selected,
				messagesHasMore: Boolean(messages.nextCursor) || selected.length < (messages.items as unknown[]).length,
			};
		}
		if (attempt && interest.kinds.includes("tool")) {
			const tools = await this.runtimeTools({
				...access,
				agentInstanceRef: interest.agentInstanceRef,
				attemptId: attempt.attempt_id,
			});
			const toolWork = tools.work as RuntimeWork;
			work.value.scannedRows += toolWork.scannedRows;
			work.value.materializedBytes += toolWork.materializedBytes;
			work.check();
			detail = { ...detail, tools: tools.items, toolsNextCursor: tools.nextCursor };
		}
		return detail;
	}
	async runtimeSnapshot(
		scope: RuntimeScope,
		access: RuntimeAccess,
		cursor?: string,
		limit = runtimeLimits.httpPageRecords,
		maxBytes = runtimeLimits.httpPageBytes,
	): Promise<RuntimeSnapshot> {
		validateRuntimeValue("scope", scope);
		if (
			!access.principalId ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > runtimeLimits.httpPageRecords ||
			!Number.isInteger(maxBytes) ||
			maxBytes < 1 ||
			maxBytes > runtimeLimits.httpPageBytes
		)
			throw new EngineTargetError("invalid_request", "Invalid snapshot access or page bounds");
		const work = queryWork();
		const cut = await this.meta(work);
		const hash = runtimeProjectionHash(scope);
		const cursorScope = ["snapshot", access, scope, cut];
		const position = decodeCursor(cursor, cursorScope, {
			cursor: undefined as string | undefined,
			memberSource: 0,
			detail: 0,
			membersDone: scope.kind === "agent" || scope.kind === "attempt",
		});
		const page: RuntimeSnapshot = {
			version: "1.0",
			scope,
			...cut,
			projectionHash: hash,
			agents: [],
			...(scope.kind !== "catalog" ? { members: [] } : {}),
			nextCursor: null,
			work: work.value,
		};
		if (scope.kind === "branch") {
			const root = await this.identity(scope.rootAgentInstanceRef, access, work);
			if (root.root_agent_instance_ref !== root.agent_instance_ref)
				throw new EngineTargetError("stale_target", "Branch requires a canonical root");
		}
		const interests = scope.kind === "catalog" ? [] : scope.kind === "branch" ? scope.interests : [scope];
		const fits = (value: unknown) => size(page) + size(value) + 2048 <= maxBytes;
		while (!position.membersDone && page.agents.length + (page.members?.length ?? 0) < limit) {
			let identity: RocksIdentity | undefined;
			let next: string | null = null;
			if (scope.kind === "catalog" && position.memberSource > 0) {
				const ref = access.authorizedAgentInstanceRefs?.[position.memberSource - 1];
				if (!ref) {
					position.membersDone = true;
					break;
				}
				identity = await this.identity(ref, access, work);
				if (identity.principal_id !== "") {
					position.memberSource++;
					continue;
				}
			} else {
				const rows = await this.records.query(
					scope.kind === "branch" ? ("identity_root" as StorageRuntimeIndex) : "identity_principal",
					[scope.kind === "branch" ? scope.rootAgentInstanceRef : access.principalId],
					position.cursor,
					1,
				);
				account(work, rows.records);
				identity = rows.records[0]?.value as unknown as RocksIdentity | undefined;
				next = rows.nextCursor;
				if (!identity) {
					if (scope.kind === "catalog") position.memberSource++;
					else position.membersDone = true;
					position.cursor = undefined;
					continue;
				}
			}
			const value =
				scope.kind === "catalog"
					? (JSON.parse(identity.summary_json ?? "null") as Record<string, unknown>)
					: {
							agentInstanceRef: identity.agent_instance_ref,
							rootAgentInstanceRef: identity.root_agent_instance_ref,
							parentAgentInstanceRef: identity.parent_agent_instance_ref,
							revision: identity.membership_revision,
						};
			if (!value) throw new EngineTargetError("projection_changed", "Summary is not retained");
			if (!fits(value)) {
				if (!page.agents.length && !page.members?.length)
					throw new EngineTargetError("restore_budget", "Snapshot item cannot fit its page");
				break;
			}
			if (scope.kind === "catalog") page.agents.push(value);
			else page.members!.push(value);
			if (position.memberSource > 0) position.memberSource++;
			else if (next) position.cursor = next;
			else if (scope.kind === "catalog") {
				position.memberSource++;
				position.cursor = undefined;
			} else position.membersDone = true;
		}
		while (
			position.membersDone &&
			position.detail < interests.length &&
			page.agents.length + (page.members?.length ?? 0) < limit
		) {
			const value = await this.detail(
				interests[position.detail],
				access,
				work,
				scope.kind === "branch" ? scope.rootAgentInstanceRef : undefined,
			);
			if (!fits(value)) {
				if (!page.agents.length && !page.members?.length)
					throw new EngineTargetError("restore_budget", "Detail cannot fit its page");
				break;
			}
			page.agents.push(value);
			position.detail++;
		}
		if (!position.membersDone || position.detail < interests.length)
			page.nextCursor = encodeCursor(cursorScope, position);
		await this.assertCut(cut, work);
		return finish("snapshot", page, work, page.agents.length + (page.members?.length ?? 0), maxBytes);
	}
	async indexedEvents(
		key: string[],
		after: number,
		limit: number,
		work: RuntimeQueryWork,
	): Promise<{ rows: ProjectedEvent[]; more: boolean }> {
		const page = await this.storageClient.runtimeQuery({
			selector: { type: "index", index: "event_projection" as StorageRuntimeIndex, key, after: [after] },
			maxRecords: limit,
			maxBytes: Math.min(1024 * 1024, work.remaining.materializedBytes - work.value.materializedBytes),
		});
		account(work, page.records);
		return { rows: page.records.map(row => row.value as unknown as ProjectedEvent), more: page.nextCursor !== null };
	}
	async runtimeEvents(request: RuntimeEventsRequest): Promise<RuntimeEventBatch> {
		validateRuntimeValue("nativeEventsRequest", request);
		const work = queryWork(request.remainingWork);
		const meta = await this.meta(work);
		if (request.epoch !== meta.epoch) throw new RuntimeQueryError("epoch_changed", "Owner epoch changed", work.value);
		if (request.afterCursor > meta.watermark)
			throw new RuntimeQueryError("retention_gap", "Event cursor is outside retention", work.value);
		const head = Math.min(request.untilCursor ?? meta.watermark, meta.watermark);
		const sources: Array<{
			key: string[];
			kind?: string;
			attempt?: string;
			agentOnly?: boolean;
			selected?: string[];
		}> = [];
		if (request.scope.kind === "catalog") {
			sources.push({ key: ["summary", request.principalId, "", ""] });
			for (const ref of request.authorizedAgentInstanceRefs ?? []) {
				const identity = await this.identity(ref, request, work);
				if (identity.principal_id === "")
					sources.push({ key: ["summary_agent", identity.agent_instance_id, "", ""] });
			}
		} else {
			if (request.scope.kind === "branch") {
				const root = await this.identity(request.scope.rootAgentInstanceRef, request, work);
				if (root.root_agent_instance_ref !== root.agent_instance_ref)
					throw new EngineTargetError("stale_target", "Branch requires a canonical root");
				sources.push({ key: ["membership", root.agent_instance_ref, "", ""] });
			}
			for (const interest of request.scope.kind === "branch" ? request.scope.interests : [request.scope]) {
				const identity = await this.identity(interest.agentInstanceRef, request, work);
				if (
					request.scope.kind === "branch" &&
					identity.root_agent_instance_ref !== request.scope.rootAgentInstanceRef
				)
					throw new EngineTargetError("stale_target", "Interest is outside its branch");
				const attempt = await this.attempt(
					identity,
					interest.kind === "attempt" ? interest.attemptId : undefined,
					work,
				);
				for (const kind of interest.kinds) {
					if (attempt)
						sources.push({
							key: ["detail", identity.agent_instance_id, attempt.attempt_id, kind],
							kind,
							attempt: attempt.attempt_id,
							selected: interest.kinds,
						});
					if (kind === "state" || kind === "queue")
						sources.push({
							key: ["agent", identity.agent_instance_id, "", kind],
							kind,
							agentOnly: true,
							selected: interest.kinds,
						});
				}
			}
		}
		const candidates = new Map<number, RuntimeChange[]>();
		let through = head;
		for (const source of sources) {
			const page = await this.indexedEvents(
				source.key,
				request.afterCursor,
				Math.max(1, Math.ceil(request.limit / Math.max(1, sources.length))),
				work,
			);
			if (page.more && page.rows.length) through = Math.min(through, page.rows.at(-1)!.eventId);
			for (const event of page.rows) {
				if (event.eventId > head) continue;
				let changes: RuntimeChange[];
				if (!source.kind) {
					const value = source.key[0] === "membership" ? event.membership_payload : event.summary_payload;
					changes = value
						? [
								{
									kind: source.key[0] === "membership" ? "membership" : "summary",
									agentInstanceRef: String(value.agentInstanceRef),
									cursor: event.eventId,
									revision: Number(value.revision),
									value,
								},
							]
						: [];
				} else
					changes = event.projection_payload.filter(change => {
						const attempt = change.kind === "state" ? change.value.attemptId : change.attemptId;
						const kind =
							change.kind === "receipt"
								? "state"
								: change.kind === "invalidate"
									? change.value.resource === "holds"
										? "state"
										: change.value.resource === "context"
											? "usage"
											: change.value.resource
									: change.kind;
						return (
							kind === source.kind &&
							(source.agentOnly ? attempt === undefined || attempt === null : attempt === source.attempt)
						);
					});
				changes = changes.map(change =>
					change.kind !== "state"
						? change
						: {
								...change,
								value: {
									...change.value,
									...(!source.selected?.includes("tool") ? { tools: [], toolsNextCursor: null } : {}),
									...(!source.selected?.includes("input")
										? {
												pendingInputs: [],
												inputsHasMore: Boolean(
													(change.value.pendingInputs as unknown[]).length || change.value.inputsHasMore,
												),
											}
										: {}),
								},
							},
				);
				const existing = candidates.get(event.eventId) ?? [];
				for (const change of changes)
					if (!existing.some(item => JSON.stringify(item) === JSON.stringify(change))) existing.push(change);
				candidates.set(event.eventId, existing);
			}
		}
		const result: RuntimeEventBatch = {
			epoch: meta.epoch,
			throughCursor: through,
			headCursor: head,
			changes: [],
			hasMore: through < head,
			work: work.value,
		};
		for (const [id, changes] of [...candidates].sort(([a], [b]) => a - b)) {
			if (id > through) break;
			if (
				result.changes.length + changes.length > request.limit ||
				size({ ...result, changes: [...result.changes, ...changes] }) + 128 > request.maxBytes
			) {
				if (!result.changes.length)
					throw new RuntimeQueryError("restore_budget", "One event exceeds the delivery budget", work.value);
				result.throughCursor = id - 1;
				result.hasMore = true;
				break;
			}
			result.changes.push(...changes);
		}
		return finish("eventBatch", result, work, result.changes.length, request.maxBytes);
	}
	async waitRuntimeEvents(request: RuntimeEventsRequest, signal?: AbortSignal): Promise<RuntimeEventBatch> {
		const change = this.changeSignal();
		const result = await this.runtimeEvents(request);
		if (
			result.changes.length ||
			result.hasMore ||
			request.untilCursor !== undefined ||
			signal?.aborted ||
			request.timeoutMs <= 0
		)
			return result;
		const wake = Promise.withResolvers<void>();
		const abort = () => wake.resolve();
		const timer = setTimeout(
			abort,
			Math.min(
				request.timeoutMs,
				request.scope.kind === "catalog" ? runtimeLimits.appCursorHeartbeatMs : runtimeLimits.eventWaitMs,
			),
		);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await Promise.race([change, wake.promise]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
		const next = await this.runtimeEvents({
			...request,
			afterCursor: result.throughCursor,
			remainingWork: {
				...request.remainingWork,
				scannedRows: request.remainingWork.scannedRows - result.work.scannedRows,
				materializedBytes: request.remainingWork.materializedBytes - result.work.materializedBytes,
				timeMs: request.remainingWork.timeMs - result.work.elapsedMs,
			},
		});
		next.work.scannedRows += result.work.scannedRows;
		next.work.materializedBytes += result.work.materializedBytes;
		next.work.elapsedMs += result.work.elapsedMs;
		for (;;) {
			const bytes = size(next);
			if (bytes === next.work.bytes) break;
			next.work.bytes = bytes;
		}
		if (next.work.bytes > request.maxBytes)
			throw new RuntimeQueryError("restore_budget", "Event read exceeds its byte budget", next.work);
		validateRuntimeValue("eventBatch", next);
		return next;
	}
	async runtimeCommand(
		commandId: string,
		access?: RuntimeAccess,
		browserPayloadHash?: string,
	): Promise<Record<string, unknown>> {
		const row = await this.row<RocksCommand>("command", commandId);
		if (!row)
			return {
				commandId,
				lookup: "outcome_unknown",
				dedupHorizonMs: runtimeLimits.dedupHorizonMs,
				retention: "indefinite",
			};
		const identity = row.identity;
		if (
			access &&
			identity.principalId !== access.principalId &&
			!(identity.principalId === "" && access.authorizedAgentInstanceRefs?.includes(identity.agentInstanceRef ?? ""))
		)
			throw new EngineTargetError("agent_not_found", "Unknown authorized command");
		if (browserPayloadHash && identity.browserPayloadHash !== browserPayloadHash)
			throw new EngineCommandConflictError(commandId);
		const agent = await this.row<RocksIdentity>("identity", row.agent_instance_id);
		const attempt = identity.attemptId ? await this.row<RocksAttempt>("attempt", identity.attemptId) : undefined;
		const receipt = runtimeReceipt(row, agent, attempt);
		return {
			commandId,
			lookup: row.state === "settled" ? "known" : "pending",
			stage:
				row.receipt?.outcome === "rejected"
					? "rejected"
					: row.state !== "settled"
						? "engine_accepted"
						: row.operation === "start" && attempt && terminal.has(attempt.state)
							? "execution_terminal"
							: "applied",
			receipt: row.receipt ?? undefined,
			rawCanonicalHash: row.canonical_hash,
			browserPayloadHash: identity.browserPayloadHash,
			target: {
				agentInstanceRef: identity.agentInstanceRef,
				agentInstanceId: row.agent_instance_id,
				attemptId: identity.attemptId,
				executionId: identity.executionId,
			},
			dedupHorizonMs: runtimeLimits.dedupHorizonMs,
			dedupUntil: row.state === "settled" ? row.updated_at + runtimeLimits.dedupHorizonMs : null,
			retention: "indefinite",
			...receipt,
		};
	}
}
