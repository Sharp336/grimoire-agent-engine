import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { BlobStore, parseBlobRef } from "../../src/session/blob-store";
import {
	type NativeSessionCheckpoint,
	NativeSessionWriteRejectedError,
} from "../../src/session/native-session-storage";
import {
	NATIVE_ENTRY_BLOB_GC_GUARD_FILE,
	RocksNativeSessionStorage,
} from "../../src/session/rocks-native-session-storage";
import { SessionManager } from "../../src/session/session-manager";
import { StorageClient, StorageClientError } from "../../src/session/storage-client";
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

it.each([
	{ edit: true, code: "sequence_gap", message: "write does not follow accepted prefix", rollback: true },
	{ edit: true, code: "sequence_gap", message: "apply predecessor missing", rollback: false },
	{ edit: true, code: "outcome_unknown", message: "response lost", rollback: false },
	{ edit: false, code: "sequence_gap", message: "write does not follow accepted prefix", rollback: false },
] as const)(
	"rolls back only proven conditional pre-admission rejection: %j",
	async ({ edit, code, message, rollback }) => {
		const client = new DelayedStorageClient();
		const manager = SessionManager.createNative(
			"/rejected",
			new RocksNativeSessionStorage(client, "rejected", "root"),
		);
		const id = manager.appendMessage({ role: "user", content: "accepted", timestamp: 1 });
		await client.apply(0);
		const entry = manager.getEntry(id);
		if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("Expected user entry");
		if (edit) entry.message.content = "unconfirmed";
		else manager.appendMessage({ role: "user", content: "unconfirmed", timestamp: 2 });
		const completion = (edit ? manager.rewriteEntries() : manager.flush()).catch(error => error);
		await Bun.sleep(0);
		const error = new StorageClientError(code, message);
		client.writes[1].reject(error);
		const observed: unknown = await completion;
		if (rollback) expect(observed).toBeInstanceOf(NativeSessionWriteRejectedError);
		else expect(observed).toBe(error);
		if (edit) {
			const restored = manager.getEntry(id);
			if (restored?.type !== "message" || restored.message.role !== "user") throw new Error("Expected user entry");
			expect(restored.message.content).toBe(rollback ? "accepted" : "unconfirmed");
		} else expect(manager.getContextBranch()).toHaveLength(2);
	},
);

it("persists oversized native text, image, tool, and signed payloads exactly through bounded blobs", async () => {
	using tempDir = TempDir.createSync("@omp-native-entry-blobs-");
	const blobs = new BlobStore(path.join(tempDir.path(), "blobs"));
	const stored: StorageEntry[] = [];
	const writes: StorageWrite[] = [];
	const wireBytes: number[] = [];
	let latest: StorageWrite | undefined;
	let seq = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const raw = await request.text();
			wireBytes.push(Buffer.byteLength(raw));
			const body = JSON.parse(raw) as StorageProtocolRequest;
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
				writes.push(body.write);
				stored.push(...body.write.entries);
				seq += Math.max(1, body.write.entries.length);
				return response(body.write.requestId, {
					receipt: {
						...body.write,
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
			if (body.operation !== "read_context") throw new Error(`Unexpected operation ${body.operation}`);
			const offset = Number(body.read.cursor ?? 0);
			const result = stored.toReversed();
			const events = result.slice(offset, offset + body.read.maxRecords);
			return response(body.read.requestId, {
				familyId: body.read.familyId,
				generationId: body.read.generationId,
				throughSeq: body.read.cutSeq ?? seq,
				durableThroughSeq: seq,
				liveThroughSeq: seq,
				head: latest?.head,
				state: latest?.state,
				events,
				nextCursor: offset + events.length < result.length ? String(offset + events.length) : null,
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
		const storage = new RocksNativeSessionStorage(client, "large", "root", {}, blobs);
		const manager = SessionManager.createNative("/large-native", storage);
		const largeText = `leading\u0000${"界-text-".repeat(45_000)}trailing`;
		const imageData = Buffer.from(Uint8Array.from({ length: 230_000 }, (_, index) => (index * 31) & 0xff)).toString(
			"base64",
		);
		const toolPayload = `tool:${'{\\"nested\\":true}|'.repeat(18_000)}`;
		const opaqueSignature = `sig:${'\\u0000|\\"|\\\\|Ж|'.repeat(24_000)}:end`;
		const textMessage: UserMessage = { role: "user", content: largeText, timestamp: 1 };
		const imageMessage: UserMessage = {
			role: "user",
			content: [{ type: "image", data: imageData, mimeType: "image/png", detail: "original" }],
			timestamp: 2,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "retain exact signed reasoning", thinkingSignature: opaqueSignature },
				{ type: "toolCall", id: "large-tool", name: "write", arguments: { payload: toolPayload } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 3,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "large-tool",
			toolName: "write",
			content: [{ type: "text", text: `result:${"tool-output|".repeat(24_000)}` }],
			isError: false,
			timestamp: 4,
		};
		const ids: string[] = [];
		const pressureIds: string[] = [];
		await manager.appendEntriesAtomically(() => {
			ids.push(manager.appendMessage(textMessage));
			ids.push(manager.appendMessage(imageMessage));
			ids.push(manager.appendMessage(assistant));
			ids.push(manager.appendMessage(toolResult));
			for (let index = 0; index < 9; index++)
				pressureIds.push(
					manager.appendMessage({
						role: "user",
						content: `${index}:${"request-pressure|".repeat(7_500)}`,
						timestamp: 5 + index,
					}),
				);
		});
		const expected = structuredClone(manager.getWorkingEntries());
		await manager.flushAndCheckpoint();

		expect(writes).toHaveLength(1);
		expect(await Bun.file(path.join(blobs.dir, NATIVE_ENTRY_BLOB_GC_GUARD_FILE)).json()).toEqual({
			schema: "omp.native.entry.blob.gc-guard.v1",
		});
		expect(wireBytes.every(bytes => bytes < 1024 * 1024)).toBe(true);
		expect(stored).toHaveLength(expected.length);
		const byId = new Map(stored.map(entry => [entry.entryId, entry]));
		for (const id of ids) expect(byId.get(id)?.payload).toMatchObject({ schema: "omp.native.entry.blob.v1" });
		expect(pressureIds.some(id => byId.get(id)?.payload.schema === "omp.native.entry.blob.v1")).toBe(true);
		const refs = stored
			.filter(entry => entry.payload.schema === "omp.native.entry.blob.v1")
			.map(entry => String(entry.payload.ref));
		const hashes = refs.map(ref => parseBlobRef(ref));
		expect(hashes.every(Boolean)).toBe(true);
		expect(new Set(hashes).size).toBe(hashes.length);

		const cold = await SessionManager.openNative(new RocksNativeSessionStorage(client, "large", "root", {}, blobs));
		expect(cold.getWorkingEntries()).toEqual(expected);
		const signed = cold.getEntry(ids[2]);
		if (signed?.type !== "message" || signed.message.role !== "assistant")
			throw new Error("Expected restored assistant entry");
		expect(signed.message.content[0]).toEqual({
			type: "thinking",
			thinking: "retain exact signed reasoning",
			thinkingSignature: opaqueSignature,
		});

		const hash = hashes[0]!;
		const blobPath = path.join(blobs.dir, hash);
		const original = await fs.readFile(blobPath);
		await fs.unlink(blobPath);
		await expect(new RocksNativeSessionStorage(client, "large", "root", {}, blobs).readContext()).rejects.toThrow(
			/blob.*missing/i,
		);
		await blobs.restore(hash, original);
		await fs.writeFile(blobPath, Buffer.alloc(original.byteLength, 0x5a));
		await expect(new RocksNativeSessionStorage(client, "large", "root", {}, blobs).readContext()).rejects.toThrow(
			/blob.*hash/i,
		);
	} finally {
		await server.stop(true);
	}
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
			if (body.operation !== "read_context" && body.operation !== "read_children" && body.operation !== "read_range")
				throw new Error(`Unexpected archive request ${body.operation}`);
			const read = body.read;
			cuts.push(read.cutSeq);
			expect(read.maxRecords).toBe(1);
			expect(read.maxBytes).toBe(4096);
			const result: StorageEntry[] = [];
			if (body.operation === "read_children") {
				if (read.cursor) result.push(...entries.filter(entry => entry.parentId === read.parentId));
			} else if (body.operation === "read_range") {
				result.push(...entries.toReversed());
			} else {
				let id = latest.head?.leafId;
				while (id) {
					const entry = entries.find(entry => entry.entryId === id)!;
					result.push(entry);
					if (id === latest.head?.contextAnchors?.startEntryId) break;
					id = entry.parentId;
				}
			}
			const offset = body.operation === "read_children" ? 0 : Number(read.cursor ?? 0);
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
			manager.appendLabelChange(archived, "first");
			manager.appendLabelChange(archived, "second");
			manager.appendLabelChange(archived, undefined);
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
		await cold.materializeHistory();
		expect(cold.getEntries().map(candidate => candidate.id)).toEqual(entries.map(candidate => candidate.entryId));
		expect(cold.getLabel(archived)).toBeUndefined();
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
