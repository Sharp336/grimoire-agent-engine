import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ThinkingConfig } from "@oh-my-pi/pi-catalog/types";
import { defineCapability, loadCapability, registerProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { settings as ambientSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	EngineControlInitiator,
	EngineEvent,
	EngineLaunchProfile,
	EngineProfileRouteState,
	EngineStartRequest,
} from "@oh-my-pi/pi-coding-agent/engine/contracts";
import { validateStartRequest } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import {
	EngineControlQueryClient,
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
import { getLspResourceCounts } from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as mcpConfig from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { withOriginalAttachment } from "@oh-my-pi/pi-coding-agent/session/original-attachments";
import {
	parseNativeSessionLocator,
	RocksNativeSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/rocks-native-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StorageClientError } from "@oh-my-pi/pi-coding-agent/session/storage-client";
import { normalizeModelContextImages } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { resolveProviderCandidates } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { removeSyncWithRetries, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import { startStorageWorker, storageBlobsDir } from "./helpers/storage-worker-fixture";

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
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		registerMockApi("engine-runtime-test");
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-engine-runtime-shared-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	afterEach(async () => {
		for (const runtime of testRuntimes.splice(0)) await runtime.dispose();
		await storage?.stop();
		storage = undefined;
		for (const [name, value] of [
			["GRIMOIRE_STORAGE_BINDING", savedStorageEnv.binding],
			["PI_BLOBS_DIR", savedStorageEnv.blobs],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
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
		dispatchPrompt: EngineRuntimeOptions["dispatchPrompt"] = async () => true,
		overrides: Partial<EngineRuntimeOptions> = {},
		sessionDefaultOverrides: EngineRuntimeOptions["sessionDefaults"] = {},
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
			overrides: { "bash.autoBackground.enabled": true },
		});
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
				...sessionDefaultOverrides,
			},
			...overrides,
		};
		if (options.resolveSessionProfile && !options.resolveSessionContinuation) {
			options.resolveSessionContinuation = async launch => `test:${launch.profileDigest}`;
		}
		const runtime = await openRuntime(options);
		return { runtime, cwd, options, blobsDir };
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
	async function nativeHistory(runtime: EngineRuntime, agentInstanceId: string) {
		const page = await runtime.sessionHistoryPage(
			agentInstanceId,
			`grimoire://tasks/grimoire/runtime-test/agents/${agentInstanceId}`,
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

	const profile: EngineLaunchProfile = {
		spawns: "",
		profileDigest: "leaf-profile-v1",
		enableMCP: false,
		enableLsp: false,
	};

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
		const setup = await createRuntime(undefined, {
			dispatchPrompt: undefined,
			resolveSessionProfile: async () => ({ options: { model: mock.model }, dispose() {} }),
		});
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
			await expect(
				setup.runtime.start(
					{
						commandId: "file-denied",
						principalId: "alice",
						clientMessageId: "file-message",
						attachmentUploadIds: ["file-upload"],
						agentInstanceId: "file-denied-agent",
						executionId: "file-denied-execution",
						attemptId: "file-denied-attempt",
						authorityGeneration: 1,
						cwd: setup.cwd,
					},
					{ ...profile, restrictToolNames: true, toolNames: ["glob"] },
				),
			).rejects.toMatchObject({ code: "attachment_requires_read", message: expect.stringContaining("notes.txt") });
			expect(calls).toBe(0);
			expect(await setup.runtime.store.getAttempt("file-denied-attempt")).toBeUndefined();
			const started = await setup.runtime.start(
				{
					commandId: "file-start",
					principalId: "alice",
					clientMessageId: "file-message",
					attachmentUploadIds: ["file-upload"],
					agentInstanceId: "file-agent",
					executionId: "file-execution",
					attemptId: "file-attempt",
					authorityGeneration: 1,
					cwd: setup.cwd,
					explicitContinue: true,
				},
				profile,
			);
			await setup.runtime.drain();
			expect(calls).toBe(2);
			const ref = "grimoire://tasks/grimoire/file-test/agents/one";
			const page = await setup.runtime.sessionHistoryPage(started.agentInstanceId, ref);
			const user = page.entries.find(entry => entry.role === "user")!;
			expect(user.text).toBe("");
			expect(user.attachments?.[0]).toMatchObject({ name: "notes.txt", status: "available" });
			await setup.runtime.dispose();
			const restarted = await openRuntime(setup.options);
			const originalUri = uri;
			await restarted.start(
				{
					commandId: "file-resume",
					principalId: "alice",
					agentInstanceId: "file-agent",
					executionId: "file-resume-execution",
					attemptId: "file-resume-attempt",
					authorityGeneration: 1,
					cwd: setup.cwd,
					explicitContinue: true,
				},
				profile,
			);
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
		const setup = await createRuntime(undefined, {
			dispatchPrompt: undefined,
			resolveSessionProfile: async () => ({ options: { model: mock.model }, dispose() {} }),
		});
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
		const base: EngineCommandEnvelope = {
			schema: "grimoire.engine.command.v1",
			commandId: "image-start",
			op: "start",
			principalId: "alice",
			deviceId: "test-device",
			engineId: "test-engine",
			engineGeneration: setup.runtime.engineGeneration,
			agentInstanceId: "image-agent",
			agentInstanceRef,
			executionId: "image-execution",
			attemptId: "image-attempt",
			authorityGeneration: 1,
			issuedAt: Date.now(),
			payload: {
				cwd: setup.cwd,
				profileDigest: profile.profileDigest,
				clientMessageId: "image-message",
				attachmentUploadIds: ["first-image"],
				explicitContinue: true,
			},
		};
		const dispatch = (command: EngineCommandEnvelope) =>
			dispatchEngineCommand({ runtime: setup.runtime, command, resolveLaunchProfile: () => profile });
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
			await dispatch(base);
			await withTimeout(reached.promise, 5000, "Image-only start did not reach the provider");
			const binding = setup.runtime.getBinding(base.agentInstanceId)!;
			const runningCommand = {
				...base,
				runtimeBindingId: binding.bindingId,
				bindingGeneration: binding.bindingGeneration,
			};
			await stage("queued-image", "queued-message");
			await dispatch({
				...runningCommand,
				op: "enqueue",
				commandId: "enqueue-image",
				payload: {
					clientMessageId: "queued-message",
					text: "queued caption",
					attachmentUploadIds: ["queued-image"],
				},
			});
			expect(mock.calls).toHaveLength(1);
			expect((await setup.runtime.listInbox(binding)).map(item => item.sourceEventId)).toEqual(["queued-message"]);
			await stage("steer-image", "steer-message");
			const steer = {
				...runningCommand,
				op: "steer" as const,
				commandId: "steer-image-command",
				payload: {
					clientMessageId: "steer-message",
					text: "steered caption",
					attachmentUploadIds: ["steer-image"],
				},
			};
			await dispatch(steer);
			await dispatch(steer);
			release.resolve();
			await setup.runtime.drain();
			expect((await setup.runtime.listInbox(binding)).map(item => item.sourceEventId)).toEqual(["queued-message"]);
			await setup.runtime.store.claimDueInboxWakes(setup.runtime.engineGeneration);
			const queued = (await setup.runtime.store.getInboxItemByQueueId("queued-message"))!;
			const intent = await setup.runtime.store.intent(base.agentInstanceId);
			const queueStart: EngineCommandEnvelope = {
				...base,
				commandId: "queue-image-start",
				attemptId: "queued-attempt",
				executionId: "queued-execution",
				payload: {
					cwd: setup.cwd,
					profileDigest: profile.profileDigest,
					queueId: queued.queueId,
					expectedRevision: queued.revision,
					mutationId: "consume-image",
					expectedIntentRevision: intent.intentRevision,
					explicitContinue: true,
				},
			};
			await expect(
				dispatch({
					...queueStart,
					commandId: "wrong-queued-identity",
					payload: { ...queueStart.payload, clientMessageId: "different-message" },
				}),
			).rejects.toMatchObject({ code: "invalid_request" });
			expect((await setup.runtime.store.getInboxItemByQueueId(queued.queueId))?.disposition).toBe("pending");
			await dispatch(queueStart);
			await setup.runtime.drain();
			await dispatch(queueStart);
			expect((await setup.runtime.store.getInboxItemByQueueId(queued.queueId))?.disposition).toBe("acknowledged");
			const lastCallUsers = mock.calls.at(-1)!.context.messages.filter(message => message.role === "user");
			expect(lastCallUsers).toHaveLength(3);
			expect(
				lastCallUsers.map(message =>
					JSON.stringify(message.content).match(/attachment:\/\/original\/message\/[^/]+\/0/g),
				),
			).toEqual([
				["attachment://original/message/image-message/0"],
				["attachment://original/message/steer-message/0"],
				["attachment://original/message/queued-message/0"],
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
			const page = await reopened.sessionHistoryPage(base.agentInstanceId, agentInstanceRef, undefined, 100);
			const users = page.entries.filter(entry => entry.role === "user");
			expect(users.map(entry => entry.clientMessageId)).toEqual([
				"image-message",
				"steer-message",
				"queued-message",
			]);
			expect(users.map(entry => entry.images?.length)).toEqual([1, 1, 1]);
			for (const entry of users) {
				expect(entry.attachments).toHaveLength(1);
				expect(entry.attachments?.[0].resource).toMatchObject({
					...originalAttachment,
					kind: "history_attachment",
					attachmentIndex: 0,
				});
				validateRuntimeValue("resourceReadRequest", {
					resource: entry.attachments?.[0].resource,
					offset: 0,
					limit: 65536,
				});
			}
			expect(users.map(entry => entry.text)).toEqual([
				"\n[Image]",
				"steered caption\n[Image]",
				"queued caption\n[Image]",
			]);
			const source = (await reopened.store.getBinding(base.agentInstanceId))!;
			const retained = await nativeSession(reopened, source.sessionFile!);
			const nativeUsers = retained
				.getEntries()
				.filter(entry => entry.type === "message" && entry.message.role === "user");
			expect(nativeUsers).toHaveLength(3);
			for (const entry of nativeUsers) expect(entry).toHaveProperty("originalAttachments", [originalAttachment]);
			for (const mode of ["branch", "edit"] as const) {
				const fork = await reopened.start(
					{
						commandId: `${mode}-original`,
						agentInstanceId: mode === "edit" ? base.agentInstanceId : "original-branch",
						executionId: `${mode}-original-execution`,
						attemptId: `${mode}-original-attempt`,
						authorityGeneration: 1,
						cwd: setup.cwd,
						historyEdit: {
							mode,
							source,
							sourceSessionId: retained.getSessionId(),
							expectedLeafEntryId: retained.getLeafId()!,
							entryId: users[0]!.entryId,
							...(mode === "edit" ? { replacementText: "new image caption" } : {}),
						},
					},
					profile,
				);
				await reopened.drain();
				// The fork's working context inherits the selected prefix; its own records hold only new entries.
				const { familyId, generationId } = parseNativeSessionLocator(fork.sessionFile!);
				const forked = await SessionManager.openNative(
					new RocksNativeSessionStorage(reopened.store.storageClient, familyId, generationId),
				);
				const forkUser = forked
					.getContextBranch()
					.find(entry => entry.type === "message" && entry.message.role === "user");
				expect(forkUser).toHaveProperty("originalAttachments", [originalAttachment]);
			}
		} finally {
			release.resolve();
			for (const runtime of testRuntimes.splice(0)) await runtime.dispose();
		}
	}, 30_000);

	it("refuses missing or unsupported images before model dispatch and leaves failed queued delivery pending", async () => {
		const mock = createMockModel({ handler: { content: ["must not run"] } });
		const { runtime, cwd } = await createRuntime(undefined, {
			dispatchPrompt: undefined,
			resolveSessionProfile: async () => ({ options: { model: mock.model }, dispose() {} }),
		});
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			"base64",
		);
		const request: EngineStartRequest = {
			commandId: "reject-start",
			principalId: "alice",
			clientMessageId: "image-message",
			attachmentUploadIds: ["image"],
			agentInstanceId: "reject-agent",
			executionId: "reject-execution",
			attemptId: "reject-attempt",
			authorityGeneration: 1,
			cwd,
		};
		await expect(runtime.start(request, profile)).rejects.toMatchObject({ code: "attachment_expired" });
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
		await expect(runtime.start(request, profile)).rejects.toMatchObject({
			code: "attachment_requires_images",
			message: expect.stringContaining('Image "pixel.png" cannot be sent'),
		});
		expect(mock.calls).toHaveLength(0);
		expect(await runtime.store.getAttempt(request.attemptId)).toBeUndefined();
		const queued = await runtime.enqueueAgentInbox(request.agentInstanceId, {
			sourceEventId: "image-message",
			sourceType: "user",
			body: "",
			attachments: { principalId: "alice", uploadIds: ["image"] },
		});
		const queuedRequest = {
			...request,
			attachmentUploadIds: undefined,
			queueId: queued.item.queueId,
			expectedRevision: queued.item.revision,
			mutationId: "consume-refused",
			expectedIntentRevision: (await runtime.store.intent(request.agentInstanceId)).intentRevision,
			explicitContinue: true,
		};
		// The queued message owns its accepted image, so delivery fails on the route, not on the upload.
		await expect(runtime.start(queuedRequest, profile)).rejects.toMatchObject({ code: "attachment_requires_images" });
		expect((await runtime.store.getInboxItemByQueueId(queued.item.queueId))?.disposition).toBe("pending");
		expect(mock.calls).toHaveLength(0);
	});

	it("keeps each launch's actual settings on its initiating native message after profile change and restart", async () => {
		const mock = createMockModel({ reasoning: true, handler: { content: ["done"] } });
		Object.assign(mock, {
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] } satisfies ThinkingConfig,
		});
		const setup = await createRuntime((session, input, identity) => session.prompt(input, identity), {
			resolveSessionProfile: async launch => ({
				options: { model: mock.model, thinkingLevel: launch.thinkingLevel },
				dispose() {},
			}),
		});
		const request = (suffix: string): EngineStartRequest => ({
			commandId: `snapshot-command-${suffix}`,
			agentInstanceRef: "grimoire://tasks/grimoire/snapshots/agents/one",
			profileSelectionRevision: suffix === "one" ? 4 : 8,
			clientMessageId: `snapshot-client-${suffix}`,
			agentInstanceId: "snapshot-agent",
			executionId: `snapshot-execution-${suffix}`,
			attemptId: `snapshot-attempt-${suffix}`,
			authorityGeneration: 1,
			cwd: setup.cwd,
			input: "same text",
		});
		const selected = { ...profile, launchProfileRef: "gctx:2222222222222222", thinkingLevel: ThinkingLevel.High };
		await setup.runtime.start(request("one"), selected);
		await setup.runtime.drain();
		await setup.runtime.start(request("two"), {
			...selected,
			profileDigest: "changed-profile",
			launchProfileRef: "gctx:3333333333333333",
			thinkingLevel: ThinkingLevel.Low,
		});
		await setup.runtime.drain();
		await setup.runtime.dispose();
		const reopened = await openRuntime(setup.options);
		const users = (await nativeHistory(reopened, "snapshot-agent")).entries.filter(entry => entry.role === "user");
		expect(
			users.map(entry => [
				entry.sourceCommandId,
				entry.launchSnapshot?.attemptId,
				entry.launchSnapshot?.profileRef,
				entry.launchSnapshot?.thinkingLevel,
			]),
		).toEqual([
			["snapshot-command-one", "snapshot-attempt-one", selected.launchProfileRef, "high"],
			["snapshot-command-two", "snapshot-attempt-two", "gctx:3333333333333333", "low"],
		]);
		expect(users[0].launchSnapshot?.model).toEqual({
			provider: mock.model.provider,
			id: mock.model.id,
			contextWindow: mock.model.contextWindow,
		});
		expect(new Set(users.map(entry => entry.launchSnapshot?.profileDigest)).size).toBe(2);
		expect(
			users.map(entry => [entry.launchSnapshot?.previousSelectionRevision, entry.launchSnapshot?.selectionRevision]),
		).toEqual([
			[0, 4],
			[4, 8],
		]);
		let cursor: string | undefined;
		const pagedSnapshots = [];
		for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
			const page = await reopened.sessionHistoryPage("snapshot-agent", request("one").agentInstanceRef!, cursor, 1);
			pagedSnapshots.push(...page.entries.filter(entry => entry.role === "user").map(entry => entry.launchSnapshot));
			cursor = page.nextCursor ?? undefined;
			if (!cursor) break;
		}
		expect(cursor).toBeUndefined();
		expect(pagedSnapshots).toEqual(users.toReversed().map(entry => entry.launchSnapshot));
		for (const call of mock.calls) {
			expect(JSON.stringify(call.context)).not.toContain('"launchSnapshot"');
			expect(JSON.stringify(call.context)).not.toContain('"profileDigest"');
		}
		const malformed = await createRuntime(async (session, input, identity) => {
			const launchSnapshot = { ...identity!.launchSnapshot!, credential: "not-public" };
			session.sessionManager.appendMessage(
				{ role: "user", content: input, timestamp: Date.now() },
				{ ...identity, launchSnapshot },
			);
			return true;
		});
		await malformed.runtime.start({ ...request("malformed"), cwd: malformed.cwd }, selected);
		await malformed.runtime.drain();
		expect((await nativeHistory(malformed.runtime, "snapshot-agent")).entries[0]).not.toHaveProperty(
			"launchSnapshot",
		);
		expect(
			(await nativeHistory(reopened, "snapshot-agent")).entries
				.filter(entry => entry.role === "assistant")
				.every(entry => !entry.launchSnapshot),
		).toBe(true);
	});

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
		const setup = await createRuntime(
			(session, input, identity) => session.prompt(input, identity),
			{
				resolveSessionProfile: async (_launch, cwd) => ({
					options: {
						settings: await Settings.loadReadOnly({
							cwd,
							agentDir: path.join(path.dirname(cwd), "agent"),
							overrides: { "tools.xdev": false, "bash.autoBackground.enabled": true },
						}),
					},
					dispose() {},
				}),
			},
			{ model: mock.model },
		);
		let runtime = setup.runtime;
		const launch = { ...profile, enableMCP: true };
		const request = (agent: string, turn: number): EngineStartRequest => ({
			commandId: `${agent}-command-${turn}`,
			agentInstanceId: agent,
			executionId: `${agent}-execution-${turn}`,
			attemptId: `${agent}-attempt-${turn}`,
			authorityGeneration: 1,
			cwd: setup.cwd,
			input: `${agent} turn ${turn}`,
		});
		const lastMcpTools = () =>
			mock.calls
				.at(-1)
				?.context.tools?.map(tool => tool.name)
				.filter(name => name.startsWith("mcp__")) ?? [];
		try {
			const first = await runtime.start(request("route-root", 1), launch);
			await runtime.drain();
			await runtime.start(request("route-root", 2), launch);
			await runtime.drain();
			await runtime.start(request("route-root", 3), launch);
			await runtime.drain();
			expect(lastMcpTools()).toEqual(["mcp__foreign_probe"]);
			const oldHistory = await retainedEntries(runtime, first.sessionFile!);
			const oldMessages = oldHistory.entries.filter(entry => entry.type === "message");
			expect(oldMessages).toHaveLength(6);
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
			const upgraded = await runtime.start(request("route-root", 4), launch);
			await runtime.drain();
			expect(upgraded.sessionFile).toBe(first.sessionFile);
			expect(lastMcpTools()).toEqual(["mcp__grimoire_engine_owned_probe"]);
			expect(calls.foreign).toBe(1);
			expect(live.owned.size).toBe(1);
			const child = await runtime.start(
				{ ...request("route-child", 1), parentAgentInstanceId: first.agentInstanceId },
				launch,
			);
			await runtime.drain();
			expect(lastMcpTools()).toEqual(["mcp__grimoire_engine_owned_probe"]);
			expect(live.owned.size).toBe(2);
			await runtime.release(child);
			expect(live.owned.size).toBe(1);
			const restrictedProfiles: [string, EngineLaunchProfile][] = [
				["mcp-disabled", { ...launch, enableMCP: false }],
				["mcp-restricted", { ...launch, restrictToolNames: true, toolNames: ["read"] }],
			];
			for (const [agent, restricted] of restrictedProfiles) {
				await runtime.start(request(agent, 1), restricted);
				await runtime.drain();
				expect(lastMcpTools()).toEqual([]);
			}
			expect(calls.owned).toBe(2);
			unavailable = true;
			const modelCallsBeforeFailure = mock.calls.length;
			await expect(runtime.start(request("mcp-unavailable", 1), launch)).rejects.toThrow(
				"Hosted Core MCP binding failed",
			);
			expect(mock.calls).toHaveLength(modelCallsBeforeFailure);
			expect(runtime.getBinding("mcp-unavailable")).toBeUndefined();
			// MCPManager rejects promptly and closes failed catalog sessions in the background.
			await Promise.race([failedConnectionClosed.promise, Bun.sleep(1000)]);
			expect(live.owned.size).toBe(1);
			expect(calls.foreign).toBe(1);
			unavailable = false;
			await runtime.dispose();
			expect(live.owned.size).toBe(0);
			runtime = await openRuntime(boundOptions);
			const restarted = await runtime.start(request("route-root", 5), launch);
			await runtime.drain();
			expect(restarted.sessionFile).toBe(first.sessionFile);
			expect(lastMcpTools()).toEqual(["mcp__grimoire_engine_owned_probe"]);
			const retained = await retainedEntries(runtime, restarted.sessionFile!);
			expect(retained.entries[0]).toEqual(oldHistory.entries[0]);
			expect(retained.entries.filter(entry => entry.type === "message").slice(0, 6)).toEqual(oldMessages);
			expect(retained.entries.filter(entry => entry.type === "message")).toHaveLength(10);
			expect(JSON.stringify(retained.entries)).not.toContain("isolated-mcp-test");
			await runtime.dispose();
			expect(live.owned.size).toBe(0);
			owned.stop(true);
			runtime = await openRuntime(boundOptions);
			const modelCallsBeforeOffline = mock.calls.length;
			await expect(runtime.start(request("mcp-offline", 1), launch)).rejects.toThrow(
				"Hosted Core MCP binding failed",
			);
			expect(runtime.getBinding("mcp-offline")).toBeUndefined();
			expect(mock.calls).toHaveLength(modelCallsBeforeOffline);
			expect(calls.foreign).toBe(1);
		} finally {
			await runtime.dispose();
			discover.mockRestore();
			owned.stop(true);
			foreign.stop(true);
		}
	}, 60_000);

	it("delivers refreshed command context with the unchanged inbox body after explicit Continue following restart, once", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const { runtime, cwd, options } = await createRuntime(
			(session, input, identity) => session.prompt(input, identity),
			{},
			{ model: mock.model },
		);
		const started = await runtime.start(
			{
				commandId: "context-initial",
				agentInstanceId: "context-agent",
				executionId: "context-execution-1",
				attemptId: "context-attempt-1",
				authorityGeneration: 1,
				cwd,
				input: "A",
				context: JSON.stringify({ work_tracking: { receipt: "R1" } }),
			},
			profile,
		);
		await runtime.drain();
		const queued = await runtime.enqueueInbox(started, {
			sourceEventId: "context-body-b",
			sourceType: "user",
			body: "B",
			createdAt: Date.now(),
			deliverAt: Date.now() + 250,
			wakeIntent: true,
		});
		await runtime.dispose();
		let resumed = await openRuntime(options);
		try {
			await Bun.sleep(300);
			const item = await resumed.store.getInboxItemByQueueId(queued.item.queueId);
			expect(item?.wakeDeliveredAt).toBeUndefined();
			const recoveredIntent = await resumed.store.intent(started.agentInstanceId);
			expect(recoveredIntent.holds.some(hold => hold.kind === "recovery")).toBeTrue();
			expect(mock.calls).toHaveLength(1);
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "context-wake",
				op: "start",
				deviceId: "context-device",
				engineId: "context-engine",
				engineGeneration: resumed.engineGeneration,
				agentInstanceId: started.agentInstanceId,
				executionId: "context-execution-2",
				attemptId: "context-attempt-2",
				authorityGeneration: 1,
				issuedAt: Date.now(),
				payload: {
					cwd,
					profileDigest: profile.profileDigest,
					queueId: item!.queueId,
					expectedRevision: item!.revision,
					mutationId: "context-consume",
					expectedIntentRevision: recoveredIntent.intentRevision,
					explicitContinue: true,
					context: JSON.stringify({ work_tracking: { receipt: "R2" } }),
				},
			};
			const dispatch = (value: EngineCommandEnvelope) =>
				dispatchEngineCommand({
					runtime: resumed,
					command: value,
					resolveLaunchProfile: () => profile,
				});
			await expect(
				dispatch({ ...command, payload: { ...command.payload, expectedRevision: item!.revision - 1 } }),
			).rejects.toMatchObject({ code: "stale_target" });
			expect(mock.calls).toHaveLength(1);
			await expect(
				dispatch({ ...command, payload: { ...command.payload, input: "replacement body" } }),
			).rejects.toMatchObject({ code: "invalid_request" });
			expect(await dispatch(command)).toMatchObject({ phase: "consumed" });
			await resumed.drain();
			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("R2");
			expect(mock.calls[1].context.messages.filter(message => message.role === "user").at(-1)?.content).toEqual([
				{ type: "text", text: "B" },
			]);
			const binding = await resumed.store.getBinding(started.agentInstanceId);
			expect(binding?.sessionFile).toBe(started.sessionFile);
			const history = await retainedEntries(resumed, binding!.sessionFile!);
			const contexts = history.entries.filter(
				entry => entry.type === "custom_message" && entry.customType === "engine-command-context",
			);
			expect(contexts).toHaveLength(2);
			const body = history.entries.find(
				entry => entry.type === "message" && entry.sourceCommandId === command.commandId,
			);
			expect(body).toMatchObject({
				clientMessageId: "context-body-b",
				message: { role: "user", content: [{ type: "text", text: "B" }] },
			});
			expect(await resumed.store.getInboxItemByQueueId(item!.queueId)).toMatchObject({
				sourceBody: "B",
				deliveryPayload: "B",
				disposition: "acknowledged",
				revision: item!.revision + 1,
			});
			await dispatch(command);
			await resumed.drain();
			await resumed.dispose();
			resumed = await openRuntime(options);
			await dispatch({ ...command, engineGeneration: resumed.engineGeneration });
			await resumed.drain();
			expect(mock.calls).toHaveLength(2);
			const replayHistory = await retainedEntries(resumed, binding!.sessionFile!);
			expect(
				replayHistory.entries.filter(entry => entry.type === "message" || entry.type === "custom_message"),
			).toEqual(history.entries.filter(entry => entry.type === "message" || entry.type === "custom_message"));
		} finally {
			await resumed.dispose();
		}
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
		const { runtime, cwd } = await createRuntime(
			(session, input, identity) => session.prompt(input, identity),
			{},
			{ model: mock.model },
		);
		try {
			const first = await runtime.start(
				{
					commandId: "resume-context-start",
					agentInstanceId: "resume-context-agent",
					executionId: "resume-context-execution",
					attemptId: "resume-context-attempt",
					authorityGeneration: 1,
					cwd,
					input: "work",
				},
				profile,
			);
			await firstEntered.promise;
			const paused = nextEngineEvent(runtime, "paused");
			const hold = await runtime.pause({
				...first,
				commandId: "resume-context-pause",
				initiator: { kind: "human" },
				expectedIntentRevision: first.intentRevision,
			});
			firstRelease.resolve();
			await paused;
			const control = (
				target: typeof first,
				op: "resume" | "steer",
				commandId: string,
				payload: Record<string, unknown>,
			) =>
				dispatchEngineCommand({
					runtime,
					resolveLaunchProfile: () => profile,
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
				control(first, "resume", "resume-context-stale", {
					initiator: { kind: "human" },
					expectedIntentRevision: first.intentRevision,
					context: "stale-resume-context",
				}),
			).rejects.toMatchObject({ code: "stale_target" });
			const resumePayload = {
				initiator: { kind: "human" },
				expectedIntentRevision: hold.intentRevision,
				context: '{"work_tracking":{"receipt":"RESUME_R2"}}',
			};
			await control(first, "resume", "resume-context-accepted", resumePayload);
			await control(first, "resume", "resume-context-accepted", resumePayload);
			await runtime.drain();
			expect(mock.calls).toHaveLength(1);
			const second = await runtime.start(
				{
					commandId: "steer-context-start",
					agentInstanceId: first.agentInstanceId,
					executionId: "steer-context-execution",
					attemptId: "steer-context-attempt",
					authorityGeneration: 1,
					cwd,
					input: "continue",
				},
				profile,
			);
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

	it("rejects an over-budget Resume before adding its context to the live or retained session", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, cwd } = await createRuntime(async () => {
			entered.resolve();
			await release.promise;
			return true;
		});
		const started = await runtime.start(
			{
				commandId: "budget-context-start",
				agentInstanceId: "budget-context-root",
				agentInstanceRef: "grimoire://tasks/grimoire/context-budget/agents/root",
				executionId: "budget-context-execution",
				attemptId: "budget-context-attempt",
				authorityGeneration: 1,
				cwd,
				input: "hold this Attempt",
			},
			profile,
		);
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
					(error: unknown) => error,
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
	it("keeps failed resume held and failed running steer pending, with rejected durable replay", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const secondRelease = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["paused work"] };
				},
				async () => {
					secondEntered.resolve();
					await secondRelease.promise;
					return { content: ["running work"] };
				},
				{ content: ["recovered"] },
			],
		});
		const { runtime, cwd, options } = await createRuntime(
			(session, input, identity) => session.prompt(input, identity),
			{},
			{ model: mock.model },
		);
		const runtimeDir = path.dirname(options.databasePath!);
		const server = await startEngineControlQueryServer({
			runtime,
			runtimeDir,
			deviceId: "context-device",
			engineId: "context-engine",
			resolveLaunchProfile: () => profile,
		});
		const client = new EngineControlQueryClient(runtimeDir);
		try {
			const started = await runtime.start(
				{
					commandId: "context-failure-start",
					agentInstanceId: "context-failure-agent",
					executionId: "context-failure-execution",
					attemptId: "context-failure-attempt",
					authorityGeneration: 1,
					cwd,
					input: "A",
				},
				profile,
			);
			await entered.promise;
			const queued = await runtime.enqueueInbox(started, {
				sourceEventId: "context-failure-body-b",
				sourceType: "user",
				body: "B",
				createdAt: Date.now(),
			});
			const paused = nextEngineEvent(runtime, "paused");
			const hold = await runtime.pause({
				...started,
				commandId: "context-failure-pause",
				initiator: { kind: "human" },
				expectedIntentRevision: started.intentRevision,
			});
			release.resolve();
			await paused;
			let target = started;
			let expectedIntent = hold.intentRevision;
			let expectedState = "paused";
			let expectedCalls = 1;
			const session = runtime.agentRegistry.get(started.engineAgentId)!.session!;
			const command = (op: "resume" | "steer", commandId: string): EngineCommandEnvelope => ({
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
				payload: {
					context: '{"work_tracking":{"receipt":"R2"}}',
					expectedIntentRevision: expectedIntent,
					...(op === "resume"
						? { initiator: { kind: "human" } }
						: {
								queueId: queued.item.queueId,
								expectedRevision: queued.item.revision,
								mutationId: `${commandId}-consume`,
							}),
				},
			});
			const assertRejectedReplay = async (value: EngineCommandEnvelope, message: string) => {
				await expect(client.request("command", { command: value })).rejects.toThrow();
				await expect(client.request("command", { command: value })).rejects.toThrow();
				expect(
					await runtime.store.admitCommand(engineCommandIdentity(value), runtime.engineGeneration),
				).toMatchObject({
					status: "replay",
					receipt: { outcome: "rejected", detail: { message } },
				});
				expect(await runtime.store.getAttempt(target.attemptId)).toMatchObject({ state: expectedState });
				expect(await runtime.store.getBinding(started.agentInstanceId)).toMatchObject({
					manualHold: expectedState === "paused",
					intentRevision: expectedIntent,
				});
				expect(await runtime.readInbox(started, queued.item.queueId)).toMatchObject({
					sourceBody: "B",
					deliveryPayload: "B",
					disposition: "pending",
					revision: queued.item.revision,
				});
				expect(mock.calls).toHaveLength(expectedCalls);
			};
			const contextFailure = spyOn(session, "sendCustomMessage").mockRejectedValue(
				new Error("context delivery unavailable"),
			);
			try {
				await assertRejectedReplay(command("resume", "context-failed-resume"), "context delivery unavailable");
				await assertRejectedReplay(command("steer", "context-held-steer"), "AgentInstance branch is held");
				expect(contextFailure).toHaveBeenCalledTimes(1);
			} finally {
				contextFailure.mockRestore();
			}
			await runtime.resume({
				...started,
				commandId: "resume-after-failure",
				initiator: { kind: "human" },
				expectedIntentRevision: hold.intentRevision,
			});
			await runtime.drain();
			target = await runtime.start(
				{
					commandId: "context-running-start",
					agentInstanceId: started.agentInstanceId,
					executionId: "context-running-execution",
					attemptId: "context-running-attempt",
					authorityGeneration: 1,
					cwd,
					input: "keep streaming",
				},
				profile,
			);
			await secondEntered.promise;
			expectedIntent = (await runtime.store.intent(target.agentInstanceId)).intentRevision;
			expectedState = "running";
			expectedCalls = 2;
			const bodyFailure = spyOn(session, "steer").mockRejectedValue(new Error("body delivery unavailable"));
			try {
				await assertRejectedReplay(command("steer", "context-failed-body"), "body delivery unavailable");
				expect(bodyFailure).toHaveBeenCalledTimes(1);
			} finally {
				bodyFailure.mockRestore();
			}
			const failedHistory = await retainedEntries(runtime, started.sessionFile!);
			expect(
				failedHistory.entries.filter(
					entry => entry.type === "custom_message" && entry.customType === "engine-command-context",
				),
			).toHaveLength(0);
			expect(
				failedHistory.entries.some(
					entry => entry.type === "message" && entry.clientMessageId === "context-failure-body-b",
				),
			).toBe(false);
			const retry = command("steer", "context-body-retry");
			retry.payload.context = '{"work_tracking":{"status":"disabled","applicable":false}}';
			await client.request("command", { command: retry });
			await client.request("command", { command: retry });
			secondRelease.resolve();
			await runtime.drain();
			expect(mock.calls).toHaveLength(3);
			expect(mock.calls[2].context.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "developer", content: [{ type: "text", text: retry.payload.context }] }),
				]),
			);
			const recoveredHistory = await retainedEntries(runtime, started.sessionFile!);
			expect(
				recoveredHistory.entries.filter(
					entry => entry.type === "message" && entry.clientMessageId === "context-failure-body-b",
				),
			).toEqual([
				expect.objectContaining({
					sourceCommandId: retry.commandId,
					message: expect.objectContaining({ role: "user", content: [{ type: "text", text: "B" }] }),
				}),
			]);
			expect(await runtime.readInbox(started, queued.item.queueId)).toMatchObject({
				disposition: "acknowledged",
				revision: queued.item.revision + 1,
			});
		} finally {
			release.resolve();
			secondRelease.resolve();
			await server.close();
			await runtime.dispose();
		}
	}, 60_000);

	it("rejects malformed or over-budget native command context before admission and accepts the exact UTF-8 bound", async () => {
		let dispatches = 0;
		const { runtime, cwd } = await createRuntime(async () => {
			dispatches++;
			return true;
		});
		try {
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "context-bound",
				op: "start",
				deviceId: "context-device",
				engineId: "context-engine",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId: "context-bound-agent",
				executionId: "context-bound-execution",
				attemptId: "context-bound-attempt",
				authorityGeneration: 1,
				issuedAt: Date.now(),
				payload: { cwd, profileDigest: profile.profileDigest, input: "B" },
			};
			for (const context of [null, [], {}, 42, "\u20ac".repeat(21_846)]) {
				await expect(
					dispatchEngineCommand({
						runtime,
						command: { ...command, payload: { ...command.payload, context } },
						resolveLaunchProfile: () => profile,
					}),
				).rejects.toMatchObject({ code: "invalid_request" });
			}
			expect(dispatches).toBe(0);
			expect(await runtime.store.getAttempt(command.attemptId!)).toBeUndefined();
			await dispatchEngineCommand({
				runtime,
				command: { ...command, payload: { ...command.payload, context: "\u00e9".repeat(32_768) } },
				resolveLaunchProfile: () => profile,
			});
			await runtime.drain();
			expect(dispatches).toBe(1);
		} finally {
			await runtime.dispose();
		}
	});

	it.each(["inline", "blob"])(
		"projects %s user and tool-result images from their own retained entries across restart",
		async storage => {
			const png = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
				"base64",
			);
			const image = storage === "inline" ? png : Buffer.concat([png, Buffer.alloc(2048)]);
			const agentInstanceId = "history-image-agent";
			const agentInstanceRef = "grimoire://tasks/grimoire/image-history/agents/owner";
			{
				const fixture = await createRuntime(async session => {
					session.sessionManager.appendMessage({
						role: "user",
						content: [
							{ type: "text", text: "Uploaded image" },
							{ type: "image", mimeType: "image/png", data: image.toString("base64") },
							{ type: "text", text: "After uploaded image" },
						],
						timestamp: 1,
					});
					session.sessionManager.appendMessage({
						role: "assistant",
						content: [
							{ type: "text", text: "Reading image" },
							{ type: "toolCall", id: "read-image", name: "read", arguments: { path: "picture.png" } },
						],
						api: "openai-responses",
						provider: "mock",
						model: "mock",
						timestamp: 2,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
					});
					session.sessionManager.appendMessage({
						role: "toolResult",
						toolCallId: "read-image",
						toolName: "read",
						content: [
							{ type: "text", text: "Before result image" },
							{ type: "image", mimeType: "image/png", data: image.toString("base64") },
							{ type: "text", text: "After result image" },
						],
						isError: false,
						timestamp: 3,
					});
					return true;
				});
				await fixture.runtime.store.registerAgent({
					agentInstanceId,
					agentInstanceRef,
					principalId: "owner",
					authorityGeneration: 1,
				});
				const started = await fixture.runtime.start(
					{
						commandId: "history-image-start",
						agentInstanceId,
						agentInstanceRef,
						executionId: "history-image-execution",
						attemptId: "history-image-attempt",
						authorityGeneration: 1,
						cwd: fixture.cwd,
						input: "images",
					},
					profile,
				);
				await fixture.runtime.drain();
				const page = await fixture.runtime.sessionHistoryPage(
					agentInstanceId,
					agentInstanceRef,
					undefined,
					100,
					started.attemptId,
				);
				const user = page.entries.find(entry => entry.role === "user")!;
				const assistant = page.entries.find(entry => entry.role === "assistant")!;
				expect(user.images).toMatchObject([{ status: "available" }]);
				const upload = user.images![0].resource!;
				const result = assistant.blocks!.find(block => block.toolCallId === "read-image")!.images![0].resource!;
				expect(upload).toMatchObject({ entryId: user.entryId, blockIndex: 1, bytes: image.length });
				expect(result.entryId).not.toBe(assistant.entryId);
				expect(result).toMatchObject({ blockIndex: 1, contentHash: upload.contentHash, revision: upload.revision });
				expect(user.blocks?.map(block => [block.blockIndex, block.text])).toEqual([
					[0, "Uploaded image"],
					[2, "After uploaded image"],
				]);
				expect(assistant.blocks!.find(block => block.toolCallId === "read-image")!.resultBlocks).toMatchObject([
					{ blockIndex: 0, text: "Before result image" },
					{ blockIndex: 1, image: { resource: result } },
					{ blockIndex: 2, text: "After result image" },
				]);
				expect(page.entries.map(entry => entry.role)).toEqual(["user", "assistant"]);
				expect(JSON.stringify(page.entries)).not.toContain(image.toString("base64"));
				for (const resource of [upload, result]) {
					const read = await fixture.runtime.store.runtimeResource({
						principalId: "owner",
						resource: { ...resource },
						offset: 0,
						limit: 65_536,
					});
					expect(Buffer.from(String(read.contentBase64), "base64")).toEqual(image);
				}
				await fixture.runtime.dispose();
				const reopened = await openRuntime(fixture.options);
				expect(
					(await reopened.sessionHistoryPage(agentInstanceId, agentInstanceRef, undefined, 100, started.attemptId))
						.entries,
				).toEqual(page.entries);
			}
		},
		30_000,
	);

	it("applies native history edit and branch starts without flattening or changing the source branch", async () => {
		const dispatches: Array<{
			kind: string | undefined;
			input: string;
			sessionId: string;
			messages: string;
		}> = [];
		const { runtime, cwd } = await createRuntime(async (session, input, _identity, kind) => {
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
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			return true;
		});
		const source = await runtime.start(
			{
				commandId: "history-source-command",
				agentInstanceId: "history-source",
				executionId: "history-source-execution",
				attemptId: "history-source-attempt",
				authorityGeneration: 1,
				cwd,
				input: "original user",
			},
			profile,
		);
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

		const branched = await runtime.start(
			{
				commandId: "history-branch-command",
				agentInstanceId: "history-branch",
				executionId: "history-branch-execution",
				attemptId: "history-branch-attempt",
				authorityGeneration: 1,
				cwd,
				input: "new branch prompt",
				historyEdit: {
					mode: "branch",
					source,
					sourceSessionId: sourceHistory.sessionId,
					expectedLeafEntryId: sourceHistory.sessionLeafEntryId,
					entryId: sourceUser.entryId,
				},
			},
			profile,
		);
		await runtime.drain();
		expect(branched.sessionFile).not.toBe(source.sessionFile);
		expect(branched.historyEdit).toMatchObject({ mode: "branch", sourceEntryId: sourceUser.entryId });
		const branchDispatch = dispatches.find(call => call.input === "new branch prompt");
		expect(branchDispatch?.messages).toContain("original user");
		expect(branchDispatch?.messages).not.toContain("answer:original user");
		expect(await runtime.listInbox(branched, true)).toEqual([]);
		expect(await runtime.listInbox(source)).toEqual(pendingBeforeEdit);
		const unchanged = await nativeHistory(runtime, source.agentInstanceId);
		expect(unchanged.entries.map(entry => entry.text)).toEqual(["original user", "answer:original user"]);
		await runtime.start(
			{
				commandId: "history-empty-branch-command",
				agentInstanceId: "history-empty-branch",
				executionId: "history-empty-branch-execution",
				attemptId: "history-empty-branch-attempt",
				authorityGeneration: 1,
				cwd,
				historyEdit: {
					mode: "branch",
					source,
					sourceSessionId: sourceHistory.sessionId,
					expectedLeafEntryId: sourceHistory.sessionLeafEntryId,
					entryId: sourceUser.entryId,
				},
			},
			profile,
		);
		await runtime.drain();
		const emptyBranchDispatch = dispatches.find(call => call.kind === "continue");
		expect(emptyBranchDispatch?.messages).toContain("original user");
		expect(emptyBranchDispatch?.messages).not.toContain("history-resume");

		const edited = await runtime.start(
			{
				commandId: "history-edit-command",
				context: JSON.stringify({ work_tracking: { receipt: "R-history-edit" } }),
				clientMessageId: "edited-client-message",
				agentInstanceId: source.agentInstanceId,
				executionId: "history-edit-execution",
				attemptId: "history-edit-attempt",
				authorityGeneration: 1,
				cwd,
				historyEdit: {
					mode: "edit",
					source,
					sourceSessionId: sourceHistory.sessionId,
					expectedLeafEntryId: sourceHistory.sessionLeafEntryId,
					entryId: sourceAssistant.entryId,
					replacementText: "edited assistant",
				},
			},
			profile,
		);
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
		expect(editDispatch?.messages).not.toContain('"role":"user","content":"edited assistant"');
		expect(edited.manualHold).toBeTrue();
		expect(await runtime.listInbox(edited)).toEqual(
			pendingBeforeEdit.map(item =>
				expect.objectContaining({
					queueId: item.queueId,
					sessionId: edited.historyEdit?.sessionId,
					sourceBody: item.sourceBody,
					deliveryPayload: item.deliveryPayload,
					position: item.position,
					revision: item.revision,
					disposition: "pending",
				}),
			),
		);
		expect(await runtime.store.listInboxItems(sourceHistory.sessionId)).toEqual([]);
		await expect(runtime.listInbox(source)).rejects.toMatchObject({ code: "stale_target" });
		await runtime.dispose();
	}, 60_000);

	it("removes a prepared history fork when profile resolution fails and preserves the source", async () => {
		let failProfile = false;
		const { runtime, cwd } = await createRuntime(
			async (session, input) => {
				session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
				return true;
			},
			{
				resolveSessionProfile: async () => {
					if (failProfile) throw new Error("profile unavailable");
					return { options: {}, dispose() {} };
				},
			},
		);
		const source = await runtime.start(
			{
				commandId: "cleanup-source",
				agentInstanceId: "cleanup-source",
				executionId: "cleanup-source",
				attemptId: "cleanup-source",
				authorityGeneration: 1,
				cwd,
				input: "retained source",
			},
			profile,
		);
		await runtime.drain();
		const history = await nativeHistory(runtime, source.agentInstanceId);
		const fork = spyOn(SessionManager, "forkNativeContext");
		try {
			failProfile = true;
			await expect(
				runtime.start(
					{
						commandId: "cleanup-branch",
						agentInstanceId: "cleanup-branch",
						executionId: "cleanup-branch",
						attemptId: "cleanup-branch",
						authorityGeneration: 1,
						cwd,
						historyEdit: {
							mode: "branch",
							source,
							sourceSessionId: history.sessionId,
							expectedLeafEntryId: history.sessionLeafEntryId!,
							entryId: history.entries[0]!.entryId,
						},
					},
					profile,
				),
			).rejects.toThrow("profile unavailable");
			expect(fork).toHaveBeenCalledTimes(1);
			expect(((await fork.mock.results[0]!.value) as SessionManager).getSessionFile()).toBeDefined();
			expect(await runtime.store.getBinding("cleanup-branch")).toBeUndefined();
			expect(await runtime.store.getAttempt("cleanup-branch")).toBeUndefined();
			expect(await nativeHistory(runtime, source.agentInstanceId)).toEqual(history);
		} finally {
			fork.mockRestore();
			await runtime.dispose();
		}
	});

	it("rejects a history branch while the exact source Attempt is unfinished", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, cwd } = await createRuntime(async (session, input) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
			entered.resolve();
			await release.promise;
			return true;
		});
		const source = await runtime.start(
			{
				commandId: "active-history-source-command",
				agentInstanceId: "active-history-source",
				executionId: "active-history-source-execution",
				attemptId: "active-history-source-attempt",
				authorityGeneration: 1,
				cwd,
				input: "active source",
			},
			profile,
		);
		await entered.promise;
		await runtime.agentRegistry.get(source.engineAgentId)!.session!.sessionManager.flush();
		const history = await nativeHistory(runtime, source.agentInstanceId);
		if (!history.sessionLeafEntryId || !history.entries[0]) throw new Error("Expected active source history");

		await expect(
			runtime.start(
				{
					commandId: "active-history-branch-command",
					agentInstanceId: "active-history-branch",
					executionId: "active-history-branch-execution",
					attemptId: "active-history-branch-attempt",
					authorityGeneration: 1,
					cwd,
					historyEdit: {
						mode: "branch",
						source,
						sourceSessionId: history.sessionId,
						expectedLeafEntryId: history.sessionLeafEntryId,
						entryId: history.entries[0].entryId,
					},
				},
				profile,
			),
		).rejects.toMatchObject({ code: "agent_busy" });
		expect(runtime.getBinding("active-history-branch")).toBeUndefined();
		release.resolve();
		await runtime.drain();
		await runtime.dispose();
	}, 60_000);

	it("fails closed when Engine mode has no explicit Settings snapshot", async () => {
		const { runtime, cwd } = await createRuntime(async () => true, {}, { settings: undefined });
		await expect(
			runtime.start(
				{
					commandId: "command-missing-settings",
					agentInstanceId: "agent-missing-settings",
					executionId: "execution-missing-settings",
					attemptId: "attempt-missing-settings",
					authorityGeneration: 1,
					cwd,
					input: "must fail before startup",
				},
				profile,
			),
		).rejects.toThrow("Engine mode requires explicit settings");
		await runtime.dispose();
	});

	it("rejects an Engine Settings snapshot captured for another cwd", async () => {
		const { runtime, cwd } = await createRuntime(
			async () => true,
			{},
			{ settings: await Settings.loadReadOnly({ cwd: process.cwd() }) },
		);
		await expect(
			runtime.start(
				{
					commandId: "command-mismatched-settings",
					agentInstanceId: "agent-mismatched-settings",
					executionId: "execution-mismatched-settings",
					attemptId: "attempt-mismatched-settings",
					authorityGeneration: 1,
					cwd,
					input: "must fail before startup",
				},
				profile,
			),
		).rejects.toThrow("Engine settings cwd does not match session cwd");
		await runtime.dispose();
	});

	it("forces extension discovery to explicit-only with no in-process roots", async () => {
		let roots: { mode: string; explicit: readonly string[] } | undefined;
		let enabledTools: string[] = [];
		const { runtime, cwd } = await createRuntime(
			async session => {
				roots = session.effectiveExtensionRoots;
				enabledTools = session.getEnabledToolNames();
				return true;
			},
			{},
			{
				disableExtensionDiscovery: false,
				additionalExtensionPaths: [process.cwd()],
				preloadedCustomToolPaths: [{ path: "ambient-engine-tool.js" }],
			},
		);
		fs.writeFileSync(
			path.join(cwd, "ambient-engine-tool.js"),
			[
				"export default api => ({",
				'  name: "ambient_engine_tool",',
				'  label: "Ambient Engine Tool",',
				'  description: "must not load",',
				"  parameters: api.arktype({}),",
				'  async execute() { return { content: [{ type: "text", text: "bad" }] }; },',
				"});",
			].join("\n"),
		);
		await runtime.start(
			{
				commandId: "command-ambient-extensions",
				agentInstanceId: "agent-ambient-extensions",
				executionId: "execution-ambient-extensions",
				attemptId: "attempt-ambient-extensions",
				authorityGeneration: 1,
				cwd,
				input: "start without ambient extensions",
			},
			{ ...profile, spawns: "*", maxSpawnDepth: 1 },
		);
		await runtime.drain();
		expect(roots).toMatchObject({ mode: "explicit-only", explicit: [] });
		expect(enabledTools).not.toContain("ambient_engine_tool");
		expect(enabledTools).not.toContain("task");
		await runtime.dispose();
	});

	it("seals cwd, settings, provider policy and tools across one root plus six concurrent children", async () => {
		const capabilityId = `engine-policy-${Snowflake.next()}`;
		const providers = Array.from({ length: 7 }, (_, index) => `${capabilityId}-${index}`);
		const webProviders = ["perplexity", "gemini", "anthropic", "codex", "xai", "zai", "exa"] as const;
		defineCapability<{ name: string }>({
			id: capabilityId,
			displayName: capabilityId,
			description: capabilityId,
			key: item => item.name,
		});
		for (const provider of providers) {
			registerProvider(capabilityId, {
				id: provider,
				displayName: provider,
				description: provider,
				priority: 1,
				load: async ctx => ({
					items: [
						{
							name: provider,
							_source: { provider, providerName: provider, path: ctx.cwd, level: "project" as const },
						},
					],
				}),
			});
		}

		const settingsByProfile = new Map<string, Settings>();
		const entered = Promise.withResolvers<void>();
		const providerResults = new Map<string, string[]>();
		const webProviderResults = new Map<string, string>();
		const toolResults = new Map<string, string[]>();
		let enteredCount = 0;
		const { runtime, cwd } = await createRuntime(
			async session => {
				expect(session.settings.isReadOnly()).toBe(true);
				expect(ambientSettings.getCwd()).toBe(session.settings.getCwd());
				expect(() => session.settings.override("task.maxRecursionDepth", 99)).toThrow(
					"Settings snapshot is read-only",
				);
				expect(() => session.settings.get("disabledProviders").push("ambient-mutation")).toThrow();
				await expect(session.settings.reloadForCwd(process.cwd())).rejects.toThrow(
					"Settings snapshot is read-only",
				);
				enteredCount++;
				if (enteredCount === 7) entered.resolve();
				await entered.promise;
				const loaded = await loadCapability<{ name: string }>(capabilityId, { cwd: session.settings.getCwd() });
				providerResults.set(
					session.settings.getCwd(),
					loaded.items.map(item => item.name),
				);
				webProviderResults.set(session.settings.getCwd(), resolveProviderCandidates()[0]!.id);
				toolResults.set(session.settings.getCwd(), session.getEnabledToolNames());
				return true;
			},
			{
				resolveSessionProfile: async launch => ({
					options: { settings: settingsByProfile.get(launch.profileDigest) },
					dispose() {},
				}),
			},
		);
		const processCwd = process.cwd();
		const workspaces = await Promise.all(
			providers.map(async (provider, index) => {
				const sessionCwd = path.join(path.dirname(cwd), `workspace-${index}`);
				fs.mkdirSync(sessionCwd);
				settingsByProfile.set(
					`profile-${index}`,
					await Settings.loadReadOnly({
						cwd: sessionCwd,
						overrides: {
							disabledProviders: providers.filter(candidate => candidate !== provider),
							"providers.webSearchOrder": [webProviders[index]!],
						},
					}),
				);
				return sessionCwd;
			}),
		);
		const starts = await Promise.all(
			workspaces.map((sessionCwd, index) =>
				runtime.start(
					{
						commandId: `command-policy-${index}`,
						agentInstanceId: `agent-policy-${index}`,
						...(index > 0 ? { parentAgentInstanceId: "agent-policy-0" } : {}),
						executionId: `execution-policy-${index}`,
						attemptId: `attempt-policy-${index}`,
						authorityGeneration: 1,
						cwd: sessionCwd,
						input: String(index),
					},
					{
						...profile,
						profileDigest: `profile-${index}`,
						toolNames: [index % 2 === 0 ? "read" : "glob"],
						restrictToolNames: true,
					},
				),
			),
		);
		await runtime.drain();
		for (let index = 0; index < workspaces.length; index++) {
			expect(providerResults.get(workspaces[index]!)).toEqual([providers[index]!]);
			expect(webProviderResults.get(workspaces[index]!)).toBe(webProviders[index]!);
			const ownTool = index % 2 === 0 ? "read" : "glob";
			const otherTool = index % 2 === 0 ? "glob" : "read";
			expect(toolResults.get(workspaces[index]!)?.includes(ownTool)).toBe(true);
			expect(toolResults.get(workspaces[index]!)?.includes(otherTool)).toBe(false);
		}
		expect(process.cwd()).toBe(processCwd);
		await Promise.all(starts.map(target => runtime.release(target)));
		expect(runtime.agentRegistry.list()).toHaveLength(0);
		expect(runtime.asyncJobManager.getRunningJobs()).toHaveLength(0);
		await runtime.dispose();
	});

	it("releases every binding resource when one session disposer fails", async () => {
		let profileDisposals = 0;
		const { runtime, cwd } = await createRuntime(
			async session => {
				const dispose = session.dispose.bind(session);
				session.dispose = async () => {
					await dispose();
					throw new Error("injected session disposal failure");
				};
				return true;
			},
			{
				resolveSessionProfile: async () => ({
					options: {},
					dispose: () => {
						profileDisposals++;
					},
				}),
			},
		);
		await Promise.all(
			[0, 1].map(index =>
				runtime.start(
					{
						commandId: `command-cleanup-${index}`,
						agentInstanceId: `agent-cleanup-${index}`,
						executionId: `execution-cleanup-${index}`,
						attemptId: `attempt-cleanup-${index}`,
						authorityGeneration: 1,
						cwd,
						input: "finish",
					},
					profile,
				),
			),
		);
		await runtime.drain();
		await expect(runtime.dispose()).rejects.toBeInstanceOf(AggregateError);
		expect(profileDisposals).toBe(2);
		expect(runtime.agentRegistry.list()).toHaveLength(0);
		expect(runtime.asyncJobManager.getRunningJobs()).toHaveLength(0);
		expect(getLspResourceCounts()).toEqual({ clients: 0, pending: 0, owners: 0 });
	});

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
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await runtime.start(
			{
				commandId: "command-input",
				agentInstanceId: "agent-input",
				executionId: "execution-input",
				attemptId: "attempt-input",
				authorityGeneration: 1,
				cwd,
				input: "ask",
			},
			{ ...profile, toolNames: ["ask"], restrictToolNames: true },
		);
		const input = await requested;
		const inputId = String(input.payload?.inputId);
		expect(input.payload).toEqual({
			inputId,
			inputKind: "ask",
			questions,
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
		const { runtime, cwd } = await createRuntime(
			(session, input) => {
				activeSession = session;
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		);
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await runtime.start(
			{
				commandId: "command-indexed-start",
				agentInstanceId: "agent-indexed",
				// Input revisions are guarded on the projected input, which only refs are projected into.
				agentInstanceRef: "grimoire://tasks/grimoire/runtime-test/agents/agent-indexed",
				executionId: "execution-indexed",
				attemptId: "attempt-indexed",
				authorityGeneration: 1,
				cwd,
				input: "ask",
			},
			{ ...profile, toolNames: ["ask"], restrictToolNames: true },
		);
		const input = await requested;
		const inputId = String(input.payload?.inputId);
		const expectedIntentRevision = (await runtime.store.intent(started.agentInstanceId)).intentRevision;
		const result = {
			kind: "submit" as const,
			results: questions.map(question => ({
				id: question.id,
				selectedOptionIndexes: question.options.map((_, index) => index),
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

	it("completes a native prompt when user persistence and history checkpoints share the lane", async () => {
		const mock = createMockModel({ responses: [{ content: ["checkpoint answer"] }] });
		const { runtime, cwd } = await createRuntime(undefined, {
			dispatchPrompt: undefined,
			resolveSessionProfile: async () => ({
				options: { model: mock.model },
				profileRoutes: {
					profileRef: "gctx:2222222222222222",
					primaryRouteRef: "gctx:3333333333333333",
					routes: [{ routeRef: "gctx:3333333333333333", provider: mock.model.provider, modelId: mock.model.id }],
				},
				dispose() {},
			}),
		});
		const started = await runtime.start(
			{
				commandId: "checkpoint-cycle-start",
				agentInstanceId: "checkpoint-cycle-agent",
				executionId: "checkpoint-cycle-execution",
				attemptId: "checkpoint-cycle-attempt",
				authorityGeneration: 1,
				cwd,
				input: "checkpoint question",
			},
			profile,
		);
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

	for (const queued of [false, true]) {
		it(`publishes ${queued ? "queued" : "ordinary"} Start user history while the provider is still running`, async () => {
			const dispatchEntered = Promise.withResolvers<void>();
			const allowAppend = Promise.withResolvers<void>();
			const providerEntered = Promise.withResolvers<void>();
			const releaseProvider = Promise.withResolvers<void>();
			const input = "The new user message must be visible before the answer.";
			const mock = createMockModel({
				responses: [
					...(queued ? [{ content: ["previous answer"] }] : []),
					async () => {
						providerEntered.resolve();
						await releaseProvider.promise;
						return { content: ["new answer"] };
					},
				],
			});
			const { runtime, cwd, options } = await createRuntime(
				async (session, text, identity) => {
					if (text === input) {
						dispatchEntered.resolve();
						await allowAppend.promise;
					}
					return session.prompt(text, identity);
				},
				{},
				{ model: mock.model },
			);
			const agentInstanceRef = `grimoire://tasks/grimoire/runtime-test/agents/user-history-${queued}`;
			const request: EngineStartRequest = {
				commandId: "history-user-start",
				agentInstanceId: engineAgentInstanceId(agentInstanceRef),
				agentInstanceRef,
				principalId: "history-owner",
				executionId: "history-user-execution",
				attemptId: "history-user-attempt",
				authorityGeneration: 1,
				cwd,
				input,
				clientMessageId: "history-user-message",
			};
			const server = await startEngineControlQueryServer({
				runtime,
				runtimeDir: path.dirname(options.databasePath!),
				deviceId: "history-device",
				engineId: "history-engine",
				resolveLaunchProfile: () => profile,
			});
			const client = new EngineControlQueryClient(path.dirname(options.databasePath!));
			const replicated: string[] = [];
			const replicate = (entry: { id: string }) => {
				replicated.push(entry.id);
			};
			const newerReplicate = (_entry: { id: string }) => {};
			const createManager = SessionManager.createNative.bind(SessionManager);
			let observedManager: SessionManager | undefined;
			const creation = spyOn(SessionManager, "createNative").mockImplementation((...args) => {
				const manager = createManager(...args);
				if (args[0] === cwd) {
					manager.onEntryAppended = replicate;
					observedManager = manager;
				}
				return manager;
			});
			try {
				if (queued) {
					const previous = await runtime.start(
						{
							...request,
							commandId: "history-previous-start",
							attemptId: "history-previous-attempt",
							executionId: "history-previous-execution",
							input: "previous user",
						},
						profile,
					);
					await runtime.drain();
					const held = await runtime.pause({
						...previous,
						commandId: "history-previous-pause",
						initiator: { kind: "human" },
						expectedIntentRevision: previous.intentRevision,
					});
					const item = await runtime.enqueueInbox(previous, {
						sourceEventId: "history-queue-user",
						sourceType: "user",
						body: input,
						createdAt: Date.now(),
					});
					delete request.input;
					delete request.clientMessageId;
					Object.assign(request, {
						queueId: item.item.queueId,
						expectedRevision: item.item.revision,
						mutationId: "history-queue-consume",
						expectedIntentRevision: held.intentRevision,
						explicitContinue: true,
					});
				}
				const started = await runtime.start(request, profile);
				await withTimeout(dispatchEntered.promise, 2_000, "Start did not reach the controlled prompt boundary");
				const scope: RuntimeScope = {
					kind: "attempt",
					agentInstanceRef,
					attemptId: started.attemptId,
					kinds: ["history", "state"],
				};
				const before = await runtime.store.runtimeSnapshot(scope, { principalId: "history-owner" });
				const params = { agentInstanceRef, attemptId: started.attemptId, principalId: "history-owner", limit: 40 };
				const initial = (await client.request("runtime.history", params)) as { entries: Array<{ text: string }> };
				expect(initial.entries.some(entry => entry.text === input)).toBeFalse();
				const published = nextEngineEvent(runtime, "reconciled", started.attemptId);
				allowAppend.resolve();
				await withTimeout(providerEntered.promise, 2_000, "User append did not reach the held provider");
				const event = await withTimeout(published, 2_000, "Durable user append did not invalidate public history");
				const changes = await runtime.store.runtimeEvents({
					scope,
					principalId: "history-owner",
					epoch: before.epoch,
					afterCursor: before.watermark,
					timeoutMs: 0,
					limit: 100,
					maxBytes: 61_440,
					remainingWork: runtimeRemainingWork(),
				});
				expect(changes.changes).toContainEqual(
					expect.objectContaining({
						kind: "invalidate",
						agentInstanceRef,
						attemptId: started.attemptId,
						cursor: event.eventId,
						value: expect.objectContaining({ resource: "history" }),
					}),
				);
				const page = (await client.request("runtime.history", params)) as {
					entries: Array<{
						entryId: string;
						role: string;
						text: string;
						sourceCommandId?: string;
						clientMessageId?: string;
					}>;
				};
				validateRuntimeValue("historyPage", page);
				const users = page.entries.filter(entry => entry.role === "user" && entry.text === input);
				expect(users).toHaveLength(1);
				expect(users[0]).toMatchObject({
					sourceCommandId: request.commandId,
					clientMessageId: queued ? "history-queue-user" : "history-user-message",
				});
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
				const after = await runtime.store.runtimeSnapshot(scope, { principalId: "history-owner" });
				expect(after.agents[0]?.history).toMatchObject({ leafEntryId: users[0].entryId });
				expect(replicated.filter(id => id === users[0].entryId)).toHaveLength(1);
				if (queued)
					expect(await runtime.readInbox(started, request.queueId!)).toMatchObject({
						disposition: "acknowledged",
						revision: 2,
					});
				if (queued) observedManager!.onEntryAppended = newerReplicate;
			} finally {
				allowAppend.resolve();
				releaseProvider.resolve();
				try {
					await runtime.drain();
					await server.close();
					await runtime.dispose();
				} finally {
					creation.mockRestore();
				}
			}
			// Releasing the Engine restores its predecessor, but must not remove a newer collab owner.
			expect(observedManager?.onEntryAppended).toBe(queued ? newerReplicate : replicate);
		}, 20_000);
	}

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
		const { runtime, cwd } = await createRuntime(
			async (session, text, identity) => {
				if (text === "cancel this user append") {
					dispatchEntered.resolve();
					await allowAppend.promise;
				}
				return session.prompt(text, identity);
			},
			{},
			{ model: mock.model },
		);
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
			const request: EngineStartRequest = {
				commandId: "history-cancel-start",
				agentInstanceId: "history-cancel-agent",
				executionId: "history-cancel-execution",
				attemptId: "history-cancel-attempt",
				authorityGeneration: 1,
				cwd,
				input: "cancel this user append",
			};
			const started = await runtime.start(request, profile);
			await withTimeout(dispatchEntered.promise, 2_000, "Start did not reach the append boundary");
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
				stoppedEvents.filter(event => event.kind === "reconciled" && event.attemptId === started.attemptId),
			).toHaveLength(0);
			const stopped = await runtime.store.intent(started.agentInstanceId);
			const next = await runtime.start(
				{
					...request,
					commandId: "history-next-start",
					attemptId: "history-next-attempt",
					executionId: "history-next-execution",
					input: "only the next Attempt owns this user append",
					expectedIntentRevision: stopped.intentRevision,
					explicitContinue: true,
				},
				profile,
			);
			await withTimeout(runtime.drain(), 3_000, "Next Attempt did not finish");
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
			expect((await runtime.store.getAttempt(next.attemptId))?.state).toBe("completed");
			const events = await runtime.store.pendingEvents();
			expect(events.filter(event => event.kind === "reconciled").map(event => event.attemptId)).toEqual([
				next.attemptId,
			]);
			const history = await nativeHistory(runtime, next.agentInstanceId);
			expect(history.entries.filter(entry => entry.role === "user").map(entry => entry.text)).toEqual([
				request.input!,
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

	it("cancels an Attempt that is waiting for Ask input", async () => {
		const questions = [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }];
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: "ask-cancel", name: "ask", arguments: { questions } }] }],
		});
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await runtime.start(
			{
				commandId: "command-cancel-input",
				agentInstanceId: "agent-cancel-input",
				executionId: "execution-cancel-input",
				attemptId: "attempt-cancel-input",
				authorityGeneration: 1,
				cwd,
				input: "ask",
			},
			{ ...profile, toolNames: ["ask"], restrictToolNames: true },
		);
		const input = await requested;
		const resolved = nextEngineEvent(runtime, "input_resolved");
		await runtime.cancel({ ...started, commandId: "command-stop-input", reason: "No answer needed" });
		await runtime.drain();
		expect(await resolved).toMatchObject({
			causationCommandId: "command-stop-input",
			payload: {
				inputId: input.payload?.inputId,
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
		const { runtime, cwd } = await createRuntime(
			(session, input) => {
				abortDialog = () => session.abort({ reason: "dialog aborted" });
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		);
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await runtime.start(
			{
				commandId: "command-abort-input",
				agentInstanceId: "agent-abort-input",
				executionId: "execution-abort-input",
				attemptId: "attempt-abort-input",
				authorityGeneration: 1,
				cwd,
				input: "ask",
			},
			{ ...profile, toolNames: ["ask"], restrictToolNames: true },
		);
		const input = await requested;
		const resolved = nextEngineEvent(runtime, "input_resolved");
		if (!abortDialog) throw new Error("dialog abort handle is unavailable");
		await abortDialog();
		await runtime.drain();
		expect(await resolved).toMatchObject({
			payload: { inputId: input.payload?.inputId, status: "cancelled", reason: "Input request aborted" },
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).not.toBe("waiting_input");
		await expect(
			runtime.resolveInput({
				...started,
				commandId: "late-input",
				inputId: String(input.payload?.inputId),
				result: { kind: "chat" },
			}),
		).rejects.toMatchObject({ code: "too_late" });
		await runtime.dispose();
	}, 60_000);

	it("waits for an explicit permit decision before executing a tool", async () => {
		const mock = toolTurnModel("read-permit", "read", { path: "permit.txt" });
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		fs.writeFileSync(path.join(cwd, "permit.txt"), "approved");
		const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await runtime.start(
			{
				commandId: "command-permit",
				agentInstanceId: "agent-permit",
				executionId: "execution-permit",
				attemptId: "attempt-permit",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "permit" } },
		);
		const approval = await approvalRequested;
		const approvalId = String(approval.payload?.approvalId);
		expect(toolResultOf(mock, "read-permit")).toBeUndefined();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "planned", policy: "permit" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "pending", decision: null });

		await runtime.resolveToolApproval({
			...started,
			commandId: "command-approve",
			approvalId,
			decision: "approve",
		});
		await runtime.drain();
		expect(toolResultOf(mock, "read-permit")).toMatchObject({ isError: false });
		expect(JSON.stringify(toolResultOf(mock, "read-permit")?.content)).toContain("approved");
		const events = await runtime.store.pendingEvents();
		expect(events.filter(event => event.kind.startsWith("tool_")).map(event => event.kind)).toEqual([
			"tool_approval_requested",
			"tool_approval_resolved",
			"tool_started",
			"tool_settled",
		]);
		expect(events.find(event => event.kind === "tool_approval_resolved")?.causationCommandId).toBe("command-approve");
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "completed" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "approve" });
		await runtime.dispose();
	}, 60_000);

	it("cancels an Attempt that is waiting for a tool permit", async () => {
		let executed = false;
		const { runtime, cwd } = await createRuntime(async session => {
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-cancelled-permit", { path: "permit.txt" });
			executed = true;
			return true;
		});
		fs.writeFileSync(path.join(cwd, "permit.txt"), "not read");
		const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await runtime.start(
			{
				commandId: "command-cancelled-permit",
				agentInstanceId: "agent-cancelled-permit",
				executionId: "execution-cancelled-permit",
				attemptId: "attempt-cancelled-permit",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "permit" } },
		);
		const approval = await approvalRequested;
		const approvalId = String(approval.payload?.approvalId);
		await runtime.cancel({ ...started, commandId: "command-cancel-permit" });
		await runtime.drain();
		expect(executed).toBeFalse();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const events = await runtime.store.pendingEvents();
		expect(events.find(event => event.kind === "tool_approval_resolved")?.payload?.decision).toBe("cancelled");
		expect(events.find(event => event.kind === "tool_approval_resolved")?.causationCommandId).toBe(
			"command-cancel-permit",
		);
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "cancelled" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "cancelled" });
		await runtime.dispose();
	}, 60_000);

	it("durably denies a permitted tool without executing it", async () => {
		let executed = false;
		const { runtime, cwd } = await createRuntime(async session => {
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-denied-permit", { path: "permit.txt" });
			executed = true;
			return true;
		});
		fs.writeFileSync(path.join(cwd, "permit.txt"), "not read");
		const requested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await runtime.start(
			{
				commandId: "command-denied-permit",
				agentInstanceId: "agent-denied-permit",
				executionId: "execution-denied-permit",
				attemptId: "attempt-denied-permit",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "permit" } },
		);
		const approvalId = String((await requested).payload?.approvalId);
		await runtime.resolveToolApproval({
			...started,
			commandId: "command-deny",
			approvalId,
			decision: "deny",
			reason: "not now",
		});
		await runtime.drain();
		expect(executed).toBeFalse();
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "denied" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "deny" });
		await runtime.dispose();
	}, 60_000);

	it("settles a tracked async effect only after its owner job finishes", async () => {
		const release = Promise.withResolvers<string>();
		const mock = toolTurnModel("read-tracked", "read", { path: "tracked.txt" });
		let runtime!: EngineRuntime;
		let cwd = "";
		({ runtime, cwd } = await createRuntime(
			(session, input) => {
				const jobId = runtime.asyncJobManager.register("bash", "tracked", () => release.promise, {
					ownerId: session.getAgentId(),
					attemptId: session.getAttemptId(),
					sourceToolCallId: "read-tracked",
				});
				runtime.asyncJobManager.watchJobs([jobId]);
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		));
		fs.writeFileSync(path.join(cwd, "tracked.txt"), "tracked");
		const toolStarted = nextEngineEvent(runtime, "tool_started");
		const started = await runtime.start(
			{
				commandId: "command-tracked",
				agentInstanceId: "agent-tracked",
				executionId: "execution-tracked",
				attemptId: "attempt-tracked",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "tracked" } },
		);
		const startedEvent = await toolStarted;
		const effectId = String(startedEvent.payload?.invocationId);
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		expect(await runtime.store.getEffect(effectId)).toMatchObject({ state: "started", policy: "tracked" });
		expect((await runtime.store.pendingEvents()).find(event => event.kind === "tool_settled")).toBeUndefined();
		release.resolve("done");
		await runtime.drain();
		const events = await runtime.store.pendingEvents();
		expect(events.find(event => event.kind === "tool_settled")?.payload).toMatchObject({ status: "completed" });
		expect(events.findIndex(event => event.kind === "tool_settled")).toBeLessThan(
			events.findIndex(event => event.kind === "completed"),
		);
		expect(await runtime.store.getEffect(effectId)).toMatchObject({ state: "settled", outcome: "completed" });
		await runtime.dispose();
	}, 60_000);

	it("keeps a background effect open while paused and settles only after resume", async () => {
		const release = Promise.withResolvers<string>();
		const mock = toolTurnModel("read-paused-background", "read", { path: "paused.txt" });
		let runtime!: EngineRuntime;
		let cwd = "";
		({ runtime, cwd } = await createRuntime(
			(session, input) => {
				const jobId = runtime.asyncJobManager.register("bash", "paused background", () => release.promise, {
					ownerId: session.getAgentId(),
					attemptId: session.getAttemptId(),
					sourceToolCallId: "read-paused-background",
				});
				runtime.asyncJobManager.watchJobs([jobId]);
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		));
		fs.writeFileSync(path.join(cwd, "paused.txt"), "paused");
		const toolStarted = nextEngineEvent(runtime, "tool_started");
		const started = await runtime.start(
			{
				commandId: "command-paused-background",
				agentInstanceId: "agent-paused-background",
				executionId: "execution-paused-background",
				attemptId: "attempt-paused-background",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "tracked" } },
		);
		const effectId = String((await toolStarted).payload?.invocationId);
		const paused = nextEngineEvent(runtime, "paused");
		await runtime.pause({ ...started, commandId: "pause-background", initiator: { kind: "human" } });
		await paused;
		expect(await runtime.store.getEffect(effectId)).toMatchObject({ state: "started" });
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
		expect((await runtime.store.pendingEvents()).some(event => event.kind === "completed")).toBeFalse();

		const toolSettled = nextEngineEvent(runtime, "tool_settled");
		release.resolve("done");
		await toolSettled;
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
		const completed = nextEngineEvent(runtime, "completed");
		await runtime.resume({ ...started, commandId: "resume-background", initiator: { kind: "human" } });
		await completed;
		expect(await runtime.store.getEffect(effectId)).toMatchObject({ state: "settled", outcome: "completed" });
		await runtime.dispose();
	}, 60_000);

	it.each(["approve", "cancel"] as const)(
		"executes write→xd with a distinct durable device effect and honors %s",
		async decision => {
			let deviceResult: string | undefined;
			const args = {
				path: "xd://grep",
				content: JSON.stringify({ pattern: "needle", path: "fixture.txt" }),
			};
			const mock = toolTurnModel("outer-write", "write", args);
			const { runtime, cwd } = await createRuntime(
				async (session, input) => {
					await session.prompt(input);
					const result = toolResultOf(mock, "outer-write");
					if (result && !result.isError) {
						deviceResult = JSON.stringify(result.content);
						const write = session.getToolByName("write");
						if (!write) throw new Error("write tool is unavailable");
						await expect(write.execute("outer-write", args)).rejects.toThrow();
					}
					return true;
				},
				{},
				{ model: mock.model },
			);
			try {
				fs.writeFileSync(path.join(cwd, "fixture.txt"), "needle\n");
				const requested = nextEngineEvent(runtime, "tool_approval_requested");
				const started = await runtime.start(
					{
						commandId: "command-xd",
						agentInstanceId: "agent-xd",
						executionId: "execution-xd",
						attemptId: "attempt-xd",
						authorityGeneration: 1,
						cwd,
						input: "grep through xd",
					},
					{ ...profile, toolPolicies: { grep: "permit" } },
				);
				const approval = await Promise.race([
					requested,
					runtime.drain().then(() => {
						throw new Error("Device finished without requesting its Engine permit");
					}),
				]);
				const approvalId = String(approval.payload?.approvalId);
				expect(deviceResult).toBeUndefined();
				expect(await runtime.store.getEffect(approvalId)).toMatchObject({
					tool_name: "grep",
					policy: "permit",
					state: "planned",
				});
				if (decision === "approve") {
					await runtime.resolveToolApproval({
						...started,
						commandId: "approve-xd",
						approvalId,
						decision: "approve",
					});
				} else {
					await runtime.cancel({ ...started, commandId: "cancel-xd" });
				}
				await runtime.drain();
				const events = await runtime.store.pendingEvents();
				const tools = events.filter(event => event.kind === "tool_started");
				expect(tools.filter(event => event.payload?.toolName === "write")).toHaveLength(1);
				expect(tools.filter(event => event.payload?.toolName === "grep")).toHaveLength(
					decision === "approve" ? 1 : 0,
				);
				expect(await runtime.store.getEffect(approvalId)).toMatchObject({
					state: "settled",
					outcome: decision === "approve" ? "completed" : "cancelled",
				});
				if (decision === "approve") {
					expect(deviceResult).toContain("needle");
					expect(new Set(tools.map(event => event.payload?.toolCallId)).size).toBe(2);
				} else {
					expect(deviceResult).toBeUndefined();
				}
			} finally {
				await runtime.dispose();
			}
		},
		60_000,
	);

	it("records unrestricted tools without exposing their raw input", async () => {
		const mock = toolTurnModel("read-unrestricted", "read", { path: "secret-name.txt" });
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		fs.writeFileSync(path.join(cwd, "secret-name.txt"), "secret-value");
		await runtime.start(
			{
				commandId: "command-unrestricted",
				agentInstanceId: "agent-unrestricted",
				executionId: "execution-unrestricted",
				attemptId: "attempt-unrestricted",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			profile,
		);
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.kind.startsWith("tool_"));
		expect(events.map(event => event.kind)).toEqual(["tool_started", "tool_settled"]);
		expect(JSON.stringify(events)).not.toContain("secret-name.txt");
		const effectId = String(events[0]?.payload?.invocationId);
		expect(await runtime.store.getEffect(effectId)).toMatchObject({
			state: "settled",
			outcome: "completed",
			policy: "unrestricted",
		});
		await runtime.dispose();
	}, 60_000);

	it("runs a turn of twelve parallel reads without refusing its own storage requests", async () => {
		const count = 12;
		const ids = Array.from({ length: count }, (_, index) => `read-parallel-${index}`);
		const mock = createMockModel({
			responses: [
				{
					content: ids.map((id, index) => ({
						type: "toolCall" as const,
						id,
						name: "read",
						arguments: { path: `parallel-${index}.txt` },
					})),
				},
				{ content: ["done"] },
			],
		});
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		for (let index = 0; index < count; index++)
			fs.writeFileSync(path.join(cwd, `parallel-${index}.txt`), `parallel content ${index}`);
		await runtime.start(
			{
				commandId: "command-parallel-reads",
				agentInstanceId: "agent-parallel-reads",
				executionId: "execution-parallel-reads",
				attemptId: "attempt-parallel-reads",
				authorityGeneration: 1,
				cwd,
				input: "read them all",
			},
			profile,
		);
		await runtime.drain();
		expect((await runtime.store.getAttempt("attempt-parallel-reads"))?.state).toBe("completed");
		for (const [index, id] of ids.entries()) {
			const result = toolResultOf(mock, id);
			expect(result?.isError).not.toBeTrue();
			expect(JSON.stringify(result?.content)).toContain(`parallel content ${index}`);
		}
		const settled = (await runtime.store.pendingEvents()).filter(event => event.kind === "tool_settled");
		expect(settled).toHaveLength(count);
	}, 60_000);

	it("records model dispatch certainty without exposing the prompt", async () => {
		const { runtime, cwd } = await createRuntime();
		await runtime.start(
			{
				commandId: "command-model-effect",
				agentInstanceId: "agent-model-effect",
				executionId: "execution-model-effect",
				attemptId: "attempt-model-effect",
				authorityGeneration: 1,
				cwd,
				input: "private prompt sentinel",
			},
			profile,
		);
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.kind.startsWith("model_"));
		expect(events.map(event => event.kind)).toEqual(["model_started", "model_settled"]);
		expect(JSON.stringify(events)).not.toContain("private prompt sentinel");
		const effectId = String(events[0]?.payload?.effectId);
		expect(await runtime.store.getEffect(effectId)).toMatchObject({
			effect_kind: "model",
			state: "settled",
			outcome: "completed",
		});
		await runtime.dispose();
	}, 60_000);

	it("applies Pause while a native usage query is pending and aborts the provider on IPC close", async () => {
		const entered = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const provider = Promise.withResolvers<void>();
		const prompt = Promise.withResolvers<boolean>();
		const ready = Promise.withResolvers<void>();
		const { runtime, cwd } = await createRuntime(async session => {
			session.fetchUsageReports = async signal => {
				signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				entered.resolve();
				await provider.promise;
				return [];
			};
			ready.resolve();
			return await prompt.promise;
		});
		const agentInstanceRef = "grimoire://tasks/grimoire/runtime-test/agents/usage-control";
		const runtimeDir = path.join(cwd, "control-query");
		fs.mkdirSync(runtimeDir);
		const server = await startEngineControlQueryServer({
			runtime,
			runtimeDir,
			deviceId: "device",
			engineId: "engine",
			resolveLaunchProfile: () => profile,
		});
		const client = new EngineControlQueryClient(runtimeDir);
		let usage: Promise<unknown> = Promise.resolve();
		try {
			const started = await runtime.start(
				{
					commandId: "start-usage-control",
					agentInstanceId: engineAgentInstanceId(agentInstanceRef),
					agentInstanceRef,
					principalId: "owner",
					executionId: "execution-usage-control",
					attemptId: "attempt-usage-control",
					authorityGeneration: 1,
					cwd,
					input: "test pending usage",
				},
				profile,
			);
			await ready.promise;
			usage = client
				.request("runtime.usage", { agentInstanceRef, attemptId: started.attemptId, principalId: "owner" })
				.then(
					() => undefined,
					error => error,
				);
			await withTimeout(entered.promise, 2_000, "Native usage query did not reach the provider");
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
			await server.close();
			provider.resolve();
			prompt.resolve(true);
			await usage;
			await runtime.dispose();
		}
	}, 20_000);

	it("rejects late usage from the previous Attempt and reads its retained header without loading history", async () => {
		const entered = Promise.withResolvers<void>();
		const provider = Promise.withResolvers<void>();
		let calls = 0;
		const { runtime, cwd } = await createRuntime(async session => {
			session.fetchUsageReports = async () => {
				calls++;
				entered.resolve();
				await provider.promise;
				return [];
			};
			return true;
		});
		const request = {
			commandId: "usage-history-first",
			agentInstanceId: "usage-history-agent",
			executionId: "usage-history-execution-first",
			attemptId: "usage-history-attempt-first",
			authorityGeneration: 1,
			cwd,
			input: "first usage Attempt",
		};
		const first = await runtime.start(request, profile);
		await runtime.drain();
		const firstHeader = await runtime.store.nativeSessionHeader(first);
		const usage = runtime.sessionUsage(first).then(
			() => undefined,
			error => error,
		);
		try {
			await entered.promise;
			const second = await withTimeout(
				runtime.start(
					{
						...request,
						commandId: "usage-history-second",
						executionId: "usage-history-execution-second",
						attemptId: "usage-history-attempt-second",
						input: "second usage Attempt",
					},
					profile,
				),
				2_000,
				"Previous usage query blocked the next Attempt",
			);
			provider.resolve();
			expect(await usage).toMatchObject({ code: "stale_target" });
			await runtime.drain();
			const read = spyOn(RocksNativeSessionStorage.prototype, "readContext").mockRejectedValue(
				new Error("Full history read forbidden"),
			);
			try {
				expect(await runtime.sessionUsage(first)).toMatchObject({
					attemptId: first.attemptId,
					sessionId: firstHeader.sessionId,
					status: "not_ready",
					local: null,
					provider: { status: "unavailable", reason: "session_not_active" },
				});
				expect(calls).toBe(1);
				expect(read).not.toHaveBeenCalled();
				expect(runtime.getBinding(first.agentInstanceId)?.attemptId).toBe(second.attemptId);
			} finally {
				read.mockRestore();
			}
		} finally {
			provider.resolve();
			await usage;
			await runtime.dispose();
		}
	}, 20_000);

	it("reports unsupported provider usage when no reports exist", async () => {
		const { runtime, cwd } = await createRuntime(async session => {
			session.fetchUsageReports = async () => [];
			return true;
		});
		const started = await runtime.start(
			{
				commandId: "usage-empty",
				agentInstanceId: "usage-agent",
				executionId: "usage-execution",
				attemptId: "usage-attempt",
				authorityGeneration: 1,
				cwd,
				input: "test usage",
			},
			profile,
		);
		await runtime.drain();
		expect((await runtime.sessionUsage(started)).provider).toEqual({
			status: "unavailable",
			reason: "provider_usage_not_supported",
		});
		await runtime.dispose();
	});

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
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		fs.writeFileSync(path.join(cwd, "private-input.txt"), "private tool output sentinel");
		await runtime.start(
			{
				commandId: "command-public-trace",
				agentInstanceId: "agent-public-trace",
				executionId: "execution-public-trace",
				attemptId: "attempt-public-trace",
				authorityGeneration: 1,
				cwd,
				input: "inspect the file",
			},
			{ ...profile, toolNames: ["read"], restrictToolNames: true },
		);
		await runtime.drain();
		const events = await runtime.store.pendingEvents();
		const trace = events.filter(event => event.kind.startsWith("trace_"));
		expect(trace.some(event => event.kind === "trace_reasoning")).toBe(true);
		expect(trace.some(event => event.kind === "trace_tool")).toBe(true);
		const tools = trace.filter(event => event.kind === "trace_tool").map(event => event.payload?.tool);
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

	it.each([
		["answered", false],
		["auth_failed", false],
		["retry_failed", false],
		["answered", true],
		["auth_failed", true],
		["retry_failed", true],
	] as const)(
		"records fallback and restarts the selected route on the next Attempt (%s, restart=%s)",
		async (outcome, restart) => {
			const exhausted = outcome !== "answered";
			const failure = outcome === "retry_failed" ? "503 Service unavailable" : "401 Unauthorized";
			let primaryAttempts = 0;
			const primary = createMockModel({
				id: "route-primary",
				handler: () =>
					++primaryAttempts > 1 && !exhausted ? { content: ["primary recovered"] } : { throw: failure },
			});
			const fallback = createMockModel({
				id: "route-fallback",
				handler: () => (exhausted ? { throw: failure } : { content: ["fallback answered"] }),
			});
			const find = spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
				[primary, fallback].find(model => model.provider === provider && model.id === id),
			);
			const key = spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
			const mapping = {
				profileRef: "gctx:2222222222222222",
				primaryRouteRef: "gctx:3333333333333333",
				routes: [primary, fallback].map((model, index) => ({
					routeRef: index === 0 ? "gctx:3333333333333333" : "gctx:4444444444444444",
					provider: model.provider,
					modelId: model.id,
				})),
			};
			const { runtime, cwd, options } = await createRuntime((session, input) => session.prompt(input), {
				resolveSessionProfile: async () => ({
					options: { model: primary },
					profileRoutes: mapping,
					orderedRouteFallback: { selectors: [primary, fallback].map(model => `${model.provider}/${model.id}`) },
					dispose() {},
				}),
			});
			let currentRuntime = runtime;
			const wait = spyOn(scheduler, "wait").mockResolvedValue(undefined);
			try {
				await runtime.start(
					{
						commandId: "route-fallback-start",
						agentInstanceId: "route-fallback-agent",
						executionId: "route-fallback-execution",
						attemptId: "route-fallback-attempt",
						authorityGeneration: 1,
						cwd,
						input: "test fallback",
					},
					profile,
				);
				await runtime.drain();
				expect(primary.calls).toHaveLength(1);
				expect(fallback.calls).toHaveLength(outcome === "retry_failed" ? 3 : 1);
				const attempt = await runtime.store.getAttempt("route-fallback-attempt");
				expect(attempt?.state).toBe(exhausted ? "failed" : "completed");
				const state = JSON.parse(attempt!.profile_route_state!) as EngineProfileRouteState;
				expect(state).toMatchObject({ fallback: true, phase: exhausted ? "exhausted" : "active" });
				if (!exhausted) expect(state.routeRef).toBe(mapping.routes[1]!.routeRef);
				const events = await runtime.store.pendingEvents();
				const changes = events.filter(event => event.kind === "profile_route_changed");
				expect(
					changes.some(
						event =>
							(event.payload?.profileRoute as EngineProfileRouteState | undefined)?.pendingRouteRef ===
							mapping.routes[1]!.routeRef,
					),
				).toBe(true);
				expect(events.indexOf(changes.at(-1)!)).toBeLessThan(
					events.findIndex(event => event.kind === (exhausted ? "failed" : "completed")),
				);
				if (restart) {
					await runtime.dispose();
					currentRuntime = await EngineRuntime.create(options);
				}
				await currentRuntime.start(
					{
						commandId: "route-next-start",
						agentInstanceId: "route-fallback-agent",
						executionId: "route-next-execution",
						attemptId: "route-next-attempt",
						authorityGeneration: 1,
						cwd,
						input: "next attempt",
					},
					profile,
				);
				await currentRuntime.drain();
				expect(primary.calls).toHaveLength(2);
				expect(fallback.calls).toHaveLength(outcome === "retry_failed" ? 6 : exhausted ? 2 : 1);
				if (!exhausted) {
					expect(
						primary.calls[1]?.context.messages.some(
							message =>
								message.role === "assistant" &&
								message.content.some(block => block.type === "text" && block.text === "fallback answered"),
						),
					).toBe(true);
				}
				const next = await currentRuntime.store.getAttempt("route-next-attempt");
				expect(next?.state).toBe(exhausted ? "failed" : "completed");
				const nextChanges = (await currentRuntime.store.pendingEvents()).filter(
					event => event.attemptId === "route-next-attempt" && event.kind === "profile_route_changed",
				);
				expect(nextChanges[0]?.payload?.profileRoute).toMatchObject({
					pendingRouteRef: mapping.primaryRouteRef,
					fallback: false,
					phase: "loading",
				});
				expect(JSON.parse(next!.profile_route_state!)).toMatchObject({
					fallback: exhausted,
					phase: exhausted ? "exhausted" : "active",
				});
			} finally {
				await currentRuntime.dispose();
				find.mockRestore();
				key.mockRestore();
				wait.mockRestore();
			}
		},
		60_000,
	);

	it("projects observed profile slots, resets them per Attempt, and retains routing after restart", async () => {
		const model = createMockModel({ responses: [{ content: ["route answer"] }] });
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const mapping = {
			profileRef: "gctx:2222222222222222",
			primaryRouteRef: "gctx:3333333333333333",
			routes: [{ routeRef: "gctx:4444444444444444", provider: model.provider, modelId: model.id }],
		};
		const { runtime, cwd, options } = await createRuntime(
			async (session, input) => {
				if (input === "fail before provider") throw new Error("local input failure");
				entered.resolve();
				await release.promise;
				return session.prompt(input);
			},
			{ resolveSessionProfile: async () => ({ options: { model }, profileRoutes: mapping, dispose() {} }) },
		);
		const runtimeDir = path.dirname(options.databasePath!);
		const server = await startEngineControlQueryServer({
			runtime,
			runtimeDir,
			deviceId: "route-device",
			engineId: "route-engine",
			resolveLaunchProfile: () => profile,
		});
		const client = new EngineControlQueryClient(runtimeDir);
		const request = {
			commandId: "route-start",
			agentInstanceId: "route-agent",
			executionId: "route-execution",
			attemptId: "route-attempt",
			authorityGeneration: 1,
			cwd,
			input: "answer",
		};
		const completedRoute: EngineProfileRouteState = {
			profileRef: mapping.profileRef,
			primaryRouteRef: mapping.primaryRouteRef,
			routeRef: mapping.routes[0]!.routeRef,
			fallback: true,
			phase: "active",
		};
		try {
			const loading = nextEngineEvent(runtime, "profile_route_changed");
			await runtime.start(request, profile);
			await entered.promise;
			expect((await loading).payload?.profileRoute).toEqual({
				profileRef: mapping.profileRef,
				primaryRouteRef: mapping.primaryRouteRef,
				pendingRouteRef: mapping.routes[0]!.routeRef,
				fallback: true,
				phase: "loading",
			});
			release.resolve();
			await runtime.drain();
			const first = await runtime.store.getAttempt(request.attemptId);
			expect(first?.state).toBe("completed");
			expect(JSON.parse(first!.profile_route_state!)).toMatchObject(completedRoute);
			const response = await client.request("snapshots.get", { attemptId: request.attemptId });
			expect(response).toMatchObject({ profileRoute: completedRoute });
			const events = (await runtime.store.pendingEvents()).filter(event => event.attemptId === request.attemptId);
			const changes = events.filter(event => event.kind === "profile_route_changed");
			expect(changes.map(event => event.payload?.profileRoute)).toEqual([
				{ ...completedRoute, routeRef: undefined, pendingRouteRef: completedRoute.routeRef, phase: "loading" },
				completedRoute,
			]);
			expect(JSON.parse(first!.profile_route_state!).eventSeq).toBe(changes.at(-1)!.seq);
			expect(events.indexOf(changes[1]!)).toBeLessThan(events.findIndex(event => event.kind === "completed"));
			await runtime.start(
				{
					...request,
					commandId: "next-route-start",
					executionId: "next-route-execution",
					attemptId: "next-route-attempt",
					input: "fail before provider",
				},
				profile,
			);
			await runtime.drain();
			const failed = await runtime.store.getAttempt("next-route-attempt");
			expect(failed?.state).toBe("failed");
			expect(JSON.parse(failed!.profile_route_state!)).toMatchObject({ phase: "loading" });
			expect(JSON.parse(failed!.profile_route_state!)).not.toHaveProperty("routeRef");
		} finally {
			release.resolve();
			await server.close();
			await runtime.dispose();
		}
		const reopened = await EngineRuntime.create({ databasePath: options.databasePath });
		try {
			expect(JSON.parse((await reopened.store.getAttempt(request.attemptId))!.profile_route_state!)).toMatchObject(
				completedRoute,
			);
		} finally {
			await reopened.dispose();
		}
	}, 60_000);

	it("publishes durable tool-only and intermediate history while the next response is still running", async () => {
		const release = Promise.withResolvers<void>();
		const reachedFinal = Promise.withResolvers<void>();
		const retained = Promise.withResolvers<void>();
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
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
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
		const checkpoints: EngineEvent[] = [];
		const unsubscribe = runtime.subscribe(async event => {
			if (
				event.attemptId !== attemptId ||
				event.kind !== "history_checkpoint" ||
				!event.payload?.transcriptCheckpoint
			)
				return;
			checkpoints.push(event);
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
			await runtime.start(
				{
					commandId: "incremental-history-start",
					agentInstanceId,
					executionId: "incremental-history-execution",
					attemptId,
					authorityGeneration: 1,
					cwd,
					input: "Read twice",
				},
				{ ...profile, toolNames: ["read"], restrictToolNames: true },
			);
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
			const latest = checkpoints.at(-1)!;
			expect((await runtime.store.getAttempt(attemptId))?.transcript_revision).toBe(
				Number((latest.payload!.transcriptCheckpoint as { revision: number }).revision),
			);
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
		const { runtime, cwd, options } = await createRuntime(
			(session, input, identity) => session.prompt(input, identity),
			{},
			{ model: mock.model },
		);
		const agentInstanceId = "empty-retry-history";
		const agentInstanceRef = "grimoire://tasks/grimoire/empty-retry-history/agents/owner";
		const attemptId = "empty-retry-attempt";
		await runtime.store.registerAgent({
			agentInstanceId,
			agentInstanceRef,
			principalId: "owner",
			authorityGeneration: 1,
		});
		await runtime.start(
			{
				commandId: "empty-retry-command",
				agentInstanceId,
				agentInstanceRef,
				executionId: "empty-retry-execution",
				attemptId,
				authorityGeneration: 1,
				cwd,
				input: "Recover from a transient error",
			},
			profile,
		);
		await runtime.drain();
		expect(mock.calls).toHaveLength(2);
		const events = await runtime.store.pendingEvents();
		const retry = events.find(event => event.kind === "retry_scheduled")!;
		const page = await runtime.sessionHistoryPage(agentInstanceId, agentInstanceRef, undefined, 100, attemptId);
		const lifecycle = await runtime.store.nativeLifecyclePage(
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
		const failure = events.find(
			event =>
				event.kind === "assistant_snapshot" &&
				event.payload?.assistantMessageId === assistants[0].assistantMessageId,
		)!;
		expect(failure.payload).toMatchObject({ text: "", stopReason: "error", historyEntryId: assistants[0].entryId });
		expect(failure.eventId).toBeLessThan(retry.eventId);
		await runtime.dispose();
		const reopened = await openRuntime(options);
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

	it("streams bounded assistant snapshots with one identity before terminal settlement", async () => {
		let retainedSessionManager: SessionManager | undefined;
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
			// Publishes the directly appended hidden entry through the next Attempt's transcript.
			handler: { content: ["after the hidden entry"] },
		});
		const { runtime, cwd } = await createRuntime(
			(session, input) => {
				retainedSessionManager = session.sessionManager;
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		);
		fs.writeFileSync(path.join(cwd, "private.txt"), "private tool output sentinel");
		const firstSnapshot = nextEngineEvent(runtime, "assistant_snapshot");
		const started = await runtime.start(
			{
				commandId: "command-assistant-stream",
				agentInstanceId: "agent-assistant-stream",
				executionId: "execution-assistant-stream",
				attemptId: "attempt-assistant-stream",
				authorityGeneration: 1,
				cwd,
				input: "inspect then answer",
			},
			{ ...profile, toolNames: ["read"], restrictToolNames: true },
		);
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
		const snapshots = events.filter(event => event.kind === "assistant_snapshot");
		const messageIds = [...new Set(snapshots.map(event => String(event.payload?.assistantMessageId)))];
		expect(messageIds).toHaveLength(2);
		const toolEvents = events.filter(event => event.kind === "tool_started" || event.kind === "tool_settled");
		expect(toolEvents.map(event => event.payload)).toMatchObject([
			{ toolCallId: "read-stream", origin: { messageId: messageIds[0], blockId: "block_2" } },
			{ toolCallId: "read-stream", origin: { messageId: messageIds[0], blockId: "block_2" } },
		]);
		const precedingBlocks = events.filter(
			event => event.kind === "message_updated" && event.payload?.messageId === messageIds[0],
		);
		expect(precedingBlocks.at(-1)!.eventId).toBeLessThan(toolEvents[0]!.eventId);
		for (const assistantMessageId of messageIds) {
			const revisions = snapshots
				.filter(event => event.payload?.assistantMessageId === assistantMessageId)
				.map(event => Number(event.payload?.revision));
			expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
			expect(new Set(revisions).size).toBe(revisions.length);
		}
		const settled = snapshots.at(-1);
		expect(settled?.payload).toMatchObject({
			assistantMessageId: messageIds[1],
			text: fullFinal.slice(0, 48_000),
			status: "settled",
			stopReason: "stop",
			textTruncated: true,
		});
		expect(String(settled?.payload?.text)).toHaveLength(48_000);
		const completed = events.find(event => event.kind === "completed");
		expect(completed?.payload?.assistantMessageId).toBe(messageIds[1]);
		expect(events.indexOf(settled!)).toBeLessThan(events.indexOf(completed!));
		const history = await nativeHistory(runtime, started.agentInstanceId);
		const assistantEntries = history.entries.filter(entry => entry.role === "assistant");
		expect(assistantEntries.map(entry => entry.assistantMessageId)).toEqual(messageIds);
		expect(history.activityCompleteness).toBe("complete");
		expect(assistantEntries[0]?.blocks).toEqual([
			expect.objectContaining({
				kind: "reasoning",
				status: "available",
				text: "private streaming reasoning sentinel",
			}),
			expect.objectContaining({ kind: "text", blockIndex: 1, text: "Inspecting the file." }),
			expect.objectContaining({
				kind: "tool_call",
				toolCallId: "read-stream",
				toolName: "read",
				argumentsText: '{"path":"private.txt"}',
				toolStatus: "succeeded",
				resultText: expect.stringContaining("private tool output sentinel"),
			}),
			expect.objectContaining({ kind: "text", blockIndex: 3, text: "Waiting for the read result." }),
		]);
		expect(assistantEntries[0]?.blocks?.[0]?.blockId).toContain(`history:${history.sessionId}:`);
		let cursor: string | undefined;
		let foundMixedPage = false;
		for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
			const page = await runtime.sessionHistoryPage(
				started.agentInstanceId,
				"grimoire://tasks/grimoire/stream/agents/agent-assistant-stream",
				cursor,
				1,
			);
			const mixed = page.entries.find(entry => entry.entryId === assistantEntries[0]?.entryId);
			if (mixed) {
				expect(mixed.blocks?.map(block => [block.kind, block.blockIndex, block.text])).toEqual(
					assistantEntries[0]?.blocks?.map(block => [block.kind, block.blockIndex, block.text]),
				);
				foundMixedPage = true;
				break;
			}
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(foundMixedPage).toBe(true);
		const hiddenEntry = retainedSessionManager?.appendMessage({
			role: "assistant",
			content: [{ type: "redactedThinking", data: "HIDDEN-PROVIDER-PAYLOAD" }],
			api: "engine-runtime-test",
			provider: "mock",
			model: "test",
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
		});
		await retainedSessionManager?.flush();
		// A terminal Attempt's history is cut at its own transcript; the next Attempt carries the hidden entry.
		await runtime.start(
			{
				commandId: "command-hidden-reasoning",
				agentInstanceId: started.agentInstanceId,
				executionId: "execution-hidden-reasoning",
				attemptId: "attempt-hidden-reasoning",
				authorityGeneration: 1,
				cwd,
				input: "continue after hidden reasoning",
				expectedIntentRevision: (await runtime.store.intent(started.agentInstanceId)).intentRevision,
				explicitContinue: true,
			},
			{ ...profile, toolNames: ["read"], restrictToolNames: true },
		);
		await runtime.drain();
		const hiddenHistory = await nativeHistory(runtime, started.agentInstanceId);
		expect(hiddenHistory.entries.find(entry => entry.entryId === hiddenEntry)?.blocks).toEqual([
			expect.objectContaining({ kind: "reasoning", status: "unavailable" }),
		]);
		expect(JSON.stringify(hiddenHistory)).not.toContain("HIDDEN-PROVIDER-PAYLOAD");
		const historyEntryId = settled?.payload?.historyEntryId;
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
		const writeEntered = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		let publishedDeltas = 0;
		const { runtime, cwd, options } = await createRuntime(
			(session, input) => {
				session.subscribe(event => {
					if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
						publishedDeltas++;
				});
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		);
		const append = runtime.store.appendEvent.bind(runtime.store);
		let inFlightBytes = 0;
		let maxInFlightBytes = 0;
		const slowStore = spyOn(runtime.store, "appendEvent").mockImplementation(async event => {
			if (event.kind !== "message_updated") return append(event);
			const bytes = Buffer.byteLength(JSON.stringify(event.payload));
			inFlightBytes += bytes;
			maxInFlightBytes = Math.max(maxInFlightBytes, inFlightBytes);
			writeEntered.resolve();
			try {
				await releaseWrite.promise;
				return await append(event);
			} finally {
				inFlightBytes -= bytes;
			}
		});
		const agentInstanceRef = "grimoire://tasks/grimoire/burst/agents/large";
		const started = await runtime.start(
			{
				commandId: "burst-start",
				agentInstanceRef,
				agentInstanceId: engineAgentInstanceId(agentInstanceRef),
				principalId: "burst-owner",
				executionId: "burst-execution",
				attemptId: "burst-attempt",
				authorityGeneration: 1,
				cwd,
				input: "large answer",
			},
			profile,
		);
		try {
			await writeEntered.promise;
			await Bun.sleep(20);
			expect(publishedDeltas).toBe(0);
			expect(maxInFlightBytes).toBeLessThanOrEqual(runtimeLimits.deliveryBatchBytes);
		} finally {
			releaseWrite.resolve();
			await runtime.drain();
			slowStore.mockRestore();
		}
		expect(publishedDeltas).toBe(1);
		expect(maxInFlightBytes).toBeLessThanOrEqual(runtimeLimits.deliveryBatchBytes);
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
		let publishedDeltas = 0;
		const { runtime, cwd } = await createRuntime(
			(session, input) => {
				session.subscribe(event => {
					if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
						publishedDeltas++;
				});
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		);
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
			const started = await runtime.start(
				{
					commandId: "stream-failure-start",
					agentInstanceId: "stream-failure-agent",
					executionId: "stream-failure-execution",
					attemptId: "stream-failure-attempt",
					authorityGeneration: 1,
					cwd,
					input: "answer",
				},
				profile,
			);
			await runtime.drain();
			expect(await runtime.store.getAttempt(started.attemptId)).toMatchObject({
				state: "failed",
				cause: "Engine message content could not be persisted",
			});
			expect(failedWrites).toBe(1);
			expect(publishedDeltas).toBe(0);
			expect(mock.calls).toHaveLength(1);
		} finally {
			brokenStore.mockRestore();
		}
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
		const { runtime, cwd } = await createRuntime(async session => {
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
		const started = await runtime.start(
			{
				commandId: "command-assistant-stop",
				agentInstanceId: "agent-assistant-stop",
				executionId: "execution-assistant-stop",
				attemptId: "attempt-assistant-stop",
				authorityGeneration: 1,
				cwd,
				input: "start a long answer",
			},
			profile,
		);
		await firstSnapshot;
		await runtime.cancel({ ...started, commandId: "command-stop-assistant", reason: "user stopped" });
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.attemptId === started.attemptId);
		const snapshots = events.filter(event => event.kind === "assistant_snapshot");
		const streamingSnapshots = snapshots.filter(event => event.payload?.status === "streaming");
		expect(streamingSnapshots).toHaveLength(2);
		expect(new Set(streamingSnapshots.map(event => event.payload?.assistantMessageId)).size).toBe(1);
		expect(streamingSnapshots.map(event => event.payload?.revision)).toEqual([1, 2]);
		expect(snapshots.at(-1)?.payload).toMatchObject({
			assistantMessageId: snapshots[0]?.payload?.assistantMessageId,
			text: "a".repeat(400),
			status: "settled",
			stopReason: "aborted",
			historyEntryId: expect.any(String),
		});
		const firstCancelled = events.findIndex(event => event.kind === "cancelled");
		expect(events.indexOf(snapshots.at(-1)!)).toBeLessThan(firstCancelled);
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const retainedAnswer = (await nativeHistory(runtime, started.agentInstanceId)).entries.find(
			entry => entry.assistantMessageId === snapshots[0]?.payload?.assistantMessageId,
		);
		expect(retainedAnswer).toMatchObject({ text: "a".repeat(400), stopReason: "aborted" });
		await runtime.dispose();
	}, 60_000);

	it("launches six pinned children in parallel and rejects the seventh", async () => {
		const taskCall = (index: number) => ({
			type: "toolCall" as const,
			id: `tool-child-${index}`,
			name: "task",
			arguments: {
				profileRef: "gctx:2222222222222222",
				workStepId: `child-step-${index}`,
				assignment: `Do child step ${index}`,
			},
		});
		const mock = createMockModel({
			responses: [{ content: Array.from({ length: 7 }, (_, index) => taskCall(index)) }, { content: ["done"] }],
		});
		const launches: Array<{ toolCallId: string; workStepId?: string; maxSpawnDepth: number }> = [];
		const { runtime, cwd } = await createRuntime((session, input) => session.prompt(input), {
			resolveSessionProfile: async () => ({
				options: { model: mock.model },
				childProfiles: [{ profileRef: "gctx:2222222222222222", displayName: "Worker" }],
				dispose() {},
			}),
			launchChild: async request => {
				launches.push(request);
				return {
					agentInstanceId: `child-${request.toolCallId}`,
					status: "completed",
					assistantFinal: `done ${request.toolCallId}`,
				};
			},
		});
		await runtime.start(
			{
				commandId: "command-parent",
				agentInstanceId: "parent-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/parent-agent",
				executionId: "execution-parent",
				attemptId: "attempt-parent",
				authorityGeneration: 1,
				cwd,
				input: "delegate",
			},
			{
				...profile,
				spawns: "*",
				maxSpawnDepth: 1,
				maxChildren: 6,
				childProfileRefs: ["gctx:2222222222222222"],
			},
		);
		await runtime.drain();
		expect(launches).toHaveLength(6);
		// Parallel calls reserve the ceiling in any order: exactly one of the seven is refused.
		const outcomes = Array.from({ length: 7 }, (_, index) => {
			const id = `tool-child-${index}`;
			const text = toolResultOf(mock, id)?.content.find(part => part.type === "text")?.text ?? "";
			if (text === `done ${id}`) return "done";
			return text.includes("maxChildren ceiling (6) reached") ? "ceiling" : text;
		});
		expect([...outcomes].sort()).toEqual(["ceiling", ...Array.from({ length: 6 }, () => "done")]);
		expect(launches.map(launch => launch.toolCallId)).not.toContain(`tool-child-${outcomes.indexOf("ceiling")}`);
		for (const launch of launches) {
			expect(launch).toMatchObject({
				workStepId: launch.toolCallId.replace("tool-child-", "child-step-"),
				maxSpawnDepth: 0,
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
					profileRef: "gctx:2222222222222222",
					workStepId: `child-step-${index}`,
					assignment: `Do child step ${index}`,
				},
			})),
		};
		const mock = createMockModel({
			responses: [taskCalls, { content: ["done first"] }, taskCalls, { content: ["done second"] }],
		});
		const launches: string[] = [];
		let failedSecondRound = false;
		const { runtime, cwd } = await createRuntime((session, input) => session.prompt(input), {
			resolveSessionProfile: async () => ({
				options: { model: mock.model },
				childProfiles: [{ profileRef: "gctx:2222222222222222", displayName: "Worker" }],
				dispose() {},
			}),
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
		const parentProfile: EngineLaunchProfile = {
			...profile,
			spawns: "*",
			maxSpawnDepth: 1,
			maxChildren: 2,
			childProfileRefs: ["gctx:2222222222222222"],
		};
		const first = await runtime.start(
			{
				commandId: "command-parent-reuse-a",
				agentInstanceId: "parent-reuse-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/parent-reuse-agent",
				executionId: "execution-parent-reuse-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "first round",
			},
			parentProfile,
		);
		await runtime.drain();
		const second = await runtime.start(
			{
				commandId: "command-parent-reuse-b",
				agentInstanceId: "parent-reuse-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/parent-reuse-agent",
				executionId: "execution-parent-reuse-b",
				attemptId: "attempt-b",
				authorityGeneration: 1,
				cwd,
				input: "second round",
			},
			parentProfile,
		);
		await runtime.drain();
		expect(second.bindingGeneration).toBe(first.bindingGeneration + 1);
		expect(runtime.agentRegistry.get(second.engineAgentId)?.session).toBe(
			runtime.agentRegistry.get(first.engineAgentId)?.session,
		);
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
			if (text.includes("maxChildren ceiling (2) reached")) return "ceiling";
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
		const entries = (await nativeHistory(runtime, "parent-reuse-agent")).entries;
		expect(entries.filter(entry => entry.role === "user").map(entry => entry.text)).toEqual([
			"first round",
			"second round",
		]);
		await runtime.dispose();
	}, 60_000);

	it("binds native task discovery to each parent and exposes a failed launch as an error", async () => {
		const parents = ["first", "second"] as const;
		const ref = (id: string) => `grimoire://tasks/project/${id}/agents/parent-${id}`;
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
										profileRef: "gctx:2222222222222222",
										workStepId: "child",
										assignment: "Do child work",
									},
								},
							],
						},
		});
		const { runtime, cwd } = await createRuntime(
			async (session, input) => {
				const task = session.getToolByName("task");
				if (!task) throw new Error("Engine root did not expose task");
				descriptions.set(input, task.description);
				await session.prompt(input);
				const result = session.messages.find(message => message.role === "toolResult");
				results.set(input, result?.role === "toolResult" ? result.isError : undefined);
				if (input === "first") {
					expect(result?.content).toEqual([
						{ type: "text", text: "Task execution failed: WorkStep child is unavailable" },
					]);
				}
				return true;
			},
			{
				resolveSessionProfile: async () => ({
					options: { model: mock.model },
					childProfiles: [{ profileRef: "gctx:2222222222222222", displayName: "Worker" }],
					dispose() {},
				}),
				launchChild: async request => {
					launches.push(request.parentAgentInstanceRef);
					if (request.parentAgentInstanceRef === ref("first")) throw new Error("WorkStep child is unavailable");
					return { agentInstanceId: "child-second", status: "completed", assistantFinal: "child completed" };
				},
			},
		);
		try {
			await Promise.all(
				parents.map(id =>
					runtime.start(
						{
							commandId: `command-${id}`,
							agentInstanceId: `parent-${id}`,
							agentInstanceRef: ref(id),
							executionId: `execution-${id}`,
							attemptId: `attempt-${id}`,
							authorityGeneration: 1,
							cwd,
							input: id,
						},
						{
							...profile,
							spawns: "*",
							maxSpawnDepth: 1,
							maxChildren: 1,
							childProfileRefs: ["gctx:2222222222222222"],
						},
					),
				),
			);
			await runtime.drain();
			for (const id of parents) {
				expect(descriptions.get(id)).toContain(ref(id));
				expect(descriptions.get(id)).toContain(`Current task: grimoire://tasks/project/${id}`);
				expect(descriptions.get(id)).not.toContain(ref(id === "first" ? "second" : "first"));
			}
			expect(launches.sort()).toEqual(parents.map(ref));
			expect(results.get("first")).toBeTrue();
			expect(results.get("second")).not.toBeTrue();
			const settled = (await runtime.store.pendingEvents()).filter(event => event.kind === "tool_settled");
			expect(settled).toHaveLength(2);
			for (const event of settled) {
				expect(await runtime.store.getEffect(String(event.payload?.invocationId))).toMatchObject({
					outcome: event.agentInstanceId === "parent-first" ? "failed" : "completed",
				});
			}
		} finally {
			await runtime.dispose();
		}
	}, 60_000);

	it("restores only retained direct-child history into its parent after restart", async () => {
		const parentId = "history-parent";
		const parentRef = "grimoire://tasks/project/history-task/agents/history-parent";
		const visibleChildId = "history-child-visible";
		const visibleChildRef = "grimoire://tasks/project/history-task/agents/history-child-visible";
		const unadvertisedChildId = "history-child-unadvertised";
		const foreignParentChildId = "history-child-foreign-parent";
		const foreignTaskChildId = "history-child-foreign-task";
		let runtimeRef: EngineRuntime;
		const childIds = [visibleChildId, unadvertisedChildId, foreignParentChildId, foreignTaskChildId];
		const engineIdOf = (id: string) => `Engine-${new Bun.SHA256().update(id).digest("hex").slice(0, 32)}`;
		// The parent spawns through task, then reads child history after restart, both through the agent loop.
		const mock = createMockModel({
			handler: context => {
				if (context.messages.at(-1)?.role === "toolResult") return { content: ["done"] };
				const user = context.messages.filter(message => message.role === "user").at(-1)!;
				if (JSON.stringify(user.content).includes("spawn truncated child")) {
					return {
						content: [
							{
								type: "toolCall" as const,
								id: "spawn-history-child",
								name: "task",
								arguments: {
									profileRef: "gctx:2222222222222222",
									workStepId: "child-history",
									assignment: "Inspect child history",
								},
							},
						],
					};
				}
				return {
					content: childIds.map(childId => ({
						type: "toolCall" as const,
						id: `read-${childId}`,
						name: "read",
						arguments: { path: `history://${engineIdOf(childId)}` },
					})),
				};
			},
		});
		const textOf = (toolCallId: string) =>
			toolResultOf(mock, toolCallId)?.content.find(part => part.type === "text")?.text ?? "";

		// Children keep their input as a plain transcript; only the parent runs the model.
		const dispatch: NonNullable<EngineRuntimeOptions["dispatchPrompt"]> = async (session, input, identity) => {
			if (input === "spawn truncated child" || input === "read retained children") return session.prompt(input);
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() }, identity);
			return true;
		};

		const created = await createRuntime(dispatch, {
			resolveSessionProfile: async () => ({
				options: { model: mock.model },
				childProfiles: [{ profileRef: "gctx:2222222222222222", displayName: "Worker" }],
				dispose() {},
			}),
			launchChild: async request => {
				const childRequest = {
					commandId: "command-history-child-visible",
					agentInstanceId: visibleChildId,
					agentInstanceRef: visibleChildRef,
					parentAgentInstanceId: request.parentAgentInstanceId,
					executionId: "execution-history-child-visible",
					attemptId: "attempt-history-child-visible",
					authorityGeneration: 1,
					cwd: request.cwd,
					input: "retained child transcript marker",
				};
				await runtimeRef.store.admitCommand(
					{
						...childRequest,
						operation: "start",
						deviceId: "device-history-restore",
						engineId: "engine-history-restore",
						engineGeneration: runtimeRef.engineGeneration,
						payloadHash: "sha256:history-child-visible",
						canonicalHash: "sha256:history-child-visible",
					},
					runtimeRef.engineGeneration,
				);
				const child = await runtimeRef.start(childRequest, profile);
				return {
					agentInstanceId: visibleChildId,
					status: "completed",
					assistantFinal: "retained child transcript marker",
					transcriptRef: `history://${child.engineAgentId}`,
					outputTruncated: true,
				};
			},
		});
		runtimeRef = created.runtime;
		const parentProfile = {
			...profile,
			spawns: "*",
			maxSpawnDepth: 1,
			maxChildren: 1,
			childProfileRefs: ["gctx:2222222222222222"],
			toolNames: ["task", "read"],
			restrictToolNames: true,
		};
		await runtimeRef.start(
			{
				commandId: "command-history-parent-one",
				agentInstanceId: parentId,
				agentInstanceRef: parentRef,
				executionId: "execution-history-parent-one",
				attemptId: "attempt-history-parent-one",
				authorityGeneration: 1,
				cwd: created.cwd,
				input: "spawn truncated child",
			},
			parentProfile,
		);
		await runtimeRef.drain();
		expect(textOf("spawn-history-child")).toContain(`history://${engineIdOf(visibleChildId)}`);

		const startForeign = async (id: string, agentInstanceRef: string, parentAgentInstanceId: string) => {
			const request = {
				commandId: `command-${id}`,
				agentInstanceId: id,
				agentInstanceRef,
				parentAgentInstanceId,
				executionId: `execution-${id}`,
				attemptId: `attempt-${id}`,
				authorityGeneration: 1,
				cwd: created.cwd,
				input: `private marker ${id}`,
			};
			await runtimeRef.store.admitCommand(
				{
					...request,
					operation: "start",
					deviceId: "device-history-restore",
					engineId: "engine-history-restore",
					engineGeneration: runtimeRef.engineGeneration,
					payloadHash: `sha256:payload-${id}`,
					canonicalHash: `sha256:canonical-${id}`,
				},
				runtimeRef.engineGeneration,
			);
			await runtimeRef.start(request, profile);
		};
		await startForeign(
			unadvertisedChildId,
			"grimoire://tasks/project/history-task/agents/history-child-unadvertised",
			parentId,
		);
		await runtimeRef.store.registerAgent({
			agentInstanceId: "another-parent",
			agentInstanceRef: "grimoire://tasks/project/history-task/agents/another-parent",
			authorityGeneration: 1,
		});
		await startForeign(
			foreignParentChildId,
			"grimoire://tasks/project/history-task/agents/history-child-foreign-parent",
			"another-parent",
		);
		await startForeign(
			foreignTaskChildId,
			"grimoire://tasks/project/another-task/agents/history-child-foreign-task",
			parentId,
		);
		await runtimeRef.drain();
		await runtimeRef.dispose();

		const restarted = await openRuntime(created.options);
		runtimeRef = restarted;
		await restarted.start(
			{
				commandId: "command-history-parent-two",
				agentInstanceId: parentId,
				agentInstanceRef: parentRef,
				executionId: "execution-history-parent-two",
				attemptId: "attempt-history-parent-two",
				authorityGeneration: 1,
				cwd: created.cwd,
				input: "read retained children",
			},
			parentProfile,
		);
		await restarted.drain();
		expect(textOf(`read-${visibleChildId}`)).toContain("retained child transcript marker");
		expect(textOf(`read-${unadvertisedChildId}`)).toContain(`private marker ${unadvertisedChildId}`);
		expect(textOf(`read-${foreignParentChildId}`)).toContain("Unknown agent");
		expect(textOf(`read-${foreignTaskChildId}`)).toContain("Unknown agent");
		await restarted.dispose();
	}, 60_000);

	it("does not expose task when the pinned profile has no child catalog", async () => {
		let enabledTools: string[] = [];
		const { runtime, cwd } = await createRuntime(
			async session => {
				enabledTools = session.getEnabledToolNames();
				return true;
			},
			{
				resolveSessionProfile: async () => ({ options: {}, childProfiles: [], dispose() {} }),
				launchChild: async () => {
					throw new Error("must not launch");
				},
			},
		);
		await runtime.start(
			{
				commandId: "command-leaf",
				agentInstanceId: "leaf-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/leaf-agent",
				executionId: "execution-leaf",
				attemptId: "attempt-leaf",
				authorityGeneration: 1,
				cwd,
				input: "leaf",
			},
			profile,
		);
		await runtime.drain();
		expect(enabledTools).not.toContain("task");
		await runtime.dispose();
	}, 60_000);

	it("uses canonical presentation fields without changing the Engine agent route", async () => {
		const { runtime, cwd } = await createRuntime();
		const started = await runtime.start(
			{
				commandId: "command-named",
				agentInstanceId: "agent-machine-identity",
				agentInstanceRef: "grimoire://tasks/p/t/agents/agent-machine-identity",
				displayName: "Schema Sentinel",
				delegationHint: "PostgreSQL migration review",
				executionId: "execution-named",
				attemptId: "attempt-named",
				authorityGeneration: 1,
				cwd,
				input: "verify naming",
			},
			profile,
		);
		await runtime.drain();
		const ref = runtime.agentRegistry.get(started.engineAgentId);
		expect(started.engineAgentId).toBe(engineAgentId("agent-machine-identity"));
		expect(ref).toMatchObject({
			id: started.engineAgentId,
			displayName: "Schema Sentinel",
			delegationHint: "PostgreSQL migration review",
		});
		await runtime.dispose();
	}, 60_000);

	it("bounds canonical presentation fields at Engine admission", () => {
		const request = {
			commandId: "command-validation",
			agentInstanceId: "agent-validation",
			executionId: "execution-validation",
			attemptId: "attempt-validation",
			authorityGeneration: 1,
			cwd: process.cwd(),
			input: "verify",
		};
		expect(() => validateStartRequest({ ...request, displayName: "" })).toThrow("displayName");
		expect(() => validateStartRequest({ ...request, displayName: "x".repeat(65) })).toThrow("displayName");
		expect(() => validateStartRequest({ ...request, delegationHint: "line one\nline two" })).toThrow(
			"delegationHint",
		);
		expect(() =>
			validateStartRequest({
				...request,
				displayName: "Schema Sentinel",
				delegationHint: "UI/UX review",
			}),
		).not.toThrow();
	});
	it("runs two independent roots on one shared runtime and disposes only the targeted root", async () => {
		const { runtime, cwd } = await createRuntime();
		const first = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		const second = await runtime.start(
			{
				commandId: "command-b",
				agentInstanceId: "agent-b",
				executionId: "execution-b",
				attemptId: "attempt-b",
				authorityGeneration: 1,
				cwd,
				input: "B",
			},
			profile,
		);
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
		expect(runtime.agentRegistry.get(first.engineAgentId)?.session).toBe(firstSession);
		release.resolve("done");
		await runtime.asyncJobManager.waitForAll();
		await runtime.dispose();
	}, 60000);

	it("reuses an idle root for a new Attempt and rejects stale generation fences", async () => {
		const { runtime, cwd } = await createRuntime();
		const first = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		await runtime.drain();
		const firstSession = runtime.agentRegistry.get(first.engineAgentId)?.session;
		const second = await runtime.start(
			{
				commandId: "command-b",
				agentInstanceId: "agent-a",
				executionId: "execution-b",
				attemptId: "attempt-b",
				authorityGeneration: 1,
				cwd,
				input: "B",
			},
			profile,
		);
		expect(second.bindingGeneration).toBe(first.bindingGeneration + 1);
		expect(runtime.agentRegistry.get(second.engineAgentId)?.session).toBe(firstSession);
		await expect(
			runtime.start(
				{
					commandId: "command-c",
					agentInstanceId: "agent-a",
					executionId: "execution-c",
					attemptId: "attempt-b",
					authorityGeneration: 1,
					cwd,
					input: "C",
				},
				profile,
			),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			runtime.cancel({ ...second, bindingGeneration: second.bindingGeneration + 1 }),
		).rejects.toMatchObject({
			code: "stale_target",
		});
		await runtime.drain();
		await runtime.dispose();
	}, 60000);

	it("rebuilds an idle root when only its per-run tool policy changes", async () => {
		const { runtime, cwd } = await createRuntime();
		const first = await runtime.start(
			{
				commandId: "command-policy-a",
				agentInstanceId: "agent-policy",
				executionId: "execution-policy-a",
				attemptId: "attempt-policy-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		await runtime.drain();
		const firstSession = runtime.agentRegistry.get(first.engineAgentId)?.session;
		const second = await runtime.start(
			{
				commandId: "command-policy-b",
				agentInstanceId: "agent-policy",
				executionId: "execution-policy-b",
				attemptId: "attempt-policy-b",
				authorityGeneration: 1,
				cwd,
				input: "B",
			},
			{ ...profile, toolPolicies: { read: "tracked" } },
		);
		expect(second.bindingGeneration).toBeGreaterThan(first.bindingGeneration);
		expect(runtime.agentRegistry.get(second.engineAgentId)?.session).not.toBe(firstSession);
		await runtime.drain();
		await runtime.dispose();
	}, 60_000);

	it("carries a durable conversation into a fresh session when the profile changes", async () => {
		const mock = createMockModel({
			responses: [{ content: ["remembered 41"] }, { content: ["same profile"] }, { content: ["fresh profile"] }],
		});
		const { runtime, cwd, options } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		const first = await runtime.start(
			{
				commandId: "command-continuity-a",
				agentInstanceId: "agent-continuity",
				executionId: "execution-continuity-a",
				attemptId: "attempt-continuity-a",
				authorityGeneration: 1,
				cwd,
				input: "Remember 41",
			},
			profile,
		);
		await runtime.drain();
		await runtime.dispose();

		const restarted = await openRuntime(options);
		const second = await restarted.start(
			{
				commandId: "command-continuity-b",
				agentInstanceId: "agent-continuity",
				executionId: "execution-continuity-b",
				attemptId: "attempt-continuity-b",
				authorityGeneration: 1,
				cwd,
				input: "What number did I say?",
			},
			profile,
		);
		await restarted.drain();
		expect(second.sessionFile).toBe(first.sessionFile);
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("Remember 41");

		const changed = await restarted.start(
			{
				commandId: "command-continuity-c",
				agentInstanceId: "agent-continuity",
				executionId: "execution-continuity-c",
				attemptId: "attempt-continuity-c",
				authorityGeneration: 1,
				cwd,
				input: "Start clean",
			},
			{ ...profile, systemPrompt: "A different AgentInstance profile" },
		);
		await restarted.drain();
		expect(changed.sessionFile).not.toBe(second.sessionFile);
		expect(JSON.stringify(mock.calls[2]?.context.messages)).toContain("Remember 41");
		expect(mock.calls[2]?.context.systemPrompt?.join("\n")).toContain("A different AgentInstance profile");
		await restarted.dispose();
	}, 60_000);

	it("fails a profile change when its retained conversation cannot be read", async () => {
		const { runtime, cwd } = await createRuntime(async (session, input) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
			return true;
		});
		const first = await runtime.start(
			{
				commandId: "command-retained-read-a",
				agentInstanceId: "agent-retained-read",
				agentInstanceRef: "grimoire://tasks/project-a/task-a/agents/agent-retained-read",
				executionId: "execution-retained-read-a",
				attemptId: "attempt-retained-read-a",
				authorityGeneration: 1,
				cwd,
				input: "Keep this context",
			},
			profile,
		);
		await runtime.drain();
		const failedRead = spyOn(RocksNativeSessionStorage.prototype, "readContext").mockRejectedValue(
			new Error("injected retained storage failure"),
		);
		try {
			await expect(
				runtime.start(
					{
						commandId: "command-retained-read-b",
						agentInstanceId: first.agentInstanceId,
						agentInstanceRef: "grimoire://tasks/project-a/task-a/agents/agent-retained-read",
						executionId: "execution-retained-read-b",
						attemptId: "attempt-retained-read-b",
						authorityGeneration: 1,
						cwd,
						input: "Must not silently reset",
					},
					{ ...profile, systemPrompt: "changed profile" },
				),
			).rejects.toThrow("Retained AgentSession conversation could not be loaded");
		} finally {
			failedRead.mockRestore();
		}
		await runtime.dispose();
	}, 60_000);

	it("rebinds a deferred inbox item after restart and emits its wake once", async () => {
		const { runtime, cwd, options } = await createRuntime();
		await runtime.start(
			{
				commandId: "command-inbox-sender",
				agentInstanceId: "agent-inbox-sender",
				executionId: "execution-inbox-sender",
				attemptId: "attempt-inbox-sender",
				authorityGeneration: 1,
				cwd,
				input: "sender",
			},
			profile,
		);
		const recipient = await runtime.start(
			{
				commandId: "command-inbox-recipient-a",
				agentInstanceId: "agent-inbox-recipient",
				executionId: "execution-inbox-recipient-a",
				attemptId: "attempt-inbox-recipient-a",
				authorityGeneration: 1,
				cwd,
				input: "recipient",
			},
			profile,
		);
		await runtime.drain();
		expect(
			await runtime.deliverPeerMessage({
				messageId: "message-deferred-restart",
				fromAgentInstanceId: "agent-inbox-sender",
				toAgentInstanceId: "agent-inbox-recipient",
				body: "wake later",
			}),
		).toMatchObject({ outcome: "queued" });
		const [queued] = await runtime.listInbox(recipient);
		if (!queued) throw new Error("deferred inbox item was not queued");
		await runtime.mutateInbox(recipient, {
			mutationId: "defer-before-restart",
			queueId: queued.queueId,
			expectedRevision: queued.revision,
			op: "defer",
			value: Date.now() + 60_000,
		});
		await runtime.dispose();

		const restarted = await openRuntime(options);
		const wakes: string[] = [];
		expect((await restarted.listInbox(recipient))[0]).toMatchObject({ queueId: queued.queueId, revision: 2 });
		expect(await restarted.readInbox(recipient, queued.queueId)).toMatchObject({ deliveryPayload: "wake later" });
		await expect(restarted.listInbox({ ...recipient, authorityGeneration: 2 })).rejects.toMatchObject({
			code: "stale_target",
		});
		await restarted.mutateInbox(recipient, {
			mutationId: "edit-after-restart",
			queueId: queued.queueId,
			expectedRevision: 2,
			op: "edit",
			value: "edited before resuming",
		});
		expect(await restarted.sessionContext(recipient)).toMatchObject({ status: "not_ready", context: null });
		expect(await restarted.sessionUsage(recipient)).toMatchObject({
			status: "not_ready",
			local: null,
			provider: { status: "unavailable" },
		});
		expect(restarted.getBinding(recipient.agentInstanceId)).toBeUndefined();
		restarted.subscribe(event => {
			if (event.kind === "inbox_changed" && event.payload?.action === "wake_due")
				wakes.push(event.eventId.toString());
		});
		const resumed = await restarted.start(
			{
				commandId: "command-inbox-recipient-b",
				agentInstanceId: "agent-inbox-recipient",
				executionId: "execution-inbox-recipient-b",
				attemptId: "attempt-inbox-recipient-b",
				authorityGeneration: 1,
				cwd,
				input: "resume recipient",
				explicitContinue: true,
				expectedIntentRevision: (await restarted.store.intent(recipient.agentInstanceId)).intentRevision,
			},
			profile,
		);
		const [rebound] = await restarted.listInbox(resumed);
		if (!rebound) throw new Error("rebound inbox item was not retained");
		expect(rebound).toMatchObject({
			queueId: "message-deferred-restart",
			attemptId: "attempt-inbox-recipient-b",
			revision: 3,
		});
		await restarted.mutateInbox(resumed, {
			mutationId: "defer-after-restart-rebind",
			queueId: rebound.queueId,
			expectedRevision: rebound.revision,
			op: "defer",
			value: Date.now() + 50,
		});
		for (let remaining = 50; wakes.length === 0 && remaining > 0; remaining--) await Bun.sleep(50);
		await Bun.sleep(150);
		expect(wakes).toHaveLength(1);
		expect(resumed.sessionFile).toBe(recipient.sessionFile);
		expect((await restarted.listInbox(recipient))[0]).toMatchObject({
			queueId: "message-deferred-restart",
			attemptId: "attempt-inbox-recipient-b",
			revision: 5,
		});
		expect((await restarted.listInbox(resumed))[0]).toMatchObject({
			queueId: "message-deferred-restart",
			attemptId: "attempt-inbox-recipient-b",
			wakeIntent: true,
			revision: 5,
			deliveryPayload: "edited before resuming",
		});
		await restarted.dispose();
	}, 60_000);

	it("holds a formerly unheld durable queue after restart until an explicit Continue", async () => {
		const { runtime, cwd, options } = await createRuntime();
		const started = await runtime.start(
			{
				commandId: "command-released-wake",
				agentInstanceId: "agent-released-wake",
				executionId: "execution-released-wake",
				attemptId: "attempt-released-wake",
				authorityGeneration: 1,
				cwd,
				input: "complete before restart",
			},
			profile,
		);
		await runtime.drain();
		const queued = await runtime.enqueueInbox(started, {
			sourceEventId: "ordinary-released-wake",
			sourceType: "user",
			body: "continue after restart",
			createdAt: Date.now(),
			deliverAt: Date.now() + 250,
			wakeIntent: true,
		});
		const priorGeneration = runtime.engineGeneration;
		await runtime.dispose();

		const restarted = await openRuntime(options);
		const wakes: EngineEvent[] = [];
		restarted.subscribe(event => {
			if (event.kind === "inbox_changed" && event.payload?.action === "wake_due") wakes.push(event);
		});
		await Bun.sleep(350);
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

	it("starts one new Attempt from an immediate ordinary queue wake after the active Attempt settles", async () => {
		const firstPrompt = Promise.withResolvers<boolean>();
		const inputs: string[] = [];
		const { runtime, cwd } = await createRuntime(async (_session, input) => {
			inputs.push(input);
			return inputs.length === 1 ? await firstPrompt.promise : true;
		});
		const started = await runtime.start(
			{
				commandId: "command-auto-queue-a",
				agentInstanceId: "agent-auto-queue",
				executionId: "execution-auto-queue-a",
				attemptId: "attempt-auto-queue-a",
				authorityGeneration: 1,
				cwd,
				input: "first",
			},
			profile,
		);
		const wakes: EngineEvent[] = [];
		runtime.subscribe(event => {
			if (event.kind === "inbox_changed" && event.payload?.action === "wake_due") wakes.push(event);
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
		await Bun.sleep(100);
		expect(wakes).toHaveLength(0);

		firstPrompt.resolve(true);
		await runtime.drain();
		for (let remaining = 50; wakes.length === 0 && remaining > 0; remaining--) await Bun.sleep(25);
		expect(wakes[0]?.payload).toEqual({
			action: "wake_due",
			queueId: queued.item.queueId,
			revision: 2,
			intentRevision: started.intentRevision,
			manualHold: false,
		});
		const intervening = await runtime.start(
			{
				commandId: "command-auto-queue-intervening",
				agentInstanceId: started.agentInstanceId,
				executionId: "execution-auto-queue-intervening",
				attemptId: "attempt-auto-queue-intervening",
				authorityGeneration: 1,
				cwd,
				input: "intervening direct Send",
			},
			profile,
		);
		await expect(
			runtime.start(
				{
					commandId: "command-auto-queue-old-wake",
					agentInstanceId: started.agentInstanceId,
					executionId: "execution-auto-queue-old-wake",
					attemptId: "attempt-auto-queue-old-wake",
					authorityGeneration: 1,
					cwd,
					queueId: queued.item.queueId,
					expectedRevision: 2,
					mutationId: "wake:ordinary-auto-queue:2",
					expectedIntentRevision: started.intentRevision,
				},
				profile,
			),
		).rejects.toMatchObject({ code: "stale_target" });
		await runtime.drain();
		for (let remaining = 50; wakes.length < 2 && remaining > 0; remaining--) await Bun.sleep(25);
		expect(wakes[1]?.payload).toMatchObject({
			queueId: queued.item.queueId,
			revision: 3,
			intentRevision: intervening.intentRevision,
		});
		const next = await runtime.start(
			{
				commandId: "command-auto-queue-b",
				agentInstanceId: started.agentInstanceId,
				executionId: "execution-auto-queue-b",
				attemptId: "attempt-auto-queue-b",
				authorityGeneration: 1,
				cwd,
				queueId: queued.item.queueId,
				expectedRevision: 3,
				mutationId: "wake:ordinary-auto-queue:3",
				expectedIntentRevision: intervening.intentRevision,
			},
			profile,
		);
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
		expect(nextEvents.slice(0, 3).map(event => event.kind)).toEqual(["inbox_changed", "accepted", "running"]);
		await runtime.drain();
		for (let remaining = 50; wakes.length < 3 && remaining > 0; remaining--) await Bun.sleep(25);
		expect(wakes).toHaveLength(3);
		expect(wakes[2]?.payload).toMatchObject({
			queueId: queuedSecond.item.queueId,
			revision: 2,
			intentRevision: next.intentRevision,
		});
		const third = await runtime.start(
			{
				commandId: "command-auto-queue-c",
				agentInstanceId: started.agentInstanceId,
				executionId: "execution-auto-queue-c",
				attemptId: "attempt-auto-queue-c",
				authorityGeneration: 1,
				cwd,
				queueId: queuedSecond.item.queueId,
				expectedRevision: 2,
				mutationId: "wake:ordinary-auto-queue-second:2",
				expectedIntentRevision: next.intentRevision,
			},
			profile,
		);
		expect(third.queueRevision).toBe(3);
		await runtime.drain();
		expect(inputs).toEqual([
			"first",
			"intervening direct Send",
			"queued canonical body",
			"second queued canonical body",
		]);
		expect(await runtime.store.getInboxItem(queued.item.sessionId, queued.item.queueId)).toMatchObject({
			disposition: "acknowledged",
			revision: 4,
		});
		expect(await runtime.store.getInboxItem(queuedSecond.item.sessionId, queuedSecond.item.queueId)).toMatchObject({
			disposition: "acknowledged",
			revision: 3,
		});
		await expect(
			runtime.start(
				{
					commandId: "command-auto-queue-stale",
					agentInstanceId: started.agentInstanceId,
					executionId: "execution-auto-queue-stale",
					attemptId: "attempt-auto-queue-stale",
					authorityGeneration: 1,
					cwd,
					queueId: queued.item.queueId,
					expectedRevision: 2,
					mutationId: "wake:ordinary-auto-queue:2",
					expectedIntentRevision: started.intentRevision,
				},
				profile,
			),
		).rejects.toMatchObject({ code: "stale_target" });
		await runtime.dispose();
	}, 60_000);

	it("allows only read-only inbox access through an exact historical target for the same session", async () => {
		const { runtime, cwd, options } = await createRuntime();
		const prior = await runtime.start(
			{
				commandId: "command-historical-inbox-a",
				agentInstanceId: "agent-historical-inbox",
				executionId: "execution-historical-inbox-a",
				attemptId: "attempt-historical-inbox-a",
				authorityGeneration: 1,
				cwd,
				input: "first",
			},
			profile,
		);
		await runtime.drain();
		const queued = await runtime.enqueueInbox(prior, {
			sourceEventId: "historical-inbox-source",
			sourceType: "user",
			body: "queued for the next Attempt",
			createdAt: Date.now(),
			wakeIntent: true,
		});
		let wake: EngineEvent | undefined;
		for (let remaining = 50; !wake && remaining > 0; remaining--) {
			wake = (await runtime.store.pendingEvents()).find(
				event =>
					event.kind === "inbox_changed" &&
					event.payload?.action === "wake_due" &&
					event.payload?.queueId === queued.item.queueId,
			);
			if (!wake) await Bun.sleep(25);
		}
		if (!wake) throw new Error("Historical inbox wake was not claimed");
		const current = await runtime.start(
			{
				commandId: "command-historical-inbox-b",
				agentInstanceId: prior.agentInstanceId,
				executionId: "execution-historical-inbox-b",
				attemptId: "attempt-historical-inbox-b",
				authorityGeneration: 1,
				cwd,
				queueId: queued.item.queueId,
				expectedRevision: Number(wake.payload?.revision),
				mutationId: `wake:${queued.item.queueId}:${wake.payload?.revision}`,
				expectedIntentRevision: prior.intentRevision!,
			},
			profile,
		);
		await runtime.drain();

		expect(await runtime.listInbox(prior, true)).toContainEqual(
			expect.objectContaining({
				queueId: queued.item.queueId,
				sourceEventId: "historical-inbox-source",
				disposition: "acknowledged",
				revision: 3,
			}),
		);
		expect(await runtime.readInbox(prior, queued.item.queueId)).toMatchObject({
			sourceEventId: "historical-inbox-source",
			disposition: "acknowledged",
			revision: 3,
		});

		await expect(
			runtime.enqueueInbox(prior, {
				sourceEventId: "historical-write-rejected",
				sourceType: "user",
				body: "must not enqueue",
				createdAt: Date.now(),
			}),
		).rejects.toMatchObject({ code: "stale_target" });
		await expect(
			runtime.mutateInbox(prior, {
				mutationId: "historical-mutation-rejected",
				queueId: queued.item.queueId,
				expectedRevision: 3,
				op: "drop",
			}),
		).rejects.toMatchObject({ code: "stale_target" });
		await expect(runtime.reorderInbox(prior, "historical-reorder-rejected", [], [])).rejects.toMatchObject({
			code: "stale_target",
		});

		const tamperedTargets = [
			{ target: { ...prior, agentInstanceId: "agent-historical-inbox-other" }, code: "agent_not_found" },
			{ target: { ...prior, executionId: "execution-historical-inbox-other" }, code: "stale_target" },
			{ target: { ...prior, attemptId: current.attemptId }, code: "stale_target" },
			{ target: { ...prior, bindingId: "binding-historical-inbox-other" }, code: "stale_target" },
			{ target: { ...prior, engineGeneration: prior.engineGeneration + 1 }, code: "stale_target" },
			{ target: { ...prior, bindingGeneration: prior.bindingGeneration + 1 }, code: "stale_target" },
			{ target: { ...prior, authorityGeneration: prior.authorityGeneration + 1 }, code: "stale_target" },
		];
		for (const { target, code } of tamperedTargets) {
			await expect(runtime.listInbox(target, true)).rejects.toMatchObject({ code });
		}

		await runtime.dispose();
		const restarted = await openRuntime(options);
		expect(await restarted.listInbox(prior, true)).toContainEqual(
			expect.objectContaining({
				queueId: queued.item.queueId,
				sourceEventId: "historical-inbox-source",
				disposition: "acknowledged",
			}),
		);
		expect(await restarted.readInbox(prior, queued.item.queueId)).toMatchObject({
			sourceEventId: "historical-inbox-source",
			disposition: "acknowledged",
		});
		await expect(
			restarted.mutateInbox(prior, {
				mutationId: "historical-retained-mutation-rejected",
				queueId: queued.item.queueId,
				expectedRevision: 3,
				op: "drop",
			}),
		).rejects.toMatchObject({ code: "stale_target" });

		const fresh = await restarted.start(
			{
				commandId: "command-historical-inbox-fresh",
				agentInstanceId: prior.agentInstanceId,
				executionId: "execution-historical-inbox-fresh",
				attemptId: "attempt-historical-inbox-fresh",
				authorityGeneration: 1,
				cwd,
				input: "fresh session",
			},
			{ ...profile, continuationPolicy: "fresh" },
		);
		await restarted.drain();
		expect(fresh.sessionFile).not.toBe(current.sessionFile);
		await expect(restarted.listInbox(prior, true)).rejects.toMatchObject({ code: "stale_target" });
		await restarted.dispose();
	}, 60_000);

	it("reopens a transcript only across an exact continuation identity", async () => {
		let dependencyDigest = "dependency-a";
		const priorUserMessages = new Map<string, string[]>();
		const enabledTools = new Map<string, string[]>();
		const { runtime, cwd } = await createRuntime(
			async (session, input) => {
				// A carried fork holds only the working context; its archive is not materialized.
				priorUserMessages.set(
					input,
					session.sessionManager
						.getContextBranch()
						.flatMap(entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							typeof entry.message.content === "string"
								? [entry.message.content]
								: [],
						),
				);
				enabledTools.set(input, session.getEnabledToolNames());
				session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
				return true;
			},
			{
				resolveSessionContinuation: async () => dependencyDigest,
				resolveSessionProfile: async (_profile, sessionCwd) => ({
					options: { settings: await Settings.loadReadOnly({ cwd: sessionCwd }) },
					dispose() {},
				}),
			},
		);
		const request = {
			agentInstanceId: "agent-exact-continuation",
			agentInstanceRef: "grimoire://tasks/project-a/task-a/agents/agent-exact-continuation",
			authorityGeneration: 1,
			cwd,
		};
		const start = (suffix: string, overrides: Partial<EngineStartRequest> = {}, launch = profile) =>
			runtime.start(
				{
					...request,
					...overrides,
					commandId: `command-exact-${suffix}`,
					executionId: `execution-exact-${suffix}`,
					attemptId: `attempt-exact-${suffix}`,
					input: suffix,
				},
				launch,
			);

		const firstProfile = { ...profile, toolNames: ["read"], restrictToolNames: true };
		const secondProfile = {
			...profile,
			profileDigest: "leaf-profile-v2",
			toolNames: ["glob"],
			restrictToolNames: true,
		};
		const first = await start("first", {}, firstProfile);
		await runtime.drain();
		const same = await start("same", {}, firstProfile);
		await runtime.drain();
		expect(same.sessionFile).toBe(first.sessionFile);
		expect(priorUserMessages.get("same")).toEqual(["first"]);

		const profileChanged = await start("profile", {}, secondProfile);
		await runtime.drain();
		expect(profileChanged.sessionFile).not.toBe(same.sessionFile);
		expect(priorUserMessages.get("profile")).toEqual(["first", "same"]);
		expect(enabledTools.get("profile")).toContain("glob");
		expect(enabledTools.get("profile")).not.toContain("read");
		const queued = await runtime.enqueueInbox(profileChanged, {
			sourceEventId: "profile-change-pending-queue",
			sourceType: "user",
			body: "queued across the profile change",
			createdAt: Date.now(),
			wakeIntent: true,
		});
		const stopped = await runtime.cancel({
			...profileChanged,
			commandId: "command-profile-hold",
			expectedIntentRevision: profileChanged.intentRevision,
		});
		expect(stopped).toMatchObject({ manualHold: true });

		dependencyDigest = "dependency-b";
		const dependencyChanged = await start(
			"dependency",
			{ expectedIntentRevision: stopped.intentRevision, explicitContinue: true },
			secondProfile,
		);
		await runtime.drain();
		expect(dependencyChanged.sessionFile).not.toBe(profileChanged.sessionFile);
		expect(priorUserMessages.get("dependency")).toEqual(["first", "same", "profile"]);
		expect(enabledTools.get("dependency")).toContain("glob");
		expect(enabledTools.get("dependency")).not.toContain("read");
		expect(dependencyChanged.manualHold).toBe(false);
		expect(await runtime.readInbox(dependencyChanged, queued.item.queueId)).toMatchObject({
			sourceEventId: "profile-change-pending-queue",
			disposition: "pending",
		});

		await expect(start("parent", { parentAgentInstanceId: "parent-agent-b" }, secondProfile)).rejects.toMatchObject({
			code: "stale_target",
		});
		expect(priorUserMessages.has("parent")).toBe(false);
		expect((await runtime.store.getBinding(dependencyChanged.agentInstanceId))?.sessionFile).toBe(
			dependencyChanged.sessionFile,
		);
		await runtime.store.registerAgent({
			agentInstanceId: "parent-agent-b",
			agentInstanceRef: "grimoire://tasks/project-b/task-b/agents/parent-agent-b",
			authorityGeneration: 1,
		});

		const projectRef = "grimoire://tasks/project-b/task-b/agents/agent-exact-continuation";
		await expect(
			start(
				"project-alias",
				{ agentInstanceRef: projectRef, parentAgentInstanceId: "parent-agent-b" },
				secondProfile,
			),
		).rejects.toMatchObject({ code: "stale_target" });
		const projectAgentInstanceId = "agent-new-project";
		const projectChanged = await start(
			"project",
			{
				agentInstanceId: projectAgentInstanceId,
				agentInstanceRef: projectRef,
				parentAgentInstanceId: "parent-agent-b",
			},
			secondProfile,
		);
		await runtime.drain();
		expect(projectChanged.sessionFile).not.toBe(dependencyChanged.sessionFile);
		expect(priorUserMessages.get("project")).toEqual([]);

		const authorityChanged = await start(
			"authority",
			{
				agentInstanceId: projectAgentInstanceId,
				agentInstanceRef: projectRef,
				parentAgentInstanceId: "parent-agent-b",
				authorityGeneration: 2,
			},
			secondProfile,
		);
		await runtime.drain();
		expect(authorityChanged.sessionFile).not.toBe(projectChanged.sessionFile);
		expect(priorUserMessages.get("authority")).toEqual([]);

		const otherCwd = path.join(path.dirname(cwd), "workspace-b");
		fs.mkdirSync(otherCwd);
		const cwdChanged = await start(
			"cwd",
			{
				agentInstanceId: projectAgentInstanceId,
				agentInstanceRef: projectRef,
				parentAgentInstanceId: "parent-agent-b",
				authorityGeneration: 2,
				cwd: otherCwd,
			},
			secondProfile,
		);
		await runtime.drain();
		expect(cwdChanged.sessionFile).not.toBe(authorityChanged.sessionFile);
		expect(priorUserMessages.get("cwd")).toEqual([]);

		const fresh = await start(
			"fresh-a",
			{
				agentInstanceId: projectAgentInstanceId,
				agentInstanceRef: projectRef,
				parentAgentInstanceId: "parent-agent-b",
				authorityGeneration: 2,
				cwd: otherCwd,
			},
			{ ...secondProfile, continuationPolicy: "fresh" },
		);
		await runtime.drain();
		const freshAgain = await start(
			"fresh-b",
			{
				agentInstanceId: projectAgentInstanceId,
				agentInstanceRef: projectRef,
				parentAgentInstanceId: "parent-agent-b",
				authorityGeneration: 2,
				cwd: otherCwd,
			},
			{ ...secondProfile, continuationPolicy: "fresh" },
		);
		await runtime.drain();
		expect(freshAgain.sessionFile).not.toBe(fresh.sessionFile);
		expect(priorUserMessages.get("fresh-b")).toEqual([]);
		await runtime.dispose();
	}, 60_000);

	it("removes only an uncommitted carried transcript when a pending start is cancelled", async () => {
		const { runtime, cwd, options } = await createRuntime(async (session, input) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
			return true;
		});
		const first = await runtime.start(
			{
				commandId: "command-carry-cancel-first",
				agentInstanceId: "agent-carry-cancel",
				agentInstanceRef: "grimoire://tasks/project/task/agents/agent-carry-cancel",
				executionId: "execution-carry-cancel-first",
				attemptId: "attempt-carry-cancel-first",
				authorityGeneration: 1,
				cwd,
				input: "retained before cancelled profile change",
			},
			profile,
		);
		await runtime.drain();
		const stopped = await runtime.cancel({
			...first,
			commandId: "command-carry-cancel-hold",
			expectedIntentRevision: first.intentRevision,
		});
		const queued = await runtime.enqueueInbox(first, {
			sourceEventId: "carry-cancel-pending-inbox",
			sourceType: "user",
			body: "remain pending on the retained session",
			createdAt: Date.now(),
			wakeIntent: true,
		});
		if (!first.sessionFile) throw new Error("Expected the retained session file");
		const command = {
			commandId: "command-carry-cancel-second",
			operation: "start" as const,
			deviceId: "device-carry-cancel",
			engineId: "engine-carry-cancel",
			engineGeneration: runtime.engineGeneration,
			agentInstanceId: first.agentInstanceId,
			agentInstanceRef: "grimoire://tasks/project/task/agents/agent-carry-cancel",
			executionId: "execution-carry-cancel-second",
			attemptId: "attempt-carry-cancel-second",
			authorityGeneration: 1,
			payloadHash: "sha256:carry-cancel-payload",
			canonicalHash: "sha256:carry-cancel-command",
		};
		expect(await runtime.store.admitCommand(command, runtime.engineGeneration)).toEqual({ status: "claimed" });

		const forkStarted = Promise.withResolvers<void>();
		const releaseFork = Promise.withResolvers<void>();
		const forkNativeContext = SessionManager.forkNativeContext.bind(SessionManager);
		let forkPath: string | undefined;
		const blockedWrite = spyOn(SessionManager, "forkNativeContext").mockImplementation(async (...args) => {
			forkStarted.resolve();
			await releaseFork.promise;
			const forked = await forkNativeContext(...args);
			forkPath = forked.getSessionFile();
			return forked;
		});
		const next = {
			commandId: command.commandId,
			agentInstanceId: first.agentInstanceId,
			agentInstanceRef: command.agentInstanceRef,
			executionId: command.executionId,
			attemptId: command.attemptId,
			authorityGeneration: command.authorityGeneration,
			cwd,
			input: "must be cancelled before admission",
			explicitContinue: true,
			expectedIntentRevision: stopped.intentRevision,
		};
		try {
			const start = runtime.start(next, { ...profile, systemPrompt: "changed profile" });
			await forkStarted.promise;
			const cancelled = await runtime.cancelPendingStart({
				commandId: "command-carry-cancel-stop",
				agentInstanceId: next.agentInstanceId,
				executionId: next.executionId,
				attemptId: next.attemptId,
				authorityGeneration: next.authorityGeneration,
				engineGeneration: runtime.engineGeneration,
				expectedIntentRevision: stopped.intentRevision,
			});
			expect(cancelled).toMatchObject({ phase: "applied", preStart: true, manualHold: true });
			releaseFork.resolve();
			await expect(start).rejects.toMatchObject({ code: "stale_target" });
		} finally {
			releaseFork.resolve();
			blockedWrite.mockRestore();
		}

		expect(forkPath).toBeDefined();
		expect(forkPath).not.toBe(first.sessionFile);
		expect(JSON.stringify((await retainedEntries(runtime, first.sessionFile)).entries)).toContain(
			"retained before cancelled profile change",
		);
		expect(await runtime.store.getBinding(first.agentInstanceId)).toMatchObject({
			sessionFile: first.sessionFile,
			state: "released",
			manualHold: true,
		});
		expect(await runtime.store.getAttempt(next.attemptId)).toBeUndefined();
		expect(await runtime.store.getInboxItem(queued.item.sessionId, queued.item.queueId)).toMatchObject({
			sessionId: queued.item.sessionId,
			disposition: "pending",
		});
		// A later processor generation replays the durable rejection instead of starting the cancelled command.
		await runtime.dispose();
		const restarted = await openRuntime(options);
		expect(await restarted.store.admitCommand(command, restarted.engineGeneration)).toMatchObject({
			status: "replay",
			receipt: { outcome: "rejected", detail: { code: "cancelled" } },
		});
	}, 60_000);

	it("aborts profile resolution only after a pending Start is durably cancelled", async () => {
		const resolutionStarted = Promise.withResolvers<AbortSignal>();
		const releaseResolution = Promise.withResolvers<void>();
		let promptCalls = 0;
		let disposeCalls = 0;
		const { runtime, cwd, options } = await createRuntime(
			async () => {
				promptCalls += 1;
				return true;
			},
			{
				resolveSessionProfile: async (_launch, _cwd, signal) => {
					if (!signal) throw new Error("Expected pending Start signal");
					resolutionStarted.resolve(signal);
					await releaseResolution.promise;
					return {
						options: {},
						dispose() {
							disposeCalls += 1;
						},
					};
				},
			},
		);
		const command = {
			commandId: "command-cancel-profile-resolution",
			operation: "start" as const,
			deviceId: "device-cancel-profile-resolution",
			engineId: "engine-cancel-profile-resolution",
			engineGeneration: runtime.engineGeneration,
			agentInstanceId: "agent-cancel-profile-resolution",
			agentInstanceRef: "grimoire://tasks/project/task/agents/agent-cancel-profile-resolution",
			executionId: "execution-cancel-profile-resolution",
			attemptId: "attempt-cancel-profile-resolution",
			authorityGeneration: 1,
			payloadHash: "sha256:cancel-profile-resolution-payload",
			canonicalHash: "sha256:cancel-profile-resolution-command",
			principalId: "owner-profile-cancellation",
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		expect(await runtime.store.admitCommand(command, runtime.engineGeneration)).toEqual({ status: "claimed" });
		const start = runtime.start(
			{
				commandId: command.commandId,
				agentInstanceId: command.agentInstanceId,
				agentInstanceRef: command.agentInstanceRef,
				executionId: command.executionId,
				attemptId: command.attemptId,
				authorityGeneration: command.authorityGeneration,
				cwd,
				input: "must never reach the model",
				expectedIntentRevision: 0,
			},
			profile,
		);
		const signal = await resolutionStarted.promise;
		expect(signal.aborted).toBeFalse();

		const cancelled = await runtime.cancelPendingStart({
			commandId: "command-stop-profile-resolution",
			agentInstanceId: command.agentInstanceId,
			executionId: command.executionId,
			attemptId: command.attemptId,
			authorityGeneration: command.authorityGeneration,
			engineGeneration: runtime.engineGeneration,
			reason: "cancel provider material lookup",
			expectedIntentRevision: 0,
			pendingStartCommandId: command.commandId,
			expectedStartIntentRevision: 0,
			principalId: command.principalId,
		});

		expect(cancelled).toMatchObject({ phase: "applied", preStart: true, manualHold: true });
		expect(signal.aborted).toBeTrue();
		releaseResolution.resolve();
		await expect(start).rejects.toThrow("cancel provider material lookup");
		expect(disposeCalls).toBe(1);
		expect(promptCalls).toBe(0);
		expect(runtime.getBinding(command.agentInstanceId)).toBeUndefined();
		expect(await runtime.store.getAttempt(command.attemptId)).toBeUndefined();
		expect(
			(await runtime.store.pendingEvents()).filter(
				event =>
					event.attemptId === command.attemptId &&
					(event.kind.startsWith("model_") || event.kind.startsWith("tool_")),
			),
		).toEqual([]);
		await runtime.dispose();
		const restarted = await openRuntime(options);
		expect(await restarted.store.admitCommand(command, restarted.engineGeneration)).toMatchObject({
			status: "replay",
			receipt: { outcome: "rejected", detail: { code: "cancelled" } },
		});
	}, 60_000);

	it("applies a Stop compiled before Start binding using only the persisted source revision", async () => {
		const release = Promise.withResolvers<void>();
		const { runtime, cwd } = await createRuntime(async () => {
			await release.promise;
			return true;
		});
		const command = {
			commandId: "start-bound-race",
			operation: "start" as const,
			deviceId: "device",
			engineId: "engine",
			engineGeneration: runtime.engineGeneration,
			agentInstanceId: "agent-bound-race",
			agentInstanceRef: "grimoire://tasks/project/task/agents/bound-race",
			principalId: "owner",
			executionId: "execution-bound-race",
			attemptId: "attempt-bound-race",
			authorityGeneration: 1,
			payloadHash: "payload",
			canonicalHash: "canonical",
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		try {
			await runtime.store.admitCommand(command, runtime.engineGeneration);
			const started = await runtime.start({ ...command, cwd, input: "active", expectedIntentRevision: 0 }, profile);
			expect(started.intentRevision).toBe(1);
			const result = await runtime.cancelPendingStart({
				...command,
				commandId: "stop-bound-race",
				pendingStartCommandId: command.commandId,
				expectedStartIntentRevision: 0,
				expectedIntentRevision: 0,
			});
			expect(result).toMatchObject({ manualHold: true, intentRevision: 2 });
			expect((await runtime.store.getAttempt(command.attemptId))?.state).toBe("cancel_requested");
		} finally {
			release.resolve();
			await runtime.drain();
			await runtime.dispose();
		}
	}, 60_000);

	for (const op of ["cancel", "pause"] as const) {
		it(`holds a completed Attempt when a revision-fenced ${op} arrives before its queued wake starts`, async () => {
			const { runtime, cwd, options } = await createRuntime();
			const started = await runtime.start(
				{
					commandId: "command-a",
					agentInstanceId: "agent-a",
					executionId: "execution-a",
					attemptId: "attempt-a",
					authorityGeneration: 1,
					cwd,
					input: "A",
				},
				profile,
			);
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
			for (let remaining = 50; !wake && remaining > 0; remaining--) {
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
			expect(await runtime.store.getAttempt(started.attemptId)).toEqual(completedAttempt);
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
			await expect(
				runtime.start(
					{
						commandId: "stale-wake-after-terminal-stop",
						agentInstanceId: started.agentInstanceId,
						executionId: "execution-stale-wake-after-stop",
						attemptId: "attempt-stale-wake-after-stop",
						authorityGeneration: 1,
						cwd,
						queueId: queued.item.queueId,
						expectedRevision: 2,
						mutationId: "wake:queued-after-completion-boundary:2",
						expectedIntentRevision: started.intentRevision,
					},
					profile,
				),
			).rejects.toMatchObject({ code: "stale_target" });
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
				const sent = await restarted.start(
					{
						commandId: "send-after-terminal-hold",
						agentInstanceId: started.agentInstanceId,
						executionId: "execution-after-terminal-hold",
						attemptId: "attempt-after-terminal-hold",
						authorityGeneration: started.authorityGeneration,
						cwd,
						input: "manual release",
						expectedIntentRevision: recoveredIntent.intentRevision,
						explicitContinue: true,
					},
					profile,
				);
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

		it(`rejects a terminal ${op} after a newer Send advances the AgentInstance intent`, async () => {
			const { runtime, cwd } = await createRuntime();
			const first = await runtime.start(
				{
					commandId: "command-terminal-stop-old",
					agentInstanceId: "agent-terminal-stop-newer-send",
					executionId: "execution-terminal-stop-old",
					attemptId: "attempt-terminal-stop-old",
					authorityGeneration: 1,
					cwd,
					input: "first",
				},
				profile,
			);
			await runtime.drain();
			const newer = await runtime.start(
				{
					commandId: "command-terminal-stop-newer",
					agentInstanceId: first.agentInstanceId,
					executionId: "execution-terminal-stop-newer",
					attemptId: "attempt-terminal-stop-newer",
					authorityGeneration: 1,
					cwd,
					input: "newer",
					expectedIntentRevision: first.intentRevision,
				},
				profile,
			);
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

	it("attributes parent-driven cancellation to the start command that owns the Attempt", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const { runtime, cwd } = await createRuntime(() => prompt.promise);
		const events: Array<{ kind: string; causationCommandId: string }> = [];
		runtime.subscribe(event => {
			events.push(event);
		});
		await runtime.start(
			{
				commandId: "command-parent-owned",
				agentInstanceId: "agent-parent-owned",
				executionId: "execution-parent-owned",
				attemptId: "attempt-parent-owned",
				authorityGeneration: 1,
				cwd,
				input: "wait",
			},
			profile,
		);
		await runtime.cancelAgentInstance("agent-parent-owned", "parent aborted");
		prompt.resolve(true);
		await runtime.drain();
		expect(events.find(event => event.kind === "cancelled")?.causationCommandId).toBe("command-parent-owned");
		await runtime.dispose();
	}, 60000);

	for (const action of ["pause", "stop"] as const) {
		it(`applies parent ${action} while an enrolled child is still resolving its profile`, async () => {
			const resolving = Promise.withResolvers<AbortSignal>();
			const releaseProfile = Promise.withResolvers<void>();
			const parentPrompt = Promise.withResolvers<boolean>();
			const prompts: string[] = [];
			let resolutions = 0;
			const { runtime, cwd } = await createRuntime(
				async (_session, input) => {
					prompts.push(input);
					return input === "parent work" ? parentPrompt.promise : true;
				},
				{
					resolveSessionProfile: async (_launch, _cwd, signal) => {
						if (resolutions++ === 0) return { options: {}, dispose() {} };
						if (!signal) throw new Error("Child Start must have cancellation");
						resolving.resolve(signal);
						const blocked = Promise.withResolvers<void>();
						const abort = () => blocked.reject(signal.reason);
						signal.addEventListener("abort", abort, { once: true });
						try {
							await Promise.race([releaseProfile.promise, blocked.promise]);
						} finally {
							signal.removeEventListener("abort", abort);
						}
						return { options: {}, dispose() {} };
					},
				},
			);
			const parent = await runtime.start(
				{
					commandId: `branch-${action}-parent-start`,
					agentInstanceId: `branch-${action}-parent`,
					agentInstanceRef: `grimoire://tasks/p/t/agents/branch-${action}-parent`,
					executionId: `branch-${action}-parent-execution`,
					attemptId: `branch-${action}-parent-attempt`,
					authorityGeneration: 1,
					cwd,
					input: "parent work",
				},
				profile,
			);
			const childRequest: EngineStartRequest = {
				commandId: `branch-${action}-child-start`,
				agentInstanceId: `branch-${action}-child`,
				agentInstanceRef: `grimoire://tasks/p/t/agents/branch-${action}-child`,
				parentAgentInstanceId: parent.agentInstanceId,
				executionId: `branch-${action}-child-execution`,
				attemptId: `branch-${action}-child-attempt`,
				authorityGeneration: 1,
				cwd,
				input: "child work",
			};
			const child = runtime.start(childRequest, profile).then(
				value => ({ value }),
				error => ({ error }),
			);
			const signal = await resolving.promise;
			const childPaused = nextEngineEvent(runtime, "paused", childRequest.attemptId);
			const control =
				action === "pause"
					? runtime.pause({
							...parent,
							commandId: "parent-pause-during-child-profile",
							initiator: { kind: "human" },
						})
					: runtime.cancel({ ...parent, commandId: "parent-stop-during-child-profile" });
			try {
				const result = await withTimeout(control, 2000, "Parent control waited for child profile");
				expect(result.manualHold).toBe(true);
				expect((await runtime.store.intent(childRequest.agentInstanceId)).manualHold).toBe(true);
				if (action === "stop") {
					expect(signal.aborted).toBe(true);
					expect(await child).toHaveProperty("error");
					expect(await runtime.store.getAttempt(childRequest.attemptId)).toBeUndefined();
				} else {
					expect(signal.aborted).toBe(false);
					releaseProfile.resolve();
					expect(await child).toHaveProperty("value");
					await withTimeout(childPaused, 2000, "Held child did not become quiescent");
					expect((await runtime.store.getAttempt(childRequest.attemptId))?.state).toBe("paused");
				}
				expect(prompts).toEqual(["parent work"]);
				if (action === "pause") {
					const childCompleted = nextEngineEvent(runtime, "completed", childRequest.attemptId);
					parentPrompt.resolve(true);
					await runtime.resume({ ...parent, commandId: "resume-held-new-child", initiator: { kind: "human" } });
					await withTimeout(childCompleted, 2000, "Resumed child did not execute");
					expect(prompts).toEqual(["parent work", "child work"]);
				}
			} finally {
				releaseProfile.resolve();
				parentPrompt.resolve(true);
				await Promise.allSettled([child, control]);
				await runtime.dispose();
			}
		}, 15000);
	}
	it("cancels pending profile resolution before waiting for shutdown lanes", async () => {
		const resolving = Promise.withResolvers<AbortSignal>();
		const releaseProfile = Promise.withResolvers<void>();
		let dispatched = false;
		const { runtime, cwd } = await createRuntime(
			async () => {
				dispatched = true;
				return true;
			},
			{
				resolveSessionProfile: async (_launch, _cwd, signal) => {
					if (!signal) throw new Error("Start must have cancellation");
					resolving.resolve(signal);
					const aborted = Promise.withResolvers<void>();
					const abort = () => aborted.reject(signal.reason);
					signal.addEventListener("abort", abort, { once: true });
					try {
						await Promise.race([releaseProfile.promise, aborted.promise]);
					} finally {
						signal.removeEventListener("abort", abort);
					}
					return { options: {}, dispose() {} };
				},
			},
		);
		const pending = runtime
			.start(
				{
					commandId: "shutdown-profile-start",
					agentInstanceId: "shutdown-profile-agent",
					executionId: "shutdown-profile-execution",
					attemptId: "shutdown-profile-attempt",
					authorityGeneration: 1,
					cwd,
					input: "work",
				},
				profile,
			)
			.then(
				value => ({ value }),
				error => ({ error }),
			);
		const signal = await resolving.promise;
		const disposed = runtime.dispose({ closeStore: false });
		try {
			await withTimeout(disposed, 2000, "Shutdown waited for pending profile resolution");
			expect(signal.aborted).toBeTrue();
			expect(await pending).toHaveProperty("error");
			expect(dispatched).toBeFalse();
			expect(await runtime.store.getAttempt("shutdown-profile-attempt")).toBeUndefined();
		} finally {
			releaseProfile.resolve();
			await Promise.allSettled([pending, disposed]);
			await runtime.store.close();
		}
	}, 15000);

	it("disposes a newborn held child while its effect admission is returning", async () => {
		const parentPrompt = Promise.withResolvers<boolean>();
		const parentDispatched = Promise.withResolvers<void>();
		const busyReached = Promise.withResolvers<void>();
		const returnBusy = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const { runtime, cwd } = await createRuntime(async (_session, input) => {
			prompts.push(input);
			if (input !== "parent work") return true;
			parentDispatched.resolve();
			return parentPrompt.promise;
		});
		const parent = await runtime.start(
			{
				commandId: "dispose-held-parent-start",
				agentInstanceId: "dispose-held-parent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/dispose-held-parent",
				executionId: "dispose-held-parent-execution",
				attemptId: "dispose-held-parent-attempt",
				authorityGeneration: 1,
				cwd,
				input: "parent work",
			},
			profile,
		);
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
			const child = await runtime.start(
				{
					commandId: "dispose-held-child-start",
					agentInstanceId: "dispose-held-child",
					agentInstanceRef: "grimoire://tasks/p/t/agents/dispose-held-child",
					parentAgentInstanceId: parent.agentInstanceId,
					executionId: "dispose-held-child-execution",
					attemptId: "dispose-held-child-attempt",
					authorityGeneration: 1,
					cwd,
					input: "child work",
				},
				profile,
			);
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
		const { runtime, cwd } = await createRuntime(async (_session, input) => {
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
			const started = await runtime.start(
				{
					commandId: "parked-admission-start",
					agentInstanceId: "parked-admission-agent",
					agentInstanceRef: "grimoire://tasks/p/t/agents/parked-admission-agent",
					executionId: "parked-admission-execution",
					attemptId: "parked-admission-attempt",
					authorityGeneration: 1,
					cwd,
					input: "parked work",
				},
				profile,
			);
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

	for (const action of ["pause", "stop"] as const) {
		it(`keeps nested TaskTool waits quiescent under parent ${action} while an independent root completes`, async () => {
			const leafEntered = Promise.withResolvers<void>();
			const releaseLeaf = Promise.withResolvers<void>();
			const siblingEntered = Promise.withResolvers<void>();
			const releaseSibling = Promise.withResolvers<void>();
			const waitsReady = Promise.withResolvers<void>();
			const waiting = new Set<string>();
			const results: Array<{ agent: string; attemptId?: string; state: string; payload: Record<string, unknown> }> =
				[];
			const ref = (name: string) => `grimoire://tasks/grimoire/nested-wait/agents/${action}-${name}`;
			const requestFor = (name: string, cwd: string, parentAgentInstanceId?: string): EngineStartRequest => ({
				commandId: `${action}-${name}-start`,
				agentInstanceId: engineAgentInstanceId(ref(name)),
				agentInstanceRef: ref(name),
				parentAgentInstanceId,
				executionId: `${action}-${name}-execution`,
				attemptId: `${action}-${name}-attempt`,
				authorityGeneration: 1,
				cwd,
				input: `nested-${name}-work`,
			});
			const parentProfile: EngineLaunchProfile = {
				...profile,
				spawns: "*",
				maxSpawnDepth: 2,
				maxChildren: 1,
				childProfileRefs: ["gctx:2222222222222222"],
				toolNames: ["task"],
				restrictToolNames: true,
			};
			const mock = createMockModel({
				handler: async (context, options) => {
					const user = context.messages.find(message => message.role === "user");
					const input =
						typeof user?.content === "string"
							? user.content
							: (user?.content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("") ?? "");
					for (const name of ["root", "middle"]) {
						if (!input.includes(`nested-${name}-work`)) continue;
						if (context.messages.some(message => message.role === "toolResult"))
							return { content: [`${name}-result-after-child`] };
						return {
							content: [
								{
									type: "toolCall",
									id: `${name}-wait`,
									name: "task",
									arguments: {
										profileRef: "gctx:2222222222222222",
										workStepId: name === "root" ? "middle" : "leaf",
										assignment: name === "root" ? "middle" : "leaf",
									},
								},
							],
						};
					}
					if (input.includes("nested-leaf-work")) {
						leafEntered.resolve();
						const abort = () => releaseLeaf.resolve();
						options?.signal?.addEventListener("abort", abort, { once: true });
						try {
							await releaseLeaf.promise;
							options?.signal?.throwIfAborted();
							return { content: ["leaf-exact-result"] };
						} finally {
							options?.signal?.removeEventListener("abort", abort);
						}
					}
					if (!input.includes("nested-sibling-work")) throw new Error("Unexpected nested fixture input");
					siblingEntered.resolve();
					await releaseSibling.promise;
					return { content: ["independent-sibling-result"] };
				},
			});
			let runtimeRef: EngineRuntime;
			const { runtime, cwd } = await createRuntime(
				(session, input, identity) => session.prompt(input, identity),
				{
					resolveSessionProfile: async () => ({
						options: {},
						childProfiles: [{ profileRef: "gctx:2222222222222222", displayName: "Nested worker" }],
						dispose() {},
					}),
					launchChild: async request => {
						const child = requestFor(request.assignment, request.cwd, request.parentAgentInstanceId);
						await request.enrollChild(child.agentInstanceRef!, child.attemptId);
						await runtimeRef.start(
							child,
							request.maxSpawnDepth > 0 ? { ...parentProfile, maxSpawnDepth: request.maxSpawnDepth } : profile,
						);
						waiting.add(request.assignment);
						if (waiting.size === 2) waitsReady.resolve();
						try {
							const result = await runtimeRef.store.waitAttemptResult(
								child.agentInstanceId,
								child.commandId,
								child.attemptId,
								request.signal,
							);
							results.push({ agent: request.assignment, ...result });
							return {
								agentInstanceId: child.agentInstanceId,
								agentInstanceRef: child.agentInstanceRef,
								status:
									result.state === "completed"
										? "completed"
										: result.state === "cancelled"
											? "cancelled"
											: "failed",
								assistantFinal: String(result.payload.assistantFinal ?? ""),
							};
						} catch (error) {
							if (!request.signal?.aborted) throw error;
							return {
								agentInstanceId: child.agentInstanceId,
								status: "cancelled",
								error: "Parent task aborted",
							};
						} finally {
							waiting.delete(request.assignment);
						}
					},
				},
				{ model: mock.model },
			);
			runtimeRef = runtime;
			try {
				const root = await runtime.start(requestFor("root", cwd), parentProfile);
				await withTimeout(
					Promise.all([leafEntered.promise, waitsReady.promise]),
					5000,
					"Nested TaskTool waits did not enroll",
				);
				const middle = runtime.getBinding(engineAgentInstanceId(ref("middle")))!;
				const leaf = runtime.getBinding(engineAgentInstanceId(ref("leaf")))!;
				expect(runtime.agentRegistry.get(root.engineAgentId)?.session?.isStreaming).toBeTrue();
				expect(runtime.agentRegistry.get(middle.engineAgentId)?.session?.isStreaming).toBeTrue();
				const leafPaused = nextEngineEvent(runtime, "paused", leaf.attemptId);
				await runtime.pause({ ...leaf, commandId: "leaf-own-pause", initiator: { kind: "human" } });
				releaseLeaf.resolve();
				await withTimeout(leafPaused, 5000, "Leaf did not reach its own safe pause");
				expect(waiting.size).toBe(2);
				expect(results).toHaveLength(0);
				const sibling = await runtime.start(requestFor("sibling", cwd), profile);
				await withTimeout(siblingEntered.promise, 5000, "Independent root did not enter provider");
				if (action === "pause") {
					const paused = Promise.all([
						nextEngineEvent(runtime, "paused", root.attemptId),
						nextEngineEvent(runtime, "paused", middle.attemptId),
					]);
					await runtime.pause({ ...root, commandId: "nested-parent-pause", initiator: { kind: "human" } });
					await withTimeout(paused, 5000, "Nested waits prevented parent quiescence");
					expect(waiting.size).toBe(2);
					expect(results).toHaveLength(0);
				} else {
					await runtime.cancel({ ...root, commandId: "nested-parent-stop" });
				}
				releaseSibling.resolve();
				const siblingResult = await withTimeout(
					runtime.store.waitAttemptResult(sibling.agentInstanceId, `${action}-sibling-start`, sibling.attemptId),
					5000,
					"Held branch blocked independent root",
				);
				expect(siblingResult).toMatchObject({
					attemptId: sibling.attemptId,
					state: "completed",
					payload: { assistantFinal: "independent-sibling-result" },
				});
				expect((await runtime.store.intent(sibling.agentInstanceId)).manualHold).toBeFalse();
				if (action === "pause") {
					expect((await runtime.store.getAttempt(root.attemptId))?.state).toBe("paused");
					await runtime.resume({ ...root, commandId: "nested-parent-resume", initiator: { kind: "human" } });
					const ownHold = await runtime.store.intent(leaf.agentInstanceId);
					expect(ownHold.holds.map(hold => hold.commandId)).toEqual(["leaf-own-pause"]);
					expect((await runtime.store.getAttempt(leaf.attemptId))?.state).toBe("paused");
					expect(waiting.size).toBe(2);
					await runtime.resume({
						...leaf,
						commandId: "leaf-own-resume",
						initiator: { kind: "human" },
						expectedIntentRevision: ownHold.intentRevision,
					});
				}
				await withTimeout(runtime.drain(), 5000, "Nested task waits did not finish after explicit release/Stop");
				for (const [name, target] of [
					["root", root],
					["middle", middle],
					["leaf", leaf],
				] as const) {
					const result = await runtime.store.waitAttemptResult(
						target.agentInstanceId,
						`${action}-${name}-start`,
						target.attemptId,
					);
					expect(result).toMatchObject({
						attemptId: target.attemptId,
						state: action === "pause" ? "completed" : "cancelled",
					});
					if (action === "pause")
						expect(result.payload.assistantFinal).toBe(
							name === "leaf" ? "leaf-exact-result" : `${name}-result-after-child`,
						);
					else expect((await runtime.store.intent(target.agentInstanceId)).manualHold).toBeTrue();
				}
				expect(waiting.size).toBe(0);
				if (action === "pause") {
					expect(results.map(result => [result.agent, result.attemptId, result.payload.assistantFinal])).toEqual([
						["leaf", leaf.attemptId, "leaf-exact-result"],
						["middle", middle.attemptId, "middle-result-after-child"],
					]);
				}
				expect(
					(await runtime.store.pendingEvents()).filter(
						event =>
							event.agentInstanceId === sibling.agentInstanceId &&
							["pause_requested", "paused", "cancelled"].includes(event.kind),
					),
				).toHaveLength(0);
			} finally {
				releaseLeaf.resolve();
				releaseSibling.resolve();
				await runtime.dispose();
			}
		}, 20000);
	}

	it("pauses and resumes the same child Attempt without waking its parent", async () => {
		const prompts = new Map<string, PromiseWithResolvers<boolean>>();
		const { runtime, cwd } = await createRuntime(session => {
			const prompt = Promise.withResolvers<boolean>();
			const agentId = session.getAgentId();
			if (!agentId) throw new Error("Engine test session has no agent id");
			prompts.set(agentId, prompt);
			return prompt.promise;
		});
		const parent = await runtime.start(
			{
				commandId: "command-parent",
				agentInstanceId: "parent-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/parent-agent",
				executionId: "execution-parent",
				attemptId: "attempt-parent",
				authorityGeneration: 1,
				cwd,
				input: "wait for children",
			},
			profile,
		);
		const parentSession = runtime.agentRegistry.get(parent.engineAgentId)?.session;
		if (!parentSession) throw new Error("parent session is unavailable");
		let parentSessionEvents = 0;
		parentSession.subscribe(() => parentSessionEvents++);

		const sources: EngineControlInitiator[] = [
			{ kind: "human" },
			{
				kind: "agent",
				agentInstanceId: "controller-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/controller-agent",
			},
		];
		for (const [index, initiator] of sources.entries()) {
			const child = await runtime.start(
				{
					commandId: `command-child-${index}`,
					agentInstanceId: `child-agent-${index}`,
					agentInstanceRef: `grimoire://tasks/p/t/agents/child-agent-${index}`,
					parentAgentInstanceId: "parent-agent",
					executionId: `execution-child-${index}`,
					attemptId: `attempt-child-${index}`,
					authorityGeneration: 1,
					cwd,
					input: "work",
				},
				profile,
			);
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

	it("rejects queued steer while held and only explicit Resume releases the same Attempt", async () => {
		const promptStarted = Promise.withResolvers<void>();
		const prompt = Promise.withResolvers<boolean>();
		const delivered: string[] = [];
		const { runtime, cwd } = await createRuntime(async session => {
			session.steer = async message => {
				delivered.push(message);
			};
			promptStarted.resolve();
			return prompt.promise;
		});
		try {
			const started = await runtime.start(
				{
					commandId: "held-steer-start",
					agentInstanceId: "held-steer-agent",
					executionId: "held-steer-execution",
					attemptId: "held-steer-attempt",
					authorityGeneration: 1,
					cwd,
					input: "work",
				},
				profile,
			);
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

	it("fences a Stop racing Resume by the current intent and rejects delayed controls", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const { runtime, cwd } = await createRuntime(() => prompt.promise);
		try {
			const started = await runtime.start(
				{
					commandId: "paused-cancel-start",
					agentInstanceId: "paused-cancel-agent",
					executionId: "paused-cancel-execution",
					attemptId: "paused-cancel-attempt",
					authorityGeneration: 1,
					cwd,
					input: "wait",
				},
				profile,
			);
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

	it("keeps a stopped AgentInstance held across restart until a revision-fenced new Send", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const { runtime, cwd, options } = await createRuntime(() => prompt.promise);
		const started = await runtime.start(
			{
				commandId: "command-held-before-restart",
				agentInstanceId: "agent-held-before-restart",
				executionId: "execution-held-before-restart",
				attemptId: "attempt-held-before-restart",
				authorityGeneration: 1,
				cwd,
				input: "wait",
			},
			profile,
		);
		const paused = nextEngineEvent(runtime, "paused");
		const pauseResult = await runtime.pause({
			...started,
			commandId: "pause-held-before-restart",
			initiator: { kind: "human" },
			expectedIntentRevision: started.intentRevision,
		});
		prompt.resolve(true);
		await paused;

		const wakeAt = Date.now() + 250;
		const pending = await runtime.enqueueInbox(started, {
			sourceEventId: "held-wake-item",
			sourceType: "user",
			body: "deliver after explicit Send",
			createdAt: Date.now(),
			deliverAt: wakeAt,
			wakeIntent: true,
		});
		const dropped = await runtime.enqueueInbox(started, {
			sourceEventId: "held-drop-item",
			sourceType: "user",
			body: "drop without resuming",
			createdAt: Date.now(),
		});
		const mutationEvents: EngineEvent[] = [];
		runtime.subscribe(event => {
			if (event.kind === "inbox_changed") mutationEvents.push(event);
		});
		await runtime.mutateInbox(started, {
			mutationId: "edit-held-item",
			queueId: pending.item.queueId,
			expectedRevision: pending.item.revision,
			op: "edit",
			value: "edited while held",
		});
		await runtime.mutateInbox(started, {
			mutationId: "edit-held-item",
			queueId: pending.item.queueId,
			expectedRevision: pending.item.revision,
			op: "edit",
			value: "edited while held",
		});
		await runtime.reorderInbox(
			started,
			"reorder-held-items",
			[pending.item.queueId, dropped.item.queueId],
			[dropped.item.queueId, pending.item.queueId],
		);
		await runtime.reorderInbox(
			started,
			"reorder-held-items",
			[pending.item.queueId, dropped.item.queueId],
			[dropped.item.queueId, pending.item.queueId],
		);
		await runtime.mutateInbox(started, {
			mutationId: "drop-held-item",
			queueId: dropped.item.queueId,
			expectedRevision: dropped.item.revision + 1,
			op: "drop",
		});
		await Bun.sleep(25);
		expect(mutationEvents.map(event => event.payload?.action)).toEqual(["edit", "reorder", "drop"]);
		expect(mutationEvents.some(event => event.payload?.action === "wake_due")).toBeFalse();
		expect(runtime.getBinding(started.agentInstanceId)).toMatchObject({
			manualHold: true,
			intentRevision: pauseResult.intentRevision,
		});

		const cancelResult = await runtime.cancel({
			...started,
			commandId: "stop-held-before-restart",
			expectedIntentRevision: pauseResult.intentRevision,
		});
		await runtime.drain();
		await runtime.dispose();

		const restarted = await openRuntime(options);
		const wakes: EngineEvent[] = [];
		restarted.subscribe(event => {
			if (event.kind === "inbox_changed" && event.payload?.action === "wake_due") wakes.push(event);
		});
		await Bun.sleep(Math.max(0, wakeAt - Date.now()) + 150);
		expect(wakes).toHaveLength(0);
		const recoveredIntent = await restarted.store.intent(started.agentInstanceId);
		expect(recoveredIntent.holds.some(hold => hold.kind === "recovery")).toBeTrue();
		expect(recoveredIntent.intentRevision).toBe(cancelResult.intentRevision + 1);
		expect(await restarted.store.getBinding(started.agentInstanceId)).toMatchObject({
			manualHold: true,
			intentRevision: recoveredIntent.intentRevision,
		});

		const staleRequest = {
			commandId: "explicit-send-after-restart",
			agentInstanceId: started.agentInstanceId,
			executionId: "execution-after-restart",
			attemptId: "attempt-after-restart",
			authorityGeneration: 1,
			cwd,
			input: "continue",
		};
		await expect(restarted.start(staleRequest, profile)).rejects.toMatchObject({ code: "agent_busy" });
		const retainedPending = await restarted.store.getInboxItem(pending.item.sessionId, pending.item.queueId);
		expect(retainedPending).toMatchObject({
			disposition: "pending",
			revision: pending.item.revision + 2,
		});
		expect(retainedPending?.wakeDeliveredAt).toBeUndefined();
		const nextRequest = {
			commandId: "explicit-queue-send-after-restart",
			agentInstanceId: started.agentInstanceId,
			executionId: "execution-queue-after-restart",
			attemptId: "attempt-queue-after-restart",
			authorityGeneration: 1,
			cwd,
			queueId: pending.item.queueId,
			expectedRevision: retainedPending!.revision,
			mutationId: "consume-held-after-restart",
			expectedIntentRevision: recoveredIntent.intentRevision,
			explicitContinue: true,
		};
		const resumed = await restarted.start(nextRequest, profile);
		expect(resumed).toMatchObject({
			manualHold: false,
			intentRevision: recoveredIntent.intentRevision + 1,
			queueId: pending.item.queueId,
			queueRevision: retainedPending!.revision + 1,
		});
		expect(await restarted.start(nextRequest, profile)).toMatchObject({ duplicate: true });
		expect(wakes).toHaveLength(0);
		const consumed = await restarted.store.getInboxItem(pending.item.sessionId, pending.item.queueId);
		expect(consumed).toMatchObject({
			deliveryPayload: "edited while held",
			disposition: "acknowledged",
			revision: retainedPending!.revision + 1,
		});
		expect(consumed?.wakeDeliveredAt).toBeUndefined();
		expect(await restarted.store.getInboxItem(dropped.item.sessionId, dropped.item.queueId)).toMatchObject({
			disposition: "dropped",
		});
		await restarted.dispose();
	}, 60000);

	it("does not redispatch a durable Attempt after Engine restart", async () => {
		let dispatchCount = 0;
		const { runtime, cwd, options } = await createRuntime(async () => {
			dispatchCount++;
			return true;
		});
		const request = {
			commandId: "command-a",
			agentInstanceId: "agent-a",
			executionId: "execution-a",
			attemptId: "attempt-a",
			authorityGeneration: 1,
			cwd,
			input: "A",
		};
		await runtime.start(request, profile);
		await runtime.drain();
		await runtime.dispose();

		const restarted = await openRuntime(options);
		const duplicate = await restarted.start(request, profile);
		expect(duplicate.duplicate).toBeTrue();
		expect(duplicate.state).toBe("released");
		expect(dispatchCount).toBe(1);
		await restarted.dispose();
	}, 60000);

	it("interrupts active, paused and approval-waiting Attempts before closing the store", async () => {
		const pausedDispatch = Promise.withResolvers<boolean>();
		const activeDispatch = Promise.withResolvers<boolean>();
		const { runtime, cwd } = await createRuntime(async (session, input) => {
			switch (input) {
				case "wait": {
					const abort = session.abort.bind(session);
					session.abort = async options => {
						activeDispatch.resolve(false);
						return await abort(options);
					};
					return await activeDispatch.promise;
				}
				case "pause":
					return await pausedDispatch.promise;
				case "read": {
					const read = session.getToolByName("read");
					if (!read) throw new Error("read tool is unavailable");
					await read.execute("read-shutdown-permit", { path: "shutdown.txt" });
					return true;
				}
				default:
					throw new Error("unexpected shutdown test agent");
			}
		}, {});
		fs.writeFileSync(path.join(cwd, "shutdown.txt"), "must not be read");
		try {
			const modelStarted = nextEngineEvent(runtime, "model_started");
			await runtime.start(
				{
					commandId: "command-shutdown-active",
					agentInstanceId: "agent-shutdown-active",
					executionId: "execution-shutdown-active",
					attemptId: "attempt-shutdown-active",
					authorityGeneration: 1,
					cwd,
					input: "wait",
				},
				profile,
			);
			await modelStarted;

			const paused = await runtime.start(
				{
					commandId: "command-shutdown-paused",
					agentInstanceId: "agent-shutdown-paused",
					executionId: "execution-shutdown-paused",
					attemptId: "attempt-shutdown-paused",
					authorityGeneration: 1,
					cwd,
					input: "pause",
				},
				profile,
			);
			const pauseFinished = nextEngineEvent(runtime, "paused");
			await runtime.pause({ ...paused, commandId: "pause-for-shutdown", initiator: { kind: "human" } });
			pausedDispatch.resolve(true);
			await pauseFinished;

			const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
			await runtime.start(
				{
					commandId: "command-shutdown-approval",
					agentInstanceId: "agent-shutdown-approval",
					executionId: "execution-shutdown-approval",
					attemptId: "attempt-shutdown-approval",
					authorityGeneration: 1,
					cwd,
					input: "read",
				},
				{ ...profile, toolPolicies: { read: "permit" } },
			);
			const approvalId = String((await approvalRequested).payload?.approvalId);

			await runtime.dispose({ closeStore: false });
			for (const attemptId of ["attempt-shutdown-active", "attempt-shutdown-paused", "attempt-shutdown-approval"]) {
				expect(await runtime.store.getAttempt(attemptId)).toMatchObject({ state: "interrupted" });
			}
			const events = await runtime.store.pendingEvents();
			expect(
				events
					.filter(event => event.kind === "interrupted")
					.map(event => event.attemptId)
					.sort(),
			).toEqual(["attempt-shutdown-active", "attempt-shutdown-approval", "attempt-shutdown-paused"]);
			expect(await runtime.store.getApproval(approvalId)).toMatchObject({
				state: "resolved",
				decision: "cancelled",
			});
		} finally {
			await runtime.store.close();
		}
	}, 60_000);

	it("rejects steering after an Attempt becomes idle", async () => {
		const { runtime, cwd } = await createRuntime();
		const started = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		await runtime.drain();
		await expect(runtime.steer({ ...started, commandId: "steer-1", message: "too late" })).rejects.toMatchObject({
			code: "too_late",
		});
		await runtime.dispose();
	}, 60000);

	it("admits repeated cancel before owner jobs quiesce and publishes one terminal cancellation after", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const job = Promise.withResolvers<string>();
		let jobSettled = false;
		const { runtime, cwd } = await createRuntime(() => prompt.promise);
		const started = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		runtime.asyncJobManager.register(
			"bash",
			"slow cancellation",
			async () => {
				const result = await job.promise;
				jobSettled = true;
				return result;
			},
			{ ownerId: started.engineAgentId, attemptId: started.attemptId },
		);

		await runtime.cancel({ ...started, commandId: "cancel-a" });
		await runtime.cancel({ ...started, commandId: "cancel-a" });
		expect(jobSettled).toBeFalse();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancel_requested");
		job.resolve("stopped");
		prompt.resolve(true);
		await runtime.drain();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const cancelledEvents = (await runtime.store.pendingEvents()).filter(event => event.kind === "cancelled");
		expect(cancelledEvents.map(event => event.causationCommandId)).toEqual(["cancel-a"]);
		expect(cancelledEvents.map(event => event.payload?.transcriptRef)).toEqual([
			`history://${started.engineAgentId}`,
		]);
		await runtime.dispose();
	}, 60000);

	it("waits for attempt jobs before publishing the bounded final result", async () => {
		const job = Promise.withResolvers<string>();
		const fullFinal = `${"x".repeat(48_001)}FULL-TRANSCRIPT-TAIL`;
		const { runtime, cwd } = await createRuntime(async session => {
			Object.defineProperty(session, "getLastAssistantText", { value: () => fullFinal });
			Object.defineProperty(session, "messages", {
				value: [{ role: "assistant", content: [{ type: "text", text: fullFinal }] }],
			});
			const jobId = runtime.asyncJobManager.register("task", "child", () => job.promise, {
				ownerId: session.getAgentId(),
				attemptId: session.getAttemptId(),
			});
			runtime.asyncJobManager.watchJobs([jobId]);
			return true;
		});
		const started = await runtime.start(
			{
				commandId: "command-final",
				agentInstanceId: "agent-final",
				executionId: "execution-final",
				attemptId: "attempt-final",
				authorityGeneration: 1,
				cwd,
				input: "finish",
			},
			profile,
		);
		await Bun.sleep(10);
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		job.resolve("done");
		await runtime.drain();
		const completed = (await runtime.store.pendingEvents()).find(event => event.kind === "completed");
		expect(completed?.payload).toMatchObject({
			assistantFinal: `${fullFinal.slice(0, 48_000)}\n[…truncated]`,
			transcriptRef: `history://${started.engineAgentId}`,
			outputTruncated: true,
			transcriptCheckpoint: {
				sessionId: expect.any(String),
				sessionPath: expect.any(String),
				leafEntryId: expect.any(String),
				byteBoundary: expect.any(Number),
				revision: 2,
			},
		});
		const completedAttempt = await runtime.store.getAttempt(started.attemptId);
		expect(completedAttempt).toMatchObject({
			state: "completed",
			transcript_session_id: expect.any(String),
			transcript_path: expect.any(String),
			transcript_leaf_entry_id: expect.any(String),
			transcript_byte_boundary: expect.any(Number),
			transcript_revision: 2,
		});
		const history = await InternalUrlRouter.instance().resolve(String(completed?.payload?.transcriptRef), {
			agentRegistry: runtime.agentRegistry,
			engineMode: true,
		});
		expect(history.content).toContain("FULL-TRANSCRIPT-TAIL");
		await runtime.dispose();
	}, 60000);

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
			],
		});
		const { runtime, cwd } = await createRuntime(
			(session, input) => {
				prompts.push(input);
				expect(session.getToolByName("yield")).toBeDefined();
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		);
		const first = await runtime.start(
			{
				commandId: "command-yield-a",
				agentInstanceId: "agent-yield",
				executionId: "execution-yield-a",
				attemptId: "attempt-yield-a",
				authorityGeneration: 1,
				cwd,
				input: "finish A",
			},
			{ ...profile, requireYieldTool: true, outputSchema: { type: "object" } },
		);
		await runtime.drain();
		const firstEvents = await runtime.store.pendingEvents();
		expect(
			firstEvents.find(event => event.kind === "completed" && event.attemptId === first.attemptId)?.payload,
		).toMatchObject({ assistantFinal: '{"assignment":"A","ok":true}' });

		const second = await runtime.start(
			{
				commandId: "command-yield-b",
				agentInstanceId: "agent-yield",
				executionId: "execution-yield-b",
				attemptId: "attempt-yield-b",
				authorityGeneration: 1,
				cwd,
				input: "finish B",
			},
			{ ...profile, requireYieldTool: true, outputSchema: { type: "object" } },
		);
		await runtime.drain();
		const secondEvents = (await runtime.store.pendingEvents()).filter(event => event.attemptId === second.attemptId);
		expect(secondEvents.find(event => event.kind === "completed")).toBeUndefined();
		expect(secondEvents.find(event => event.kind === "failed")?.payload).toMatchObject({
			error: "required_yield_not_submitted",
		});
		expect(prompts).toHaveLength(4);
		expect(prompts[2]).toContain("Call the yield tool now");
		expect(prompts[3]).toContain("Call the yield tool now");
		await runtime.dispose();
	}, 60000);

	it("does not accept aborted yield results as terminal success", async () => {
		const mock = createMockModel({
			responses: Array.from({ length: 3 }, (_, index) => ({
				content: [
					{
						type: "toolCall" as const,
						id: `yield-aborted-${index}`,
						name: "yield",
						arguments: { result: { error: `cannot finish ${index}` } },
					},
				],
			})),
		});
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		const started = await runtime.start(
			{
				commandId: "command-aborted-yield",
				agentInstanceId: "agent-aborted-yield",
				executionId: "execution-aborted-yield",
				attemptId: "attempt-aborted-yield",
				authorityGeneration: 1,
				cwd,
				input: "finish",
			},
			{ ...profile, requireYieldTool: true, outputSchema: { type: "object" } },
		);
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.attemptId === started.attemptId);
		expect(events.find(event => event.kind === "completed")).toBeUndefined();
		expect(events.find(event => event.kind === "failed")?.payload).toMatchObject({
			error: "required_yield_not_submitted",
		});
		await runtime.dispose();
	}, 60000);

	it("fails a required-yield attempt after two prose-only reminders", async () => {
		const prompts: string[] = [];
		const { runtime, cwd } = await createRuntime(async (_session, input) => {
			prompts.push(input);
			return true;
		});
		await runtime.start(
			{
				commandId: "command-missing-yield",
				agentInstanceId: "agent-missing-yield",
				executionId: "execution-missing-yield",
				attemptId: "attempt-missing-yield",
				authorityGeneration: 1,
				cwd,
				input: "finish",
			},
			{ ...profile, requireYieldTool: true, outputSchema: { type: "object" } },
		);
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
			const { runtime, cwd } = await createRuntime(async session => {
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
			const started = await runtime.start(
				{
					commandId: "command-provider-error",
					agentInstanceId: "agent-provider-error",
					executionId: "execution-provider-error",
					attemptId: "attempt-provider-error",
					authorityGeneration: 1,
					cwd,
					input: "fail",
				},
				profile,
			);
			await runtime.drain();
			const events = await runtime.store.pendingEvents();
			const modelEffectId = String(events.find(event => event.kind === "model_started")?.payload?.effectId);
			const modelEffect = await runtime.store.getEffect(modelEffectId);
			const history = await nativeHistory(runtime, started.agentInstanceId);
			expect(history.entries).toHaveLength(1);
			expect(history.entries[0]).toMatchObject({ role: "assistant", stopReason: "error" });
			expect(history.entries[0]).not.toHaveProperty("errorMessage");
			expect(JSON.stringify(history)).not.toContain("secretcredential");
			const paged = await runtime.sessionHistoryPage(
				started.agentInstanceId,
				"grimoire://tasks/grimoire/provider-error/agents/agent-provider-error",
				undefined,
				1,
			);
			expect(paged.entries[0]).toMatchObject({ entryId: history.entries[0]?.entryId, stopReason: "error" });
			await runtime.dispose();
			expect(events.find(event => event.kind === "completed")).toBeUndefined();
			const failed = events.find(event => event.kind === "failed");
			expect(JSON.stringify(failed?.payload)).not.toContain("secretcredential");
			expect(JSON.stringify(failed?.payload)).not.toContain("private.invalid");
			expect(failed?.payload?.error).toStartWith(`${publicReason} (diagnostic `);
			expect(failed?.payload).toMatchObject({
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

	it("keeps an Attempt nonterminal when transcript durability cannot be proven", async () => {
		const { runtime, cwd } = await createRuntime();
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
			const started = await runtime.start(
				{
					commandId: "command-flush-failure",
					agentInstanceId: "agent-flush-failure",
					executionId: "execution-flush-failure",
					attemptId: "attempt-flush-failure",
					authorityGeneration: 1,
					cwd,
					input: "finish",
				},
				profile,
			);
			await failedTwice.promise;
			await Bun.sleep(1);
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
		const { runtime, cwd } = await createRuntime();
		let flushCalls = 0;
		const originalFlush = SessionManager.prototype.flushAndCheckpoint;
		const flush = spyOn(SessionManager.prototype, "flushAndCheckpoint").mockImplementation(async function (
			this: SessionManager,
		) {
			if (++flushCalls === 1) return originalFlush.call(this);
			throw new StorageClientError("sequence_gap", "write does not follow accepted prefix");
		});
		try {
			const started = await runtime.start(
				{
					commandId: "command-rejected-write",
					agentInstanceId: "agent-rejected-write",
					executionId: "execution-rejected-write",
					attemptId: "attempt-rejected-write",
					authorityGeneration: 1,
					cwd,
					input: "finish",
				},
				profile,
			);
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

	it("survives a late stream capacity rejection but still dies on any other unhandled rejection", async () => {
		// A separate process: the contract is what the process-level rejection hook lets survive.
		const service = path.join(import.meta.dir, "../src/engine/service.ts");
		const run = async (reason: string) => {
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`const { isLateStreamCapacityRejection } = await import(${JSON.stringify(service)});
const { interceptUnhandledRejections } = await import("@oh-my-pi/pi-utils/postmortem");
const { StreamAdmissionError } = await import("@oh-my-pi/pi-ai/utils/stream-admission");
interceptUnhandledRejections(isLateStreamCapacityRejection);
Promise.reject(${reason});
await Bun.sleep(50);
console.log("alive");`,
				],
				{ cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
			);
			const out = await new Response(child.stdout).text();
			return { code: await child.exited, out };
		};
		expect(await run('new StreamAdmissionError("maxEvents")')).toEqual({ code: 0, out: "alive\n" });
		expect((await run('new Error("unrelated failure")')).code).not.toBe(0);
	}, 60000);

	it("preserves terminal child history by default and refuses explicit expiry policies", async () => {
		const starts = new Map<string, number>();
		const startAgent = async (runtime: EngineRuntime, cwd: string, id: string, input: string, child = true) => {
			if (child) {
				await runtime.store.registerAgent({
					agentInstanceId: "parent-agent",
					agentInstanceRef: "grimoire://tasks/grimoire/history-test/agents/parent-agent",
					authorityGeneration: 1,
				});
			}
			const sequence = (starts.get(id) ?? 0) + 1;
			starts.set(id, sequence);
			const request = {
				commandId: `command-${id}-${sequence}`,
				agentInstanceId: id,
				agentInstanceRef: `grimoire://tasks/grimoire/history-test/agents/${id}`,
				...(child ? { parentAgentInstanceId: "parent-agent" } : {}),
				executionId: `execution-${id}-${sequence}`,
				attemptId: `attempt-${id}-${sequence}`,
				authorityGeneration: 1,
				cwd,
				input,
			};
			await runtime.store.admitCommand(
				{
					...request,
					operation: "start",
					deviceId: "device-history",
					engineId: "engine-history",
					engineGeneration: runtime.engineGeneration,
					payloadHash: `sha256:payload-${id}`,
					canonicalHash: `sha256:canonical-${id}`,
				},
				runtime.engineGeneration,
			);
			await runtime.start(request, profile);
			await runtime.drain();
		};

		const recordPrompt: NonNullable<EngineRuntimeOptions["dispatchPrompt"]> = async (session, input, identity) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() }, identity);
			return true;
		};
		const cancelledPrompt = Promise.withResolvers<boolean>();
		const cancelledDispatched = Promise.withResolvers<void>();
		const preserved = await createRuntime(async (session, input, identity) => {
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() }, identity);
			if (input.startsWith("fail")) throw new Error("injected failed child");
			if (!input.startsWith("cancel")) return true;
			cancelledDispatched.resolve();
			return await cancelledPrompt.promise;
		});
		await startAgent(preserved.runtime, preserved.cwd, "child-local-failed", "fail but retain child history");
		await startAgent(preserved.runtime, preserved.cwd, "child-local-completed", "complete and retain child history");
		const cancelledRequest = {
			commandId: "command-child-local-cancelled-1",
			agentInstanceId: "child-local-cancelled",
			agentInstanceRef: "grimoire://tasks/grimoire/history-test/agents/child-local-cancelled",
			parentAgentInstanceId: "parent-agent",
			executionId: "execution-child-local-cancelled-1",
			attemptId: "attempt-child-local-cancelled-1",
			authorityGeneration: 1,
			cwd: preserved.cwd,
			input: "cancel but retain child history",
		};
		await preserved.runtime.store.admitCommand(
			{
				...cancelledRequest,
				operation: "start",
				deviceId: "device-history",
				engineId: "engine-history",
				engineGeneration: preserved.runtime.engineGeneration,
				payloadHash: "sha256:payload-child-local-cancelled",
				canonicalHash: "sha256:canonical-child-local-cancelled",
			},
			preserved.runtime.engineGeneration,
		);
		const cancelledStarted = await preserved.runtime.start(cancelledRequest, profile);
		// Stop the child mid-prompt; a Stop before model admission never dispatches the prompt at all.
		await withTimeout(cancelledDispatched.promise, 2000, "Cancelled child prompt was not dispatched");
		await preserved.runtime.cancel({ ...cancelledStarted, commandId: "cancel-child-local-cancelled" });
		cancelledPrompt.resolve(true);
		await preserved.runtime.drain();
		expect((await preserved.runtime.store.getAttempt("attempt-child-local-failed-1"))?.state).toBe("failed");
		expect((await preserved.runtime.store.getAttempt("attempt-child-local-completed-1"))?.state).toBe("completed");
		expect((await preserved.runtime.store.getAttempt("attempt-child-local-cancelled-1"))?.state).toBe("cancelled");
		await preserved.runtime.dispose();
		const preservedRestart = await openRuntime(preserved.options);
		expect(await preservedRestart.sweepExpiredChildHistory()).toEqual({
			expired: 0,
			archived: 0,
			deleted: 0,
			retained: 0,
		});
		expect(await nativeHistory(preservedRestart, "child-local-failed")).toMatchObject({
			entries: [{ role: "user", text: "fail but retain child history" }],
		});
		expect(await nativeHistory(preservedRestart, "child-local-completed")).toMatchObject({
			entries: [{ role: "user", text: "complete and retain child history" }],
		});
		expect(await nativeHistory(preservedRestart, "child-local-cancelled")).toMatchObject({
			entries: [{ role: "user", text: "cancel but retain child history" }],
		});
		await preservedRestart.dispose();

		// Expiring retained child history is deferred for native storage; explicit policies refuse.
		const local = await createRuntime(recordPrompt, { childHistoryRetention: "off" });
		await expect(local.runtime.sweepExpiredChildHistory()).rejects.toMatchObject({ code: "invalid_request" });
		await local.runtime.dispose();

		const correlated = await createRuntime(recordPrompt);
		const firstCorrelation = {
			commandId: "history-command-one",
			clientMessageId: "history-client-one",
			agentInstanceId: "history-correlated-agent",
			executionId: "history-execution-one",
			attemptId: "history-attempt-one",
			authorityGeneration: 1,
			cwd: correlated.cwd,
			input: "repeated text",
		};
		await correlated.runtime.start(firstCorrelation, profile);
		await correlated.runtime.drain();
		await correlated.runtime.start(
			{
				...firstCorrelation,
				commandId: "history-command-two",
				clientMessageId: "history-client-two",
				executionId: "history-execution-two",
				attemptId: "history-attempt-two",
			},
			profile,
		);
		await correlated.runtime.drain();
		await correlated.runtime.dispose();

		const correlatedRestart = await openRuntime(correlated.options);
		const correlatedHistory = await nativeHistory(correlatedRestart, "history-correlated-agent");
		expect(
			correlatedHistory.entries.map(entry => [entry.text, entry.sourceCommandId, entry.clientMessageId]),
		).toEqual([
			["repeated text", "history-command-one", "history-client-one"],
			["repeated text", "history-command-two", "history-client-two"],
		]);
		await correlatedRestart.dispose();

		const projection = await createRuntime(async session => {
			session.sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
			session.sessionManager.appendMessage({ role: "user", content: "", timestamp: Date.now() });
			session.sessionManager.appendMessage({ role: "user", content: "last", timestamp: Date.now() });
			return true;
		});
		await startAgent(projection.runtime, projection.cwd, "child-projection", "ignored");
		const history = await nativeHistory(projection.runtime, "child-projection");
		expect(history.entries.map(entry => entry.text)).toEqual(["first", "last"]);
		expect(history.entries[1]?.parentEntryId).toBe(history.entries[0]?.entryId);
		expect(history.leafEntryId).toBe(history.entries[1]?.entryId);
		await projection.runtime.dispose();
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
