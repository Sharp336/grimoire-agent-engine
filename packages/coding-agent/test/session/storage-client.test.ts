import { expect, it } from "bun:test";
import { RuntimeRecords } from "../../src/engine/runtime-records";
import { StorageClient, StorageClientError, storageCanonicalJson } from "../../src/session/storage-client";
import {
	STORAGE_PROTOCOL_SCHEMA_HASH,
	type StorageRuntimeMutation,
	type StorageRuntimeRecord,
	type StorageWrite,
} from "../../src/session/storage-protocol";

interface TestRequest {
	operation: string;
	write: StorageWrite;
	receipt: { requestId: string };
	read: { requestId: string; familyId: string; generationId: string };
	barrier: { requestId: string; familyId: string };
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

it("queues a read behind a full read lane instead of refusing it", async () => {
	const holding = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as TestRequest;
			const keys = body.query.selector.keys;
			if (keys.some(key => key.id === "observer")) {
				holding.resolve();
				await release.promise;
			}
			return envelope(body.query.requestId, {
				records: keys.map(key => ({ ...key, revision: null, value: null })),
				nextCursor: null,
			});
		},
	});
	let observer: Promise<unknown> | undefined;
	try {
		// An observer read holds the only read slot. A command's read arriving now must wait for that slot:
		// refusing it made a continued chat's Start fail as "admission budget exhausted" under observer load.
		const client = new StorageClient(binding(server.port!), { readRequests: 1 });
		const query = (id: string) =>
			client.runtimeQuery({
				selector: { type: "records", keys: [{ kind: "metadata", id }] },
				maxRecords: 1,
				maxBytes: 1024,
			});
		observer = query("observer");
		await holding.promise;
		const command = query("command");
		const later = query("later");
		expect(client.pending.read).toBe(1);
		release.resolve();
		expect((await command).records[0]?.id).toBe("command");
		expect((await later).records[0]?.id).toBe("later");
		await observer;
		expect(client.pending.read).toBe(0);
	} finally {
		release.resolve();
		await observer?.catch(() => {});
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

it("reads event mutations outside the event chain while the owner still checks every counter revision", async () => {
	// Owner model: revision +1 per applied put, a stale check rejects the whole batch, seqs follow receipts.
	const rows = new Map<string, StorageRuntimeRecord>();
	const seqs = new Map<string, number>();
	const calls = { query: 0, cut: 0 };
	const slow = Promise.withResolvers<void>();
	const slowStarted = Promise.withResolvers<void>();
	const client = {
		runtimeQuery: async (query: { selector: { keys: Array<{ kind: "metadata"; id: string }> } }) => {
			calls.query++;
			if (query.selector.keys.some(key => key.id === "slow")) {
				slowStarted.resolve();
				await slow.promise;
			}
			return {
				records: query.selector.keys.map(key => rows.get(key.id) ?? { ...key, revision: null, value: null }),
				nextCursor: null,
			};
		},
		readRange: async ({ familyId }: { familyId: string }) => {
			calls.cut++;
			return { liveThroughSeq: seqs.get(familyId) ?? 0 };
		},
		write: async ({
			familyId,
			firstSeq,
			runtime,
		}: {
			familyId: string;
			firstSeq: number;
			runtime: StorageRuntimeMutation;
		}) => {
			if (firstSeq !== (seqs.get(familyId) ?? 0) + 1) throw new StorageClientError("sequence_gap", "gap");
			if (runtime.checks.some(check => (rows.get(check.id)?.revision ?? null) !== check.revision))
				throw new StorageClientError("conflict", "runtime record revision mismatch");
			for (const put of runtime.puts) rows.set(put.id, { ...put, revision: (rows.get(put.id)?.revision ?? 0) + 1 });
			seqs.set(familyId, firstSeq);
			return { throughSeq: firstSeq };
		},
	} as unknown as StorageClient;
	const records = new RuntimeRecords(client);
	const event = (scope: string, reads: string[] = []) =>
		records.mutate(scope, async tx => {
			tx.sequence("events");
			for (const id of reads) await tx.get("metadata", id);
			const count = ((await tx.get<{ count: number }>("metadata", "events"))?.count ?? 0) + 1;
			await tx.put("metadata", "events", { count });
			return count;
		});

	expect(await event("warm")).toBe(1);
	const blocked = event("blocked", ["slow"]);
	await slowStarted.promise;
	// A neighbor's slow read does not hold the chain: this event commits meanwhile, warm, in one write.
	const before = { ...calls };
	expect(await event("warm")).toBe(2);
	expect(calls).toEqual(before);
	slow.resolve();
	expect(await blocked).toBe(3);
	// Another writer bumps the counter: the cached revision conflicts, and the retry reads it again.
	rows.set("events", { kind: "metadata", id: "events", revision: 99, value: { count: 10 } });
	expect(await event("warm")).toBe(11);
	expect(rows.get("events")).toMatchObject({ revision: 100, value: { count: 11 } });
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

it("keeps every failed read local and fences only an unknown write or barrier outcome", async () => {
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
			// The client's own deadline is the behavior under test; the response never arrives.
			if (body.operation === "barrier") await hang.promise;
			if (body.read.familyId === "degraded")
				return envelope(body.read.requestId, {
					error: { code: "storage_error", message: "RocksDB read failed", retryable: false },
				});
			if (body.read.familyId === "garbled")
				return Response.json({ schema: "wrong.storage.protocol", version: "1.0", requestId: body.read.requestId });
			if (body.read.familyId === "oversized") return envelope(body.read.requestId, { padding: "x".repeat(4096) });
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
		// A barrier confirms durability of accepted writes, so its lost outcome is a write outcome.
		const barrier = new StorageClient(binding(server.port!), { deadlineMs: 200 });
		await expect(
			barrier.barrier({ familyId: "f", generationId: "g", throughSeq: 1, dependencies: [] }),
		).rejects.toMatchObject({ code: "outcome_unknown" });
		expect(barrier.failure?.code).toBe("outcome_unknown");
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

it("fences a write or barrier the owner may have applied, never one it provably refused", async () => {
	let receipts = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as TestRequest;
			if (body.operation === "receipt") {
				receipts++;
				return envelope(body.receipt.requestId, {
					error: { code: "outcome_unknown", message: "no authoritative receipt", retryable: true },
				});
			}
			// The family names the error the owner answers with.
			const { requestId, familyId: code } = body.operation === "write" ? body.write : body.barrier;
			return envelope(requestId, { error: { code, message: `owner answered ${code}`, retryable: false } });
		},
	});
	const barrierInput = (familyId: string) => ({ familyId, generationId: "g", throughSeq: 1, dependencies: [] });
	try {
		// A validation rejection and an admission refusal both prove nothing was applied.
		for (const code of ["conflict", "backpressure"]) {
			const client = new StorageClient(binding(server.port!), { deadlineMs: 200 });
			await expect(client.write({ ...input, familyId: code })).rejects.toMatchObject({ code });
			await expect(client.barrier(barrierInput(code))).rejects.toMatchObject({ code });
			expect(client.failure).toBeUndefined();
		}
		expect(receipts).toBe(0);

		// storage_error can follow write_opt (a failed flush_wal): reconcile through the receipt, then fence.
		const written = new StorageClient(binding(server.port!), { deadlineMs: 200 });
		await expect(written.write({ ...input, familyId: "storage_error" })).rejects.toThrow("outcome is unknown");
		expect(written.failure?.code).toBe("outcome_unknown");
		expect(receipts).toBeGreaterThan(0);
		const barrier = new StorageClient(binding(server.port!), { deadlineMs: 200 });
		await expect(barrier.barrier(barrierInput("storage_error"))).rejects.toMatchObject({ code: "storage_error" });
		expect(barrier.failure?.code).toBe("storage_error");
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
