import type { StorageRuntimeIndex } from "../session/storage-protocol";
import { type EngineTarget, EngineTargetError } from "./contracts";
import { decodeCursor, encodeCursor } from "./rocks-runtime-cursor";
import type { ProjectedEvent, RocksProjection } from "./rocks-runtime-projection";
import { projectionId, terminal } from "./rocks-runtime-projection";
import type { RocksAttempt, RocksBinding, RocksCommand } from "./rocks-runtime-rows";
import { queryWork, type RocksEngineStore } from "./rocks-runtime-store";
import type { EngineNativeHistoryPage } from "./runtime-history";
import type { HistoryLifecycleContext } from "./runtime-lifecycle";
import { type RuntimeRemainingWork, runtimeLimits, validateRuntimeValue } from "./runtime-protocol";

interface NativeScope {
	familyId: string;
	generationId: string;
}
interface NativeCut extends NativeScope {
	cutSeq: number;
	sessionId: string;
}
interface LifecycleContext extends HistoryLifecycleContext {
	anchors: Array<{ attemptId: string; entryId: string; eventId: number }>;
}
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export async function nativeScope(
	store: RocksEngineStore,
	agentId: string,
	attemptId?: string,
): Promise<{ scope: NativeScope; path: string; attempt?: RocksAttempt; currentAttemptId: string | null }> {
	const binding = await store.row<RocksBinding>("binding", agentId);
	const attempt = attemptId
		? await store.row<RocksAttempt>("attempt", attemptId)
		: binding
			? await store.row<RocksAttempt>("attempt", binding.attempt_id)
			: undefined;
	if (attemptId && (!attempt || attempt.agent_instance_id !== agentId))
		throw new EngineTargetError("stale_target", "History Attempt belongs to another agent");
	const path = attempt?.transcript_path ?? binding?.session_file;
	const match = path?.match(/^native:([^/]+)\/([^/]+)$/);
	if (!path || !match) throw new EngineTargetError("history_expired", "Native history locator is not retained");
	return {
		scope: { familyId: decodeURIComponent(match[1]), generationId: decodeURIComponent(match[2]) },
		path,
		attempt,
		currentAttemptId: attemptId ?? binding?.attempt_id ?? null,
	};
}
function header(state: Record<string, unknown> | null | undefined): { id: string; cwd?: string } {
	const value = (state?.native as { header?: { id: string; cwd?: string } } | undefined)?.header;
	if (!value || typeof value.id !== "string")
		throw new EngineTargetError("history_expired", "Native session header is not retained");
	return value;
}
export async function nativeSessionHeader(
	store: RocksEngineStore,
	target: EngineTarget,
): Promise<{ sessionId: string; cwd: string | null }> {
	const selected = await nativeScope(store, target.agentInstanceId, target.attemptId);
	const attempt = selected.attempt!;
	if (
		attempt.execution_id !== target.executionId ||
		attempt.binding_id !== target.bindingId ||
		attempt.binding_generation !== target.bindingGeneration ||
		attempt.engine_generation !== target.engineGeneration ||
		attempt.authority_generation !== target.authorityGeneration
	)
		throw new EngineTargetError("stale_target", "Native session target changed");
	const page = await store.storageClient.readContext({
		...selected.scope,
		maxRecords: 1,
		maxBytes: runtimeLimits.httpPageBytes,
	});
	const value = header(page.state);
	return { sessionId: value.id, cwd: value.cwd ?? null };
}
export async function nativeHistoryPage(
	store: RocksEngineStore,
	agentId: string,
	cursor?: string,
	limit = runtimeLimits.httpPageRecords,
	attemptId?: string,
): Promise<EngineNativeHistoryPage> {
	if (!Number.isInteger(limit) || limit < 1 || limit > runtimeLimits.httpPageRecords)
		throw new EngineTargetError("invalid_request", "History page limit exceeds the owner budget");
	const started = performance.now();
	const selected = await nativeScope(store, agentId, attemptId);
	const meta = await store.meta();
	const cursorScope = ["history", agentId, attemptId ?? null, selected.path, meta.epoch, meta.generation];
	const initial = await store.storageClient.readContext({
		...selected.scope,
		...(selected.attempt?.transcript_native && terminal.has(selected.attempt.state)
			? { cutSeq: selected.attempt.transcript_native.throughSeq }
			: {}),
		maxRecords: 1,
		maxBytes: runtimeLimits.httpPageBytes,
	});
	const session = header(initial.state);
	const currentLeaf = terminal.has(selected.attempt?.state ?? "")
		? (selected.attempt?.transcript_leaf_entry_id ?? initial.head?.leafId ?? null)
		: (initial.head?.leafId ?? null);
	const position = decodeCursor(cursor, cursorScope, {
		cutSeq: initial.throughSeq,
		leafId: currentLeaf,
		next: currentLeaf,
		watermark: meta.watermark,
		sessionId: session.id,
	});
	if (position.sessionId !== session.id || position.cutSeq > initial.liveThroughSeq)
		throw new EngineTargetError("stale_target", "History cursor changed its native session");
	const entries: Record<string, unknown>[] = [];
	let visited = 1;
	let readBytes = jsonBytes(initial);
	let next = position.next;
	let entryRef: EngineNativeHistoryPage["entryRef"];
	let first: string | null = null;
	const lineage = encodeCursor(["native-cut", agentId, selected.path], {
		...selected.scope,
		sessionId: session.id,
		cutSeq: position.cutSeq,
	} satisfies NativeCut);
	let fallback: EngineNativeHistoryPage["projectionFallback"];
	const continuation = (value: string | null) =>
		value ? encodeCursor(cursorScope, { ...position, next: value }) : null;
	for (let count = 0; next && count < limit; count++) {
		const page = await store.storageClient.readContext({
			...selected.scope,
			leafId: next,
			cutSeq: position.cutSeq,
			maxRecords: 1,
			maxBytes: runtimeLimits.httpPageBytes,
		});
		const entry = page.events[0];
		visited++;
		readBytes += jsonBytes(page);
		if (!entry || entry.entryId !== next)
			throw new EngineTargetError("history_expired", "Frozen native entry is unavailable");
		const bytes = jsonBytes(entry.payload);
		if (entries.length && jsonBytes(entries) + bytes > runtimeLimits.httpPageBytes - 8192) break;
		first ??= entry.entryId;
		if (!fallback)
			fallback = {
				entryRef: { entryId: entry.entryId, revision: lineage, bytes, method: "runtime.history.entry" },
				nextCursor: continuation(entry.parentId),
			};
		next = entry.parentId;
		if (bytes > runtimeLimits.httpPageBytes - 8192) {
			entryRef = fallback.entryRef;
			break;
		}
		entries.unshift(entry.payload);
		if (
			readBytes > runtimeLimits.bootstrapMaterializedBytes ||
			performance.now() - started > runtimeLimits.bootstrapTimeoutMs
		)
			throw new EngineTargetError("restore_budget", "Native history read work exceeds its bound");
	}
	const anchors: LifecycleContext["anchors"] = [];
	for (const entry of entries) {
		if (typeof entry.sourceCommandId === "string") {
			const command = await store.row<RocksCommand>("command", entry.sourceCommandId);
			const owner = await store.row<RocksProjection>(
				"projection",
				projectionId("ownership", "command", entry.sourceCommandId),
			);
			if (command?.agent_instance_id === agentId && command.identity.attemptId && owner)
				anchors.push({ attemptId: command.identity.attemptId, entryId: String(entry.id), eventId: owner.position });
		} else if (typeof entry.assistantMessageId === "string") {
			const owner = await store.row<RocksProjection>(
				"projection",
				projectionId("ownership", agentId, entry.assistantMessageId),
			);
			if (owner) anchors.push({ attemptId: owner.attempt_id, entryId: String(entry.id), eventId: owner.position });
		}
	}
	const lifecycleContext: LifecycleContext = {
		agentInstanceId: agentId,
		sessionPath: selected.path,
		sessionId: session.id,
		lineage,
		anchor: position.leafId,
		first,
		count: entries.length + (entryRef ? 1 : 0),
		currentAttemptId: selected.currentAttemptId,
		targetAttemptId: attemptId ?? null,
		watermark: position.watermark,
		anchors,
	};
	return {
		sessionId: session.id,
		revision: position.leafId ?? "empty",
		anchor: position.leafId,
		entries,
		nextCursor: continuation(next),
		lifecycleContext,
		...(entryRef ? { entryRef } : {}),
		...(fallback ? { projectionFallback: fallback } : {}),
		visitedRecords: visited,
		readBytes,
		elapsedMs: Math.ceil(performance.now() - started),
	};
}
export async function nativeEntry(
	store: RocksEngineStore,
	agentId: string,
	entryId: string,
	revision: string,
	expectedSessionId?: string,
	attemptId?: string,
): Promise<Record<string, unknown>> {
	const selected = await nativeScope(store, agentId, attemptId);
	const cut = decodeCursor<NativeCut | undefined>(revision, ["native-cut", agentId, selected.path], undefined);
	if (
		!cut ||
		cut.familyId !== selected.scope.familyId ||
		cut.generationId !== selected.scope.generationId ||
		(expectedSessionId && cut.sessionId !== expectedSessionId)
	)
		throw new EngineTargetError("stale_target", "Native history resource changed scope");
	const page = await store.storageClient.readContext({
		...selected.scope,
		cutSeq: cut.cutSeq,
		leafId: entryId,
		maxRecords: 1,
		maxBytes: runtimeLimits.httpPageBytes,
	});
	if (header(page.state).id !== cut.sessionId || page.events[0]?.entryId !== entryId)
		throw new EngineTargetError("history_expired", "Native history entry is unavailable");
	return page.events[0].payload;
}
export async function nativeHistoryEntry(
	store: RocksEngineStore,
	agentId: string,
	entryId: string,
	revision: string,
	offset = 0,
	limit = runtimeLimits.deliveryBatchBytes,
	expectedSessionId?: string,
	attemptId?: string,
): Promise<Record<string, unknown>> {
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > runtimeLimits.deliveryBatchBytes
	)
		throw new EngineTargetError("invalid_request", "History range exceeds its byte budget");
	const entry = await nativeEntry(store, agentId, entryId, revision, expectedSessionId, attemptId);
	const bytes = Buffer.from(JSON.stringify(entry));
	if (offset > bytes.length) throw new EngineTargetError("invalid_request", "History range starts after EOF");
	const end = Math.min(offset + limit, bytes.length);
	return {
		sessionId:
			expectedSessionId ??
			decodeCursor<NativeCut | undefined>(
				revision,
				["native-cut", agentId, (await nativeScope(store, agentId, attemptId)).path],
				undefined,
			)?.sessionId,
		entryId,
		revision,
		offset,
		totalBytes: bytes.length,
		contentBase64: bytes.subarray(offset, end).toString("base64"),
		nextOffset: end < bytes.length ? end : null,
	};
}
const lifecycleKinds: Record<string, [string, string]> = {
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
};
export async function nativeLifecyclePage(
	store: RocksEngineStore,
	agentId: string,
	agentRef: string,
	limit: number,
	attemptId?: string,
	context?: HistoryLifecycleContext,
	cursor?: string,
	maxBytes = runtimeLimits.httpPageBytes,
	remaining?: RuntimeRemainingWork,
) {
	const work = queryWork(remaining);
	const selected = await nativeScope(store, agentId, attemptId);
	const cursorScope = ["lifecycle", agentId, agentRef, attemptId ?? null, selected.path];
	const position = decodeCursor(cursor, cursorScope, {
		context: context as LifecycleContext | undefined,
		before: (context?.watermark ?? 0) + 1,
	});
	const pinned = position.context;
	if (
		!pinned ||
		pinned.agentInstanceId !== agentId ||
		pinned.sessionPath !== selected.path ||
		pinned.targetAttemptId !== (attemptId ?? null)
	)
		throw new EngineTargetError("stale_target", "Lifecycle cursor changed its owner or Attempt");
	const attempts = new Set([
		...(pinned.currentAttemptId ? [pinned.currentAttemptId] : []),
		...(pinned.anchors ?? []).map(row => row.attemptId),
	]);
	let pageMore = false;
	const candidates: ProjectedEvent[] = [];
	for (const id of limit > 0 ? attempts : []) {
		const page = await store.storageClient.runtimeQuery({
			selector: {
				type: "index",
				index: "event_lifecycle" as StorageRuntimeIndex,
				key: [id],
				after: [position.before],
			},
			maxRecords: Math.max(1, Math.min(limit + 1, runtimeLimits.httpPageRecords)),
			maxBytes: Math.min(runtimeLimits.httpPageBytes, work.remaining.materializedBytes),
		});
		pageMore ||= Boolean(page.nextCursor);
		work.rows(page.records.length);
		work.value.materializedBytes += jsonBytes(page);
		work.check();
		candidates.push(...page.records.map(row => row.value as unknown as ProjectedEvent));
	}
	candidates.sort((a, b) => b.eventId - a.eventId);
	const activities: Record<string, unknown>[] = [];
	let before = position.before;
	for (const event of candidates) {
		if (activities.length >= limit) break;
		const mapped = lifecycleKinds[event.kind];
		if (!mapped) continue;
		const anchor = pinned.anchors?.findLast(
			row => row.attemptId === event.attemptId && row.eventId <= event.eventId,
		)?.entryId;
		const activity = {
			id: `engine:${pinned.sessionId}:${agentRef}:${event.attemptId}:${event.eventId}`,
			kind: "lifecycle",
			source: "engine",
			sessionId: pinned.sessionId,
			agentInstanceRef: agentRef,
			attemptId: event.attemptId,
			executionId: event.executionId,
			eventId: String(event.eventId),
			seq: event.seq,
			status: mapped[0],
			terminal: terminal.has(event.kind),
			label: mapped[1],
			at: event.createdAt,
			...(event.causationCommandId ? { causationCommandId: event.causationCommandId } : {}),
			...(event.lifecycle_summary ? { summary: event.lifecycle_summary } : {}),
			...(anchor ? { afterEntryId: anchor } : {}),
		};
		validateRuntimeValue("lifecycleActivity", activity);
		if (jsonBytes(activities) + jsonBytes(activity) + 2048 > maxBytes) break;
		activities.push(activity);
		before = event.eventId;
	}
	const more = limit === 0 || pageMore || candidates.length > activities.length;
	if (!activities.length && more && limit > 0)
		throw new EngineTargetError("restore_budget", "Lifecycle item cannot fit its requested page");
	const result = {
		sessionId: pinned.sessionId,
		revision: pinned.anchor ?? "empty",
		anchor: pinned.anchor,
		activities: activities.reverse(),
		activityNextCursor: more ? encodeCursor(cursorScope, { context: pinned, before }) : null,
		work: work.value,
	};
	work.finish(result, activities.length);
	if (jsonBytes(result) > maxBytes)
		throw new EngineTargetError("restore_budget", "Lifecycle page exceeds its byte budget");
	return result;
}
