import { expect, it } from "bun:test";
import { RuntimeRecords } from "../../src/engine/runtime-records";
import { StorageClient, storageCanonicalJson } from "../../src/session/storage-client";
import { STORAGE_PROTOCOL_SCHEMA_HASH, type StorageWrite } from "../../src/session/storage-protocol";

interface TestRequest {
	operation: string;
	write: StorageWrite;
	receipt: { requestId: string };
	read: { requestId: string; familyId: string; generationId: string };
	query: {
		requestId: string;
		selector: { type: "records"; keys: Array<{ kind: "metadata"; id: string }> };
	};
}

const input = {
	operationId: "op-one",
	familyId: "family",
	generationId: "generation",
	firstSeq: 1,
	entries: [{ entryId: "entry", parentId: null, kind: "message", payload: { text: "hello" } }],
	durability: "required" as const,
	dependencies: [],
};
function envelope(requestId: string, fields: object, incarnation = 1) {
	return Response.json({
		schema: "artel.storage.protocol.response.v1",
		version: "1.0",
		requestId,
		incarnation,
		...fields,
	});
}
function receipt(write: StorageWrite) {
	return {
		...write,
		throughSeq: 1,
		admissionState: "admitted",
		appliedState: "applied",
		durabilityState: "durable",
		outcome: "success",
	};
}
function binding(port: number) {
	return {
		url: `http://127.0.0.1:${port}`,
		token: "0123456789012345",
		incarnation: 1,
		protocolHash: STORAGE_PROTOCOL_SCHEMA_HASH,
	};
}

it("recovers the original durable receipt after a lost write response, without sending the write twice", async () => {
	let admitted: StorageWrite | undefined;
	let writes = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as TestRequest;
			if (body.operation === "write") {
				writes++;
				admitted = body.write;
				return new Response(null, { status: 408 });
			}
			return envelope(body.receipt.requestId, { receipt: receipt(admitted!) });
		},
	});
	try {
		const client = new StorageClient(binding(server.port!), { deadlineMs: 500 });
		expect((await client.write(input)).durabilityState).toBe("durable");
		expect(writes).toBe(1);
		expect(client.pending.write).toBe(0);
	} finally {
		await server.stop(true);
	}
});

it("rejects overflow synchronously while retaining separate read and required-control lanes", async () => {
	const gate = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as TestRequest;
			if (body.operation === "write") {
				if (body.write.durability === "buffered") await gate.promise;
				return envelope(body.write.requestId, { receipt: receipt(body.write) });
			}
			return envelope(body.read.requestId, {
				familyId: "family",
				generationId: "generation",
				throughSeq: 0,
				durableThroughSeq: 0,
				liveThroughSeq: 0,
				events: [],
				nextCursor: null,
			});
		},
	});
	try {
		const client = new StorageClient(binding(server.port!), { writeRequests: 1 });
		const first = client.write({ ...input, durability: "buffered" });
		expect(() => client.write({ ...input, operationId: "op-two" })).toThrow("admission budget");
		expect(
			(await client.readRange({ familyId: "family", generationId: "generation", maxRecords: 1, maxBytes: 1024 }))
				.events,
		).toEqual([]);
		expect((await client.write({ ...input, familyId: "control", operationId: "terminal" }, true)).outcome).toBe(
			"success",
		);
		gate.resolve();
		await first;
		expect(client.pending.writeBytes).toBe(0);
	} finally {
		gate.resolve();
		await server.stop(true);
	}
});

it("keeps buffered runtime mutations on reserved control reads when observer reads fill their lane", async () => {
	const observerStarted = Promise.withResolvers<void>();
	const releaseObserver = Promise.withResolvers<void>();
	const controlStarted = Promise.withResolvers<void>();
	const releaseControl = Promise.withResolvers<void>();
	let observer: Promise<unknown> | undefined;
	let control: Promise<unknown> | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as TestRequest;
			if (body.operation === "runtime_query") {
				const keys = body.query.selector.keys;
				if (keys.some(key => key.id === "observer")) {
					observerStarted.resolve();
					await releaseObserver.promise;
				} else if (keys.some(key => key.id === "control")) {
					controlStarted.resolve();
					await releaseControl.promise;
				}
				return envelope(body.query.requestId, {
					records: keys.map(key => ({ ...key, revision: null, value: null })),
					nextCursor: null,
				});
			}
			if (body.operation === "read_range") {
				return envelope(body.read.requestId, {
					familyId: body.read.familyId,
					generationId: body.read.generationId,
					throughSeq: 0,
					durableThroughSeq: 0,
					liveThroughSeq: 0,
					events: [],
					nextCursor: null,
				});
			}
			return envelope(body.write.requestId, { receipt: receipt(body.write) });
		},
	});
	try {
		const client = new StorageClient(binding(server.port!), { readRequests: 1, controlRequests: 1 });
		observer = client.runtimeQuery({
			selector: { type: "records", keys: [{ kind: "metadata", id: "observer" }] },
			maxRecords: 1,
			maxBytes: 1024,
		});
		await observerStarted.promise;

		const records = new RuntimeRecords(client);
		expect(
			await records.mutate(
				"runtime-scope",
				async tx => {
					await tx.put("metadata", "target", { value: "persisted" });
					return "persisted";
				},
				[],
				"buffered",
			),
		).toBe("persisted");
		releaseObserver.resolve();
		await observer;

		control = client.runtimeQuery(
			{
				selector: { type: "records", keys: [{ kind: "metadata", id: "control" }] },
				maxRecords: 1,
				maxBytes: 1024,
			},
			true,
		);
		await controlStarted.promise;
		await expect(
			records.mutate(
				"blocked-scope",
				async tx => tx.put("metadata", "blocked", { value: "rejected" }),
				[],
				"buffered",
			),
		).rejects.toThrow("admission budget");
		releaseControl.resolve();
		await control;
	} finally {
		releaseObserver.resolve();
		releaseControl.resolve();
		await observer?.catch(() => {});
		await control?.catch(() => {});
		await server.stop(true);
	}
});

it("keeps one runtime scope from consuming the whole required mutation budget", async () => {
	const release = Promise.withResolvers<void>();
	const client = {
		runtimeQuery: async (query: { selector: { keys: Array<{ kind: string; id: string }> } }) => ({
			records: query.selector.keys.map(key => ({ ...key, revision: null, value: null })),
			nextCursor: null,
		}),
		readRange: async () => ({ liveThroughSeq: 0 }),
		write: async () => {
			await release.promise;
			return {};
		},
	} as unknown as StorageClient;
	const records = new RuntimeRecords(client);
	const mutate = (scope: string, id: number) =>
		records.mutate(scope, async tx => {
			await tx.put("metadata", `${scope}-${id}`, { scope, id });
		});
	const firstScope = Array.from({ length: 4 }, (_, id) => mutate("hot", id));
	const secondScope = Array.from({ length: 4 }, (_, id) => mutate("cold", id));
	expect(() => mutate("hot", 4)).toThrow("admission exhausted");
	release.resolve();
	await Promise.all([...firstScope, ...secondScope]);
});

it("fences all later calls after the owner incarnation changes", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as TestRequest;
			return envelope(body.write.requestId, { receipt: receipt(body.write) }, 2);
		},
	});
	try {
		const client = new StorageClient(binding(server.port!));
		await expect(client.write(input)).rejects.toThrow("incarnation changed");
		expect(() => client.write(input)).toThrow("incarnation changed");
	} finally {
		await server.stop(true);
	}
});

it("keeps every failed read local and fences only an unknown write outcome", async () => {
	let requests = 0;
	const hang = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests++;
			const body = (await request.json()) as TestRequest;
			if (body.operation === "write") return new Response(null, { status: 408 });
			if (body.operation === "receipt")
				return envelope(body.receipt.requestId, {
					error: { code: "outcome_unknown", message: "no authoritative receipt", retryable: true },
				});
			if (body.read.familyId === "degraded")
				return envelope(body.read.requestId, {
					error: { code: "storage_error", message: "RocksDB read failed", retryable: false },
				});
			if (body.read.familyId === "garbled")
				return Response.json({ schema: "wrong.storage.protocol", version: "1.0", requestId: body.read.requestId });
			if (body.read.familyId === "oversized") return envelope(body.read.requestId, { padding: "x".repeat(4096) });
			// The client's own deadline is the behavior under test; the response never arrives.
			if (body.read.familyId === "slow") await hang.promise;
			return envelope(body.read.requestId, {
				familyId: body.read.familyId,
				generationId: body.read.generationId,
				throughSeq: 0,
				durableThroughSeq: 0,
				liveThroughSeq: 0,
				events: [],
				nextCursor: null,
			});
		},
	});
	const read = (familyId: string) => client.readRange({ familyId, generationId: "g", maxRecords: 1, maxBytes: 1024 });
	const client = new StorageClient(binding(server.port!), { deadlineMs: 200, responseBytes: 2048 });
	try {
		await expect(read("degraded")).rejects.toThrow("RocksDB read failed");
		await expect(read("garbled")).rejects.toMatchObject({ code: "retryable" });
		await expect(read("oversized")).rejects.toThrow("exceeded its byte budget");
		await expect(read("slow")).rejects.toMatchObject({ code: "retryable" });
		const stopped = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		await stopped.stop(true);
		const offline = new StorageClient(binding(stopped.port!));
		await expect(
			offline.readRange({ familyId: "refused", generationId: "g", maxRecords: 1, maxBytes: 1024 }),
		).rejects.toMatchObject({ code: "retryable" });
		expect(offline.failure).toBeUndefined();
		expect(client.failure).toBeUndefined();
		expect((await read("healthy")).events).toEqual([]);

		await expect(client.write(input)).rejects.toThrow("outcome is unknown");
		expect(client.failure?.code).toBe("outcome_unknown");
		const before = requests;
		expect(() => read("healthy")).toThrow("outcome is unknown");
		expect(requests).toBe(before);
	} finally {
		hang.resolve();
		await server.stop(true);
	}
});

it("hashes JCS numeric keys in lexical order and rejects lossy non-JSON payloads", () => {
	const actual = storageCanonicalJson({ "2": "two", "10": "ten", nested: { z: 1, a: -0 } });
	// Rust serde_jcs consumes these exact bytes before checking the hash.
	expect(actual).toBe('{"10":"ten","2":"two","nested":{"a":0,"z":1}}');
	expect(() => storageCanonicalJson({ bad: Number.NaN })).toThrow("finite JSON");
	expect(() => storageCanonicalJson({ bad: "\ud800" })).toThrow("unpaired surrogate");
});
