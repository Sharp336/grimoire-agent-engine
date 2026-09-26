import { describe, expect, spyOn, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { EngineEvent, EngineTarget } from "../src/engine/contracts";
import { decodeCursor, encodeCursor } from "../src/engine/rocks-runtime-cursor";
import { nativeEntry, nativeScope } from "../src/engine/rocks-runtime-history";
import { projectEvent, projectionId, settleRuntimeMessages } from "../src/engine/rocks-runtime-projection";
import type { RocksCommand } from "../src/engine/rocks-runtime-rows";
import { queryWork, RocksEngineStore } from "../src/engine/rocks-runtime-store";
import { RocksEngineMutations } from "../src/engine/rocks-store";
import { type RuntimeEventsRequest, validateRuntimeValue } from "../src/engine/runtime-protocol";
import { RuntimeRecords, RuntimeTransaction } from "../src/engine/runtime-records";
import type { EngineCommandIdentity } from "../src/engine/store";
import { BlobStore } from "../src/session/blob-store";
import { StorageClient } from "../src/session/storage-client";
import {
	STORAGE_PROTOCOL_SCHEMA_HASH,
	type StorageRuntimeIndex,
	type StorageRuntimeKind,
	type StorageRuntimeQuery,
	type StorageRuntimeQueryResponse,
	type StorageRuntimeRecord,
} from "../src/session/storage-protocol";

class Rows extends RuntimeRecords {
	readonly values = new Map<string, StorageRuntimeRecord>();
	constructor() {
		super(
			new StorageClient({
				url: "http://127.0.0.1:1",
				token: "test-only-not-a-credential",
				incarnation: 1,
				protocolHash: STORAGE_PROTOCOL_SCHEMA_HASH,
			}),
		);
	}
	seed(kind: StorageRuntimeKind, id: string, value: object): void {
		this.values.set(`${kind}:${id}`, { kind, id, revision: 1, value: value as Record<string, unknown> });
	}
	override async getMany(keys: Array<{ kind: StorageRuntimeKind; id: string }>): Promise<StorageRuntimeRecord[]> {
		return keys.map(({ kind, id }) =>
			structuredClone(this.values.get(`${kind}:${id}`) ?? { kind, id, revision: null, value: null }),
		);
	}
	override async query(
		index: StorageRuntimeIndex,
		key: Array<string | number | null>,
		cursor?: string,
		maxRecords = 100,
		after?: Array<string | number | null>,
	): Promise<StorageRuntimeQueryResponse> {
		let rows = [...this.values.values()].filter(row => {
			const v = row.value;
			switch (String(index)) {
				case "projection_attempt":
					return row.kind === "projection" && v?.subtype === key[0] && v?.attempt_id === key[1] && !v?.resolved;
				case "command_agent_pending":
					return row.kind === "command" && v?.agent_instance_id === key[0] && v?.state === "received";
				case "effect_attempt":
					return row.kind === "effect" && v?.attempt_id === key[0] && v?.state === key[1];
				case "identity_ref":
					return row.kind === "identity" && v?.agent_instance_ref === key[0];
				case "inbox_agent_pending":
					return row.kind === "inbox" && v?.agent_instance_id === key[0] && v?.disposition === "pending";
				case "event_message_revision":
					return row.kind === "event" && v?.message_content_id === key[0] && v?.message_revision === key[1];
				case "event_message":
					return row.kind === "event" && v?.message_content_id === key[0];
				default:
					return false;
			}
		});
		if (index === "effect_attempt") rows.sort((a, b) => a.id.localeCompare(b.id));
		if (after && index === "effect_attempt") rows = rows.filter(row => row.id > String(after[0]));
		const start = Number(cursor ?? 0);
		const next = start + maxRecords < rows.length ? String(start + maxRecords) : null;
		rows = rows.slice(start, start + maxRecords);
		return {
			schema: "artel.storage.protocol.response.v1",
			version: "1.0",
			requestId: "test",
			incarnation: 1,
			records: structuredClone(rows),
			nextCursor: next,
			indexRevision: 1,
		};
	}
}
const target: EngineTarget & { commandId: string } = {
	agentInstanceId: "a",
	commandId: "c",
	attemptId: "attempt",
	executionId: "execution",
	bindingId: "binding",
	engineGeneration: 1,
	bindingGeneration: 1,
	authorityGeneration: 1,
};
function fixture(): Rows {
	const rows = new Rows();
	rows.seed("metadata", "engine", { store_epoch: "epoch", generation: 1 });
	rows.seed("metadata", "events", { count: 10 });
	rows.seed("identity", "a", {
		agent_instance_id: "a",
		agent_instance_ref: "grimoire://tasks/grimoire/runtime-test/agents/a",
		parent_agent_instance_id: null,
		parent_agent_instance_ref: null,
		principal_id: "p",
		authority_generation: 1,
		intent_revision: 0,
		queue_revision: 0,
		queue_pending_count: 0,
		root_agent_instance_ref: "grimoire://tasks/grimoire/runtime-test/agents/a",
		summary_revision: 0,
		summary_json: null,
		membership_revision: 1,
	});
	rows.seed("binding", "a", { agent_instance_id: "a", attempt_id: "attempt" });
	rows.seed("attempt", "attempt", {
		agent_instance_id: "a",
		attempt_id: "attempt",
		execution_id: "execution",
		binding_id: "binding",
		engine_generation: 1,
		binding_generation: 1,
		authority_generation: 1,
		state: "running",
		transcript_session_id: null,
		transcript_leaf_entry_id: null,
		detail_revision: 0,
		input_revision: 0,
		message_revision: 0,
		tool_revision: 0,
		profile_route_state: null,
	});
	return rows;
}
async function append(
	tx: RuntimeTransaction,
	kind: EngineEvent["kind"],
	payload: Record<string, unknown>,
	eventId = 1,
): Promise<EngineEvent> {
	const { commandId, ...eventTarget } = target;
	const event: EngineEvent = {
		...eventTarget,
		causationCommandId: commandId,
		eventId,
		seq: eventId,
		createdAt: Date.now(),
		kind,
		payload,
	};
	await tx.put("event", String(eventId), {
		...event,
		event_id: eventId,
		agent_instance_id: "a",
		attempt_id: "attempt",
		published_at: null,
	});
	await projectEvent(tx, event);
	return event;
}
describe("Rocks runtime atomic public projections", () => {
	test("settlement publishes a canonical receipt with the command's frozen identity", async () => {
		const rows = fixture();
		const identity: EngineCommandIdentity = {
			commandId: "frozen-command",
			operation: "steer",
			deviceId: "device",
			engineId: "engine",
			engineGeneration: 1,
			agentInstanceId: "a",
			agentInstanceRef: ref,
			executionId: "frozen-execution",
			attemptId: "frozen-attempt",
			bindingId: "frozen-binding",
			bindingGeneration: 3,
			authorityGeneration: 1,
			payloadHash: `sha256:${"a".repeat(64)}`,
			browserPayloadHash: `sha256:${"a".repeat(64)}`,
			canonicalHash: `sha256:${"b".repeat(64)}`,
			serializedCommand: JSON.stringify({
				browserTarget: {
					agentInstanceRef: ref,
					attemptId: "frozen-attempt",
					executionId: "frozen-execution",
				},
			}),
		};
		rows.seed("command", identity.commandId, {
			command_id: identity.commandId,
			agent_instance_id: identity.agentInstanceId,
			processor_generation: 1,
			state: "received",
			canonical_hash: identity.canonicalHash,
			payload_bytes: 1,
			control_admission: 0,
			engine_generation: 1,
			operation: identity.operation,
			identity,
			receipt: null,
			received_at: 1,
			updated_at: 1,
			pending_accounted: false,
		} satisfies RocksCommand);
		const tx = new RuntimeTransaction(rows);
		const mutations = new RocksEngineMutations(rows.client, async () => {});
		await mutations.settle(
			tx,
			identity.commandId,
			{ outcome: "applied", detail: { persisted: true } },
			identity.canonicalHash,
			true,
		);
		const event = await tx.get<EngineEvent>("event", "11");
		expect(event).toMatchObject({
			causationCommandId: identity.commandId,
			agentInstanceId: identity.agentInstanceId,
			executionId: identity.executionId,
			attemptId: identity.attemptId,
			bindingId: identity.bindingId,
			bindingGeneration: identity.bindingGeneration,
			kind: "command_receipt",
			payload: {
				value: {
					version: "1.0",
					commandId: identity.commandId,
					payloadHash: identity.browserPayloadHash,
					target: {
						agentInstanceRef: ref,
						attemptId: identity.attemptId,
						executionId: identity.executionId,
					},
					stage: "applied",
					lookup: "known",
					result: {
						persisted: true,
						target: {
							agentInstanceRef: ref,
							attemptId: identity.attemptId,
							executionId: identity.executionId,
							authorityGeneration: 1,
							intentRevision: 0,
						},
					},
				},
			},
		});
		expect(event?.payload).not.toHaveProperty("receipt");
	});
	test("a terminally rejected unbound Start leaves no pending target and an explicit Start becomes current", async () => {
		const rows = fixture();
		rows.seed("attempt", "attempt", { ...(await rows.get("attempt", "attempt")).value, state: "completed" });
		const store = storeWith(rows);
		spyOn(store.records, "mutate").mockImplementation(async (_scope, work) => {
			const tx = new RuntimeTransaction(rows);
			const result = await work(tx);
			const { puts, deletes } = tx.mutation();
			for (const put of puts) rows.seed(put.kind, put.id, put.value);
			for (const row of deletes) rows.values.delete(`${row.kind}:${row.id}`);
			return result;
		});
		const start = (name: string): EngineCommandIdentity => ({
			commandId: `start-${name}`,
			operation: "start",
			deviceId: "device",
			engineId: "engine",
			engineGeneration: 1,
			agentInstanceId: "a",
			agentInstanceRef: ref,
			executionId: `execution-${name}`,
			attemptId: `attempt-${name}`,
			authorityGeneration: 1,
			principalId: "p",
			payloadHash: name,
			canonicalHash: name,
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		});
		const summary = async () =>
			(await store.runtimeSummary({ principalId: "p", agentInstanceRef: ref })).summary as Record<string, unknown>;
		const detail = { code: "attachment_requires_read", message: 'File "notes.txt" cannot be sent' };
		// A queue wake Start without a browser receipt is claimed, then refused before any Attempt exists.
		const wake = start("wake");
		expect(await store.admitCommand(wake, 1)).toEqual({ status: "claimed" });
		await store.commitUnboundStartRejection(
			{
				...target,
				commandId: wake.commandId,
				executionId: wake.executionId!,
				attemptId: wake.attemptId!,
				bindingId: "",
				bindingGeneration: 0,
			},
			{ kind: "rejected", payload: detail, causationCommandId: wake.commandId },
			{ outcome: "rejected", detail },
		);
		expect(await summary()).toMatchObject({
			state: "completed",
			target: { attemptId: "attempt" },
			pendingStart: null,
		});
		// A Start whose admission failed takes the same terminal path without a claimed processor.
		await store.rejectUnadmittedCommand(start("unadmitted"), { outcome: "rejected", detail }, 1);
		expect((await summary()).pendingStart).toBeNull();
		const next = start("explicit");
		expect(await store.admitCommand(next, 1)).toEqual({ status: "claimed" });
		await store.commitAttemptTransition(
			{
				commandId: next.commandId,
				agentInstanceId: "a",
				executionId: next.executionId!,
				attemptId: next.attemptId!,
				bindingId: "binding-explicit",
				engineAgentId: "native-a",
				profileDigest: "read-profile",
				state: "running",
				engineGeneration: 1,
				bindingGeneration: 2,
				authorityGeneration: 1,
			},
			"running",
			[{ kind: "accepted" }, { kind: "running" }],
			{
				requireNew: true,
				settleCommandId: next.commandId,
				startIntent: { expectedRevision: 0, explicitContinue: true },
			},
		);
		expect(await summary()).toMatchObject({
			state: "running",
			target: { attemptId: next.attemptId },
			pendingStart: null,
		});
	});
	test("an event committed with its command settlement projects the command as settled", async () => {
		const rows = fixture();
		rows.seed("binding", "a", {
			agent_instance_id: "a",
			execution_id: "execution",
			attempt_id: "attempt",
			binding_id: "binding",
			engine_generation: 1,
			binding_generation: 1,
			authority_generation: 1,
		});
		const store = storeWith(rows);
		spyOn(store.records, "mutate").mockImplementation(async (_scope, work) => {
			const tx = new RuntimeTransaction(rows);
			const result = await work(tx);
			for (const put of tx.mutation().puts) rows.seed(put.kind, put.id, put.value);
			return result;
		});
		const start: EngineCommandIdentity = {
			commandId: "start-refused",
			operation: "start",
			deviceId: "device",
			engineId: "engine",
			engineGeneration: 1,
			agentInstanceId: "a",
			agentInstanceRef: ref,
			executionId: "execution-refused",
			attemptId: "attempt-refused",
			authorityGeneration: 1,
			principalId: "p",
			payloadHash: "refused",
			canonicalHash: "refused",
		};
		expect(await store.admitCommand(start, 1)).toEqual({ status: "claimed" });
		const detail = { code: "invalid_request", message: "refused" };
		// A non-browser Start emits no receipt event, so the transition event carries the last summary.
		await store.commitEvent(
			target,
			{ kind: "rejected", payload: detail, causationCommandId: start.commandId },
			start.commandId,
			{ outcome: "rejected", detail },
		);
		const summary = await store.runtimeSummary({ principalId: "p", agentInstanceRef: ref });
		expect((summary.summary as Record<string, unknown>).pendingStart).toBeNull();
	});
	test("new input and its attention/detail appear in the same mutation; resolution removes pending input", async () => {
		const tx = new RuntimeTransaction(fixture());
		await append(tx, "input_requested", {
			inputId: "input",
			questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
		});
		const event = await tx.get<{
			detail_payload: { pendingInputs: unknown[] };
			summary_payload: { attention: { needsInput: boolean } };
		}>("event", "1");
		expect(event?.detail_payload.pendingInputs).toEqual([{ inputId: "input", kind: "question", revision: 1 }]);
		expect(event?.summary_payload.attention.needsInput).toBe(true);
		expect(tx.mutation().checks).toContainEqual({
			kind: "projection",
			id: projectionId("input", "attempt", "input"),
			revision: null,
		});
		await append(tx, "input_resolved", { inputId: "input" }, 2);
		expect(
			(await tx.get<{ detail_payload: { pendingInputs: unknown[] } }>("event", "2"))?.detail_payload.pendingInputs,
		).toEqual([]);
	});
	test("wrong append revision is rejected and terminal empty append settles the exact live lineage in the same batch", async () => {
		const rows = fixture();
		const tx = new RuntimeTransaction(rows);
		await append(tx, "message_updated", {
			mode: "snapshot",
			messageId: "m",
			blockId: "b",
			stream: "assistant",
			contentId: "content",
			revision: 1,
			offset: 0,
			endOffset: 5,
			totalBytes: 5,
			text: "hello",
			status: "streaming",
			partial: false,
		});
		const wrong = new RuntimeTransaction(rows);
		await expect(
			append(
				wrong,
				"message_updated",
				{
					mode: "append",
					messageId: "m",
					blockId: "b",
					stream: "assistant",
					contentId: "content",
					baseRevision: 1,
					revision: 2,
					offset: 5,
					endOffset: 6,
					totalBytes: 6,
					text: "!",
					status: "streaming",
				},
				2,
			),
		).rejects.toThrow("exact revision");
		await settleRuntimeMessages(tx, target, "settled", async (batch, _target, event) =>
			append(batch, event.kind, event.payload ?? {}, 2),
		);
		const message = await tx.get<{ value: Record<string, unknown> }>(
			"projection",
			projectionId("message", "attempt", "m", "b", "assistant"),
		);
		expect(message?.value).toMatchObject({ text: "hello", revision: 2, totalBytes: 5, status: "settled" });
		expect(tx.mutation().puts.some(row => row.kind === "event" && row.id === "2")).toBe(true);
		expect(rows.values.has(`projection:${projectionId("message", "attempt", "m", "b", "assistant")}`)).toBe(false);
	});
	test("continuations reject a different owner, revision and forged position", () => {
		const scope = ["messages", "agent", "attempt", 7];
		const cursor = encodeCursor(scope, "position");
		expect(decodeCursor(cursor, scope, "")).toBe("position");
		expect(() => decodeCursor(cursor, ["messages", "other", "attempt", 7], "")).toThrow("scope");
		expect(() => decodeCursor(cursor, ["messages", "agent", "attempt", 8], "")).toThrow("scope");
		expect(() => decodeCursor(`x${cursor}`, scope, "")).toThrow("scope");
	});
});
function storeWith(rows: Rows): RocksEngineStore {
	const store = new RocksEngineStore(rows.client);
	spyOn(store.records, "getMany").mockImplementation(keys => rows.getMany(keys));
	spyOn(store.records, "query").mockImplementation((index, key, cursor, max, after) =>
		rows.query(index, key, cursor, max, after),
	);
	return store;
}
const ref = "grimoire://tasks/grimoire/runtime-test/agents/a";
describe("Rocks bounded reader contracts", () => {
	test("default 1024-event recovery pages within owner bounds without fencing later reads", async () => {
		const rows = fixture();
		rows.seed("metadata", "events", { count: 1024 });
		const tx = new RuntimeTransaction(rows);
		await append(tx, "running", {});
		const projected = await tx.get<{ summary_payload: Record<string, unknown> }>("event", "1");
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests++;
				const { query } = (await request.json()) as { query: StorageRuntimeQuery };
				const envelope = {
					schema: "artel.storage.protocol.response.v1",
					version: "1.0",
					incarnation: 1,
					requestId: query.requestId,
				};
				// Same admission bounds as the Rust owner: invalid queries fence StorageClient.
				if (
					query.maxRecords < 1 ||
					query.maxRecords > 1000 ||
					query.maxBytes < 1024 ||
					query.maxBytes > 4 * 1024 * 1024
				)
					return Response.json(
						{ ...envelope, error: { code: "schema_error", message: "runtime query bounds exceeded" } },
						{ status: 400 },
					);
				const after = query.selector.type === "index" ? Number(query.selector.after?.[0] ?? 0) : 0;
				const end = Math.min(1024, after + query.maxRecords);
				return Response.json({
					...envelope,
					indexRevision: 1,
					nextCursor: end < 1024 ? String(end) : null,
					records: Array.from({ length: end - after }, (_, index) => ({
						kind: "event",
						id: String(after + index + 1),
						revision: 1,
						value: {
							eventId: after + index + 1,
							summary_payload: { ...projected!.summary_payload, revision: after + index + 1 },
						},
					})),
				});
			},
		});
		const client = new StorageClient({
			url: server.url.origin,
			token: "test-only-not-a-credential",
			incarnation: 1,
			protocolHash: STORAGE_PROTOCOL_SCHEMA_HASH,
		});
		const store = new RocksEngineStore(client);
		const read = spyOn(store.records, "getMany").mockImplementation(keys => rows.getMany(keys));
		try {
			const request: RuntimeEventsRequest = {
				scope: { kind: "catalog" },
				epoch: "epoch",
				principalId: "p",
				afterCursor: 0,
				limit: 1024,
				maxBytes: 65536,
				timeoutMs: 0,
				remainingWork: {
					bytes: 65536,
					changes: 1024,
					scannedRows: 8192,
					materializedBytes: 4 * 1024 * 1024,
					timeMs: 2000,
				},
			};
			const seen: number[] = [];
			for (let page = 0; page < 1024; page++) {
				const batch = await store.runtimeEvents(request);
				seen.push(...batch.changes.map(change => change.cursor));
				expect(batch.throughCursor).toBeGreaterThan(request.afterCursor);
				request.afterCursor = batch.throughCursor;
				request.untilCursor = batch.headCursor;
				if (!batch.hasMore) break;
			}
			expect(seen).toEqual(Array.from({ length: 1024 }, (_, index) => index + 1));
			expect(request.afterCursor).toBe(1024);
			expect(requests).toBeGreaterThan(1);
			const before = requests;
			const work = queryWork({ ...request.remainingWork, materializedBytes: 1024 });
			work.value.materializedBytes = 1;
			await expect(store.indexedEvents(["summary", "p", "", ""], 0, 1024, work)).rejects.toMatchObject({
				code: "restore_budget",
			});
			expect(requests).toBe(before);
			expect(client.failure).toBeUndefined();
			expect((await store.runtimeEvents(request)).changes).toEqual([]);
		} finally {
			read.mockRestore();
			await server.stop(true);
		}
	});
	test("terminal state resolves pending inputs and keeps newly staged active tools in its atomic detail", async () => {
		const tx = new RuntimeTransaction(fixture());
		await tx.put("effect", "tool", {
			effect_id: "tool",
			effect_kind: "tool",
			attempt_id: "attempt",
			state: "started",
			tool_call_id: "call",
			tool_name: "read",
			runtime_event_id: 1,
		});
		await append(tx, "input_requested", {
			inputId: "input",
			questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
		});
		const detail = (await tx.get<{ detail_payload: { tools: unknown[] } }>("event", "1"))?.detail_payload;
		expect(detail?.tools).toEqual([{ toolCallId: "call", name: "read", phase: "started", revision: 1 }]);
		await append(tx, "completed", {}, 2);
		expect(
			(await tx.get<{ resolved: boolean }>("projection", projectionId("input", "attempt", "input")))?.resolved,
		).toBe(true);
		expect((await tx.get<{ input_revision: number }>("attempt", "attempt"))?.input_revision).toBe(2);
	});
	test("atomic tool baseline continuation starts after its visible prefix without stale index cursors", async () => {
		const rows = fixture();
		const tx = new RuntimeTransaction(rows);
		for (let i = 0; i < 18; i++) {
			const id = `effect-${String(i).padStart(2, "0")}`;
			await tx.put("effect", id, {
				effect_id: id,
				effect_kind: "tool",
				attempt_id: "attempt",
				state: "started",
				tool_call_id: id,
				tool_name: "read",
				runtime_event_id: 1,
			});
		}
		const attempt = await tx.get<Record<string, unknown>>("attempt", "attempt");
		await tx.put("attempt", "attempt", { ...attempt, tool_revision: 1 });
		await append(tx, "running", {});
		const detail = (await tx.get<{ detail_payload: { tools: unknown[]; toolsNextCursor: string } }>("event", "1"))!
			.detail_payload;
		expect(detail.tools).toHaveLength(16);
		for (const put of tx.mutation().puts) rows.seed(put.kind, put.id, put.value);
		const page = await storeWith(rows).runtimeTools({
			principalId: "p",
			agentInstanceRef: ref,
			attemptId: "attempt",
			cursor: detail.toolsNextCursor,
		});
		expect((page.items as Array<{ toolCallId: string }>).map(item => item.toolCallId)).toEqual([
			"effect-16",
			"effect-17",
		]);
		expect(page.nextCursor).toBeNull();
	});

	test("queue reads use the pending partition and reject cross-principal access before returning data", async () => {
		const rows = fixture();
		for (const disposition of ["pending", "acknowledged"])
			rows.seed("inbox", disposition, {
				subtype: "item",
				agent_instance_id: "a",
				queue_id: disposition,
				queueId: disposition,
				sourceType: "user",
				source_event_id: disposition,
				sourceEventId: disposition,
				deliveryPayload: "hello",
				wakeIntent: false,
				position: 1,
				disposition,
				revision: 1,
				createdAt: 1,
				updatedAt: 1,
			});
		const store = storeWith(rows);
		const page = await store.runtimeQueue({ agentInstanceRef: ref, principalId: "p", limit: 1 });
		expect((page.items as Array<{ queueId: string }>).map(item => item.queueId)).toEqual(["pending"]);
		expect(store.records.query).toHaveBeenCalledWith("inbox_agent_pending", ["a"], undefined, 1);
		await expect(store.runtimeQueue({ agentInstanceRef: ref, principalId: "other", limit: 1 })).rejects.toThrow(
			"authorized",
		);
	});
	test("message resource bounds preserve UTF-8 and reject an interior codepoint offset", async () => {
		const rows = fixture();
		const tx = new RuntimeTransaction(rows);
		await append(tx, "message_updated", {
			mode: "snapshot",
			messageId: "m",
			blockId: "b",
			stream: "assistant",
			contentId: "content",
			revision: 1,
			offset: 0,
			endOffset: 5,
			totalBytes: 5,
			text: "a\u20acb",
			status: "streaming",
			partial: false,
		});
		for (const put of tx.mutation().puts) rows.seed(put.kind, put.id, put.value);
		const store = storeWith(rows);
		const resource = {
			kind: "message",
			agentInstanceRef: ref,
			attemptId: "attempt",
			messageId: "m",
			blockId: "b",
			stream: "assistant",
			contentId: "content",
			revision: 1,
			mediaType: "text/plain; charset=utf-8",
			bytes: 5,
		};
		const page = await store.runtimeResource({ principalId: "p", resource, offset: 0, limit: 3 });
		expect(Buffer.from(String(page.contentBase64), "base64").toString()).toBe("a");
		expect(page.nextOffset).toBe(1);
		await expect(store.runtimeResource({ principalId: "p", resource, offset: 2, limit: 3 })).rejects.toThrow("UTF-8");
	});
	test("native history cursor pins leaf/cut while later writes advance and resource can select its exact attempt", async () => {
		const rows = fixture();
		rows.seed("binding", "a", { agent_instance_id: "a", attempt_id: "attempt", session_file: "native:family/gen" });
		const store = storeWith(rows);
		let live = 2;
		const read = spyOn(store.storageClient, "readContext").mockImplementation(async input => {
			const leaf = input.leafId ?? (live === 2 ? "e2" : "e3");
			const n = Number(leaf.slice(1));
			return {
				schema: "artel.storage.protocol.response.v1",
				version: "1.0",
				requestId: "read",
				incarnation: 1,
				familyId: "family",
				generationId: "gen",
				throughSeq: input.cutSeq ?? live,
				durableThroughSeq: live,
				liveThroughSeq: live,
				head: { leafId: live === 2 ? "e2" : "e3" },
				state: { native: { header: { id: "native-session" } } },
				events: [
					{
						entryId: leaf,
						parentId: n > 1 ? `e${n - 1}` : null,
						kind: "message",
						seq: n,
						payload: {
							id: leaf,
							type: "message",
							parentId: n > 1 ? `e${n - 1}` : null,
							message: { role: "user", content: "hello" },
						},
					},
				],
				nextCursor: null,
			};
		});
		const first = await store.nativeHistoryPage("a", undefined, 1);
		live = 3;
		const second = await store.nativeHistoryPage("a", first.nextCursor ?? undefined, 1);
		expect(first.revision).toBe("e2");
		expect(second.revision).toBe("e2");
		expect(second.entries.map(entry => (entry as { id: string }).id)).toEqual(["e1"]);
		const resource = await nativeEntry(
			store,
			"a",
			"e2",
			first.lifecycleContext!.lineage,
			"native-session",
			"attempt",
		);
		expect(resource.entry.id).toBe("e2");
		expect(resource.sessionId).toBe("native-session");
		validateRuntimeValue("bulkResource", {
			kind: "history_entry",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/a",
			sessionId: "native-session",
			entryId: "e2",
			revision: first.lifecycleContext.lineage,
			mediaType: "application/json",
			bytes: 100,
		});
		expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ cutSeq: 2, leafId: "e2", maxRecords: 1 });
		await expect(nativeEntry(store, "a", "e2", first.lifecycleContext.lineage, "other-session")).rejects.toThrow(
			"changed session",
		);
		rows.seed("binding", "a", { agent_instance_id: "a", attempt_id: "attempt", session_file: "native:family/other" });
		await expect(nativeEntry(store, "a", "e2", first.lifecycleContext.lineage)).rejects.toThrow("changed scope");
	});
	test("a corrupt native locator reads as expired history, not an internal failure", async () => {
		const rows = fixture();
		const store = storeWith(rows);
		for (const session_file of ["native:%E0%A4%A/gen", "native:family-only", "legacy.jsonl"]) {
			rows.seed("binding", "a", { agent_instance_id: "a", attempt_id: "attempt", session_file });
			await expect(nativeScope(store, "a")).rejects.toMatchObject({ code: "history_expired" });
		}
	});
	test("history image ranges read the referenced blob body and never decode an inline record", async () => {
		using tempDir = TempDir.createSync("@omp-history-image-");
		const previous = process.env.PI_BLOBS_DIR;
		process.env.PI_BLOBS_DIR = tempDir.path();
		try {
			const image = Buffer.from(Uint8Array.from({ length: 70_000 }, (_, index) => (index * 5) & 0xff));
			const { hash } = await new BlobStore(tempDir.path()).put(image);
			const rows = fixture();
			rows.seed("binding", "a", {
				agent_instance_id: "a",
				attempt_id: "attempt",
				session_file: "native:family/gen",
			});
			const store = storeWith(rows);
			let data = `blob:sha256:${hash}`;
			spyOn(store.storageClient, "readContext").mockImplementation(async input => ({
				schema: "artel.storage.protocol.response.v1",
				version: "1.0",
				requestId: "read",
				incarnation: 1,
				familyId: "family",
				generationId: "gen",
				throughSeq: input.cutSeq ?? 1,
				durableThroughSeq: 1,
				liveThroughSeq: 1,
				head: { leafId: "e1" },
				state: { native: { header: { id: "native-session" } } },
				events: [
					{
						entryId: "e1",
						parentId: null,
						kind: "message",
						seq: 1,
						payload: {
							id: "e1",
							type: "message",
							parentId: null,
							message: { role: "user", content: [{ type: "image", data, mimeType: "image/png" }] },
						},
					},
				],
				nextCursor: null,
			}));
			const page = await store.nativeHistoryPage("a", undefined, 1);
			const resource = {
				kind: "history_image",
				agentInstanceRef: ref,
				attemptId: "attempt",
				sessionId: "native-session",
				entryId: "e1",
				revision: page.lifecycleContext.lineage,
				blockIndex: 0,
				mediaType: "image/png",
				bytes: image.length,
				contentHash: `sha256:${hash}`,
			};
			const range = await store.runtimeResource({ principalId: "p", resource, offset: 65_536, limit: 65_536 });
			expect(Buffer.from(String(range.contentBase64), "base64")).toEqual(image.subarray(65_536));
			expect(range.nextOffset).toBeNull();
			data = image.toString("base64");
			await expect(store.runtimeResource({ principalId: "p", resource, offset: 0, limit: 1024 })).rejects.toThrow(
				"content hash changed",
			);
		} finally {
			if (previous === undefined) delete process.env.PI_BLOBS_DIR;
			else process.env.PI_BLOBS_DIR = previous;
		}
	});
});
