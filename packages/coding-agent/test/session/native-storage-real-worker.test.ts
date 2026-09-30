import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import {
	type EngineBindingSnapshot,
	type EngineOrdinaryEvent,
	type EngineExecutionConfiguration,
	type EngineSemanticBindingSnapshot,
	type EngineStartRequest,
	EngineTargetError,
} from "../../src/engine/contracts";
import { runEngineCommand } from "../../src/engine/control-query";
import type { EngineCommandEnvelope } from "../../src/engine/nats-adapter";
import { EngineRuntime, type EngineRuntimeOptions } from "../../src/engine/runtime";
import { BlobStore } from "../../src/session/blob-store";
import { parseNativeSessionLocator, RocksNativeSessionStorage } from "../../src/session/rocks-native-session-storage";
import { SessionManager } from "../../src/session/session-manager";
import { StorageClient, storageCanonicalJson } from "../../src/session/storage-client";
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
/** The native-storage tests use a real Engine command/admission path with a local deterministic provider. */
function nativeEngineHarness(
	model: Model, modelRegistry: ModelRegistry, settings: Settings,
	taskRef: WorkTarget["task_ref"], agentInstanceRef: string,
) {
	const accountRef = "gctx:aaaaaaaaaaaaaaaa";
	const routeRef = "gctx:bbbbbbbbbbbbbbbb";
	const dispatchRef = "gctx:cccccccccccccccc";
	const hash = (value: unknown) => `sha256:${Bun.SHA256.hash(storageCanonicalJson(value), "hex")}`;
	const spawn = { allowed: "no", max_depth: 0, max_children: 0, on_exceed: "deny" } as const;
	const limits = { timeout_seconds: null, max_iterations: null };
	const dispatch: EngineExecutionConfiguration["dispatch"] = {
		schema: "grimoire.dispatch.v2",
		execution_kind: "ordinary",
		special_ref: null,
		dispatch_id: "native-worker-fixture",
		target: { task_ref: taskRef, work_step_id: null },
		prompt: "Native worker fixture",
		instructions: "",
		skill_refs: [],
		display_name: null,
		preset: null,
		tools: null,
		tools_permit: [],
		tools_on_request: "none",
		spawn,
		requirement: {
			min_tier: 0, required: [], required_tags: [], preferred_tags: [], models: null,
			exclude: { models: [], families: [], agent_instances: [] },
			min_context: null, min_output: null, latency_ceiling_ms: null, min_effort: null,
			service_tier: "standard", downgrade: "forbidden", pin: null,
			require_trusted_provider: true, fallback_mode: "none",
		},
		output_schema: null,
		limits,
	};
	const config: EngineExecutionConfiguration = {
		dispatch,
		routes: { routes: [{
			model_id: model.id, route_ref: routeRef, account_ref: accountRef,
			effort: "none", service_tier: "standard", billing_pool_id: "native-fixture-pool",
			billing_pool_basis: "expected", tier: 0, provider_id: model.provider,
			quota_window_ids: [], shadow_cost: null, price_source: "unknown", estimated: false,
			record_revisions: {}, provider: model.provider, modelId: model.id,
			billing_pools: [{
				pool_id: "native-fixture-pool", kind: "payg", valuation: 1, reserve: 0, price_multiplier: 1,
				service_tier_multipliers: { standard: 1, priority: 1, flex: 1 },
				quota_windows: [], window_seconds: null, cap: null,
			}], quota_windows: [],
			// The first case materializes the mock API locally; its frozen route only supplies admission capacity.
			execution: {
				api: "openai-completions", base_url: model.api === "mock" ? "http://127.0.0.1:1/v1" : model.baseUrl,
				provider_model_id: model.id, context_window: model.contextWindow,
				max_output_tokens: model.maxTokens, input_modalities: ["text"],
				supports_tools: true, supports_reasoning: false, header_refs: [], compat: null,
				route_content_hash: hash("native-route"), account_content_hash: hash("native-account"),
				display_name: "Native fixture route", efforts: ["none"], trusted: true,
				credential: { method: "none", local_ref: null, hosted_ref: null, generation: 1 },
				account_binding_id: null,
			},
			family: null, tags: [], efforts: ["none"], hard_quota_window_ids: [], order_match: null,
		}] },
		continuationPolicy: "exact",
		continuationConfiguration: {
			systemPrompt: "", toolNames: [], restrictToolNames: true, toolPolicies: {},
			enableMCP: false, enableLsp: false, lspShared: false,
			disabledCapabilityProviders: [], outputSchema: null, requireYieldTool: false,
			spawn, limits, tools_permit: [], tools_on_request: "none", providerPromptCacheKey: null,
		},
		stableDependencyDigest: hash("native-dependency"),
		sessionDefaults: {},
		instruction_sources: {
			facts: { binding: "task", scope: [taskRef], os: null, runtime: "artel-engine", engine_version: null },
			rules: [], skills: [],
		},
		record_revisions: {},
		routingLimits: {
			scopes: [{ scope_ref: taskRef, agents: 1, by_tier: [], consultations: null }],
			accounts: { [accountRef]: 1 }, providers: { [model.provider]: 1 },
		},
		scope_revision: hash("native-scope"), roster_revision: hash("native-roster"), roster_complete: true,
	};
	const bindingSnapshot: EngineSemanticBindingSnapshot = {
		agentInstanceRef, taskRef, workStepId: null, bindingRevision: 0, installationId: null,
		parentAgentInstanceRef: null, parentAttemptId: null, parentBindingRevision: null,
	};
	const dispatchHash = hash(dispatch);
	const receipts = new Map<string, Pick<EngineCommandEnvelope, "commandId" | "agentInstanceRef" | "attemptId" | "principalId">>();
	const options: Pick<EngineRuntimeOptions, "deviceId" | "resolveExecution" | "verifyOriginReceipt"> = {
		deviceId: "native-fixture-device",
		resolveExecution: async (execution, frozen) => {
			if (hash(execution.dispatch) !== dispatchHash || frozen.length !== 1 || frozen[0]?.route_ref !== routeRef)
				throw new EngineTargetError("stale_target", "Fixture route differs from admitted execution");
			return {
				options: { model, modelRegistry, settings },
				selectors: ["native-fixture-route"],
				verifyCandidate: async index => {
					if (index !== 0) throw new EngineTargetError("stale_target", "Unknown fixture route");
					return { billing_pool_id: "native-fixture-pool", billing_pool_basis: "expected" };
				},
				activateCandidate: () => {},
				setBillingPoolChanged: () => {}, // Local deterministic provider has no hosted billing admission.
				dispose: () => {},
			};
		},
		verifyOriginReceipt: async identity => {
			const receipt = receipts.get(identity.originReceiptId);
			if (!receipt || receipt.commandId !== identity.commandId ||
				receipt.agentInstanceRef !== identity.agentInstanceRef ||
				receipt.attemptId !== identity.attemptId || receipt.principalId !== identity.principalId)
				throw new EngineTargetError("stale_target", "Fixture Start origin differs from exact command");
			return {
				verified: true, dispatchHash, bindingSnapshot, authContextId: "native-fixture-auth",
				approvalSettings: null, specialApproval: null,
			};
		},
	};
	async function start(runtime: EngineRuntime, request:
		Pick<EngineStartRequest, "commandId" | "agentInstanceId" | "executionId" | "attemptId" | "cwd"> &
		{ input: string; expectedIntentRevision?: number; explicitContinue?: boolean },
	): Promise<EngineBindingSnapshot> {
		const originReceiptId = `origin:${request.commandId}`;
		const command: EngineCommandEnvelope = {
			schema: "grimoire.engine.command.v1", op: "start", commandId: request.commandId,
			deviceId: "native-fixture-device", engineId: "native-fixture-engine",
			engineGeneration: runtime.engineGeneration, agentInstanceId: request.agentInstanceId,
			agentInstanceRef, bindingSnapshot, executionId: request.executionId,
			attemptId: request.attemptId, authorityGeneration: 1, principalId: "owner",
			issuedAt: Date.now(),
			payload: {
				cwd: request.cwd, input: request.input,
				...(request.expectedIntentRevision === undefined ? {} : { expectedIntentRevision: request.expectedIntentRevision }),
				...(request.explicitContinue ? { explicitContinue: true } : {}),
				executionConfiguration: config, dispatchRef, dispatchHash,
				executionKind: "ordinary", specialRef: null, originReceiptId,
			},
		};
		receipts.set(originReceiptId, command);
		const result = await runEngineCommand({
			runtime, deviceId: "native-fixture-device", engineId: "native-fixture-engine",
		}, command);
		if (result.outcome !== "applied") throw new Error("Native fixture Start was not applied");
		const binding = await runtime.store.getBinding(request.agentInstanceId);
		if (!binding || binding.attemptId !== request.attemptId)
			throw new Error("Native fixture Start did not retain its exact binding");
		return binding;
	}
	return { options, start };
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
		const agentInstanceId = "native-real-worker-successful-overflow-agent";
		const taskRef = "grimoire://tasks/grimoire/native-real-worker-successful-overflow";
		const agentInstanceRef = `${taskRef}/agents/owner`;
		const harness = nativeEngineHarness(mock.model, modelRegistry, settings, taskRef, agentInstanceRef);
		const options: EngineRuntimeOptions = {
			databasePath: path.join(runRoot, "engine.sqlite"),
			...harness.options,
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
				const started = await harness.start(runtime, {
					commandId: `native-real-worker-successful-overflow-command-${turn}`,
					agentInstanceId,
					executionId: `native-real-worker-successful-overflow-execution-${turn}`,
					attemptId,
					cwd,
					input: `turn ${turn}`,
				});
				await runtime.drain();
				unsubscribe();
				// assistant_snapshot is an ordinary kind: payload is the plain record the Engine wrote.
				const ordinarySnapshots = events.filter(
					event => event.kind === "assistant_snapshot" && event.attemptId === attemptId,
				) as EngineOrdinaryEvent[];
				const snapshot = ordinarySnapshots.findLast(
					event => typeof event.payload?.stopReason === "string",
				);
				const historyEntryId = typeof snapshot?.payload?.historyEntryId === "string"
					? snapshot.payload.historyEntryId
					: null;
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
		const agentInstanceId = "s31-openai-stream-agent";
		const taskRef = "grimoire://tasks/grimoire/s31-openai-stream";
		const agentInstanceRef = `${taskRef}/agents/owner`;
		const harness = nativeEngineHarness(model, modelRegistry, settings, taskRef, agentInstanceRef);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(runRoot, "engine.sqlite"),
			...harness.options,
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
		try {
			const first = await harness.start(runtime, {
				commandId: "s31-openai-stream-command-1",
				agentInstanceId,
				executionId: "s31-openai-stream-execution-1",
				attemptId: "s31-openai-stream-attempt-1",
				cwd,
				input: "S31_T2_DURABLE_PREFIX",
			});
			await runtime.drain();
			const interrupted = await runtime.store.getAttempt("s31-openai-stream-attempt-1");
			const firstEvents = (await runtime.store.pendingEvents()).filter(
				event => event.attemptId === "s31-openai-stream-attempt-1",
			);
			expect(interrupted?.state).toBe("interrupted");
			expect(requests).toBe(1);
			expect(firstEvents.filter(event => event.kind === "model_settled")).toHaveLength(1);
			// model_settled is an ordinary kind: payload is the plain record the Engine wrote.
			const settled = firstEvents.filter(event => event.kind === "model_settled") as EngineOrdinaryEvent[];
			expect(settled[0]?.payload?.status).toBe("failed");
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

			const continued = await harness.start(runtime, {
				commandId: "s31-openai-stream-command-2",
				agentInstanceId,
				executionId: "s31-openai-stream-execution-2",
				attemptId: "s31-openai-stream-attempt-2",
				expectedIntentRevision: first.intentRevision,
				explicitContinue: true,
				cwd,
				input: "Continue explicitly after the interrupted stream.",
			});
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
