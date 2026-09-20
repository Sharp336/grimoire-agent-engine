import { expect, it } from "bun:test";
import { StorageClient, storageCanonicalJson } from "../../src/session/storage-client";
import { STORAGE_PROTOCOL_SCHEMA_HASH, type StorageWrite } from "../../src/session/storage-protocol";

interface TestRequest {
	operation: string;
	write: StorageWrite;
	receipt: { requestId: string };
	read: { requestId: string };
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

it("hashes JCS numeric keys in lexical order and rejects lossy non-JSON payloads", () => {
	const actual = storageCanonicalJson({ "2": "two", "10": "ten", nested: { z: 1, a: -0 } });
	// Rust serde_jcs consumes these exact bytes before checking the hash.
	expect(actual).toBe('{"10":"ten","2":"two","nested":{"a":0,"z":1}}');
	expect(() => storageCanonicalJson({ bad: Number.NaN })).toThrow("finite JSON");
	expect(() => storageCanonicalJson({ bad: "\ud800" })).toThrow("unpaired surrogate");
});
