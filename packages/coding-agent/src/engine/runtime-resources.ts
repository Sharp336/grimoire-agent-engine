import { EngineTargetError } from "./contracts";
import { readNativeHistoryEntry } from "./runtime-history";
import { runtimeMessageBaselines, runtimeMessageRange } from "./runtime-messages";
import {
	type RuntimeIdentityRow,
	RuntimeQueryError,
	RuntimeQueryWork,
	type RuntimeSql,
	runtimeIdentity,
} from "./runtime-projection";
import {
	type RuntimeAccess,
	runtimeLimits,
	runtimeToolIdChars,
	runtimeToolNameChars,
	runtimeToolPageRecords,
	validateRuntimeValue,
} from "./runtime-protocol";
import { runtimeQueueRange } from "./runtime-queue";

export interface RuntimePageRequest extends RuntimeAccess {
	agentInstanceRef: string;
	attemptId?: string;
	revision?: number;
	cursor?: string;
	limit?: number;
	inputId?: string;
}

export interface RuntimeResourceRequest extends RuntimeAccess {
	resource: Record<string, unknown>;
	offset: number;
	limit: number;
}

interface ResourceCursor {
	agent: string;
	attempt: string | null;
	revision: number;
	after: string | number;
}

function queryWork(): RuntimeQueryWork {
	return new RuntimeQueryWork({
		bytes: runtimeLimits.httpPageBytes,
		changes: runtimeLimits.httpPageRecords,
		scannedRows: runtimeLimits.bootstrapScannedRows,
		materializedBytes: runtimeLimits.bootstrapMaterializedBytes,
		timeMs: runtimeLimits.bootstrapTimeoutMs,
	});
}

function cursorPosition(
	request: Pick<RuntimePageRequest, "agentInstanceRef" | "attemptId" | "revision" | "cursor">,
	revision: number,
	initial: string | number,
): string | number {
	if (request.revision !== undefined && request.revision !== revision)
		throw new EngineTargetError("stale_target", "Owner collection revision changed");
	if (!request.cursor) return initial;
	let parsed: ResourceCursor;
	try {
		parsed = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as ResourceCursor;
	} catch {
		throw new EngineTargetError("stale_target", "Invalid resource page cursor");
	}
	if (
		parsed.agent !== request.agentInstanceRef ||
		parsed.attempt !== (request.attemptId ?? null) ||
		parsed.revision !== revision ||
		typeof parsed.after !== typeof initial
	)
		throw new EngineTargetError("stale_target", "Resource page cursor changed identity or revision");
	return parsed.after;
}

function cursorNext(
	request: Pick<RuntimePageRequest, "agentInstanceRef" | "attemptId">,
	revision: number,
	after: string | number,
): string {
	return Buffer.from(
		JSON.stringify({
			agent: request.agentInstanceRef,
			attempt: request.attemptId ?? null,
			revision,
			after,
		} satisfies ResourceCursor),
	).toString("base64url");
}

async function readIdentity(
	sql: RuntimeSql,
	request: RuntimePageRequest,
	work: RuntimeQueryWork,
): Promise<RuntimeIdentityRow> {
	const identity = await runtimeIdentity(sql, request.agentInstanceRef, request);
	work.rows(1);
	if (request.attemptId) {
		const attempts = await sql.unsafe(
			"SELECT attempt_id FROM engine_attempts WHERE attempt_id=? AND agent_instance_id=?",
			[request.attemptId, identity.agent_instance_id],
		);
		work.rows(attempts.length);
		if (!attempts.length)
			throw new EngineTargetError("stale_target", "Exact Attempt is not owned by this AgentInstance");
	}
	return identity;
}

export async function readRuntimeHolds(sql: RuntimeSql, request: RuntimePageRequest): Promise<Record<string, unknown>> {
	const { principalId: _principal, authorizedAgentInstanceRefs: _refs, ...read } = request;
	validateRuntimeValue("holdsReadRequest", read);
	const work = queryWork();
	const identity = await readIdentity(sql, request, work);
	const revision = Number(identity.intent_revision);
	const after = String(cursorPosition(request, revision, ""));
	const ancestors = (await sql.unsafe(
		`WITH RECURSIVE ancestors(id,parent,depth) AS (
		SELECT agent_instance_id,parent_agent_instance_id,0 FROM engine_agent_identity WHERE agent_instance_id=?
		UNION ALL SELECT i.agent_instance_id,i.parent_agent_instance_id,a.depth+1 FROM engine_agent_identity i JOIN ancestors a ON i.agent_instance_id=a.parent WHERE a.depth<?)
		SELECT id,parent,depth FROM ancestors ORDER BY depth`,
		[identity.agent_instance_id, runtimeLimits.bootstrapScannedRows],
	)) as Array<{ id: string; parent: string | null; depth: number }>;
	work.rows(ancestors.length);
	if (ancestors.at(-1)?.parent)
		throw new RuntimeQueryError("restore_budget", "Ancestry exceeds this bounded hold read", { ...work.value });
	const limit = request.limit ?? runtimeLimits.httpPageRecords;
	const rows = (await sql.unsafe(
		`SELECT i.agent_instance_ref,h.command_id,h.generation,h.kind,h.source_agent_instance_id||':'||h.kind AS position
		FROM engine_branch_holds h JOIN engine_agent_identity i ON i.agent_instance_id=h.source_agent_instance_id
		WHERE h.source_agent_instance_id IN (${ancestors.map(() => "?").join(",")}) AND h.source_agent_instance_id||':'||h.kind>?
		ORDER BY h.source_agent_instance_id,h.kind LIMIT ?`,
		[...ancestors.map(row => row.id), after, limit + 1],
	)) as Array<{ agent_instance_ref: string; command_id: string; generation: number; kind: string; position: string }>;
	work.rows(rows.length);
	const selected = rows.slice(0, limit);
	const result = {
		version: "1.0",
		agentInstanceRef: request.agentInstanceRef,
		attemptId: request.attemptId ?? null,
		revision,
		nextCursor:
			rows.length > selected.length ? cursorNext(request, revision, selected.at(-1)?.position ?? after) : null,
		items: selected.map(row => ({
			sourceAgentInstanceRef: row.agent_instance_ref,
			commandId: row.command_id,
			generation: Number(row.generation),
			kind: row.kind,
		})),
		work: work.value,
	};
	work.finish(result, result.items.length);
	validateRuntimeValue("holdsPage", result);
	return result;
}

export async function readRuntimeInput(sql: RuntimeSql, request: RuntimePageRequest): Promise<Record<string, unknown>> {
	const { principalId: _principal, authorizedAgentInstanceRefs: _refs, ...read } = request;
	validateRuntimeValue(request.inputId ? "inputReadRequest" : "detailPageRequest", read);
	const work = queryWork();
	await readIdentity(sql, request, work);
	if (request.inputId) {
		const rows = (await sql.unsafe(
			`SELECT p.created_event_id,LENGTH(CAST(e.input_body AS BLOB)) AS bytes FROM engine_runtime_inputs p
			JOIN engine_event_outbox e ON e.event_id=p.created_event_id
			WHERE p.attempt_id=? AND p.input_id=? AND p.resolved_event_id IS NULL`,
			[request.attemptId!, request.inputId],
		)) as Array<{ created_event_id: number; bytes: number }>;
		work.rows(rows.length);
		const row = rows[0];
		if (!row || Number(row.created_event_id) !== request.revision)
			throw new EngineTargetError("stale_target", "Pending input or its exact revision changed");
		const partial = Number(row.bytes) > runtimeLimits.httpPageBytes - runtimeLimits.bulkPreviewBytes;
		const bodies = (await sql.unsafe(
			`SELECT ${partial ? "input_preview" : "input_body"} AS body FROM engine_event_outbox WHERE event_id=?`,
			[row.created_event_id],
		)) as Array<{ body: string }>;
		work.rows(bodies.length);
		const input = work.decode<Record<string, unknown>>(bodies[0].body);
		const result = {
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
							bytes: Number(row.bytes),
						},
					}
				: {}),
			work: work.value,
		};
		work.finish(result, 1);
		validateRuntimeValue("inputDetail", result);
		return result;
	}
	const attempts = (await sql.unsafe("SELECT input_revision,state FROM engine_attempts WHERE attempt_id=?", [
		request.attemptId!,
	])) as Array<{ input_revision: number; state: string }>;
	work.rows(attempts.length);
	const revision = Number(attempts[0].input_revision);
	const after = Number(cursorPosition(request, revision, 0));
	const limit = request.limit ?? runtimeLimits.httpPageRecords;
	const rows = (await sql.unsafe(
		`SELECT input_id,kind,created_event_id FROM engine_runtime_inputs WHERE attempt_id=?
		AND resolved_event_id IS NULL AND created_event_id>? ORDER BY created_event_id LIMIT ?`,
		[request.attemptId!, after, limit + 1],
	)) as Array<{ input_id: string; kind: string; created_event_id: number }>;
	work.rows(rows.length);
	const selected = rows.slice(0, limit);
	const result = {
		version: "1.0",
		agentInstanceRef: request.agentInstanceRef,
		attemptId: request.attemptId,
		revision,
		nextCursor:
			rows.length > selected.length
				? cursorNext(request, revision, Number(selected.at(-1)?.created_event_id ?? after))
				: null,
		items: selected.map(row => ({ inputId: row.input_id, revision: Number(row.created_event_id), kind: row.kind })),
		work: work.value,
	};
	work.finish(result, result.items.length);
	validateRuntimeValue("inputPage", result);
	return result;
}

export async function readRuntimeResource(
	sql: RuntimeSql,
	request: RuntimeResourceRequest,
): Promise<Record<string, unknown>> {
	validateRuntimeValue("resourceReadRequest", {
		resource: request.resource,
		offset: request.offset,
		limit: request.limit,
	});
	const resource = request.resource;
	const work = queryWork();
	if (resource.kind === "message") return await runtimeMessageRange(sql, request, work);
	if (resource.kind === "queue_item") return await runtimeQueueRange(sql, request, work);
	const identity = await runtimeIdentity(sql, String(resource.agentInstanceRef), request);
	work.rows(1);
	if (resource.kind === "history_entry") {
		if (resource.mediaType !== "application/json" || resource.contentHash !== undefined)
			throw new EngineTargetError("stale_target", "History descriptor differs from the native owner resource");
		const range = await readNativeHistoryEntry(
			sql,
			identity.agent_instance_id,
			String(resource.entryId),
			String(resource.revision),
			request.offset,
			request.limit,
			String(resource.sessionId),
			typeof resource.attemptId === "string" ? resource.attemptId : undefined,
			work,
		);
		if (range.totalBytes !== resource.bytes)
			throw new EngineTargetError("stale_target", "History resource size changed");
		const result = {
			resource,
			offset: range.offset,
			nextOffset: range.nextOffset,
			contentBase64: range.contentBase64,
		};
		work.finish(result, 1);
		validateRuntimeValue("httpRange", result);
		return result;
	}
	if (resource.kind !== "input")
		throw new EngineTargetError("invalid_request", "This resource kind requires its native owner reader");
	const rows = (await sql.unsafe(
		`SELECT p.created_event_id,LENGTH(CAST(e.input_body AS BLOB)) AS bytes
		FROM engine_runtime_inputs p JOIN engine_event_outbox e ON e.event_id=p.created_event_id
		WHERE e.agent_instance_id=? AND p.attempt_id=? AND p.input_id=?`,
		[identity.agent_instance_id, String(resource.attemptId), String(resource.inputId)],
	)) as Array<{ created_event_id: number; bytes: number }>;
	work.rows(rows.length);
	const row = rows[0];
	if (
		!row ||
		Number(row.created_event_id) !== resource.revision ||
		Number(row.bytes) !== resource.bytes ||
		request.offset > Number(row.bytes)
	)
		throw new EngineTargetError("stale_target", "Input resource identity, revision or range changed");
	const chunks = (await sql.unsafe(
		"SELECT SUBSTR(CAST(input_body AS BLOB),?,?) AS chunk FROM engine_event_outbox WHERE event_id=?",
		[request.offset + 1, request.limit, row.created_event_id],
	)) as Array<{ chunk: Uint8Array }>;
	work.rows(chunks.length);
	const bytes = Buffer.from(chunks[0].chunk);
	work.value.materializedBytes += bytes.length;
	work.check();
	const end = request.offset + bytes.length;
	const result = {
		resource,
		offset: request.offset,
		nextOffset: end < Number(row.bytes) ? end : null,
		contentBase64: bytes.toString("base64"),
	};
	work.finish(result, 1);
	validateRuntimeValue("httpRange", result);
	return result;
}

export async function readRuntimeMessages(
	sql: RuntimeSql,
	request: RuntimePageRequest,
): Promise<Record<string, unknown>> {
	const { principalId: _principal, authorizedAgentInstanceRefs: _refs, ...read } = request;
	validateRuntimeValue("detailPageRequest", read);
	const work = queryWork();
	await readIdentity(sql, request, work);
	const attempts = (await sql.unsafe("SELECT message_revision FROM engine_attempts WHERE attempt_id=?", [
		request.attemptId!,
	])) as Array<{ message_revision: number }>;
	work.rows(attempts.length);
	let revision = request.revision ?? Number(attempts[0].message_revision);
	if (request.cursor && request.revision === undefined) {
		try {
			revision = Number(
				(JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as ResourceCursor).revision,
			);
		} catch {
			throw new EngineTargetError("stale_target", "Invalid messages cursor");
		}
	}
	if (!Number.isSafeInteger(revision) || revision > Number(attempts[0].message_revision))
		throw new EngineTargetError("stale_target", "Message collection revision is not retained");
	const after = Number(cursorPosition(request, revision, 0));
	const messages = await runtimeMessageBaselines(
		sql,
		request.attemptId!,
		revision,
		after,
		Math.min(request.limit ?? 16, 16),
		work,
	);
	const result = {
		version: "1.0",
		agentInstanceRef: request.agentInstanceRef,
		attemptId: request.attemptId,
		revision,
		nextCursor: messages.next === null ? null : cursorNext(request, revision, messages.next),
		items: messages.items,
		work: work.value,
	};
	work.finish(result, messages.items.length);
	validateRuntimeValue("messagesPage", result);
	return result;
}

export async function runtimeToolBaselines(
	sql: RuntimeSql,
	request: Pick<RuntimePageRequest, "agentInstanceRef" | "attemptId" | "revision" | "cursor" | "limit">,
	revision: number,
	work?: RuntimeQueryWork,
	maxBytes = runtimeLimits.bulkPreviewBytes * 2,
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
	const after = String(cursorPosition(request, revision, ""));
	const limit = Math.min(request.limit ?? runtimeToolPageRecords, runtimeToolPageRecords);
	const rows = (await sql.unsafe(
		`SELECT effect_id,substr(tool_call_id,1,?) AS tool_call_id,substr(tool_name,1,?) AS tool_name,state,runtime_event_id
		FROM engine_effects WHERE attempt_id=? AND effect_kind='tool' AND state IN ('started','unknown')
		AND effect_id>? ORDER BY effect_id LIMIT ?`,
		[runtimeToolIdChars + 1, runtimeToolNameChars + 1, request.attemptId!, after, limit + 1],
	)) as Array<{ effect_id: string; tool_call_id: string; tool_name: string; state: string; runtime_event_id: number }>;
	work?.rows(rows.length);
	const items: Record<string, unknown>[] = [];
	let bytes = 2;
	let position = after;
	for (const row of rows.slice(0, limit)) {
		const item = {
			toolCallId: row.tool_call_id,
			name: row.tool_name,
			phase: row.state === "unknown" ? "unknown" : "started",
			revision: Number(row.runtime_event_id),
		};
		validateRuntimeValue("toolSnapshot", item);
		const json = JSON.stringify(item);
		if (bytes + Buffer.byteLength(json) + 1 > maxBytes) break;
		items.push(work ? work.decode<Record<string, unknown>>(json) : item);
		bytes += Buffer.byteLength(json) + 1;
		position = row.effect_id;
	}
	return {
		items,
		nextCursor: items.length < rows.length ? cursorNext(request, revision, position) : null,
	};
}

export async function readRuntimeTools(sql: RuntimeSql, request: RuntimePageRequest): Promise<Record<string, unknown>> {
	const { principalId: _principal, authorizedAgentInstanceRefs: _refs, ...read } = request;
	validateRuntimeValue("detailPageRequest", read);
	const work = queryWork();
	await readIdentity(sql, request, work);
	const attempts = (await sql.unsafe("SELECT tool_revision FROM engine_attempts WHERE attempt_id=?", [
		request.attemptId!,
	])) as Array<{ tool_revision: number }>;
	work.rows(attempts.length);
	const revision = Number(attempts[0].tool_revision);
	const tools = await runtimeToolBaselines(sql, request, revision, work, runtimeLimits.httpPageBytes / 2);
	const result = {
		version: "1.0",
		agentInstanceRef: request.agentInstanceRef,
		attemptId: request.attemptId,
		revision,
		items: tools.items,
		nextCursor: tools.nextCursor,
		work: work.value,
	};
	work.finish(result, tools.items.length);
	validateRuntimeValue("toolsPage", result);
	return result;
}
