import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RocksNativeSessionStorage } from "../../src/session/rocks-native-session-storage";
import { SessionManager } from "../../src/session/session-manager";
import { StorageClient } from "../../src/session/storage-client";
import { STORAGE_PROTOCOL_SCHEMA_HASH } from "../../src/session/storage-protocol";

interface StorageRuntimeManifest {
	schema: string;
	source_commit: string;
	files: Array<{ role: string; path: string; sha256: string }>;
}

interface StorageReady {
	schema: string;
	url: string;
	incarnation: number;
	owner: string;
	pid: number;
	protocolHash: string;
}

interface RunningWorker {
	ready: StorageReady;
	stop(): Promise<void>;
}

interface StorageTrace {
	path: string;
	operation?: string;
	cursor?: string;
	cutSeq?: number;
	maxRecords?: number;
	maxBytes?: number;
}

async function hashFile(file: string): Promise<string> {
	return Bun.SHA256.hash(await Bun.file(file).arrayBuffer(), "hex");
}

function assertReady(value: unknown): StorageReady {
	if (!value || typeof value !== "object") throw new Error("Storage worker published an invalid ready file");
	const ready = value as StorageReady;
	if (
		ready.schema !== "artel.storage.protocol.ready.v1" ||
		new URL(ready.url).hostname !== "127.0.0.1" ||
		!Number.isSafeInteger(ready.incarnation) ||
		ready.incarnation < 1 ||
		ready.owner !== "artel-storage-runtime" ||
		!Number.isSafeInteger(ready.pid) ||
		ready.protocolHash !== STORAGE_PROTOCOL_SCHEMA_HASH
	)
		throw new Error("Storage worker ready identity does not match the Engine protocol");
	return ready;
}

async function startWorker(
	executable: string,
	dataDirectory: string,
	tokenFile: string,
	readyFile: string,
): Promise<RunningWorker> {
	const child = Bun.spawn(
		[
			executable,
			"--data",
			dataDirectory,
			"--token-file",
			tokenFile,
			"--ready-file",
			readyFile,
			"--listen",
			"127.0.0.1:0",
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const ready = assertReady(await Bun.file(readyFile).json());
			return {
				ready,
				async stop() {
					if (child.exitCode === null) child.kill();
					await child.exited;
				},
			};
		} catch (error) {
			if (child.exitCode !== null) {
				const stderr = await new Response(child.stderr).text();
				throw new Error(`Storage worker exited before ready: ${stderr.trim()}`, { cause: error });
			}
		}
		await Bun.sleep(20);
	}
	child.kill();
	await child.exited;
	const stderr = await new Response(child.stderr).text();
	throw new Error(`Storage worker readiness timed out: ${stderr.trim()}`);
}

const runtimeRoot = Bun.env.ARTEL_STORAGE_RUNTIME_ROOT;
const expectedSourceCommit = Bun.env.ARTEL_STORAGE_EXPECTED_SOURCE_COMMIT;
const requestedRunRoot = Bun.env.ARTEL_STORAGE_TEST_RUN_ROOT;

describe.skipIf(!runtimeRoot || !expectedSourceCommit || !requestedRunRoot)("real native storage bridge", () => {
	it("preserves the S1 context through bounded reads and a real worker cold restart", async () => {
		if (!runtimeRoot || !expectedSourceCommit || !requestedRunRoot)
			throw new Error("Real worker fixture is not configured");
		if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit)) throw new Error("Expected source commit must be exact");
		const runRoot = path.resolve(requestedRunRoot);
		const canonicalTempRoot = await fs.realpath(os.tmpdir());
		const canonicalRunRoot = path.join(await fs.realpath(path.dirname(runRoot)), path.basename(runRoot));
		const relativeRunRoot = path.relative(canonicalTempRoot, canonicalRunRoot);
		if (
			!relativeRunRoot ||
			relativeRunRoot.startsWith("..") ||
			path.isAbsolute(relativeRunRoot) ||
			!path.basename(runRoot).startsWith("artel-")
		)
			throw new Error("Real worker fixture requires a new artel-* directory under the system TEMP root");
		await fs.mkdir(runRoot, { recursive: false });

		const manifest = (await Bun.file(path.join(runtimeRoot, "manifest.json")).json()) as StorageRuntimeManifest;
		expect(manifest.schema).toBe("artel.storage.runtime.v1");
		expect(manifest.source_commit).toBe(expectedSourceCommit);
		const binaryRecord = manifest.files.find(file => file.role === "storage");
		const protocolRecord = manifest.files.find(file => file.role === "protocol");
		if (!binaryRecord || !protocolRecord) throw new Error("Storage runtime manifest is incomplete");
		const executable = path.join(runtimeRoot, binaryRecord.path);
		const protocol = path.join(runtimeRoot, protocolRecord.path);
		const binaryHash = await hashFile(executable);
		const protocolHash = `sha256:${await hashFile(protocol)}`;
		expect(binaryHash).toBe(binaryRecord.sha256);
		expect(protocolHash).toBe(`sha256:${protocolRecord.sha256}`);
		expect(protocolHash).toBe(STORAGE_PROTOCOL_SCHEMA_HASH);

		const dataDirectory = path.join(runRoot, "data");
		const tokenFile = path.join(runRoot, "token.txt");
		const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		await Bun.write(tokenFile, token);
		let worker = await startWorker(executable, dataDirectory, tokenFile, path.join(runRoot, "first.ready.json"));
		let targetUrl = worker.ready.url;
		const firstIncarnation = worker.ready.incarnation;
		const traces: StorageTrace[] = [];
		const proxy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const body =
					request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
				let operation: string | undefined;
				let read: Record<string, unknown> | undefined;
				if (body?.byteLength) {
					const envelope = JSON.parse(Buffer.from(body).toString("utf8")) as {
						operation?: unknown;
						read?: Record<string, unknown>;
					};
					if (typeof envelope.operation === "string") operation = envelope.operation;
					read = envelope.read;
				}
				traces.push({
					path: url.pathname,
					operation,
					cursor: typeof read?.cursor === "string" ? read.cursor : undefined,
					cutSeq: typeof read?.cutSeq === "number" ? read.cutSeq : undefined,
					maxRecords: typeof read?.maxRecords === "number" ? read.maxRecords : undefined,
					maxBytes: typeof read?.maxBytes === "number" ? read.maxBytes : undefined,
				});
				const headers = new Headers();
				const authorization = request.headers.get("authorization");
				const contentType = request.headers.get("content-type");
				if (authorization) headers.set("authorization", authorization);
				if (contentType) headers.set("content-type", contentType);
				return fetch(`${targetUrl}${url.pathname}${url.search}`, {
					method: request.method,
					headers,
					body: body?.byteLength ? body : undefined,
					redirect: "error",
				});
			},
		});

		let succeeded = false;
		let sessionId = "";
		let leafId = "";
		let archivedBranchId = "";
		try {
			const health = await fetch(`${worker.ready.url}/health`, { headers: { authorization: `Bearer ${token}` } });
			expect(health.status).toBe(200);
			const client = new StorageClient({
				url: `http://127.0.0.1:${proxy.port}`,
				token,
				incarnation: firstIncarnation,
				protocolHash,
			});
			const storage = new RocksNativeSessionStorage(client, "native-equivalence", "root", {
				maxRecords: 1,
				maxBytes: 65_536,
			});
			const manager = SessionManager.createNative("/native-equivalence", storage);
			manager.appendModelChange("openai/configured", "default");
			manager.appendThinkingLevelChange("high", "auto");
			manager.appendModeChange("plan", { exact: true });
			manager.appendTtsrInjection(["rule-a", "rule-b"]);
			const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			archivedBranchId = manager.appendMessage({ role: "user", content: "off branch", timestamp: 2 });
			manager.branch(rootId);
			const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 3 });
			manager.appendCompaction("summary", undefined, keptId, 101, {
				preserveData: {
					openaiRemoteCompaction: {
						provider: "openai",
						replacementHistory: [
							{ type: "compaction", encrypted_content: "opaque-ciphertext", unknown: { keep: [1, 2] } },
						],
					},
				},
			});
			const toolCallEntryId = manager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "read-call-1", name: "read", arguments: { path: "AGENTS.md" } }],
				provider: "openai",
				model: "configured",
				api: "openai-responses",
				timestamp: 4,
				stopReason: "toolUse",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const toolResultEntryId = manager.appendMessage({
				role: "toolResult",
				toolCallId: "read-call-1",
				toolName: "read",
				content: [{ type: "text", text: "fixture result" }],
				isError: false,
				timestamp: 5,
			});
			const expectedContext = manager.buildSessionContext();
			sessionId = manager.getSessionId();
			leafId = manager.getLeafId() ?? "";
			const checkpoint = await manager.flushAndCheckpoint();
			expect(checkpoint.native?.throughSeq).toBeGreaterThan(0);
			await manager.close();

			const cold = await SessionManager.openNative(storage);
			expect(cold.getSessionId()).toBe(sessionId);
			expect(cold.getLeafId()).toBe(leafId);
			expect(cold.buildSessionContext()).toEqual(expectedContext);
			expect(cold.getLastModelChangeRole()).toBe("default");
			expect(cold.hasContextEntryType("thinking_level_change")).toBe(true);
			expect(cold.hasContextEntryType("mode_change")).toBe(true);
			expect(cold.getEntry(toolResultEntryId)?.parentId).toBe(toolCallEntryId);
			const coldContext = cold.buildSessionContext();
			const toolCallIds = coldContext.messages.flatMap(message =>
				message.role === "assistant"
					? message.content.filter(content => content.type === "toolCall").map(content => content.id)
					: [],
			);
			const toolResultIds = coldContext.messages.flatMap(message =>
				message.role === "toolResult" ? [message.toolCallId] : [],
			);
			expect(toolCallIds).toEqual(["read-call-1"]);
			expect(toolResultIds).toEqual(["read-call-1"]);
			expect(() => cold.getEntries()).toThrow("materializeHistory");
			const firstContextReads = traces.filter(trace => trace.path === "/v1/read/context");
			expect(firstContextReads.length).toBeGreaterThan(1);
			expect(firstContextReads.every(trace => trace.maxRecords === 1 && trace.maxBytes === 65_536)).toBe(true);
			expect(traces.some(trace => trace.path === "/v1/read/range")).toBe(false);
			await cold.close();

			await worker.stop();
			worker = await startWorker(executable, dataDirectory, tokenFile, path.join(runRoot, "second.ready.json"));
			targetUrl = worker.ready.url;
			expect(worker.ready.incarnation).toBeGreaterThan(firstIncarnation);
			const reopenedStorage = new RocksNativeSessionStorage(
				new StorageClient({
					url: `http://127.0.0.1:${proxy.port}`,
					token,
					incarnation: worker.ready.incarnation,
					protocolHash,
				}),
				"native-equivalence",
				"root",
				{ maxRecords: 1, maxBytes: 65_536 },
			);
			const reopened = await SessionManager.openNative(reopenedStorage);
			expect(reopened.getSessionId()).toBe(sessionId);
			expect(reopened.getLeafId()).toBe(leafId);
			expect(reopened.buildSessionContext()).toEqual(expectedContext);
			expect(traces.some(trace => trace.path === "/v1/read/range")).toBe(false);
			const materializeStart = traces.length;
			await reopened.materializeHistory();
			expect(traces.slice(materializeStart).some(trace => trace.path === "/v1/read/range")).toBe(true);
			expect(reopened.getEntries().map(entry => entry.id)).toContain(archivedBranchId);
			await reopened.close();
			succeeded = true;
		} finally {
			await proxy.stop(true);
			await worker.stop();
			await Bun.write(
				path.join(runRoot, "native-equivalence-evidence.json"),
				JSON.stringify(
					{
						schema: "artel.native_equivalence.real_worker.v1",
						status: succeeded ? "pass" : "failed",
						sourceCommit: manifest.source_commit,
						binarySha256: binaryHash,
						protocolSha256: protocolHash,
						firstIncarnation,
						reopenedIncarnation: worker.ready.incarnation,
						sessionId,
						leafId,
						traces,
					},
					null,
					2,
				),
			);
		}
	});
});
