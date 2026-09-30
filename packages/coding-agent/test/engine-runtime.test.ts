import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { defineCapability, loadCapability, registerProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { settings as ambientSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ApprovalDecision,
	EngineBindingGate,
	EngineBindingResult,
	EngineControlInitiator,
	EngineEvent,
	EngineExecutionConfiguration,
	EngineStartRequest,
	EngineTarget,
	WorkTarget,
} from "@oh-my-pi/pi-coding-agent/engine/contracts";
import { EngineTargetError, validateStartRequest } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import {
	EngineControlQueryClient,
	startEngineControlQueryServer,
	runEngineCommand,
} from "@oh-my-pi/pi-coding-agent/engine/control-query";
import {
	dispatchEngineCommand,
	type EngineCommandEnvelope,
	engineCommandIdentity,
} from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import { engineAgentId } from "@oh-my-pi/pi-coding-agent/engine/route";
import { EngineRuntime, type EngineRuntimeOptions } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import type { RocksAttempt, RocksCommand } from "@oh-my-pi/pi-coding-agent/engine/rocks-runtime-rows";
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
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { withOriginalAttachment } from "@oh-my-pi/pi-coding-agent/session/original-attachments";
import {
	parseNativeSessionLocator,
	RocksNativeSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/rocks-native-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StorageClientError, storageCanonicalJson } from "@oh-my-pi/pi-coding-agent/session/storage-client";
import { normalizeModelContextImages } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { resolveProviderCandidates } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { removeSyncWithRetries, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import { Database } from "bun:sqlite";
import type { ResolvedEngineExecution } from "@oh-my-pi/pi-coding-agent/engine/execution-resolver";
import type { Model } from "@oh-my-pi/pi-ai";
import { startStorageWorker, storageBlobsDir } from "./helpers/storage-worker-fixture";
import { semanticBinding } from "./helpers/runtime-v1-rocks-fixture";

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

	beforeAll(() => {
		registerMockApi("engine-runtime-test");
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-engine-runtime-shared-"));
		const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		auth.setRuntimeApiKey("mock", "test-key");
		modelRegistry = new ModelRegistry(auth, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
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

	const hash = (value: unknown) => `sha256:${Bun.SHA256.hash(storageCanonicalJson(value), "hex")}`;
	const spawnOff = { allowed: "no", max_depth: 0, max_children: 0, on_exceed: "deny" } as const;
	const unlimitedLimits = { timeout_seconds: null, max_iterations: null };

	/** Continuation configuration derived from one admitted dispatch; per-Start knobs live here. */
	function continuation(
		overrides: Partial<EngineExecutionConfiguration["continuationConfiguration"]> = {},
	): EngineExecutionConfiguration["continuationConfiguration"] {
		return {
			systemPrompt: "",
			toolNames: [],
			restrictToolNames: false,
			toolPolicies: {},
			enableMCP: false,
			enableLsp: false,
			lspShared: false,
			disabledCapabilityProviders: [],
			outputSchema: null,
			requireYieldTool: false,
			spawn: spawnOff,
			limits: unlimitedLimits,
			tools_permit: [],
			tools_on_request: "none",
			providerPromptCacheKey: null,
			...overrides,
		};
	}

	interface AdmittedExecutionFixture {
		config: EngineExecutionConfiguration;
		dispatchRef: string;
		dispatchHash: string;
		taskRef: string;
		receipts: Map<string, EngineCommandEnvelope>;
		decisions: Map<string, ApprovalDecision>;
		setModelOverride(override: Record<string, unknown>): void;
		optionsFor(runtimeOptions: Pick<EngineRuntimeOptions, "deviceId" | "sessionDefaults">): Pick<
			EngineRuntimeOptions,
			"deviceId" | "resolveExecution" | "verifyOriginReceipt" | "verifyApprovalReceipt"
		>;
	}

	/**
	 * One admitted typed execution for an ordinary Agent on a Task: a frozen single-route roster
	 * materialized locally by the test resolver, origin receipts captured per Start command, and
	 * canonical instruction_sources. Mirrors the common native proof fixture without reading it.
	 */
	function admittedExecution(
		model: Model,
		options: {
			taskRef?: string;
			continuation?: Partial<EngineExecutionConfiguration["continuationConfiguration"]>;
			spawn?: EngineExecutionConfiguration["dispatch"]["spawn"];
			continuationPolicy?: "exact" | "fresh";
			fallbackModel?: { provider: string; id: string } | null;
		} = {},
	) {
		const taskRef = options.taskRef ?? "grimoire://tasks/grimoire/runtime-test";
		const dispatchRef = "gctx:cccccccccccccccc";
		const primaryRouteRef = "gctx:bbbbbbbbbbbbbbbb";
		const fallbackRouteRef = options.fallbackModel ? "gctx:dddddddddddddddd" : primaryRouteRef;
		type FixtureRoute = EngineExecutionConfiguration["routes"]["routes"][number];
		const route = (routeRef: string, modelId: string, provider: string): FixtureRoute => ({
			model_id: modelId, route_ref: routeRef, account_ref: "gctx:aaaaaaaaaaaaaaaa",
			effort: "none", service_tier: "standard", billing_pool_id: "engine-runtime-test-pool",
			billing_pool_basis: "expected", tier: 0, provider_id: provider, quota_window_ids: [],
			shadow_cost: null, price_source: "unknown", estimated: false, record_revisions: {},
			provider, modelId, billing_pools: [], quota_windows: [],
			execution: {
				api: "openai-completions",
				base_url: model.api === "mock" ? "http://127.0.0.1:1/v1" : model.baseUrl ?? "http://127.0.0.1:1/v1",
				provider_model_id: modelId,
				context_window: model.contextWindow ?? 200_000,
				max_output_tokens: model.maxTokens ?? 8_192,
				input_modalities: ["text"] as ["text"],
				supports_tools: true, supports_reasoning: false, header_refs: [], compat: null,
				route_content_hash: hash({ route: routeRef }), account_content_hash: hash({ account: routeRef }),
				display_name: `Engine runtime test route ${routeRef}`, efforts: ["none"] as ["none"], trusted: true,
				credential: { method: "none", local_ref: null, hosted_ref: null, generation: 1 },
				account_binding_id: null,
			},
			family: null, tags: [], efforts: ["none"] as ["none"], hard_quota_window_ids: [], order_match: null,
		});
		const routes: EngineExecutionConfiguration["routes"]["routes"] = [route(primaryRouteRef, model.id, model.provider)];
		if (options.fallbackModel)
			routes.push(route(fallbackRouteRef, options.fallbackModel.id, options.fallbackModel.provider));
		const spawn = options.spawn ?? spawnOff;
		const config: EngineExecutionConfiguration = {
			dispatch: {
				schema: "grimoire.dispatch.v2", execution_kind: "ordinary", special_ref: null,
				dispatch_id: "engine-runtime-test-dispatch",
				target: { task_ref: taskRef, work_step_id: null },
				prompt: "Engine runtime test", instructions: "", skill_refs: [],
				display_name: null, preset: null, tools: null, tools_permit: [],
				tools_on_request: "none", spawn,
				requirement: {
					min_tier: 0, required: [], required_tags: [], preferred_tags: [], models: null,
					exclude: { models: [], families: [], agent_instances: [] },
					min_context: null, min_output: null, latency_ceiling_ms: null, min_effort: null,
					service_tier: "standard", downgrade: "forbidden", pin: null,
					require_trusted_provider: true,
					fallback_mode: options.fallbackModel ? "same_model" : "none",
				},
				output_schema: null, limits: unlimitedLimits,
			},
			routes: { routes },
			continuationPolicy: options.continuationPolicy ?? "exact",
			continuationConfiguration: continuation({ spawn, limits: unlimitedLimits, ...options.continuation }),
			stableDependencyDigest: hash("engine-runtime-test-dependency"),
			sessionDefaults: {},
			instruction_sources: {
				facts: { binding: "task", scope: [taskRef], os: null, runtime: "artel-engine", engine_version: null },
				rules: [], skills: [],
			},
			record_revisions: {},
			routingLimits: {
				scopes: [{ scope_ref: taskRef, agents: 4, by_tier: [], consultations: null }],
				accounts: { "gctx:aaaaaaaaaaaaaaaa": 4 }, providers: { [model.provider]: 4 },
			},
			scope_revision: hash("engine-runtime-test-scope"),
			roster_revision: hash("engine-runtime-test-roster"),
			roster_complete: true,
		};
		const dispatchHash = hash(config.dispatch);
		const receipts = new Map<string, EngineCommandEnvelope>();
		const decisions = new Map<string, ApprovalDecision>();
		let modelOverride: Record<string, unknown> = {};
		const optionsFor = (runtimeOptions: Pick<EngineRuntimeOptions, "deviceId" | "sessionDefaults">): Pick<
			EngineRuntimeOptions,
			"deviceId" | "resolveExecution" | "verifyOriginReceipt" | "verifyApprovalReceipt"
		> => ({
			deviceId: "engine-runtime-test-device",
			resolveExecution: async (execution, frozen, _attempt, _cwd, _signal): Promise<ResolvedEngineExecution> => {
				if (hash(execution.dispatch) !== dispatchHash ||
					frozen.length !== routes.length ||
					frozen.some((candidate, index) => candidate.route_ref !== routes[index]!.route_ref))
					throw new EngineTargetError("stale_target", "Fixture route differs from admitted execution");
				return {
					options: { model, modelRegistry, ...(runtimeOptions.sessionDefaults?.settings
						? { settings: runtimeOptions.sessionDefaults.settings }
						: {}), ...modelOverride },
					selectors: routes.map(candidate => `${candidate.provider}/${candidate.modelId}`),
					verifyCandidate: async index => {
						if (index >= routes.length) throw new EngineTargetError("stale_target", "Unknown fixture route");
					},
					activateCandidate: () => {},
					dispose: () => {},
				};
			},
			verifyOriginReceipt: async identity => {
				const command = receipts.get(identity.originReceiptId);
				if (!command || command.commandId !== identity.commandId ||
					command.agentInstanceRef !== identity.agentInstanceRef ||
					command.attemptId !== identity.attemptId || command.principalId !== identity.principalId)
					throw new EngineTargetError("stale_target", "Origin differs from the exact fixture command");
				return {
					verified: true, dispatchHash, bindingSnapshot: semanticBinding(command.agentInstanceRef!, taskRef),
					authContextId: "engine-runtime-test-auth", approvalSettings: null, specialApproval: null,
				};
			},
			verifyApprovalReceipt: async identity => {
				const decision = decisions.get(identity.originReceiptId);
				if (!decision || decision.command_id !== identity.commandId)
					throw new EngineTargetError("stale_target", "Approval decision differs from its submitted command");
				return { verified: true, approvalDecision: decision, expectedInputRevision: null };
			},
		});
		const fixtureResult: AdmittedExecutionFixture = {
			config,
			dispatchRef,
			dispatchHash,
			taskRef,
			receipts,
			decisions,
			setModelOverride: (override: Record<string, unknown>) => {
				modelOverride = override;
			},
			optionsFor,
		};
		return fixtureResult;
	}

	const fixture = (model: Model, taskRef: string): AdmittedExecutionFixture => admittedExecution(model, { taskRef });

	/** A typed Start request against one admitted execution. */
	function startRequest(
		execution: AdmittedExecutionFixture,
		identity: {
			commandId: string;
			agentInstanceId: string;
			agentInstanceRef: string;
			executionId: string;
			attemptId: string;
		},
		payload: {
			cwd: string;
			principalId: string;
			input?: string;
			parentAgentInstanceId?: string;
			historyEdit?: EngineStartRequest["historyEdit"];
			attachmentUploadIds?: string[];
			clientMessageId?: string;
			context?: string;
			displayName?: string;
			delegationHint?: string;
			queueId?: string;
			expectedRevision?: number;
			mutationId?: string;
			expectedIntentRevision?: number;
			explicitContinue?: boolean;
		},
	): EngineStartRequest {
		const originReceiptId = `origin:${identity.commandId}`;
		const command: EngineCommandEnvelope = {
			schema: "grimoire.engine.command.v1", op: "start", commandId: identity.commandId,
			deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine",
			engineGeneration: 0, agentInstanceId: identity.agentInstanceId,
			agentInstanceRef: identity.agentInstanceRef,
			bindingSnapshot: semanticBinding(identity.agentInstanceRef, execution.taskRef),
			executionId: identity.executionId, attemptId: identity.attemptId, authorityGeneration: 1,
			principalId: payload.principalId, issuedAt: Date.now(),
			payload: { cwd: payload.cwd },
		};
		execution.receipts.set(originReceiptId, command);
		const { principalId: _p, cwd: _c, ...rest } = payload;
		return {
			...rest,
			commandId: identity.commandId,
			principalId: payload.principalId,
			executionConfiguration: execution.config,
			dispatchRef: execution.dispatchRef,
			dispatchHash: execution.dispatchHash,
			executionKind: "ordinary",
			specialRef: null,
			originReceiptId,
			agentInstanceId: identity.agentInstanceId,
			agentInstanceRef: identity.agentInstanceRef,
			bindingSnapshot: semanticBinding(identity.agentInstanceRef, execution.taskRef),
			executionId: identity.executionId,
			attemptId: identity.attemptId,
			authorityGeneration: 1,
			cwd: payload.cwd,
		};
	}

	/** An approval decision carrying the exact command identity the fixture verifier captured. */
	function approvalDecision(
		execution: ReturnType<typeof admittedExecution>,
		target: EngineTarget & { principalId?: string },
		commandId: string,
		requestId: string,
		decision: "approve" | "deny",
		reason?: string,
	): { target: EngineTarget; commandId: string; approvalDecision: ApprovalDecision } {
		const approvalDecisionValue: ApprovalDecision = {
			schema: "grimoire.approval_decision.v1",
			request_id: requestId,
			expected_address_revision: 1,
			expected_decision_revision: 0,
			command_id: commandId,
			decision,
			reason: reason ?? null,
			origin_receipt_id: `origin:${commandId}`,
			decided_by: { kind: "human", principal_id: target.principalId ?? "owner" },
			authority: {
				ceiling_hash: hash({ tools_permit: [] }),
				subject_hash: hash({ request_id: requestId }),
				dispatch_hash: execution.dispatchHash,
			},
			decided_at: new Date().toISOString(),
		};
		execution.decisions.set(approvalDecisionValue.origin_receipt_id, approvalDecisionValue);
		return { target, commandId, approvalDecision: approvalDecisionValue };
	}

	async function createRuntime(
		execution: ReturnType<typeof admittedExecution>,
		dispatchPrompt: EngineRuntimeOptions["dispatchPrompt"] = async () => true,
		overrides: Partial<EngineRuntimeOptions> = {},
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
			},
			...execution.optionsFor({ deviceId: "engine-runtime-test-device", sessionDefaults: {} }),
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
		const deniedExecution = admittedExecution(mock.model, {
			continuation: { toolNames: ["glob"], restrictToolNames: true },
		});
		// Positive Start: the admitted execution with `read` in its tool ceiling.
		const execution = admittedExecution(mock.model, {
			continuation: { toolNames: ["read"], restrictToolNames: true },
		});
		const setup = await createRuntime(execution, undefined);
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
			await expect(deniedRuntime.start(denied)).rejects.toMatchObject({
				code: "attachment_requires_read", message: expect.stringContaining("notes.txt"),
			});
			expect(calls).toBe(0);
			expect(await deniedRuntime.store.getAttempt("file-denied-attempt")).toBeUndefined();
			const startedRequest = request("file-start", "file-attempt", "start");
			startedRequest.attachmentUploadIds = ["file-upload"];
			startedRequest.explicitContinue = true;
			const started = await setup.runtime.start(startedRequest);
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
			await restarted.start(resumed);
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
		const execution = admittedExecution(mock.model);
		const { runtime, cwd } = await createRuntime(execution, undefined);
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
		await expect(runtime.start(request)).rejects.toMatchObject({ code: "attachment_expired" });
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
		await expect(runtime.start(request)).rejects.toMatchObject({
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
		await expect(runtime.start(queuedRequest)).rejects.toMatchObject({ code: "attachment_requires_images" });
		expect((await runtime.store.getInboxItemByQueueId(queued.item.queueId))?.disposition).toBe("pending");
		expect(mock.calls).toHaveLength(0);
	});

	it("runs two independent roots on one shared runtime and disposes only the targeted root", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const request = (suffix: string) =>
			startRequest(execution, {
				commandId: `command-${suffix}`, agentInstanceId: `agent-${suffix}`,
				agentInstanceRef: `grimoire://tasks/grimoire/shared-runtime/agents/agent-${suffix}`,
				executionId: `execution-${suffix}`, attemptId: `attempt-${suffix}`,
			}, { cwd, principalId: "owner", input: suffix.toUpperCase() });
		const first = await runtime.start(request("a"));
		const second = await runtime.start(request("b"));
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
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const request = (suffix: string, attemptId: string) =>
			startRequest(execution, {
				commandId: `command-${suffix}`, agentInstanceId: "agent-a",
				agentInstanceRef: "grimoire://tasks/grimoire/shared-runtime/agents/agent-a",
				executionId: `execution-${suffix}`, attemptId,
			}, { cwd, principalId: "owner", input: suffix.toUpperCase() });
		const first = await runtime.start(request("a", "attempt-a"));
		await runtime.drain();
		const firstSession = runtime.agentRegistry.get(first.engineAgentId)?.session;
		const second = await runtime.start(request("b", "attempt-b"));
		expect(second.bindingGeneration).toBe(first.bindingGeneration + 1);
		expect(runtime.agentRegistry.get(second.engineAgentId)?.session).toBe(firstSession);
		// The same Attempt id already exists bound to another execution.
		await expect(runtime.start(request("c", "attempt-b"))).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			runtime.cancel({ ...second, commandId: "cancel-stale", bindingGeneration: second.bindingGeneration + 1 }),
		).rejects.toMatchObject({ code: "stale_target" });
		await runtime.drain();
		await runtime.dispose();
	}, 60000);

	it("bounds canonical presentation fields at Engine admission", () => {
		const execution = admittedExecution(createMockModel().model);
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
		const execution = admittedExecution(mock.model);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const started = await runtime.start(startRequest(execution, {
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
		const execution = admittedExecution(mock.model);
		const setup = await createRuntime(execution, async () => true);
		// Remove the explicit settings: Engine mode must refuse to start with ambient settings.
		const options: EngineRuntimeOptions = { ...setup.options };
		if (options.sessionDefaults) options.sessionDefaults = { ...options.sessionDefaults, settings: undefined };
		const runtime = await openRuntime(options);
		await expect(
			runtime.start(startRequest(execution, {
				commandId: "command-missing-settings", agentInstanceId: "agent-missing-settings",
				agentInstanceRef: "grimoire://tasks/grimoire/settings/agents/agent-missing-settings",
				executionId: "execution-missing-settings", attemptId: "attempt-missing-settings",
			}, { cwd: setup.cwd, principalId: "owner", input: "must fail before startup" })),
		).rejects.toThrow("Engine mode requires explicit");
		await runtime.dispose();
	});

	it("rejects an Engine Settings snapshot captured for another cwd", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model);
		const setup = await createRuntime(execution, async () => true);
		const options: EngineRuntimeOptions = { ...setup.options };
		if (options.sessionDefaults)
			options.sessionDefaults = {
				...options.sessionDefaults,
				settings: await Settings.loadReadOnly({ cwd: process.cwd() }),
			};
		const runtime = await openRuntime(options);
		await expect(
			runtime.start(startRequest(execution, {
				commandId: "command-mismatched-settings", agentInstanceId: "agent-mismatched-settings",
				agentInstanceRef: "grimoire://tasks/grimoire/settings/agents/agent-mismatched-settings",
				executionId: "execution-mismatched-settings", attemptId: "attempt-mismatched-settings",
			}, { cwd: setup.cwd, principalId: "owner", input: "must fail before startup" })),
		).rejects.toThrow("Engine settings cwd does not match session cwd");
		await runtime.dispose();
	});

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
		const execution = admittedExecution(mock.model);
		const { runtime, cwd } = await createRuntime(execution, (session, input, identity) =>
			session.prompt(input, identity));
		try {
			const started = await runtime.start(startRequest(execution, {
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
		const execution = admittedExecution(mock.model);
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		try {
			const started = await runtime.start(startRequest(execution, {
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
		const execution = admittedExecution(mock.model);
		const { runtime, cwd } = await createRuntime(execution, (session, input, identity) =>
			session.prompt(input, identity));
		try {
			const started = await runtime.start(startRequest(execution, {
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
		const execution = admittedExecution(mock.model, {
			continuation: { toolPolicies: { read: "permit" } },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		fs.writeFileSync(path.join(cwd, "permit.txt"), "approved");
		const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await runtime.start(startRequest(execution, {
			commandId: "command-permit", agentInstanceId: "agent-permit",
			agentInstanceRef: "grimoire://tasks/grimoire/permit/agents/one",
			executionId: "execution-permit", attemptId: "attempt-permit",
		}, { cwd, principalId: "owner", input: "read" }));
		const approval = await approvalRequested;
		const approvalId = (approval.payload as ApprovalDecision & { id: string }).id;
		expect(toolResultOf(mock, "read-permit")).toBeUndefined();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "planned", policy: "permit" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "pending", decision: null });

		const decision = approvalDecision(execution, started, "command-approve", approvalId, "approve");
		await runtime.resolveApproval({ ...started, ...decision });
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
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model, {
			continuation: { toolPolicies: { read: "permit" } },
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
		const started = await runtime.start(startRequest(execution, {
			commandId: "command-cancelled-permit", agentInstanceId: "agent-cancelled-permit",
			agentInstanceRef: "grimoire://tasks/grimoire/permit-cancel/agents/one",
			executionId: "execution-cancelled-permit", attemptId: "attempt-cancelled-permit",
		}, { cwd, principalId: "owner", input: "read" }));
		const approval = await approvalRequested;
		const approvalId = (approval.payload as ApprovalDecision & { id: string }).id;
		await runtime.cancel({ ...started, commandId: "command-cancel-permit" });
		await runtime.drain();
		expect(executed).toBeFalse();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const events = await runtime.store.pendingEvents();
		expect(events.find(event => event.kind === "tool_approval_resolved")?.payload?.outcome).toBe("cancelled");
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
		const execution = admittedExecution(mock.model, {
			continuation: { toolPolicies: { read: "permit" } },
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
		const started = await runtime.start(startRequest(execution, {
			commandId: "command-denied-permit", agentInstanceId: "agent-denied-permit",
			agentInstanceRef: "grimoire://tasks/grimoire/permit-deny/agents/one",
			executionId: "execution-denied-permit", attemptId: "attempt-denied-permit",
		}, { cwd, principalId: "owner", input: "read" }));
		const approvalId = ((await requested).payload as ApprovalDecision & { id: string }).id;
		const decision = approvalDecision(execution, started, "command-deny", approvalId, "deny", "not now");
		await runtime.resolveApproval({ ...started, ...decision });
		await runtime.drain();
		expect(executed).toBeFalse();
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "denied" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "deny" });
		await runtime.dispose();
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
		const execution = admittedExecution(mock.model, {
			continuation: { toolNames: ["ask"], restrictToolNames: true },
		});
		const { runtime, cwd } = await createRuntime(execution, (session, input) => session.prompt(input));
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await runtime.start(startRequest(execution, {
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
		const execution = admittedExecution(mock.model);
		const { runtime, cwd } = await createRuntime(execution, (session, input, identity) =>
			session.prompt(input, identity));
		try {
			const started = await runtime.start(startRequest(execution, {
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
			const second = await runtime.start(startRequest(execution, {
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
		const execution = admittedExecution(mock.model);
		const setup = await createRuntime(execution, (session, input) => session.prompt(input));
		const started = await setup.runtime.start(startRequest(execution, {
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
		const execution = admittedExecution(mock.model);
		const setup = await createRuntime(execution, async () => {
			dispatchCount++;
			return true;
		});
		const request = startRequest(execution, {
			commandId: "command-a", agentInstanceId: "agent-a",
			agentInstanceRef: "grimoire://tasks/grimoire/redispatch/agents/agent-a",
			executionId: "execution-a", attemptId: "attempt-a",
		}, { cwd: setup.cwd, principalId: "owner", input: "A" });
		await setup.runtime.start(request);
		await setup.runtime.drain();
		await setup.runtime.dispose();

		const restarted = await openRuntime(setup.options);
		const duplicate = await restarted.start(request);
		expect(duplicate.duplicate).toBeTrue();
		expect(duplicate.state).toBe("released");
		expect(dispatchCount).toBe(1);
		await restarted.dispose();
	}, 60000);

	it("keeps an Attempt nonterminal when transcript durability cannot be proven", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const execution = admittedExecution(mock.model);
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
			const started = await runtime.start(startRequest(execution, {
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
		const execution = admittedExecution(mock.model);
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
			const started = await runtime.start(startRequest(execution, {
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
