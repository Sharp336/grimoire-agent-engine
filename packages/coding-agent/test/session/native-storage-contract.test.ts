import { describe, expect, it } from "bun:test";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildSessionContext } from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";
import {
	assertStorageProtocolHash,
	STORAGE_PROTOCOL_REVISION,
	STORAGE_PROTOCOL_SCHEMA,
	STORAGE_PROTOCOL_SCHEMA_HASH,
	STORAGE_PROTOCOL_VERSION,
	type StorageBarrierResponse,
	type StorageErrorResponse,
	type StorageHealthResponse,
	type StorageMetricsResponse,
	type StorageNativeHead,
	type StorageReadResponse,
	type StorageReceipt,
	type StorageReceiptResponse,
	type StorageWrite,
	type StorageWriteResponse,
	storageProtocolRequest,
} from "../../src/session/storage-protocol";

const user = (content: string, timestamp: number): UserMessage => ({
	role: "user",
	content,
	timestamp,
});

describe("native session storage contract", () => {
	it("keeps leaf-to-root lineage, protects branches, and stops cycles", () => {
		const manager = SessionManager.inMemory("/tmp/native-contract");
		const root = manager.appendMessage(user("root", 1));
		const originalChild = manager.appendMessage(user("original", 2));

		manager.branch(root);
		const branch = manager.appendMessage(user("branch", 3));

		expect(manager.getBranch().map(entry => entry.id)).toEqual([root, branch]);
		expect(manager.getEntry(originalChild)?.parentId).toBe(root);
		const originalEntry = manager.getEntry(originalChild);
		expect(originalEntry?.type).toBe("message");
		if (originalEntry?.type === "message") expect(originalEntry.message).toMatchObject({ content: "original" });

		manager.ingestReplicatedEntry({
			type: "custom",
			id: "cycle",
			parentId: "cycle",
			timestamp: new Date(4).toISOString(),
			customType: "native-contract",
		});
		expect(manager.getBranch("cycle").map(entry => entry.id)).toEqual(["cycle"]);
	});

	it("retains native transition metadata and ordered tool pairs", () => {
		const manager = SessionManager.inMemory("/tmp/native-contract");
		const first = manager.appendMessage(user("prompt", 1));
		manager.appendThinkingLevelChange("high", "high");
		manager.appendModelChange("anthropic/claude", "slow");
		manager.appendServiceTierChange(null);
		manager.appendModeChange("plan", { source: "test" });
		manager.appendTtsrInjection(["rule-a", "rule-a", "rule-b"]);
		manager.appendCompaction("summary", undefined, first, 12);

		expect(manager.getLastModelChangeRole()).toBe("slow");
		expect(manager.getInjectedTtsrRules()).toEqual(["rule-a", "rule-b"]);
		expect(manager.getEntries().map(entry => entry.type)).toEqual([
			"message",
			"thinking_level_change",
			"model_change",
			"service_tier_change",
			"mode_change",
			"ttsr_injection",
			"compaction",
		]);

		const dangling = [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: new Date(1).toISOString(),
				message: user("run", 1),
			},
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
				},
			},
		] as SessionEntry[];
		const context = buildSessionContext(dangling, undefined, undefined, { transcript: true });
		expect(context.messages.some(message => message.role === "assistant" && message.content.length === 0)).toBe(true);
	});

	it("preserves session identity and completed entries on cold reopen", async () => {
		using tempDir = TempDir.createSync("@omp-native-contract-");
		const cwd = `${tempDir.path()}/project`;
		const sessionDir = `${tempDir.path()}/sessions`;
		const storage = new FileSessionStorage();
		const sessionFile = SessionManager.createEmptySessionFile(cwd, storage);
		const manager = await SessionManager.open(sessionFile, sessionDir, storage, { suppressBreadcrumb: true });
		const sessionId = manager.getSessionId();
		manager.appendMessage(user("durable", 1));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, sessionDir, storage, { suppressBreadcrumb: true });
		expect(reopened.getSessionId()).toBe(sessionId);
		expect(reopened.getEntries().some(entry => entry.type === "message" && entry.message.role === "user")).toBe(true);
		await reopened.close();
	});

	it("seals the journal so shutdown cannot report a dropped append as durable", async () => {
		using tempDir = TempDir.createSync("@omp-native-contract-seal-");
		const storage = new FileSessionStorage();
		const sessionFile = SessionManager.createEmptySessionFile(tempDir.path(), storage);
		const manager = await SessionManager.open(sessionFile, tempDir.path(), storage, { suppressBreadcrumb: true });
		manager.appendMessage(user("before seal", 1));
		await manager.close();
		const persisted = await Bun.file(sessionFile).text();
		manager.releaseRetainedEntries();
		manager.appendMessage(user("after seal", 2));
		expect(manager.getEntries()).toHaveLength(0);
		expect(await Bun.file(sessionFile).text()).toBe(persisted);
	});

	it("pins the Core-owned protocol identity without a second schema", () => {
		const request = storageProtocolRequest("barrier", {
			barrier: {
				requestId: "request-1",
				familyId: "family-1",
				generationId: "generation-1",
				throughSeq: 1,
				dependencies: [],
				incarnation: 1,
			},
		});
		expect(request.schema).toBe(STORAGE_PROTOCOL_SCHEMA);
		expect(request.version).toBe(STORAGE_PROTOCOL_VERSION);
		expect(STORAGE_PROTOCOL_REVISION).toBe(11);
		expect(STORAGE_PROTOCOL_SCHEMA_HASH).toBe(
			"sha256:f36386741fd92df4fc376112dabbdd972432a0b8099d82c611ce98abee5fe560",
		);
		expect(() => assertStorageProtocolHash(STORAGE_PROTOCOL_SCHEMA_HASH)).not.toThrow();
		expect(() => assertStorageProtocolHash("sha256:stale")).toThrow(/Unsupported storage protocol schema hash/);
	});

	// Run with the Core-owned file and a Python environment containing jsonschema/rfc8785.
	// No schema copy or validator is installed in the Engine runtime.
	it.skipIf(!Bun.env.ARTEL_STORAGE_PROTOCOL_SCHEMA)(
		"validates protocol9 wire and hash vectors against canonical Core bytes",
		async () => {
			const schemaPath = Bun.env.ARTEL_STORAGE_PROTOCOL_SCHEMA!;
			const schemaBytes = await Bun.file(schemaPath).arrayBuffer();
			assertStorageProtocolHash(`sha256:${Bun.SHA256.hash(schemaBytes, "hex")}`);
			const write: StorageWrite = {
				requestId: "request-1",
				operationId: "operation-1",
				familyId: "family-1",
				generationId: "generation-1",
				firstSeq: 1,
				entries: [{ entryId: "entry-1", parentId: null, kind: "message", payload: {} }],
				durability: "required",
				dependencies: [],
				payloadHash: `sha256:${"0".repeat(64)}`,
				incarnation: 1,
			};
			const barrier = storageProtocolRequest("barrier", {
				barrier: {
					requestId: "request-1",
					familyId: "family-1",
					generationId: "generation-1",
					throughSeq: 0,
					dependencies: [],
					incarnation: 1,
				},
			});
			const read = {
				requestId: "request-1",
				familyId: "family-1",
				generationId: "generation-1",
				cutSeq: 0,
				cursor: "v1:opaque",
				maxRecords: 100,
				maxBytes: 1024,
				incarnation: 1,
			};
			const receiptRequest = storageProtocolRequest("receipt", {
				receipt: {
					requestId: "request-2",
					familyId: "family-1",
					generationId: "generation-1",
					operationId: "operation-1",
					incarnation: 1,
				},
			});
			const head: StorageNativeHead = {
				leafId: null,
				lineage: { parentGenerationId: "parent", forkCutSeq: 0, forkLeafId: null },
				contextAnchors: { preserved: ["native"] },
				nativeExtra: { unchanged: true },
			};
			const base = {
				schema: "artel.storage.protocol.response.v1",
				version: STORAGE_PROTOCOL_VERSION,
				requestId: "request-1",
				incarnation: 2,
			} as const;
			const error: StorageErrorResponse = {
				...base,
				requestId: null,
				error: { code: "schema_error", message: "Malformed request", retryable: false },
			};
			const receipt: StorageReceipt = {
				operationId: write.operationId,
				familyId: write.familyId,
				generationId: write.generationId,
				payloadHash: write.payloadHash,
				firstSeq: 1,
				throughSeq: 1,
				admissionState: "admitted",
				appliedState: "applied",
				durabilityState: "durable",
				outcome: "success",
				incarnation: 1,
			};
			const emptyRead = {
				...base,
				familyId: "family-1",
				generationId: "generation-1",
				throughSeq: 0,
				durableThroughSeq: 0,
				liveThroughSeq: 0,
				events: [],
				nextCursor: null,
			} satisfies StorageReadResponse;
			const responses = {
				writeResponse: [{ ...base, receipt }, error] satisfies StorageWriteResponse[],
				barrierResponse: [
					{
						...base,
						familyId: "family-1",
						generationId: "generation-1",
						throughSeq: 0,
						durableThroughSeq: 0,
						dependencies: [],
					},
					error,
				] satisfies StorageBarrierResponse[],
				readResponse: [
					emptyRead,
					{
						...emptyRead,
						throughSeq: 1,
						liveThroughSeq: 2,
						events: [{ ...write.entries[0]!, seq: 1 }],
						nextCursor: "v1:opaque",
					},
					error,
				] satisfies StorageReadResponse[],
				receiptResponse: [
					{ ...base, receipt },
					{
						...error,
						requestId: "request-2",
						error: { code: "outcome_unknown", message: "Missing receipt", retryable: false },
					},
				] satisfies StorageReceiptResponse[],
				healthResponse: [
					{
						schema: base.schema,
						version: base.version,
						incarnation: 2,
						status: "ok",
						ready: true,
						owner: "owner",
					},
					error,
				] satisfies StorageHealthResponse[],
				metricsResponse: [
					{ schema: base.schema, version: base.version, incarnation: 2, queue: {}, rocksdb: {} },
					error,
				] satisfies StorageMetricsResponse[],
			};
			// These must fail both TypeScript and the canonical wire validator.
			// @ts-expect-error Writes require a write body.
			const missingBody = storageProtocolRequest("write");
			// @ts-expect-error Read operations cannot contain a write body.
			const wrongBody = storageProtocolRequest("read_range", { write });
			const reservedHead: StorageNativeHead = {
				// @ts-expect-error Client head cannot set authoritative watermarks.
				durableThroughSeq: 1,
			};
			const vectors = {
				revision: STORAGE_PROTOCOL_REVISION,
				requests: [
					storageProtocolRequest("write", { write }),
					storageProtocolRequest("write", { write: { ...write, head } }),
					barrier,
					storageProtocolRequest("read_range", { read }),
					storageProtocolRequest("read_context", { read }),
					receiptRequest,
					storageProtocolRequest("health"),
					storageProtocolRequest("metrics"),
				],
				invalidRequests: [
					missingBody,
					wrongBody,
					storageProtocolRequest("write", { write: { ...write, head: reservedHead } }),
					{ ...barrier, barrier: { ...barrier.barrier, throughSeq: -1 } },
					{
						...barrier,
						barrier: {
							...barrier.barrier,
							dependencies: [
								{ familyId: "family-1", generationId: "parent", throughSeq: Number.MAX_SAFE_INTEGER + 1 },
							],
						},
					},
					storageProtocolRequest("write", {
						write: { ...write, head: { ...head, lineage: { ...head.lineage!, forkCutSeq: -1 } } },
					}),
					{
						schema: STORAGE_PROTOCOL_SCHEMA,
						version: STORAGE_PROTOCOL_VERSION,
						operation: "write",
						write: { ...write, state: null },
					},
					{
						schema: STORAGE_PROTOCOL_SCHEMA,
						version: STORAGE_PROTOCOL_VERSION,
						operation: "read_range",
						read: { ...read, cursor: 1 },
					},
				],
				responses,
				invalidResponses: {
					readResponse: [
						{ ...emptyRead, nextCursor: 1 },
						{ ...error, events: [] },
						{ ...emptyRead, requestId: null },
					],
					receiptResponse: [{ ...base, receipt: { ...receipt, generationId: undefined } }],
				},
				write,
				hashChanges: [
					{ incarnation: 2 },
					{ durability: "buffered" },
					{ dependencies: [{ familyId: "family-1", generationId: "parent", throughSeq: 0 }] },
					{ head },
					{ state: {} },
					{ effect: {} },
				],
				numbers: [1, -0, 1e-7, 1e-6, 1e3, 0.3333333333333333].map(value => [value, JSON.stringify(value)]),
			};
			const check = Bun.spawnSync(
				[
					Bun.env.ARTEL_STORAGE_PROTOCOL_PYTHON ?? "python",
					"-c",
					`
import hashlib, json, sys
import jsonschema, rfc8785
schema = json.load(open(sys.argv[1], encoding="utf-8"))
vectors = json.load(sys.stdin)
jsonschema.Draft202012Validator.check_schema(schema)
assert schema["x-artel"]["protocolRevision"] == vectors["revision"]
validator = jsonschema.Draft202012Validator(schema)
for request in vectors["requests"]: validator.validate(request)
for request in vectors["invalidRequests"]: assert not validator.is_valid(request), request
for group, valid in [("responses", True), ("invalidResponses", False)]:
    for name, values in vectors[group].items():
        response = jsonschema.Draft202012Validator({"$defs": schema["$defs"], "$ref": "#/$defs/" + name})
        for value in values: assert response.is_valid(value) == valid, (name, value)
exclude = schema["x-artel"]["hash"]["exclude"]
assert exclude == ["requestId", "payloadHash"]
def digest(write):
    return hashlib.sha256(rfc8785.dumps({k:v for k,v in write.items() if k not in exclude})).hexdigest()
write = vectors["write"]
golden = b'{"dependencies":[],"durability":"required","entries":[{"entryId":"entry-1","kind":"message","parentId":null,"payload":{}}],"familyId":"family-1","firstSeq":1,"generationId":"generation-1","incarnation":1,"operationId":"operation-1"}'
assert digest(write) == hashlib.sha256(golden).hexdigest()
assert digest(write) == digest({**write, "requestId":"different", "payloadHash":"ignored"})
for change in vectors["hashChanges"]: assert digest(write) != digest({**write, **change}), change
for value, golden in vectors["numbers"]: assert rfc8785.dumps(value).decode() == golden
assert rfc8785.dumps({"\\ue000":1,"\\U0001f600":2}).decode() == '{"\\U0001f600":2,"\\ue000":1}'
for value in [9007199254740992, -9007199254740992, 10**20, 10**21]:
    try: rfc8785.dumps({"nested":[value]})
    except rfc8785.IntegerDomainError: pass
    else: raise AssertionError("unsafe integer accepted")
print("protocol9 requests/responses/JCS PASS")
`,
					schemaPath,
				],
				{ stdin: Buffer.from(JSON.stringify(vectors)) },
			);
			expect(check.stderr.toString()).toBe("");
			expect(check.exitCode).toBe(0);
			expect(check.stdout.toString().trim()).toBe("protocol9 requests/responses/JCS PASS");
		},
	);
});
