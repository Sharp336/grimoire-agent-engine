import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import type { EngineBindingSnapshot, EngineEvent, EngineInboxTarget } from "../src/engine/contracts";
import type { RocksCommand, RocksIdentity } from "../src/engine/rocks-runtime-rows";
import type { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import { nativeHistoryAttachments, nativeHistoryImages } from "../src/engine/runtime-history";
import {
	type RuntimeScope,
	runtimeLimits,
	runtimeRemainingWork,
	validateRuntimeValue,
} from "../src/engine/runtime-protocol";
import { publicRuntimeQueueItem } from "../src/engine/runtime-queue";
import { EngineCommandConflictError } from "../src/engine/store";
import { BlobStore } from "../src/session/blob-store";
import type { NativeSessionCheckpoint } from "../src/session/native-session-storage";
import { RocksNativeSessionStorage } from "../src/session/rocks-native-session-storage";
import type { SessionEntry, SessionHeader } from "../src/session/session-entries";
import {
	active,
	binding,
	command,
	eventsRequest,
	identity,
	nativeCheckpoint,
	runtimeV1Fixture,
} from "./helpers/runtime-v1-rocks-fixture";
import { storageWorkerUnavailable } from "./helpers/storage-worker-fixture";

/** The Rust owner stores one runtime record in at most 256 KiB; every seed below stays inside it. */
const OWNER_RECORD_BYTES = 256 * 1024;

describe.skipIf(storageWorkerUnavailable)("runtime v1 receipts, queues and native resources", () => {
	const { createStore, reopen, blobsDir } = runtimeV1Fixture();

	/** One native transcript written through the product writer; its checkpoint state carries the header. */
	function nativeTranscript(store: RocksEngineStore, familyId: string, header: Record<string, unknown>) {
		const session = new RocksNativeSessionStorage(store.storageClient, familyId, "main");
		const checkpoint = (leafId: string | null) =>
			({
				schema: "omp.native.context.v1",
				header: header as unknown as SessionHeader,
				leafId,
				contextStartId: null,
				// The runtime history reads only the header; the context prefix belongs to session restore.
				prefix: {} as NativeSessionCheckpoint["prefix"],
			}) satisfies NativeSessionCheckpoint;
		let throughSeq = 0;
		return {
			sessionPath: session.locator,
			async append(entries: Array<Record<string, unknown>>) {
				const ticket = session.append(
					entries as unknown as SessionEntry[],
					checkpoint(String(entries.at(-1)!.id)),
					"required",
				);
				await ticket.completion;
				throughSeq = ticket.position.throughSeq;
			},
			/** Edits retained entries, deletes others and appends new ones in one conditional native write. */
			async rewrite(
				edited: Array<Record<string, unknown>>,
				deletedIds: string[],
				appended: Array<Record<string, unknown>> = [],
			) {
				const ticket = session.rewrite(
					edited as unknown as SessionEntry[],
					deletedIds,
					checkpoint(String((appended.at(-1) ?? edited.at(-1))!.id)),
					appended as unknown as SessionEntry[],
				);
				await ticket.completion;
				throughSeq = ticket.position.throughSeq;
			},
			/** The completed Attempt's durable native cut. */
			checkpoint(leafEntryId: string) {
				return {
					sessionId: String(header.id),
					sessionPath: session.locator,
					leafEntryId,
					byteBoundary: 0,
					native: { familyId, generationId: "main", throughSeq, incarnation: store.storageClient.incarnation },
				};
			},
		};
	}
	function failWrites(
		store: RocksEngineStore,
		matches: (puts: Array<{ kind: string; id: string; value: unknown }>) => boolean,
	) {
		const write = store.storageClient.write.bind(store.storageClient);
		return spyOn(store.storageClient, "write").mockImplementation((input, control) =>
			input.runtime && matches(input.runtime.puts)
				? Promise.reject(new Error("injected owner batch failure"))
				: write(input, control),
		);
	}

	it("routes frozen browser receipt targets across branch destination changes and preserves stages", async () => {
		const store = await createStore();
		const source = identity("root");
		await store.registerAgent(source);
		const destination = identity("branch");
		const scope = { kind: "agent" as const, agentInstanceRef: source.agentInstanceRef, kinds: ["state" as const] };
		const snapshot = await store.runtimeSnapshot(scope, { principalId: "owner" });
		const browserTarget = {
			agentInstanceRef: source.agentInstanceRef,
			attemptId: "source-attempt",
			executionId: "source-execution",
		};
		const start = {
			...command("branch-command"),
			...destination,
			serializedCommand: JSON.stringify({ browserTarget, payload: { expectedIntentRevision: 0 } }),
		};
		await store.admitCommand(start, 1);
		await store.settleCommand(start.commandId, start.canonicalHash, {
			outcome: "applied",
			detail: { intentRevision: 1 },
		});
		const queried = await store.runtimeCommand(start.commandId, { principalId: "owner" });
		expect(queried.target).toEqual(browserTarget);
		expect(queried.result).toMatchObject({
			target: { agentInstanceRef: destination.agentInstanceRef, attemptId: start.attemptId, intentRevision: 1 },
		});
		const batch = await store.runtimeEvents(eventsRequest(snapshot.epoch, snapshot.watermark, scope));
		const receipts = batch.changes.filter(change => change.kind === "receipt");
		expect(receipts.map(change => change.value.stage)).toEqual(["engine_accepted", "applied"]);
		for (const change of receipts) {
			validateRuntimeValue("change", change);
			expect(change.value.target).toEqual(browserTarget);
		}
	});

	it("enforces queue record bounds atomically while reserving control admission", async () => {
		const store = await createStore();
		const agent = identity("root");
		await store.registerAgent(agent);
		const target: EngineInboxTarget = { ...binding("root"), sessionId: "session-root" };
		for (let n = 0; n < runtimeLimits.agentPendingRecords; n++)
			await store.enqueueInboxItem(target, {
				sourceEventId: `message-${n}`,
				sourceType: "user",
				body: "queued",
				wakeIntent: true,
			});
		await expect(
			store.enqueueInboxItem(target, { sourceEventId: "overflow", sourceType: "user", body: "overflow" }),
		).rejects.toThrow("budget");
		expect(await store.getInboxItem(target.sessionId, "overflow")).toBeUndefined();
		expect((await store.admitCommand(command("stop", "cancel"), 1)).status).toBe("claimed");
		await expect(store.admitCommand(command("ordinary"), 1)).rejects.toThrow("budget");
		const page = await store.runtimeQueue({ agentInstanceRef: agent.agentInstanceRef, principalId: "owner" });
		expect((page.items as unknown[]).length).toBe(runtimeLimits.httpPageRecords);
		expect(page.nextCursor).toBeString();
	}, 60_000);

	it("keeps exact pending queue counts through edits, rollback, consumption and reopen", async () => {
		let store = await createStore();
		const target: EngineInboxTarget = { ...(await active(store)), sessionId: "count-session" };
		const scope: RuntimeScope = {
			kind: "agent",
			agentInstanceRef: identity("root").agentInstanceRef,
			kinds: ["queue"],
		};
		const count = async () => (await store.runtimeSnapshot(scope, { principalId: "owner" })).agents[0].queue;
		expect(await count()).toMatchObject({ pendingCount: 0 });
		const { item } = await store.enqueueInboxItem(target, {
			sourceEventId: "count-item",
			sourceType: "user",
			body: "before",
		});
		expect(await count()).toMatchObject({ pendingCount: 1 });
		const edited = await store.mutateInboxItem(target, {
			mutationId: "count-edit",
			queueId: item.queueId,
			expectedRevision: 1,
			op: "edit",
			value: "after",
		});
		expect(await count()).toMatchObject({ pendingCount: 1 });
		// The queue row, its pending count and its event are one owner batch: a refused batch changes none of them.
		const refused = failWrites(store, puts => puts.some(put => put.kind === "inbox" && put.id === "count-rollback"));
		try {
			const failure = await store
				.enqueueInboxItem(target, { sourceEventId: "count-rollback", sourceType: "user", body: "must roll back" })
				.then(
					() => undefined,
					error => error,
				);
			expect(failure).toBeInstanceOf(Error);
		} finally {
			refused.mockRestore();
		}
		expect(await count()).toMatchObject({ pendingCount: 1 });
		expect((await store.row<RocksIdentity>("identity", target.agentInstanceId))?.queue_pending_count).toBe(1);
		expect(await store.getInboxItem(target.sessionId, "count-rollback")).toBeUndefined();
		await store.close();
		store = reopen();
		expect(await count()).toMatchObject({ pendingCount: 1 });
		await store.mutateInboxItem(target, {
			mutationId: "count-consume",
			queueId: item.queueId,
			expectedRevision: edited.revision,
			op: "acknowledge",
		});
		expect(await count()).toMatchObject({ pendingCount: 0 });
	});

	it("reserves all control records when the device ordinary record budget is full", async () => {
		const store = await createStore();
		const first = { ...command("device-0", "enqueue"), ...identity("device-agent-0") };
		for (let n = 0; n < runtimeLimits.devicePendingRecords; n++) {
			const agent = identity(`device-agent-${Math.floor(n / runtimeLimits.agentPendingRecords)}`);
			await store.admitCommand({ ...command(`device-${n}`, "enqueue"), ...agent }, 1);
		}
		const overflow = { ...command("device-overflow", "enqueue"), ...identity("new-device-agent") };
		const rejected = await store.admitCommand(overflow, 1).then(
			() => undefined,
			error => error,
		);
		expect(rejected).toMatchObject({ code: "queue_full" });
		for (let n = 0; n < runtimeLimits.controlPendingRecords; n++)
			expect(
				(await store.admitCommand({ ...command(`reserved-${n}`, "cancel"), ...identity("device-agent-0") }, 1))
					.status,
			).toBe("claimed");
		const controlOverflow = await store
			.admitCommand({ ...command("reserved-overflow", "cancel"), ...identity("device-agent-0") }, 1)
			.then(
				() => undefined,
				error => error,
			);
		expect(controlOverflow).toMatchObject({ code: "queue_full" });
		await store.settleCommand(first.commandId, first.canonicalHash, { outcome: "applied" });
		expect((await store.admitCommand(overflow, 1)).status).toBe("claimed");
		// Received commands stay counted in their own ordinary and reserved-control lanes.
		expect((await store.records.get("metadata", "budget:ordinary:device")).value).toMatchObject({
			count: runtimeLimits.devicePendingRecords,
		});
		expect((await store.records.get("metadata", "budget:control:device")).value).toMatchObject({
			count: runtimeLimits.controlPendingRecords,
		});
	}, 180_000);

	it("enforces independent device and reserved-control byte budgets using real serialized commands", async () => {
		const store = await createStore();
		const bytes = runtimeLimits.deliveryBatchBytes;
		const payload = JSON.stringify({ text: "x".repeat(bytes - 11) });
		expect(Buffer.byteLength(payload)).toBe(bytes);
		const perAgent = Math.floor(runtimeLimits.agentPendingBytes / bytes);
		const records = Math.floor(runtimeLimits.devicePendingBytes / bytes);
		expect(records).toBeLessThan(runtimeLimits.devicePendingRecords);
		for (let n = 0; n < records; n++)
			await store.admitCommand(
				{
					...command(`bytes-${n}`, "enqueue"),
					...identity(`bytes-agent-${Math.floor(n / perAgent)}`),
					serializedCommand: payload,
				},
				1,
			);
		const overflow = {
			...command("bytes-overflow", "enqueue"),
			...identity("new-byte-agent"),
			serializedCommand: payload,
		};
		expect(
			await store.admitCommand(overflow, 1).then(
				() => undefined,
				error => error,
			),
		).toMatchObject({ code: "queue_full" });
		const controls = Math.floor(runtimeLimits.controlPendingBytes / bytes);
		expect(controls).toBeLessThan(runtimeLimits.controlPendingRecords);
		for (let n = 0; n < controls; n++)
			expect(
				(
					await store.admitCommand(
						{
							...command(`reserved-bytes-${n}`, "cancel"),
							...identity("bytes-agent-0"),
							serializedCommand: payload,
						},
						1,
					)
				).status,
			).toBe("claimed");
		expect(
			await store
				.admitCommand(
					{
						...command("reserved-bytes-overflow", "cancel"),
						...identity("bytes-agent-0"),
						serializedCommand: payload,
					},
					1,
				)
				.then(
					() => undefined,
					error => error,
				),
		).toMatchObject({ code: "queue_full" });
	}, 180_000);

	it("reads large queue fields through bounded previews and exact UTF-8 ranges", async () => {
		const store = await createStore();
		const agent = identity("queue-large");
		await store.registerAgent(agent);
		const target: EngineInboxTarget = { ...binding("queue-large"), sessionId: "session-queue-large" };
		// Multi-byte and JSON-escaped text; the queue row keeps body, source body, sender and annotation in one record.
		const text = (repeat: number) => `${"я😀".repeat(1000)}\u0000\\"`.repeat(repeat);
		const fields = { deliveryPayload: text(11), sender: text(5), annotation: text(5) };
		expect(Buffer.byteLength(fields.deliveryPayload)).toBeGreaterThan(runtimeLimits.httpRangeBytes + 2);
		const first = await store.enqueueInboxItem(target, {
			sourceEventId: "large-first",
			sourceType: "user",
			body: fields.deliveryPayload,
			sender: fields.sender,
		});
		const annotated = await store.mutateInboxItem(target, {
			mutationId: "large-annotation",
			queueId: first.item.queueId,
			expectedRevision: first.item.revision,
			op: "annotate",
			value: fields.annotation,
		});
		const second = await store.enqueueInboxItem(target, {
			sourceEventId: "large-second",
			sourceType: "agent",
			body: "later",
		});
		const access = { principalId: "owner", agentInstanceRef: agent.agentInstanceRef };
		const page = await store.runtimeQueue({ ...access, limit: 1 });
		validateRuntimeValue("queuePage", page);
		const item = (page.items as Record<string, unknown>[])[0];
		expect(item).toMatchObject({ queueId: first.item.queueId, revision: annotated.revision, partial: true });
		expect(item).not.toHaveProperty("sourceBody");
		expect(item).not.toHaveProperty("agentInstanceId");
		const work = page.work as { bytes: number; materializedBytes: number; scannedRows: number };
		expect(work.bytes).toBe(Buffer.byteLength(JSON.stringify(page)));
		// The owner returns whole records: materialization is the one queue row plus bounded metadata.
		expect(work.materializedBytes).toBeLessThan(OWNER_RECORD_BYTES + 16_384);
		expect(work.scannedRows).toBeLessThanOrEqual(16);
		expect(
			Buffer.byteLength(
				JSON.stringify({ deliveryPayload: item.deliveryPayload, annotation: item.annotation, sender: item.sender }),
			),
		).toBeLessThanOrEqual(runtimeLimits.bulkPreviewBytes);
		for (const [key, field] of [
			["resource", "deliveryPayload"],
			["annotationResource", "annotation"],
			["senderResource", "sender"],
		] as const) {
			const encoded = Buffer.from(fields[field]);
			const resource = item[key] as Record<string, unknown>;
			expect(resource.bytes).toBe(encoded.length);
			const offset = 2;
			const range = await store.runtimeResource({
				principalId: "owner",
				resource,
				offset,
				limit: runtimeLimits.httpRangeBytes,
			});
			validateRuntimeValue("httpRange", range);
			const received = Buffer.from(String(range.contentBase64), "base64");
			expect(received).toEqual(encoded.subarray(offset, offset + received.length));
			expect(received.length).toBeGreaterThanOrEqual(
				Math.min(runtimeLimits.httpRangeBytes, encoded.length - offset) - 3,
			);
			await expect(
				store.runtimeResource({ principalId: "owner", resource, offset: 3, limit: 10 }),
			).rejects.toMatchObject({ code: "invalid_request" });
			const end = await store.runtimeResource({ principalId: "owner", resource, offset: encoded.length, limit: 1 });
			expect(end).toMatchObject({ nextOffset: null, contentBase64: "" });
			await expect(
				store.runtimeResource({ principalId: "other", resource, offset: 0, limit: 1 }),
			).rejects.toMatchObject({ code: "agent_not_found" });
			await expect(
				store.runtimeResource({
					principalId: "owner",
					resource: { ...resource, revision: 900 },
					offset: 0,
					limit: 1,
				}),
			).rejects.toMatchObject({ code: "stale_target" });
		}
		const next = await store.runtimeQueue({ ...access, cursor: String(page.nextCursor), limit: 1 });
		expect(next.items).toMatchObject([{ queueId: second.item.queueId, deliveryPayload: "later", partial: false }]);
		expect(next.nextCursor).toBeNull();
		const exact = await store.runtimeQueue({ ...access, queueId: second.item.queueId });
		expect(exact.items).toHaveLength(1);
		await expect(store.runtimeQueue({ ...access, principalId: "other" })).rejects.toMatchObject({
			code: "agent_not_found",
		});
		await store.mutateInboxItem(target, {
			mutationId: "change-later",
			queueId: second.item.queueId,
			op: "drop",
			expectedRevision: second.item.revision,
		});
		await expect(store.runtimeQueue({ ...access, cursor: String(page.nextCursor) })).rejects.toMatchObject({
			code: "stale_target",
		});
	});

	it("keeps escaped queue text and ancillary-only partial receipts inside the public change bound", async () => {
		const store = await createStore();
		const agent = identity("root");
		await store.registerAgent(agent);
		const target: EngineInboxTarget = { ...binding("root"), sessionId: "session-root" };
		const queued = await store.enqueueInboxItem(target, {
			sourceEventId: "escaped-queue",
			sourceType: "user",
			body: "short",
		});
		const item = publicRuntimeQueueItem(agent.agentInstanceRef, {
			...queued.item,
			sender: '\\"\n'.repeat(40_000),
			annotation: "annotation".repeat(40_000),
		});
		expect(item).toMatchObject({ partial: false, deliveryPayload: "short" });
		expect(item).not.toHaveProperty("resource");
		expect(item).toHaveProperty("senderResource");
		expect(item).toHaveProperty("annotationResource");
		validateRuntimeValue("queueItem", item);
		const emoji = "😀".repeat(20_000);
		const emojiItem = publicRuntimeQueueItem(agent.agentInstanceRef, { ...queued.item, deliveryPayload: emoji });
		expect(emojiItem.partial).toBe(true);
		expect(emoji.startsWith(String(emojiItem.deliveryPayload))).toBe(true);
		expect(emojiItem.deliveryPayload).not.toContain("�");
		validateRuntimeValue("queueItem", emojiItem);
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		const cmd = command("queue-receipt", "enqueue");
		await store.admitCommand(cmd, 1);
		await store.settleCommand(cmd.commandId, cmd.canonicalHash, { outcome: "applied", detail: { item } });
		const receipt = await store.runtimeCommand(cmd.commandId, { principalId: "owner" });
		expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(runtimeLimits.liveChangeBytes);
		const events = await store.runtimeEvents(
			eventsRequest(snapshot.epoch, snapshot.watermark, {
				kind: "agent",
				agentInstanceRef: agent.agentInstanceRef,
				kinds: ["state"],
			}),
		);
		expect(events.changes.filter(change => change.kind === "receipt").length).toBe(2);
		validateRuntimeValue("eventBatch", events);
		// A retained item receipt still carrying its private source body projects only public queue fields.
		const retained = command("retained-queue-receipt", "queue_edit");
		await store.admitCommand(retained, 1);
		await store.settleCommand(retained.commandId, retained.canonicalHash, {
			outcome: "applied",
			detail: { item: { ...queued.item, sourceBody: "private source".repeat(10_000) } },
		});
		const recovered = await store.runtimeCommand(retained.commandId, { principalId: "owner" });
		expect(Buffer.byteLength(JSON.stringify(recovered))).toBeLessThan(runtimeLimits.liveChangeBytes);
		expect(JSON.stringify(recovered)).not.toContain("private source");
		expect(JSON.stringify(recovered)).not.toContain("sourceBody");
		await store.mutateInboxItem(target, {
			mutationId: "retained-result-later",
			queueId: queued.item.queueId,
			expectedRevision: queued.item.revision,
			op: "drop",
		});
		const later = await store.runtimeCommand(retained.commandId, { principalId: "owner" });
		expect(later).toMatchObject({ stage: "applied", lookup: "known" });
		expect(later.result).toEqual(recovered.result);
		expect(later.target).toEqual(recovered.target);
		expect(later.payloadHash).toBe(recovered.payloadHash);
	});

	it("keeps oversized retained receipts bounded on replay without rewriting authority", async () => {
		let store = await createStore();
		await store.registerAgent(identity("source-browser"));
		const frozenTarget = {
			agentInstanceRef: identity("source-browser").agentInstanceRef,
			attemptId: "browser-attempt",
			executionId: "browser-execution",
		};
		const applied = {
			...command("huge-applied", "enqueue"),
			serializedCommand: JSON.stringify({ browserTarget: frozenTarget }),
		};
		await store.admitCommand(applied, 1);
		// Beyond one live change, inside one owner record.
		const receipt = { outcome: "applied" as const, detail: { result: "native-result".repeat(9_000) } };
		expect(Buffer.byteLength(JSON.stringify(receipt))).toBeGreaterThan(runtimeLimits.liveChangeBytes);
		await store.settleCommand(applied.commandId, applied.canonicalHash, receipt);
		const first = await store.runtimeCommand(applied.commandId, { principalId: "owner" });
		expect(first).toMatchObject({
			stage: "applied",
			lookup: "known",
			target: frozenTarget,
			payloadHash: applied.browserPayloadHash,
			result: { partial: true, unavailable: "result_exceeds_projection_limit" },
		});
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(runtimeLimits.liveChangeBytes);
		const replay = await store.admitCommand(applied, 1);
		expect(replay).toMatchObject({ status: "replay", receipt: { outcome: "applied", detail: { partial: true } } });
		expect(Buffer.byteLength(JSON.stringify(replay))).toBeLessThan(runtimeLimits.liveChangeBytes);
		// The identical settlement is idempotent; any other receipt conflicts.
		await store.settleCommand(applied.commandId, applied.canonicalHash, receipt);
		await expect(
			store.settleCommand(applied.commandId, applied.canonicalHash, { outcome: "applied", detail: {} }),
		).rejects.toBeInstanceOf(EngineCommandConflictError);
		expect((await store.runtimeCommand(applied.commandId, { principalId: "owner" })).target).toEqual(frozenTarget);
		await expect(store.admitCommand({ ...applied, canonicalHash: "changed" }, 1)).rejects.toThrow(
			"different canonical",
		);
		await expect(store.runtimeCommand(applied.commandId, { principalId: "foreign" })).rejects.toThrow("authorized");
		const rejected = {
			...command("huge-rejected", "steer"),
			serializedCommand: JSON.stringify({ browserTarget: frozenTarget }),
		};
		await store.admitCommand(rejected, 1);
		await store.settleCommand(rejected.commandId, rejected.canonicalHash, {
			outcome: "rejected",
			detail: { message: "rejected".repeat(15_000) },
		});
		expect(await store.runtimeCommand(rejected.commandId, { principalId: "owner" })).toMatchObject({
			stage: "rejected",
			lookup: "known",
			target: frozenTarget,
		});
		await store.close();
		store = reopen();
		expect(await store.runtimeCommand(applied.commandId, { principalId: "owner" })).toEqual(first);
		expect(await store.admitCommand(applied, 1)).toEqual(replay);
		const row = await store.row<RocksCommand>("command", applied.commandId);
		expect(row).toMatchObject({ state: "settled", receipt });
	});

	it("rolls back receipt settlement when its bounded receipt event fails", async () => {
		const store = await createStore();
		const cmd = command("receipt-rollback", "enqueue");
		await store.admitCommand(cmd, 1);
		const before = (await store.meta()).watermark;
		const refused = failWrites(store, puts =>
			puts.some(put => put.kind === "event" && (put.value as { kind?: string }).kind === "command_receipt"),
		);
		try {
			const result = await store
				.settleCommand(cmd.commandId, cmd.canonicalHash, {
					outcome: "applied",
					detail: { text: "x".repeat(100_000) },
				})
				.then(
					() => undefined,
					error => error,
				);
			expect(result).toBeInstanceOf(Error);
		} finally {
			refused.mockRestore();
		}
		expect(await store.runtimeCommand(cmd.commandId, { principalId: "owner" })).toMatchObject({
			stage: "engine_accepted",
			lookup: "pending",
		});
		expect((await store.meta()).watermark).toBe(before);
		expect(await store.row<RocksCommand>("command", cmd.commandId)).toMatchObject({
			state: "received",
			receipt: null,
		});
	});

	it("commits concurrent stream appends before their readers and refuses a broken stream append without acknowledgement", async () => {
		const store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		const write = (revision: number, text: string, baseRevision = revision - 1) =>
			store.appendEvent({
				...target,
				causationCommandId: `stream-${revision}`,
				kind: "message_updated",
				payload: {
					mode: revision === 1 ? "snapshot" : "append",
					...(revision === 1 ? { partial: false } : { baseRevision }),
					messageId: "group-message",
					blockId: "text",
					contentId: "group-content",
					stream: "assistant",
					revision,
					offset: revision - 1,
					endOffset: revision,
					totalBytes: revision,
					text,
					status: "streaming",
				},
			});
		const scope = {
			kind: "attempt" as const,
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			kinds: ["assistant" as const],
		};
		// One native snapshot is one owner cut: an append committed during the read makes it restart.
		const snapshot = async () => {
			for (;;) {
				const result = await store.runtimeSnapshot(scope, { principalId: "owner" }).then(
					value => ({ value }),
					(error: unknown) => ({ error }),
				);
				if ("value" in result) return result.value;
				expect(result.error).toMatchObject({ code: "projection_changed" });
			}
		};
		const [a, b] = await Promise.all([write(1, "a"), write(2, "b")]);
		expect(a.eventId).toBeLessThan(b.eventId);
		expect((await snapshot()).watermark).toBe(b.eventId);
		const [cut, c] = await Promise.all([snapshot(), write(3, "c")]);
		expect(c.eventId).toBeGreaterThan(b.eventId);
		expect([b.eventId, c.eventId]).toContain(cut.watermark);
		// Each native append is its own owner batch: the broken successor fails alone and publishes nothing.
		const settled = await Promise.allSettled([write(4, "d"), write(5, "e", 100)]);
		expect(settled.map(value => value.status)).toEqual(["fulfilled", "rejected"]);
		const appended: EngineEvent = (settled[0] as PromiseFulfilledResult<EngineEvent>).value;
		expect(appended.seq).toBe(c.seq + 1);
		expect((await snapshot()).watermark).toBe(appended.eventId);
		const resource = {
			kind: "message",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			messageId: "group-message",
			blockId: "text",
			stream: "assistant",
			contentId: "group-content",
			revision: 4,
			bytes: 4,
			mediaType: "text/plain; charset=utf-8",
		};
		const range = await store.runtimeResource({ principalId: "owner", resource, offset: 0, limit: 4 });
		expect(Buffer.from(String(range.contentBase64), "base64").toString("utf8")).toBe("abcd");
	});

	it("anchors retry events between their native responses and distinguishes rejected controls from Attempt completion", async () => {
		const store = await createStore();
		const agent = identity("retry-chronology");
		await store.registerAgent(agent);
		const transcript = nativeTranscript(store, "retry-chronology", {
			type: "session",
			version: 3,
			id: "retry-session",
			timestamp: new Date(0).toISOString(),
			cwd: "/test",
		});
		const target = { ...binding("retry-chronology"), sessionFile: transcript.sessionPath };
		await store.admitCommand(
			{ ...command(target.commandId), ...agent, attemptId: target.attemptId, executionId: target.executionId },
			1,
		);
		await store.commitAttemptTransition(target, "running", [{ kind: "running" }]);
		const emit = (
			kind: "assistant_snapshot" | "retry_scheduled" | "retry_settled" | "rejected" | "completed",
			payload = {},
		) => store.appendEvent({ ...target, causationCommandId: target.commandId, kind, payload });
		await emit("assistant_snapshot", { assistantMessageId: "failed-response", text: "" });
		const retry = await emit("retry_scheduled");
		const rejected = await emit("rejected");
		await emit("assistant_snapshot", { assistantMessageId: "final-response", text: "Answer" });
		await emit("retry_settled");
		const completed = await emit("completed");
		await emit("assistant_snapshot", { assistantMessageId: "failed-response", text: "" });
		await transcript.append([
			{
				type: "message",
				id: "user",
				parentId: null,
				sourceCommandId: target.commandId,
				timestamp: new Date(3000).toISOString(),
				message: { role: "user", content: "Start" },
			},
			{
				type: "message",
				id: "failure",
				parentId: "user",
				assistantMessageId: "failed-response",
				timestamp: new Date(2000).toISOString(),
				message: { role: "assistant", content: [], stopReason: "error" },
			},
			{
				type: "message",
				id: "final",
				parentId: "failure",
				assistantMessageId: "final-response",
				timestamp: new Date(1000).toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop" },
			},
		]);
		const history = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 50);
		const page = await store.nativeLifecyclePage(
			agent.agentInstanceId,
			agent.agentInstanceRef,
			50,
			undefined,
			history.lifecycleContext,
		);
		expect(page.activities.find(event => event.eventId === String(retry.eventId))).toMatchObject({
			afterEntryId: "failure",
			terminal: false,
		});
		expect(page.activities.find(event => event.eventId === String(rejected.eventId))).toMatchObject({
			afterEntryId: "failure",
			status: "failed",
			terminal: false,
		});
		expect(page.activities.find(event => event.eventId === String(completed.eventId))).toMatchObject({
			afterEntryId: "final",
			terminal: true,
		});
		expect(page.activities.find(event => event.status === "started")).toMatchObject({
			afterEntryId: "user",
			terminal: false,
		});
		for (const event of page.activities) validateRuntimeValue("lifecycleActivity", event);
		const lastEntry = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 1);
		const partial = await store.nativeLifecyclePage(
			agent.agentInstanceId,
			agent.agentInstanceRef,
			50,
			undefined,
			lastEntry.lifecycleContext,
		);
		const partialRetry = partial.activities.find(event => event.eventId === String(retry.eventId));
		expect(partialRetry).toBeDefined();
		expect(partialRetry?.afterEntryId).toBeUndefined();
		expect(partialRetry?.beforeEntryId).toBeUndefined();
		expect(partial.work.scannedRows).toBeLessThan(runtimeLimits.bootstrapScannedRows);
	});

	it("pins bounded lifecycle pages to reachable native entries and their immutable event cut", async () => {
		const store = await createStore();
		const agent = identity("lifecycle");
		await store.registerAgent(agent);
		const header = {
			type: "session",
			version: 3,
			id: "session-lifecycle",
			timestamp: new Date(0).toISOString(),
			cwd: "/test",
		};
		const transcript = nativeTranscript(store, "runtime-v1-lifecycle", header);
		const old = { ...binding("lifecycle"), sessionFile: transcript.sessionPath };
		const removed = {
			...old,
			attemptId: "removed-attempt",
			executionId: "removed-execution",
			commandId: "removed-start",
			bindingGeneration: 2,
		};
		const current = {
			...old,
			attemptId: "current-attempt",
			executionId: "current-execution",
			commandId: "current-start",
			bindingGeneration: 3,
		};
		// Each Attempt starts from its admitted command; events append while it holds the binding.
		const start = async (target: EngineBindingSnapshot) => {
			await store.admitCommand(
				{ ...command(target.commandId), ...agent, attemptId: target.attemptId, executionId: target.executionId },
				1,
			);
			await store.commitAttemptTransition(target, "running", [{ kind: "running" }]);
		};
		await start(old);
		for (let i = 0; i < 110; i++)
			await store.appendEvent({
				...old,
				causationCommandId: old.commandId,
				kind: "retry_settled",
				payload: { retry: { attempt: i, maxAttempts: 110, error: "bounded retained reason" } },
			});
		await start(removed);
		await store.appendEvent({
			...removed,
			causationCommandId: removed.commandId,
			kind: "failed",
			payload: { error: "edited away" },
		});
		await start(current);
		const entry = (id: string, parentId: string | null, target = old) => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date(0).toISOString(),
			sourceCommandId: target.commandId,
			message: { role: "user", content: id },
		});
		await transcript.append([
			entry("old-user", null),
			entry("removed-user", "old-user", removed),
			entry("current-user", "old-user", current),
		]);
		const history = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 50);
		expect(history.entries.map(value => (value as { id: string }).id)).toEqual(["old-user", "current-user"]);
		const first = await store.nativeLifecyclePage(
			agent.agentInstanceId,
			agent.agentInstanceRef,
			1,
			undefined,
			history.lifecycleContext,
		);
		expect(first.activities).toHaveLength(1);
		expect(first.activityNextCursor).toBeString();
		const oneEntry = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 1);
		const later = await store.appendEvent({
			...current,
			causationCommandId: current.commandId,
			kind: "paused",
			payload: {},
		});
		await transcript.append([entry("after-cut", "current-user", current)]);
		const olderEntry = await store.nativeHistoryPage(agent.agentInstanceId, oneEntry.nextCursor!, 1);
		expect(olderEntry.lifecycleContext.watermark).toBe(oneEntry.lifecycleContext.watermark);
		expect(olderEntry.lifecycleContext.currentAttemptId).toBe(oneEntry.lifecycleContext.currentAttemptId);
		const activities = [...first.activities];
		let cursor = first.activityNextCursor;
		while (cursor) {
			const page = await store.nativeLifecyclePage(
				agent.agentInstanceId,
				agent.agentInstanceRef,
				17,
				undefined,
				undefined,
				cursor,
			);
			expect(page.activities.length).toBeLessThanOrEqual(17);
			expect(page.work.scannedRows).toBeLessThanOrEqual(runtimeLimits.bootstrapScannedRows);
			expect(page.work.changes).toBe(page.activities.length);
			activities.push(...page.activities);
			cursor = page.activityNextCursor;
		}
		expect(activities).toHaveLength(112);
		expect(new Set(activities.map(value => value.id)).size).toBe(112);
		expect(
			activities.every(value => value.attemptId !== removed.attemptId && value.eventId !== String(later.eventId)),
		).toBe(true);
		for (const value of activities) {
			validateRuntimeValue("lifecycleActivity", value);
			expect(["old-user", "current-user"]).toContain(String(value.afterEntryId));
		}
		// Another agent with its own retained native history cannot continue this cursor.
		const foreign = identity("lifecycle-foreign");
		await store.registerAgent(foreign);
		const foreignTranscript = nativeTranscript(store, "runtime-v1-lifecycle-foreign", header);
		await foreignTranscript.append([entry("foreign-user", null)]);
		await store.commitAttemptTransition(
			{ ...binding("lifecycle-foreign"), sessionFile: foreignTranscript.sessionPath },
			"running",
			[{ kind: "running" }],
		);
		await expect(
			store.nativeLifecyclePage(
				foreign.agentInstanceId,
				agent.agentInstanceRef,
				10,
				undefined,
				undefined,
				first.activityNextCursor!,
			),
		).rejects.toMatchObject({ code: "stale_target" });
		// A native rewrite appends a new cut; the continuation stays on its pinned immutable cut and events.
		const continuation = () =>
			store.nativeLifecyclePage(
				agent.agentInstanceId,
				agent.agentInstanceRef,
				10,
				undefined,
				undefined,
				first.activityNextCursor!,
			);
		const beforeRewrite = await continuation();
		await transcript.rewrite(
			[],
			["old-user", "removed-user", "current-user", "after-cut"],
			[entry("rewritten", null, current)],
		);
		expect((await continuation()).activities).toEqual(beforeRewrite.activities);
		const rewritten = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 50);
		expect(rewritten.entries.map(value => (value as { id: string }).id)).toEqual(["rewritten"]);
		expect(rewritten.lifecycleContext.lineage).not.toBe(history.lifecycleContext.lineage);
	}, 30_000);

	it("reads the retained native session header from one bounded record and fences its exact Attempt", async () => {
		const store = await createStore();
		await store.registerAgent(identity("header"));
		const header = {
			type: "session",
			version: 3,
			id: "session-header",
			timestamp: new Date(0).toISOString(),
			cwd: "/exact-cwd",
		};
		const transcript = nativeTranscript(store, "runtime-large-header", header);
		await transcript.append([
			{
				type: "message",
				id: "only",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "x" },
			},
		]);
		const target = { ...binding("header"), sessionFile: transcript.sessionPath };
		await store.commitAttemptTransition(target, "running", [{ kind: "running" }]);
		const context = spyOn(store.storageClient, "readContext");
		try {
			expect(await store.nativeSessionHeader(target)).toEqual({ sessionId: header.id, cwd: header.cwd });
			// The header comes from the checkpoint state of one bounded record, never from the transcript entries.
			expect(context.mock.calls.map(([input]) => input.maxRecords)).toEqual([1]);
			expect(
				await store.nativeSessionHeader({ ...target, attemptId: "foreign" }).then(
					() => null,
					(error: unknown) => error,
				),
			).toMatchObject({ code: "stale_target" });
			expect(
				await store.nativeSessionHeader({ ...target, executionId: "changed" }).then(
					() => null,
					(error: unknown) => error,
				),
			).toMatchObject({ code: "stale_target" });
		} finally {
			context.mockRestore();
		}
	});

	it("bounds native history reads by the page instead of the 100,000-entry transcript", async () => {
		const store = await createStore();
		const agent = identity("history");
		await store.registerAgent(agent);
		const transcript = nativeTranscript(store, "runtime-v1-history", {
			type: "session",
			version: 3,
			id: "session-history",
			timestamp: new Date(0).toISOString(),
			cwd: "/test",
		});
		const entries = Array.from({ length: 100_000 }, (_, i) => ({
			type: "message",
			id: `entry-${i}`,
			parentId: i ? `entry-${i - 1}` : null,
			timestamp: new Date(i).toISOString(),
			message: {
				role: i % 2 ? "assistant" : "user",
				content: [{ type: "text", text: `message-${i}` }],
				timestamp: i,
			},
		}));
		// The owner admits a bounded entry count per native write.
		for (let i = 0; i < entries.length; i += 32) await transcript.append(entries.slice(i, i + 32));
		await store.putBinding({ ...binding("history"), sessionFile: transcript.sessionPath });
		const page = await store.nativeHistoryPage(agent.agentInstanceId);
		expect(page.entries).toHaveLength(100);
		expect(page.visitedRecords).toBeLessThanOrEqual(runtimeLimits.httpPageRecords * 2 + 10);
		// One owner page per visited entry, each with its checkpoint state and envelope: bounded by the page,
		// not by the ~20 MB transcript.
		expect(page.readBytes).toBeLessThan((runtimeLimits.httpPageRecords + 1) * 2048);
		expect((page.entries[0] as { id: string }).id).toBe("entry-99900");
		expect(page.nextCursor).toBeString();
		await transcript.append([
			{
				type: "message",
				id: "after-cut",
				parentId: "entry-99999",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "After pinned page", timestamp: Date.now() },
			},
		]);
		const prior = await store.nativeHistoryPage(agent.agentInstanceId, page.nextCursor!);
		expect(prior.revision).toBe(page.revision);
		expect((prior.entries.at(-1) as { id: string }).id).toBe("entry-99899");
		expect(prior.visitedRecords).toBeLessThanOrEqual(runtimeLimits.httpPageRecords * 2 + 10);
		// Beyond one history page: the native writer keeps it as an entry blob, never inline in the owner record.
		const giant = {
			type: "message",
			id: "giant",
			parentId: "after-cut",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: Array.from({ length: 3 }, () => ({
					type: "text",
					text: "я".repeat(runtimeLimits.httpPageBytes / 4),
				})),
			},
		};
		const giantBytes = Buffer.from(JSON.stringify(giant));
		expect(giantBytes.length).toBeGreaterThan(runtimeLimits.httpPageBytes);
		await transcript.append([giant]);
		const oversized = await store.nativeHistoryPage(agent.agentInstanceId);
		expect(oversized.entries).toEqual([]);
		expect(oversized.entryRef?.entryId).toBe("giant");
		expect(oversized.entryRef?.bytes).toBe(giantBytes.length);
		// Only owner records are read; the entry body stays in its blob.
		expect(oversized.readBytes).toBeLessThan(runtimeLimits.deliveryBatchBytes);
		const chunk = await store.nativeHistoryEntry(agent.agentInstanceId, "giant", oversized.entryRef!.revision);
		expect(Buffer.from(String(chunk.contentBase64), "base64")).toEqual(
			giantBytes.subarray(0, runtimeLimits.deliveryBatchBytes),
		);
		expect(chunk.nextOffset).toBe(runtimeLimits.deliveryBatchBytes);
		const resource = {
			kind: "history_entry",
			agentInstanceRef: agent.agentInstanceRef,
			sessionId: oversized.sessionId,
			entryId: "giant",
			revision: oversized.entryRef!.revision,
			bytes: oversized.entryRef!.bytes,
			mediaType: "application/json",
		};
		const range = await store.runtimeResource({ principalId: "owner", resource, offset: 65536, limit: 65536 });
		validateRuntimeValue("httpRange", range);
		expect(Buffer.from(String(range.contentBase64), "base64")).toEqual(giantBytes.subarray(65536, 131072));
		await expect(store.runtimeResource({ principalId: "other", resource, offset: 0, limit: 32 })).rejects.toThrow(
			"authorized",
		);
		await expect(
			store.runtimeResource({
				principalId: "owner",
				resource: { ...resource, bytes: resource.bytes + 1 },
				offset: 0,
				limit: 32,
			}),
		).rejects.toThrow("size");
		// A native rewrite appends a new cut: the pinned resource and cursor keep reading their immutable cut.
		const pinnedRange = await store.runtimeResource({ principalId: "owner", resource, offset: 0, limit: 32 });
		const pinnedPrior = await store.nativeHistoryPage(agent.agentInstanceId, page.nextCursor!);
		await transcript.rewrite([], ["giant"], [{ ...giant, id: "rewritten" }]);
		expect(await store.runtimeResource({ principalId: "owner", resource, offset: 0, limit: 32 })).toEqual(
			pinnedRange,
		);
		expect(await store.nativeHistoryPage(agent.agentInstanceId, page.nextCursor!)).toMatchObject({
			revision: pinnedPrior.revision,
			entries: pinnedPrior.entries,
		});
		const rewritten = await store.nativeHistoryPage(agent.agentInstanceId);
		expect(rewritten.entryRef?.entryId).toBe("rewritten");
		expect(rewritten.entryRef?.revision).not.toBe(resource.revision);
	}, 120_000);

	it("downloads original files only through their authorized message descriptor and rejects changed ownership or metadata", async () => {
		const store = await createStore();
		const blobs = new BlobStore(blobsDir());
		const bytes = Buffer.from(Array.from({ length: 130_017 }, (_, index) => index % 251));
		const saved = await blobs.publish(bytes);
		const unrelated = await blobs.publish(Buffer.from("not owned by this message"));
		await unrelated.release();
		const agent = identity("file-resource");
		await store.registerAgent(agent);
		const header = {
			type: "session",
			version: 3,
			id: "file-session",
			timestamp: new Date(0).toISOString(),
			cwd: "/test",
		};
		const transcript = nativeTranscript(store, "file-resource", header);
		const target = { ...binding("file-resource"), sessionFile: transcript.sessionPath };
		const message = {
			type: "message",
			id: "file-entry",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "" },
			originalAttachments: [
				{
					name: "report.bin",
					mediaType: "application/octet-stream",
					bytes: bytes.length,
					contentHash: `sha256:${saved.hash}`,
				},
			],
		};
		await transcript.append([message]);
		// The applied record owns the managed body now; the producer pin is no longer needed.
		await saved.release();
		await store.commitAttemptTransition(target, "completed", [{ kind: "completed" }], {
			transcriptCheckpoint: transcript.checkpoint(message.id),
		});
		const page = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 100, target.attemptId);
		const resource = (await nativeHistoryAttachments(page, agent.agentInstanceRef, blobs)).get(message.id)![0]
			.resource!;
		validateRuntimeValue("resourceReadRequest", { resource, offset: 0, limit: 65536 });
		const read = (changes: Record<string, unknown> = {}, principalId = "owner", offset = 0, limit = 65536) =>
			store.runtimeResource({ principalId, resource: { ...resource, ...changes }, offset, limit });
		const pieces: Buffer[] = [];
		for (let offset = 0; offset < bytes.length; offset += 65536) {
			const result = await read({}, "owner", offset);
			validateRuntimeValue("httpRange", result);
			pieces.push(Buffer.from(String(result.contentBase64), "base64"));
		}
		expect(Buffer.concat(pieces)).toEqual(bytes);
		expect(await read({}, "owner", bytes.length)).toMatchObject({ contentBase64: "", nextOffset: null });
		await expect(read({}, "other")).rejects.toThrow("authorized");
		for (const change of [
			{ contentHash: `sha256:${unrelated.hash}` },
			{ attachmentIndex: 1 },
			{ name: "other.bin" },
			{ mediaType: "text/plain" },
			{ bytes: bytes.length + 1 },
			{ attemptId: "other-attempt" },
			{ sessionId: "other-session" },
			{ entryId: "other-entry" },
			{ revision: "other-lineage" },
		])
			await expect(read(change)).rejects.toMatchObject({
				code: expect.stringMatching(/stale_target|history_expired/),
			});
		await expect(read({ attachmentIndex: -1 })).rejects.toMatchObject({ code: "invalid_request" });
		await expect(read({}, "owner", 0, 65537)).rejects.toMatchObject({ code: "invalid_request" });
		await expect(read({}, "owner", bytes.length + 1)).rejects.toMatchObject({ code: "invalid_request" });
		await fs.promises.writeFile(saved.path, Buffer.from("truncated"));
		await expect(read()).rejects.toMatchObject({ code: "stale_target" });
		await fs.promises.unlink(saved.path);
		await expect(read()).rejects.toMatchObject({ code: "history_expired" });
		expect((await nativeHistoryAttachments(page, agent.agentInstanceRef, blobs)).get(message.id)![0]).toMatchObject({
			name: "report.bin",
			status: "unavailable",
			reason: "history_expired",
		});
		await (await blobs.publish(bytes)).release();
		// The completed Attempt keeps its immutable native cut; the edit is visible only at a newer cut.
		await transcript.rewrite([{ ...message, message: { role: "assistant", content: "not user owned" } }], []);
		expect(Buffer.from(String((await read()).contentBase64), "base64")).toEqual(bytes.subarray(0, 65536));
		const next = { ...target, attemptId: "next-attempt", executionId: "next-execution", bindingGeneration: 2 };
		await store.commitAttemptTransition(next, "running", [{ kind: "running" }]);
		const replaced = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 100, next.attemptId);
		expect(await nativeHistoryAttachments(replaced, agent.agentInstanceRef, blobs)).toEqual(new Map());
		await expect(
			read({ attemptId: next.attemptId, revision: replaced.lifecycleContext.lineage }),
		).rejects.toMatchObject({ code: "stale_target" });
	});

	it("serves image ranges only for the exact authorized retained content block, never for a bare blob hash", async () => {
		const store = await createStore();
		const blobs = new BlobStore(blobsDir());
		const bytes = Buffer.from(Array.from({ length: 130_017 }, (_, index) => index % 251));
		const saved = await blobs.publish(bytes);
		const unrelated = await blobs.publish(Buffer.from("not present in this history"));
		await unrelated.release();
		const agent = identity("image-resource");
		await store.registerAgent(agent);
		const header = {
			type: "session",
			version: 3,
			id: "image-session",
			timestamp: new Date(0).toISOString(),
			cwd: "/test",
		};
		const transcript = nativeTranscript(store, "image-resource", header);
		const target = { ...binding("image-resource"), sessionFile: transcript.sessionPath };
		const message = {
			type: "message",
			id: "image-entry",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "image-read",
				content: [
					{ type: "text", text: "image follows" },
					{ type: "image", mimeType: "image/png", data: `blob:sha256:${saved.hash}` },
				],
			},
		};
		await transcript.append([message]);
		// The applied record owns the managed body now; the producer pin is no longer needed.
		await saved.release();
		await store.commitAttemptTransition(target, "completed", [{ kind: "completed" }], {
			transcriptCheckpoint: transcript.checkpoint(message.id),
		});
		const page = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 100, target.attemptId);
		const descriptors = await nativeHistoryImages(page, agent.agentInstanceRef, blobs);
		const resource = descriptors.get("image-entry")![0].resource!;
		validateRuntimeValue("resourceReadRequest", { resource, offset: 0, limit: 65_536 });
		expect(resource).toMatchObject({ entryId: "image-entry", blockIndex: 1, bytes: bytes.length });
		expect(resource.revision).not.toBe(page.revision);
		expect(resource.revision).toBe(page.lifecycleContext.lineage);
		const read = (changes: Record<string, unknown> = {}, principalId = "owner", offset = 0, limit = 65_536) =>
			store.runtimeResource({ principalId, resource: { ...resource, ...changes }, offset, limit });
		const pieces: Buffer[] = [];
		for (let offset = 0; offset < bytes.length; offset += 65_536) {
			const result = await read({}, "owner", offset);
			validateRuntimeValue("httpRange", result);
			pieces.push(Buffer.from(String(result.contentBase64), "base64"));
		}
		expect(Buffer.concat(pieces)).toEqual(bytes);
		expect(await read({}, "owner", bytes.length)).toMatchObject({ contentBase64: "", nextOffset: null });
		await expect(read({}, "other")).rejects.toThrow("authorized");
		for (const change of [
			{ contentHash: `sha256:${unrelated.hash}` },
			{ blockIndex: 0 },
			{ mediaType: "image/jpeg" },
			{ bytes: bytes.length + 1 },
			{ attemptId: "other-attempt" },
			{ revision: "changed-lineage" },
		])
			await expect(read(change)).rejects.toMatchObject({ code: "stale_target" });
		await expect(read({ blockIndex: -1 })).rejects.toMatchObject({ code: "invalid_request" });
		await expect(read({ mediaType: "image/svg+xml" })).rejects.toMatchObject({ code: "invalid_request" });
		await expect(read({}, "owner", 0, 65_537)).rejects.toMatchObject({ code: "invalid_request" });
		await expect(read({}, "owner", bytes.length + 1)).rejects.toMatchObject({ code: "invalid_request" });
		await fs.promises.unlink(saved.path);
		await expect(read()).rejects.toMatchObject({ code: "history_expired" });
		expect((await nativeHistoryImages(page, agent.agentInstanceRef, blobs)).get("image-entry")).toEqual([
			{ entryId: "image-entry", blockIndex: 1, status: "unavailable", reason: "history_expired" },
		]);
		await (await blobs.publish(bytes)).release();
		// The completed Attempt keeps its immutable native cut; edits are visible only at a newer cut.
		await transcript.rewrite([{ ...message, message: { role: "user", content: "replaced" } }], []);
		expect(Buffer.from(String((await read()).contentBase64), "base64")).toEqual(bytes.subarray(0, 65_536));
		const next = { ...target, attemptId: "next-attempt", executionId: "next-execution", bindingGeneration: 2 };
		await store.commitAttemptTransition(next, "running", [{ kind: "running" }]);
		const current = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 100, next.attemptId);
		await expect(
			read({ attemptId: next.attemptId, revision: current.lifecycleContext.lineage }),
		).rejects.toMatchObject({ code: "stale_target" });
		await transcript.rewrite(
			[
				{
					...message,
					message: {
						...message.message,
						// The native writer moves every non-empty image body into a blob, so an undecodable
						// inline body is never retained; a data-less block remains.
						content: [
							{ type: "image", mimeType: "image/png" },
							{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" },
						],
					},
				},
			],
			[],
		);
		const unavailable = await nativeHistoryImages(
			await store.nativeHistoryPage(agent.agentInstanceId, undefined, 100, next.attemptId),
			agent.agentInstanceRef,
			blobs,
		);
		expect(unavailable.get("image-entry")).toEqual([
			{ entryId: "image-entry", blockIndex: 0, status: "unavailable", reason: "invalid_image" },
			{ entryId: "image-entry", blockIndex: 1, status: "unavailable", reason: "unsupported_format" },
		]);
	});

	it("keeps a retained Attempt history resource pinned across another binding and a store reopen", async () => {
		let store = await createStore();
		const agent = identity("retained-resource");
		await store.registerAgent(agent);
		const transcript = nativeTranscript(store, "retained-first", {
			type: "session",
			version: 3,
			id: "retained-session",
			timestamp: new Date(0).toISOString(),
			cwd: "/first",
		});
		const first = { ...binding("retained-resource"), sessionFile: transcript.sessionPath };
		const entry = {
			type: "message",
			id: "same-entry",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "assistant", content: "🙂я".repeat(100_000) },
		};
		await transcript.append([entry]);
		await store.commitAttemptTransition(first, "completed", [{ kind: "completed" }], {
			transcriptCheckpoint: transcript.checkpoint(entry.id),
		});
		const page = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 100, first.attemptId);
		const resource = {
			kind: "history_entry",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: first.attemptId,
			sessionId: page.sessionId,
			entryId: "same-entry",
			revision: page.lifecycleContext.lineage,
			bytes: Buffer.byteLength(JSON.stringify(entry)),
			mediaType: "application/json",
		};
		await transcript.append([
			{ ...entry, id: "later", parentId: "same-entry", message: { role: "user", content: "later" } },
		]);
		const nextTranscript = nativeTranscript(store, "retained-next", {
			type: "session",
			version: 3,
			id: "next-session",
			timestamp: new Date(0).toISOString(),
			cwd: "/next",
		});
		await nextTranscript.append([{ ...entry, message: { role: "assistant", content: "foreign body" } }]);
		const next = {
			...first,
			sessionFile: nextTranscript.sessionPath,
			attemptId: "next-attempt",
			executionId: "next-execution",
			bindingGeneration: 2,
			commandId: "next-start",
		};
		await store.commitAttemptTransition(next, "running", [{ kind: "running" }]);
		await store.close();
		store = reopen();
		const expected = Buffer.from(JSON.stringify(entry));
		for (let offset = 0; offset < expected.length; offset += 65_536) {
			const range = await store.runtimeResource({ principalId: "owner", resource, offset, limit: 65_536 });
			validateRuntimeValue("httpRange", range);
			expect(Buffer.from(String(range.contentBase64), "base64")).toEqual(expected.subarray(offset, offset + 65_536));
		}
		await expect(
			store.runtimeResource({
				principalId: "owner",
				resource: { ...resource, attemptId: next.attemptId },
				offset: 0,
				limit: 100,
			}),
		).rejects.toMatchObject({ code: "stale_target" });
		const pinned = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 100, first.attemptId);
		expect(pinned.anchor).toBe("same-entry");
		expect(pinned.entries).toEqual(page.entries);
		expect(pinned.lifecycleContext.lineage).toBe(page.lifecycleContext.lineage);
	}, 30_000);

	it("uses the retained native identity and preserves catalog continuation under a byte budget", async () => {
		const store = await createStore();
		const native = { ...identity("native"), agentInstanceId: "native-generated-id" };
		await store.registerAgent(native);
		expect(
			(await store.runtimeTarget({ agentInstanceRef: native.agentInstanceRef, principalId: "owner" }))
				.agentInstanceId,
		).toBe(native.agentInstanceId);
		for (let i = 0; i < 8; i++) await store.registerAgent(identity(`page-${i}`));
		const found = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" }, cursor, 100, 4096);
			for (const item of page.agents) {
				expect(found.has(String(item.agentInstanceRef))).toBe(false);
				found.add(String(item.agentInstanceRef));
			}
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(found.size).toBe(9);
	});

	it("keeps page summaries at the initial cut and refuses a continuation after current summaries advance", async () => {
		const store = await createStore();
		for (let i = 0; i < 8; i++) await store.registerAgent(identity(`cut-${i}`));
		const catalog = (cursor?: string) =>
			store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" }, cursor, 1);
		const first = await catalog();
		const second = await catalog(first.nextCursor!);
		expect(second.watermark).toBe(first.watermark);
		const later = identity("cut-7");
		await store.branchIntent(later.agentInstanceId, "hold-after-cut", "pause", 0);
		const current = await store.runtimeSummary({ agentInstanceRef: later.agentInstanceRef, principalId: "owner" });
		expect((current.summary as { attention: { held: boolean } }).attention.held).toBe(true);
		// A native owner cut cannot continue once it moved (L10): the reader restarts from a fresh cut.
		await expect(catalog(second.nextCursor!)).rejects.toMatchObject({ code: "stale_target" });
		const all: Array<Record<string, unknown>> = [];
		let cursor: string | undefined;
		let watermark: number | undefined;
		do {
			const page = await catalog(cursor);
			watermark ??= page.watermark;
			expect(page.watermark).toBe(watermark);
			all.push(...page.agents);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(watermark).toBeGreaterThan(first.watermark);
		expect(all).toHaveLength(8);
		expect(
			(all.find(row => row.agentInstanceRef === later.agentInstanceRef)!.attention as { held: boolean }).held,
		).toBe(true);
	});

	it("does not wake the app writer or materialize a token-only payload", async () => {
		const store = await createStore();
		const target = await active(store);
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		const text = "x".repeat(200_000);
		let resolved = false;
		const waiting = store
			.waitRuntimeEvents(eventsRequest(snapshot.epoch, snapshot.watermark, { kind: "catalog" }, 50))
			.then(value => {
				resolved = true;
				return value;
			});
		await store.appendEvent({
			...target,
			causationCommandId: target.commandId,
			kind: "assistant_snapshot",
			payload: { text },
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		const result = await waiting;
		expect(result.changes).toEqual([]);
		// Only cut metadata is read; the token payload is never materialized.
		expect(result.work.materializedBytes).toBeLessThan(4096);
		expect(result.work.scannedRows).toBeLessThan(20);
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).agents[0].revision).toBe(
			snapshot.agents[0].revision,
		);
	});

	it("keeps a quiet paused detail wait within its budget while an unobserved sibling streams", async () => {
		const store = await createStore();
		const root = identity("root");
		await store.registerAgent(root);
		for (const name of ["quiet", "noisy"]) {
			await store.registerAgent(identity(name, root.agentInstanceId));
			await store.commitAttemptTransition(binding(name), "running", [{ kind: "running" }]);
		}
		const quiet = binding("quiet"),
			noisy = binding("noisy");
		await store.branchIntent(quiet.agentInstanceId, "pause-quiet", "pause", 0);
		await store.commitAttemptTransition(quiet, "paused", [{ kind: "paused" }]);
		const scope: RuntimeScope = {
			kind: "branch",
			rootAgentInstanceRef: root.agentInstanceRef,
			interests: [
				{
					kind: "attempt",
					agentInstanceRef: identity("quiet").agentInstanceRef,
					attemptId: quiet.attemptId,
					kinds: ["state", "assistant", "queue", "input", "history", "tool", "usage"],
				},
			],
		};
		const snapshot = await store.runtimeSnapshot(scope, { principalId: "owner" });
		const read = store.runtimeEvents.bind(store);
		let reads = 0;
		store.runtimeEvents = async request => {
			reads++;
			return read(request);
		};
		let settled = false;
		const pending = store
			.waitRuntimeEvents({
				...eventsRequest(snapshot.epoch, snapshot.watermark, scope, 5000),
				remainingWork: { ...runtimeRemainingWork(), scannedRows: 64 },
			})
			.then(
				value => ({ value }),
				error => ({ error }),
			)
			.finally(() => {
				settled = true;
			});
		for (let revision = 1; revision <= 40; revision++) {
			await store.appendEvent({
				...noisy,
				causationCommandId: `noise-${revision}`,
				kind: "message_updated",
				payload: {
					mode: revision === 1 ? "snapshot" : "append",
					...(revision === 1 ? { partial: false } : { baseRevision: revision - 1 }),
					messageId: "noisy-message",
					blockId: "text",
					stream: "assistant",
					contentId: "noisy-content",
					revision,
					offset: (revision - 1) * 1024,
					endOffset: revision * 1024,
					totalBytes: revision * 1024,
					text: "x".repeat(1024),
					status: "streaming",
				},
			});
			await Bun.sleep(50);
		}
		expect(settled).toBe(false);
		expect(reads).toBe(1);
		// A refused batch for the observed Attempt commits nothing, so it wakes nobody.
		const refused = failWrites(store, puts =>
			puts.some(put => put.kind === "event" && (put.value as { kind?: string }).kind === "failed"),
		);
		try {
			await expect(
				store.commitAttemptTransition(quiet, "paused", [{ kind: "paused" }, { kind: "failed" }]),
			).rejects.toThrow("injected owner batch failure");
		} finally {
			refused.mockRestore();
		}
		expect(reads).toBe(1);
		expect(settled).toBe(false);
		await store.branchIntent(quiet.agentInstanceId, "resume-quiet", "resume", 1);
		const result = await pending;
		if ("error" in result) throw result.error;
		expect(result.value.changes.some(change => change.kind === "state")).toBe(true);
		expect(result.value.work.scannedRows).toBeLessThan(64);
		expect(reads).toBe(2);
		expect(result.value.changes.every(change => change.agentInstanceRef === identity("quiet").agentInstanceRef)).toBe(
			true,
		);
		store.runtimeEvents = read;
		// Branch membership still wakes with no selected child detail and no polling.
		const membership = store.waitRuntimeEvents(
			eventsRequest(snapshot.epoch, result.value.throughCursor, scope, 1000),
		);
		await store.registerAgent(identity("new-child", root.agentInstanceId));
		expect(
			(await membership).changes.some(
				change =>
					change.kind === "membership" && change.agentInstanceRef === identity("new-child").agentInstanceRef,
			),
		).toBe(true);
	}, 10000);

	it("seeks selected kinds and Attempts before the page limit while retaining AGI-level receipts and queue notices", async () => {
		const store = await createStore();
		const old = await active(store);
		const agent = identity("root");
		const before = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		async function stream(target: EngineBindingSnapshot) {
			for (let page = 0; page < 20; page++)
				await Promise.all(
					Array.from({ length: 50 }, (_, offset) =>
						store.appendEvent({
							...target,
							kind: "message_updated",
							causationCommandId: target.commandId,
							payload: {
								...(page === 0 && offset === 0
									? { mode: "snapshot", partial: false }
									: { mode: "append", baseRevision: page * 50 + offset }),
								messageId: `message-${target.attemptId}`,
								blockId: "text",
								stream: "assistant",
								contentId: `content-${target.attemptId}`,
								revision: page * 50 + offset + 1,
								offset: page * 50 + offset,
								endOffset: page * 50 + offset + 1,
								totalBytes: page * 50 + offset + 1,
								text: "x",
								status: "streaming",
							},
						}),
					),
				);
		}
		await stream(old);
		// An AGI-level receipt of the old Attempt: its command settles with that Attempt's frozen identity.
		const oldCommand = {
			...command("old-attempt-receipt", "steer"),
			attemptId: old.attemptId,
			executionId: old.executionId,
		};
		await store.admitCommand(oldCommand, 1);
		await store.commitAttemptTransition(old, "completed", [{ kind: "completed" }], {
			transcriptCheckpoint: await nativeCheckpoint(store),
		});
		const target = {
			...old,
			attemptId: "next-attempt",
			executionId: "next-execution",
			bindingId: "next-binding",
			commandId: "next-command",
			bindingGeneration: 2,
		};
		await store.commitAttemptTransition(target, "running", [{ kind: "running" }]);
		await stream(target);
		await store.startToolEffect(target, {
			effectId: "selected-effect",
			toolCallId: "selected-tool",
			toolName: "read",
			inputHash: "sha256:private",
			policy: "tracked",
		});
		const pause = await store.commitAttemptTransition(target, "paused", [{ kind: "paused" }]);
		await store.settleCommand(oldCommand.commandId, oldCommand.canonicalHash, { outcome: "applied" });
		const receipt = await store.runtimeCommand(oldCommand.commandId, { principalId: "owner" });
		await store.enqueueInboxItem(
			{ ...old, sessionId: "old-session" },
			{ sourceEventId: "old-queue", sourceType: "user", body: "queued" },
		);
		const scope: RuntimeScope = {
			kind: "attempt",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			kinds: ["state", "queue"],
		};
		const head = (await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).watermark;
		const request = {
			...eventsRequest(before.epoch, 0, scope),
			untilCursor: head,
			remainingWork: { ...runtimeRemainingWork(), scannedRows: 64 },
		};
		const batch = await store.runtimeEvents(request);
		expect(batch.throughCursor).toBe(head);
		expect(batch.hasMore).toBeFalse();
		expect(batch.work.scannedRows).toBeLessThan(32);
		expect(batch.changes.filter(change => change.kind === "state").map(change => change.value.state)).toEqual([
			"running",
			"paused",
		]);
		const receipts = batch.changes.filter(change => change.kind === "receipt").map(change => change.value);
		expect(receipts.map(value => value.stage)).toEqual(["engine_accepted", "applied"]);
		for (const value of receipts)
			expect(value).toMatchObject({
				commandId: oldCommand.commandId,
				target: {
					agentInstanceRef: agent.agentInstanceRef,
					attemptId: old.attemptId,
					executionId: old.executionId,
				},
			});
		expect(receipts.at(-1)).toMatchObject({
			stage: receipt.stage,
			lookup: receipt.lookup,
			dedupUntil: receipt.dedupUntil,
		});
		expect(
			batch.changes.some(change => change.kind === "invalidate" && change.value.resource === "queue"),
		).toBeTrue();
		expect(
			batch.changes
				.filter(change => change.kind === "state")
				.every(change => (change.value.tools as unknown[]).length === 0),
		).toBeTrue();
		const fullScope: RuntimeScope = {
			...scope,
			kinds: ["assistant", "tool", "state", "queue", "input", "history", "usage"],
		};
		const full = await store.runtimeEvents(eventsRequest(before.epoch, pause[0].eventId - 1, fullScope));
		expect(full.changes.find(change => change.kind === "state")?.value.tools).toMatchObject([
			{ toolCallId: "selected-tool" },
		]);
		const other = await active(store, "other");
		for (const attemptId of ["missing-attempt", other.attemptId]) {
			const failure = await store.runtimeEvents({ ...request, scope: { ...scope, attemptId } }).then(
				() => undefined,
				error => error,
			);
			expect(failure).toMatchObject({ code: "stale_target" });
		}
	}, 60_000);

	it("filters selected Attempts before decoding detail and honors a fixed replay head", async () => {
		const store = await createStore();
		const root = identity("root");
		const target = await active(store);
		await store.registerAgent(identity("child", root.agentInstanceId));
		await store.commitAttemptTransition(binding("child"), "running", [{ kind: "running" }]);
		const scope: RuntimeScope = {
			kind: "branch",
			rootAgentInstanceRef: root.agentInstanceRef,
			interests: [
				{ kind: "attempt", agentInstanceRef: root.agentInstanceRef, attemptId: target.attemptId, kinds: ["state"] },
			],
		};
		const snapshot = await store.runtimeSnapshot(scope, { principalId: "owner" });
		expect(snapshot.members).toHaveLength(2);
		expect(snapshot.agents).toHaveLength(1);
		await store.commitAttemptTransition(target, "paused", [{ kind: "paused" }]);
		const head = (await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).watermark;
		await store.commitAttemptTransition(binding("child"), "failed", [
			{ kind: "failed", payload: { error: "heavy".repeat(20_000) } },
		]);
		const batch = await store.runtimeEvents({
			...eventsRequest(snapshot.epoch, snapshot.watermark, scope),
			untilCursor: head,
		});
		expect(batch.headCursor).toBe(head);
		expect(batch.throughCursor).toBe(head);
		expect(batch.changes.map(change => change.agentInstanceRef)).toEqual([root.agentInstanceRef]);
		expect(batch.work.materializedBytes).toBeLessThan(10_000);
		await expect(
			store.runtimeEvents({
				...eventsRequest(snapshot.epoch, 0, scope),
				remainingWork: { ...runtimeRemainingWork(), scannedRows: 1 },
			}),
		).rejects.toThrow("budget");
	});

	it("retains active UTF-8 message bytes and reopens an immutable version with bounded work", async () => {
		const store = await createStore();
		const target = await active(store);
		let offset = 0;
		let revision = 0;
		let expected = "";
		for (let i = 0; i < 100; i++) {
			const text = "🙂я".repeat(100);
			const bytes = Buffer.byteLength(text);
			const base = revision++;
			await store.appendEvent({
				...target,
				causationCommandId: target.commandId,
				kind: "message_updated",
				payload: {
					mode: base ? "append" : "snapshot",
					messageId: "message",
					blockId: "block",
					stream: "assistant",
					contentId: "content",
					revision,
					offset,
					endOffset: offset + bytes,
					totalBytes: offset + bytes,
					text,
					status: "streaming",
					...(base ? { baseRevision: base } : { partial: false }),
				},
			});
			offset += bytes;
			expected += text;
		}
		const page = await store.runtimeMessages({
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
			principalId: "owner",
		});
		const baseline = (page.items as Array<Record<string, unknown>>)[0];
		expect(baseline.partial).toBe(true);
		expect(baseline.totalBytes).toBe(Buffer.byteLength(expected));
		expect((page.work as { scannedRows: number }).scannedRows).toBeLessThan(10);
		const resource = baseline.resource as Record<string, unknown>;
		let position = 0;
		const chunks: Buffer[] = [];
		while (position < offset) {
			const range = await store.runtimeResource({ principalId: "owner", resource, offset: position, limit: 8192 });
			const chunk = Buffer.from(String(range.contentBase64), "base64");
			new TextDecoder("utf-8", { fatal: true }).decode(chunk);
			chunks.push(chunk);
			position = range.nextOffset === null ? offset : Number(range.nextOffset);
		}
		expect(Buffer.concat(chunks).toString("utf8")).toBe(expected);
		await expect(store.runtimeResource({ principalId: "other", resource, offset: 0, limit: 4096 })).rejects.toThrow(
			"authorized",
		);
	});

	it("fences input response by its exact metadata revision after newer unrelated inputs", async () => {
		const store = await createStore();
		const target = await active(store);
		const inputs = [];
		for (let n = 0; n < 40; n++) {
			const inputId = `metadata-input-${n}`;
			const [event] = await store.commitAttemptTransition(target, "waiting_input", [
				{
					kind: "input_requested",
					payload: { inputId, questions: [{ id: "q", question: "Choose", options: [{ label: "Yes" }] }] },
				},
			]);
			inputs.push({ inputId, revision: event.eventId });
		}
		const first = inputs[0];
		const resolve = (inputId: string, inputRevision: number) =>
			store.commitAttemptTransition(target, "running", [{ kind: "input_resolved", payload: { inputId } }], {
				expectedStates: ["waiting_input"],
				intentGuard: { expectedRevision: 0, requireUnheld: true, inputId, inputRevision },
			});
		for (const [inputId, revision] of [
			[first.inputId, inputs.at(-1)!.revision],
			["missing-input", first.revision],
		] as const) {
			const rejected = await resolve(inputId, revision).then(
				() => undefined,
				error => error,
			);
			expect(rejected).toMatchObject({ code: "stale_target" });
			expect((await store.getAttempt(target.attemptId))?.state).toBe("waiting_input");
		}
		await resolve(first.inputId, first.revision);
		expect((await store.getAttempt(target.attemptId))?.state).toBe("running");
		const pending = await store.runtimeInput({
			principalId: "owner",
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
		});
		expect((pending.items as unknown[]).length).toBe(39);
	});

	it("reads oversized input through an exact retained resource without losing controls", async () => {
		const store = await createStore();
		const target = await active(store);
		const questions = Array.from({ length: 32 }, (_, i) => ({
			id: `q-${i}`,
			question: "Вопрос".repeat(100),
			multi: true,
			options: Array.from({ length: 32 }, (_, n) => ({
				label: `${n}:${"я".repeat(2000)}`,
				description: "д".repeat(4000),
			})),
		}));
		const events = await store.commitAttemptTransition(target, "waiting_input", [
			{ kind: "input_requested", payload: { inputId: "input", questions } },
		]);
		const request = {
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
			principalId: "owner",
		};
		const input = await store.runtimeInput({ ...request, inputId: "input", revision: events[0].eventId });
		expect(input.partial).toBe(true);
		expect((input.input as { questions: unknown[] }).questions).toHaveLength(32);
		expect(Buffer.byteLength(JSON.stringify(input.input))).toBeLessThanOrEqual(runtimeLimits.inputPreviewBytes);
		const range = await store.runtimeResource({
			principalId: "owner",
			resource: input.resource as Record<string, unknown>,
			offset: 0,
			limit: 65536,
		});
		expect(Buffer.from(String(range.contentBase64), "base64").length).toBe(65536);
		await expect(
			store.runtimeInput({ ...request, inputId: "input", revision: events[0].eventId + 1 }),
		).rejects.toThrow("revision");
	});

	it("pins a child wait to the launch command and retained Attempt across later executions", async () => {
		const store = await createStore();
		const first = await active(store);
		const firstResult = { assistantFinal: "first result", transcriptRef: "history://first" };
		await store.commitAttemptTransition(first, "completed", [{ kind: "completed" }], {
			terminalResult: firstResult,
			transcriptCheckpoint: await nativeCheckpoint(store),
		});
		const later = {
			...first,
			commandId: "later-command",
			attemptId: "later-attempt",
			executionId: "later-execution",
			bindingGeneration: 2,
		};
		await store.commitAttemptTransition(later, "completed", [{ kind: "completed" }], {
			terminalResult: { assistantFinal: "later result" },
			transcriptCheckpoint: await nativeCheckpoint(store),
		});
		expect(await store.waitAttemptResult(first.agentInstanceId, first.commandId, first.attemptId)).toEqual({
			attemptId: first.attemptId,
			state: "completed",
			payload: firstResult,
		});
		await expect(
			store.waitAttemptResult(first.agentInstanceId, "unrelated-command", first.attemptId),
		).rejects.toThrow("another launch");
		await expect(store.waitAttemptResult(first.agentInstanceId, first.commandId, later.attemptId)).rejects.toThrow(
			"another launch",
		);
	});

	it("does not lose cancellation while the initial child state read is pending", async () => {
		const store = await createStore();
		const controller = new AbortController();
		const pending = store.waitAttemptResult(
			identity("root").agentInstanceId,
			"not-yet-admitted",
			undefined,
			controller.signal,
		);
		queueMicrotask(() => controller.abort(new Error("parent cancelled")));
		await expect(pending).rejects.toThrow("parent cancelled");
	});
});
