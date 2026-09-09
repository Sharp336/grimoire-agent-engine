import { EngineTargetError } from "./contracts";
import { runtimeMessageBaselines } from "./runtime-messages";
import {
	RUNTIME_KIND_MASK,
	type RuntimeIdentityRow,
	RuntimeQueryError,
	RuntimeQueryWork,
	type RuntimeSql,
	runtimeIdentity,
	runtimeMeta,
} from "./runtime-projection";
import {
	type RuntimeAccess,
	type RuntimeChange,
	type RuntimeDetailInterest,
	type RuntimeEventBatch,
	type RuntimeEventsRequest,
	type RuntimeScope,
	type RuntimeWork,
	runtimeLimits,
	runtimeProjectionHash,
	validateRuntimeValue,
} from "./runtime-protocol";
import { runtimeToolBaselines } from "./runtime-resources";

export interface RuntimeSnapshot {
	version: "1.0";
	scope: RuntimeScope;
	epoch: string;
	generation: number;
	watermark: number;
	projectionHash: string;
	agents: Record<string, unknown>[];
	members?: Record<string, unknown>[];
	nextCursor: string | null;
	work: RuntimeWork;
}

interface SnapshotCursor {
	epoch: string;
	generation: number;
	cut: number;
	hash: string;
	after: string;
	detail: number;
	membersDone: boolean;
}

interface EventMetadata {
	event_id: number;
	agent_instance_id: string;
	agent_instance_ref: string;
	attempt_id: string;
	projection_kinds: number;
}

interface EventSource {
	where: string;
	values: Array<string | number>;
	column: "summary_payload" | "membership_payload" | "projection_payload";
	mask?: number;
	attemptId?: string;
}

function readCursor<T>(cursor: string): T {
	try {
		return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
	} catch {
		throw new EngineTargetError("stale_target", "Invalid owner cursor");
	}
}

function encodeCursor(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function bootstrapWork(): RuntimeQueryWork {
	return new RuntimeQueryWork({
		bytes: runtimeLimits.bootstrapBytes,
		changes: runtimeLimits.bootstrapRecords,
		scannedRows: runtimeLimits.bootstrapScannedRows,
		materializedBytes: runtimeLimits.bootstrapMaterializedBytes,
		timeMs: runtimeLimits.bootstrapTimeoutMs,
	});
}

function accessSql(access: RuntimeAccess): { where: string; values: string[] } {
	if (!access.principalId) throw new EngineTargetError("invalid_request", "A server principal is required");
	const legacy = access.authorizedAgentInstanceRefs ?? [];
	return {
		where: `(i.principal_id=?${legacy.length ? ` OR (i.principal_id='' AND i.agent_instance_ref IN (${legacy.map(() => "?").join(",")}))` : ""})`,
		values: [access.principalId, ...legacy],
	};
}

async function identityAt(
	sql: RuntimeSql,
	ref: string,
	access: RuntimeAccess,
	work: RuntimeQueryWork,
): Promise<RuntimeIdentityRow> {
	const identity = await runtimeIdentity(sql, ref, access);
	work.rows(1);
	return identity;
}

async function summaryAt(
	sql: RuntimeSql,
	identity: RuntimeIdentityRow,
	cut: number,
	work: RuntimeQueryWork,
): Promise<Record<string, unknown>> {
	const rows = (await sql.unsafe(
		`SELECT summary_payload FROM engine_event_outbox WHERE agent_instance_id=?
		AND summary_payload IS NOT NULL AND event_id<=? ORDER BY event_id DESC LIMIT 1`,
		[identity.agent_instance_id, cut],
	)) as Array<{ summary_payload: string }>;
	work.rows(rows.length);
	if (!rows[0])
		throw new RuntimeQueryError("projection_changed", "Agent summary is not retained at this snapshot cut", {
			...work.value,
		});
	return work.decode<Record<string, unknown>>(rows[0].summary_payload);
}

export async function readRuntimeSummary(
	sql: RuntimeSql,
	request: RuntimeAccess & { agentInstanceRef: string },
): Promise<Record<string, unknown>> {
	validateRuntimeValue("nativeSummaryRequest", request);
	const work = bootstrapWork();
	const meta = await runtimeMeta(sql);
	work.rows(3);
	const identity = await identityAt(sql, request.agentInstanceRef, request, work);
	if (!identity.summary_json)
		throw new RuntimeQueryError("projection_changed", "Summary migration is incomplete", { ...work.value });
	const summary = work.decode<Record<string, unknown>>(identity.summary_json);
	const result = { version: "1.0", ...meta, summary, work: work.value };
	work.finish(result, 1);
	validateRuntimeValue("summaryRead", result);
	return result;
}

async function selectedDetail(
	sql: RuntimeSql,
	interest: RuntimeDetailInterest,
	access: RuntimeAccess,
	cut: number,
	root: string | undefined,
	work: RuntimeQueryWork,
): Promise<Record<string, unknown>> {
	const identity = await identityAt(sql, interest.agentInstanceRef, access, work);
	if (root && identity.root_agent_instance_ref !== root)
		throw new EngineTargetError("stale_target", "Selected detail is outside the root branch");
	const summary = await summaryAt(sql, identity, cut, work);
	const summaryTarget = summary.target as { attemptId?: string };
	const attemptId = interest.kind === "attempt" ? interest.attemptId : summaryTarget.attemptId;
	let detail: Record<string, unknown>;
	if (attemptId) {
		const rows = (await sql.unsafe(
			`SELECT detail_payload FROM engine_event_outbox WHERE attempt_id=?
			AND agent_instance_id=? AND detail_payload IS NOT NULL AND event_id<=? ORDER BY event_id DESC LIMIT 1`,
			[attemptId, identity.agent_instance_id, cut],
		)) as Array<{ detail_payload: string }>;
		work.rows(rows.length);
		if (!rows[0]) throw new EngineTargetError("stale_target", "Exact Attempt detail is not present at the cut");
		detail = work.decode<Record<string, unknown>>(rows[0].detail_payload);
	} else {
		const rows = (await sql.unsafe(
			`SELECT detail_payload FROM engine_event_outbox WHERE agent_instance_id=?
			AND detail_payload IS NOT NULL AND event_id<=? ORDER BY event_id DESC LIMIT 1`,
			[identity.agent_instance_id, cut],
		)) as Array<{ detail_payload: string }>;
		work.rows(rows.length);
		if (!rows[0])
			throw new RuntimeQueryError("projection_changed", "Registered detail has no retained baseline", {
				...work.value,
			});
		detail = work.decode<Record<string, unknown>>(rows[0].detail_payload);
	}
	// Only the chosen kinds acquire resources. The remaining fields are bounded metadata.
	if (!interest.kinds.includes("tool")) detail = { ...detail, tools: [], toolsNextCursor: null };
	else if (attemptId) {
		const attempts = (await sql.unsafe("SELECT tool_revision FROM engine_attempts WHERE attempt_id=?", [
			attemptId,
		])) as Array<{ tool_revision: number }>;
		work.rows(attempts.length);
		// A continued snapshot may precede a lifecycle mutation. Its persisted detail
		// keeps that cut; the explicit tools cursor rejects a changed collection.
		if (Number(attempts[0].tool_revision) <= cut) {
			const tools = await runtimeToolBaselines(
				sql,
				{ agentInstanceRef: identity.agent_instance_ref, attemptId },
				Number(attempts[0].tool_revision),
				work,
			);
			detail = { ...detail, tools: tools.items, toolsNextCursor: tools.nextCursor };
		}
	}
	if (!interest.kinds.includes("input"))
		detail = {
			...detail,
			pendingInputs: [],
			inputsHasMore: Boolean((detail.pendingInputs as unknown[]).length || detail.inputsHasMore),
		};
	if (!interest.kinds.includes("assistant"))
		detail = {
			...detail,
			messages: [],
			messagesHasMore: Boolean((detail.messages as unknown[]).length || detail.messagesHasMore),
		};
	else if (attemptId) {
		const messages = await runtimeMessageBaselines(sql, attemptId, cut, 0, 16, work);
		const selected: Record<string, unknown>[] = [];
		let bytes = Buffer.byteLength(JSON.stringify(detail));
		for (const message of messages.items) {
			const size = Buffer.byteLength(JSON.stringify(message)) + 1;
			if (bytes + size > runtimeLimits.detailStateBytes) break;
			selected.push(message);
			bytes += size;
		}
		detail = {
			...detail,
			messages: selected,
			messagesHasMore: messages.next !== null || selected.length < messages.items.length,
		};
	}
	return detail;
}

export async function readRuntimeSnapshot(
	sql: RuntimeSql,
	scope: RuntimeScope,
	access: RuntimeAccess,
	cursor?: string,
	limit = runtimeLimits.httpPageRecords,
	maxBytes = runtimeLimits.httpPageBytes,
): Promise<RuntimeSnapshot> {
	validateRuntimeValue("scope", scope);
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > runtimeLimits.httpPageRecords ||
		!Number.isInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > runtimeLimits.httpPageBytes
	)
		throw new EngineTargetError("invalid_request", "Invalid snapshot page bounds");
	const work = bootstrapWork();
	const meta = await runtimeMeta(sql);
	work.rows(3);
	const hash = runtimeProjectionHash(scope);
	const position: SnapshotCursor = cursor
		? readCursor<SnapshotCursor>(cursor)
		: {
				epoch: meta.epoch,
				generation: meta.generation,
				cut: meta.watermark,
				hash,
				after: "",
				detail: 0,
				membersDone: false,
			};
	if (position.epoch !== meta.epoch || position.generation !== meta.generation)
		throw new RuntimeQueryError("epoch_changed", "Snapshot generation changed", { ...work.value });
	if (
		position.hash !== hash ||
		!Number.isSafeInteger(position.cut) ||
		position.cut > meta.watermark ||
		position.cut < 0 ||
		typeof position.after !== "string" ||
		!Number.isSafeInteger(position.detail) ||
		position.detail < 0 ||
		typeof position.membersDone !== "boolean"
	)
		throw new RuntimeQueryError("projection_changed", "Snapshot cursor belongs to another projection", {
			...work.value,
		});
	const page: RuntimeSnapshot = {
		version: "1.0",
		scope,
		epoch: position.epoch,
		generation: position.generation,
		watermark: position.cut,
		projectionHash: hash,
		agents: [],
		...(scope.kind !== "catalog" ? { members: [] } : {}),
		nextCursor: null,
		work: work.value,
	};
	let bytes = Buffer.byteLength(JSON.stringify(page)) + 1024;
	const fits = (value: unknown): boolean => {
		const size = Buffer.byteLength(JSON.stringify(value)) + 1;
		if (bytes + size > maxBytes) return false;
		bytes += size;
		return true;
	};
	if (scope.kind === "catalog" || scope.kind === "branch") {
		if (scope.kind === "branch") {
			const root = await identityAt(sql, scope.rootAgentInstanceRef, access, work);
			if (root.root_agent_instance_ref !== root.agent_instance_ref)
				throw new EngineTargetError("stale_target", "Branch channel requires a canonical root");
		}
		if (!position.membersDone) {
			const allowed = accessSql(access);
			const rows = (await sql.unsafe(
				`SELECT i.* FROM engine_agent_identity i WHERE ${allowed.where} AND i.agent_instance_id>?
				AND i.membership_revision>0 AND i.membership_revision<=? ${scope.kind === "branch" ? "AND i.root_agent_instance_ref=?" : ""}
				ORDER BY i.agent_instance_id LIMIT ?`,
				[
					...allowed.values,
					position.after,
					position.cut,
					...(scope.kind === "branch" ? [scope.rootAgentInstanceRef] : []),
					limit + 1,
				],
			)) as RuntimeIdentityRow[];
			work.rows(rows.length);
			let consumed = 0;
			for (const identity of rows.slice(0, limit)) {
				const value =
					scope.kind === "catalog"
						? await summaryAt(sql, identity, position.cut, work)
						: {
								agentInstanceRef: identity.agent_instance_ref,
								rootAgentInstanceRef: identity.root_agent_instance_ref,
								parentAgentInstanceRef: identity.parent_agent_instance_ref,
								revision: Number(identity.membership_revision),
							};
				if (!fits(value)) break;
				if (scope.kind === "catalog") page.agents.push(value);
				else page.members?.push(value);
				position.after = identity.agent_instance_id;
				consumed++;
			}
			position.membersDone = consumed === rows.length;
			if (!consumed && rows.length)
				throw new RuntimeQueryError("restore_budget", "Snapshot item cannot fit the requested page", {
					...work.value,
				});
		}
	}
	const interests = scope.kind === "catalog" ? [] : scope.kind === "branch" ? scope.interests : [scope];
	if (scope.kind !== "catalog" && (scope.kind !== "branch" || position.membersDone)) {
		while (position.detail < interests.length && page.agents.length + (page.members?.length ?? 0) < limit) {
			const detail = await selectedDetail(
				sql,
				interests[position.detail],
				access,
				position.cut,
				scope.kind === "branch" ? scope.rootAgentInstanceRef : undefined,
				work,
			);
			if (!fits(detail)) break;
			page.agents.push(detail);
			position.detail++;
		}
		if (!page.agents.length && !page.members?.length && position.detail < interests.length)
			throw new RuntimeQueryError("restore_budget", "Selected detail cannot fit the requested page", {
				...work.value,
			});
	}
	if (
		((scope.kind === "catalog" || scope.kind === "branch") && !position.membersDone) ||
		position.detail < interests.length
	)
		page.nextCursor = encodeCursor(position);
	work.finish(
		page,
		page.agents.length +
			(page.members?.length ?? 0) +
			page.agents.reduce((sum, agent) => sum + (Array.isArray(agent.tools) ? agent.tools.length : 0), 0),
	);
	validateRuntimeValue("snapshot", page);
	return page;
}

async function eventSources(
	sql: RuntimeSql,
	request: RuntimeEventsRequest,
	work: RuntimeQueryWork,
): Promise<EventSource[]> {
	const { scope } = request;
	if (scope.kind === "catalog") {
		const sources: EventSource[] = [
			{
				where: "e.summary_payload IS NOT NULL AND e.projection_principal=?",
				values: [request.principalId],
				column: "summary_payload",
			},
		];
		for (const ref of request.authorizedAgentInstanceRefs ?? []) {
			const rows = (await sql.unsafe(
				"SELECT agent_instance_id FROM engine_agent_identity WHERE agent_instance_ref=? AND principal_id=''",
				[ref],
			)) as Array<{ agent_instance_id: string }>;
			work.rows(rows.length);
			if (rows[0])
				sources.push({
					where: "e.summary_payload IS NOT NULL AND e.agent_instance_id=?",
					values: [rows[0].agent_instance_id],
					column: "summary_payload",
				});
		}
		return sources;
	}
	const sources: EventSource[] = [];
	if (scope.kind === "branch") {
		const root = await identityAt(sql, scope.rootAgentInstanceRef, request, work);
		if (root.root_agent_instance_ref !== root.agent_instance_ref)
			throw new EngineTargetError("stale_target", "Detail scope requires a canonical root");
		sources.push({
			where: "e.membership_payload IS NOT NULL AND e.projection_root=?",
			values: [scope.rootAgentInstanceRef],
			column: "membership_payload",
		});
	}
	for (const interest of scope.kind === "branch" ? scope.interests : [scope]) {
		const identity = await identityAt(sql, interest.agentInstanceRef, request, work);
		if (scope.kind === "branch" && identity.root_agent_instance_ref !== scope.rootAgentInstanceRef)
			throw new EngineTargetError("stale_target", "Selected detail is outside its root branch");
		let attemptId = interest.kind === "attempt" ? interest.attemptId : undefined;
		if (!attemptId) {
			const current = (await sql.unsafe("SELECT attempt_id FROM engine_runtime_bindings WHERE agent_instance_id=?", [
				identity.agent_instance_id,
			])) as Array<{ attempt_id: string }>;
			work.rows(current.length);
			attemptId = current[0]?.attempt_id;
		}
		const mask = interest.kinds.reduce((value, kind) => value | RUNTIME_KIND_MASK[kind], 0);
		sources.push({
			where: "e.projection_kinds<>0 AND e.agent_instance_id=?",
			values: [identity.agent_instance_id],
			column: "projection_payload",
			mask,
			attemptId,
		});
	}
	return sources;
}

function selectedChange(change: RuntimeChange, source: EventSource): boolean {
	if (source.column !== "projection_payload") return true;
	const attempt = change.kind === "state" ? (change.value.attemptId ?? undefined) : change.attemptId;
	if (attempt !== undefined && attempt !== source.attemptId) return false;
	const resource = change.value.resource;
	const kind =
		change.kind === "invalidate"
			? resource === "holds"
				? "state"
				: resource === "context"
					? "usage"
					: resource
			: change.kind === "receipt"
				? "state"
				: change.kind;
	return (
		typeof kind === "string" &&
		kind in RUNTIME_KIND_MASK &&
		Boolean((source.mask ?? 0) & RUNTIME_KIND_MASK[kind as keyof typeof RUNTIME_KIND_MASK])
	);
}

export async function readRuntimeEvents(sql: RuntimeSql, request: RuntimeEventsRequest): Promise<RuntimeEventBatch> {
	validateRuntimeValue("nativeEventsRequest", request);
	const work = new RuntimeQueryWork(request.remainingWork);
	const meta = await runtimeMeta(sql);
	work.rows(3);
	if (request.epoch !== meta.epoch)
		throw new RuntimeQueryError("epoch_changed", "Owner epoch changed", { ...work.value });
	const bounds = (await sql.unsafe("SELECT MIN(event_id) AS first FROM engine_event_outbox")) as Array<{
		first: number | null;
	}>;
	work.rows(1);
	if (
		request.afterCursor > meta.watermark ||
		(bounds[0].first !== null && request.afterCursor < Number(bounds[0].first) - 1)
	)
		throw new RuntimeQueryError("retention_gap", "Event cursor is outside retention", { ...work.value });
	const head = Math.min(request.untilCursor ?? meta.watermark, meta.watermark);
	const sources = await eventSources(sql, request, work);
	// Reserve one indexed body lookup for each metadata row before fetching any body.
	const availableRows = Math.floor((request.remainingWork.scannedRows - work.value.scannedRows) / 2);
	if (availableRows < sources.length)
		throw new RuntimeQueryError("restore_budget", "Owner scan budget cannot cover the selected interests", {
			...work.value,
		});
	const sourceLimit = Math.max(
		1,
		Math.min(
			Math.ceil((request.limit + 1) / Math.max(1, sources.length)),
			Math.floor(availableRows / Math.max(1, sources.length)),
		),
	);
	const candidates: Array<{ row: EventMetadata; source: EventSource }> = [];
	let cut = head;
	for (const source of sources) {
		const rows = (await sql.unsafe(
			`SELECT e.event_id,e.agent_instance_id,i.agent_instance_ref,e.attempt_id,e.projection_kinds
			FROM engine_event_outbox e JOIN engine_agent_identity i ON i.agent_instance_id=e.agent_instance_id
			WHERE ${source.where} AND e.event_id>? AND e.event_id<=? ORDER BY e.event_id LIMIT ?`,
			[...source.values, request.afterCursor, head, sourceLimit],
		)) as EventMetadata[];
		work.rows(rows.length);
		if (rows.length === sourceLimit) cut = Math.min(cut, Number(rows.at(-1)?.event_id));
		for (const row of rows) candidates.push({ row, source });
	}
	candidates.sort((a, b) => Number(a.row.event_id) - Number(b.row.event_id));
	const batch: RuntimeEventBatch = {
		epoch: meta.epoch,
		headCursor: head,
		throughCursor: cut,
		changes: [],
		hasMore: cut < head,
		work: work.value,
	};
	let bytes = Buffer.byteLength(JSON.stringify(batch)) + 128;
	for (let index = 0; index < candidates.length; ) {
		const cursor = Number(candidates[index].row.event_id);
		if (cursor > cut) break;
		const eventChanges: RuntimeChange[] = [];
		while (index < candidates.length && Number(candidates[index].row.event_id) === cursor) {
			const { row, source } = candidates[index++];
			if (
				source.column === "projection_payload" &&
				(!(Number(row.projection_kinds) & (source.mask ?? 0)) ||
					(source.attemptId !== undefined && row.attempt_id !== source.attemptId))
			)
				continue;
			const bodies = (await sql.unsafe(`SELECT ${source.column} AS body FROM engine_event_outbox WHERE event_id=?`, [
				cursor,
			])) as Array<{ body: string }>;
			work.rows(bodies.length);
			const value = work.decode<Record<string, unknown> | RuntimeChange[]>(bodies[0].body);
			const changes =
				source.column === "projection_payload"
					? (value as RuntimeChange[])
					: [
							{
								kind: source.column === "summary_payload" ? "summary" : "membership",
								agentInstanceRef: row.agent_instance_ref,
								revision: Number((value as Record<string, unknown>).revision),
								cursor,
								value: value as Record<string, unknown>,
							} satisfies RuntimeChange,
						];
			for (const change of changes)
				if (
					selectedChange(change, source) &&
					!eventChanges.some(
						existing =>
							existing.kind === change.kind &&
							existing.agentInstanceRef === change.agentInstanceRef &&
							existing.revision === change.revision &&
							(change.kind !== "invalidate" || existing.value.resource === change.value.resource),
					)
				)
					eventChanges.push(change);
		}
		const size = eventChanges.reduce((sum, change) => sum + Buffer.byteLength(JSON.stringify(change)) + 1, 0);
		if (
			bytes + size > request.maxBytes ||
			batch.changes.length + eventChanges.length > Math.min(request.limit, request.remainingWork.changes)
		) {
			if (!batch.changes.length)
				throw new RuntimeQueryError(
					"restore_budget",
					"A single owner event cannot fit the remaining delivery budget",
					{ ...work.value },
				);
			batch.throughCursor = cursor - 1;
			batch.hasMore = true;
			break;
		}
		batch.changes.push(...eventChanges);
		bytes += size;
	}
	work.finish(batch, batch.changes.length);
	validateRuntimeValue("eventBatch", batch);
	return batch;
}
