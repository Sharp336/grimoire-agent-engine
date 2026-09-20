import { expect, it } from "bun:test";
import { RocksNativeSessionStorage } from "../../src/session/rocks-native-session-storage";
import { SessionManager } from "../../src/session/session-manager";
import { StorageClient } from "../../src/session/storage-client";
import {
	STORAGE_PROTOCOL_SCHEMA_HASH,
	type StorageEntry,
	type StorageProtocolRequest,
	type StorageWrite,
} from "../../src/session/storage-protocol";

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
	} finally {
		await server.stop(true);
	}
});
