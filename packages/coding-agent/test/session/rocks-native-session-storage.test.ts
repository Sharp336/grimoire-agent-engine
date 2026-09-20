import { expect, it } from "bun:test";
import type { NativeSessionCheckpoint } from "../../src/session/native-session-storage";
import { RocksNativeSessionStorage } from "../../src/session/rocks-native-session-storage";
import { SessionManager } from "../../src/session/session-manager";
import { StorageClient } from "../../src/session/storage-client";
import {
	STORAGE_PROTOCOL_SCHEMA_HASH,
	type StorageBarrier,
	type StorageBarrierSuccessResponse,
	type StorageEntry,
	type StorageProtocolRequest,
	type StorageReceipt,
	type StorageWrite,
} from "../../src/session/storage-protocol";

class DelayedStorageClient extends StorageClient {
	readonly writes: Array<{
		input: Omit<StorageWrite, "requestId" | "payloadHash" | "incarnation">;
		resolve(receipt: StorageReceipt): void;
		reject(error: Error): void;
	}> = [];
	readonly barriers: number[] = [];
	constructor() {
		super({
			url: "http://127.0.0.1:1",
			token: "0123456789012345",
			incarnation: 1,
			protocolHash: STORAGE_PROTOCOL_SCHEMA_HASH,
		});
	}
	override write(input: Omit<StorageWrite, "requestId" | "payloadHash" | "incarnation">): Promise<StorageReceipt> {
		const { promise, resolve, reject } = Promise.withResolvers<StorageReceipt>();
		this.writes.push({ input, resolve, reject });
		return promise;
	}
	async apply(index: number): Promise<void> {
		const { input, resolve } = this.writes[index];
		resolve({
			...input,
			payloadHash: "sha256:test",
			incarnation: 1,
			throughSeq: input.firstSeq + Math.max(1, input.entries.length) - 1,
			admissionState: "admitted",
			appliedState: "applied",
			durabilityState: "not_required",
			outcome: "success",
		});
		await Bun.sleep(0);
	}
	override async barrier(
		input: Omit<StorageBarrier, "requestId" | "incarnation">,
	): Promise<StorageBarrierSuccessResponse> {
		this.barriers.push(input.throughSeq);
		return {
			...input,
			schema: "artel.storage.protocol.response.v1",
			version: "1.0",
			requestId: "barrier",
			incarnation: 1,
			durableThroughSeq: input.throughSeq,
		};
	}
}

it("keeps ordinary appends in prefix order and flushes only after every buffered write applies", async () => {
	const client = new DelayedStorageClient();
	const manager = SessionManager.createNative("/ordered", new RocksNativeSessionStorage(client, "ordered", "root"));
	for (let index = 0; index < 11; index++)
		manager.appendMessage({ role: "user", content: String(index), timestamp: index });
	let flushed = false;
	const flush = manager.flushAndCheckpoint().then(checkpoint => {
		flushed = true;
		return checkpoint;
	});
	for (let index = 0; index < 11; index++) {
		expect(client.writes).toHaveLength(index + 1);
		expect(client.writes[index].input.firstSeq).toBe(index + 1);
		expect(client.writes[index].input.durability).toBe("buffered");
		expect(flushed).toBe(false);
		expect(client.barriers).toEqual([]);
		await client.apply(index);
	}
	expect((await flush).native?.throughSeq).toBe(11);
	expect(client.barriers).toEqual([11]);
});

it("rejects bounded append admission without leaving the rejected entry in the manager", async () => {
	const client = new DelayedStorageClient();
	const storage = new RocksNativeSessionStorage(client, "bounded", "root", { maxPendingWrites: 2 });
	const manager = SessionManager.createNative("/bounded", storage);
	for (let index = 0; index < 2; index++)
		manager.appendMessage({ role: "user", content: String(index), timestamp: index });
	expect(() => manager.appendMessage({ role: "user", content: "rejected", timestamp: 2 })).toThrow("admission budget");
	expect(manager.getContextBranch()).toHaveLength(2);
	await expect(manager.flush()).rejects.toThrow("admission budget");
	await client.apply(0);
	await client.apply(1);
	expect(client.writes.map(write => write.input.firstSeq)).toEqual([1, 2]);
	const checkpoint = client.writes[1].input.state?.native as NativeSessionCheckpoint;
	const next = storage.append([], checkpoint, "buffered");
	expect(next.position.throughSeq).toBe(3);
	await client.apply(2);
	await next.completion;
	const byteClient = new DelayedStorageClient();
	const byteManager = SessionManager.createNative(
		"/bytes",
		new RocksNativeSessionStorage(byteClient, "bytes", "root", { maxPendingBytes: 1 }),
	);
	expect(() => byteManager.appendMessage({ role: "user", content: "界", timestamp: 1 })).toThrow(
		"byte admission budget",
	);
	expect(byteManager.getContextBranch()).toEqual([]);
	expect(byteClient.writes).toEqual([]);
});

it("rejects flush and queued successors when an earlier native prefix fails", async () => {
	const client = new DelayedStorageClient();
	const manager = SessionManager.createNative("/failed", new RocksNativeSessionStorage(client, "failed", "root"));
	for (let index = 0; index < 3; index++)
		manager.appendMessage({ role: "user", content: String(index), timestamp: index });
	const flush = manager.flushAndCheckpoint();
	void flush.catch(() => {});
	client.writes[0].reject(new Error("prefix failed"));
	await expect(flush).rejects.toThrow("prefix failed");
	expect(client.writes).toHaveLength(1);
	expect(client.barriers).toEqual([]);
	expect(() => manager.appendMessage({ role: "user", content: "later", timestamp: 4 })).toThrow("prefix failed");
});

it("persists structured native checkpoints through the shared HTTP client and reads frozen bounded context/children", async () => {
	let latest: StorageWrite;
	let seq = 0;
	let entries: StorageEntry[] = [];
	const writes: StorageWrite[] = [];
	const operations: string[] = [];
	const readIds: string[] = [];
	const cuts: (number | undefined)[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as StorageProtocolRequest;
			operations.push(body.operation);
			const response = (requestId: string, fields: object) =>
				Response.json({
					schema: "artel.storage.protocol.response.v1",
					version: "1.0",
					requestId,
					incarnation: 1,
					...fields,
				});
			if (body.operation === "write") {
				latest = body.write;
				writes.push(latest);
				if (latest.head?.lineage) seq = 0;
				expect(latest.firstSeq).toBe(seq + 1);
				if (latest.nativeEdits) expect(latest.expectedThroughSeq).toBe(seq);
				for (const edit of latest.nativeEdits ?? []) {
					entries = entries.filter(entry => entry.entryId !== edit.entryId);
					if (edit.entry) entries.push(edit.entry);
				}
				entries.push(...latest.entries);
				seq += Math.max(1, latest.entries.length);
				return response(latest.requestId, {
					receipt: {
						...latest,
						throughSeq: seq,
						admissionState: "admitted",
						appliedState: "applied",
						durabilityState: "durable",
						outcome: "success",
					},
				});
			}
			if (body.operation === "barrier")
				return response(body.barrier.requestId, { ...body.barrier, durableThroughSeq: seq });
			if (body.operation !== "read_context" && body.operation !== "read_children")
				throw new Error(`Unexpected archive request ${body.operation}`);
			const read = body.read;
			cuts.push(read.cutSeq);
			expect(read.maxRecords).toBe(1);
			expect(read.maxBytes).toBe(4096);
			const result: StorageEntry[] = [];
			if (body.operation === "read_children") {
				if (read.cursor) result.push(...entries.filter(entry => entry.parentId === read.parentId));
			} else {
				let id = latest.head?.leafId;
				while (id) {
					const entry = entries.find(entry => entry.entryId === id)!;
					result.push(entry);
					if (id === latest.head?.contextAnchors?.startEntryId) break;
					id = entry.parentId;
				}
			}
			const offset = body.operation === "read_context" ? Number(read.cursor ?? 0) : 0;
			const events = result.slice(offset, offset + 1);
			readIds.push(...events.map(entry => entry.entryId));
			return response(read.requestId, {
				familyId: "f",
				generationId: "g",
				throughSeq: read.cutSeq ?? seq,
				durableThroughSeq: seq,
				liveThroughSeq: seq,
				head: latest.head,
				state: latest.state,
				events,
				nextCursor:
					body.operation === "read_children" && !read.cursor
						? "children-next"
						: offset + 1 < result.length
							? String(offset + 1)
							: null,
			});
		},
	});
	try {
		const client = new StorageClient({
			url: `http://127.0.0.1:${server.port}`,
			token: "0123456789012345",
			incarnation: 1,
			protocolHash: STORAGE_PROTOCOL_SCHEMA_HASH,
		});
		const storage = new RocksNativeSessionStorage(client, "f", "g", { maxRecords: 1, maxBytes: 4096 });
		const manager = SessionManager.createNative("/native", storage);
		let archived = "";
		let kept = "";
		await manager.appendEntriesAtomically(() => {
			manager.appendModelChange("openai/model");
			archived = manager.appendMessage({ role: "user", content: "archive", timestamp: 1 });
			kept = manager.appendMessage({ role: "user", content: "keep", timestamp: 2 });
			manager.appendCompaction("summary", undefined, kept, 100);
		});
		const checkpoint = await manager.flushAndCheckpoint();
		const cold = await SessionManager.openNative(storage);
		expect(cold.buildSessionContext()).toEqual(manager.buildSessionContext());
		expect(readIds).not.toContain(archived);
		expect(cuts.slice(0, 2)).toEqual([undefined, checkpoint.native!.throughSeq]);
		expect(await storage.readChildren(kept, checkpoint.native!)).toHaveLength(1);
		expect(operations.filter(value => value === "read_children")).toHaveLength(2);
		const entry = cold.getEntry(kept)!;
		if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Expected retained user message");
		entry.message.content = "changed";
		await cold.rewriteEntries();
		expect(writes.at(-1)?.entries).toEqual([]);
		expect(writes.at(-1)?.nativeEdits?.[0].entryId).toBe(kept);
		expect(writes.at(-1)?.expectedThroughSeq).toBe(checkpoint.native!.throughSeq);
		expect((await SessionManager.openNative(storage)).buildSessionContext()).toEqual(cold.buildSessionContext());
		expect(client.pending).toEqual({ write: 0, read: 0, control: 0, writeBytes: 0 });
		const current = await storage.readContext();
		const target = new RocksNativeSessionStorage(client, "f", "fork");
		await target.initializeFork(current.position, current.checkpoint).completion;
		expect(writes.at(-1)?.entries).toEqual([]);
		expect(writes.at(-1)?.head?.lineage).toEqual({
			parentGenerationId: "g",
			forkCutSeq: current.throughSeq,
			forkLeafId: current.checkpoint.leafId,
		});
		expect(writes.at(-1)?.dependencies).toEqual([
			{ familyId: "f", generationId: "g", throughSeq: current.throughSeq },
		]);
	} finally {
		await server.stop(true);
	}
});
