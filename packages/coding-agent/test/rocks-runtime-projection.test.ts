import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineTarget } from "../src/engine/contracts";
import { decodeCursor, encodeCursor } from "../src/engine/rocks-runtime-cursor";
import { projectEvent, projectionId, settleRuntimeMessages } from "../src/engine/rocks-runtime-projection";
import { RuntimeRecords, RuntimeTransaction } from "../src/engine/runtime-records";
import { StorageClient } from "../src/session/storage-client";
import {
	STORAGE_PROTOCOL_SCHEMA_HASH,
	type StorageRuntimeIndex,
	type StorageRuntimeKind,
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
	override async get(kind: StorageRuntimeKind, id: string): Promise<StorageRuntimeRecord> {
		return structuredClone(this.values.get(`${kind}:${id}`) ?? { kind, id, revision: null, value: null });
	}
	override async query(
		index: StorageRuntimeIndex,
		key: Array<string | number | null>,
	): Promise<StorageRuntimeQueryResponse> {
		const rows = [...this.values.values()].filter(row =>
			String(index) === "projection_attempt"
				? row.kind === "projection" &&
					row.value?.subtype === key[0] &&
					row.value?.attempt_id === key[1] &&
					!row.value?.resolved
				: index === "command_agent_pending"
					? row.kind === "command" && row.value?.agent_instance_id === key[0] && row.value?.state === "received"
					: false,
		);
		return {
			schema: "artel.storage.protocol.response.v1",
			version: "1.0",
			requestId: "test",
			incarnation: 1,
			records: structuredClone(rows),
			nextCursor: null,
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
