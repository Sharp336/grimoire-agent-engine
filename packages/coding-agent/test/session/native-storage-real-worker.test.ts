import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { EngineEvent, EngineLaunchProfile } from "../../src/engine/contracts";
import { EngineRuntime, type EngineRuntimeOptions } from "../../src/engine/runtime";
import { BlobStore } from "../../src/session/blob-store";
import { parseNativeSessionLocator, RocksNativeSessionStorage } from "../../src/session/rocks-native-session-storage";
import { SessionManager } from "../../src/session/session-manager";
import { StorageClient } from "../../src/session/storage-client";
import { STORAGE_PROTOCOL_SCHEMA_HASH } from "../../src/session/storage-protocol";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

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
	it("retains successful assistants when reported usage exceeds the route context window", async () => {
		if (!runtimeRoot || !expectedSourceCommit || !requestedRunRoot)
			throw new Error("Real worker fixture is not configured");
		if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit)) throw new Error("Expected source commit must be exact");
		const runRoot = path.resolve(`${requestedRunRoot}-successful-overflow`);
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

		const tokenFile = path.join(runRoot, "token.txt");
		const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		await Bun.write(tokenFile, token);
		const worker = await startWorker(
			executable,
			path.join(runRoot, "data"),
			tokenFile,
			path.join(runRoot, "ready.json"),
		);
		const binding = {
			url: worker.ready.url,
			token,
			incarnation: worker.ready.incarnation,
			protocolHash,
		};
		const storageClient = new StorageClient(binding);
		const previousBinding = Bun.env.GRIMOIRE_STORAGE_BINDING;
		Bun.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(binding);

		registerMockApi("native-real-worker-successful-overflow");
		const usage = {
			input: 2,
			output: 105,
			cacheRead: 0,
			cacheWrite: 39_642,
			totalTokens: 39_749,
		};
		const mock = createMockModel({
			contextWindow: 32_000,
			responses: [
				{ content: ["first visible answer"], stopReason: "stop", usage },
				{ content: ["second visible answer"], stopReason: "stop", usage },
			],
		});
		const auth = createInMemoryAuthStorage();
		auth.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(auth);
		const cwd = path.join(runRoot, "workspace");
		const agentDir = path.join(runRoot, "agent");
		await fs.mkdir(cwd);
		await fs.mkdir(agentDir);
		const settings = await Settings.loadReadOnly({
			cwd,
			agentDir,
			overrides: {
				"compaction.enabled": true,
				"compaction.asyncEnabled": false,
				"compaction.methodOrder": ["shake"],
				"contextPromotion.enabled": false,
			},
		});
		const options: EngineRuntimeOptions = {
			databasePath: path.join(runRoot, "engine.sqlite"),
			attachmentBlobStore: new BlobStore(path.join(runRoot, "data", "blobs")),
			sessionDefaults: {
				cwd,
				agentDir,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
				model: mock.model,
			},
		};
		const profile: EngineLaunchProfile = {
			spawns: "",
			profileDigest: "native-real-worker-successful-overflow-v1",
			enableMCP: false,
			enableLsp: false,
		};
		const agentInstanceId = "native-real-worker-successful-overflow-agent";
		const agentInstanceRef = "grimoire://tasks/grimoire/native-real-worker-successful-overflow/agents/owner";
		let runtime: EngineRuntime | undefined;
		let locator: string | undefined;
		const retainedAssistantHistoryEntryIds: string[] = [];
		try {
			for (let turn = 1; turn <= 2; turn++) {
				runtime = await EngineRuntime.create(options);
				const events: EngineEvent[] = [];
				const unsubscribe = runtime.subscribe(event => {
					events.push(event);
				});
				const attemptId = `native-real-worker-successful-overflow-attempt-${turn}`;
				const started = await runtime.start(
					{
						commandId: `native-real-worker-successful-overflow-command-${turn}`,
						agentInstanceId,
						agentInstanceRef,
						executionId: `native-real-worker-successful-overflow-execution-${turn}`,
						attemptId,
						authorityGeneration: 1,
						cwd,
						input: `turn ${turn}`,
					},
					profile,
				);
				await runtime.drain();
				unsubscribe();
				const snapshot = events.findLast(
					event =>
						event.kind === "assistant_snapshot" &&
						event.attemptId === attemptId &&
						typeof event.payload?.stopReason === "string",
				);
				const historyEntryId =
					typeof snapshot?.payload?.historyEntryId === "string" ? snapshot.payload.historyEntryId : null;
				const attempt = await runtime.store.getAttempt(attemptId);
				if (!attempt?.transcript_path) throw new Error("Attempt did not retain its native session locator");
				locator ??= String(attempt.transcript_path);
				expect(String(attempt.transcript_path)).toBe(locator);
				expect(String(started.sessionFile)).toBe(locator);
				const { familyId, generationId } = parseNativeSessionLocator(locator);
				const raw = await storageClient.readContext({
					familyId,
					generationId,
					maxRecords: 100,
					maxBytes: 1_048_576,
				});
				const history = await runtime.sessionHistoryPage(
					agentInstanceId,
					agentInstanceRef,
					undefined,
					100,
					attemptId,
				);
				expect(snapshot?.payload?.stopReason).toBe("stop");
				expect(typeof historyEntryId).toBe("string");
				retainedAssistantHistoryEntryIds.push(String(historyEntryId));
				expect(attempt.transcript_leaf_entry_id).toBe(historyEntryId);
				expect(raw.head?.leafId).toBe(historyEntryId);
				expect(history.entries.filter(entry => entry.role === "user")).toHaveLength(turn);
				expect(history.entries.filter(entry => entry.role === "assistant")).toHaveLength(turn);
				await runtime.dispose();
				runtime = undefined;
			}
			expect(mock.calls).toHaveLength(2);
			expect(new Set(retainedAssistantHistoryEntryIds).size).toBe(2);
		} finally {
			await runtime?.dispose();
			if (previousBinding === undefined) delete Bun.env.GRIMOIRE_STORAGE_BINDING;
			else Bun.env.GRIMOIRE_STORAGE_BINDING = previousBinding;
			auth.close();
			await worker.stop();
		}
	}, 60_000);

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

	it("bounds the OpenAI SSE parser inside Engine and requires an explicit native-session continuation", async () => {
		if (!runtimeRoot || !expectedSourceCommit || !requestedRunRoot)
			throw new Error("Real worker fixture is not configured");
		const runRoot = path.resolve(`${requestedRunRoot}-openai-stream-admission`);
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
		expect(manifest.source_commit).toBe(expectedSourceCommit);
		const binaryRecord = manifest.files.find(file => file.role === "storage");
		const protocolRecord = manifest.files.find(file => file.role === "protocol");
		if (!binaryRecord || !protocolRecord) throw new Error("Storage runtime manifest is incomplete");
		const executable = path.join(runtimeRoot, binaryRecord.path);
		const protocolHash = `sha256:${await hashFile(path.join(runtimeRoot, protocolRecord.path))}`;
		expect(protocolHash).toBe(STORAGE_PROTOCOL_SCHEMA_HASH);

		const tokenFile = path.join(runRoot, "token.txt");
		const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		await Bun.write(tokenFile, token);
		const worker = await startWorker(
			executable,
			path.join(runRoot, "data"),
			tokenFile,
			path.join(runRoot, "ready.json"),
		);
		const binding = {
			url: worker.ready.url,
			token,
			incarnation: worker.ready.incarnation,
			protocolHash,
		};
		const previousBinding = Bun.env.GRIMOIRE_STORAGE_BINDING;
		Bun.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(binding);
		let requests = 0;
		const frame = (content: string, finishReason: string | null = null) =>
			`data: ${JSON.stringify({
				id: "chatcmpl-s31",
				object: "chat.completion.chunk",
				created: 0,
				model: "s31-openai-stream",
				choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
			})}\n\n`;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests++;
				await request.arrayBuffer();
				const body =
					requests === 1
						? [
								frame("S31_T2_DURABLE_PREFIX"),
								frame("-1"),
								frame("-2"),
								frame("-3"),
								frame("LATE_CALLBACK_MUST_NOT_PERSIST", "stop"),
								"data: [DONE]\n\n",
							].join("")
						: `${frame("S31_T2_EXPLICIT_CONTINUE_OK", "stop")}data: [DONE]\n\n`;
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			},
		});
		const provider = "s31-openai-stream";
		const model = buildModel({
			id: "s31-openai-stream",
			name: "S3.1 OpenAI stream acceptance",
			api: "openai-completions",
			provider,
			baseUrl: `${server.url}v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 1_024,
		});
		const auth = createInMemoryAuthStorage();
		auth.setRuntimeApiKey(provider, "fixture-key");
		const modelRegistry = new ModelRegistry(auth);
		const cwd = path.join(runRoot, "workspace");
		const agentDir = path.join(runRoot, "agent");
		await fs.mkdir(cwd);
		await fs.mkdir(agentDir);
		const settings = await Settings.loadReadOnly({ cwd, agentDir });
		const runtime = await EngineRuntime.create({
			databasePath: path.join(runRoot, "engine.sqlite"),
			streamAdmissionLimits: { maxProviderEvents: 4 },
			sessionDefaults: {
				cwd,
				agentDir,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
				model,
			},
		});
		const agentInstanceId = "s31-openai-stream-agent";
		const agentInstanceRef = "grimoire://tasks/grimoire/s31-openai-stream/agents/owner";
		const profile: EngineLaunchProfile = {
			spawns: "",
			profileDigest: "s31-openai-stream-profile-v1",
			enableMCP: false,
			enableLsp: false,
		};
		try {
			const first = await runtime.start(
				{
					commandId: "s31-openai-stream-command-1",
					agentInstanceId,
					agentInstanceRef,
					executionId: "s31-openai-stream-execution-1",
					attemptId: "s31-openai-stream-attempt-1",
					authorityGeneration: 1,
					cwd,
					input: "S31_T2_DURABLE_PREFIX",
				},
				profile,
			);
			await runtime.drain();
			const interrupted = await runtime.store.getAttempt("s31-openai-stream-attempt-1");
			const firstEvents = (await runtime.store.pendingEvents()).filter(
				event => event.attemptId === "s31-openai-stream-attempt-1",
			);
			expect(runtime.storageMode).toBe("native");
			expect(interrupted?.state).toBe("interrupted");
			expect(requests).toBe(1);
			expect(firstEvents.filter(event => event.kind === "model_settled")).toHaveLength(1);
			expect(firstEvents.find(event => event.kind === "model_settled")?.payload?.status).toBe("failed");
			expect(firstEvents.some(event => event.kind === "completed")).toBe(false);
			const interruptedHistory = await runtime.sessionHistoryPage(
				agentInstanceId,
				agentInstanceRef,
				undefined,
				100,
				"s31-openai-stream-attempt-1",
			);
			expect(interruptedHistory.entries.some(entry => JSON.stringify(entry).includes("S31_T2_DURABLE_PREFIX"))).toBe(
				true,
			);
			expect(
				interruptedHistory.entries.some(entry => JSON.stringify(entry).includes("LATE_CALLBACK_MUST_NOT_PERSIST")),
			).toBe(false);

			const continued = await runtime.start(
				{
					commandId: "s31-openai-stream-command-2",
					agentInstanceId,
					agentInstanceRef,
					executionId: "s31-openai-stream-execution-2",
					attemptId: "s31-openai-stream-attempt-2",
					authorityGeneration: 1,
					expectedIntentRevision: first.intentRevision,
					explicitContinue: true,
					cwd,
					input: "Continue explicitly after the interrupted stream.",
				},
				profile,
			);
			await runtime.drain();
			const completed = await runtime.store.getAttempt("s31-openai-stream-attempt-2");
			const finalHistory = await runtime.sessionHistoryPage(
				agentInstanceId,
				agentInstanceRef,
				undefined,
				100,
				"s31-openai-stream-attempt-2",
			);
			expect(completed?.state).toBe("completed");
			expect(requests).toBe(2);
			expect(continued.sessionFile).toBe(first.sessionFile);
			expect(continued.bindingGeneration).toBe(first.bindingGeneration + 1);
			expect(continued.bindingId).not.toBe(first.bindingId);
			expect(finalHistory.entries.some(entry => JSON.stringify(entry).includes("S31_T2_EXPLICIT_CONTINUE_OK"))).toBe(
				true,
			);
			expect(
				finalHistory.entries.some(entry => JSON.stringify(entry).includes("LATE_CALLBACK_MUST_NOT_PERSIST")),
			).toBe(false);
			const settledFirstEvents = (await runtime.store.pendingEvents()).filter(
				event => event.attemptId === "s31-openai-stream-attempt-1",
			);
			expect(settledFirstEvents.filter(event => event.kind === "model_settled")).toHaveLength(1);
			expect(settledFirstEvents.some(event => event.kind === "completed")).toBe(false);
		} finally {
			await runtime.dispose();
			auth.close();
			server.stop(true);
			if (previousBinding === undefined) delete Bun.env.GRIMOIRE_STORAGE_BINDING;
			else Bun.env.GRIMOIRE_STORAGE_BINDING = previousBinding;
			await worker.stop();
		}
	}, 60_000);
});
