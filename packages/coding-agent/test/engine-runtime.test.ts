import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { AgentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	EngineControlInitiator,
	EngineEvent,
	EngineInboxItem,
	EngineOrdinaryEvent,
	EngineStartRequest,
} from "@oh-my-pi/pi-coding-agent/engine/contracts";
import { EngineTargetError, validateStartRequest } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import {
	EngineControlQueryClient,
	runEngineCommand,
	startEngineControlQueryServer,
} from "@oh-my-pi/pi-coding-agent/engine/control-query";
import {
	dispatchEngineCommand,
	type EngineCommandEnvelope,
	engineCommandIdentity,
} from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import { engineAgentId, engineAgentInstanceId } from "@oh-my-pi/pi-coding-agent/engine/route";
import { EngineRuntime, type EngineRuntimeOptions } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import {
	type RuntimeScope,
	runtimeLimits,
	runtimeRemainingWork,
	validateRuntimeValue,
} from "@oh-my-pi/pi-coding-agent/engine/runtime-protocol";
import { hostedCoreMcpConfig } from "@oh-my-pi/pi-coding-agent/engine/service";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as mcpConfig from "@oh-my-pi/pi-coding-agent/mcp/config";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { withOriginalAttachment } from "@oh-my-pi/pi-coding-agent/session/original-attachments";
import {
	parseNativeSessionLocator,
	RocksNativeSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/rocks-native-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StorageClientError, storageCanonicalJson } from "@oh-my-pi/pi-coding-agent/session/storage-client";
import { normalizeModelContextImages } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { removeSyncWithRetries, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import { ProviderAdmissionClient } from "../src/engine/provider-admission";
import { Database } from "bun:sqlite";
import { startStorageWorker, storageBlobsDir } from "./helpers/storage-worker-fixture";
import { semanticBinding } from "./helpers/runtime-v1-rocks-fixture";
import {
	admitStart,
	admitRequest,
	admittedExecution,
	approvalDecisionFor,
	startEnvelope,
	startRequest,
	type AdmittedExecutionFixture,
} from "./helpers/engine-runtime-admitted-fixture";

const storageExecutable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const storageRunRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;

describe.skipIf(!(storageExecutable && storageRunRoot))("EngineRuntime", () => {
	const tempDirs: string[] = [];
	const testRuntimes: EngineRuntime[] = [];
	const savedStorageEnv = { binding: process.env.GRIMOIRE_STORAGE_BINDING, blobs: process.env.PI_BLOBS_DIR };
	let storage: { stop(): Promise<void>; blobsDir: string } | undefined;
	async function openRuntime(options: EngineRuntimeOptions) {
		const runtime = await EngineRuntime.create(options);
		testRuntimes.push(runtime);
		return runtime;
	}
	let sharedDir: string;
	let modelRegistry: ModelRegistry;
	let auth: AuthStorage;

	beforeAll(() => {
		registerMockApi("engine-runtime-test");
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-engine-runtime-shared-"));
		auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		auth.setRuntimeApiKey("mock", "test-key");
		modelRegistry = new ModelRegistry(auth, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		auth.close();
		removeSyncWithRetries(sharedDir);
	});

	afterEach(async () => {
		const failures: unknown[] = [];
		for (const runtime of testRuntimes.splice(0))
			try { await runtime.dispose(); } catch (error) { failures.push(error); }
		try { await storage?.stop(); } catch (error) { failures.push(error); }
		storage = undefined;
		for (const [name, value] of [
			["GRIMOIRE_STORAGE_BINDING", savedStorageEnv.binding],
			["PI_BLOBS_DIR", savedStorageEnv.blobs],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		for (const dir of tempDirs.splice(0))
			try { removeSyncWithRetries(dir); } catch (error) { failures.push(error); }
		if (failures.length) throw new AggregateError(failures, "Runtime fixture teardown failed");
	});

	/** One real Rust owner per test; every runtime and restart in that test binds to it. */
	async function testStorage() {
		if (!storage) {
			const root = fs.mkdtempSync(path.join(storageRunRoot!, "engine-runtime-storage-"));
			tempDirs.push(root);
			const worker = await startStorageWorker(
				storageExecutable!,
				root,
				`${crypto.randomUUID()}${crypto.randomUUID()}`,
				1,
			);
			storage = { stop: () => worker.stop(), blobsDir: storageBlobsDir(root) };
			process.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(worker.binding);
			process.env.PI_BLOBS_DIR = storage.blobsDir;
		}
		return storage;
	}


	async function createRuntime(
		execution: AdmittedExecutionFixture,
		dispatchPrompt: EngineRuntimeOptions["dispatchPrompt"] = undefined,
		overrides: Partial<EngineRuntimeOptions> = {},
		additionalExecutions: readonly AdmittedExecutionFixture[] = [],
		/** Extra overrides sealed into the same read-only snapshot Engine mode requires. */
		settingsOverrides: Parameters<typeof Settings.isolated>[0] = {},
	) {
		const { blobsDir } = await testStorage();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-runtime-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const agentDir = path.join(tempDir, "agent");
		const settings = await Settings.loadReadOnly({
			cwd,
			agentDir,
			overrides: { "bash.autoBackground.enabled": true, ...settingsOverrides },
		});
		const executions = [execution, ...additionalExecutions];
		const options: EngineRuntimeOptions = {
			databasePath: path.join(tempDir, "engine.sqlite"),
			attachmentBlobStore: new BlobStore(blobsDir),
			dispatchPrompt,
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
			},
			...execution.optionsFor({ deviceId: "engine-runtime-test-device" }),
			resolveExecution: (config, frozen, attempt, resolverCwd, signal) => {
				const selected = executions.find(item => storageCanonicalJson(item.config) === storageCanonicalJson(config));
				if (!selected) throw new Error("Unregistered fixture execution");
				return selected.optionsFor({ deviceId: "engine-runtime-test-device" })
					.resolveExecution!(config, frozen, attempt, resolverCwd, signal);
			},
			verifyOriginReceipt: identity => {
				const selected = executions.find(item => item.receipts.has(identity.originReceiptId));
				if (!selected) throw new Error("Unregistered fixture receipt");
				return selected.optionsFor({ deviceId: "engine-runtime-test-device" }).verifyOriginReceipt!(identity);
			},
			...overrides,
		};
		const runtime = await openRuntime(options);
		return { runtime, cwd, options, blobsDir, execution };
	}

	/** Open the retained native session of a runtime binding exactly as the Engine stores it. */
	async function nativeSession(runtime: EngineRuntime, locator: string) {
		const { familyId, generationId } = parseNativeSessionLocator(locator);
		const manager = await SessionManager.openNative(
			new RocksNativeSessionStorage(runtime.store.storageClient, familyId, generationId),
		);
		await manager.materializeHistory();
		return manager;
	}

	/** The retained native history of an AgentInstance as the public history page projects it. */
	async function nativeHistory(runtime: EngineRuntime, agentInstanceId: string, taskRef?: string) {
		const page = await runtime.sessionHistoryPage(
			agentInstanceId,
			`grimoire://tasks/grimoire/${taskRef ?? "runtime-test"}/agents/${agentInstanceId}`,
			undefined,
			runtimeLimits.httpPageRecords,
		);
		// elapsedMs measures the read itself, not the history.
		const { elapsedMs: _elapsedMs, ...stable } = page;
		return { ...stable, leafEntryId: page.anchor, sessionLeafEntryId: page.anchor };
	}

	/** Header and entries of a retained native session, in the shape of a loaded session file. */
	async function retainedEntries(runtime: EngineRuntime, locator: string) {
		const manager = await nativeSession(runtime, locator);
		return { entries: [manager.getHeader()!, ...manager.getEntries()] };
	}

	/**
	 * A model that calls one tool, then answers. Native storage settles a tool effect only once its toolResult is
	 * durable, so tool scenarios run through the agent loop instead of calling `execute` directly.
	 */
	function toolTurnModel(toolCallId: string, name: string, args: Record<string, unknown>) {
		return createMockModel({
			responses: [
				{ content: [{ type: "toolCall" as const, id: toolCallId, name, arguments: args }] },
				{ content: ["done"] },
			],
		});
	}

	/** The toolResult the model received for one call, if the loop got that far. */
	function toolResultOf(mock: MockModel, toolCallId: string) {
		return mock.calls
			.flatMap(call => call.context.messages)
			.find(
				(message): message is ToolResultMessage =>
					message.role === "toolResult" && message.toolCallId === toolCallId,
			);
	}

	it("lets a native text model read an uploaded file without UI and retains the original handle after restart", async () => {
		const payload = "first line\nORIGINAL_FILE_CONTENT_42\nlast line\n";
		let calls = 0;
		let uri = "";
		const mock = createMockModel({
			handler: context => {
				if (++calls % 2 === 1) {
					const user = context.messages.filter(message => message.role === "user").at(-1)!;
					const text =
						typeof user.content === "string"
							? user.content
							: user.content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("\n");
					expect(text).not.toContain("ORIGINAL_FILE_CONTENT_42");
					uri = text.match(/attachment:\/\/original\/message\/[A-Za-z0-9%_-]+\/0/)?.[0] ?? "";
					expect(uri).not.toBe("");
					return { content: [{ type: "toolCall", name: "read", arguments: { path: `${uri}:2` } }] };
				}
				const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
				expect(result.isError).not.toBeTrue();
				expect(JSON.stringify(result.content)).toContain("ORIGINAL_FILE_CONTENT_42");
				return { content: ["read completed"] };
			},
		});
		// Negative Start: a separately admitted execution whose tool ceiling omits `read`.
		const deniedExecution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["glob"], restrictToolNames: true },
		});
		// Positive Start: the admitted execution with `read` in its tool ceiling.
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true },
		});
		const setup = await createRuntime(execution, undefined, {}, [deniedExecution]);
		// The denied Start runs on the same runtime but its own typed config and receipt.
		const deniedRuntime = setup.runtime;
		try {
			await setup.runtime.attachmentUploads.stage("alice", {
				uploadId: "file-upload",
				clientMessageId: "file-message",
				name: "notes.txt",
				mediaType: "text/plain",
				bytes: Buffer.byteLength(payload),
				contentHash: `sha256:${new Bun.SHA256().update(payload).digest("hex")}`,
				offset: 0,
				contentBase64: Buffer.from(payload).toString("base64"),
			});
			const request = (commandId: string, attempt: string, executable: string) =>
				startRequest(execution, {
					commandId, agentInstanceId: "file-agent",
					agentInstanceRef: "grimoire://tasks/grimoire/file-test/agents/one",
					executionId: `file-${executable}`, attemptId: attempt,
				}, { cwd: setup.cwd, principalId: "alice", clientMessageId: "file-message" });
			const denied = startRequest(deniedExecution, {
				commandId: "file-denied", agentInstanceId: "file-denied-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/file-test/agents/denied",
				executionId: "file-denied", attemptId: "file-denied-attempt",
			}, { cwd: setup.cwd, principalId: "alice", clientMessageId: "file-message" });
			denied.attachmentUploadIds = ["file-upload"];
			await expect(admitRequest(deniedRuntime, denied)).rejects.toMatchObject({
				code: "attachment_requires_read", message: expect.stringContaining("notes.txt"),
			});
			expect(calls).toBe(0);
			expect(await deniedRuntime.store.getAttempt("file-denied-attempt")).toBeUndefined();
			const startedRequest = request("file-start", "file-attempt", "start");
			startedRequest.attachmentUploadIds = ["file-upload"];
			startedRequest.explicitContinue = true;
			const started = await admitRequest(setup.runtime, startedRequest);
			await setup.runtime.drain();
			expect(calls).toBe(2);
			const ref = "grimoire://tasks/grimoire/file-test/agents/one";
			const page = await setup.runtime.sessionHistoryPage("file-agent", ref);
			const user = page.entries.find(entry => entry.role === "user")!;
			expect(user.text).toBe("");
			expect(user.attachments?.[0]).toMatchObject({ name: "notes.txt", status: "available" });
			await setup.runtime.dispose();
			const restarted = await openRuntime(setup.options);
			const originalUri = uri;
			const resumed = request("file-resume", "file-resume-attempt", "resume");
			resumed.explicitContinue = true;
			await admitRequest(restarted, resumed);
			await restarted.drain();
			expect(calls).toBe(4);
			expect(uri).toBe(originalUri);
			const manager = await nativeSession(restarted, started.sessionFile!);
			let copiedPath = "";
			expect(
				await withOriginalAttachment(manager, uri, async filePath => {
					copiedPath = filePath;
					return Bun.file(filePath).text();
				}),
			).toBe(payload);
			expect(fs.existsSync(copiedPath)).toBeFalse();
			await expect(
				withOriginalAttachment(SessionManager.inMemory(), uri, async () => "must not run"),
			).rejects.toThrow("session branch");
			const controller = new AbortController();
			controller.abort();
			await expect(
				withOriginalAttachment(manager, uri, async () => "must not run", controller.signal),
			).rejects.toThrow();
			await expect(
				withOriginalAttachment(manager, uri, async filePath => {
					copiedPath = filePath;
					throw new Error("read failed");
				}),
			).rejects.toThrow("read failed");
			expect(fs.existsSync(copiedPath)).toBeFalse();
			const original = user.attachments![0].resource!;
			fs.writeFileSync(
				path.join(new BlobStore(setup.blobsDir).liveDir, original.contentHash.slice(7)),
				Buffer.alloc(original.bytes, 65),
			);
			await expect(withOriginalAttachment(manager, uri, async () => "must not run")).rejects.toThrow("SHA-256");
		} finally {
			for (const runtime of testRuntimes.splice(0)) await runtime.dispose();
		}
	});

	it("refuses missing or unsupported images before model dispatch and leaves failed queued delivery pending", async () => {
		const mock = createMockModel({ handler: { content: ["must not run"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const vision = createMockModel({ handler: { content: ["image accepted"] } });
		vision.input.push("image");
		const visionExecution = admittedExecution(vision.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, undefined, {}, [visionExecution]);
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			"base64",
		);
		const request = startRequest(execution, {
			commandId: "reject-start", agentInstanceId: "reject-agent",
			agentInstanceRef: "grimoire://tasks/grimoire/image-reject/agents/one",
			executionId: "reject-execution", attemptId: "reject-attempt",
		}, { cwd, principalId: "alice", clientMessageId: "image-message" });
		request.attachmentUploadIds = ["image"];
		await expect(admitRequest(runtime, request)).rejects.toMatchObject({ code: "attachment_expired" });
		await runtime.attachmentUploads.stage("alice", {
			uploadId: "image",
			clientMessageId: "image-message",
			name: "pixel.png",
			mediaType: "image/png",
			bytes: png.length,
			contentHash: `sha256:${new Bun.SHA256().update(png).digest("hex")}`,
			offset: 0,
			contentBase64: png.toString("base64"),
		});
		await expect(admitRequest(runtime, request)).rejects.toMatchObject({
			code: "attachment_requires_images",
			message: expect.stringContaining('Image "pixel.png" cannot be sent'),
		});
		expect(mock.calls).toHaveLength(0);
		expect(await runtime.store.getAttempt(request.attemptId)).toMatchObject({ state: "failed" });
		expect((await runtime.store.records.get("metadata", `slot-lease:${request.attemptId}`)).value).toBeNull();
		expect(await runtime.store.attemptToolEffects(request.attemptId)).toEqual([]);
		const queued = await runtime.enqueueAgentInbox(request.agentInstanceId, {
			sourceEventId: "image-message",
			sourceType: "user",
			body: "",
			attachments: { principalId: "alice", uploadIds: ["image"] },
		});
		const queuedRequest = {
			...request,
			commandId: "queued-image-start", attemptId: "queued-image-attempt", executionId: "queued-image-execution",
			originReceiptId: "origin:queued-image-start",
			attachmentUploadIds: undefined,
			queueId: queued.item.queueId,
			expectedRevision: queued.item.revision,
			mutationId: "consume-refused",
			expectedIntentRevision: (await runtime.store.intent(request.agentInstanceId)).intentRevision,
			explicitContinue: true,
		};
		// The queued message owns its accepted image, so delivery fails on the route, not on the upload.
		await expect(admitRequest(runtime, queuedRequest)).rejects.toMatchObject({ code: "attachment_requires_images" });
		expect(await runtime.store.getInboxItemByQueueId(queued.item.queueId)).toMatchObject({
			disposition: "pending", sessionId: queued.item.sessionId, revision: queued.item.revision,
		});
		expect(mock.calls).toHaveLength(0);
		expect(await admitRequest(runtime, queuedRequest)).not.toHaveProperty("queueRevision");
		expect((await runtime.store.records.get("command", queuedRequest.commandId)).value).toMatchObject({
			receipt: { outcome: "applied", detail: { phase: "applied" } },
		});
		const delivered = await admitRequest(runtime, startRequest(visionExecution, {
			commandId: "queued-image-valid", attemptId: "queued-image-valid-attempt", executionId: "queued-image-valid-execution",
			agentInstanceId: request.agentInstanceId, agentInstanceRef: request.agentInstanceRef,
		}, {
			cwd, principalId: "alice", queueId: queued.item.queueId, expectedRevision: queued.item.revision,
			mutationId: "consume-valid-image", explicitContinue: true,
			expectedIntentRevision: (await runtime.store.intent(request.agentInstanceId)).intentRevision,
		}));
		await runtime.drain();
		expect(vision.calls).toHaveLength(1);
		expect(await runtime.store.getInboxItemByQueueId(queued.item.queueId)).toMatchObject({
			disposition: "acknowledged", revision: queued.item.revision + 1, attemptId: delivered.attemptId,
		});
		const imageHistory = await nativeSession(runtime, delivered.sessionFile!);
		expect(imageHistory.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"))
			.toMatchObject([{ clientMessageId: "image-message", sourceCommandId: "queued-image-valid",
				originalAttachments: [{ name: "pixel.png" }] }]);
	});

	it("runs two independent roots on one shared runtime and disposes only the targeted root", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const request = (suffix: string) =>
			startRequest(execution, {
				commandId: `command-${suffix}`, agentInstanceId: `agent-${suffix}`,
				agentInstanceRef: `grimoire://tasks/grimoire/shared-runtime/agents/agent-${suffix}`,
				executionId: `execution-${suffix}`, attemptId: `attempt-${suffix}`,
			}, { cwd, principalId: "owner", input: suffix.toUpperCase() });
		const first = await admitRequest(runtime, request("a"));
		const second = await admitRequest(runtime, request("b"));
		await runtime.drain();
		const firstSession = runtime.agentRegistry.get(first.engineAgentId)?.session;
		const secondSession = runtime.agentRegistry.get(second.engineAgentId)?.session;
		expect(firstSession).toBeDefined();
		expect(secondSession).toBeDefined();
		expect(firstSession).not.toBe(secondSession);

		const release = Promise.withResolvers<string>();
		const jobId = runtime.asyncJobManager.register("bash", "agent-a job", async () => release.promise, {
			ownerId: first.engineAgentId,
			attemptId: first.attemptId,
		});
		await runtime.release(second);
		expect(runtime.asyncJobManager.getJob(jobId)?.status).toBe("running");
		expect(runtime.getBinding(second.agentInstanceId)).toBeUndefined();
		expect(runtime.getBinding(first.agentInstanceId)).toBeDefined();
		release.resolve("done");
		await runtime.asyncJobManager.waitForAll();
		await runtime.dispose();
	}, 60000);

	it("reuses an idle root for a new Attempt and rejects stale generation fences", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const request = (suffix: string, attemptId: string) =>
			startRequest(execution, {
				commandId: `command-${suffix}`, agentInstanceId: "agent-a",
				agentInstanceRef: "grimoire://tasks/grimoire/shared-runtime/agents/agent-a",
				executionId: `execution-${suffix}`, attemptId,
			}, { cwd, principalId: "owner", input: suffix.toUpperCase() });
		const first = await admitRequest(runtime, request("a", "attempt-a"));
		await runtime.drain();
		const second = await admitRequest(runtime, request("b", "attempt-b"));
		expect(second.bindingGeneration).toBe(first.bindingGeneration + 1);
		// The idle root retains its native conversation: the new Attempt continues the same session file.
		expect(second.sessionFile).toBe(first.sessionFile);
		// The same Attempt id already exists bound to another execution.
		await expect(admitRequest(runtime, request("c", "attempt-b"))).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			runtime.cancel({ ...second, commandId: "cancel-stale", bindingGeneration: second.bindingGeneration + 1 }),
		).rejects.toMatchObject({ code: "stale_target" });
		await runtime.drain();
		await runtime.dispose();
	}, 60000);

	it("bounds canonical presentation fields at Engine admission", () => {
		const execution = admittedExecution(createMockModel().model, modelRegistry);
		const base = startRequest(execution, {
			commandId: "command-validation", agentInstanceId: "agent-validation",
			agentInstanceRef: "grimoire://tasks/grimoire/validation/agents/agent-validation",
			executionId: "execution-validation", attemptId: "attempt-validation",
		}, { cwd: process.cwd(), principalId: "owner", input: "verify" });
		expect(() => validateStartRequest({ ...base, displayName: "" })).toThrow("displayName");
		expect(() => validateStartRequest({ ...base, displayName: "x".repeat(65) })).toThrow("displayName");
		expect(() => validateStartRequest({ ...base, delegationHint: "line one\nline two" })).toThrow("delegationHint");
		expect(() =>
			validateStartRequest({ ...base, displayName: "Schema Sentinel", delegationHint: "UI/UX review" }),
		).not.toThrow();
	});

	it("uses canonical presentation fields without changing the Engine agent route", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-named", agentInstanceId: "agent-machine-identity",
			agentInstanceRef: "grimoire://tasks/grimoire/naming/agents/agent-machine-identity",
			executionId: "execution-named", attemptId: "attempt-named",
		}, {
			cwd, principalId: "owner", input: "verify naming",
			displayName: "Schema Sentinel", delegationHint: "PostgreSQL migration review",
		}));
		await runtime.drain();
		const ref = runtime.agentRegistry.get(started.engineAgentId);
		expect(started.engineAgentId).toBe(engineAgentId("agent-machine-identity"));
		expect(ref).toMatchObject({
			id: started.engineAgentId,
			displayName: "Schema Sentinel",
			delegationHint: "PostgreSQL migration review",
		});
		await runtime.dispose();
	}, 60000);

	it("fails closed when Engine mode has no explicit Settings snapshot", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const setup = await createRuntime(execution, async () => true);
		// Remove the explicit settings: Engine mode must refuse to start with ambient settings.
		const options: EngineRuntimeOptions = { ...setup.options };
		if (options.sessionDefaults) options.sessionDefaults = { ...options.sessionDefaults, settings: undefined };
		const runtime = await openRuntime(options);
		await expect(
			admitRequest(runtime, startRequest(execution, {
				commandId: "command-missing-settings", agentInstanceId: "agent-missing-settings",
				agentInstanceRef: "grimoire://tasks/grimoire/settings/agents/agent-missing-settings",
				executionId: "execution-missing-settings", attemptId: "attempt-missing-settings",
			}, { cwd: setup.cwd, principalId: "owner", input: "must fail before startup" })),
		).rejects.toThrow("Engine mode requires explicit");
		await runtime.dispose();
	});

	it("rejects an Engine Settings snapshot captured for another cwd", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const setup = await createRuntime(execution, async () => true);
		const options: EngineRuntimeOptions = { ...setup.options };
		if (options.sessionDefaults)
			options.sessionDefaults = {
				...options.sessionDefaults,
				settings: await Settings.loadReadOnly({ cwd: process.cwd() }),
			};
		const runtime = await openRuntime(options);
		await expect(
			admitRequest(runtime, startRequest(execution, {
				commandId: "command-mismatched-settings", agentInstanceId: "agent-mismatched-settings",
				agentInstanceRef: "grimoire://tasks/grimoire/settings/agents/agent-mismatched-settings",
				executionId: "execution-mismatched-settings", attemptId: "attempt-mismatched-settings",
			}, { cwd: setup.cwd, principalId: "owner", input: "must fail before startup" })),
		).rejects.toThrow("Engine settings cwd does not match session cwd");
		await runtime.dispose();
	});

	it("keeps the native lease until an admitted side model quiesces at Pause, then resumes the same Attempt", async () => {
		const primaryEntered = Promise.withResolvers<void>();
		const releasePrimary = Promise.withResolvers<void>();
		const sideEntered = Promise.withResolvers<void>();
		const releaseSide = Promise.withResolvers<void>();
		const primaryParked = Promise.withResolvers<AgentPauseGate>();
		const wait = AgentPauseGate.prototype.waitUntilResumed;
		const gateObserver = spyOn(AgentPauseGate.prototype, "waitUntilResumed").mockImplementation(function (
			this: AgentPauseGate, signal?: AbortSignal,
		) {
			const pending = wait.call(this, signal);
			if (this.parked) primaryParked.resolve(this);
			return pending;
		});
		const mock = createMockModel({
			baseUrl: "https://side-pause.invalid/v1",
			responses: [
				async () => {
					primaryEntered.resolve();
					await releasePrimary.promise;
					return { content: ["primary before pause"] };
				},
				async (_context, options) => {
					await options!.fetch!("https://side-pause.invalid/v1/completions");
					return { content: ["side completed"] };
				},
				{ content: ["sibling used released slot"] },
				{ content: ["same Attempt resumed"] },
			],
		});
		const execution = admittedExecution(mock.model, modelRegistry, { scopeAgents: 1 });
		const resolver = execution.optionsFor({ deviceId: "engine-runtime-test-device" }).resolveExecution!;
		const provider = mockProviderFetch("https://side-pause.invalid/", async () => {
			sideEntered.resolve();
			await releaseSide.promise;
			return new Response("ok");
		});
		let created: Awaited<ReturnType<typeof createRuntime>> | undefined;
		try {
			created = await createRuntime(execution, (session, input, identity) => session.prompt(input, identity), {
				resolveExecution: async (config, frozen, attempt, resolverCwd, signal) => {
					const resolved = await resolver(config, frozen, attempt, resolverCwd, signal);
					const route = config.routes.routes[0]!;
					resolved.options.providerRequestHook = new ProviderAdmissionClient(
						"http://admission.invalid", "fixture", async () => Response.json({ allowed: true }),
					).createHook(undefined, auth, "", [{
						...attempt, routeRef: route.route_ref, routeContentHash: `sha256:${"a".repeat(64)}`,
						providerAccountRef: route.account_ref, providerAccountContentHash: `sha256:${"b".repeat(64)}`,
						credentialGeneration: 1, providerId: mock.model.provider, runtimeProviderId: mock.model.provider,
						modelId: mock.model.id, baseUrl: mock.model.baseUrl,
					}]);
					return resolved;
				},
			});
			const { runtime, cwd } = created;
			const request = (id: string) => startRequest(execution, {
				commandId: `${id}-start`, agentInstanceId: id, agentInstanceRef: `${execution.taskRef}/agents/${id}`,
				executionId: `${id}-execution`, attemptId: `${id}-attempt`,
			}, { cwd, principalId: "owner", input: id });
			const started = await admitRequest(runtime, request("side-pause"));
			await primaryEntered.promise;
			const session = runtime.agentRegistry.get(started.engineAgentId)!.session!;
			const side = session.runEphemeralTurn({ promptText: "independent side request" })
				.then(value => value, error => error);
			await withTimeout(sideEntered.promise, 5_000, "Side request did not reach its admitted provider");
			const paused = nextEngineEvent(runtime, "paused", started.attemptId);
			const hold = await runtime.pause({ ...started, commandId: "pause-side",
				initiator: { kind: "human" }, expectedIntentRevision: started.intentRevision });
			releasePrimary.resolve();
			const gate = await withTimeout(primaryParked.promise, 5_000, "Primary did not park");
			expect(gate.parked).toBe(true);
			// The provider stays held throughout this observation; primary parking alone cannot release its lease.
			await scheduler.wait(50);
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("pause_requested");
			expect(await runtime.store.runtimeCommand("side-pause-start")).toMatchObject({ lease: { held: true } });
			releaseSide.resolve();
			expect(await side).toMatchObject({ replyText: "side completed" });
			await withTimeout(paused, 5_000, "Pause did not finish after side settlement");
			expect(await runtime.store.runtimeCommand("side-pause-start")).toMatchObject({ lease: { held: false } });
			const siblingCompleted = nextEngineEvent(runtime, "completed", "side-sibling-attempt");
			await admitRequest(runtime, request("side-sibling"));
			await withTimeout(siblingCompleted, 5_000, "Sibling could not use the released native slot");
			await runtime.resume({ ...started, commandId: "resume-side", initiator: { kind: "human" },
				expectedIntentRevision: hold.intentRevision, principalId: "owner",
				message: "continue this Attempt", clientMessageId: "side-resume-message" });
			await runtime.drain();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
			const events = await runtime.store.pendingEvents();
			const sideSettlement = events.find(event => event.attemptId === started.attemptId &&
				event.kind === "model_settled" && Array.isArray(event.payload?.requests) && event.payload.requests.length > 0);
			const pauseEvent = events.find(event => event.attemptId === started.attemptId && event.kind === "paused");
			expect(sideSettlement!.eventId).toBeLessThan(pauseEvent!.eventId);
			expect(mock.calls).toHaveLength(4);
		} finally {
			releasePrimary.resolve();
			releaseSide.resolve();
			try {
				await created?.runtime.dispose();
			} finally {
				gateObserver.mockRestore();
				provider.mockRestore();
			}
		}
	}, 30_000);

	it("waits for a pause_requested safe point before admitting the message and continuing", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["first turn"] };
				},
				{ content: ["corrected turn"] },
			],
		});
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input, identity) =>
			session.prompt(input, identity));
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "requested-resume-start", agentInstanceId: "requested-resume-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/requested-resume/agents/one",
				executionId: "requested-resume-execution", attemptId: "requested-resume-attempt",
			}, { cwd, principalId: "alice", input: "first" }));
			await entered.promise;
			const paused = nextEngineEvent(runtime, "paused", started.attemptId);
			const hold = await runtime.pause({
				...started,
				commandId: "requested-resume-pause",
				initiator: { kind: "human" },
				expectedIntentRevision: started.intentRevision,
			});
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("pause_requested");
			const resuming = runtime.resume({
				...started,
				commandId: "requested-resume-message",
				initiator: { kind: "human" },
				expectedIntentRevision: hold.intentRevision,
				principalId: "alice",
				message: "correct first answer",
				clientMessageId: "requested-resume-client",
			});
			await Promise.resolve();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("pause_requested");
			expect(runtime.agentRegistry.get(started.engineAgentId)?.session?.sessionManager.getContextBranch().some(
				entry => entry.type === "message" && entry.clientMessageId === "requested-resume-client",
			)).toBeFalse();
			expect(mock.calls).toHaveLength(1);
			release.resolve();
			await paused;
			expect(await resuming).toMatchObject({ manualHold: false, intentRevision: hold.intentRevision + 1 });
			await runtime.drain();
			expect(mock.calls).toHaveLength(2);
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
			expect((await retainedEntries(runtime, started.sessionFile!)).entries.filter(
				entry => entry.type === "message" && entry.clientMessageId === "requested-resume-client",
			)).toHaveLength(1);
		} finally {
			release.resolve();
			await runtime.dispose();
		}
	}, 60_000);

	it("fences a Stop racing Resume by the current intent and rejects delayed controls", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const mock = createMockModel({ responses: [async () => {
			await prompt.promise;
			return { content: ["answer"] };
		}] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "paused-cancel-start", agentInstanceId: "paused-cancel-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/paused-cancel/agents/one",
				executionId: "paused-cancel-execution", attemptId: "paused-cancel-attempt",
			}, { cwd, principalId: "alice", input: "wait" }));
			const pauseResult = await runtime.pause({
				...started,
				commandId: "pause-before-cancel",
				initiator: { kind: "human" },
				expectedIntentRevision: started.intentRevision,
			});
			const resume = runtime.resume({
				...started,
				commandId: "resume-before-stop",
				initiator: { kind: "human" },
				expectedIntentRevision: pauseResult.intentRevision,
			});
			const staleStop = runtime.cancel({
				...started,
				commandId: "stale-stop",
				expectedIntentRevision: pauseResult.intentRevision,
			});
			const resumed = await resume;
			await expect(staleStop).rejects.toMatchObject({ code: "stale_target" });
			expect((await runtime.store.getBinding(started.agentInstanceId))?.manualHold).toBeFalse();
			const stopped = await runtime.cancel({
				...started,
				commandId: "current-stop",
				expectedIntentRevision: resumed.intentRevision,
			});
			expect(stopped).toMatchObject({ manualHold: true, intentRevision: resumed.intentRevision + 1 });
			prompt.resolve(true);
			await runtime.drain();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
			await expect(
				runtime.resume({
					...started,
					commandId: "late-resume",
					initiator: { kind: "human" },
					expectedIntentRevision: pauseResult.intentRevision,
				}),
			).rejects.toMatchObject({ code: "stale_target" });
			const events = await runtime.store.pendingEvents();
			expect(events.some(event => event.kind === "resumed")).toBeTrue();
			expect(
				events.find(event => event.kind === "cancelled" && event.causationCommandId === "current-stop"),
			).toBeDefined();
			expect(events.some(event => event.causationCommandId === "stale-stop")).toBeFalse();
		} finally {
			prompt.resolve(true);
			await runtime.dispose();
		}
	}, 60000);

	it("admits a paused user message before releasing the same Attempt and replays it once", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["initial answer"] };
				},
				{ content: ["answer after correction"] },
			],
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input, identity) =>
			session.prompt(input, identity));
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "paused-message-start", agentInstanceId: "paused-message-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/paused-message/agents/one",
				executionId: "paused-message-execution", attemptId: "paused-message-attempt",
			}, { cwd, principalId: "alice", input: "initial work" }));
			await entered.promise;
			const paused = nextEngineEvent(runtime, "paused", started.attemptId);
			const hold = await runtime.pause({
				...started,
				commandId: "paused-message-hold",
				initiator: { kind: "human" },
				expectedIntentRevision: started.intentRevision,
			});
			release.resolve();
			await paused;
			const attachmentBody = Buffer.from("accepted paused attachment");
			await runtime.attachmentUploads.stage("alice", {
				uploadId: "paused-message-file",
				clientMessageId: "paused-message-client",
				name: "correction.txt",
				mediaType: "text/plain",
				bytes: attachmentBody.length,
				contentHash: `sha256:${new Bun.SHA256().update(attachmentBody).digest("hex")}`,
				offset: 0,
				contentBase64: attachmentBody.toString("base64"),
			});
			const resume = {
				...started,
				commandId: "paused-message-resume",
				principalId: "alice",
				initiator: { kind: "human" } as const,
				expectedIntentRevision: hold.intentRevision,
				message: "Use the corrected instructions",
				clientMessageId: "paused-message-client",
				attachmentUploadIds: ["paused-message-file"],
				context: '{"instructions":"separate from the user message"}',
			};
			await expect(runtime.resume({ ...resume, expectedIntentRevision: started.intentRevision }))
				.rejects.toMatchObject({ code: "stale_target" });
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
			expect(mock.calls).toHaveLength(1);
			await expect(runtime.resume({
				...resume,
				commandId: "paused-message-missing-upload",
				clientMessageId: "paused-message-upload-client",
				message: "",
				attachmentUploadIds: ["missing-upload"],
			})).rejects.toMatchObject({ code: "attachment_expired" });
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
			expect((await runtime.store.intent(started.agentInstanceId)).intentRevision).toBe(hold.intentRevision);
			const session = runtime.agentRegistry.get(started.engineAgentId)!.session!;
			const rejected = spyOn(session, "steer").mockRejectedValueOnce(new Error("message admission unavailable"));
			try {
				await expect(runtime.resume({
					...resume,
					commandId: "paused-message-failed",
					clientMessageId: "paused-message-failed-client",
					attachmentUploadIds: undefined,
				})).rejects.toThrow("message admission unavailable");
			} finally {
				rejected.mockRestore();
			}
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
			expect((await runtime.store.intent(started.agentInstanceId)).intentRevision).toBe(hold.intentRevision);
			const intentFailure = spyOn(runtime.store, "branchIntent")
				.mockRejectedValueOnce(new Error("intent commit unavailable"));
			try {
				await expect(runtime.resume(resume)).rejects.toMatchObject({ code: "message_accepted_resume_unknown" });
			} finally {
				intentFailure.mockRestore();
			}
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
			expect((await runtime.store.intent(started.agentInstanceId)).intentRevision).toBe(hold.intentRevision);
			expect(mock.calls).toHaveLength(1);
			expect((await retainedEntries(runtime, started.sessionFile!)).entries.filter(
				entry => entry.type === "message" && entry.sourceCommandId === resume.commandId,
			)).toHaveLength(1);
			const transition = runtime.store.commitAttemptTransition.bind(runtime.store);
			let failTransition = true;
			const transitionFailure = spyOn(runtime.store, "commitAttemptTransition")
				.mockImplementation((binding, state, events, options) => {
					if (failTransition && state === "running" && events.some(event => event.kind === "resumed")) {
						failTransition = false;
						throw new Error("resume transition unavailable");
					}
					return transition(binding, state, events, options);
				});
			try {
				await expect(runtime.resume(resume)).rejects.toMatchObject({ code: "message_accepted_resume_unknown" });
			} finally {
				transitionFailure.mockRestore();
			}
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
			expect(await runtime.store.intent(started.agentInstanceId)).toMatchObject({
				manualHold: false,
				intentRevision: hold.intentRevision + 1,
			});
			expect(mock.calls).toHaveLength(1);
			expect(await runtime.resume(resume)).toMatchObject({
				manualHold: false,
				intentRevision: hold.intentRevision + 1,
			});
			await runtime.resume(resume);
			await runtime.drain();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("Use the corrected instructions");
			const history = await retainedEntries(runtime, started.sessionFile!);
			expect(history.entries.filter(
				entry => entry.type === "message" && entry.sourceCommandId === resume.commandId,
			)).toMatchObject([
				{
					clientMessageId: resume.clientMessageId,
					message: { role: "user", content: [{ type: "text", text: resume.message }] },
				},
			]);
			const acceptedUser = history.entries.find(
				entry => entry.type === "message" && entry.sourceCommandId === resume.commandId,
			);
			expect(acceptedUser).toMatchObject({
				originalAttachments: [{ name: "correction.txt", mediaType: "text/plain" }],
			});
			expect(history.entries.filter(
				entry => entry.type === "message" && entry.sourceCommandId === "paused-message-failed",
			)).toHaveLength(0);
			expect(history.entries.filter(
				entry => entry.type === "custom_message" && entry.customType === "engine-command-context" &&
					(entry.details as { sourceCommandId?: string } | undefined)?.sourceCommandId === resume.commandId,
			)).toHaveLength(1);
			expect((await runtime.store.pendingEvents()).filter(
				event => event.kind === "resumed" && event.attemptId === started.attemptId,
			)).toHaveLength(1);
		} finally {
			release.resolve();
			await runtime.dispose();
		}
	}, 60_000);

	it("waits for an explicit permit decision before executing a tool", async () => {
		const mock = toolTurnModel("read-permit", "read", { path: "permit.txt" });
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true, toolPolicies: { read: "permit" }, tools_permit: ["read"] },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		fs.writeFileSync(path.join(cwd, "permit.txt"), "approved");
		const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-permit", agentInstanceId: "agent-permit",
			agentInstanceRef: "grimoire://tasks/grimoire/permit/agents/one",
			executionId: "execution-permit", attemptId: "attempt-permit",
		}, { cwd, principalId: "owner", input: "read" }));
		const approval = await approvalRequested;
		const approvalRequest = approval.kind === "tool_approval_requested" ? approval.payload : null;
		if (!approvalRequest) throw new Error("Approval request identity is missing");
		const approvalId = approvalRequest.id;
		expect(toolResultOf(mock, "read-permit")).toBeUndefined();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "planned", policy: "permit" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "pending", decision: null });

		const decision = approvalDecisionFor(execution, started, "command-approve", (await runtime.store.getApproval(approvalId))!.request, "approve");
		await runtime.resolveApproval({ ...started, commandId: "command-approve", approvalDecision: decision });
		await runtime.drain();
		expect(toolResultOf(mock, "read-permit")).toMatchObject({ isError: false });
		expect(JSON.stringify(toolResultOf(mock, "read-permit")?.content)).toContain("approved");
		const events = await runtime.store.pendingEvents();
		const toolKinds = events.filter(event => event.kind.startsWith("tool_")).map(event => event.kind);
		const expectedToolKinds = ["tool_approval_requested", "tool_approval_resolved", "tool_started", "tool_settled"] as const;
		for (const kind of expectedToolKinds) expect(toolKinds).toContain(kind);
		const ordered = expectedToolKinds.map(kind => toolKinds.indexOf(kind));
		expect(ordered.every((index, position) => index >= 0 && (position === 0 || index > ordered[position - 1]))).toBeTrue();
		expect(events.find(event => event.kind === "tool_approval_resolved")?.causationCommandId).toBe("command-approve");
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "completed" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "approve" });
		await runtime.dispose();
	}, 60_000);

	it("cancels an Attempt that is waiting for a tool permit", async () => {
		let executed = false;
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true, toolPolicies: { read: "permit" }, tools_permit: ["read"] },
		});
		const { runtime, cwd } = await createRuntime(execution, async session => {
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-cancelled-permit", { path: "permit.txt" });
			executed = true;
			return true;
		});
		fs.writeFileSync(path.join(cwd, "permit.txt"), "not read");
		const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-cancelled-permit", agentInstanceId: "agent-cancelled-permit",
			agentInstanceRef: "grimoire://tasks/grimoire/permit-cancel/agents/one",
			executionId: "execution-cancelled-permit", attemptId: "attempt-cancelled-permit",
		}, { cwd, principalId: "owner", input: "read" }));
		const approval = await approvalRequested;
		const approvalRequest = approval.kind === "tool_approval_requested" ? approval.payload : null;
		if (!approvalRequest) throw new Error("Approval request identity is missing");
		const approvalId = approvalRequest.id;
		await runtime.cancel({ ...started, commandId: "command-cancel-permit" });
		await runtime.drain();
		expect(executed).toBeFalse();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const events = await runtime.store.pendingEvents();
		const resolvedApproval = events.find(event => event.kind === "tool_approval_resolved");
		expect(resolvedApproval?.kind === "tool_approval_resolved" ? resolvedApproval.payload.outcome : undefined)
			.toBe("cancelled");
		expect(events.find(event => event.kind === "tool_approval_resolved")?.causationCommandId).toBe(
			"command-cancel-permit",
		);
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "cancelled" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "cancelled" });
		await runtime.dispose();
	}, 60_000);

	it("durably denies a permitted tool without executing it", async () => {
		let executed = false;
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true, toolPolicies: { read: "permit" }, tools_permit: ["read"] },
		});
		const { runtime, cwd } = await createRuntime(execution, async session => {
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-denied-permit", { path: "permit.txt" });
			executed = true;
			return true;
		});
		fs.writeFileSync(path.join(cwd, "permit.txt"), "not read");
		const requested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-denied-permit", agentInstanceId: "agent-denied-permit",
			agentInstanceRef: "grimoire://tasks/grimoire/permit-deny/agents/one",
			executionId: "execution-denied-permit", attemptId: "attempt-denied-permit",
		}, { cwd, principalId: "owner", input: "read" }));
		const approvalEvent = await requested;
		const approvalRequest = approvalEvent.kind === "tool_approval_requested" ? approvalEvent.payload : null;
		if (!approvalRequest) throw new Error("Approval request identity is missing");
		const approvalId = approvalRequest.id;
		const decision = approvalDecisionFor(execution, started, "command-deny", (await runtime.store.getApproval(approvalId))!.request, "deny", "not now");
		await runtime.resolveApproval({ ...started, commandId: "command-deny", approvalDecision: decision });
		await runtime.drain();
		expect(executed).toBeFalse();
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "denied" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "deny" });
		await runtime.dispose();
	}, 60_000);

	it.each(["mounted", "nested", "denied", "worker", "worker-denied", "worker-shared-denied", "worker-stop", "parallel", "delayed"] as const)("preserves %s request ownership through the real mounted tool boundary", async mode => {
		const reached = Promise.withResolvers<void>();
		const submitted = Promise.withResolvers<{ isError: boolean; text: string }>();
		const queuedTurn = Promise.withResolvers<void>();
		const delayed = mode === "delayed";
		const release = Promise.withResolvers<void>();
		const allRequested = Promise.withResolvers<void>();
		const independentLive = Promise.withResolvers<void>();
		const shared = mode === "worker-shared-denied";
		let independentLaunched = false;
		const requests: Array<Extract<EngineEvent, { kind: "tool_approval_requested" }>["payload"]> = [];
		const worker = mode.startsWith("worker") || mode === "parallel";
		const evalOperation = worker || delayed;
		const denied = mode.endsWith("denied");
		let continuationOrdinal = 0;
		let phase = 0;
		let requestId = "";
		let decision: { decisionRevision: number; inputRevision: number } | undefined;
		const call = (id: string, name: string, args: Record<string, unknown>) =>
			({ content: [{ type: "toolCall" as const, id, name, arguments: args }] });
		const mock = createMockModel({ handler: async context => {
			if (phase === 1) {
				const submit = context.messages.findLast(message => message.role === "toolResult" && message.toolCallId === "submit-mounted");
				submitted.resolve(submit?.role === "toolResult"
					? { isError: submit.isError === true, text: submit.content.filter(block => block.type === "text").map(block => block.text).join("") }
					: { isError: true, text: "submit-mounted has no tool result" });
			}
			switch (phase++) {
				case 0: return call("submit-mounted", "request", { action: "submit", handling: "nonblocking",
					operation: delayed ? { toolName: "eval", arguments: { language: "js", timeout: 0, code:
						'const pending=tool.read({path:"protected-read.txt"}); await new Promise(resolve=>setTimeout(resolve,1500));' +
						'await tool.write({path:"sibling-after.txt",content:"after"}); display(await pending);' } }
					: worker ? { toolName: "eval", arguments: { language: "js", timeout: 0, code:
						'globalThis.requestKernelMarker="same-kernel"; await tool.write({path:"sibling-before.txt",content:"before"});' +
						(mode === "parallel"
							? 'const value=await Promise.all([tool.read({path:"protected-read.txt"}),tool.read({path:"protected-read.txt"})]);'
							: shared
								? 'let value; try { value=await tool.read({path:"protected-read.txt"}); } catch { value="caught"; }'
								: 'const value=await tool.read({path:"protected-read.txt"});') +
						'await tool.write({path:"sibling-after.txt",content:"after"}); display(value);' } }
						: mode === "mounted" ? { toolName: "read", arguments: { path: "protected-read.txt" } }
							: { toolName: "write", arguments: { path: "xd://read", content: JSON.stringify({ path: "protected-read.txt" }) } } });
				case 1:
					if (shared && !independentLaunched) {
						independentLaunched = true;
						phase = 1;
						return call("independent-eval", "eval", { language: "js", timeout: 0, code:
							'if(globalThis.requestKernelMarker!=="same-kernel") throw new Error("different kernel");' +
							'const independentGate=Promise.withResolvers(); globalThis.releaseIndependent=independentGate.resolve; display("INDEPENDENT_RUNNING"); await independentGate.promise; display("INDEPENDENT_COMPLETED");' });
					}
					reached.resolve();
					if (mode === "worker-stop") { phase = 4; return { content: ["Wait for the request."] }; }
					if (delayed) { phase = 5; return { content: ["Wait for the request."] }; }
					await release.promise;
					return call(`read-mounted-decision-${continuationOrdinal}`, "request", { action: "read", requestId });
				case 2: {
					const result = context.messages.findLast(message => message.role === "toolResult" && message.toolCallId === `read-mounted-decision-${continuationOrdinal}`);
					if (!result || result.role !== "toolResult") throw new Error("Missing delivered decision");
					decision = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join(""));
					return call(`continue-mounted-${continuationOrdinal}`, "request", { action: "continue", requestId,
						expectedDecisionRevision: decision!.decisionRevision, expectedInputRevision: decision!.inputRevision });
				}
				case 3: {
					const result = context.messages.findLast(message => message.role === "toolResult" && message.toolCallId === `continue-mounted-${continuationOrdinal}`);
					if (mode === "parallel" && continuationOrdinal === 0) {
						if (!result || result.role !== "toolResult") throw new Error("Missing next leaf handle");
						const next = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join(""));
						expect(next.status).toBe("pending");
						requestId = next.requestId;
						continuationOrdinal++;
						phase = 2;
						return call(`read-mounted-decision-${continuationOrdinal}`, "request", { action: "read", requestId });
					}
					if (shared) return call("release-independent", "eval", { language: "js", timeout: 0,
						code: 'globalThis.releaseIndependent(); display("RELEASED");' });
					return call("independent-write", "write", { path: "independent-after-request.txt", content: "still authorized" });
				}
				case 4:
					if (shared) return call("independent-write", "write", { path: "independent-after-request.txt", content: "still authorized" });
					return { content: ["done"] };
				case 5: {
					const queued = context.messages.findLast(message => message.role === "user");
					expect(JSON.stringify(queued?.content)).toContain("queued while composite lives");
					queuedTurn.resolve();
					return { content: ["Queued work handled."] };
				}
				case 6:
					phase = 2;
					return call(`read-mounted-decision-${continuationOrdinal}`, "request", { action: "read", requestId });
				default: return { content: ["done"] };
			}
		} });
		const execution = admittedExecution(mock.model, modelRegistry, { continuation: {
			toolNames: ["request", "write", "read", ...(evalOperation ? ["eval"] : [])], restrictToolNames: true, toolPolicies: { read: "permit" }, tools_permit: ["read"],
		} });
		const { runtime, cwd } = await createRuntime(execution, async (session, input, identity) => {
			await session.setActiveToolPresentation(["request", "write", ...(shared ? ["eval"] : [])],
				["read", ...(evalOperation && !shared ? ["eval"] : [])]);
			expect(session.getActiveToolNames()).not.toContain("read");
			expect(session.getEnabledToolNames()).toContain("read");
			return session.prompt(input, identity);
		}, {}, [], { "tools.xdev": true, ...(shared ? { "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 0 } : {}) });
		fs.writeFileSync(path.join(cwd, "protected-read.txt"), "whole-operation-value");
		const register = runtime.asyncJobManager.register.bind(runtime.asyncJobManager);
		const registration = shared ? spyOn(runtime.asyncJobManager, "register").mockImplementation((type, label, run, options) =>
			register(type, label, run, { ...options, onProgress: async (text, details) => {
				if (options?.sourceToolCallId === "independent-eval" && text.includes("INDEPENDENT_RUNNING")) independentLive.resolve();
				await options?.onProgress?.(text, details);
			} })) : undefined;
		const unsubscribe = runtime.subscribe(event => {
			if (event.kind !== "tool_approval_requested") return;
			requests.push(event.payload);
			if (requests.length === (mode === "parallel" ? 2 : 1)) allRequested.resolve();
		});
		try {
			const requested = nextEngineEvent(runtime, "tool_approval_requested");
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: `mounted-${mode}`, agentInstanceId: `mounted-${mode}`,
				agentInstanceRef: `grimoire://tasks/grimoire/requests/agents/mounted-${mode}`,
				executionId: `mounted-execution-${mode}`, attemptId: `mounted-attempt-${mode}`,
			}, { cwd, principalId: "owner", input: "Use the enabled mounted operation" }));
			// The real submit result must be the pending handle of an emitted approval, not an error the model skips past.
			const submit = await withTimeout(submitted.promise, 20_000, "The submit result never reached the model");
			let handle: { status?: unknown; requestId?: unknown; handling?: unknown } | undefined;
			try { handle = JSON.parse(submit.text); } catch { handle = undefined; }
			if (submit.isError || handle?.status !== "pending" || typeof handle.requestId !== "string")
				throw new Error(`Submit did not return a pending handle: ${submit.text}`);
			expect(handle.handling).toBe("nonblocking");
			const event = await withTimeout(requested, 5_000, "A pending handle was returned without its approval request");
			if (event.kind !== "tool_approval_requested") throw new Error("Missing original leaf approval");
			await withTimeout(allRequested.promise, 10_000, "Not every protected leaf requested approval");
			if (mode === "parallel") expect(requests.map(request => request.id)).toContain(handle.requestId);
			else expect(handle.requestId).toBe(event.payload.id);
			requestId = handle.requestId;
			await withTimeout(reached.promise, 10_000, "The model did not take its turn after the pending handle");
			if (shared) await withTimeout(independentLive.promise, 5_000, "Independent eval did not enter the same live kernel");
			if (worker) {
				expect(fs.readFileSync(path.join(cwd, "sibling-before.txt"), "utf8")).toBe("before");
				expect(fs.existsSync(path.join(cwd, "sibling-after.txt"))).toBeFalse();
			}
			if (mode === "worker-stop") {
				// The live evaluator awaiting its leaf is not a proven suspension point.
				await scheduler.wait(100);
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
				await runtime.pause({ ...started, commandId: "pause-worker-request", initiator: { kind: "human" } });
				await scheduler.wait(200);
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("pause_requested");
				expect(await runtime.store.runtimeCommand(`mounted-${mode}`)).toMatchObject({ lease: { held: true } });
				await runtime.resume({ ...started, commandId: "resume-worker-request", initiator: { kind: "human" } });
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
				await runtime.cancel({ ...started, commandId: "stop-worker-request" });
				await runtime.drain();
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
				expect(fs.existsSync(path.join(cwd, "sibling-after.txt"))).toBeFalse();
				expect((await runtime.store.getApproval(requestId))?.request.status).toBe("cancelled");
				expect((await runtime.store.attemptToolEffects(started.attemptId)).filter(effect =>
					effect.state === "started" || effect.state === "planned")).toEqual([]);
				return;
			}
			if (delayed) {
				await scheduler.wait(100);
				await runtime.pause({ ...started, commandId: "pause-delayed-tail", initiator: { kind: "human" } });
				await scheduler.wait(300);
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("pause_requested");
				expect(await runtime.store.runtimeCommand(`mounted-${mode}`)).toMatchObject({ lease: { held: true } });
				expect(fs.existsSync(path.join(cwd, "sibling-after.txt"))).toBeFalse();
				await runtime.resume({ ...started, commandId: "resume-delayed-tail", initiator: { kind: "human" } });
				const tail = path.join(cwd, "sibling-after.txt");
				for (let wait = 0; wait < 100 && !fs.existsSync(tail); wait++) await scheduler.wait(50);
				expect(fs.readFileSync(tail, "utf8")).toBe("after");
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
				await runtime.steer({ ...started, commandId: "steer-delayed-live", message: "queued while composite lives" });
				await withTimeout(queuedTurn.promise, 5_000, "Queued input did not run while the composite root lived");
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
			}
			for (const request of requests) {
				expect(request.handling).toBe("nonblocking");
				expect(JSON.stringify(request)).not.toContain("protected-read.txt");
				const answer = approvalDecisionFor(execution, started, `answer-${mode}-${request.id}`, request, denied ? "deny" : "approve");
				await runtime.resolveApproval({ ...started, commandId: answer.command_id, approvalDecision: answer });
				if (!denied) expect((await runtime.store.getEffect(request.id))?.state).toBe("planned");
			}
			release.resolve();
			await runtime.drain();
			const result = toolResultOf(mock, `continue-mounted-${continuationOrdinal}`);
			expect(result?.isError).toBe(denied);
			if (!denied) expect(JSON.stringify(result?.content)).toContain("whole-operation-value");
			if (evalOperation) expect(fs.existsSync(path.join(cwd, "sibling-after.txt"))).toBe(!denied);
			expect(fs.readFileSync(path.join(cwd, "independent-after-request.txt"), "utf8")).toBe("still authorized");
			if (shared) {
				const independent = runtime.asyncJobManager.getAllJobs({ ownerId: started.engineAgentId, attemptId: started.attemptId })
					.find(job => job.sourceToolCallId === "independent-eval");
				expect(independent).toMatchObject({ status: "completed" });
				expect(independent?.resultText).toContain("INDEPENDENT_COMPLETED");
			}
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
			const effects = await runtime.store.attemptToolEffects(started.attemptId);
			expect(effects.filter(effect => effect.state === "started" || effect.state === "planned")).toEqual([]);
			for (const request of requests) expect((await runtime.store.pendingEvents(1000)).filter(event =>
				event.kind === "tool_started" && event.payload?.invocationId === request.id)).toHaveLength(denied ? 0 : 1);
		} finally {
			release.resolve();
			unsubscribe();
			registration?.mockRestore();
			await runtime.dispose();
		}
	}, 60_000);

	it("returns the trusted handle for a direct hosted MCP escalation and keeps ordinary MCP errors", async () => {
		const subject = { action: "gated_probe", scope: "fixture" };
		const subjectHash = `sha256:${crypto.createHash("sha256").update(storageCanonicalJson(subject)).digest("hex")}`;
		let gatedCalls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") return new Response(null, { status: 204 });
				if (request.method === "GET") return new Response(null, { status: 405 });
				const message = (await request.json()) as { id?: string | number; method: string; params?: { name?: string } };
				if (message.id === undefined) return new Response(null, { status: 202 });
				const reply = (result: unknown, headers?: Record<string, string>) =>
					Response.json({ jsonrpc: "2.0", id: message.id, result }, headers ? { headers } : undefined);
				if (message.method === "initialize")
					return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "escalation", version: "1" } },
						{ "Mcp-Session-Id": "escalation-fixture" });
				if (message.method === "tools/list")
					return reply({ tools: ["gated_probe", "failing_probe"].map(name => ({
						name, description: `${name} fixture`, inputSchema: { type: "object", properties: {} },
					})) });
				if (message.method === "tools/call" && message.params?.name === "gated_probe") {
					gatedCalls++;
					return reply({ content: [{ type: "text", text: JSON.stringify({ status: "escalation_required", subject, subject_hash: subjectHash }) }] });
				}
				if (message.method === "tools/call")
					return reply({ isError: true, content: [{ type: "text", text: "ordinary failure" }] });
				return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported fixture method" } });
			},
		});
		const discover = spyOn(mcpConfig, "loadAllMCPConfigs").mockResolvedValue({ configs: {}, sources: {}, exaApiKeys: [] });
		const gated = "mcp__grimoire_engine_gated_probe";
		const failing = "mcp__grimoire_engine_failing_probe";
		const call = (id: string, name: string, args: Record<string, unknown>) =>
			({ content: [{ type: "toolCall" as const, id, name, arguments: args }] });
		let turn = 0;
		const mock = createMockModel({ handler: async () => {
			switch (turn++) {
				case 0: return call("submit-gated", "request", { action: "submit", handling: "nonblocking", operation: { toolName: gated, arguments: {} } });
				case 1: return call("submit-failing", "request", { action: "submit", handling: "nonblocking", operation: { toolName: failing, arguments: {} } });
				default: return { content: ["done"] };
			}
		} });
		const execution = admittedExecution(mock.model, modelRegistry, { continuation: {
			enableMCP: true, toolPolicies: { [gated]: "permit", [failing]: "permit" }, tools_permit: [gated, failing],
		} });
		const { runtime, cwd } = await createRuntime(execution, (session, input, identity) => session.prompt(input, identity), {
			mcpServer: {
				...hostedCoreMcpConfig({ serverUrl: `${server.url}mcp/client_agents`, token: "isolated-mcp-test", clientId: "engine-route-test" }),
				timeout: 1000,
			},
		});
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "direct-mcp-escalation", agentInstanceId: "direct-mcp-escalation",
				agentInstanceRef: "grimoire://tasks/grimoire/requests/agents/direct-mcp-escalation",
				executionId: "direct-mcp-escalation-execution", attemptId: "direct-mcp-escalation-attempt",
			}, { cwd, principalId: "owner", input: "Submit the hosted operations" }));
			await runtime.drain();
			// The SDK adapter normalizes the pending escalation into an error; only the host-owned identity is the handle.
			const gatedResult = toolResultOf(mock, "submit-gated");
			expect(gatedResult?.isError).toBeFalsy();
			const handle = JSON.parse(gatedResult!.content.filter(block => block.type === "text").map(block => block.text).join(""));
			expect(handle).toMatchObject({ status: "pending", handling: "nonblocking" });
			expect(handle.effectId).toBe(handle.requestId);
			expect(await runtime.store.getApproval(handle.requestId)).toMatchObject({ state: "pending",
				request: { kind: "escalation", handling: "nonblocking", requester_attempt_id: started.attemptId } });
			expect(gatedCalls).toBe(1);
			const failingResult = toolResultOf(mock, "submit-failing");
			expect(failingResult?.isError).toBeTrue();
			expect(JSON.stringify(failingResult?.content)).toContain("ordinary failure");
			expect(JSON.stringify(failingResult?.content)).not.toContain("requestId");
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_request");
		} finally {
			discover.mockRestore();
			await runtime.dispose();
			server.stop(true);
		}
	}, 60_000);

	it("freezes the captured reachable limit from the full roster and never resizes it on Resume", async () => {
		const release = Promise.withResolvers<boolean>();
		const entered = Promise.withResolvers<void>();
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const first = execution.config.routes.routes[0]!;
		for (let index = 1; index < 14; index++) execution.config.routes.routes.push({
			...structuredClone(first), route_ref: `gctx:${String(index).padStart(16, "0")}`,
		});
		first.account_ref = "gctx:0000000000000000";
		execution.config.routingLimits.accounts[first.account_ref] = 0;
		let maximum = 11;
		const verify = execution.optionsFor({}).verifyOriginReceipt!;
		const { runtime, cwd } = await createRuntime(execution, async () => {
			entered.resolve();
			return await release.promise;
		}, { verifyOriginReceipt: async identity => ({ ...await verify(identity),
			approvalSettings: { timeout_seconds: 300, max_frozen_candidates: maximum, settings_revision: 1,
				settings_hash: `sha256:${"7".repeat(64)}` } }) });
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "roster-limit-start", agentInstanceId: "roster-limit-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/roster/agents/one",
				executionId: "roster-limit-execution", attemptId: "roster-limit-attempt",
			}, { cwd, principalId: "owner", input: "use the whole roster" }));
			await entered.promise;
			const original = (await runtime.store.getAttempt(started.attemptId))!.execution!.executor_choice;
			expect(original.candidates.map(route => route.route_ref)).toEqual(
				execution.config.routes.routes.slice(1, 12).map(route => route.route_ref));
			validateRuntimeValue("executorChoice", original);
			maximum = 1;
			await runtime.pause({ ...started, commandId: "pause-roster-limit", initiator: { kind: "human" } });
			await runtime.resume({ ...started, commandId: "resume-roster-limit", initiator: { kind: "human" } });
			expect((await runtime.store.getAttempt(started.attemptId))!.execution!.executor_choice).toEqual(original);
			release.resolve(true);
			await runtime.drain();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
		} finally {
			release.resolve(true);
			await runtime.dispose();
		}
	}, 60_000);

	it("retains Q1 across Q2, drain and restart until its native request.read result is checkpointed", async () => {
		const independent = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const questions = [{ id: "choice", question: "Choose", options: [{ label: "Yes" }, { label: "No" }] }];
		let phase = 0;
		let readQ1 = false;
		let q1 = "";
		const mock = createMockModel({ handler: async () => {
			if (phase++ === 0) return { content: [{ type: "toolCall" as const, id: "ask-q1", name: "ask",
				arguments: { questions, handling: "nonblocking" } }] };
			if (phase === 2) {
				independent.resolve();
				await release.promise;
				return { content: [{ type: "toolCall" as const, id: "ask-q2", name: "ask",
					arguments: { questions, handling: "nonblocking" } }] };
			}
			if (readQ1) {
				readQ1 = false;
				return { content: [{ type: "toolCall" as const, id: "read-q1", name: "request",
					arguments: { action: "read", requestId: q1 } }] };
			}
			return { content: ["Independent work finished; retain the requests."] };
		} });
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["ask", "request"], restrictToolNames: true },
		});
		const created = await createRuntime(execution);
		let runtime = created.runtime;
		try {
			const first = nextEngineEvent(runtime, "input_requested");
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "q1-q2-start", agentInstanceId: "q1-q2-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/requests/agents/questions",
				executionId: "q1-q2-execution", attemptId: "q1-q2-attempt",
			}, { cwd: created.cwd, principalId: "owner", input: "Ask without blocking independent work" }));
			const firstEvent = await first;
			if (firstEvent.kind !== "input_requested") throw new Error("Q1 request event is missing");
			q1 = String(firstEvent.payload?.inputId);
			await independent.promise;
			const second = nextEngineEvent(runtime, "input_requested");
			await runtime.resolveInput({ ...started, commandId: "answer-q1", inputId: q1,
				expectedInputRevision: firstEvent.eventId,
				result: { kind: "submit", results: [{ id: "choice", selectedOptionIndexes: [1] }] } });
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
			expect((await runtime.store.requestProjection(started, q1))?.result_consumption).toBeUndefined();
			release.resolve();
			const secondEvent = await second;
			if (secondEvent.kind !== "input_requested") throw new Error("Q2 request event is missing");
			const q2 = String(secondEvent.payload?.inputId);
			await runtime.drain();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_request");
			const waitEvent = (await runtime.store.pendingEvents(1000)).findLast(event => event.kind === "request_waiting");
			if (!waitEvent) throw new Error("Natural drain did not retain its wait event");
			const historyPage = await runtime.sessionHistoryPage(started.agentInstanceId,
				started.bindingSnapshot!.agentInstanceRef, undefined, 100, started.attemptId);
			const lifecycle = await runtime.store.nativeLifecyclePage(started.agentInstanceId,
				started.bindingSnapshot!.agentInstanceRef, 1, started.attemptId, historyPage.lifecycleContext);
			expect(lifecycle.activities).toMatchObject([{ eventId: String(waitEvent.eventId), status: "waiting", terminal: false }]);
			expect((await runtime.store.retainedRequestInputs(started)).map(row => row.value.inputId).sort()).toEqual([q1, q2].sort());
			expect((await runtime.store.requestProjection(started, q1))?.result).toEqual({
				status: "answered", result: { kind: "submit", results: [{ id: "choice", selectedOptionIndexes: [1] }] },
			});
			expect((await runtime.store.runtimeCommand(started.commandId, { principalId: "owner" })).lease).toMatchObject({ held: true });
			await runtime.pause({ ...started, commandId: "pause-questions", initiator: { kind: "human" } });
			await runtime.dispose();
			runtime = await openRuntime(created.options);
			const restored = runtime.getBinding(started.agentInstanceId)!;
			expect(restored.attemptId).toBe(started.attemptId);
			expect((await runtime.store.requestProjection(restored, q1))?.result_consumption).toBeUndefined();
			readQ1 = true;
			await runtime.resume({ ...restored, commandId: "resume-questions", initiator: { kind: "human" } });
			await runtime.drain();
			const consumed = await runtime.store.requestProjection(restored, q1);
			expect(consumed?.result_consumption).toMatchObject({ input_revision: consumed?.value.revision, tool_call_id: "read-q1" });
			const history = await nativeSession(runtime, restored.sessionFile!);
			expect(history.getEntry(consumed!.result_consumption!.tool_result_entry_id)).toMatchObject({
				type: "message", message: { role: "toolResult", toolCallId: "read-q1", toolName: "request", isError: false },
			});
			expect((await runtime.store.retainedRequestInputs(restored)).map(row => row.value.inputId)).toEqual([q2]);
			await runtime.cancel({ ...restored, commandId: "stop-questions" });
			await runtime.drain();
			await expect(runtime.resolveInput({ ...restored, commandId: "late-q2", inputId: q2,
				result: { kind: "submit", results: [{ id: "choice", selectedOptionIndexes: [0] }] } }))
				.rejects.toMatchObject({ code: "too_late" });
		} finally {
			release.resolve();
			await runtime.dispose();
		}
	}, 60_000);

	it("keeps a nonblocking permit planned after approval and continues its original effect exactly once", async () => {
		const independent = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let phase = 0;
		let requestId = "";
		let revisions: { decisionRevision: number; inputRevision: number } | undefined;
		const mock = createMockModel({ handler: async context => {
			switch (phase++) {
				case 0: return { content: [{ type: "toolCall" as const, id: "submit-protected", name: "request",
					arguments: { action: "submit", handling: "nonblocking",
						operation: { toolName: "write", arguments: { path: "protected.txt", content: "once" } } } }] };
				case 1:
					independent.resolve();
					await release.promise;
					return { content: [{ type: "toolCall" as const, id: "independent-read", name: "read",
						arguments: { path: "independent.txt" } }] };
				case 2: return { content: [{ type: "toolCall" as const, id: "read-decision", name: "request",
					arguments: { action: "read", requestId } }] };
				case 3: {
					const result = context.messages.findLast(message => message.role === "toolResult" && message.toolCallId === "read-decision");
					if (!result || result.role !== "toolResult") throw new Error("Decision was not delivered to the model");
					const text = result.content.filter(block => block.type === "text").map(block => block.text).join("");
					revisions = JSON.parse(text);
					return { content: [{ type: "toolCall" as const, id: "different-continue-id", name: "request",
						arguments: { action: "continue", requestId, expectedDecisionRevision: revisions!.decisionRevision,
							expectedInputRevision: revisions!.inputRevision } }] };
				}
				case 4: return { content: [{ type: "toolCall" as const, id: "duplicate-continue", name: "request",
					arguments: { action: "continue", requestId, expectedDecisionRevision: revisions!.decisionRevision,
						expectedInputRevision: revisions!.inputRevision } }] };
				default: return { content: ["done"] };
			}
		} });
		const execution = admittedExecution(mock.model, modelRegistry, { continuation: {
			toolNames: ["request", "read", "write"], restrictToolNames: true, toolPolicies: { write: "permit" }, tools_permit: ["write"],
		} });
		const { runtime, cwd } = await createRuntime(execution);
		fs.writeFileSync(path.join(cwd, "independent.txt"), "authorized work");
		try {
			const requested = nextEngineEvent(runtime, "tool_approval_requested");
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "request-permit-start", agentInstanceId: "request-permit",
				agentInstanceRef: "grimoire://tasks/grimoire/requests/agents/permit",
				executionId: "request-permit-execution", attemptId: "request-permit-attempt",
			}, { cwd, principalId: "owner", input: "Submit an approval and continue independent work" }));
			const event = await requested;
			if (event.kind !== "tool_approval_requested") throw new Error("Missing permit request");
			requestId = event.payload.id;
			await independent.promise;
			const decision = approvalDecisionFor(execution, started, "approve-request-permit", event.payload, "approve");
			await runtime.resolveApproval({ ...started, commandId: decision.command_id, approvalDecision: decision });
			expect(fs.existsSync(path.join(cwd, "protected.txt"))).toBeFalse();
			expect((await runtime.store.getEffect(requestId))?.state).toBe("planned");
			release.resolve();
			await runtime.drain();
			expect(fs.readFileSync(path.join(cwd, "protected.txt"), "utf8")).toBe("once");
			expect(toolResultOf(mock, "duplicate-continue")?.isError).toBeTrue();
			expect((await runtime.store.getEffect(requestId))?.state).toBe("settled");
			expect((await runtime.store.pendingEvents()).filter(event =>
				event.kind === "tool_started" && event.payload?.invocationId === requestId)).toHaveLength(1);
			expect((await runtime.store.getApproval(requestId))?.request.submitted_operation?.tool_call_id).not.toBe("different-continue-id");
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
		} finally {
			release.resolve();
			await runtime.dispose();
		}
	}, 60_000);

	it("waits for a validated rich Ask answer and resumes the same Attempt", async () => {
		const questions = [
			{
				id: "delivery",
				question: "How should this ship?",
				header: "Delivery",
				options: [
					{ label: "Fast", description: "Minimize scope" },
					{ label: "Safe", preview: "Run the focused suite first" },
				],
				recommended: 1,
			},
			{
				id: "checks",
				question: "Which checks matter?",
				options: [{ label: "Tests" }, { label: " Docs " }],
				multi: true,
			},
		];
		const release = Promise.withResolvers<void>();
		const secondModelCall = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: (async function* () {
				yield { content: [{ type: "toolCall" as const, id: "ask-engine", name: "ask", arguments: { questions } }] };
				secondModelCall.resolve();
				await release.promise;
				yield { content: ["done"] };
			})(),
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["ask"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-input", agentInstanceId: "agent-input",
			agentInstanceRef: "grimoire://tasks/grimoire/ask/agents/one",
			executionId: "execution-input", attemptId: "attempt-input",
		}, { cwd, principalId: "owner", input: "ask" }));
		const input = await requested;
		const inputId = String((input.payload as { inputId: string }).inputId);
		expect(input.payload).toEqual({
			inputId,
			inputKind: "ask",
			questions,
			handling: "blocking",
			requesterAttemptId: started.attemptId,
			attemptState: "waiting_input",
			controlReadiness: { pause: false, resume: false, steer: false, cancel: true, resolveInput: true },
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_input");
		await expect(
			runtime.steer({ ...started, commandId: "steer-while-input", message: "do something else" }),
		).rejects.toMatchObject({ code: "too_late" });

		await expect(
			runtime.resolveInput({
				...started,
				commandId: "command-invalid-input",
				inputId,
				result: {
					kind: "submit",
					results: [
						{
							id: "wrong-order",
							question: "How should this ship?",
							options: ["Safe", "Fast"],
							multi: false,
							selectedOptions: ["Safe"],
						},
						{
							id: "checks",
							question: "Which checks matter?",
							options: ["Tests", "Docs"],
							multi: true,
							selectedOptions: ["Tests"],
						},
					],
				},
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			runtime.resolveInput({
				...started,
				commandId: "command-oversized-input",
				inputId,
				result: {
					kind: "submit",
					results: [
						{
							id: "delivery",
							question: "How should this ship?",
							options: ["Fast", "Safe"],
							multi: false,
							selectedOptions: ["Safe"],
							note: "x".repeat(48_001),
						},
						{
							id: "checks",
							question: "Which checks matter?",
							options: ["Tests", "Docs"],
							multi: true,
							selectedOptions: ["Tests"],
						},
					],
				},
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_input");

		const result = {
			kind: "submit" as const,
			results: [
				{
					id: "delivery",
					question: "How should this ship?",
					options: ["Fast", "Safe"],
					multi: false,
					selectedOptions: ["Safe"],
					note: "Prefer deterministic checks",
				},
				{
					id: "checks",
					question: "Which checks matter?",
					options: ["Tests", "Docs"],
					multi: true,
					selectedOptions: ["Tests", "Docs"],
				},
			],
		};
		const canonicalResult = {
			...result,
			results: [
				result.results[0]!,
				{
					...result.results[1]!,
					options: ["Tests", " Docs "],
					selectedOptions: ["Tests", " Docs "],
				},
			],
		};
		const store = runtime.store;
		const commitAttemptTransition = store.commitAttemptTransition.bind(store);
		const transitionSpy = spyOn(store, "commitAttemptTransition").mockImplementation(
			async (...args: Parameters<typeof commitAttemptTransition>) => {
				const [, , events] = args;
				if (events.some(event => event.kind === "input_resolved")) {
					throw new Error("injected input_resolved failure");
				}
				return await commitAttemptTransition(...args);
			},
		);
		try {
			await expect(
				runtime.resolveInput({ ...started, commandId: "command-failed-input-event", inputId, result }),
			).rejects.toThrow("injected input_resolved failure");
		} finally {
			transitionSpy.mockRestore();
		}
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_input");
		const resolved = nextEngineEvent(runtime, "input_resolved");
		await runtime.resolveInput({ ...started, commandId: "command-resolve-input", inputId, result });
		const resolvedEvent = await resolved;
		await secondModelCall.promise;
		expect(resolvedEvent).toMatchObject({
			attemptId: started.attemptId,
			causationCommandId: "command-resolve-input",
			payload: {
				inputId,
				result: canonicalResult,
				attemptState: "running",
				controlReadiness: { pause: true, resume: false, steer: true, cancel: true, resolveInput: false },
			},
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		release.resolve();
		await runtime.drain();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
		await runtime.dispose();
	}, 60_000);

	it("delivers admitted command context on raw resume and queued steer without stale or replay delivery", async () => {
		const firstEntered = Promise.withResolvers<void>();
		const firstRelease = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const secondRelease = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					firstEntered.resolve();
					await firstRelease.promise;
					return { content: ["first"] };
				},
				async () => {
					secondEntered.resolve();
					await secondRelease.promise;
					return { content: ["second"] };
				},
				{ content: ["steered"] },
			],
		});
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input, identity) =>
			session.prompt(input, identity));
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "resume-context-start", agentInstanceId: "resume-context-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/resume-context/agents/one",
				executionId: "resume-context-execution", attemptId: "resume-context-attempt",
			}, { cwd, principalId: "owner", input: "work" }));
			await firstEntered.promise;
			const paused = nextEngineEvent(runtime, "paused", started.attemptId);
			const hold = await runtime.pause({
				...started,
				commandId: "resume-context-pause",
				initiator: { kind: "human" },
				expectedIntentRevision: started.intentRevision,
			});
			firstRelease.resolve();
			await paused;
			const control = (
				target: typeof started,
				op: "resume" | "steer",
				commandId: string,
				payload: Record<string, unknown>,
			) =>
				dispatchEngineCommand({
					runtime,
					command: {
						schema: "grimoire.engine.command.v1",
						commandId,
						op,
						deviceId: "context-device",
						engineId: "context-engine",
						engineGeneration: runtime.engineGeneration,
						agentInstanceId: target.agentInstanceId,
						runtimeBindingId: target.bindingId,
						bindingGeneration: target.bindingGeneration,
						executionId: target.executionId,
						attemptId: target.attemptId,
						authorityGeneration: target.authorityGeneration,
						issuedAt: Date.now(),
						payload,
					},
				});
			await expect(
				control(started, "resume", "resume-context-stale", {
					initiator: { kind: "human" },
					expectedIntentRevision: started.intentRevision,
					context: "stale-resume-context",
				}),
			).rejects.toMatchObject({ code: "stale_target" });
			const resumePayload = {
				initiator: { kind: "human" },
				expectedIntentRevision: hold.intentRevision,
				context: '{"work_tracking":{"receipt":"RESUME_R2"}}',
			};
			await control(started, "resume", "resume-context-accepted", resumePayload);
			await control(started, "resume", "resume-context-accepted", resumePayload);
			await runtime.drain();
			expect(mock.calls).toHaveLength(1);
			const second = await admitRequest(runtime, startRequest(execution, {
				commandId: "steer-context-start", agentInstanceId: started.agentInstanceId,
				agentInstanceRef: "grimoire://tasks/grimoire/resume-context/agents/one",
				executionId: "steer-context-execution", attemptId: "steer-context-attempt",
			}, { cwd, principalId: "owner", input: "continue" }));
			await secondEntered.promise;
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("RESUME_R2");
			const queued = await runtime.enqueueInbox(second, {
				sourceEventId: "steer-body-b",
				sourceType: "user",
				body: "B",
				createdAt: Date.now(),
			});
			const steerPayload = {
				queueId: queued.item.queueId,
				expectedRevision: queued.item.revision,
				mutationId: "steer-context-consume",
				expectedIntentRevision: second.intentRevision,
				context: '{"work_tracking":{"receipt":"STEER_R3"}}',
			};
			await expect(
				control(second, "steer", "steer-context-stale", {
					...steerPayload,
					expectedRevision: queued.item.revision + 1,
					context: "stale-steer-context",
				}),
			).rejects.toMatchObject({ code: "stale_target" });
			await control(second, "steer", "steer-context-accepted", steerPayload);
			await control(second, "steer", "steer-context-accepted", steerPayload);
			secondRelease.resolve();
			await runtime.drain();
			expect(mock.calls).toHaveLength(3);
			expect(JSON.stringify(mock.calls[2].context.messages)).toContain("STEER_R3");
			const history = await retainedEntries(runtime, second.sessionFile!);
			expect(JSON.stringify(history.entries)).not.toContain("stale-resume-context");
			expect(JSON.stringify(history.entries)).not.toContain("stale-steer-context");
			expect(
				history.entries.filter(
					entry => entry.type === "custom_message" && entry.customType === "engine-command-context",
				),
			).toHaveLength(2);
			expect(
				history.entries.find(
					entry => entry.type === "message" && entry.sourceCommandId === "steer-context-accepted",
				),
			).toMatchObject({
				clientMessageId: "steer-body-b",
				message: { role: "user", content: [{ type: "text", text: "B" }] },
			});
			expect(
				history.entries.find(
					entry => entry.type === "message" && entry.sourceCommandId === "steer-context-accepted",
				),
			).not.toHaveProperty("launchSnapshot");
			expect(await runtime.readInbox(second, queued.item.queueId)).toMatchObject({
				sourceBody: "B",
				deliveryPayload: "B",
				disposition: "acknowledged",
				revision: queued.item.revision + 1,
			});
		} finally {
			firstRelease.resolve();
			secondRelease.resolve();
			await runtime.dispose();
		}
	}, 60_000);

	it("holds a formerly unheld durable queue after restart until an explicit Continue", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const setup = await createRuntime(execution, (session, input) => session.prompt(input));
		const started = await admitRequest(setup.runtime, startRequest(execution, {
			commandId: "command-released-wake", agentInstanceId: "agent-released-wake",
			agentInstanceRef: "grimoire://tasks/grimoire/released-wake/agents/one",
			executionId: "execution-released-wake", attemptId: "attempt-released-wake",
		}, { cwd: setup.cwd, principalId: "owner", input: "complete before restart" }));
		await setup.runtime.drain();
		const queued = await setup.runtime.enqueueInbox(started, {
			sourceEventId: "ordinary-released-wake",
			sourceType: "user",
			body: "continue after restart",
			createdAt: Date.now(),
			deliverAt: Date.now() + 250,
			wakeIntent: true,
		});
		const priorGeneration = setup.runtime.engineGeneration;
		await setup.runtime.dispose();

		const restarted = await openRuntime(setup.options);
		const wakes: EngineEvent[] = [];
		restarted.subscribe(event => {
			if (event.kind === "inbox_changed" && event.payload?.action === "wake_due") wakes.push(event);
		});
		// The deferred wake fires on the platform clock; only a real wait can prove it stays held.
		await Bun.sleep(400);
		expect(restarted.engineGeneration).toBe(priorGeneration + 1);
		expect(await restarted.store.getBinding(started.agentInstanceId)).toMatchObject({
			state: "released",
			manualHold: true,
			engineGeneration: priorGeneration,
		});
		expect(wakes).toHaveLength(0);
		const intent = await restarted.store.intent(started.agentInstanceId);
		expect(intent.holds.some(hold => hold.kind === "recovery")).toBeTrue();
		expect(await restarted.store.getInboxItemByQueueId(queued.item.queueId)).toMatchObject({
			disposition: "pending",
			revision: queued.item.revision,
		});
		expect(restarted.getBinding(started.agentInstanceId)).toBeUndefined();
		await restarted.dispose();
	}, 60_000);

	it("does not redispatch a durable Attempt after Engine restart", async () => {
		let dispatchCount = 0;
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const setup = await createRuntime(execution, async () => {
			dispatchCount++;
			return true;
		});
		const request = startRequest(execution, {
			commandId: "command-a", agentInstanceId: "agent-a",
			agentInstanceRef: "grimoire://tasks/grimoire/redispatch/agents/agent-a",
			executionId: "execution-a", attemptId: "attempt-a",
		}, { cwd: setup.cwd, principalId: "owner", input: "A" });
		await admitRequest(setup.runtime, request);
		await setup.runtime.drain();
		await setup.runtime.dispose();

		const restarted = await openRuntime(setup.options);
		const duplicate = await admitRequest(restarted, request);
		expect(duplicate.duplicate).toBeTrue();
		expect(duplicate.state).toBe("released");
		expect(dispatchCount).toBe(1);
		await restarted.dispose();
	}, 60000);

	it("keeps an Attempt nonterminal when transcript durability cannot be proven", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const failedTwice = Promise.withResolvers<void>();
		let flushCalls = 0;
		const originalFlush = SessionManager.prototype.flushAndCheckpoint;
		const flush = spyOn(SessionManager.prototype, "flushAndCheckpoint").mockImplementation(async function (
			this: SessionManager,
		) {
			flushCalls++;
			if (flushCalls === 1) return originalFlush.call(this);
			if (flushCalls === 3) failedTwice.resolve();
			// The owner may have applied the write before flush_wal failed, so this is not a rejection.
			throw new StorageClientError("storage_error", "injected flush_wal failure after write_opt");
		});
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "command-flush-failure", agentInstanceId: "agent-flush-failure",
				agentInstanceRef: "grimoire://tasks/grimoire/flush-failure/agents/one",
				executionId: "execution-flush-failure", attemptId: "attempt-flush-failure",
			}, { cwd, principalId: "owner", input: "finish" }));
			await failedTwice.promise;
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
			expect(
				(await runtime.store.pendingEvents()).some(event => event.kind === "completed" || event.kind === "failed"),
			).toBeFalse();

			flush.mockRestore();
			await runtime.cancel({ ...started, commandId: "cancel-after-flush-failure" });
			await runtime.drain();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		} finally {
			flush.mockRestore();
		}
		await runtime.dispose();
	}, 60000);

	it("fails an Attempt terminally when the storage owner rejects its transcript write", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		let flushCalls = 0;
		const originalFlush = SessionManager.prototype.flushAndCheckpoint;
		const flush = spyOn(SessionManager.prototype, "flushAndCheckpoint").mockImplementation(async function (
			this: SessionManager,
		) {
			if (++flushCalls === 1) return originalFlush.call(this);
			throw new StorageClientError("sequence_gap", "write does not follow accepted prefix");
		});
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "command-rejected-write", agentInstanceId: "agent-rejected-write",
				agentInstanceRef: "grimoire://tasks/grimoire/rejected-write/agents/one",
				executionId: "execution-rejected-write", attemptId: "attempt-rejected-write",
			}, { cwd, principalId: "owner", input: "finish" }));
			await runtime.drain();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("failed");
			expect(
				(await runtime.store.pendingEvents()).filter(
					event => event.attemptId === started.attemptId && event.kind === "failed",
				),
			).toHaveLength(1);
		} finally {
			flush.mockRestore();
		}
	});

	it("queues an unbound prepared history fork for reclamation after resolution fails and preserves the source", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		// The failing branch resolution uses its own admitted execution whose resolver refuses after the fork.
		let failResolution = false;
		const failingExecution = admittedExecution(mock.model, modelRegistry, {
			taskRef: "grimoire://tasks/grimoire/fork-cleanup",
		});
		const failingOptions = failingExecution.optionsFor({ deviceId: "engine-runtime-test-device" });
		const originalResolve = failingOptions.resolveExecution!;
		const refusingResolve: typeof originalResolve = (config, frozen, attempt, resolverCwd, signal) => {
			if (!failResolution) return originalResolve(config, frozen, attempt, resolverCwd, signal);
			return Promise.reject(new Error("execution resolution unavailable"));
		};
		failingExecution.optionsFor = () => ({
			...failingOptions,
			resolveExecution: refusingResolve,
		});

		const { runtime, cwd } = await createRuntime(execution, async (session, input) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
			return true;
		}, {}, [failingExecution]);
		// Bind the failing resolver into this runtime's options before starting the branch.
		const source = await admitRequest(runtime, startRequest(execution, {
			commandId: "cleanup-source", agentInstanceId: "cleanup-source",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/cleanup-source",
			executionId: "cleanup-source", attemptId: "cleanup-source",
		}, { cwd, principalId: "owner", input: "retained source" }));
		await runtime.drain();
		const history = await nativeHistory(runtime, source.agentInstanceId);
		const fork = spyOn(SessionManager, "forkNativeContext");
		try {
			failResolution = true;
			await expect(
				admitRequest(runtime, startRequest(failingExecution, {
					commandId: "cleanup-branch", agentInstanceId: "cleanup-branch",
					agentInstanceRef: "grimoire://tasks/grimoire/fork-cleanup/agents/cleanup-branch",
					executionId: "cleanup-branch", attemptId: "cleanup-branch",
				}, {
					cwd, principalId: "owner",
					historyEdit: {
						mode: "branch",
						source,
						sourceSessionId: history.sessionId,
						expectedLeafEntryId: history.sessionLeafEntryId!,
						entryId: history.entries[0]!.entryId,
					},
				})),
			).rejects.toThrow();
			expect(fork).toHaveBeenCalledTimes(1);
			const prepared = await fork.mock.results[0]!.value as SessionManager;
			const abandoned = prepared.getSessionFile();
			if (!abandoned) throw new Error("Prepared fork has no native locator");
			const { familyId, generationId } = parseNativeSessionLocator(abandoned);
			const tombstoneId = new Bun.CryptoHasher("sha256").update(`${familyId}\0${generationId}`).digest("hex");
			expect((await runtime.store.records.get("metadata", `native-delete:${tombstoneId}`)).value)
				.toMatchObject({ subtype: "native_tombstone", family_id: familyId, generation_id: generationId });
			await expect(runtime.sessionHistoryPage("cleanup-branch",
				"grimoire://tasks/grimoire/fork-cleanup/agents/cleanup-branch", undefined, undefined, "cleanup-branch"))
				.rejects.toMatchObject({ code: "history_expired" });
			expect((await runtime.store.getBinding("cleanup-branch"))?.sessionFile).toBeUndefined();
			expect(await runtime.store.getAttempt("cleanup-branch")).toMatchObject({ state: "failed" });
			const retained = await nativeHistory(runtime, source.agentInstanceId);
			expect(retained.sessionId).toBe(history.sessionId);
			expect(retained.sessionLeafEntryId).toBe(history.sessionLeafEntryId);
			expect(retained.entries).toEqual(history.entries);
		} finally {
			fork.mockRestore();
			await runtime.dispose();
		}
	});

	it("fails a history fork when its retained conversation cannot be read", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async (session, input) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
			return true;
		});
		const first = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-retained-read-a", agentInstanceId: "agent-retained-read",
			agentInstanceRef: "grimoire://tasks/grimoire/retained-read/agents/agent-retained-read",
			executionId: "execution-retained-read-a", attemptId: "attempt-retained-read-a",
		}, { cwd, principalId: "owner", input: "Keep this context" }));
		await runtime.drain();
		const failedRead = spyOn(RocksNativeSessionStorage.prototype, "readContext").mockRejectedValue(
			new Error("injected retained storage failure"),
		);
		try {
			await expect(
				admitRequest(runtime, startRequest(execution, {
					commandId: "command-retained-read-b", agentInstanceId: first.agentInstanceId,
					agentInstanceRef: "grimoire://tasks/grimoire/retained-read/agents/agent-retained-read",
					executionId: "execution-retained-read-b", attemptId: "attempt-retained-read-b",
				}, { cwd, principalId: "owner", input: "Must not silently reset" })),
			).rejects.toThrow();
		} finally {
			failedRead.mockRestore();
		}
		await runtime.dispose();
	}, 60_000);

	it("cancels a pending Start before waiting for shutdown lanes", async () => {
		let dispatched = false;
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		// Park the resolver: resolution only finishes after the Engine cancels it.
		let releaseResolution: (() => void) | undefined;
		const resolutionGate = new Promise<void>(resolve => {
			releaseResolution = resolve;
		});
		const { runtime, cwd, options } = await createRuntime(execution, async () => {
			dispatched = true;
			return true;
		});
		// Swap in a resolver that blocks until cancelled; keep the same verified origin contract.
		const blockedOptions: EngineRuntimeOptions = {
			...options,
			resolveExecution: async (config, frozen, attempt, resolverCwd, signal) => {
				const gate = resolutionGate;
				void gate;
				const abort = new Promise<never>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
				await Promise.race([resolutionGate, abort]);
				return execution.optionsFor({ deviceId: "engine-runtime-test-device" }).resolveExecution!(
					config, frozen, attempt, resolverCwd, signal);
			},
		};
		await runtime.dispose();
		const blocked = await openRuntime(blockedOptions);
		const pending = admitRequest(blocked, startRequest(execution, {
				commandId: "shutdown-resolution-start", agentInstanceId: "shutdown-resolution-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/shutdown-resolution/agents/one",
				executionId: "shutdown-resolution-execution", attemptId: "shutdown-resolution-attempt",
			}, { cwd, principalId: "owner", input: "work" }))
			.then(
				value => ({ value }),
				error => ({ error }),
			);
		const disposed = blocked.dispose({ closeStore: false });
		try {
			await withTimeout(disposed, 2000, "Shutdown waited for pending execution resolution");
			expect(await pending).toHaveProperty("error");
			expect(dispatched).toBeFalse();
			expect(await blocked.store.getAttempt("shutdown-resolution-attempt")).toBeUndefined();
		} finally {
			releaseResolution?.();
			await Promise.allSettled([pending]);
			await blocked.store.close();
		}
	}, 15000);

	it("queues after failed pre-session material without changing its owner or replaying the failed Attempt", async () => {
		const mock = createMockModel({ handler: { content: ["queued input completed"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const resolver = execution.optionsFor({}).resolveExecution!;
		const { runtime, cwd } = await createRuntime(execution, undefined, {
			resolveExecution: (config, frozen, attempt, resolverCwd, signal) => {
				if (attempt.attemptId === "failed-material-attempt") throw new Error("Fixture material is unavailable");
				return resolver(config, frozen, attempt, resolverCwd, signal);
			},
		});
		const agentInstanceId = "failed-material-agent";
		const agentInstanceRef = `${execution.taskRef}/agents/${agentInstanceId}`;
		try {
			await expect(admitRequest(runtime, startRequest(execution, {
				commandId: "failed-material-start", agentInstanceId, agentInstanceRef,
				executionId: "failed-material-execution", attemptId: "failed-material-attempt",
			}, { cwd, principalId: "owner", input: "initial material failure" }))).rejects.toThrow();
			const binding = (await runtime.store.getBinding(agentInstanceId))!;
			expect(binding.sessionFile).toBeUndefined();
			const revision = (await runtime.store.intent(agentInstanceId)).intentRevision;
			const enqueue = (commandId: string, principalId: string, generation: number) => execution.captureCommand({
				schema: "grimoire.engine.command.v1", op: "enqueue", commandId,
				deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine",
				engineGeneration: generation, authorityGeneration: binding.authorityGeneration,
				agentInstanceId, agentInstanceRef, bindingSnapshot: binding.bindingSnapshot,
				attemptId: binding.attemptId, executionId: binding.executionId,
				runtimeBindingId: binding.bindingId, bindingGeneration: binding.bindingGeneration,
				principalId, issuedAt: Date.now(),
				payload: { originReceiptId: `origin:${commandId}`, clientMessageId: commandId,
					text: "queued after material failure", expectedIntentRevision: revision },
			});
			const transport = { runtime, deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine" };
			await expect(runEngineCommand(transport, enqueue("foreign-pending-input", "foreign", runtime.engineGeneration)))
				.rejects.toThrow();
			await expect(runEngineCommand(transport, enqueue("stale-pending-input", "owner", runtime.engineGeneration - 1)))
				.rejects.toThrow();
			expect(await runtime.store.listInboxItems(`pending:${agentInstanceId}`)).toEqual([]);
			expect((await runEngineCommand(transport, enqueue("owned-pending-input", "owner", runtime.engineGeneration))).outcome)
				.toBe("applied");
			const [queued] = await runtime.store.listInboxItems(`pending:${agentInstanceId}`);
			expect(queued).toMatchObject({ attemptId: binding.attemptId, binding_id: binding.bindingId,
				binding_generation: binding.bindingGeneration, disposition: "pending" });
			await admitRequest(runtime, startRequest(execution, {
				commandId: "material-ready-start", agentInstanceId, agentInstanceRef,
				executionId: "material-ready-execution", attemptId: "material-ready-attempt",
			}, { cwd, principalId: "owner", queueId: queued!.queueId, expectedRevision: queued!.revision,
				mutationId: "material-ready-consume", expectedIntentRevision: revision, explicitContinue: true }));
			await runtime.drain();
			expect(mock.calls).toHaveLength(1);
			expect((await runtime.store.getAttempt("failed-material-attempt"))?.state).toBe("failed");
			expect((await runtime.store.getAttempt("material-ready-attempt"))?.state).toBe("completed");
			expect((await runtime.store.getInboxItemByQueueId(queued!.queueId))?.disposition).toBe("acknowledged");
		} finally { await runtime.dispose(); }
	});

	for (const sourceType of ["user", "agent"] as const) {
		it(`retains ${sourceType} queued input across an ACK failure and reuses only its exact native entry`, async () => {
			const mock = createMockModel({ handler: { content: ["delivered"] } });
			const execution = admittedExecution(mock.model, modelRegistry);
			const resolver = execution.optionsFor({}).resolveExecution!;
			const setup = await createRuntime(execution, undefined, {
				resolveExecution: (config, frozen, attempt, cwd, signal) => {
					if (attempt.attemptId === "queued-seed-attempt" || attempt.attemptId === "queued-material-cut-attempt")
						throw new Error("Material unavailable");
					return resolver(config, frozen, attempt, cwd, signal);
				},
			});
			let runtime = setup.runtime;
			const agentInstanceId = `queued-recovery-${sourceType}`;
			const agentInstanceRef = `${execution.taskRef}/agents/${agentInstanceId}`;
			const release = async (commandId: string, item: EngineInboxItem) => startRequest(execution, {
				commandId, agentInstanceId, agentInstanceRef, attemptId: `${commandId}-attempt`, executionId: `${commandId}-execution`,
			}, {
				cwd: setup.cwd, principalId: "owner", queueId: item.queueId, expectedRevision: item.revision,
				mutationId: `${commandId}-consume`, explicitContinue: true,
				expectedIntentRevision: (await runtime.store.intent(agentInstanceId)).intentRevision,
			});
			await expect(admitRequest(runtime, startRequest(execution, {
				commandId: "queued-seed", agentInstanceId, agentInstanceRef,
				attemptId: "queued-seed-attempt", executionId: "queued-seed-execution",
			}, { cwd: setup.cwd, principalId: "owner", input: "seed" }))).rejects.toThrow("Material unavailable");
			const first = await runtime.enqueueAgentInbox(agentInstanceId, {
				sourceEventId: "queued-input-one", sourceType, sender: "peer", body: "identical queued text",
			});
			await expect(admitRequest(runtime, await release("queued-material-cut", first.item))).rejects.toThrow("Material unavailable");
			expect(await runtime.store.getInboxItemByQueueId(first.item.queueId)).toMatchObject({
				disposition: "pending", sessionId: first.item.sessionId, revision: first.item.revision,
			});
			const request = await release("queued-accept-a", first.item);
			request.context = "QUEUED_START_CONTEXT_ONCE";
			const commit = runtime.store.commitAttemptTransition.bind(runtime.store);
			const cut = spyOn(runtime.store, "commitAttemptTransition").mockImplementation(async (...args) => {
				if (args[3]?.inboxMutation?.queueId === first.item.queueId) throw new Error("ACK commit cut");
				return commit(...args);
			});
			try {
				await expect(admitRequest(runtime, request)).rejects.toThrow("ACK commit cut");
			} finally { cut.mockRestore(); }
			expect(mock.calls).toHaveLength(0);
			expect(await runtime.store.getInboxItemByQueueId(first.item.queueId)).toMatchObject({
				disposition: "pending", sessionId: first.item.sessionId, revision: first.item.revision,
			});
			const retained = (await runtime.store.getBinding(agentInstanceId))!;
			const original = await nativeSession(runtime, retained.sessionFile!);
			const users = original.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
			expect(users).toHaveLength(1);
			expect(users[0]).toMatchObject({
				sourceCommandId: request.commandId, message: { attribution: "user" },
				launchSnapshot: { schema: "engine.launch_snapshot.v2", agentInstanceId,
					attemptId: request.attemptId, executionId: request.executionId,
					executionDigest: retained.executionDigest, continuationDigest: retained.continuationDigest },
			});
			if (sourceType === "agent") expect(users[0]).not.toHaveProperty("clientMessageId");
			else expect(users[0]).toHaveProperty("clientMessageId", first.item.sourceEventId);
			expect(await admitRequest(runtime, request)).not.toHaveProperty("queueRevision");
			expect((await runtime.store.records.get("command", request.commandId)).value).toMatchObject({
				receipt: { outcome: "applied", detail: { phase: "applied" } },
			});
			await runtime.dispose();
			runtime = await openRuntime(setup.options);
			expect((await runtime.store.intent(agentInstanceId)).manualHold).toBeTrue();
			expect(mock.calls).toHaveLength(0);
			if (sourceType === "agent") {
				const commitReopened = runtime.store.commitAttemptTransition.bind(runtime.store);
				const omitLoaded = spyOn(runtime.store, "commitAttemptTransition").mockImplementation(async (...args) => {
					const events = await commitReopened(...args);
					if (args[0].commandId === "queued-not-loaded" && args[3]?.transcriptCheckpoint && !args[3]?.inboxSessionId)
						runtime.agentRegistry.get(args[0].engineAgentId)!.session!.agent.replaceMessages([]);
					return events;
				});
				try {
					await expect(admitRequest(runtime, await release("queued-not-loaded", first.item)))
						.rejects.toMatchObject({ code: "stale_target" });
				} finally { omitLoaded.mockRestore(); }
				expect(await runtime.store.getInboxItemByQueueId(first.item.queueId)).toMatchObject({
					disposition: "pending", sessionId: first.item.sessionId, revision: first.item.revision,
				});
				const unchanged = await nativeSession(runtime, (await runtime.store.getBinding(agentInstanceId))!.sessionFile!);
				expect(unchanged.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"))
					.toEqual(users);
				expect(mock.calls).toHaveLength(0);
			}
			const accepted = await admitRequest(runtime, await release("queued-accept-b", first.item));
			await runtime.drain();
			expect(mock.calls).toHaveLength(1);
			const textParts = (message: (typeof mock.calls)[number]["context"]["messages"][number]) =>
				typeof message.content === "string" ? [message.content] :
					message.content.flatMap(part => part.type === "text" ? part.text : []);
			expect(mock.calls[0].context.messages.filter(message => message.role === "user").flatMap(textParts)
				.filter(text => text === first.item.deliveryPayload)).toEqual([first.item.deliveryPayload]);
			expect(mock.calls[0].context.messages.filter(message => message.role === "developer").flatMap(textParts)
				.filter(text => text === "QUEUED_START_CONTEXT_ONCE")).toEqual(["QUEUED_START_CONTEXT_ONCE"]);
			expect(await runtime.store.getInboxItemByQueueId(first.item.queueId)).toMatchObject({
				disposition: "acknowledged", revision: first.item.revision + 1, attemptId: accepted.attemptId,
			});
			const restored = await nativeSession(runtime, accepted.sessionFile!);
			expect(restored.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user")).toEqual(users);
			const ack = (await runtime.store.pendingEvents()).filter(event =>
				event.kind === "inbox_changed" && event.payload?.action === "acknowledge" && event.payload?.queueId === first.item.queueId);
			expect(ack).toMatchObject([{ causationCommandId: "queued-accept-b", payload: { revision: first.item.revision + 1 } }]);
			const second = await runtime.enqueueAgentInbox(agentInstanceId, {
				sourceEventId: "queued-input-two", sourceType, sender: "peer", body: "identical queued text",
			});
			const secondAccepted = await admitRequest(runtime, await release("queued-accept-c", second.item));
			await runtime.drain();
			expect(mock.calls).toHaveLength(2);
			expect(mock.calls[1].context.messages.filter(message => message.role === "user").flatMap(textParts)
				.filter(text => text === first.item.deliveryPayload)).toEqual([first.item.deliveryPayload, first.item.deliveryPayload]);
			const final = await nativeSession(runtime, secondAccepted.sessionFile!);
			const finalUsers = final.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
			expect(finalUsers).toMatchObject([{ sourceCommandId: "queued-accept-a" }, { sourceCommandId: "queued-accept-c" }]);
			if (sourceType === "agent") for (const entry of finalUsers) expect(entry).not.toHaveProperty("clientMessageId");
			await runtime.dispose();
		}, 30_000);
	}

	it.each([undefined, 0, 3])("projects the durable Start identity before binding without inventing browser CAS: %s", async expected => {
		const execution = admittedExecution(createMockModel().model, modelRegistry);
		const resolve = execution.optionsFor({ deviceId: "engine-runtime-test-device" }).resolveExecution!;
		let prebindingTarget: Record<string, unknown> | undefined;
		const { runtime, cwd } = await createRuntime(execution, async () => true, {
			resolveExecution: async (config, frozen, attempt, resolverCwd, signal) => {
				// Same unqualified read as ClientHost provider preparation: the durable binding row was committed
				// atomically with the running Attempt, while the live native session is not opened yet.
				prebindingTarget = await runtime.store.runtimeTarget({
					principalId: attempt.expectedPrincipalId, agentInstanceRef: attempt.agentInstanceRef,
				});
				validateRuntimeValue("nativeTarget", prebindingTarget);
				const durable = await runtime.store.getBinding(engineAgentInstanceId(attempt.agentInstanceRef));
				expect(durable).toMatchObject({ attemptId: attempt.attemptId, commandId: "target-start", state: "running" });
				expect(durable?.sessionFile).toBeUndefined();
				expect(await runtime.store.runtimeCommand("target-start", { principalId: "owner" })).toMatchObject({
					attemptState: "running", lease: { held: true },
				});
				return resolve(config, frozen, attempt, resolverCwd, signal);
			},
		});
		const agentInstanceRef = `${execution.taskRef}/agents/native-target`;
		const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
		await runtime.store.registerAgent({ agentInstanceId, agentInstanceRef, principalId: "owner", authorityGeneration: 1 });
		for (let revision = 0; revision < (expected ?? 0); revision++)
			await runtime.store.branchIntent(agentInstanceId, `target-hold-${revision}`, "pause", revision);
		const request = startRequest(execution, { commandId: "target-start", agentInstanceId, agentInstanceRef,
			executionId: "target-execution", attemptId: "target-attempt" },
			{ cwd, principalId: "owner", input: "native target proof",
				expectedIntentRevision: expected, explicitContinue: expected !== undefined });
		const command = startEnvelope(runtime, execution, request);
		await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration);
		const params = { principalId: "owner", agentInstanceRef, attemptId: request.attemptId };
		const pending = await runtime.store.runtimeTarget({ principalId: "owner", agentInstanceRef });
		validateRuntimeValue("nativeTarget", pending);
		expect(pending).toMatchObject({ kind: "pending", commandId: request.commandId });
		expect(pending.startExpectedIntentRevision).toBe(expected);
		await admitRequest(runtime, request);
		await runtime.drain();
		expect(prebindingTarget).toMatchObject({
			kind: "bound", attemptId: request.attemptId, startCommandId: request.commandId,
		});
		expect(prebindingTarget?.startExpectedIntentRevision).toBe(expected);
		const bound = await runtime.store.runtimeTarget(params);
		validateRuntimeValue("nativeTarget", bound);
		expect(bound).toMatchObject({ kind: "bound", attemptId: request.attemptId });
		expect(bound.startCommandId).toBe(request.commandId);
		expect(bound.startExpectedIntentRevision).toBe(expected);
		if (expected !== undefined) {
			const missingStart = { ...bound };
			delete missingStart.startCommandId;
			expect(() => validateRuntimeValue("nativeTarget", missingStart)).toThrow();
		}
		await runtime.dispose();
	});

	it("applies Pause while a native usage query is pending and aborts the provider on IPC close", async () => {
		const entered = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const provider = Promise.withResolvers<void>();
		let providerEntered = false;
		const prompt = Promise.withResolvers<boolean>();
		const ready = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [async () => {
			await prompt.promise;
			return { content: ["answer"] };
		}] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async session => {
			session.fetchUsageReports = async signal => {
				signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				providerEntered = true;
				entered.resolve();
				await provider.promise;
				return [];
			};
			ready.resolve();
			return await prompt.promise;
		});
		const agentInstanceRef = "grimoire://tasks/grimoire/usage-control/agents/one";
		const runtimeDir = path.join(cwd, "control-query");
		fs.mkdirSync(runtimeDir);
		const server = await startEngineControlQueryServer({
			runtime,
			runtimeDir,
			deviceId: "device",
			engineId: "engine",
		});
		const client = new EngineControlQueryClient(runtimeDir);
		let usage: Promise<unknown> = Promise.resolve();
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "start-usage-control",
				agentInstanceId: engineAgentInstanceId(agentInstanceRef),
				agentInstanceRef,
				executionId: "execution-usage-control", attemptId: "attempt-usage-control",
			}, { cwd, principalId: "owner", input: "test pending usage" }));
			await ready.promise;
			usage = client
				.request("runtime.usage", { agentInstanceRef, attemptId: started.attemptId, principalId: "owner" })
				.then(
					() => undefined,
					error => error,
				);
			await withTimeout(Promise.race([entered.promise, usage.then(async result => {
				if (providerEntered) return;
				const attempt = await runtime.store.getAttempt(started.attemptId);
				const binding = await runtime.store.getBinding(started.agentInstanceId);
				// The IPC response already contains the server's public error, never its request credentials.
				console.error("Usage IPC ended before provider entry", {
					method: "runtime.usage", agentInstanceRef, principalId: "owner", attemptId: started.attemptId,
					state: attempt?.state, bindingId: binding?.bindingId, boundAttemptId: binding?.attemptId,
					error: result instanceof Error ? result.message : "Unexpected early success",
					code: result && typeof result === "object" && "code" in result ? result.code : undefined,
				});
				throw result instanceof Error ? result : new Error("Usage query completed without entering its provider");
			})]), 2_000, "Native usage query did not reach the provider");
			const paused = await withTimeout(
				runtime.pause({ ...started, commandId: "pause-during-usage", initiator: { kind: "human" } }),
				2_000,
				"Provider usage blocked Pause",
			);
			expect(paused.manualHold).toBeTrue();
			expect((await runtime.store.intent(started.agentInstanceId)).manualHold).toBeTrue();
			await server.close();
			expect(await usage).toBeInstanceOf(Error);
			await withTimeout(aborted.promise, 2_000, "Disconnected usage query retained its provider request");
		} finally {
			await withTimeout(server.close(), 3_000, "Usage IPC cleanup did not finish");
			provider.resolve();
			prompt.resolve(true);
			await withTimeout(usage, 3_000, "Usage request cleanup did not finish");
			await withTimeout(runtime.dispose(), 5_000, "Usage runtime cleanup did not finish");
		}
	}, 20_000);

	it("reports unsupported provider usage when no reports exist", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async session => {
			session.fetchUsageReports = async () => [];
			return true;
		});
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "usage-empty", agentInstanceId: "usage-agent",
			agentInstanceRef: "grimoire://tasks/grimoire/usage-empty/agents/one",
			executionId: "usage-execution", attemptId: "usage-attempt",
		}, { cwd, principalId: "owner", input: "test usage" }));
		await runtime.drain();
		expect((await runtime.sessionUsage(started)).provider).toEqual({
			status: "unavailable",
			reason: "provider_usage_not_supported",
		});
		await runtime.dispose();
	});

	it("records unrestricted tools without exposing their raw input", async () => {
		const mock = toolTurnModel("read-unrestricted", "read", { path: "secret-name.txt" });
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		fs.writeFileSync(path.join(cwd, "secret-name.txt"), "secret-value");
		await admitRequest(runtime, startRequest(execution, {
			commandId: "command-unrestricted", agentInstanceId: "agent-unrestricted",
			agentInstanceRef: "grimoire://tasks/grimoire/unrestricted/agents/one",
			executionId: "execution-unrestricted", attemptId: "attempt-unrestricted",
		}, { cwd, principalId: "owner", input: "read" }));
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.kind.startsWith("tool_"));
		expect(events.filter(event => event.kind === "tool_started")).toHaveLength(1);
		expect(events.filter(event => event.kind === "tool_settled")).toHaveLength(1);
		expect(events.findIndex(event => event.kind === "tool_settled")).toBeGreaterThan(
			events.findIndex(event => event.kind === "tool_started"),
		);
		expect(JSON.stringify(events)).not.toContain("secret-name.txt");
		const effectId = String((events[0]?.payload as { invocationId?: string }).invocationId);
		expect(await runtime.store.getEffect(effectId)).toMatchObject({
			state: "settled",
			outcome: "completed",
			policy: "unrestricted",
		});
		await runtime.dispose();
	}, 60_000);

	it.each(["manual", "automatic"] as const)("records %s remote compaction through its actual body parser", async mode => {
		const mock = createMockModel({
			baseUrl: "https://compact.invalid/v1",
			handler: { content: [Array.from({ length: 1_000 }, (_, index) =>
				crypto.createHash("sha256").update(`remote-${index}`).digest("hex").slice(0, 6)).join("\n")],
				usage: { input: 10_000, output: 20, totalTokens: 10_020 } },
		});
		// The remote adapter family differs from the mock transport, which Model<"mock"> cannot type.
		Object.assign(mock.model, { remoteCompaction: {
			enabled: true, api: "openai-responses",
			endpoint: "https://compact.invalid/v1/responses/compact", v2StreamingEnabled: false,
		} });
		// Automatic maintenance selects from the available catalog, unlike explicit manual compaction.
		const available = spyOn(modelRegistry, "getAvailable").mockReturnValue([mock.model]);
		const execution = admittedExecution(mock.model, modelRegistry);
		const resolver = execution.optionsFor({ deviceId: "engine-runtime-test-device" }).resolveExecution!;
		let requests = 0;
		const provider = mockProviderFetch("https://compact.invalid/", async url => {
			expect(url).toBe("https://compact.invalid/v1/responses/compact");
			requests++;
			return Response.json({
				id: "remote-usage",
				output: [{ type: "compaction", encrypted_content: "fixture-compact" }],
				usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100,
					input_tokens_details: { cached_tokens: 20 } },
			});
		});
		let created: Awaited<ReturnType<typeof createRuntime>> | undefined;
		try {
			created = await createRuntime(execution, async (session, input) => {
				await session.prompt(input);
				if (mode === "manual") await session.compact(undefined, { mode: "remote" });
				return true;
			}, {
				resolveExecution: async (config, frozen, attempt, resolverCwd, signal) => {
					const resolved = await resolver(config, frozen, attempt, resolverCwd, signal);
					const route = config.routes.routes[0]!;
					resolved.options.providerRequestHook = new ProviderAdmissionClient(
						"http://admission.invalid", "fixture", async () => Response.json({ allowed: true }),
					).createHook(undefined, auth, "", [{
						...attempt, routeRef: route.route_ref, routeContentHash: `sha256:${"a".repeat(64)}`,
						providerAccountRef: route.account_ref, providerAccountContentHash: `sha256:${"b".repeat(64)}`,
						credentialGeneration: 1, providerId: mock.model.provider, runtimeProviderId: mock.model.provider,
						modelId: mock.model.id, baseUrl: mock.model.baseUrl,
					}]);
					return resolved;
				},
			}, [], {
				"compaction.enabled": mode === "automatic",
				"compaction.asyncEnabled": false,
				"compaction.methodOrder": ["remote"],
				"compaction.thresholdPercent": 1,
				"compaction.keepRecentTokens": 1,
				"compaction.autoContinue": false,
			});
			const { runtime, cwd } = created;
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: `compact-${mode}`, agentInstanceId: `compact-${mode}`,
				agentInstanceRef: `grimoire://tasks/grimoire/compact/agents/${mode}`,
				executionId: `compact-execution-${mode}`, attemptId: `compact-attempt-${mode}`,
			}, { cwd, principalId: "owner", input: "history ".repeat(2_000) }));
			await runtime.drain();
			expect(requests).toBe(1);
			const events = await runtime.store.pendingEvents();
			const consumed = events.filter(event => event.kind === "model_settled" &&
				Array.isArray(event.payload?.requests) && event.payload.requests.length > 0);
			expect(consumed).toHaveLength(1);
			expect(consumed[0]?.payload).toMatchObject({
				requests: [{ ordinal: 1, state: "responded" }],
				usage: { ordinal: 1, providerResponseId: "remote-usage",
					tokens: { input: 80, output: 0, cacheRead: 20, cacheWrite: null, reasoning: null } },
			});
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
		} finally {
			try {
				await created?.runtime.dispose();
			} finally {
				provider.mockRestore();
				available.mockRestore();
			}
		}
	}, 30_000);

	it("compacts a terminal session locally without resolving credentials or reopening provider work", async () => {
		const mock = createMockModel({ handler: { content: [Array.from({ length: 2_000 }, (_, index) =>
			crypto.createHash("sha256").update(`local-${index}`).digest("hex").slice(0, 15)).join("\n")] }, input: ["text", "image"] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input), {}, [], {
			"compaction.enabled": false,
			"compaction.methodOrder": ["snapcompact"],
			"compaction.keepRecentTokens": 1,
		});
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "idle-local-compact", agentInstanceId: "idle-local-compact",
				agentInstanceRef: "grimoire://tasks/grimoire/side/agents/local",
				executionId: "idle-local-execution", attemptId: "idle-local-attempt",
			}, { cwd, principalId: "owner", input: "retain this history ".repeat(2_000) }));
			await runtime.drain();
			const session = runtime.agentRegistry.get(started.engineAgentId)!.session!;
			const key = spyOn(session.modelRegistry, "getApiKey").mockImplementation(async () => {
				throw new Error("Idle local compaction resolved a credential");
			});
			try {
				await runtime.compact(started);
				const compacted = session.sessionManager.getContextBranch().findLast(entry => entry.type === "compaction");
				expect(compacted?.type).toBe("compaction");
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
				expect(mock.calls).toHaveLength(1);
				await expect(session.runEphemeralTurn({ promptText: "not admitted" })).rejects.toThrow("active Attempt");
				expect(key).not.toHaveBeenCalled();
			} finally {
				key.mockRestore();
			}
		} finally {
			await runtime.dispose();
		}
	}, 30_000);

	it.each([
		{ mode: "complete", origin: "headless" },
		{ mode: "complete", origin: "browser" },
		{ mode: "cancel", origin: "headless" },
		{ mode: "write_failure", origin: "headless" },
	] as const)(
		"keeps $origin side results and Attempt $mode behind durable model settlement", async ({ mode, origin }) => {
			const dispatchEntered = Promise.withResolvers<void>();
			const finishPrompt = Promise.withResolvers<boolean>();
			const settling = Promise.withResolvers<void>();
			const commit = Promise.withResolvers<void>();
			const mock = createMockModel({
				baseUrl: "https://side.invalid/v1",
				handler: async (_context, options) => {
					if (!options?.fetch) throw new Error("Side transport was not installed");
					await options.fetch("https://side.invalid/v1/completions");
					return { content: ["side answer"], usage: {
						input: 4, output: 2, reportedFields: ["input", "output"],
					} };
				},
			});
			const execution = admittedExecution(mock.model, modelRegistry);
			const resolver = execution.optionsFor({ deviceId: "engine-runtime-test-device" }).resolveExecution!;
			const provider = mockProviderFetch("https://side.invalid/", async () => new Response("ok"));
			let created: Awaited<ReturnType<typeof createRuntime>> | undefined;
			let delayed: { mockRestore(): void } | undefined;
			try {
				created = await createRuntime(execution, async () => {
					dispatchEntered.resolve();
					return await finishPrompt.promise;
				}, {
					resolveExecution: async (config, frozen, attempt, resolverCwd, signal) => {
						const resolved = await resolver(config, frozen, attempt, resolverCwd, signal);
						const route = config.routes.routes[0]!;
						resolved.options.providerRequestHook = new ProviderAdmissionClient(
							"http://admission.invalid", "fixture", async () => Response.json({ allowed: true }),
						).createHook(undefined, auth, "", [{
							...attempt, routeRef: route.route_ref, routeContentHash: `sha256:${"a".repeat(64)}`,
							providerAccountRef: route.account_ref, providerAccountContentHash: `sha256:${"b".repeat(64)}`,
							credentialGeneration: 1, providerId: mock.model.provider, runtimeProviderId: mock.model.provider,
							modelId: mock.model.id, baseUrl: mock.model.baseUrl,
						}]);
						return resolved;
					},
				});
				const { runtime, cwd } = created;
				const settle = runtime.store.settleModelEffect.bind(runtime.store);
				delayed = spyOn(runtime.store, "settleModelEffect").mockImplementation(async (...args) => {
					const effect = await runtime.store.getEffect(args[1].effectId);
					if (effect?.requests?.length) {
						settling.resolve();
						await commit.promise;
						if (mode === "write_failure") throw new Error("side settlement storage failed");
					}
					return await settle(...args);
				});
				const request = startRequest(execution, {
					commandId: `side-${mode}`, agentInstanceId: `side-${mode}`,
					agentInstanceRef: `grimoire://tasks/grimoire/side/agents/${mode}`,
					executionId: `side-execution-${mode}`, attemptId: `side-attempt-${mode}`,
				}, { cwd, principalId: "owner", input: "primary" });
				const command = startEnvelope(runtime, execution, request, {
					deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine",
					...(origin === "browser" ? {
						browserTarget: { agentInstanceRef: request.agentInstanceRef! },
						browserPayloadHash: `sha256:${"c".repeat(64)}`,
					} : {}),
				});
				await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration);
				const started = await runtime.start(request);
				const proof = await runtime.store.runtimeCommand(request.commandId,
					{ principalId: "owner" }, undefined, undefined, true);
				expect(proof).not.toHaveProperty("attemptId");
				expect(proof).toMatchObject({
					lookup: "known", stage: "applied", lease: { held: true },
					command: { attemptId: request.attemptId, executionId: request.executionId },
				});
				if (origin === "browser") expect(proof.target).toEqual(command.browserTarget);
				await dispatchEntered.promise;
				const session = runtime.agentRegistry.get(started.engineAgentId)!.session!;
				let visible = false;
				const side = session.runEphemeralTurn({ promptText: "side" })
					.then(value => { visible = true; return value; }, error => error);
				await withTimeout(settling.promise, 5_000, "Side call did not reach native settlement");
				expect(visible).toBe(false);
				if (mode === "cancel") await runtime.cancel({ ...started, commandId: "cancel-side" });
				finishPrompt.resolve(true);
				await Bun.sleep(0);
				expect((await runtime.store.getAttempt(started.attemptId))?.state).not.toBe("completed");
				expect((await runtime.store.pendingEvents()).some(event =>
					event.kind === "model_settled" && Array.isArray(event.payload?.requests) &&
					event.payload.requests.length > 0)).toBe(false);
				commit.resolve();
				const result = await side;
				if (mode === "write_failure") expect(String(result)).toContain("side settlement storage failed");
				else expect(result).toMatchObject({ replyText: "side answer" });
				await runtime.drain().catch(error => {
					if (mode !== "write_failure") throw error;
					expect(error).toMatchObject({ name: "EngineEffectConflictError" });
				});
				if (mode === "write_failure") {
					expect((await runtime.store.getAttempt(started.attemptId))?.state).not.toBe("completed");
				} else {
					expect((await runtime.store.getAttempt(started.attemptId))?.state)
						.toBe(mode === "cancel" ? "cancelled" : "completed");
					const events = await runtime.store.pendingEvents();
					const fact = events.find(event => event.kind === "model_settled" &&
						Array.isArray(event.payload?.requests) && event.payload.requests.length > 0);
					expect(fact?.payload).toMatchObject({ usage: { tokens: { input: 4, output: 2, cacheRead: null } } });
					const terminal = events.find(event => event.kind === (mode === "cancel" ? "cancelled" : "completed"));
					expect(fact!.eventId).toBeLessThan(terminal!.eventId);
				}
			} finally {
				commit.resolve();
				finishPrompt.resolve(true);
				delayed?.mockRestore();
				provider.mockRestore();
				// The injected failure intentionally leaves an open effect for native recovery;
				// shutdown may also reject its terminal transition, but must still close resources.
				if (mode === "write_failure") await Promise.allSettled([created?.runtime.dispose()]);
				else await created?.runtime.dispose();
			}
		}, 30_000,
	);

	it("records model dispatch certainty without exposing the prompt", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		await admitRequest(runtime, startRequest(execution, {
			commandId: "command-model-effect", agentInstanceId: "agent-model-effect",
			agentInstanceRef: "grimoire://tasks/grimoire/model-effect/agents/one",
			executionId: "execution-model-effect", attemptId: "attempt-model-effect",
		}, { cwd, principalId: "owner", input: "private prompt sentinel" }));
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.kind.startsWith("model_"));
		expect(events.filter(event => event.kind === "model_started")).toHaveLength(1);
		expect(events.filter(event => event.kind === "model_settled")).toHaveLength(1);
		expect(events.filter(event => event.kind === "model_settled").every(event =>
			events.findIndex(other => other.kind === "model_started") < events.indexOf(event))).toBeTrue();
		expect(JSON.stringify(events)).not.toContain("private prompt sentinel");
		const effectId = String((events[0]?.payload as { effectId?: string }).effectId);
		expect(await runtime.store.getEffect(effectId)).toMatchObject({
			effect_kind: "model",
			state: "settled",
			outcome: "completed",
		});
		await runtime.dispose();
	}, 60_000);

	it("keeps reasoning and tool input out of public trace events", async () => {
		const mock = createMockModel({
			reasoning: true,
			responses: [
				{
					content: [
						{ type: "thinking", thinking: "private reasoning sentinel" },
						{ type: "toolCall", id: "read-private", name: "read", arguments: { path: "private-input.txt" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		fs.writeFileSync(path.join(cwd, "private-input.txt"), "private tool output sentinel");
		await admitRequest(runtime, startRequest(execution, {
			commandId: "command-public-trace", agentInstanceId: "agent-public-trace",
			agentInstanceRef: "grimoire://tasks/grimoire/public-trace/agents/one",
			executionId: "execution-public-trace", attemptId: "attempt-public-trace",
		}, { cwd, principalId: "owner", input: "inspect the file" }));
		await runtime.drain();
		const events = await runtime.store.pendingEvents();
		const trace = events.filter(event => event.kind.startsWith("trace_"));
		expect(trace.some(event => event.kind === "trace_reasoning")).toBe(true);
		expect(trace.some(event => event.kind === "trace_tool")).toBe(true);
		const tools = trace.filter(event => event.kind === "trace_tool").map(event => (event.payload as { tool?: unknown }).tool);
		expect(tools).toEqual([
			{ callId: "read-private", name: "read" },
			expect.objectContaining({ callId: "read-private", name: "read", outcome: "ok" }),
		]);
		expect(JSON.stringify(trace)).not.toMatch(
			/private reasoning sentinel|private-input\.txt|private tool output sentinel/,
		);
		expect(
			events.some(
				event =>
					event.kind === "message_updated" &&
					event.payload?.stream === "thinking" &&
					event.payload?.text === "private reasoning sentinel",
			),
		).toBeTrue();
		await runtime.dispose();
	}, 60_000);

	it("applies native history edit and branch starts without flattening or changing the source branch", async () => {
		const dispatches: Array<{
			kind: string | undefined;
			input: string;
			sessionId: string;
			messages: string;
		}> = [];
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async (session, input, _identity, kind) => {
			dispatches.push({
				kind,
				input,
				sessionId: session.sessionId,
				messages: JSON.stringify(session.sessionManager.buildSessionContext().messages),
			});
			if (kind === "prompt" || kind === undefined) {
				session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
			}
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `answer:${input}` }],
				api: "engine-runtime-test",
				provider: "mock",
				model: "test",
				usage: {
					input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			return true;
		});
		const request = (commandId: string, attemptId: string, agentInstanceId: string, input?: string) =>
			startRequest(execution, {
				commandId, agentInstanceId,
				agentInstanceRef: `grimoire://tasks/grimoire/history-edit/agents/${agentInstanceId}`,
				executionId: `execution-${attemptId}`, attemptId,
			}, { cwd, principalId: "owner", ...(input !== undefined ? { input } : {}) });
		const source = await admitRequest(runtime, request("history-source-command", "history-source-attempt", "history-source", "original user"));
		await runtime.drain();
		const sourceHistory = await nativeHistory(runtime, source.agentInstanceId);
		const sourceUser = sourceHistory.entries.find(entry => entry.role === "user");
		const sourceAssistant = sourceHistory.entries.find(entry => entry.role === "assistant");
		if (!sourceUser || !sourceAssistant || !sourceHistory.sessionLeafEntryId || !source.sessionFile) {
			throw new Error("Expected complete source history");
		}
		const firstPending = await runtime.enqueueInbox(source, {
			sourceEventId: "history-edit-pending-first",
			sourceType: "user",
			body: "review first",
			createdAt: Date.now(),
		});
		const secondPending = await runtime.enqueueInbox(source, {
			sourceEventId: "history-edit-pending-second",
			sourceType: "user",
			body: "review second",
			createdAt: Date.now() + 1,
		});
		await runtime.reorderInbox(
			source,
			"history-edit-pending-order",
			[firstPending.item.queueId, secondPending.item.queueId],
			[secondPending.item.queueId, firstPending.item.queueId],
		);
		const pendingBeforeEdit = await runtime.listInbox(source);

		const branchRequest = request("history-branch-command", "history-branch-attempt", "history-branch", "new branch prompt");
		branchRequest.historyEdit = {
			mode: "branch",
			source,
			sourceSessionId: sourceHistory.sessionId,
			expectedLeafEntryId: sourceHistory.sessionLeafEntryId,
			entryId: sourceUser.entryId,
		};
		const branched = await admitRequest(runtime, branchRequest);
		await runtime.drain();
		expect(branched.sessionFile).not.toBe(source.sessionFile);
		expect(branched.historyEdit).toMatchObject({ mode: "branch", sourceEntryId: sourceUser.entryId });
		const branchDispatch = dispatches.find(call => call.input === "new branch prompt");
		expect(branchDispatch?.messages).toContain("original user");
		expect(branchDispatch?.messages).not.toContain("answer:original user");
		expect(await runtime.listInbox(branched, true)).toEqual([]);
		expect((await runtime.store.intent(branched.agentInstanceId)).manualHold).toBeFalse();
		expect(await runtime.listInbox(source)).toEqual(pendingBeforeEdit);
		const unchanged = await nativeHistory(runtime, source.agentInstanceId);
		expect(unchanged.entries.map(entry => entry.text)).toEqual(["original user", "answer:original user"]);

		const editedRequest = request(
			"history-edit-command", "history-edit-attempt", source.agentInstanceId,
		);
		editedRequest.context = JSON.stringify({ work_tracking: { receipt: "R-history-edit" } });
		editedRequest.clientMessageId = "edited-client-message";
		editedRequest.historyEdit = {
			mode: "edit",
			source,
			sourceSessionId: sourceHistory.sessionId,
			expectedLeafEntryId: sourceHistory.sessionLeafEntryId,
			entryId: sourceAssistant.entryId,
			replacementText: "edited assistant",
		};
		const edited = await admitRequest(runtime, editedRequest);
		await runtime.drain();
		expect(edited.sessionFile).not.toBe(source.sessionFile);
		expect(edited.historyEdit).toMatchObject({
			mode: "edit",
			sourceEntryId: sourceAssistant.entryId,
			sessionId: expect.any(String),
			replacementEntryId: expect.any(String),
		});
		const editDispatch = dispatches.find(call => call.kind === "continue_after_assistant");
		expect(editDispatch?.messages).toContain('"role":"assistant"');
		expect(editDispatch?.messages).toContain("edited assistant");
		expect(editDispatch?.messages).toContain("R-history-edit");
		expect(JSON.stringify((await nativeHistory(runtime, source.agentInstanceId)).entries)).not.toContain(
			"R-history-edit",
		);
		const review = await runtime.store.intent(edited.agentInstanceId);
		expect(review.manualHold).toBeTrue();
		const migrated = await runtime.listInbox(edited);
		expect(migrated.map(item => [item.queueId, item.position, item.revision, item.deliveryPayload, item.disposition]))
			.toEqual(pendingBeforeEdit.map(item => [item.queueId, item.position, item.revision, item.deliveryPayload, item.disposition]));
		expect(await runtime.store.claimDueInboxWakes(runtime.engineGeneration, Date.now() + 60_000)).toEqual([]);
		const reviewed = request("history-reviewed-command", "history-reviewed-attempt", source.agentInstanceId);
		Object.assign(reviewed, { queueId: migrated[0]!.queueId, expectedRevision: migrated[0]!.revision,
			mutationId: "history-reviewed-delivery", expectedIntentRevision: review.intentRevision - 1, explicitContinue: true });
		await expect(admitRequest(runtime, reviewed)).rejects.toMatchObject({ code: "stale_target" });
		const acceptedReview = request("history-reviewed-current", "history-reviewed-current-attempt", source.agentInstanceId);
		Object.assign(acceptedReview, { queueId: migrated[0]!.queueId, expectedRevision: migrated[0]!.revision,
			mutationId: "history-reviewed-current-delivery", expectedIntentRevision: review.intentRevision, explicitContinue: true });
		await admitRequest(runtime, acceptedReview);
		await runtime.drain();
		expect((await runtime.store.getInboxItemByQueueId(migrated[0]!.queueId))?.disposition).toBe("acknowledged");
		await runtime.dispose();
	}, 60_000);

	it("rejects a history branch while the exact source Attempt is unfinished", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [async () => {
			entered.resolve();
			await release.promise;
			return { content: ["answer"] };
		}] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input, identity) => session.prompt(input, identity));
		const source = await admitRequest(runtime, startRequest(execution, {
			commandId: "active-history-source-command", agentInstanceId: "active-history-source",
			agentInstanceRef: "grimoire://tasks/grimoire/active-history/agents/one",
			executionId: "active-history-source-execution", attemptId: "active-history-source-attempt",
		}, { cwd, principalId: "owner", input: "active source" }));
		try {
		await withTimeout(entered.promise, 5_000, "Source provider did not enter");
		await runtime.agentRegistry.get(source.engineAgentId)!.session!.sessionManager.flush();
		const history = await (async () => {
			for (;;) {
				const changed = runtime.store.changeSignal();
				const page = await nativeHistory(runtime, source.agentInstanceId);
				if (page.sessionLeafEntryId && page.entries[0]) return page;
				await withTimeout(changed, 2_000, "Active source history checkpoint was not published");
			}
		})();
		if (!history.sessionLeafEntryId) throw new Error("Published source history has no native leaf");

		const branchRequest = startRequest(execution, {
			commandId: "active-history-branch-command", agentInstanceId: "active-history-branch",
			agentInstanceRef: "grimoire://tasks/grimoire/active-history/agents/branch",
			executionId: "active-history-branch-execution", attemptId: "active-history-branch-attempt",
		}, { cwd, principalId: "owner", input: "branch while active" });
		branchRequest.historyEdit = {
			mode: "branch",
			source,
			sourceSessionId: history.sessionId,
			expectedLeafEntryId: history.sessionLeafEntryId,
			entryId: history.entries[0].entryId,
		};
		await expect(admitRequest(runtime, branchRequest)).rejects.toMatchObject({ code: "agent_busy" });
		expect(runtime.getBinding("active-history-branch")).toBeUndefined();
		} finally {
			release.resolve();
			await runtime.drain();
			await runtime.dispose();
		}
	}, 60_000);

	it("rejects an over-budget Resume before adding its context to the live or retained session", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [async () => {
			entered.resolve();
			await release.promise;
			return { content: ["answer"] };
		}] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async () => {
			entered.resolve();
			await release.promise;
			return true;
		});
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "budget-context-start", agentInstanceId: "budget-context-root",
			agentInstanceRef: "grimoire://tasks/grimoire/context-budget/agents/root",
			executionId: "budget-context-execution", attemptId: "budget-context-attempt",
		}, { cwd, principalId: "owner", input: "hold this Attempt" }));
		await entered.promise;
		const paused = nextEngineEvent(runtime, "paused");
		const hold = await runtime.pause({
			...started,
			commandId: "budget-context-pause",
			initiator: { kind: "human" },
			expectedIntentRevision: 0,
		});
		release.resolve();
		await paused;
		const session = runtime.agentRegistry.get(started.engineAgentId)!.session!;
		await session.sessionManager.flush();
		await runtime.store.assertIntent(started.agentInstanceId, hold.intentRevision);
		const messages = JSON.stringify(session.messages);
		const retained = JSON.stringify(session.sessionManager.buildSessionContext().messages);
		try {
			for (let n = 1; n <= runtimeLimits.branchControlRecords; n++)
				await runtime.store.registerAgent({
					agentInstanceId: `budget-context-child-${n}`,
					agentInstanceRef: `grimoire://tasks/grimoire/context-budget/agents/child-${n}`,
					parentAgentInstanceId: started.agentInstanceId,
					principalId: "",
					authorityGeneration: 1,
				});
			const error = await runtime
				.resume({
					...started,
					commandId: "budget-context-resume",
					initiator: { kind: "human" },
					expectedIntentRevision: hold.intentRevision,
					context: "This rejected context must never reach the agent",
				})
				.then(
					() => null,
					(resumeError: unknown) => resumeError,
				);
			expect(error).toMatchObject({ code: "restore_budget" });
			expect(JSON.stringify(session.messages)).toBe(messages);
			expect(JSON.stringify(session.sessionManager.buildSessionContext().messages)).toBe(retained);
			expect(await runtime.store.getBinding(started.agentInstanceId)).toMatchObject({
				manualHold: true,
				intentRevision: hold.intentRevision,
			});
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
		} finally {
			await runtime.dispose();
		}
	}, 120_000);

	it("starts one new Attempt from an immediate ordinary queue wake after the active Attempt settles", async () => {
		const firstPrompt = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		let calls = 0;
		const mock = createMockModel({ handler: async () => {
			if (++calls === 1) {
				firstEntered.resolve();
				await firstPrompt.promise;
			}
			return { content: ["done"] };
		} });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution);
		try {
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-auto-queue-a", agentInstanceId: "agent-auto-queue",
			agentInstanceRef: "grimoire://tasks/grimoire/auto-queue/agents/one",
			executionId: "execution-auto-queue-a", attemptId: "attempt-auto-queue-a",
		}, { cwd, principalId: "owner", input: "first" }));
		await withTimeout(firstEntered.promise, 3_000, "First provider turn did not start");
		const wakes: EngineEvent[] = [];
		const firstWake = Promise.withResolvers<void>();
		const secondWake = Promise.withResolvers<void>();
		runtime.subscribe(event => {
			if (event.kind === "inbox_changed" && event.payload?.action === "wake_due") {
				wakes.push(event);
				if (wakes.length === 1) firstWake.resolve();
				if (wakes.length === 2) secondWake.resolve();
			}
		});
		const queued = await runtime.enqueueInbox(started, {
			sourceEventId: "ordinary-auto-queue",
			sourceType: "user",
			body: "queued canonical body",
			createdAt: Date.now(),
			wakeIntent: true,
		});
		const queuedSecond = await runtime.enqueueInbox(started, {
			sourceEventId: "ordinary-auto-queue-second",
			sourceType: "user",
			body: "second queued canonical body",
			createdAt: Date.now(),
			wakeIntent: true,
		});
		expect(await runtime.store.claimDueInboxWakes(runtime.engineGeneration)).toEqual([]);
		expect(wakes).toHaveLength(0);

		firstPrompt.resolve();
		await runtime.drain();
		await withTimeout(firstWake.promise, 3_000, "Settled Attempt did not publish its queue wake");
		expect(wakes[0]?.payload).toEqual({
			action: "wake_due",
			queueId: queued.item.queueId,
			revision: 2,
			intentRevision: started.intentRevision,
			manualHold: false,
		});
		const intervening = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-auto-queue-intervening", agentInstanceId: started.agentInstanceId,
			agentInstanceRef: "grimoire://tasks/grimoire/auto-queue/agents/one",
			executionId: "execution-auto-queue-intervening", attemptId: "attempt-auto-queue-intervening",
		}, { cwd, principalId: "owner", input: "intervening direct Send" }));
		const staleWake = startRequest(execution, {
			commandId: "command-auto-queue-old-wake", agentInstanceId: started.agentInstanceId,
			agentInstanceRef: "grimoire://tasks/grimoire/auto-queue/agents/one",
			executionId: "execution-auto-queue-old-wake", attemptId: "attempt-auto-queue-old-wake",
		}, {
			cwd, principalId: "owner",
			queueId: queued.item.queueId,
			expectedRevision: 2,
			mutationId: "wake:ordinary-auto-queue:2",
			expectedIntentRevision: started.intentRevision,
		});
		await expect(admitRequest(runtime, staleWake)).rejects.toMatchObject({ code: "stale_target" });
		await runtime.drain();
		await withTimeout(secondWake.promise, 3_000, "Intervening Attempt did not publish the renewed queue wake");
		expect(wakes[1]?.payload).toMatchObject({
			queueId: queued.item.queueId,
			revision: 3,
			intentRevision: intervening.intentRevision,
		});
		const next = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-auto-queue-b", agentInstanceId: started.agentInstanceId,
			agentInstanceRef: "grimoire://tasks/grimoire/auto-queue/agents/one",
			executionId: "execution-auto-queue-b", attemptId: "attempt-auto-queue-b",
		}, {
			cwd, principalId: "owner",
			queueId: queued.item.queueId,
			expectedRevision: 3,
			mutationId: "wake:ordinary-auto-queue:3",
			expectedIntentRevision: intervening.intentRevision,
		}));
		expect(next).toMatchObject({
			duplicate: false,
			queueId: queued.item.queueId,
			queueRevision: 4,
			manualHold: false,
		});
		const nextEvents = (await runtime.store.pendingEvents()).filter(event => event.attemptId === next.attemptId);
		expect(
			nextEvents.find(
				event =>
					event.kind === "inbox_changed" &&
					event.payload?.action === "acknowledge" &&
					event.payload?.queueId === queued.item.queueId,
			),
		).toMatchObject({
			causationCommandId: "command-auto-queue-b",
			payload: {
				action: "acknowledge",
				queueId: queued.item.queueId,
				revision: 4,
				sourceEventId: "ordinary-auto-queue",
			},
		});
		await runtime.drain();
		expect(await runtime.store.getInboxItem(queued.item.sessionId, queued.item.queueId)).toMatchObject({
			disposition: "acknowledged",
			revision: 4,
		});
		expect(await runtime.store.getInboxItemByQueueId(queuedSecond.item.queueId)).toMatchObject({ disposition: "pending" });
		expect(mock.calls).toHaveLength(3);
		const providerParts = mock.calls[2].context.messages.flatMap(message => message.role !== "user" ? [] :
			typeof message.content === "string" ? [message.content] :
				message.content.flatMap(part => part.type === "text" ? part.text : []));
		expect(providerParts.filter(text => text === queued.item.deliveryPayload)).toEqual([queued.item.deliveryPayload]);
		expect(providerParts).not.toContain(queuedSecond.item.deliveryPayload);
		const native = await nativeSession(runtime, next.sessionFile!);
		expect(native.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"))
			.toMatchObject([
				{ sourceCommandId: "command-auto-queue-a", message: { content: [{ type: "text", text: "first" }] } },
				{ sourceCommandId: "command-auto-queue-intervening", message: { content: [{ type: "text", text: "intervening direct Send" }] } },
				{ sourceCommandId: "command-auto-queue-b", clientMessageId: queued.item.sourceEventId,
					message: { content: [{ type: "text", text: queued.item.deliveryPayload }] },
					launchSnapshot: { attemptId: next.attemptId, executionId: next.executionId, executionDigest: next.executionDigest } },
			]);
		} finally {
			firstPrompt.resolve();
			await runtime.dispose();
		}
	}, 60_000);

	it("binds hosted MCP tools to their own origin across legacy history, children and restart, without fallback", async () => {
		const live = { owned: new Set<string>(), foreign: new Set<string>() };
		const calls = { owned: 0, foreign: 0 };
		let unavailable = false;
		const failedConnectionClosed = Promise.withResolvers<void>();
		const serve = (origin: "owned" | "foreign") =>
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (
						origin === "owned" &&
						(new URL(request.url).pathname !== "/mcp/core" ||
							request.headers.get("Authorization") !== "Bearer isolated-mcp-test" ||
							request.headers.get("X-Grimoire-Client") !== "engine-route-test")
					) {
						return new Response(null, { status: 403 });
					}
					if (request.method === "DELETE") {
						live[origin].delete(request.headers.get("Mcp-Session-Id") ?? "");
						if (origin === "owned" && unavailable) failedConnectionClosed.resolve();
						return new Response(null, { status: 204 });
					}
					if (request.method === "GET") return new Response(null, { status: 405 });
					const message = (await request.json()) as { id?: string | number; method: string };
					if (message.id === undefined) return new Response(null, { status: 202 });
					if (message.method === "initialize") {
						const id = `${origin}-${++calls[origin]}`;
						live[origin].add(id);
						return Response.json(
							{
								jsonrpc: "2.0",
								id: message.id,
								result: {
									protocolVersion: "2025-11-25",
									capabilities: { tools: {} },
									serverInfo: { name: origin, version: "1" },
								},
							},
							{ headers: { "Mcp-Session-Id": id } },
						);
					}
					if (message.method === "tools/list") {
						if (origin === "owned") {
							if (unavailable) return new Response(null, { status: 503 });
							// Exceed MCPManager's UI startup grace: hosted model dispatch must wait for tools.
							await Bun.sleep(350);
						}
						return Response.json({
							jsonrpc: "2.0",
							id: message.id,
							result: {
								tools: [
									{
										name: `${origin}_probe`,
										description: `${origin} fixture lookup`,
										inputSchema: { type: "object", properties: {} },
									},
								],
							},
						});
					}
					return Response.json({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "unsupported fixture method" },
					});
				},
			});
		const owned = serve("owned");
		const foreign = serve("foreign");
		const discover = spyOn(mcpConfig, "loadAllMCPConfigs").mockResolvedValue({
			configs: { foreign: { type: "http", url: `${foreign.url}mcp` } },
			sources: {},
			exaApiKeys: [],
		});
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { enableMCP: true },
		});
		const setup = await createRuntime(execution, (session, input) => session.prompt(input));
		let runtime = setup.runtime;
		const request = (agent: string, turn: number) =>
			startRequest(execution, {
				commandId: `${agent}-command-${turn}`, agentInstanceId: agent,
				agentInstanceRef: `grimoire://tasks/grimoire/mcp-route/agents/${agent}`,
				executionId: `${agent}-execution-${turn}`, attemptId: `${agent}-attempt-${turn}`,
			}, { cwd: setup.cwd, principalId: "owner", input: `${agent} turn ${turn}` });
		const lastMcpTools = () =>
			mock.calls
				.at(-1)
				?.context.tools?.map(tool => tool.name)
				.filter(name => name.startsWith("mcp__")) ?? [];
		try {
			const first = await admitRequest(runtime, request("route-root", 1));
			await runtime.drain();
			await admitRequest(runtime, request("route-root", 2));
			await runtime.drain();
			await admitRequest(runtime, request("route-root", 3));
			await runtime.drain();
			expect(lastMcpTools()).toEqual(["mcp__foreign_probe"]);
			const oldHistory = await retainedEntries(runtime, first.sessionFile!);
			const oldMessages = oldHistory.entries.filter(entry => entry.type === "message");
			expect(oldMessages).toHaveLength(6);
			const foreignCallsBeforeBinding = calls.foreign;
			await runtime.dispose();
			expect(live.foreign.size).toBe(0);
			const boundOptions: EngineRuntimeOptions = {
				...setup.options,
				mcpServer: {
					...hostedCoreMcpConfig({
						serverUrl: `${owned.url}mcp/client_agents`,
						token: "isolated-mcp-test",
						clientId: "engine-route-test",
					}),
					timeout: 1000,
				},
			};
			runtime = await openRuntime(boundOptions);
			const upgraded = await admitRequest(runtime, request("route-root", 4));
			await runtime.drain();
			expect(upgraded.sessionFile).toBe(first.sessionFile);
			expect(lastMcpTools()).toEqual(["mcp__grimoire_engine_owned_probe"]);
			expect(calls.foreign).toBe(foreignCallsBeforeBinding);
			expect(live.owned.size).toBe(1);
			unavailable = true;
			const modelCallsBeforeFailure = mock.calls.length;
			await expect(admitRequest(runtime, request("mcp-unavailable", 1))).rejects.toThrow(
				"Hosted Core MCP binding failed",
			);
			expect(mock.calls).toHaveLength(modelCallsBeforeFailure);
			expect(runtime.getBinding("mcp-unavailable")).toBeUndefined();
			// MCPManager rejects promptly and closes failed catalog sessions in the background.
			await Promise.race([failedConnectionClosed.promise, Bun.sleep(1000)]);
			expect(live.owned.size).toBeLessThanOrEqual(1);
			expect(calls.foreign).toBe(foreignCallsBeforeBinding);
			unavailable = false;
			await runtime.dispose();
			expect(live.owned.size).toBe(0);
			runtime = await openRuntime(boundOptions);
			const restarted = await admitRequest(runtime, request("route-root", 5));
			await runtime.drain();
			expect(restarted.sessionFile).toBe(first.sessionFile);
			expect(lastMcpTools()).toEqual(["mcp__grimoire_engine_owned_probe"]);
			expect(calls.foreign).toBe(foreignCallsBeforeBinding);
			const retained = await retainedEntries(runtime, restarted.sessionFile!);
			expect(retained.entries[0]).toEqual(oldHistory.entries[0]);
			expect(retained.entries.filter(entry => entry.type === "message").slice(0, 6)).toEqual(oldMessages);
			expect(JSON.stringify(retained.entries)).not.toContain("isolated-mcp-test");
			await runtime.dispose();
			expect(live.owned.size).toBe(0);
			owned.stop(true);
			runtime = await openRuntime(boundOptions);
			const modelCallsBeforeOffline = mock.calls.length;
			await expect(admitRequest(runtime, request("mcp-offline", 1))).rejects.toThrow(
				"Hosted Core MCP binding failed",
			);
			expect(runtime.getBinding("mcp-offline")).toBeUndefined();
			expect(mock.calls).toHaveLength(modelCallsBeforeOffline);
			expect(calls.foreign).toBe(foreignCallsBeforeBinding);
		} finally {
			await runtime.dispose();
			discover.mockRestore();
			owned.stop(true);
			foreign.stop(true);
		}
	}, 60_000);

	it("launches six pinned children in parallel and rejects the seventh", async () => {
		const taskCall = (index: number) => ({
			type: "toolCall" as const,
			id: `tool-child-${index}`,
			name: "task",
			arguments: {
				target: { task_ref: "grimoire://tasks/grimoire/child-ceiling", work_step_id: `child-step-${index}` },
				assignment: `Do child step ${index}`,
			},
		});
		const mock = createMockModel({
			responses: [{ content: Array.from({ length: 7 }, (_, index) => taskCall(index)) }, { content: ["done"] }],
		});
		const launches: Array<{ toolCallId: string; target: { work_step_id: string | null } }> = [];
		const execution = admittedExecution(mock.model, modelRegistry, {
			spawn: { allowed: "auto", max_depth: 1, max_children: 6, on_exceed: "deny" },
			continuation: { toolNames: ["task"], restrictToolNames: true },
			scopeAgents: 8,
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input), {
			launchChild: async request => {
				const effect = await runtime.store.getEffect(request.effectId);
				expect(effect).toMatchObject({
					effect_id: request.effectId, tool_call_id: request.toolCallId,
					input_hash: request.inputHash, tool_name: "task", effect_kind: "tool", state: "started",
					agent_instance_id: "parent-agent", attempt_id: "attempt-parent", command_id: "command-parent",
				});
				expect(request.toolName).toBe("task");
				expect(request.parentAgentInstanceId).toBe("parent-agent");
				expect(request.parentAttemptId).toBe("attempt-parent");
				launches.push(request);
				return {
					agentInstanceId: `child-${request.toolCallId}`,
					status: "completed",
					assistantFinal: `done ${request.toolCallId}`,
				};
			},
		});
		await admitRequest(runtime, startRequest(execution, {
			commandId: "command-parent", agentInstanceId: "parent-agent",
			agentInstanceRef: "grimoire://tasks/grimoire/child-ceiling/agents/parent-agent",
			executionId: "execution-parent", attemptId: "attempt-parent",
		}, { cwd, principalId: "owner", input: "delegate" }));
		await runtime.drain();
		expect(launches).toHaveLength(6);
		// Parallel calls reserve the ceiling in any order: exactly one of the seven is refused.
		const outcomes = Array.from({ length: 7 }, (_, index) => {
			const id = `tool-child-${index}`;
			const text = toolResultOf(mock, id)?.content.find(part => part.type === "text")?.text ?? "";
			if (text === `done ${id}`) return "done";
			return text.includes("Child spawn ceiling reached") ? "ceiling" : text;
		});
		expect([...outcomes].sort()).toEqual(["ceiling", ...Array.from({ length: 6 }, () => "done")]);
		expect(launches.map(launch => launch.toolCallId)).not.toContain(`tool-child-${outcomes.indexOf("ceiling")}`);
		for (const launch of launches) {
			expect(launch).toMatchObject({
				target: { work_step_id: launch.toolCallId.replace("tool-child-", "child-step-") },
			});
		}
		await runtime.dispose();
	}, 60_000);

	it("resets the child launch ceiling when an idle root binding is reused for a new Attempt", async () => {
		const taskCalls = {
			content: Array.from({ length: 3 }, (_, index) => ({
				type: "toolCall" as const,
				id: `tool-child-${index}`,
				name: "task",
				arguments: {
					target: { task_ref: "grimoire://tasks/grimoire/child-reuse", work_step_id: `child-step-${index}` },
					assignment: `Do child step ${index}`,
				},
			})),
		};
		const mock = createMockModel({
			responses: [taskCalls, { content: ["done first"] }, taskCalls, { content: ["done second"] }],
		});
		const launches: string[] = [];
		let failedSecondRound = false;
		const spawn = { allowed: "auto" as const, max_depth: 1, max_children: 2, on_exceed: "deny" as const };
		const execution = admittedExecution(mock.model, modelRegistry, {
			taskRef: "grimoire://tasks/grimoire/child-reuse",
			spawn,
			continuation: { toolNames: ["task"], restrictToolNames: true, spawn },
			scopeAgents: 8,
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input), {
			launchChild: async request => {
				launches.push(request.parentAttemptId);
				// Parallel task calls reserve the ceiling in any order, so the second round fails its first launch.
				if (request.parentAttemptId === "attempt-b" && !failedSecondRound) {
					failedSecondRound = true;
					throw new Error("child unavailable");
				}
				return {
					agentInstanceId: `child-${request.toolCallId}`,
					status: "completed",
					assistantFinal: `done ${request.toolCallId}`,
				};
			},
		});
		const request = (suffix: string, attemptId: string) =>
			startRequest(execution, {
				commandId: `command-parent-reuse-${suffix}`, agentInstanceId: "parent-reuse-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/child-reuse/agents/parent-reuse-agent",
				executionId: `execution-parent-reuse-${suffix}`, attemptId,
			}, { cwd, principalId: "owner", input: `${suffix} round` });
		const first = await admitRequest(runtime, request("first", "attempt-a"));
		await runtime.drain();
		const second = await admitRequest(runtime, request("second", "attempt-b"));
		await runtime.drain();
		expect(second.bindingGeneration).toBe(first.bindingGeneration + 1);
		expect(second.sessionFile).toBe(first.sessionFile);
		// The second round's last model call sees both rounds' task results; each round has its own three.
		const results = mock.calls
			.at(-1)!
			.context.messages.flatMap(message =>
				message.role === "toolResult"
					? [{ id: message.toolCallId, text: message.content.find(part => part.type === "text")?.text ?? "" }]
					: [],
			);
		expect(results).toHaveLength(6);
		const outcomes = results.map(({ id, text }) => {
			if (text === `done ${id}`) return "done";
			if (text.includes("Task execution failed: child unavailable")) return "failed";
			if (text.includes("Child spawn ceiling reached")) return "ceiling";
			return text;
		});
		for (const [start, expected] of [
			[0, ["ceiling", "done", "done"]],
			[3, ["ceiling", "done", "failed"]],
		] as const) {
			expect(
				results
					.slice(start, start + 3)
					.map(result => result.id)
					.sort(),
			).toEqual(["tool-child-0", "tool-child-1", "tool-child-2"]);
			expect(outcomes.slice(start, start + 3).sort()).toEqual([...expected]);
		}
		expect(launches).toEqual(["attempt-a", "attempt-a", "attempt-b", "attempt-b"]);
		const entries = (await nativeHistory(runtime, "parent-reuse-agent", "child-reuse")).entries;
		expect(entries.filter(entry => entry.role === "user").map(entry => entry.text)).toEqual([
			"first round",
			"second round",
		]);
		await runtime.dispose();
	}, 60_000);

	it("binds native task discovery to each parent and exposes a failed launch as an error", async () => {
		const parents = ["first", "second"] as const;
		const ref = (id: string) => `grimoire://tasks/grimoire/task-discovery/agents/parent-${id}`;
		const descriptions = new Map<string, string>();
		const results = new Map<string, boolean | undefined>();
		const launches: string[] = [];
		// Both parents share this model concurrently, so each call answers from its own context.
		const mock = createMockModel({
			handler: context =>
				context.messages.at(-1)?.role === "toolResult"
					? { content: ["done"] }
					: {
							content: [
								{
									type: "toolCall" as const,
									id: "delegate",
									name: "task",
									arguments: {
										target: { task_ref: "grimoire://tasks/grimoire/task-discovery", work_step_id: "child" },
										assignment: "Do child work",
									},
								},
							],
						},
		});
		const spawn = { allowed: "auto" as const, max_depth: 1, max_children: 1, on_exceed: "deny" as const };
		const execution = admittedExecution(mock.model, modelRegistry, {
			taskRef: "grimoire://tasks/grimoire/task-discovery",
			spawn,
			continuation: { toolNames: ["task"], restrictToolNames: true, spawn },
			scopeAgents: 4,
		});
		const { runtime, cwd } = await createRuntime(execution, async (session, input) => {
			const task = session.getToolByName("task");
			if (!task) throw new Error("Engine root did not expose task");
			descriptions.set(input, task.description);
			await session.prompt(input);
			const result = session.messages.find(message => message.role === "toolResult");
			results.set(input, result?.role === "toolResult" ? result.isError : undefined);
			if (input === "first") {
				expect(result?.isError).toBeTrue();
			}
			return true;
		}, {
			launchChild: async request => {
				launches.push(request.parentAgentInstanceRef);
				if (request.parentAgentInstanceRef === ref("first")) throw new Error("WorkStep child is unavailable");
				return { agentInstanceId: "child-second", status: "completed", assistantFinal: "child completed" };
			},
		});
		try {
			await Promise.all(
				parents.map(id =>
					admitRequest(runtime, startRequest(execution, {
						commandId: `command-${id}`, agentInstanceId: `parent-${id}`,
						agentInstanceRef: ref(id), executionId: `execution-${id}`, attemptId: `attempt-${id}`,
					}, { cwd, principalId: "owner", input: id })),
				),
			);
			await runtime.drain();
			for (const id of parents) {
				expect(descriptions.get(id)).toContain(ref(id));
				expect(descriptions.get(id)).not.toContain(ref(id === "first" ? "second" : "first"));
			}
			expect(launches.sort()).toEqual(parents.map(ref));
			expect(results.get("first")).toBeTrue();
			expect(results.get("second")).not.toBeTrue();
			const settled = (await runtime.store.pendingEvents()).filter(event => event.kind === "tool_settled");
			expect(settled).toHaveLength(2);
			for (const event of settled) {
				expect(await runtime.store.getEffect(String((event.payload as { invocationId?: string }).invocationId))).toMatchObject({
					outcome: event.agentInstanceId === "parent-first" ? "failed" : "completed",
				});
			}
		} finally {
			await runtime.dispose();
		}
	}, 60_000);


	it("refuses an unadmitted restricted device before inner effect or approval", async () => {
		const mock = toolTurnModel("denied-device-write", "write", {
			path: "xd://bash", content: JSON.stringify({ command: "echo must-not-execute" }),
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["write", "grep"], restrictToolNames: true,
				toolPolicies: { grep: "permit" }, tools_permit: ["grep"] },
		});
		const { runtime, cwd } = await createRuntime(execution,
			(session, input, identity) => session.prompt(input, identity));
		try {
			const target = await admitRequest(runtime, startRequest(execution, {
				commandId: "denied-device", agentInstanceId: "denied-device",
				agentInstanceRef: `${execution.taskRef}/agents/denied-device`,
				executionId: "denied-device-execution", attemptId: "denied-device-attempt",
			}, { cwd, principalId: "owner", input: "Do not widen tools through devices" }));
			await runtime.drain();
			expect(toolResultOf(mock, "denied-device-write")?.isError).toBe(true);
			expect(JSON.stringify(toolResultOf(mock, "denied-device-write")?.content)).toContain("No such tool: xd://bash");
			const effects = await runtime.store.attemptToolEffects(target.attemptId);
			expect(effects.filter(effect => effect.effect_kind === "tool").map(effect => effect.tool_name)).toEqual(["write"]);
			const events = await runtime.store.pendingEvents();
			expect(events.filter(event => event.kind.endsWith("_approval_requested"))).toEqual([]);
		} finally { await runtime.dispose(); }
	});

	it.each(["approve", "cancel"] as const)(
		"executes write→xd with a distinct durable device effect and honors %s",
		async decision => {
			let deviceResult: string | undefined;
			const args = {
				path: "xd://grep",
				content: JSON.stringify({ pattern: "needle", path: "fixture.txt" }),
			};
			const mock = toolTurnModel("outer-write", "write", args);
			const execution = admittedExecution(mock.model, modelRegistry, {
				continuation: { toolNames: ["write", "grep"], restrictToolNames: true, toolPolicies: { grep: "permit" }, tools_permit: ["grep"] },
			});
			const { runtime, cwd } = await createRuntime(execution, async (session, input) => {
				await session.prompt(input);
				const result = toolResultOf(mock, "outer-write");
				if (result && !result.isError) {
					deviceResult = JSON.stringify(result.content);
					const write = session.getToolByName("write");
					if (!write) throw new Error("write tool is unavailable");
					await expect(write.execute("outer-write", args)).rejects.toThrow();
				}
				return true;
			});
			try {
				fs.writeFileSync(path.join(cwd, "fixture.txt"), "needle\n");
				const requested = nextEngineEvent(runtime, "tool_approval_requested");
				const started = await admitRequest(runtime, startRequest(execution, {
					commandId: "command-xd", agentInstanceId: "agent-xd",
					agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-xd",
					executionId: "execution-xd", attemptId: "attempt-xd",
				}, { cwd, principalId: "owner", input: "grep through xd" }));
				const approval = await Promise.race([
					requested,
					runtime.drain().then(() => {
						throw new Error("Device finished without requesting its Engine permit");
					}),
				]);
				const approvalId = String((approval.payload as { id?: string }).id);
				expect(deviceResult).toBeUndefined();
				expect(await runtime.store.getEffect(approvalId)).toMatchObject({
					tool_name: "grep",
					policy: "permit",
					state: "planned",
				});
				if (decision === "approve") {
					const decisionValue = approvalDecisionFor(execution, started, "approve-xd", (await runtime.store.getApproval(approvalId))!.request, "approve");
					await runtime.resolveApproval({ ...started, commandId: "approve-xd", approvalDecision: decisionValue });
				} else {
					await runtime.cancel({ ...started, commandId: "cancel-xd" });
				}
				await runtime.drain();
				const events = await runtime.store.pendingEvents();
				const tools = events.filter(event => event.kind === "tool_started");
				expect(tools.filter(event => (event.payload as { toolName?: string }).toolName === "write")).toHaveLength(1);
				expect(tools.filter(event => (event.payload as { toolName?: string }).toolName === "grep")).toHaveLength(
					decision === "approve" ? 1 : 0,
				);
				expect(await runtime.store.getEffect(approvalId)).toMatchObject({
					state: "settled",
					outcome: decision === "approve" ? "completed" : "cancelled",
				});
				if (decision === "approve") {
					expect(deviceResult).toContain("needle");
					expect(new Set(tools.map(event => (event.payload as { toolCallId?: string }).toolCallId)).size).toBe(2);
				} else {
					expect(deviceResult).toBeUndefined();
				}
			} finally {
				await runtime.dispose();
			}
		},
		60_000,
	);

	it("settles a tracked async effect only after its owner job finishes", async () => {
		const release = Promise.withResolvers<string>();
		const mock = toolTurnModel("read-tracked", "read", { path: "tracked.txt" });
		let runtimeRef!: EngineRuntime;
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true, toolPolicies: { read: "tracked" } },
		});
		let cwd = "";
		({ runtime: runtimeRef, cwd } = await createRuntime(execution, (session, input) => {
			const jobId = runtimeRef.asyncJobManager.register("bash", "tracked", () => release.promise, {
				ownerId: session.getAgentId(),
				attemptId: session.getAttemptId(),
				sourceToolCallId: "read-tracked",
			});
			runtimeRef.asyncJobManager.watchJobs([jobId]);
			return session.prompt(input);
		}));
		fs.writeFileSync(path.join(cwd, "tracked.txt"), "tracked");
		const toolStarted = nextEngineEvent(runtimeRef, "tool_started");
		const started = await admitRequest(runtimeRef, startRequest(execution, {
			commandId: "command-tracked", agentInstanceId: "agent-tracked",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-tracked",
			executionId: "execution-tracked", attemptId: "attempt-tracked",
		}, { cwd, principalId: "owner", input: "read" }));
		const startedEvent = await toolStarted;
		const effectId = String((startedEvent.payload as { invocationId?: string }).invocationId);
		expect((await runtimeRef.store.getAttempt(started.attemptId))?.state).toBe("running");
		expect(await runtimeRef.store.getEffect(effectId)).toMatchObject({ state: "started", policy: "tracked" });
		expect((await runtimeRef.store.pendingEvents()).find(event => event.kind === "tool_settled")).toBeUndefined();
		release.resolve("done");
		await runtimeRef.drain();
		const events = await runtimeRef.store.pendingEvents();
		expect((events.find(event => event.kind === "tool_settled")?.payload as { status?: string })?.status).toBe("completed");
		expect(events.findIndex(event => event.kind === "tool_settled")).toBeLessThan(
			events.findIndex(event => event.kind === "completed"),
		);
		expect(await runtimeRef.store.getEffect(effectId)).toMatchObject({ state: "settled", outcome: "completed" });
		await runtimeRef.dispose();
	}, 60_000);

	it("keeps a background effect open while paused and settles only after resume", async () => {
		const release = Promise.withResolvers<string>();
		const mock = toolTurnModel("read-paused-background", "read", { path: "paused.txt" });
		let runtimeRef!: EngineRuntime;
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true, toolPolicies: { read: "tracked" } },
		});
		let cwd = "";
		({ runtime: runtimeRef, cwd } = await createRuntime(execution, (session, input) => {
			const jobId = runtimeRef.asyncJobManager.register("bash", "paused background", () => release.promise, {
				ownerId: session.getAgentId(),
				attemptId: session.getAttemptId(),
				sourceToolCallId: "read-paused-background",
			});
			runtimeRef.asyncJobManager.watchJobs([jobId]);
			return session.prompt(input);
		}));
		fs.writeFileSync(path.join(cwd, "paused.txt"), "paused");
		const toolStarted = nextEngineEvent(runtimeRef, "tool_started");
		const started = await admitRequest(runtimeRef, startRequest(execution, {
			commandId: "command-paused-background", agentInstanceId: "agent-paused-background",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-paused-background",
			executionId: "execution-paused-background", attemptId: "attempt-paused-background",
		}, { cwd, principalId: "owner", input: "read" }));
		const effectId = String(((await toolStarted).payload as { invocationId?: string }).invocationId);
		const paused = nextEngineEvent(runtimeRef, "paused");
		await runtimeRef.pause({ ...started, commandId: "pause-background", initiator: { kind: "human" } });
		await paused;
		expect(await runtimeRef.store.getEffect(effectId)).toMatchObject({ state: "started" });
		expect((await runtimeRef.store.getAttempt(started.attemptId))?.state).toBe("paused");
		expect((await runtimeRef.store.pendingEvents()).some(event => event.kind === "completed")).toBeFalse();

		const toolSettled = nextEngineEvent(runtimeRef, "tool_settled");
		release.resolve("done");
		await toolSettled;
		expect((await runtimeRef.store.getAttempt(started.attemptId))?.state).toBe("paused");
		const completed = nextEngineEvent(runtimeRef, "completed");
		await runtimeRef.resume({ ...started, commandId: "resume-background", initiator: { kind: "human" } });
		await completed;
		expect(await runtimeRef.store.getEffect(effectId)).toMatchObject({ state: "settled", outcome: "completed" });
		await runtimeRef.dispose();
	}, 60_000);

	it("cancels an Attempt that is waiting for Ask input", async () => {
		const questions = [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }];
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: "ask-cancel", name: "ask", arguments: { questions } }] }],
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["ask"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-cancel-input", agentInstanceId: "agent-cancel-input",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-cancel-input",
			executionId: "execution-cancel-input", attemptId: "attempt-cancel-input",
		}, { cwd, principalId: "owner", input: "ask" }));
		const input = await requested;
		const resolved = nextEngineEvent(runtime, "input_resolved");
		await runtime.cancel({ ...started, commandId: "command-stop-input", reason: "No answer needed" });
		await runtime.drain();
		expect(await resolved).toMatchObject({
			causationCommandId: "command-stop-input",
			payload: {
				inputId: (input.payload as { inputId?: string }).inputId,
				status: "cancelled",
				reason: "No answer needed",
				attemptState: "cancel_requested",
				controlReadiness: { pause: false, resume: false, steer: false, cancel: false, resolveInput: false },
			},
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const eventKinds = (await runtime.store.pendingEvents()).map(event => event.kind);
		expect(eventKinds.indexOf("input_resolved")).toBeLessThan(eventKinds.indexOf("cancelled"));
		await runtime.dispose();
	}, 60_000);

	it("releases pending Ask input when its dialog signal aborts", async () => {
		const questions = [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }];
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: "ask-abort", name: "ask", arguments: { questions } }] }],
		});
		let abortDialog: (() => Promise<void>) | undefined;
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["ask"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => {
			abortDialog = () => session.abort({ reason: "dialog aborted" });
			return session.prompt(input);
		});
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-abort-input", agentInstanceId: "agent-abort-input",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-abort-input",
			executionId: "execution-abort-input", attemptId: "attempt-abort-input",
		}, { cwd, principalId: "owner", input: "ask" }));
		const input = await requested;
		const resolved = nextEngineEvent(runtime, "input_resolved");
		if (!abortDialog) throw new Error("dialog abort handle is unavailable");
		await abortDialog();
		await runtime.drain();
		expect(await resolved).toMatchObject({
			payload: {
				inputId: (input.payload as { inputId?: string }).inputId,
				status: "cancelled",
				reason: "Input request aborted",
			},
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).not.toBe("waiting_input");
		await expect(
			runtime.resolveInput({
				...started,
				commandId: "late-input",
				inputId: String((input.payload as { inputId?: string }).inputId),
				result: { kind: "chat" },
			}),
		).rejects.toMatchObject({ code: "too_late" });
		await runtime.dispose();
	}, 60_000);

	it("does not publish a cancelled user append into the next Attempt", async () => {
		const dispatchEntered = Promise.withResolvers<void>();
		const allowAppend = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		const stopAdmitted = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					await releaseProvider.promise;
					return { content: ["answer"] };
				},
				{ content: ["next answer"] },
			],
		});
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async (session, text, identity) => {
			if (text === "cancel this user append") {
				dispatchEntered.resolve();
				await allowAppend.promise;
			}
			return session.prompt(text, identity);
		});
		let stopOnAppend: (() => void) | undefined;
		const createManager = SessionManager.createNative.bind(SessionManager);
		const creation = spyOn(SessionManager, "createNative").mockImplementation((...args) => {
			const manager = createManager(...args);
			if (args[0] === cwd) {
				manager.onEntryAppended = entry => {
					if (entry.type !== "message" || entry.message.role !== "user") return;
					// The existing collab tap admits Stop before the Engine queues its history publication.
					stopOnAppend?.();
					stopOnAppend = undefined;
				};
			}
			return manager;
		});
		try {
			const input = "cancel this user append";
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "history-cancel-start", agentInstanceId: "history-cancel-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/history-cancel-agent",
				executionId: "history-cancel-execution", attemptId: "history-cancel-attempt",
			}, { cwd, principalId: "owner", input }));
			await withTimeout(dispatchEntered.promise, 2_000, "Start did not reach the append boundary");
			const beforeAppend = Math.max(0, ...(await runtime.store.pendingEvents()).map(event => event.eventId));
			stopOnAppend = () => {
				runtime
					.cancel({ ...started, commandId: "history-cancel-stop" })
					.then(() => stopAdmitted.resolve(), stopAdmitted.reject);
			};
			allowAppend.resolve();
			await withTimeout(stopAdmitted.promise, 2_000, "Stop deadlocked with the history write tail");
			releaseProvider.resolve();
			await withTimeout(runtime.drain(), 3_000, "Cancelled append did not quiesce");
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
			const stoppedEvents = await runtime.store.pendingEvents();
			expect(
				stoppedEvents.filter(event => event.eventId > beforeAppend &&
					event.kind === "reconciled" && event.attemptId === started.attemptId),
			).toHaveLength(0);
			const stopped = await runtime.store.intent(started.agentInstanceId);
			const next = await admitRequest(runtime, startRequest(execution, {
				commandId: "history-next-start", agentInstanceId: started.agentInstanceId,
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/history-cancel-agent",
				executionId: "history-next-execution", attemptId: "history-next-attempt",
			}, {
				cwd, principalId: "owner", input: "only the next Attempt owns this user append",
				expectedIntentRevision: stopped.intentRevision,
				explicitContinue: true,
			}));
			await withTimeout(runtime.drain(), 3_000, "Next Attempt did not finish");
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
			expect((await runtime.store.getAttempt(next.attemptId))?.state).toBe("completed");
			const events = await runtime.store.pendingEvents();
			expect(events.filter(event => event.kind === "reconciled" && event.eventId > beforeAppend)
				.every(event => event.attemptId === next.attemptId)).toBe(true);
			const history = await nativeHistory(runtime, next.agentInstanceId);
			expect(history.entries.filter(entry => entry.role === "user").map(entry => entry.text)).toEqual([
				input,
				"only the next Attempt owns this user append",
			]);
		} finally {
			stopOnAppend = undefined;
			allowAppend.resolve();
			releaseProvider.resolve();
			try {
				await runtime.drain();
				await runtime.dispose();
			} finally {
				creation.mockRestore();
			}
		}
	}, 20_000);

	it("resolves the largest indexed Ask reply without echoing or losing canonical option labels", async () => {
		const questions = Array.from({ length: 2 }, (_, question) => ({
			id: `question-${question}`,
			question: "q".repeat(9_000),
			multi: true,
			options: Array.from({ length: 32 }, (_, option) => ({
				label: `${question}:${option}:`.padEnd(2_048, "x"),
			})),
		}));
		const release = Promise.withResolvers<void>();
		const secondModelCall = Promise.withResolvers<void>();
		let activeSession: AgentSession | undefined;
		const mock = createMockModel({
			responses: (async function* () {
				yield {
					content: [{ type: "toolCall" as const, id: "ask-indexed", name: "ask", arguments: { questions } }],
				};
				secondModelCall.resolve();
				await release.promise;
				yield { content: ["done"] };
			})(),
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["ask"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => {
			activeSession = session;
			return session.prompt(input);
		});
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-indexed-start", agentInstanceId: "agent-indexed",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-indexed",
			executionId: "execution-indexed", attemptId: "attempt-indexed",
		}, { cwd, principalId: "owner", input: "ask" }));
		const input = await requested;
		const inputId = String((input.payload as { inputId: string }).inputId);
		const expectedIntentRevision = (await runtime.store.intent(started.agentInstanceId)).intentRevision;
		const result = {
			kind: "submit" as const,
			results: questions.map(question => ({
				id: question.id,
				selectedOptionIndexes: question.options.map((_option, index) => index),
			})),
		};
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_500);
		const request = {
			...started,
			commandId: "command-indexed-reply",
			inputId,
			expectedIntentRevision,
			expectedInputRevision: input.eventId,
			result,
		};
		try {
			for (const invalid of [
				{ ...result.results[0], id: "foreign-question" },
				{ ...result.results[0], selectedOptionIndexes: [32] },
				{ ...result.results[0], selectedOptionIndexes: [1, 1] },
				{ ...result.results[0], options: ["forged label"] },
			]) {
				await expect(
					runtime.resolveInput({ ...request, result: { ...result, results: [invalid, result.results[1]] } }),
				).rejects.toMatchObject({ code: "invalid_request" });
			}
			await expect(
				runtime.resolveInput({ ...request, expectedInputRevision: input.eventId + 1 }),
			).rejects.toMatchObject({ code: "stale_target" });
			await expect(
				runtime.resolveInput({ ...request, expectedIntentRevision: expectedIntentRevision + 1 }),
			).rejects.toMatchObject({ code: "stale_target" });
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_input");
			const resolved = nextEngineEvent(runtime, "input_resolved");
			await runtime.resolveInput(request);
			const event = await resolved;
			expect(event).toMatchObject({ attemptId: started.attemptId, payload: { inputId, result } });
			expect(Buffer.byteLength(JSON.stringify(event.payload))).toBeLessThan(2_048);
			await secondModelCall.promise;
			const toolResult = activeSession?.messages.find(message => message.role === "toolResult");
			expect(toolResult).toMatchObject({
				role: "toolResult",
				toolCallId: "ask-indexed",
				isError: false,
				details: {
					results: questions.map(question => ({
						id: question.id,
						question: question.question,
						multi: true,
						options: question.options.map(option => option.label),
						selectedOptions: question.options.map(option => option.label),
					})),
				},
			});
			expect(Buffer.byteLength(JSON.stringify(toolResult))).toBeGreaterThan(262_144);
			await expect(runtime.resolveInput(request)).rejects.toMatchObject({ code: "too_late" });
		} finally {
			release.resolve();
		}
		await runtime.drain();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
	}, 30_000);

	for (const op of ["cancel", "pause"] as const) {
		it(`holds a completed Attempt when a revision-fenced ${op} arrives before its queued wake starts`, async () => {
			const mock = createMockModel({ handler: { content: ["done"] } });
			const execution = admittedExecution(mock.model, modelRegistry);
			const { runtime, cwd, options } = await createRuntime(execution, (session, input) => session.prompt(input));
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "command-a", agentInstanceId: "agent-a",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-a",
				executionId: "execution-a", attemptId: "attempt-a",
			}, { cwd, principalId: "owner", input: "A" }));
			const startedIntentRevision = started.intentRevision!;
			const queued = await runtime.enqueueInbox(started, {
				sourceEventId: "queued-after-completion-boundary",
				sourceType: "user",
				body: "must remain queued",
				createdAt: Date.now(),
				wakeIntent: true,
			});
			const remaining = [];
			for (const body of ["QB", "QC"]) {
				remaining.push(
					await runtime.enqueueInbox(started, {
						sourceEventId: `queued-after-completion-${body}`,
						sourceType: "user",
						body,
						createdAt: Date.now(),
						wakeIntent: true,
					}),
				);
			}
			await runtime.drain();
			const completedAttempt = await runtime.store.getAttempt(started.attemptId);
			let wake: EngineEvent | undefined;
			for (let attempts = 50; !wake && attempts > 0; attempts--) {
				wake = (await runtime.store.pendingEvents()).find(
					event => event.kind === "inbox_changed" && event.payload?.action === "wake_due",
				);
				if (!wake) await Bun.sleep(25);
			}
			expect(wake?.payload).toMatchObject({
				queueId: queued.item.queueId,
				revision: 2,
				intentRevision: startedIntentRevision,
			});
			await expect(
				runtime[op]({ ...started, initiator: { kind: "human" }, commandId: "terminal-stop-without-revision" }),
			).rejects.toMatchObject({
				code: "too_late",
			});

			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "stop-after-completion-before-wake-start",
				op,
				deviceId: "terminal-hold-device",
				engineId: "terminal-hold-engine",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId: started.agentInstanceId,
				runtimeBindingId: started.bindingId,
				bindingGeneration: started.bindingGeneration,
				executionId: started.executionId,
				attemptId: started.attemptId,
				authorityGeneration: started.authorityGeneration,
				issuedAt: Date.now(),
				payload: { initiator: { kind: "human" }, expectedIntentRevision: startedIntentRevision },
			};
			expect(
				await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration),
			).toMatchObject({ status: "claimed" });
			const stopped = await runtime[op]({
				...started,
				initiator: { kind: "human" },
				commandId: "stop-after-completion-before-wake-start",
				expectedIntentRevision: startedIntentRevision,
			});
			expect(stopped).toEqual({
				phase: "applied",
				manualHold: true,
				intentRevision: startedIntentRevision + 1,
				alreadyTerminal: true,
			});
			await expect(
				runtime[op]({
					...started,
					initiator: { kind: "human" },
					commandId: "terminal-stop-with-wrong-revision",
					expectedIntentRevision: stopped.intentRevision! + 1,
				}),
			).rejects.toMatchObject({ code: "stale_target" });
			expect(await runtime.store.getAttempt(started.attemptId)).toMatchObject({
				state: completedAttempt!.state, agent_instance_id: completedAttempt!.agent_instance_id,
				attempt_id: completedAttempt!.attempt_id, execution_id: completedAttempt!.execution_id,
				binding_id: completedAttempt!.binding_id, binding_generation: completedAttempt!.binding_generation,
				engine_generation: completedAttempt!.engine_generation, authority_generation: completedAttempt!.authority_generation,
				result_payload: completedAttempt!.result_payload, execution: completedAttempt!.execution,
			});
			expect(
				await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration),
			).toMatchObject({
				status: "replay",
				receipt: { outcome: "applied", detail: stopped },
			});
			expect(await runtime.store.getBinding(started.agentInstanceId)).toMatchObject({
				attemptId: started.attemptId,
				manualHold: true,
				intentRevision: stopped.intentRevision,
			});
			const holdEvent = (await runtime.store.pendingEvents()).find(
				event =>
					event.causationCommandId === "stop-after-completion-before-wake-start" &&
					event.kind === "holds_changed" &&
					event.payload?.phase === "applied",
			);
			expect(holdEvent).toMatchObject({
				kind: "holds_changed",
				payload: {
					action: op === "cancel" ? "stop" : "pause",
					alreadyTerminal: true,
					manualHold: true,
					intentRevision: stopped.intentRevision,
				},
			});
			const staleWake = startRequest(execution, {
				commandId: "stale-wake-after-terminal-stop", agentInstanceId: started.agentInstanceId,
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-a",
				executionId: "execution-stale-wake-after-stop", attemptId: "attempt-stale-wake-after-stop",
			}, {
				cwd, principalId: "owner",
				queueId: queued.item.queueId,
				expectedRevision: 2,
				mutationId: "wake:queued-after-completion-boundary:2",
				expectedIntentRevision: started.intentRevision,
			});
			await expect(admitRequest(runtime, staleWake)).rejects.toMatchObject({ code: "stale_target" });
			expect(await runtime.store.getInboxItem(queued.item.sessionId, queued.item.queueId)).toMatchObject({
				disposition: "pending",
			});
			expect(
				(await runtime.store.pendingEvents()).some(event => event.kind === "cancelled" || event.kind === "paused"),
			).toBeFalse();
			await runtime.dispose();
			const restarted = await openRuntime(options);
			try {
				const recoveredIntent = await restarted.store.intent(started.agentInstanceId);
				expect(
					await restarted.store.admitCommand(engineCommandIdentity(command), restarted.engineGeneration),
				).toMatchObject({
					status: "replay",
					receipt: { outcome: "applied", detail: stopped },
				});
				expect(await restarted.store.getBinding(started.agentInstanceId)).toMatchObject({
					manualHold: true,
					intentRevision: recoveredIntent.intentRevision,
				});
				expect(await restarted.store.claimDueInboxWakes(restarted.engineGeneration)).toEqual([]);
				for (const item of [queued, ...remaining]) {
					expect(await restarted.store.getInboxItem(item.item.sessionId, item.item.queueId)).toMatchObject({
						disposition: "pending",
					});
				}
				const sent = await admitRequest(restarted, startRequest(execution, {
					commandId: "send-after-terminal-hold", agentInstanceId: started.agentInstanceId,
					agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-a",
					executionId: "execution-after-terminal-hold", attemptId: "attempt-after-terminal-hold",
				}, {
					cwd, principalId: "owner", input: "manual release",
					expectedIntentRevision: recoveredIntent.intentRevision,
					explicitContinue: true,
				}));
				expect(sent).toMatchObject({
					manualHold: false,
					intentRevision: recoveredIntent.intentRevision + 1,
					sessionFile: started.sessionFile,
				});
				await restarted.drain();
			} finally {
				await restarted.dispose();
			}
		}, 60000);
	}

	for (const op of ["cancel", "pause"] as const) {
		it(`rejects a terminal ${op} after a newer Send advances the AgentInstance intent`, async () => {
			const mock = createMockModel({ handler: { content: ["done"] } });
			const execution = admittedExecution(mock.model, modelRegistry);
			const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
			const request = (suffix: string, attemptId: string) =>
				startRequest(execution, {
					commandId: `command-terminal-stop-${suffix}`, agentInstanceId: "agent-terminal-stop-newer-send",
					agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-terminal-stop-newer-send",
					executionId: `execution-terminal-stop-${suffix}`, attemptId,
				}, { cwd, principalId: "owner", input: suffix });
			const first = await admitRequest(runtime, request("old", "attempt-terminal-stop-old"));
			await runtime.drain();
			const newer = await admitRequest(runtime, {
				...request("newer", "attempt-terminal-stop-newer"),
				expectedIntentRevision: first.intentRevision,
			});
			await expect(
				runtime[op]({
					...first,
					initiator: { kind: "human" },
					commandId: "late-stop-for-old-attempt",
					expectedIntentRevision: first.intentRevision,
				}),
			).rejects.toMatchObject({ code: "stale_target" });
			expect(runtime.getBinding(first.agentInstanceId)).toMatchObject({
				attemptId: newer.attemptId,
				manualHold: false,
				intentRevision: newer.intentRevision,
			});
			await runtime.drain();
			await runtime.dispose();
		}, 60000);
	}

	it("applies a Stop compiled before Start binding using only the persisted source revision", async () => {
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [async () => {
			await release.promise;
			return { content: ["answer"] };
		}] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async () => {
			await release.promise;
			return true;
		});
		const request = startRequest(execution, {
			commandId: "start-bound-race", agentInstanceId: "agent-bound-race",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/bound-race",
			executionId: "execution-bound-race", attemptId: "attempt-bound-race",
		}, { cwd, principalId: "owner", input: "active", expectedIntentRevision: 0 });
		// The exact transport envelope the fixture captures; admitStart admits it natively before start.
		const command = startEnvelope(runtime, execution, request);
		try {
			await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration);
			const started = await admitRequest(runtime, request);
			expect(started.intentRevision).toBe(1);
			const result = await runtime.cancelPendingStart({
				commandId: "stop-bound-race",
				agentInstanceId: request.agentInstanceId,
				executionId: request.executionId,
				attemptId: request.attemptId,
				authorityGeneration: request.authorityGeneration,
				engineGeneration: runtime.engineGeneration,
				pendingStartCommandId: command.commandId,
				expectedStartIntentRevision: 0,
				expectedIntentRevision: 0,
			});
			expect(result).toMatchObject({ manualHold: true, intentRevision: 2 });
			expect((await runtime.store.getAttempt(request.attemptId))?.state).toBe("cancel_requested");
		} finally {
			release.resolve();
			await runtime.drain();
			await runtime.dispose();
		}
	}, 60_000);

	it("attributes parent-driven cancellation to the start command that owns the Attempt", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const mock = createMockModel({ responses: [async () => {
			await prompt.promise;
			return { content: ["answer"] };
		}] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, () => prompt.promise);
		const events: Array<{ kind: string; causationCommandId: string }> = [];
		runtime.subscribe(event => {
			events.push(event);
		});
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-parent-owned", agentInstanceId: "agent-parent-owned",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-parent-owned",
			executionId: "execution-parent-owned", attemptId: "attempt-parent-owned",
		}, { cwd, principalId: "owner", input: "wait" }));
		await runtime.cancelAgentInstance(started, "parent aborted");
		prompt.resolve(true);
		await runtime.drain();
		expect(events.find(event => event.kind === "cancelled")?.causationCommandId).toBe("command-parent-owned");
		await runtime.dispose();
	}, 60000);

	it("disposes a newborn held child while its effect admission is returning", async () => {
		const parentPrompt = Promise.withResolvers<boolean>();
		const parentDispatched = Promise.withResolvers<void>();
		const busyReached = Promise.withResolvers<void>();
		const returnBusy = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async (_session, input) => {
			prompts.push(input);
			if (input !== "parent work") return true;
			parentDispatched.resolve();
			return parentPrompt.promise;
		});
		const parent = await admitRequest(runtime, startRequest(execution, {
			commandId: "dispose-held-parent-start", agentInstanceId: "dispose-held-parent",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/dispose-held-parent",
			executionId: "dispose-held-parent-execution", attemptId: "dispose-held-parent-attempt",
		}, { cwd, principalId: "owner", input: "parent work" }));
		// The parent pauses mid-prompt: its model admission is already settled, only the newborn child is held.
		await withTimeout(parentDispatched.promise, 2000, "Parent prompt was not dispatched");
		await runtime.pause({ ...parent, commandId: "dispose-held-parent-pause", initiator: { kind: "human" } });
		const originalAdmission = runtime.store.startModelEffect.bind(runtime.store);
		const admission = spyOn(runtime.store, "startModelEffect").mockImplementation(async (target, effect) => {
			try {
				return await originalAdmission(target, effect);
			} catch (error) {
				busyReached.resolve();
				await returnBusy.promise;
				throw error;
			}
		});
		try {
			const child = await admitRequest(runtime, startRequest(execution, {
				commandId: "dispose-held-child-start", agentInstanceId: "dispose-held-child",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/dispose-held-child",
				executionId: "dispose-held-child-execution", attemptId: "dispose-held-child-attempt",
			}, { cwd, principalId: "owner", input: "child work", parentAgentInstanceId: parent.agentInstanceId }));
			await withTimeout(busyReached.promise, 2000, "Held child did not reach effect admission");
			const session = runtime.agentRegistry.get(child.engineAgentId)?.session;
			if (!session) throw new Error("Child session is unavailable");
			const originalAbort = session.abort.bind(session);
			const abort = spyOn(session, "abort").mockImplementation(options => {
				returnBusy.resolve();
				return originalAbort(options);
			});
			parentPrompt.resolve(true);
			try {
				await withTimeout(runtime.dispose({ closeStore: false }), 2000, "Held child disposal did not finish");
			} finally {
				abort.mockRestore();
			}
			expect(prompts).toEqual(["parent work"]);
			expect(await runtime.store.getAttempt(child.attemptId)).toMatchObject({ state: "interrupted" });
			expect((await runtime.store.intent(child.agentInstanceId)).manualHold).toBeTrue();
			expect(
				(await runtime.store.pendingEvents()).filter(
					event => event.attemptId === child.attemptId && event.kind === "pause_requested",
				),
			).toHaveLength(0);
		} finally {
			returnBusy.resolve();
			parentPrompt.resolve(true);
			admission.mockRestore();
			await runtime.dispose({ closeStore: false });
			await runtime.store.close();
		}
	}, 15000);

	it("disposes an agent whose model admission is parked behind a hold", async () => {
		const prompts: string[] = [];
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async (_session, input) => {
			prompts.push(input);
			return true;
		});
		// A quiet store: no unrelated change will wake a parked admission, only the Engine itself can.
		const quiet = spyOn(runtime.store, "changeSignal").mockReturnValue(Promise.withResolvers<void>().promise);
		const held = Promise.withResolvers<void>();
		const parked = Promise.withResolvers<void>();
		let refused = false;
		const originalAdmission = runtime.store.startModelEffect.bind(runtime.store);
		const admission = spyOn(runtime.store, "startModelEffect").mockImplementation(
			async (target, effect, checkpoint) => {
				await held.promise;
				try {
					return await originalAdmission(target, effect, checkpoint);
				} catch (error) {
					refused = true;
					throw error;
				}
			},
		);
		// A refused admission re-reads the hold in its agent lane before it waits for a store change.
		const originalIntent = runtime.store.intent.bind(runtime.store);
		const intent = spyOn(runtime.store, "intent").mockImplementation(async agentInstanceId => {
			const afterRefusal = refused;
			const result = await originalIntent(agentInstanceId);
			if (afterRefusal) parked.resolve();
			return result;
		});
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "parked-admission-start", agentInstanceId: "parked-admission-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/parked-admission-agent",
				executionId: "parked-admission-execution", attemptId: "parked-admission-attempt",
			}, { cwd, principalId: "owner", input: "parked work" }));
			// The hold settles before the first model admission, so that admission is refused and parks.
			const paused = nextEngineEvent(runtime, "paused", started.attemptId);
			await runtime.pause({ ...started, commandId: "parked-admission-pause", initiator: { kind: "human" } });
			await withTimeout(paused, 2000, "Pause did not settle before model admission");
			held.resolve();
			await withTimeout(parked.promise, 2000, "Model admission did not park behind the hold");
			// Only microtasks separate that re-read from the wait; one macrotask turn lets the admission reach it.
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			await withTimeout(runtime.dispose({ closeStore: false }), 5000, "Parked admission blocked disposal");
			expect(prompts).toEqual([]);
			expect(await runtime.store.getAttempt(started.attemptId)).toMatchObject({ state: "interrupted" });
			expect((await runtime.store.intent(started.agentInstanceId)).manualHold).toBeTrue();
		} finally {
			held.resolve();
			admission.mockRestore();
			intent.mockRestore();
			quiet.mockRestore();
			await runtime.dispose({ closeStore: false });
			await runtime.store.close();
		}
	}, 15000);



	it("preserves terminal child history by default and refuses explicit expiry policies", async () => {
		const recordPrompt: NonNullable<EngineRuntimeOptions["dispatchPrompt"]> = async (session, input, identity) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() }, identity);
			return true;
		};
		const cancelledPrompt = Promise.withResolvers<boolean>();
		const cancelledEntered = Promise.withResolvers<void>();
		const preservedModel = createMockModel({
			responses: [async () => {
				await cancelledPrompt.promise;
				return { content: ["answer"] };
			}],
		});
		const preservedExecution = admittedExecution(preservedModel.model, modelRegistry, {
			taskRef: "grimoire://tasks/grimoire/history-test",
		});
		const preserved = await createRuntime(preservedExecution, async (session, input, identity) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() }, identity);
			if (input.startsWith("fail")) throw new Error("injected failed child");
			if (!input.startsWith("cancel")) return true;
			cancelledEntered.resolve();
			return await cancelledPrompt.promise;
		});
		const childRequest = (id: string, input: string) =>
			startRequest(preservedExecution, {
				commandId: `command-${id}-1`, agentInstanceId: id,
				agentInstanceRef: `grimoire://tasks/grimoire/history-test/agents/${id}`,
				executionId: `execution-${id}-1`, attemptId: `attempt-${id}-1`,
			}, { cwd: preserved.cwd, principalId: "owner", input });
		await preserved.runtime.store.registerAgent({
			agentInstanceId: "parent-agent",
			agentInstanceRef: "grimoire://tasks/grimoire/history-test/agents/parent-agent",
			principalId: "owner",
			authorityGeneration: 1,
		});
		const failed = await admitRequest(preserved.runtime, { ...childRequest("child-local-failed", "fail but retain child history"), parentAgentInstanceId: "parent-agent" });
		const completed = await admitRequest(preserved.runtime, { ...childRequest("child-local-completed", "complete and retain child history"), parentAgentInstanceId: "parent-agent" });
		const cancelledStarted = await admitRequest(preserved.runtime, { ...childRequest("child-local-cancelled", "cancel but retain child history"), parentAgentInstanceId: "parent-agent" });
		await withTimeout(cancelledEntered.promise, 2000, "Cancelled child prompt was not dispatched");
		await preserved.runtime.cancel({ ...cancelledStarted, commandId: "cancel-child-local-cancelled" });
		cancelledPrompt.resolve(true);
		await preserved.runtime.drain();
		expect((await preserved.runtime.store.getAttempt(failed.attemptId))?.state).toBe("failed");
		expect((await preserved.runtime.store.getAttempt(completed.attemptId))?.state).toBe("completed");
		expect((await preserved.runtime.store.getAttempt(cancelledStarted.attemptId))?.state).toBe("cancelled");
		await preserved.runtime.dispose();
		const preservedRestart = await openRuntime(preserved.options);
		expect(await preservedRestart.sweepExpiredChildHistory()).toEqual({
			expired: 0,
			archived: 0,
			deleted: 0,
			retained: 0,
		});
		for (const [id, text] of [
			["child-local-failed", "fail but retain child history"],
			["child-local-completed", "complete and retain child history"],
			["child-local-cancelled", "cancel but retain child history"],
		] as const) {
			expect(await nativeHistory(preservedRestart, id, "history-test")).toMatchObject({
				entries: [{ role: "user", text }],
			});
		}
		await preservedRestart.dispose();

		// Expiring retained child history is deferred for native storage; explicit policies refuse.
		const mock = createMockModel({ handler: { content: ["done"] } });
		const localExecution = admittedExecution(mock.model, modelRegistry);
		const local = await createRuntime(localExecution, recordPrompt, { childHistoryRetention: "off" });
		await expect(local.runtime.sweepExpiredChildHistory()).rejects.toMatchObject({ code: "invalid_request" });
		await local.runtime.dispose();
	}, 60000);




	it("rejects queued steer while held and only explicit Resume releases the same Attempt", async () => {
		const promptStarted = Promise.withResolvers<void>();
		const prompt = Promise.withResolvers<boolean>();
		const delivered: string[] = [];
		const mock = createMockModel({ responses: [async () => {
			await prompt.promise;
			return { content: ["answer"] };
		}] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async session => {
			session.steer = async message => {
				delivered.push(message);
			};
			promptStarted.resolve();
			return prompt.promise;
		});
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "held-steer-start", agentInstanceId: "held-steer-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/held-steer-agent",
				executionId: "held-steer-execution", attemptId: "held-steer-attempt",
			}, { cwd, principalId: "owner", input: "work" }));
			await promptStarted.promise;
			const queued = await runtime.enqueueInbox(started, {
				sourceEventId: "queued-steer-item",
				sourceType: "user",
				body: "change course",
				createdAt: Date.now(),
			});
			const paused = nextEngineEvent(runtime, "paused");
			const hold = await runtime.pause({
				...started,
				commandId: "pause-before-steer",
				initiator: { kind: "human" },
				expectedIntentRevision: started.intentRevision,
			});
			prompt.resolve(true);
			await paused;
			await expect(
				runtime.steer({
					...started,
					commandId: "steer-while-held",
					queueId: queued.item.queueId,
					expectedRevision: queued.item.revision,
					mutationId: "consume-held-item",
					expectedIntentRevision: hold.intentRevision,
				}),
			).rejects.toMatchObject({ code: "agent_busy" });
			expect(delivered).toEqual([]);
			expect(await runtime.readInbox(started, queued.item.queueId)).toMatchObject({
				disposition: "pending",
				revision: queued.item.revision,
			});
			expect(await runtime.store.getAttempt(started.attemptId)).toMatchObject({ state: "paused" });
			expect((await runtime.store.getBinding(started.agentInstanceId))?.manualHold).toBeTrue();
			const resumed = await runtime.resume({
				...started,
				commandId: "explicit-resume-held-steer",
				initiator: { kind: "human" },
				expectedIntentRevision: hold.intentRevision,
			});
			expect(resumed).toMatchObject({ manualHold: false, intentRevision: hold.intentRevision + 1 });
			await runtime.drain();
			expect(await runtime.store.getAttempt(started.attemptId)).toMatchObject({ state: "completed" });
			expect(delivered).toEqual([]);
			expect((await runtime.store.pendingEvents()).some(event => event.kind === "steered")).toBeFalse();
		} finally {
			prompt.resolve(true);
			await runtime.dispose();
		}
	}, 60000);

	it("pauses and resumes the same child Attempt without waking its parent", async () => {
		const prompts = new Map<string, PromiseWithResolvers<boolean>>();
		const mock = createMockModel({ responses: [async () => {
			// Both parent and child share this handler; each waits on its own gate.
			return { content: ["answer"] };
		}] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, session => {
			const prompt = Promise.withResolvers<boolean>();
			const agentId = session.getAgentId();
			if (!agentId) throw new Error("Engine test session has no agent id");
			prompts.set(agentId, prompt);
			return prompt.promise;
		});
		const parent = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-parent", agentInstanceId: "parent-agent",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/parent-agent",
			executionId: "execution-parent", attemptId: "attempt-parent",
		}, { cwd, principalId: "owner", input: "wait for children" }));
		const parentSession = runtime.agentRegistry.get(parent.engineAgentId)?.session;
		if (!parentSession) throw new Error("parent session is unavailable");
		let parentSessionEvents = 0;
		parentSession.subscribe(() => parentSessionEvents++);

		const sources: EngineControlInitiator[] = [
			{ kind: "human" },
			{
				kind: "agent",
				agentInstanceId: "controller-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/controller-agent",
			},
		];
		for (const [index, initiator] of sources.entries()) {
			const child = await admitRequest(runtime, {
				...startRequest(execution, {
					commandId: `command-child-${index}`, agentInstanceId: `child-agent-${index}`,
					agentInstanceRef: `grimoire://tasks/grimoire/runtime-test/agents/child-agent-${index}`,
					executionId: `execution-child-${index}`, attemptId: `attempt-child-${index}`,
				}, { cwd, principalId: "owner", input: "work" }),
				parentAgentInstanceId: "parent-agent",
			});
			const parentEventsBefore = (await runtime.store.pendingEvents()).filter(
				event => event.agentInstanceId === "parent-agent",
			);
			const parentSnapshot = {
				mailbox: runtime.ircBus.inbox(parent.engineAgentId, { peek: true }),
				unread: runtime.ircBus.unreadCount(parent.engineAgentId),
				sessionEvents: parentSessionEvents,
				messages: parentSession.messages.length,
				eventSeq: parentEventsBefore.map(event => event.seq),
			};
			const paused = nextEngineEvent(runtime, "paused");
			await runtime.pause({ ...child, commandId: `pause-child-${index}`, initiator });
			prompts.get(child.engineAgentId)?.resolve(true);
			const pausedEvent = await paused;

			const pausedAttempt = await runtime.store.getAttempt(child.attemptId);
			expect(pausedAttempt).toMatchObject({ state: "paused", transcript_revision: 2 });
			expect(runtime.getBinding(child.agentInstanceId)).toMatchObject({
				bindingId: child.bindingId,
				attemptId: child.attemptId,
			});
			expect(pausedEvent.payload).toMatchObject({
				initiator,
				attemptState: "paused",
				controlReadiness: { pause: false, resume: true, steer: false, cancel: true },
				transcriptCheckpoint: { revision: 2 },
			});
			expect({
				mailbox: runtime.ircBus.inbox(parent.engineAgentId, { peek: true }),
				unread: runtime.ircBus.unreadCount(parent.engineAgentId),
				sessionEvents: parentSessionEvents,
				messages: parentSession.messages.length,
				eventSeq: (await runtime.store.pendingEvents())
					.filter(event => event.agentInstanceId === "parent-agent")
					.map(event => event.seq),
			}).toEqual(parentSnapshot);

			const completed = nextEngineEvent(runtime, "completed");
			await runtime.resume({ ...child, commandId: `resume-child-${index}`, initiator });
			const completedEvent = await completed;
			expect(completedEvent.attemptId).toBe(child.attemptId);
			expect(completedEvent.payload).toMatchObject({ transcriptCheckpoint: { revision: 3 } });
			const completedAttempt = await runtime.store.getAttempt(child.attemptId);
			expect(completedAttempt).toMatchObject({ state: "completed", transcript_revision: 3 });
			expect(Number(completedAttempt?.transcript_byte_boundary)).toBeGreaterThanOrEqual(
				Number(pausedAttempt?.transcript_byte_boundary),
			);
			const resumedEvent = (await runtime.store.pendingEvents()).find(
				event => event.kind === "resumed" && event.attemptId === child.attemptId,
			);
			expect(resumedEvent?.payload).toMatchObject({ initiator, attemptState: "running" });
		}

		prompts.get(parent.engineAgentId)?.resolve(true);
		await runtime.drain();
		await runtime.dispose();
	}, 60000);

	it("completes a native prompt when user persistence and history checkpoints share the lane", async () => {
		const mock = createMockModel({ responses: [{ content: ["checkpoint answer"] }] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, undefined);
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "checkpoint-cycle-start", agentInstanceId: "checkpoint-cycle-agent",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/checkpoint-cycle-agent",
			executionId: "checkpoint-cycle-execution", attemptId: "checkpoint-cycle-attempt",
		}, { cwd, principalId: "owner", input: "checkpoint question" }));
		// Use the real prompt path: message_end precedes native user append. A mocked
		// dispatch that appends directly never exercises the two checkpoint queues.
		await withTimeout(runtime.drain(), 3_000, "User checkpoint deadlocked with the history lane");
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
		const history = await nativeHistory(runtime, started.agentInstanceId);
		expect(history.entries.filter(entry => entry.role === "user").map(entry => entry.text)).toEqual([
			"checkpoint question",
		]);
		expect(history.entries.filter(entry => entry.role === "assistant").map(entry => entry.text)).toEqual([
			"checkpoint answer",
		]);
		const events = await runtime.store.pendingEvents();
		expect(events.some(event => event.kind === "history_checkpoint")).toBeTrue();
	}, 10_000);

	it("streams bounded assistant snapshots with one identity before terminal settlement", async () => {
		const releaseFinal = Promise.withResolvers<void>();
		const finalCall = Promise.withResolvers<void>();
		const fullFinal = `${"x".repeat(48_001)}FULL-STREAM-TAIL`;
		const mock = createMockModel({
			reasoning: true,
			responses: (async function* () {
				yield {
					content: [
						{ type: "thinking" as const, thinking: "private streaming reasoning sentinel" },
						"Inspecting the file.",
						{ type: "toolCall" as const, id: "read-stream", name: "read", arguments: { path: "private.txt" } },
						"Waiting for the read result.",
					],
				};
				finalCall.resolve();
				await releaseFinal.promise;
				yield { content: [fullFinal] };
			})(),
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		fs.writeFileSync(path.join(cwd, "private.txt"), "private tool output sentinel");
		const firstSnapshot = nextEngineEvent(runtime, "assistant_snapshot");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-assistant-stream", agentInstanceId: "agent-assistant-stream",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-assistant-stream",
			executionId: "execution-assistant-stream", attemptId: "attempt-assistant-stream",
		}, { cwd, principalId: "owner", input: "inspect then answer" }));
		await finalCall.promise;
		const first = await firstSnapshot;
		expect({ attemptId: first.attemptId, payload: first.payload }).toMatchObject({
			attemptId: started.attemptId,
			payload: {
				assistantMessageId: expect.stringMatching(/^assistant_[0-9a-f]{32}$/),
				revision: 1,
				text: expect.stringContaining("Inspecting the file."),
				status: "streaming",
				textTruncated: false,
			},
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");

		releaseFinal.resolve();
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.attemptId === started.attemptId);
		const snapshots = events.filter((event): event is typeof event & EngineOrdinaryEvent =>
			event.kind === "assistant_snapshot");
		const messageIds = [...new Set(snapshots.map(event => {
			const messageId = event.payload?.assistantMessageId;
			if (typeof messageId !== "string") throw new Error("Assistant snapshot lost its message identity");
			return messageId;
		}))];
		expect(messageIds).toHaveLength(2);
		const settled = snapshots.at(-1);
		if (!settled?.payload) throw new Error("Settled assistant snapshot lost its payload");
		const settledSnapshot = settled.payload;
		expect(settledSnapshot).toMatchObject({
			assistantMessageId: messageIds[1],
			text: fullFinal.slice(0, 48_000),
			status: "settled",
			stopReason: "stop",
			textTruncated: true,
		});
		expect(String(settledSnapshot.text)).toHaveLength(48_000);
		const completed = events.find((event): event is typeof event & EngineOrdinaryEvent =>
			event.kind === "completed");
		if (!completed?.payload) throw new Error("Completed Attempt lost its assistant identity");
		expect(completed.payload.assistantMessageId).toBe(messageIds[1]);
		expect(events.indexOf(settled)).toBeLessThan(events.indexOf(completed));
		const history = await nativeHistory(runtime, started.agentInstanceId);
		const assistantEntries = history.entries.filter(entry => entry.role === "assistant");
		expect(assistantEntries.map(entry => entry.assistantMessageId)).toEqual(messageIds);
		expect(history.activityCompleteness).toBe("complete");
		const historyEntryId = settledSnapshot.historyEntryId;
		expect(typeof historyEntryId).toBe("string");
		expect(historyEntryId).toBe(assistantEntries.at(-1)?.entryId);
		expect(JSON.stringify(snapshots)).not.toMatch(
			/private streaming reasoning sentinel|private\.txt|private tool output sentinel|FULL-STREAM-TAIL/,
		);
		await runtime.dispose();
	}, 60_000);

	it("backpressures a three MiB provider burst until durable writes and reopens its exact bounded message resource", async () => {
		const prefix = `${"x".repeat(4095)}${'😀"\\\n'.repeat(1024)}`;
		const text =
			prefix +
			crypto
				.randomBytes((3 * 1024 * 1024 * 3) / 4)
				.toString("base64")
				.slice(0, 3 * 1024 * 1024 - Buffer.byteLength(prefix));
		const mock = createMockModel({ responses: [{ content: [text] }] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd, options } = await createRuntime(execution, (session, input) => session.prompt(input));
		const append = runtime.store.appendEvent.bind(runtime.store);
		let inFlightBytes = 0;
		let maxInFlightBytes = 0;
		const slowStore = spyOn(runtime.store, "appendEvent").mockImplementation(async event => {
			if (event.kind !== "message_updated") return append(event);
			const bytes = Buffer.byteLength(JSON.stringify(event.payload));
			inFlightBytes += bytes;
			maxInFlightBytes = Math.max(maxInFlightBytes, inFlightBytes);
			try {
				return await append(event);
			} finally {
				inFlightBytes -= bytes;
			}
		});
		const agentInstanceRef = "grimoire://tasks/grimoire/burst/agents/large";
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "burst-start", agentInstanceId: engineAgentInstanceId(agentInstanceRef),
			agentInstanceRef, executionId: "burst-execution", attemptId: "burst-attempt",
		}, { cwd, principalId: "burst-owner", input: "large answer" }));
		await runtime.drain();
		slowStore.mockRestore();
		const completedAttempt = await runtime.store.getAttempt(started.attemptId);
		expect(completedAttempt?.state, completedAttempt?.cause ?? undefined).toBe("completed");
		// A result beyond one storage write stays bounded; its transcript serves the rest.
		expect(completedAttempt?.result_payload).toMatchObject({
			outputTruncated: true,
			transcriptRef: `history://${started.engineAgentId}`,
		});
		const request = { agentInstanceRef, attemptId: started.attemptId, principalId: "burst-owner" };
		const page = await runtime.store.runtimeMessages(request);
		const baseline = (page.items as Array<Record<string, unknown>>)[0];
		expect(baseline).toMatchObject({ status: "settled", partial: true, totalBytes: 3 * 1024 * 1024 });
		expect((page.work as { scannedRows: number }).scannedRows).toBeLessThan(10);
		const resource = baseline.resource as Record<string, unknown>;
		await runtime.dispose();
		const reopened = await openRuntime(options);
		expect((await reopened.store.runtimeMessages(request)).items).toEqual(page.items);
		const hash = crypto.createHash("sha256");
		let offset = 0;
		do {
			const range = await reopened.store.runtimeResource({
				principalId: "burst-owner",
				resource,
				offset,
				limit: 65536,
			});
			const bytes = Buffer.from(String(range.contentBase64), "base64");
			expect(bytes.byteLength).toBeLessThanOrEqual(65536);
			new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			hash.update(bytes);
			offset += bytes.byteLength;
			expect(range.nextOffset).toBe(offset === baseline.totalBytes ? null : offset);
		} while (offset < Number(baseline.totalBytes));
		expect(hash.digest("hex")).toBe(crypto.createHash("sha256").update(text).digest("hex"));
		await reopened.dispose();
	}, 60_000);

	it("fails the Attempt when a streaming content commit fails and does not consume the next provider delta", async () => {
		const mock = createMockModel({ responses: [{ content: ["first", "second"] }] });
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const append = runtime.store.appendEvent.bind(runtime.store);
		let failedWrites = 0;
		const brokenStore = spyOn(runtime.store, "appendEvent").mockImplementation(async event => {
			if (event.kind === "message_updated") {
				failedWrites++;
				throw new Error("isolated stream commit failure");
			}
			return append(event);
		});
		try {
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "stream-failure-start", agentInstanceId: "stream-failure-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/stream-failure-agent",
				executionId: "stream-failure-execution", attemptId: "stream-failure-attempt",
			}, { cwd, principalId: "owner", input: "answer" }));
			await runtime.drain();
			expect(await runtime.store.getAttempt(started.attemptId)).toMatchObject({
				state: "failed",
				cause: "Engine message content could not be persisted",
			});
			expect(failedWrites).toBe(1);
			expect(mock.calls).toHaveLength(1);
		} finally {
			brokenStore.mockRestore();
		}
	}, 30_000);

	it.each([
		{
			kind: "unclassified",
			message: "provider rejected Authorization: Bearer sk-secretcredential1234",
			publicReason: "Error",
		},
		{
			kind: "rate limited",
			message:
				"engine_provider_retry_deferred: HTTP 429 Authorization: Bearer sk-secretcredential1234; https://private.invalid/path; retry through Engine",
			publicReason: "Provider rate limit reached",
		},
		{
			kind: "embedded untrusted code",
			message: "raw engine_provider_retry_deferred: HTTP 429 sk-secretcredential1234",
			publicReason: "Error",
		},
	])(
		"fails an attempt safely when the model turn ends with a $kind provider error",
		async ({ message, publicReason }) => {
			const execution = admittedExecution(createMockModel().model, modelRegistry);
			const { runtime, cwd } = await createRuntime(execution, async session => {
				const answer: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: publicReason === "Error" ? "Partial response" : "" }],
					api: "openai-responses",
					provider: "mock",
					model: "mock",
					timestamp: Date.now(),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: message,
				};
				session.sessionManager.appendMessage(answer);
				Object.defineProperty(session, "getLastAssistantMessage", {
					value: () => answer,
				});
				return true;
			});
			const started = await admitRequest(runtime, startRequest(execution, {
				commandId: "command-provider-error", agentInstanceId: "agent-provider-error",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-provider-error",
				executionId: "execution-provider-error", attemptId: "attempt-provider-error",
			}, { cwd, principalId: "owner", input: "fail" }));
			await runtime.drain();
			const events = await runtime.store.pendingEvents();
			const modelEffectId = String(
				(events.find(event => event.kind === "model_started")?.payload as { effectId?: string })?.effectId,
			);
			const modelEffect = await runtime.store.getEffect(modelEffectId);
			const history = await nativeHistory(runtime, started.agentInstanceId);
			expect(history.entries).toHaveLength(1);
			expect(history.entries[0]).toMatchObject({ role: "assistant", stopReason: "error" });
			expect(history.entries[0]).not.toHaveProperty("errorMessage");
			expect(JSON.stringify(history)).not.toContain("secretcredential");
			await runtime.dispose();
			expect(events.find(event => event.kind === "completed")).toBeUndefined();
			const failed = events.find((event): event is typeof event & EngineOrdinaryEvent =>
				event.kind === "failed");
			if (!failed?.payload) throw new Error("Failed Attempt lost its public error payload");
			if (typeof failed.payload.error !== "string") throw new Error("Failed Attempt has no public error");
			expect(JSON.stringify(failed?.payload)).not.toContain("secretcredential");
			expect(JSON.stringify(failed?.payload)).not.toContain("private.invalid");
			expect(failed.payload.error).toStartWith(`${publicReason} (diagnostic `);
			expect(failed.payload).toMatchObject({
				error: expect.stringContaining("diagnostic"),
				transcriptRef: `history://${started.engineAgentId}`,
				transcriptCheckpoint: { revision: 2 },
			});
			expect(modelEffect).toMatchObject({
				effect_kind: "model",
				state: "settled",
				outcome: "failed",
			});
		},
		60000,
	);

	it("delivers staged images through native start, queue and steer into provider input and retained user history", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const mock = createMockModel({
			handler: async () => {
				if (++calls === 1) {
					reached.resolve();
					await release.promise;
				}
				return { content: ["image response"] };
			},
		});
		mock.input.push("image");
		const execution = admittedExecution(mock.model, modelRegistry);
		const setup = await createRuntime(execution, undefined);
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			"base64",
		);
		const originalAttachment = {
			name: "pixel.png",
			mediaType: "image/png",
			bytes: png.length,
			contentHash: `sha256:${new Bun.SHA256().update(png).digest("hex")}`,
		};
		const agentInstanceRef = "grimoire://tasks/grimoire/attachment-test/agents/one";
		const stage = async (uploadId: string, clientMessageId: string) => {
			await setup.runtime.attachmentUploads.stage("alice", {
				uploadId,
				clientMessageId,
				name: "pixel.png",
				mediaType: "image/png",
				bytes: png.length,
				contentHash: `sha256:${new Bun.SHA256().update(png).digest("hex")}`,
				offset: 0,
				contentBase64: png.toString("base64"),
			});
		};
		try {
			await stage("first-image", "image-message");
			const started = await admitStart(setup.runtime, execution, startRequest(execution, {
				commandId: "image-start", agentInstanceId: "image-agent",
				agentInstanceRef, executionId: "image-execution", attemptId: "image-attempt",
			}, {
				cwd: setup.cwd, principalId: "alice",
				clientMessageId: "image-message",
				attachmentUploadIds: ["first-image"],
				explicitContinue: true,
			}));
			await withTimeout(reached.promise, 5000, "Image-only start did not reach the provider");
			const binding = setup.runtime.getBinding(started.agentInstanceId)!;
			const runningCommand: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "steer-image-command",
				op: "steer" as const,
				deviceId: "test-device",
				engineId: "test-engine",
				engineGeneration: setup.runtime.engineGeneration,
				agentInstanceId: started.agentInstanceId,
				agentInstanceRef,
				runtimeBindingId: binding.bindingId,
				bindingGeneration: binding.bindingGeneration,
				executionId: started.executionId,
				attemptId: started.attemptId,
				authorityGeneration: started.authorityGeneration,
				principalId: "alice",
				issuedAt: Date.now(),
				payload: {
					clientMessageId: "steer-message",
					text: "steered caption",
					attachmentUploadIds: ["steer-image"],
				},
			};
			await stage("steer-image", "steer-message");
			await dispatchEngineCommand({ runtime: setup.runtime, command: runningCommand });
			await dispatchEngineCommand({ runtime: setup.runtime, command: runningCommand });
			release.resolve();
			await setup.runtime.drain();
			const lastCallUsers = mock.calls.at(-1)!.context.messages.filter(message => message.role === "user");
			expect(lastCallUsers).toHaveLength(2);
			expect(
				lastCallUsers.map(message =>
					JSON.stringify(message.content).match(/attachment:\/\/original\/message\/[^/]+\/0/g),
				),
			).toEqual([
				["attachment://original/message/image-message/0"],
				["attachment://original/message/steer-message/0"],
			]);
			const providerImages = await normalizeModelContextImages(
				[{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
				{ model: mock.model },
			);
			for (const message of lastCallUsers) {
				expect(message).not.toHaveProperty("originalAttachments");
				expect(Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : []).toEqual(
					providerImages ?? [],
				);
			}
			expect(providerImages?.[0]?.data).not.toBe(png.toString("base64"));
			await setup.runtime.dispose();
			const reopened = await openRuntime(setup.options);
			const page = await reopened.sessionHistoryPage(started.agentInstanceId, agentInstanceRef, undefined, 100);
			const users = page.entries.filter(entry => entry.role === "user");
			expect(users.map(entry => entry.clientMessageId)).toEqual(["image-message", "steer-message"]);
			expect(users.map(entry => entry.images?.length)).toEqual([1, 1]);
			for (const entry of users) {
				expect(entry.attachments).toHaveLength(1);
				expect(entry.attachments?.[0].resource).toMatchObject({
					...originalAttachment,
					kind: "history_attachment",
					attachmentIndex: 0,
				});
			}
			expect(users.map(entry => entry.text)).toEqual(["\n[Image]", "steered caption\n[Image]"]);
			await reopened.dispose();
		} finally {
			release.resolve();
			for (const runtime of testRuntimes.splice(0)) await runtime.dispose();
		}
	}, 30_000);

	it("publishes durable tool-only and intermediate history while the next response is still running", async () => {
		const release = Promise.withResolvers<void>();
		const reachedFinal = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: (async function* () {
				yield {
					content: [
						{ type: "toolCall" as const, id: "only-tool", name: "read", arguments: { path: "input.txt" } },
					],
				};
				yield {
					content: [
						"Intermediate answer",
						{ type: "toolCall" as const, id: "next-tool", name: "read", arguments: { path: "input.txt" } },
					],
				};
				reachedFinal.resolve();
				await release.promise;
				yield { content: ["Final answer"] };
			})(),
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { toolNames: ["read"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		fs.writeFileSync(path.join(cwd, "input.txt"), "Retained tool result");
		const agentInstanceId = "incremental-history";
		const agentInstanceRef = "grimoire://tasks/grimoire/history-checkpoint/agents/owner";
		const attemptId = "incremental-history-attempt";
		await runtime.store.registerAgent({
			agentInstanceId,
			agentInstanceRef,
			principalId: "owner",
			authorityGeneration: 1,
		});
		const retained = Promise.withResolvers<void>();
		const unsubscribe = runtime.subscribe(async event => {
			if (
				event.attemptId !== attemptId ||
				event.kind !== "history_checkpoint" ||
				!event.payload?.transcriptCheckpoint
			)
				return;
			try {
				const page = await runtime.sessionHistoryPage(agentInstanceId, agentInstanceRef, undefined, 100, attemptId);
				const assistants = page.entries.filter(entry => entry.role === "assistant");
				if (
					assistants.length === 2 &&
					assistants.every(entry => entry.blocks?.some(block => block.toolStatus === "succeeded"))
				)
					retained.resolve();
			} catch (error) {
				retained.reject(error);
			}
		});
		try {
			await admitRequest(runtime, startRequest(execution, {
				commandId: "incremental-history-start", agentInstanceId,
				agentInstanceRef, executionId: "incremental-history-execution", attemptId,
			}, { cwd, principalId: "owner", input: "Read twice" }));
			await withTimeout(reachedFinal.promise, 10_000, "Provider did not reach the held final response");
			await withTimeout(
				retained.promise,
				10_000,
				"No history invalidation exposed retained tool-only results before completion",
			);
			expect((await runtime.store.getAttempt(attemptId))?.state).toBe("running");
			const page = await runtime.sessionHistoryPage(agentInstanceId, agentInstanceRef, undefined, 100, attemptId);
			const assistants = page.entries.filter(entry => entry.role === "assistant");
			expect(assistants.map(entry => entry.text)).toEqual(["", "Intermediate answer"]);
			expect(assistants.map(entry => entry.blocks?.find(block => block.kind === "tool_call")?.toolCallId)).toEqual([
				"only-tool",
				"next-tool",
			]);
			expect(assistants.every(entry => entry.assistantMessageId)).toBe(true);
		} finally {
			release.resolve();
			unsubscribe();
			await runtime.drain();
		}
	}, 30_000);

	it("anchors a retry after its empty failed response through native execution and restart", async () => {
		const mock = createMockModel({
			responses: [{ throw: "503 service unavailable" }, { content: ["Recovered answer"] }],
		});
		const execution = admittedExecution(mock.model, modelRegistry);
		const setup = await createRuntime(execution, (session, input, identity) => session.prompt(input, identity));
		const agentInstanceId = "empty-retry-history";
		const agentInstanceRef = "grimoire://tasks/grimoire/empty-retry-history/agents/owner";
		const attemptId = "empty-retry-attempt";
		await setup.runtime.store.registerAgent({
			agentInstanceId,
			agentInstanceRef,
			principalId: "owner",
			authorityGeneration: 1,
		});
		await admitRequest(setup.runtime, startRequest(execution, {
			commandId: "empty-retry-command", agentInstanceId,
			agentInstanceRef, executionId: "empty-retry-execution", attemptId,
		}, { cwd: setup.cwd, principalId: "owner", input: "Recover from a transient error" }));
		await setup.runtime.drain();
		expect(mock.calls).toHaveLength(2);
		const events = await setup.runtime.store.pendingEvents();
		const retry = events.find(event => event.kind === "retry_scheduled")!;
		const retryScope: RuntimeScope = {
			kind: "attempt",
			agentInstanceRef,
			attemptId,
			kinds: ["state"],
		};
		const retryRequest = { principalId: "owner", agentInstanceRef, attemptId };
		const settledDetail = (await setup.runtime.store.runtimeSnapshot(retryScope, retryRequest)).agents[0];
		expect(settledDetail).toMatchObject({
			attemptId,
			retry: { attempt: 1, maxAttempts: 3, outcome: "succeeded", delayMs: 3000 },
		});
		const retryChanges = await setup.runtime.store.runtimeEvents({
			scope: retryScope,
			principalId: "owner",
			epoch: (await setup.runtime.store.meta()).epoch,
			afterCursor: retry.eventId - 1,
			timeoutMs: 0,
			limit: 100,
			maxBytes: 61440,
			remainingWork: runtimeRemainingWork(),
		});
		expect(retryChanges.changes.some(change => change.kind === "state" && (change.value.retry as { outcome?: string } | null)?.outcome === "waiting")).toBeTrue();
		expect(retryChanges.changes.some(change => change.kind === "state" && (change.value.retry as { outcome?: string } | null)?.outcome === "succeeded")).toBeTrue();
		const page = await setup.runtime.sessionHistoryPage(agentInstanceId, agentInstanceRef, undefined, 100, attemptId);
		const lifecycle = await setup.runtime.store.nativeLifecyclePage(
			agentInstanceId,
			agentInstanceRef,
			100,
			attemptId,
			page.lifecycleContext,
		);
		const assistants = page.entries.filter(entry => entry.role === "assistant");
		expect(assistants.map(entry => [entry.text, entry.stopReason])).toEqual([
			["", "error"],
			["Recovered answer", "stop"],
		]);
		expect(lifecycle.activities.find(event => event.eventId === String(retry.eventId))).toMatchObject({
			afterEntryId: assistants[0].entryId,
			terminal: false,
		});
		const failure = events.find(event =>
			event.kind === "assistant_snapshot" &&
			event.payload?.assistantMessageId === assistants[0].assistantMessageId);
		if (!failure?.payload) throw new Error("Failed assistant snapshot lost its native entry");
		expect(failure.payload).toMatchObject({ text: "", stopReason: "error", historyEntryId: assistants[0].entryId });
		expect(failure.eventId).toBeLessThan(retry.eventId);
		await setup.runtime.dispose();
		const reopened = await openRuntime(setup.options);
		expect((await reopened.store.runtimeSnapshot(retryScope, retryRequest)).agents[0].retry).toEqual(settledDetail.retry);
		const retained = await reopened.sessionHistoryPage(agentInstanceId, agentInstanceRef, undefined, 100, attemptId);
		const retainedLifecycle = await reopened.store.nativeLifecyclePage(
			agentInstanceId,
			agentInstanceRef,
			100,
			attemptId,
			retained.lifecycleContext,
		);
		expect(retainedLifecycle.activities).toEqual(lifecycle.activities);
		expect(retained.entries).toEqual(page.entries);
	}, 30_000);

	it("settles a partial assistant snapshot before Stop cancels its Attempt", async () => {
		const releasePrompt = Promise.withResolvers<void>();
		const mock = createMockModel();
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "a".repeat(200) }],
			api: mock.model.api,
			provider: mock.model.provider,
			model: mock.model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let current = partial;
		const execution = admittedExecution(mock.model, modelRegistry);
		const { runtime, cwd } = await createRuntime(execution, async session => {
			const abort = session.abort.bind(session);
			Object.defineProperty(session, "abort", {
				value: async (options: { reason?: string } = {}) => {
					current.stopReason = "aborted";
					session.agent.emitExternalEvent({ type: "message_end", message: current });
					releasePrompt.resolve();
					await abort(options);
				},
			});
			session.agent.emitExternalEvent({ type: "message_start", message: partial });
			session.agent.emitExternalEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a".repeat(200), partial },
			});
			current = { ...partial, content: [{ type: "text", text: "a".repeat(400) }] };
			session.agent.emitExternalEvent({
				type: "message_update",
				message: current,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a".repeat(200), partial: current },
			});
			await releasePrompt.promise;
			return true;
		});
		const firstSnapshot = nextEngineEvent(runtime, "assistant_snapshot");
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-assistant-stop", agentInstanceId: "agent-assistant-stop",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-assistant-stop",
			executionId: "execution-assistant-stop", attemptId: "attempt-assistant-stop",
		}, { cwd, principalId: "owner", input: "start a long answer" }));
		await firstSnapshot;
		await runtime.cancel({ ...started, commandId: "command-stop-assistant", reason: "user stopped" });
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.attemptId === started.attemptId);
		const snapshots = events.filter((event): event is typeof event & EngineOrdinaryEvent =>
			event.kind === "assistant_snapshot");
		const streamingSnapshots = snapshots.filter(event => event.payload?.status === "streaming");
		expect(streamingSnapshots).toHaveLength(2);
		const streamingIds = streamingSnapshots.map(event => {
			const id = event.payload?.assistantMessageId;
			if (typeof id !== "string") throw new Error("Streaming assistant snapshot lost its identity");
			return id;
		});
		expect(new Set(streamingIds).size).toBe(1);
		expect(streamingSnapshots.map(event => event.payload?.revision)).toEqual([1, 2]);
		const settledSnapshot = snapshots.at(-1);
		const first = snapshots[0];
		if (!first?.payload || !settledSnapshot?.payload)
			throw new Error("Stopped assistant snapshots lost their payloads");
		const firstMessageId = first.payload.assistantMessageId;
		if (typeof firstMessageId !== "string")
			throw new Error("Stopped assistant snapshot lost its message identity");
		expect(settledSnapshot.payload).toMatchObject({
			assistantMessageId: firstMessageId,
			text: "a".repeat(400),
			status: "settled",
			stopReason: "aborted",
			historyEntryId: expect.any(String),
		});
		const firstCancelled = events.findIndex(event => event.kind === "cancelled");
		expect(events.indexOf(settledSnapshot)).toBeLessThan(firstCancelled);
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const retainedAnswer = (await nativeHistory(runtime, started.agentInstanceId)).entries.find(
			entry => entry.assistantMessageId === firstMessageId,
		);
		expect(retainedAnswer).toMatchObject({ text: "a".repeat(400), stopReason: "aborted" });
		await runtime.dispose();
	}, 60_000);

	it("uses only a successful terminal yield from the current Attempt", async () => {
		const prompts: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "yield-attempt-a",
							name: "yield",
							arguments: { result: { data: { assignment: "A", ok: true } } },
						},
					],
				},
				{ content: ["Attempt B prose"] },
				{ content: ["Attempt B reminder one"] },
				{ content: ["Attempt B reminder two"] },
				{
					content: [
						{
							type: "toolCall",
							id: "yield-attempt-c",
							name: "yield",
							arguments: { result: { data: false } },
						},
					],
				},
			],
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: { requireYieldTool: true, outputSchema: { type: ["object", "boolean"] } },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => {
			prompts.push(input);
			expect(session.getToolByName("yield")).toBeDefined();
			return session.prompt(input);
		});
		const request = (suffix: string) =>
			startRequest(execution, {
				commandId: `command-yield-${suffix}`, agentInstanceId: "agent-yield",
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-yield",
				executionId: `execution-yield-${suffix}`, attemptId: `attempt-yield-${suffix}`,
			}, { cwd, principalId: "owner", input: `finish ${suffix.toUpperCase()}` });
		const first = await admitRequest(runtime, request("a"));
		await runtime.drain();
		const firstEvents = await runtime.store.pendingEvents();
		expect(
			firstEvents.find(event => event.kind === "completed" && event.attemptId === first.attemptId)?.payload,
		).toMatchObject({ assistantFinal: '{"assignment":"A","ok":true}' });
		expect((await runtime.store.getAttempt(first.attemptId))?.result_payload).toMatchObject({
			assistantFinal: '{"assignment":"A","ok":true}',
			structuredOutput: {
				source: "session",
				status: "valid",
				data: { assignment: "A", ok: true },
			},
		});

		const second = await admitRequest(runtime, request("b"));
		await runtime.drain();
		const secondEvents = (await runtime.store.pendingEvents()).filter(event => event.attemptId === second.attemptId);
		expect(secondEvents.find(event => event.kind === "completed")).toBeUndefined();
		expect(secondEvents.find(event => event.kind === "failed")?.payload).toMatchObject({
			error: "required_yield_not_submitted",
		});
		expect(prompts).toHaveLength(4);
		expect(prompts[2]).toContain("Call the yield tool now");
		expect(prompts[3]).toContain("Call the yield tool now");
		const third = await admitRequest(runtime, request("c"));
		await runtime.drain();
		expect((await runtime.store.getAttempt(third.attemptId))?.result_payload).toMatchObject({
			assistantFinal: "false",
			structuredOutput: { source: "session", status: "valid", data: false },
		});
		await runtime.dispose();
	}, 60000);

	it("does not accept aborted yield results as terminal success", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "yield-partial",
							name: "yield",
							arguments: { type: ["findings"], result: { data: { finding: "partial" } } },
						},
					],
				},
				{
					content: [
						{
							type: "toolCall",
							id: "yield-aborted",
							name: "yield",
							arguments: { result: { error: "cannot finish after partial result" } },
						},
					],
				},
			],
		});
		const execution = admittedExecution(mock.model, modelRegistry, {
			continuation: {
				requireYieldTool: true,
				outputSchema: {
					type: "object",
					properties: { findings: { type: "array", items: { type: "object" } } },
					required: ["findings"],
				},
			},
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const started = await admitRequest(runtime, startRequest(execution, {
			commandId: "command-aborted-yield", agentInstanceId: "agent-aborted-yield",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-aborted-yield",
			executionId: "execution-aborted-yield", attemptId: "attempt-aborted-yield",
		}, { cwd, principalId: "owner", input: "finish" }));
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.attemptId === started.attemptId);
		expect(events.find(event => event.kind === "completed")).toBeUndefined();
		expect(events.find(event => event.kind === "failed")?.payload).toMatchObject({
			error: expect.stringMatching(/^Error \(diagnostic [0-9a-f]{12}\)$/),
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.cause).toBe("cannot finish after partial result");
		await runtime.dispose();
	}, 60000);

	it("fails a required-yield attempt after two prose-only reminders", async () => {
		const prompts: string[] = [];
		const execution = admittedExecution(createMockModel().model, modelRegistry, {
			continuation: { requireYieldTool: true, outputSchema: { type: "object" } },
		});
		const { runtime, cwd } = await createRuntime(execution, async (_session, input) => {
			prompts.push(input);
			return true;
		});
		await admitRequest(runtime, startRequest(execution, {
			commandId: "command-missing-yield", agentInstanceId: "agent-missing-yield",
			agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-missing-yield",
			executionId: "execution-missing-yield", attemptId: "attempt-missing-yield",
		}, { cwd, principalId: "owner", input: "finish" }));
		await runtime.drain();
		const events = await runtime.store.pendingEvents();
		expect(events.find(event => event.kind === "completed")).toBeUndefined();
		expect(events.find(event => event.kind === "failed")?.payload).toMatchObject({
			error: "required_yield_not_submitted",
			transcriptCheckpoint: { revision: 2 },
		});
		expect(prompts).toHaveLength(3);
		await runtime.dispose();
	}, 60000);
});

function nextEngineEvent(runtime: EngineRuntime, kind: EngineEvent["kind"], attemptId?: string): Promise<EngineEvent> {
	const result = Promise.withResolvers<EngineEvent>();
	const unsubscribe = runtime.subscribe(event => {
		if (event.kind !== kind || (attemptId && event.attemptId !== attemptId)) return;
		unsubscribe();
		result.resolve(event);
	});
	return result.promise;
}

/** Answer only one mock provider origin; native runtime queries and all other traffic keep the real transport. */
function mockProviderFetch(origin: string, respond: (url: string) => Promise<Response>) {
	const original = globalThis.fetch;
	return spyOn(globalThis, "fetch").mockImplementation(Object.assign(
		(input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			return url.startsWith(origin) ? respond(url) : original(input, init);
		},
		{ preconnect: original.preconnect },
	));
}
