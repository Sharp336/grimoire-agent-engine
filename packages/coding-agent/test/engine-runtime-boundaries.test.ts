import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { engineAgentId, engineRouteToken } from "../src/engine/route";
import type { RocksAttempt, RocksCommand } from "../src/engine/rocks-runtime-rows";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings, settings as ambientSettings } from "../src/config/settings";
import { defineCapability, loadCapability, registerProvider } from "../src/capability";
import { runEngineCommand } from "../src/engine/control-query";
import type { EngineCommandEnvelope } from "../src/engine/nats-adapter";
import type { EngineOrdinaryEvent } from "../src/engine/contracts";
import type { EngineStartResult } from "../src/engine/contracts";
import { type EngineBindingGate, type EngineBindingResult, type EngineStartRequest, type EngineEvent, EngineTargetError } from "../src/engine/contracts";
import { dispatchEngineCommand, engineCommandIdentity } from "../src/engine/nats-adapter";
import { engineAgentInstanceId } from "../src/engine/route";
import { EngineRuntime, type EngineRuntimeOptions } from "../src/engine/runtime";
import { getLspResourceCounts } from "../src/lsp/client";
import { AuthStorage } from "../src/session/auth-storage";
import { BlobStore } from "../src/session/blob-store";
import { parseNativeSessionLocator, RocksNativeSessionStorage } from "../src/session/rocks-native-session-storage";
import { SessionManager } from "../src/session/session-manager";
import { storageCanonicalJson } from "../src/session/storage-client";
import { resolveProviderCandidates } from "../src/web/search/provider";
import { removeSyncWithRetries, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import { admittedExecution, admitStart, approvalDecisionFor, startEnvelope, startRequest, type AdmittedExecutionFixture } from "./helpers/engine-runtime-admitted-fixture";
import { startStorageWorker, storageBlobsDir, storageTestExecutable, storageTestRunRoot, storageWorkerUnavailable } from "./helpers/storage-worker-fixture";
import { semanticBinding } from "./helpers/runtime-v1-rocks-fixture";

const hash = (value: unknown) => `sha256:${Bun.SHA256.hash(storageCanonicalJson(value), "hex")}`;

describe.skipIf(storageWorkerUnavailable)("typed Engine lifecycle boundaries", () => {
	let worker: { stop(): Promise<void> } | undefined;
	let ownerRoot = "";
	let savedEnvironment: { binding?: string; blobs?: string } = {};
	beforeEach(async () => {
		ownerRoot = fs.mkdtempSync(path.join(storageTestRunRoot!, "boundary-owner-"));
		savedEnvironment = { binding: process.env.GRIMOIRE_STORAGE_BINDING, blobs: process.env.PI_BLOBS_DIR };
		const started = await startStorageWorker(storageTestExecutable!, ownerRoot, crypto.randomUUID() + crypto.randomUUID(), 1);
		worker = started;
		process.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(started.binding);
		process.env.PI_BLOBS_DIR = storageBlobsDir(ownerRoot);
	});
	const runtimes: EngineRuntime[] = [];
	const roots: string[] = [];
	const authStores: AuthStorage[] = [];
	beforeAll(() => registerMockApi("engine-boundaries"));
	afterEach(async () => {
		try {
			for (const runtime of runtimes.splice(0)) await runtime.dispose();
		} finally {
			for (const auth of authStores.splice(0)) auth.close();
			await worker?.stop();
			worker = undefined;
			for (const [key, value] of [["GRIMOIRE_STORAGE_BINDING", savedEnvironment.binding], ["PI_BLOBS_DIR", savedEnvironment.blobs]] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			removeSyncWithRetries(ownerRoot);
			for (const root of roots.splice(0)) removeSyncWithRetries(root);
		}
	});

	async function open(options: EngineRuntimeOptions) {
		const runtime = await EngineRuntime.create(options);
		runtimes.push(runtime);
		return runtime;
	}

	async function setup(model: Model = createMockModel().model, dispatchPrompt: EngineRuntimeOptions["dispatchPrompt"] = async () => true) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-boundaries-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd);
		const auth = await AuthStorage.create(path.join(root, "auth.sqlite"));
		authStores.push(auth);
		auth.setRuntimeApiKey(model.provider, "fixture-key");
		const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
		const settings = await Settings.loadReadOnly({ cwd, agentDir });
		const settingsByCwd = new Map([[cwd, settings]]);
		const execution = admittedExecution(model, registry);
		const executions = [execution];
		const options: EngineRuntimeOptions = {
			databasePath: path.join(root, "engine.sqlite"), deviceId: "engine-runtime-test-device", dispatchPrompt,
			attachmentBlobStore: new BlobStore(storageBlobsDir(ownerRoot)),
			sessionDefaults: { cwd, agentDir, settings, modelRegistry: registry, disableExtensionDiscovery: true,
				enableMCP: false, enableLsp: false, skills: [], contextFiles: [], rules: [], promptTemplates: [], slashCommands: [] },
			resolveExecution: async (config, frozen, attempt, requestedCwd, signal) => {
				const selected = executions.find(item => storageCanonicalJson(item.config) === storageCanonicalJson(config));
				if (!selected) throw new EngineTargetError("stale_target", "Unregistered fixture execution");
				const snapshot = settingsByCwd.get(requestedCwd);
				if (!snapshot) throw new EngineTargetError("stale_target", "Unregistered fixture workspace");
				return selected.optionsFor({ sessionDefaults: { settings: snapshot } }).resolveExecution!(config, frozen, attempt, requestedCwd, signal);
			},
			verifyOriginReceipt: async identity => {
				const selected = executions.find(item => item.receipts.has(identity.originReceiptId));
				if (!selected) throw new EngineTargetError("stale_target", "Unknown fixture origin");
				return selected.optionsFor({}).verifyOriginReceipt!(identity);
			},
			verifyApprovalReceipt: async identity => {
				const selected = executions.find(item => item.decisions.has(identity.originReceiptId));
				if (!selected) throw new EngineTargetError("stale_target", "Unknown fixture approval");
				return selected.optionsFor({}).verifyApprovalReceipt!(identity);
			},
		};
		const runtime = await open(options);
		const start = (id: string, overrides: Partial<EngineStartRequest> = {}, active = runtime, selected = execution) => {
			const request = { ...startRequest(selected, {
				commandId: id, agentInstanceId: overrides.agentInstanceId ?? id,
				agentInstanceRef: overrides.agentInstanceRef ?? `${selected.taskRef}/agents/${overrides.agentInstanceId ?? id}`,
				executionId: `${id}-execution`, attemptId: `${id}-attempt`,
			}, { cwd, principalId: "owner", input: id }), ...overrides };
			return admitStart(active, selected, request);
		};
		return { runtime, root, cwd, agentDir, settings, settingsByCwd, registry, auth, execution, executions, options, start };
	}

	async function nativeSession(runtime: EngineRuntime, locator: string) {
		const { familyId, generationId } = parseNativeSessionLocator(locator);
		return SessionManager.openNative(new RocksNativeSessionStorage(runtime.store.storageClient, familyId, generationId));
	}

	it("rejects invalid command context before an Attempt and admits exactly 65536 UTF-8 bytes", async () => {
		let dispatches = 0;
		const env = await setup(undefined, async () => { dispatches++; return true; });
		const request = startRequest(env.execution, { commandId: "context-bound", agentInstanceId: "context-agent",
			agentInstanceRef: `${env.execution.taskRef}/agents/context`, executionId: "context-execution", attemptId: "context-attempt" },
			{ cwd: env.cwd, principalId: "owner", input: "body" });
		const command = startEnvelope(env.runtime, env.execution, request);
		for (const context of [null, [], {}, 42, "€".repeat(21_846)])
			await expect(dispatchEngineCommand({ runtime: env.runtime,
				command: { ...command, payload: { ...command.payload, context } } })).rejects.toMatchObject({ code: "invalid_request" });
		expect(dispatches).toBe(0);
		expect(await env.runtime.store.getAttempt(request.attemptId)).toBeUndefined();
		await env.start("exact-context", { context: "é".repeat(32_768) });
		await env.runtime.drain();
		expect(dispatches).toBe(1);
	});

	it("keeps Engine extension and custom-tool discovery closed despite supplied ambient roots", async () => {
		let rootsSeen: unknown;
		let tools: string[] = [];
		const env = await setup(undefined, async session => {
			rootsSeen = session.effectiveExtensionRoots;
			tools = session.getEnabledToolNames();
			return true;
		});
		const toolPath = path.join(env.cwd, "ambient-engine-tool.js");
		fs.writeFileSync(toolPath, 'throw new Error("Ambient Engine extension executed");');
		env.options.sessionDefaults = { ...env.options.sessionDefaults, disableExtensionDiscovery: false,
			additionalExtensionPaths: [toolPath], preloadedCustomToolPaths: [{ path: toolPath }] };
		await env.runtime.dispose();
		const runtime = await open(env.options);
		await env.start("ambient", {}, runtime);
		await runtime.drain();
		expect(rootsSeen).toMatchObject({ mode: "explicit-only", explicit: [] });
		expect(tools).not.toContain("ambient_engine_tool");
		expect(tools).not.toContain("task");
	});

	it("disposes every binding and execution resource when one session disposer fails", async () => {
		let disposed = 0;
		const env = await setup(undefined, async session => {
			const dispose = session.dispose.bind(session);
			session.dispose = async () => { await dispose(); throw new Error("injected disposal failure"); };
			return true;
		});
		const resolve = env.options.resolveExecution!;
		env.options.resolveExecution = async (...args) => {
			const resolved = await resolve(...args);
			return { ...resolved, dispose() { resolved.dispose(); disposed++; } };
		};
		await env.runtime.dispose();
		const runtime = await open(env.options);
		await Promise.all([env.start("cleanup-a", {}, runtime), env.start("cleanup-b", {}, runtime)]);
		await runtime.drain();
		await expect(runtime.dispose()).rejects.toBeInstanceOf(AggregateError);
		expect(disposed).toBe(2);
		expect(runtime.agentRegistry.list()).toHaveLength(0);
		expect(runtime.asyncJobManager.getRunningJobs()).toHaveLength(0);
		expect(getLspResourceCounts()).toEqual({ clients: 0, pending: 0, owners: 0 });
	});

	it("retains deferred inbox revision across restart and emits its due wake only once", async () => {
		const env = await setup();
		const sender = await env.start("sender");
		const recipient = await env.start("recipient");
		await env.runtime.drain();
		await env.runtime.deliverPeerMessage({ messageId: "deferred", fromAgentInstanceId: sender.agentInstanceId,
			toAgentInstanceId: recipient.agentInstanceId, body: "wake later" });
		const queued = (await env.runtime.listInbox(recipient))[0];
		await env.runtime.mutateInbox(recipient, { mutationId: "defer", queueId: queued.queueId,
			expectedRevision: queued.revision, op: "defer", value: Date.now() + 60_000 });
		await env.runtime.dispose();
		const runtime = await open(env.options);
		expect((await runtime.listInbox(recipient))[0]).toMatchObject({ queueId: queued.queueId, revision: 2 });
		await expect(runtime.listInbox({ ...recipient, authorityGeneration: 2 })).rejects.toMatchObject({ code: "stale_target" });
		await runtime.mutateInbox(recipient, { mutationId: "edit", queueId: queued.queueId, expectedRevision: 2,
			op: "edit", value: "edited before resuming" });
		const resumed = await env.start("recipient-b", { agentInstanceId: recipient.agentInstanceId,
			agentInstanceRef: `${env.execution.taskRef}/agents/recipient`, explicitContinue: true,
			expectedIntentRevision: (await runtime.store.intent(recipient.agentInstanceId)).intentRevision }, runtime);
		await runtime.drain();
		const rebound = (await runtime.listInbox(resumed))[0];
		expect(rebound).toMatchObject({ queueId: queued.queueId, attemptId: resumed.attemptId, revision: 3 });
		const wake = Promise.withResolvers<void>();
		const wakeIds = new Set<number>();
		const unsubscribe = runtime.subscribe(event => {
			if (event.kind === "inbox_changed" && event.payload?.action === "wake_due" && event.payload.queueId === queued.queueId) {
				wakeIds.add(event.eventId); wake.resolve();
			}
		});
		try {
			await runtime.mutateInbox(resumed, { mutationId: "due", queueId: queued.queueId,
				expectedRevision: rebound.revision, op: "defer", value: Date.now() - 1 });
			await withTimeout(wake.promise, 10_000, "Deferred inbox wake was not emitted");
			await runtime.drain();
			expect(wakeIds.size).toBe(1);
			expect(await runtime.readInbox(resumed, queued.queueId)).toMatchObject({
				revision: 5, wakeIntent: true, deliveryPayload: "edited before resuming",
			});
			expect(resumed.sessionFile).toBe(recipient.sessionFile);
		} finally { unsubscribe(); }
	});

	it("retains historical inbox reads but refuses writes and every mismatched target fence", async () => {
		const env = await setup();
		const prior = await env.start("historical");
		await env.runtime.drain();
		const wake = Promise.withResolvers<EngineOrdinaryEvent>();
		const unsubscribe = env.runtime.subscribe(event => {
			if (event.kind === "inbox_changed" && event.payload?.action === "wake_due" && event.payload.queueId === "history-message") {
				unsubscribe(); wake.resolve(event);
			}
		});
		const queued = await env.runtime.enqueueInbox(prior, { sourceEventId: "history-message", sourceType: "user",
			body: "retained message", wakeIntent: true });
		const due = await withTimeout(wake.promise, 5_000, "Historical queue wake was not claimed");
		const current = await env.start("historical-next", { agentInstanceId: prior.agentInstanceId, input: undefined,
			queueId: queued.item.queueId, expectedRevision: Number(due.payload?.revision), mutationId: "history-wake",
			expectedIntentRevision: prior.intentRevision! });
		await env.runtime.drain();
		expect(await env.runtime.readInbox(prior, queued.item.queueId)).toMatchObject({
			deliveryPayload: "retained message", disposition: "acknowledged", revision: 3,
		});
		await expect(env.runtime.enqueueInbox(prior, { sourceEventId: "must-not-enqueue", sourceType: "user", body: "no" }))
			.rejects.toMatchObject({ code: "stale_target" });
		await expect(env.runtime.mutateInbox(prior, { mutationId: "must-not-drop", queueId: queued.item.queueId,
			expectedRevision: queued.item.revision, op: "drop" })).rejects.toMatchObject({ code: "stale_target" });
		await expect(env.runtime.reorderInbox(prior, "must-not-reorder", [], [])).rejects.toMatchObject({ code: "stale_target" });
		for (const target of [
			{ ...prior, agentInstanceId: "other" }, { ...prior, executionId: "other" },
			{ ...prior, attemptId: current.attemptId }, { ...prior, bindingId: "other" },
			{ ...prior, engineGeneration: prior.engineGeneration + 1 },
			{ ...prior, bindingGeneration: prior.bindingGeneration + 1 },
			{ ...prior, authorityGeneration: prior.authorityGeneration + 1 },
		]) await expect(env.runtime.listInbox(target, true)).rejects.toThrow();
		await env.runtime.dispose();
		const runtime = await open(env.options);
		expect(await runtime.readInbox(prior, queued.item.queueId)).toMatchObject({
			deliveryPayload: "retained message", disposition: "acknowledged", revision: 3,
		});
		await expect(runtime.mutateInbox(prior, { mutationId: "retained-mutation", queueId: queued.item.queueId,
			expectedRevision: queued.item.revision, op: "drop" })).rejects.toMatchObject({ code: "stale_target" });
		const fresh = admittedExecution(createMockModel().model, env.registry, { continuationPolicy: "fresh" });
		env.executions.push(fresh);
		const next = await env.start("historical-fresh", { agentInstanceId: prior.agentInstanceId,
			explicitContinue: true, expectedIntentRevision: (await runtime.store.intent(prior.agentInstanceId)).intentRevision }, runtime, fresh);
		await runtime.drain();
		expect(next.sessionFile).not.toBe(current.sessionFile);
		await expect(runtime.listInbox(prior, true)).rejects.toMatchObject({ code: "stale_target" });
	});

	it("attributes parent cancellation to the admitted Start and settles an unstarted owned child once", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<boolean>();
		const env = await setup(undefined, async () => { entered.resolve(); return release.promise; });
		const events: EngineEvent[] = [];
		env.runtime.subscribe(event => { events.push(event); });
		const started = await env.start("parent-owned");
		await withTimeout(entered.promise, 5_000, "Controlled parent did not enter its prompt");
		try {
			const cancellation = env.runtime.cancelAgentInstance(started, "parent aborted");
			release.resolve(true);
			await cancellation;
			await env.runtime.drain();
			expect(events.find(event => event.kind === "cancelled")?.causationCommandId).toBe(started.commandId);
			const principalId = "grimoire:user:pending-child";
			const installationId = `install_${"e".repeat(32)}`;
			const owner = new Bun.CryptoHasher("sha256").update(principalId).digest("hex");
			const ref = `grimoire://agents/~u/${owner}/pending-child`;
			const id = engineAgentInstanceId(ref);
			const snapshot = { ...semanticBinding(ref, env.execution.taskRef), installationId, bindingRevision: 1 };
			env.runtime.verifyInstallation(installationId, principalId);
			await env.runtime.prepareSemanticBinding({ bindingSnapshot: snapshot, phase: "preparing",
				operationId: "child-move", proposalHash: hash("pending"), gateRevision: 0, censusMutationRevision: 0 });
			const request = startRequest(env.execution, { commandId: "pending-child", agentInstanceId: id, agentInstanceRef: ref,
				executionId: "pending-child", attemptId: "pending-child" }, { cwd: env.cwd, principalId,
				bindingSnapshot: snapshot, input: "must never dispatch" });
			const command = startEnvelope(env.runtime, env.execution, request);
			const identity = engineCommandIdentity(command);
			expect(await env.runtime.store.admitCommand(identity, env.runtime.engineGeneration)).toEqual({ status: "binding_pending" });
			const waiting = env.runtime.store.waitAttemptResult(id, command.commandId, command.attemptId);
			await env.runtime.cancelAgentInstance({ ...request, engineGeneration: env.runtime.engineGeneration }, "parent aborted");
			expect((await waiting).state).toBe("failed");
			expect(await env.runtime.store.getAttempt(request.attemptId)).toBeUndefined();
			expect(await env.runtime.store.admitCommand(identity, env.runtime.engineGeneration))
				.toMatchObject({ status: "replay", receipt: { outcome: "rejected", detail: { code: "cancelled" } } });
		} finally { release.resolve(true); }
	});

	it("keeps the owned Agent identity but creates fresh native contexts on semantic rebind and cwd change", async () => {
		const mock = createMockModel({ responses: [{ content: ["old-task-sentinel"] }, { content: ["new-task"] }, { content: ["new-folder"] }] });
		const env = await setup(mock.model, (session, input) => session.prompt(input));
		const principalId = "grimoire:user:rebind-owner";
		const installationId = `install_${"c".repeat(32)}`;
		const owner = new Bun.CryptoHasher("sha256").update(principalId).digest("hex");
		const ref = `grimoire://agents/~u/${owner}/same-agent`;
		const id = engineAgentInstanceId(ref);
		const snapshot = { ...semanticBinding(ref, env.execution.taskRef), installationId, bindingRevision: 1 };
		env.runtime.verifyInstallation(installationId, principalId);
		const first = await env.start("owned-before", { agentInstanceId: id, agentInstanceRef: ref, principalId,
			bindingSnapshot: snapshot, input: "old-task-input" });
		await env.runtime.drain();
		const gate: EngineBindingGate = { bindingSnapshot: snapshot, phase: "preparing", operationId: "semantic-move",
			proposalHash: hash("semantic-move"), gateRevision: 0, censusMutationRevision: 0 };
		const prepared = await env.runtime.store.bindingPrepare(gate);
		let after = 0;
		for (;;) {
			const page = await env.runtime.store.pendingEventsForSink("hosted-binding", 25, after);
			for (const event of page.events) await env.runtime.store.markEventDelivered(event.eventId, "hosted-binding");
			if (!page.scannedRecords) break;
			after = page.throughCursor;
		}
		const census = { agentInstanceRef: ref, installationId, operationId: gate.operationId!,
			proposalHash: gate.proposalHash!, bindingRevision: 1 };
		let checkpoint = await env.runtime.store.bindingCensus(census, env.runtime.engineGeneration);
		for (let page = 0; checkpoint.next_cursor && page < 100; page++)
			checkpoint = await env.runtime.store.bindingCensus(census, env.runtime.engineGeneration);
		expect(checkpoint.status).toBe("complete");
		const target = { ...snapshot, bindingRevision: 2, taskRef: "grimoire://tasks/grimoire/destination", workStepId: null };
		const operation = { agent_ref: ref, installation_id: installationId, operation_id: gate.operationId!,
			proposal_hash: gate.proposalHash!, revision: 3, binding_revision: 2, task_ref: target.taskRef,
			work_step_id: null, phase: "committed_await_adopt" as const, status: "committed" as const };
		const committed: EngineBindingResult = { schema: "grimoire.agent_binding.result.v1", action: "commit",
			...operation, operation_result: operation };
		await env.runtime.adoptSemanticBinding({ ...prepared, phase: "committed_closed", committedTarget: target }, committed);
		const active = { ...operation, phase: "active" as const, status: "adopted" as const };
		const targetCensus = { ...census, bindingRevision: 2 };
		checkpoint = await env.runtime.store.bindingCensus(targetCensus, env.runtime.engineGeneration);
		for (let page = 0; checkpoint.next_cursor && page < 100; page++)
			checkpoint = await env.runtime.store.bindingCensus(targetCensus, env.runtime.engineGeneration);
		expect(checkpoint.status).toBe("complete");
		await env.runtime.store.bindingTransition("activate", { ...committed, ...active, action: "adopt", operation_result: active });
		expect(await env.runtime.store.runtimeTarget({ agentInstanceRef: ref, principalId })).toMatchObject({ kind: "registered" });
		expect(await env.runtime.store.runtimeTarget({ agentInstanceRef: ref, principalId, attemptId: first.attemptId }))
			.toMatchObject({ kind: "bound", bindingSnapshot: snapshot });
		const moved = admittedExecution(mock.model, env.registry, { taskRef: target.taskRef });
		env.executions.push(moved);
		const second = await env.start("owned-after", { agentInstanceId: id, agentInstanceRef: ref, principalId,
			bindingSnapshot: target, input: "new-task-input" }, env.runtime, moved);
		await env.runtime.drain();
		expect(second.agentInstanceId).toBe(first.agentInstanceId);
		expect(second.sessionFile).not.toBe(first.sessionFile);
		expect(JSON.stringify(mock.calls[1].context.messages)).not.toContain("old-task-input");
		expect(JSON.stringify(mock.calls[1].context.messages)).not.toContain("old-task-sentinel");
		const otherCwd = path.join(env.root, "other-workspace");
		fs.mkdirSync(otherCwd);
		env.settingsByCwd.set(otherCwd, await Settings.loadReadOnly({ cwd: otherCwd, agentDir: env.agentDir }));
		const third = await env.start("owned-folder", { agentInstanceId: id, agentInstanceRef: ref, principalId,
			bindingSnapshot: target, cwd: otherCwd, input: "new-folder-input" }, env.runtime, moved);
		await env.runtime.drain();
		expect(third.agentInstanceId).toBe(id);
		expect(third.bindingSnapshot).toEqual(target);
		expect(third.sessionFile).not.toBe(second.sessionFile);
		const session = env.runtime.agentRegistry.get(third.engineAgentId)!.session!;
		expect(session.settings.getCwd()).toBe(otherCwd);
		expect(session.settings.isReadOnly()).toBe(true);
		expect((await nativeSession(env.runtime, third.sessionFile!)).getCwd()).toBe(otherCwd);
		expect(JSON.stringify(mock.calls[2].context.messages)).not.toContain("new-task-input");
		expect(JSON.stringify((await nativeSession(env.runtime, first.sessionFile!)).buildSessionContext().messages)).toContain("old-task-input");
	}, 60_000);

	it("seals workspace settings, provider policy and tools across a root and six concurrent children", async () => {
		const capabilityId = `engine-policy-${Snowflake.next()}`;
		const providers = Array.from({ length: 7 }, (_, index) => `${capabilityId}-${index}`);
		const webProviders = ["perplexity", "gemini", "anthropic", "codex", "xai", "zai", "exa"] as const;
		defineCapability<{ name: string }>({ id: capabilityId, displayName: capabilityId, description: capabilityId, key: item => item.name });
		for (const provider of providers) registerProvider(capabilityId, { id: provider, displayName: provider, description: provider,
			priority: 1, load: async ctx => ({ items: [{ name: provider,
				_source: { provider, providerName: provider, path: ctx.cwd, level: "project" as const } }] }) });
		const entered = Promise.withResolvers<void>();
		const providersSeen = new Map<string, string[]>();
		const webSeen = new Map<string, string>();
		const toolsSeen = new Map<string, string[]>();
		let count = 0;
		const model = createMockModel().model;
		const env = await setup(model, async session => {
			expect(session.settings.isReadOnly()).toBe(true);
			expect(ambientSettings.getCwd()).toBe(session.settings.getCwd());
			expect(() => session.settings.override("task.maxRecursionDepth", 99)).toThrow();
			expect(() => session.settings.get("disabledProviders").push("ambient-mutation")).toThrow();
			await expect(session.settings.reloadForCwd(process.cwd())).rejects.toThrow();
			if (++count === 7) entered.resolve();
			await entered.promise;
			const loaded = await loadCapability<{ name: string }>(capabilityId, { cwd: session.settings.getCwd() });
			providersSeen.set(session.settings.getCwd(), loaded.items.map(item => item.name));
			webSeen.set(session.settings.getCwd(), resolveProviderCandidates()[0].id);
			toolsSeen.set(session.settings.getCwd(), session.getEnabledToolNames());
			return true;
		});
		const workspaces = await Promise.all(providers.map(async (provider, index) => {
			const cwd = path.join(env.root, `policy-${index}`);
			fs.mkdirSync(cwd);
			env.settingsByCwd.set(cwd, await Settings.loadReadOnly({ cwd, agentDir: env.agentDir,
				overrides: { disabledProviders: providers.filter(other => other !== provider), "providers.webSearchOrder": [webProviders[index]] } }));
			return cwd;
		}));
		const executions = workspaces.map((_, index) => admittedExecution(model, env.registry, { scopeAgents: 8,
			continuation: { toolNames: [index % 2 === 0 ? "read" : "glob"], restrictToolNames: true } }));
		env.executions.push(...executions);
		const originalCwd = process.cwd();
		const rootRef = `${env.execution.taskRef}/agents/policy-root`;
		const root = await env.start("policy-root", { cwd: workspaces[0] }, env.runtime, executions[0]);
		const children = await Promise.all(workspaces.slice(1).map((cwd, index) => {
			const name = `policy-${index + 1}`;
			const ref = `${env.execution.taskRef}/agents/${name}`;
			return env.start(name, { cwd, agentInstanceRef: ref, parentAgentInstanceId: root.agentInstanceId,
				parentAgentInstanceRef: rootRef, bindingSnapshot: { ...semanticBinding(ref, env.execution.taskRef),
					parentAgentInstanceRef: rootRef, parentAttemptId: root.attemptId, parentBindingRevision: 0 } }, env.runtime, executions[index + 1]);
		}));
		await withTimeout(env.runtime.drain(), 15_000, "Concurrent settings contexts did not finish");
		for (const [index, cwd] of workspaces.entries()) {
			expect(providersSeen.get(cwd)).toEqual([providers[index]]);
			expect(webSeen.get(cwd)).toBe(webProviders[index]);
			expect(toolsSeen.get(cwd)).toContain(index % 2 === 0 ? "read" : "glob");
			expect(toolsSeen.get(cwd)).not.toContain(index % 2 === 0 ? "glob" : "read");
		}
		expect(process.cwd()).toBe(originalCwd);
		await Promise.all([root, ...children].map(target => env.runtime.release(target)));
		expect(env.runtime.agentRegistry.list()).toHaveLength(0);
		expect(env.runtime.asyncJobManager.getRunningJobs()).toHaveLength(0);
	}, 60_000);

	it("restores only proven direct-child history, including a retained legacy birth, after restart", async () => {
		const childIds: string[] = [];
		const releaseParents = Promise.withResolvers<void>();
		const mock = createMockModel({ handler: context => context.messages.at(-1)?.role === "toolResult"
			? { content: ["done"] }
			: { content: childIds.map(id => ({ type: "toolCall" as const, id: `read-${id}`, name: "read",
				arguments: { path: `history://${engineAgentId(id)}` } })) } });
		const env = await setup(mock.model, async (session, input, identity) => {
			if (input === "read children") return session.prompt(input);
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() }, identity);
			if (input === "parent" || input === "other-parent") await releaseParents.promise;
			return true;
		});
		try {
		const execution = admittedExecution(mock.model, env.registry, { continuation: { toolNames: ["read"], restrictToolNames: true } });
		env.executions.push(execution);
		const parent = await env.start("history-parent", { input: "parent" }, env.runtime, execution);
		const parentRef = `${execution.taskRef}/agents/history-parent`;
		const other = await env.start("other-parent", {}, env.runtime, execution);
		const legacyCall = "unadvertised-child";
		const legacyRef = `${execution.taskRef}/agents/agent_${engineRouteToken([parentRef, parent.attemptId, legacyCall].join("\0"))}`;
		const foreign = admittedExecution(mock.model, env.registry, { taskRef: "grimoire://tasks/grimoire/foreign" });
		env.executions.push(foreign);
		for (const [name, selected, sourceParent, ref] of [
			["visible", execution, parent, `${execution.taskRef}/agents/visible`],
			["legacy", execution, parent, legacyRef],
			["foreign-parent", execution, other, `${execution.taskRef}/agents/foreign-parent`],
			["foreign-task", foreign, parent, `${foreign.taskRef}/agents/foreign-task`],
		] as const) {
			const id = name === "legacy" ? engineAgentInstanceId(ref) : name;
			childIds.push(id);
			const sourceRef = sourceParent === parent ? parentRef : `${execution.taskRef}/agents/other-parent`;
			const child = await env.start(`child-${name}`, { agentInstanceId: id, agentInstanceRef: ref,
				parentAgentInstanceId: sourceParent.agentInstanceId, parentAgentInstanceRef: sourceRef,
				bindingSnapshot: { ...semanticBinding(ref, selected.taskRef), parentAgentInstanceRef: sourceRef,
					parentAttemptId: sourceParent.attemptId, parentBindingRevision: 0 }, input: `private-marker-${name}` }, env.runtime, selected);
			expect((await env.runtime.store.waitAttemptResult(child.agentInstanceId, child.commandId, child.attemptId)).state).toBe("completed");
			if (name === "legacy") await env.runtime.store.mutation(id, async tx => {
				const row = (await tx.get<RocksCommand>("command", child.commandId))!;
				const wire = JSON.parse(row.identity.serializedCommand!);
				delete wire.bindingSnapshot;
				wire.payload.localChild = { parentAttemptId: parent.attemptId, toolCallId: legacyCall };
				const retained = engineCommandIdentity(wire);
				await tx.put("command", row.command_id, { ...row, identity: retained, canonical_hash: retained.canonicalHash,
					payload_bytes: Buffer.byteLength(retained.serializedCommand!) });
				const attempt = (await tx.get<RocksAttempt>("attempt", child.attemptId))!;
				const effects = await tx.get<{ count: number }>("metadata", `effects:${attempt.attempt_id}:${attempt.binding_id}`);
				expect(effects?.count ?? 0).toBe(0);
				delete attempt.binding_snapshot;
				await tx.put("attempt", child.attemptId, attempt);
			});
		}
		releaseParents.resolve();
		await env.runtime.drain();
		await env.runtime.dispose();
		const runtime = await open(env.options);
		await env.start("history-parent-two", { agentInstanceId: parent.agentInstanceId, agentInstanceRef: parentRef,
			input: "read children", explicitContinue: true,
			expectedIntentRevision: (await runtime.store.intent(parent.agentInstanceId)).intentRevision }, runtime, execution);
		await runtime.drain();
		const results = mock.calls.flatMap(call => call.context.messages).filter((message): message is ToolResultMessage => message.role === "toolResult");
		for (const [index, name] of ["visible", "legacy", "foreign-parent", "foreign-task"].entries()) {
			const result = results.findLast(message => message.toolCallId === `read-${childIds[index]}`)!;
			if (index < 2) {
				expect(result.isError).not.toBe(true);
				expect(JSON.stringify(result.content)).toContain(`private-marker-${name}`);
			} else {
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result.content)).not.toContain(`private-marker-${name}`);
			}
		}
		} finally { releaseParents.resolve(); }
	}, 60_000);

	it("retains owned unbound child history after pre-enrollment and a taskless parent restart", async () => {
		const principalId = "grimoire:user:unbound-history";
		const installationId = `install_${"e".repeat(32)}`;
		const owner = new Bun.CryptoHasher("sha256").update(principalId).digest("hex");
		const parentRef = `grimoire://agents/~u/${owner}/parent`;
		const childRef = `grimoire://agents/~u/${owner}/child`;
		const parentId = engineAgentInstanceId(parentRef);
		const childId = engineAgentInstanceId(childRef);
		const mock = createMockModel({ responses: [
			{ content: [{ type: "toolCall", id: "read-unbound", name: "read", arguments: { path: `history://${engineAgentId(childId)}` } }] },
			{ content: ["done"] },
		] });
		const releaseParent = Promise.withResolvers<void>();
		const env = await setup(mock.model, async (session, input, identity) => {
			if (input === "read retained child") return session.prompt(input);
			session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() }, identity);
			if (input === "parent") await releaseParent.promise;
			return true;
		});
		try {
		// Ordinary Dispatch requires a Task. Use the reachable taskless consultation contract.
		const execution = admittedExecution(mock.model, env.registry, {
			dispatch: { ...env.execution.config.dispatch, execution_kind: "consultation", target: null,
				special_ref: { kind: "consultation", definition_ref: "gctx:eeeeeeeeeeeeeeee", definition_revision: 1, call_id: "history-call" } },
			continuation: { toolNames: ["read"], restrictToolNames: true },
		});
		env.executions.push(execution);
		env.runtime.verifyInstallation(installationId, principalId);
		const snapshot = { ...semanticBinding(parentRef), taskRef: null, workStepId: null, installationId, bindingRevision: 1 };
		const parent = await env.start("unbound-parent", { agentInstanceId: parentId, agentInstanceRef: parentRef,
			principalId, bindingSnapshot: snapshot, input: "parent" }, env.runtime, execution);
		await env.runtime.store.registerAgent({ agentInstanceId: childId, agentInstanceRef: childRef,
			parentAgentInstanceId: parentId, parentAgentInstanceRef: parentRef, principalId, authorityGeneration: 1 });
		const childSnapshot = { ...snapshot, agentInstanceRef: childRef, parentAgentInstanceRef: parentRef,
			parentAttemptId: parent.attemptId, parentBindingRevision: 1 };
		const child = await env.start("unbound-child", { agentInstanceId: childId, agentInstanceRef: childRef, principalId,
			parentAgentInstanceId: parentId, parentAgentInstanceRef: parentRef, bindingSnapshot: childSnapshot,
			input: "exact retained unbound transcript" }, env.runtime, execution);
		expect((await env.runtime.store.waitAttemptResult(child.agentInstanceId, child.commandId, child.attemptId)).state).toBe("completed");
		releaseParent.resolve();
		await env.runtime.drain();
		await env.runtime.dispose();
		const runtime = await open(env.options);
		runtime.verifyInstallation(installationId, principalId);
		await env.start("unbound-parent-two", { agentInstanceId: parentId, agentInstanceRef: parentRef, principalId,
			bindingSnapshot: snapshot, input: "read retained child", explicitContinue: true,
			expectedIntentRevision: (await runtime.store.intent(parentId)).intentRevision }, runtime, execution);
		await runtime.drain();
		const result = mock.calls.flatMap(call => call.context.messages)
			.findLast(message => message.role === "toolResult" && message.toolCallId === "read-unbound");
		expect(result).toMatchObject({ role: "toolResult", isError: false });
		expect(JSON.stringify(result)).toContain("exact retained unbound transcript");
		} finally { releaseParent.resolve(); }
	}, 60_000);

	for (const storage of ["inline", "blob"] as const) it(`retains ${storage} user and tool-result image resources across restart`, async () => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
		const image = storage === "inline" ? png : Buffer.concat([png, Buffer.alloc(2048)]);
		const env = await setup(undefined, async session => {
			session.sessionManager.appendMessage({ role: "user", content: [
				{ type: "text", text: "Uploaded image" },
				{ type: "image", mimeType: "image/png", data: image.toString("base64") },
				{ type: "text", text: "After uploaded image" },
			], timestamp: 1 });
			session.sessionManager.appendMessage({ role: "assistant", content: [
				{ type: "text", text: "Reading image" }, { type: "toolCall", id: "read-image", name: "read", arguments: { path: "picture.png" } },
			], api: "openai-responses", provider: "mock", model: "mock", timestamp: 2, stopReason: "toolUse",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
			session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "read-image", toolName: "read", isError: false, timestamp: 3,
				content: [{ type: "text", text: "Before result image" },
					{ type: "image", mimeType: "image/png", data: image.toString("base64") },
					{ type: "text", text: "After result image" }] });
			return true;
		});
		const target = await env.start("history-image");
		await env.runtime.drain();
		const ref = `${env.execution.taskRef}/agents/history-image`;
		const page = await env.runtime.sessionHistoryPage(target.agentInstanceId, ref, undefined, 100, target.attemptId);
		const user = page.entries.find(entry => entry.role === "user")!;
		const assistant = page.entries.find(entry => entry.role === "assistant")!;
		const upload = user.images![0].resource!;
		const result = assistant.blocks!.find(block => block.toolCallId === "read-image")!.images![0].resource!;
		expect(upload).toMatchObject({ entryId: user.entryId, blockIndex: 1, bytes: image.length });
		expect(result.entryId).not.toBe(assistant.entryId);
		expect(result).toMatchObject({ blockIndex: 1, contentHash: upload.contentHash, revision: upload.revision });
		expect(user.blocks?.map(block => [block.blockIndex, block.text])).toEqual([[0, "Uploaded image"], [2, "After uploaded image"]]);
		expect(assistant.blocks!.find(block => block.toolCallId === "read-image")!.resultBlocks).toMatchObject([
			{ blockIndex: 0, text: "Before result image" }, { blockIndex: 1, image: { resource: result } },
			{ blockIndex: 2, text: "After result image" },
		]);
		expect(JSON.stringify(page.entries)).not.toContain(image.toString("base64"));
		for (const resource of [upload, result]) {
			const read = await env.runtime.store.runtimeResource({ principalId: "owner", resource: { ...resource }, offset: 0, limit: 65_536 });
			expect(Buffer.from(String(read.contentBase64), "base64")).toEqual(image);
		}
		await env.runtime.dispose();
		const runtime = await open(env.options);
		expect((await runtime.sessionHistoryPage(target.agentInstanceId, ref, undefined, 100, target.attemptId)).entries).toEqual(page.entries);
	}, 60_000);

	for (const action of ["pause", "stop", "fifo", "approval-fifo"] as const) it(`keeps nested task waits quiescent under parent ${action} while an independent root completes`, async () => {
		const fifo = action === "fifo" || action === "approval-fifo";
		const leafEntered = Promise.withResolvers<void>();
		const releaseLeaf = Promise.withResolvers<void>();
		const siblingEntered = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		const leafResumed = Promise.withResolvers<void>();
		const releaseResumedLeaf = Promise.withResolvers<void>();
		const waitsReady = Promise.withResolvers<void>();
		const waiting = new Set<string>();
		const results: Array<{ agent: string; attemptId?: string; state: string; payload: Record<string, unknown> }> = [];
		const taskRef = "grimoire://tasks/grimoire/runtime-test";
		const ref = (name: string) => `${taskRef}/agents/${action}-${name}`;
		const mock = createMockModel({ handler: async (context, options) => {
			const input = JSON.stringify(context.messages.find(message => message.role === "user")?.content);
			for (const name of ["root", "middle"]) {
				if (!input.includes(`nested-${name}-work`)) continue;
				if (context.messages.some(message => message.role === "toolResult")) return { content: [`${name}-result-after-child`] };
				return { content: [{ type: "toolCall", id: `${name}-wait`, name: "task",
					arguments: { target: { task_ref: taskRef, work_step_id: null }, assignment: name === "root" ? "middle" : "leaf" } }] };
			}
			if (input.includes("nested-leaf-work")) {
				if (fifo && context.messages.some(message => message.role === "toolResult")) {
					if (action === "approval-fifo" && !context.messages.some(message =>
						message.role === "toolResult" && message.toolCallId === "leaf-read")) {
						leafResumed.resolve();
						await releaseResumedLeaf.promise;
						return { content: [{ type: "toolCall", id: "leaf-read", name: "read", arguments: { path: "leaf-proof.txt" } }] };
					}
					leafResumed.resolve();
					await releaseResumedLeaf.promise;
					return { content: ["leaf-exact-result"] };
				}
				leafEntered.resolve();
				const abort = () => releaseLeaf.resolve();
				options?.signal?.addEventListener("abort", abort, { once: true });
				try {
					await releaseLeaf.promise;
					options?.signal?.throwIfAborted();
					return fifo
						? { content: [{ type: "toolCall" as const, id: "leaf-first-tool",
							name: action === "approval-fifo" ? "glob" : "read",
							arguments: action === "approval-fifo" ? { pattern: "*.txt" } : { path: "leaf-proof.txt" } }] }
						: { content: ["leaf-exact-result"] };
				}
				finally { options?.signal?.removeEventListener("abort", abort); }
			}
			if (!input.includes("nested-sibling-work")) throw new Error("Unexpected nested fixture input");
			siblingEntered.resolve();
			await releaseSibling.promise;
			return { content: ["independent-sibling-result"] };
		} });
		const env = await setup(mock.model, (session, input, identity) => session.prompt(input, identity));
		fs.writeFileSync(path.join(env.cwd, "leaf-proof.txt"), "leaf result");
		const rootExecution = admittedExecution(mock.model, env.registry, { spawn: { allowed: "auto", max_depth: 2, max_children: 1, on_exceed: "deny" },
			continuation: { toolNames: ["task"], restrictToolNames: true } });
		const middleExecution = admittedExecution(mock.model, env.registry, { spawn: { allowed: "auto", max_depth: 1, max_children: 1, on_exceed: "deny" },
			continuation: { toolNames: ["task"], restrictToolNames: true } });
		const leafExecution = admittedExecution(mock.model, env.registry, {
			continuation: { toolNames: action === "approval-fifo" ? ["glob", "read"] : fifo ? ["read"] : [], restrictToolNames: true,
				...(action === "approval-fifo" ? { toolPolicies: { read: "permit" as const }, tools_permit: ["read"] } : {}) },
		});
		env.executions.push(rootExecution, middleExecution, leafExecution);
		if (action === "approval-fifo") {
			const verify = env.options.verifyOriginReceipt!;
			env.options.verifyOriginReceipt = async identity => ({ ...await verify(identity),
				approvalSettings: { timeout_seconds: 1, settings_revision: 1, settings_hash: hash("nested-deadline") } });
		}
		let runtime: EngineRuntime;
		const requestFor = (name: string, selected: AdmittedExecutionFixture, parent?: { agentInstanceId: string; agentInstanceRef: string; attemptId: string }) =>
			startRequest(selected, { commandId: `${action}-${name}-start`, agentInstanceId: engineAgentInstanceId(ref(name)),
				agentInstanceRef: ref(name), executionId: `${action}-${name}-execution`, attemptId: `${action}-${name}-attempt` },
			{ cwd: env.cwd, principalId: "owner", input: `nested-${name}-work`,
				...(parent ? { parentAgentInstanceId: parent.agentInstanceId, parentAgentInstanceRef: parent.agentInstanceRef,
					bindingSnapshot: { ...semanticBinding(ref(name), taskRef), parentAgentInstanceRef: parent.agentInstanceRef,
						parentAttemptId: parent.attemptId, parentBindingRevision: 0 } } : {}) });
		env.options.launchChild = async request => {
			const selected = request.assignment === "middle" ? middleExecution : leafExecution;
			const child = requestFor(request.assignment, selected, { agentInstanceId: request.parentAgentInstanceId,
				agentInstanceRef: request.parentAgentInstanceRef, attemptId: request.parentAttemptId });
			await request.enrollChild(child.agentInstanceRef, child.attemptId);
			await admitStart(runtime, selected, child);
			waiting.add(request.assignment);
			if (waiting.size === 2) waitsReady.resolve();
			try {
				const result = await runtime.store.waitAttemptResult(child.agentInstanceId, child.commandId, child.attemptId, request.signal);
				results.push({ agent: request.assignment, ...result });
				return { agentInstanceId: child.agentInstanceId, agentInstanceRef: child.agentInstanceRef,
					status: result.state === "completed" ? "completed" : result.state === "cancelled" ? "cancelled" : "failed",
					assistantFinal: String(result.payload.assistantFinal ?? "") };
			} catch (error) {
				if (!request.signal?.aborted) throw error;
				return { agentInstanceId: child.agentInstanceId, status: "cancelled", error: "Parent task aborted" };
			} finally { waiting.delete(request.assignment); }
		};
		await env.runtime.dispose();
		runtime = await open(env.options);
		const nextEvent = (kind: string, attemptId: string) => {
			const ready = Promise.withResolvers<void>();
			const unsubscribe = runtime.subscribe(event => { if (event.kind === kind && event.attemptId === attemptId) { unsubscribe(); ready.resolve(); } });
			return ready.promise;
		};
		try {
			const root = await admitStart(runtime, rootExecution, requestFor("root", rootExecution));
			await withTimeout(Promise.all([leafEntered.promise, waitsReady.promise]), 10_000, "Nested waits did not enroll");
			const middle = runtime.getBinding(engineAgentInstanceId(ref("middle")))!;
			const leaf = runtime.getBinding(engineAgentInstanceId(ref("leaf")))!;
			const leafPaused = nextEvent("paused", leaf.attemptId);
			await runtime.pause({ ...leaf, commandId: "leaf-own-pause", initiator: { kind: "human" } });
			releaseLeaf.resolve();
			await withTimeout(leafPaused, 5_000, "Leaf did not reach its pause");
			expect(waiting.size).toBe(2);
			expect(results).toEqual([]);
			const sibling = await admitStart(runtime, leafExecution, requestFor("sibling", leafExecution));
			await withTimeout(siblingEntered.promise, 5_000, "Independent root did not enter");
			if (action !== "stop") {
				const paused = Promise.all([nextEvent("paused", root.attemptId), nextEvent("paused", middle.attemptId)]);
				await runtime.pause({ ...root, commandId: "nested-parent-pause", initiator: { kind: "human" } });
				await withTimeout(paused, 5_000, "Nested waits blocked parent quiescence");
				expect(waiting.size).toBe(2);
				expect(results).toEqual([]);
			} else await runtime.cancel({ ...root, commandId: "nested-parent-stop" });
			if (fifo) {
				await runtime.resume({ ...leaf, commandId: "leaf-remove-own-hold", initiator: { kind: "human" },
					expectedIntentRevision: (await runtime.store.intent(leaf.agentInstanceId)).intentRevision });
				for (const name of ["blocker-one", "blocker-two"])
					await admitStart(runtime, leafExecution, { ...requestFor(name, leafExecution), input: "nested-sibling-work" });
				const command: EngineCommandEnvelope = {
					schema: "grimoire.engine.command.v1", op: "resume", commandId: "nested-fifo-resume",
					deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine", engineGeneration: runtime.engineGeneration,
					agentInstanceId: root.agentInstanceId, agentInstanceRef: root.bindingSnapshot!.agentInstanceRef,
					bindingSnapshot: root.bindingSnapshot, runtimeBindingId: root.bindingId, bindingGeneration: root.bindingGeneration,
					executionId: root.executionId, attemptId: root.attemptId, authorityGeneration: root.authorityGeneration,
					principalId: "owner", issuedAt: Date.now(),
					payload: { originReceiptId: "origin:nested-fifo-resume",
						expectedIntentRevision: (await runtime.store.intent(root.agentInstanceId)).intentRevision },
				};
				rootExecution.captureCommand(command);
				await expect(runEngineCommand({ runtime, deviceId: command.deviceId, engineId: command.engineId }, command))
					.rejects.toMatchObject({ code: "routing_queued" });
				await withTimeout(leafResumed.promise, 5_000, "Leaf did not reacquire ahead of its waiting ancestors");
				expect((await runtime.store.getAttempt(leaf.attemptId))?.state).toBe("running");
				expect((await runtime.store.getAttempt(middle.attemptId))?.state).toBe("paused");
				expect((await runtime.store.getAttempt(root.attemptId))?.state).toBe("paused");
				expect((await runtime.store.records.get("command", root.commandId)).value).toMatchObject({
					routing: { action: "release", lease_revision: 1 },
				});
				expect((await runtime.store.records.get("command", middle.commandId)).value).toMatchObject({
					routing: { action: "enqueue", lease_revision: 1 },
				});
				const waitingMiddle = (await runtime.store.records.get("command", middle.commandId)).value as unknown as RocksCommand;
				const deadlinePause = action === "approval-fifo" ? nextEvent("paused", leaf.attemptId) : undefined;
				releaseResumedLeaf.resolve();
				if (deadlinePause) {
					await withTimeout(deadlinePause, 15_000, "Resumed leaf did not reach its new approval pause");
					await expect(runEngineCommand({ runtime, deviceId: command.deviceId, engineId: command.engineId }, command))
						.rejects.toMatchObject({ code: "binding_pending" });
					expect((await runtime.store.records.get("metadata", waitingMiddle.routing!.queue_id!)).value)
						.toMatchObject({ status: "cancelled" });
					expect((await runtime.store.records.get("command", command.commandId)).value).toMatchObject({ state: "received", receipt: null });
					const approval = (await runtime.store.durableApprovalPause(leaf.attemptId))![0]!;
					const binding = (await runtime.store.getBinding(leaf.agentInstanceId))!;
					const decision = approvalDecisionFor(leafExecution, { ...binding, principalId: "owner" },
						"nested-late-approval", approval.request, "approve");
					const approve: EngineCommandEnvelope = {
						schema: "grimoire.engine.command.v1", op: "resolve_approval", commandId: decision.command_id,
						deviceId: command.deviceId, engineId: command.engineId, engineGeneration: runtime.engineGeneration,
						agentInstanceId: binding.agentInstanceId, agentInstanceRef: binding.bindingSnapshot!.agentInstanceRef,
						bindingSnapshot: binding.bindingSnapshot, runtimeBindingId: binding.bindingId, bindingGeneration: binding.bindingGeneration,
						authorityGeneration: binding.authorityGeneration, executionId: binding.executionId, attemptId: binding.attemptId,
						principalId: "owner", issuedAt: Date.now(),
						payload: { originReceiptId: decision.origin_receipt_id, approvalDecision: decision },
					};
					leafExecution.captureCommand(approve);
					expect((await runEngineCommand({ runtime, deviceId: approve.deviceId, engineId: approve.engineId }, approve)).outcome).toBe("applied");
				}
				await withTimeout(runtime.store.waitAttemptResult(root.agentInstanceId, root.commandId, root.attemptId),
					10_000, "Leaves-first Resume did not finish while unrelated slots remained occupied");
				expect((await runEngineCommand({ runtime, deviceId: command.deviceId, engineId: command.engineId }, command)).outcome)
					.toBe("applied");
			}
			releaseSibling.resolve();
			expect(await withTimeout(runtime.store.waitAttemptResult(sibling.agentInstanceId, sibling.commandId, sibling.attemptId),
				5_000, "Held branch blocked independent root")).toMatchObject({ state: "completed", payload: { assistantFinal: "independent-sibling-result" } });
			expect((await runtime.store.intent(sibling.agentInstanceId)).manualHold).toBe(false);
			if (action === "pause") {
				await runtime.resume({ ...root, commandId: "nested-parent-resume", initiator: { kind: "human" } });
				const hold = await runtime.store.intent(leaf.agentInstanceId);
				expect(hold.holds.map(item => item.commandId)).toEqual(["leaf-own-pause"]);
				expect((await runtime.store.getAttempt(leaf.attemptId))?.state).toBe("paused");
				expect(waiting.size).toBe(2);
				await runtime.resume({ ...leaf, commandId: "leaf-own-resume", initiator: { kind: "human" }, expectedIntentRevision: hold.intentRevision });
			}
			await withTimeout(runtime.drain(), 10_000, "Nested waits did not finish");
			for (const [name, target] of [["root", root], ["middle", middle], ["leaf", leaf]] as const) {
				const result = await runtime.store.waitAttemptResult(target.agentInstanceId, target.commandId, target.attemptId);
				expect(result.state).toBe(action !== "stop" ? "completed" : "cancelled");
				if (action !== "stop") expect(result.payload.assistantFinal).toBe(name === "leaf" ? "leaf-exact-result" : `${name}-result-after-child`);
				else expect((await runtime.store.intent(target.agentInstanceId)).manualHold).toBe(true);
			}
			expect(waiting.size).toBe(0);
			expect((await runtime.store.pendingEvents()).filter(event => event.agentInstanceId === sibling.agentInstanceId &&
				["pause_requested", "paused", "cancelled"].includes(event.kind))).toEqual([]);
		} finally { releaseLeaf.resolve(); releaseResumedLeaf.resolve(); releaseSibling.resolve(); await runtime.dispose(); }
	}, 60_000);

	for (const outcome of ["answered", "auth_failed", "retry_failed"] as const) for (const restart of [false, true]) {
		it(`records frozen fallback and resets selection on the next Attempt (${outcome}, restart=${restart})`, async () => {
			const exhausted = outcome !== "answered";
			const failure = outcome === "retry_failed" ? "503 Service unavailable" : "401 Unauthorized";
			let calls = 0;
			const primary = createMockModel({ id: "boundary-primary", handler: () =>
				++calls > 1 && !exhausted ? { content: ["primary recovered"] } : { throw: failure } });
			const fallback = createMockModel({ id: "boundary-fallback", handler: () =>
				exhausted ? { throw: failure } : { content: ["fallback answered"] } });
			const env = await setup(primary, (session, input) => session.prompt(input));
			const execution = admittedExecution(primary, env.registry, { fallbackModel: fallback, rules: [
				{ ref: "gctx:ffffffffffffffff", revision: 1, content_hash: hash("primary-rule"), content: "PRIMARY_RULE_ONLY",
					route_refs: ["gctx:bbbbbbbbbbbbbbbb"] },
				{ ref: "gctx:gggggggggggggggg", revision: 1, content_hash: hash("fallback-rule"), content: "FALLBACK_RULE_ONLY",
					route_refs: ["gctx:dddddddddddddddd"] },
			] });
			env.executions.push(execution);
			const find = spyOn(env.registry, "find").mockImplementation((provider, id) => [primary, fallback]
				.find(model => model.provider === provider && model.id === id));
			const key = spyOn(env.registry, "getApiKey").mockResolvedValue("fixture-key");
			const wait = spyOn(scheduler, "wait").mockResolvedValue(undefined);
			let runtime = env.runtime;
			try {
				const first = await env.start("fallback-first", { agentInstanceId: "fallback-agent", input: "first fallback" }, runtime, execution);
				await runtime.drain();
				expect(primary.calls).toHaveLength(1);
				expect(fallback.calls).toHaveLength(outcome === "retry_failed" ? 3 : 1);
				expect(JSON.stringify(fallback.calls[0].context.messages)).toContain("FALLBACK_RULE_ONLY");
				const attempt = (await runtime.store.getAttempt(first.attemptId))!;
				expect(attempt.state).toBe(exhausted ? "failed" : "completed");
				expect(attempt.execution!.executor_choice.transitions.map(item => [item.from.route_ref, item.to.route_ref]))
					.toEqual([["gctx:bbbbbbbbbbbbbbbb", "gctx:dddddddddddddddd"]]);
				expect(attempt.execution!.executor_choice.rules.map(rule => rule.ref))
					.toEqual(["gctx:ffffffffffffffff", "gctx:gggggggggggggggg"]);
				const events = await runtime.store.pendingEvents();
				const change = events.find((event): event is Extract<EngineEvent, { kind: "executor_route_changed" }> =>
					event.attemptId === first.attemptId && event.kind === "executor_route_changed")!;
				expect(change.payload?.event_id).toBe(attempt.execution!.executor_choice.transitions[0].event_id);
				expect(events.indexOf(change)).toBeLessThan(events.findIndex(event => event.attemptId === first.attemptId &&
					event.kind === (exhausted ? "failed" : "completed")));
				expect(JSON.parse(attempt.executor_route_state!)).toMatchObject({ fallback: true, phase: exhausted ? "exhausted" : "active" });
				if (restart) { await runtime.dispose(); runtime = await open(env.options); }
				const second = await env.start("fallback-next", { agentInstanceId: first.agentInstanceId, input: "next attempt",
					explicitContinue: true, expectedIntentRevision: (await runtime.store.intent(first.agentInstanceId)).intentRevision }, runtime, execution);
				await runtime.drain();
				expect(primary.calls).toHaveLength(2);
				expect(fallback.calls).toHaveLength(outcome === "retry_failed" ? 6 : exhausted ? 2 : 1);
				const next = (await runtime.store.getAttempt(second.attemptId))!;
				expect(next.state).toBe(exhausted ? "failed" : "completed");
				expect(next.execution!.executor_choice.selected.route_ref).toBe("gctx:bbbbbbbbbbbbbbbb");
				expect(next.execution!.executor_choice.transitions).toHaveLength(exhausted ? 1 : 0);
				if (!exhausted) {
					expect(JSON.stringify(primary.calls[1].context.messages)).toContain("fallback answered");
					expect(JSON.stringify(primary.calls[1].context.messages)).not.toContain("FALLBACK_RULE_ONLY");
				}
				expect(primary.calls[1].context.systemPrompt).toEqual(primary.calls[0].context.systemPrompt);
			} finally { await runtime.dispose(); find.mockRestore(); key.mockRestore(); wait.mockRestore(); }
		}, 60_000);
	}

	it("recovers a deadline-paused fallback on its current route without duplicating the original rule event", async () => {
		const primary = createMockModel({ id: "paused-primary", handler: { throw: "401 Unauthorized" } });
		const fallback = createMockModel({ id: "paused-fallback", responses: [
			{ content: [{ type: "toolCall", id: "retained-read", name: "read", arguments: { path: "effect.txt" } }] },
			{ content: ["recovered fallback"] },
		] });
		const env = await setup(primary, (session, input) => session.prompt(input));
		fs.writeFileSync(path.join(env.cwd, "effect.txt"), "effect-executed");
		const execution = admittedExecution(primary, env.registry, { fallbackModel: fallback,
			continuation: { toolNames: ["read"], restrictToolNames: true, toolPolicies: { read: "permit" }, tools_permit: ["read"] },
			rules: [{ ref: "gctx:gggggggggggggggg", revision: 1, content_hash: hash("retained-rule"), content: "RETAINED_FALLBACK_RULE",
				route_refs: ["gctx:dddddddddddddddd"] }] });
		env.executions.push(execution);
		const verify = env.options.verifyOriginReceipt!;
		env.options.verifyOriginReceipt = async identity => ({ ...await verify(identity),
			approvalSettings: { timeout_seconds: 1, settings_revision: 1, settings_hash: hash("one-second") } });
		await env.runtime.dispose();
		let runtime = await open(env.options);
		const find = spyOn(env.registry, "find").mockImplementation((provider, id) =>
			[primary, fallback].find(model => model.provider === provider && model.id === id));
		const key = spyOn(env.registry, "getApiKey").mockResolvedValue("fixture-key");
		const paused = Promise.withResolvers<void>();
		let requestId = "";
		runtime.subscribe(event => {
			if (event.kind === "tool_approval_requested") requestId = String(event.payload?.id);
			if (event.kind === "paused" && event.payload?.cause) paused.resolve();
		});
		try {
			const started = await env.start("paused-fallback", {}, runtime, execution);
			await withTimeout(paused.promise, 15_000, "Approval did not reach its durable deadline pause");
			const before = (await runtime.store.getAttempt(started.attemptId))!;
			expect(before.state).toBe("paused");
			expect(before.cause).toBe("approval_deadline");
			const eventId = before.execution!.executor_choice.transitions[0].event_id;
			await runtime.dispose();
			runtime = await open(env.options);
			const binding = (await runtime.store.getBinding(started.agentInstanceId))!;
			const approval = (await runtime.store.getApproval(requestId))!;
			const decision = approvalDecisionFor(execution, { ...binding, principalId: "owner" }, "late-fallback-approval", approval.request, "approve");
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1", op: "resolve_approval", commandId: decision.command_id,
				deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine", engineGeneration: runtime.engineGeneration,
				agentInstanceId: binding.agentInstanceId, agentInstanceRef: binding.bindingSnapshot!.agentInstanceRef,
				bindingSnapshot: binding.bindingSnapshot, runtimeBindingId: binding.bindingId, bindingGeneration: binding.bindingGeneration,
				authorityGeneration: binding.authorityGeneration, executionId: binding.executionId, attemptId: binding.attemptId,
				principalId: "owner", issuedAt: Date.now(), payload: { originReceiptId: decision.origin_receipt_id, approvalDecision: decision },
			};
			execution.captureCommand(command);
			const options = { runtime, deviceId: command.deviceId, engineId: command.engineId };
			expect((await runEngineCommand(options, command)).outcome).toBe("applied");
			await withTimeout(runtime.drain(), 15_000, "Retained approval did not complete its same Attempt");
			expect(primary.calls).toHaveLength(1);
			expect(fallback.calls).toHaveLength(2);
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
			expect((await runEngineCommand(options, command)).outcome).toBe("applied");
			expect((await runtime.store.getApproval(requestId))?.request.decision_revision).toBe(1);
			const session = await nativeSession(runtime, (await runtime.store.getBinding(started.agentInstanceId))!.sessionFile!);
			expect(session.getContextBranch().filter(entry => entry.type === "custom_message" && entry.customType === "executor-rules" &&
				entry.details && typeof entry.details === "object" && "eventId" in entry.details && entry.details.eventId === eventId)).toHaveLength(1);
			expect(JSON.stringify(fallback.calls[1].context.messages)).toContain("effect-executed");
		} finally { await runtime.dispose(); find.mockRestore(); key.mockRestore(); }
	}, 60_000);

	it.each(["measured", "zero", "unavailable"] as const)(
		"recovers only the same Attempt's measured usage after a real approval pause: %s", async availability => {
			const mock = createMockModel({ id: `recovered-usage-${availability}`, responses: [
				{ content: ["previous Attempt"], usage: { input: 900, output: 90, cacheRead: 9 } },
				{ content: [{ type: "toolCall", id: "usage-read", name: "read", arguments: { path: "effect.txt" } }],
					usage: availability === "measured"
						? { input: 10, output: 3, cacheRead: 2, cacheWrite: 1 }
						: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unavailable: availability === "unavailable" } },
				{ content: ["same Attempt complete"], usage: { input: 20, output: 4, cacheRead: 3, cacheWrite: 2 } },
			] });
			const env = await setup(mock, (session, input) => session.prompt(input));
			const execution = admittedExecution(mock, env.registry, {
				continuation: { toolNames: ["read"], restrictToolNames: true, toolPolicies: { read: "permit" }, tools_permit: ["read"] },
			});
			env.executions.push(execution);
			fs.writeFileSync(path.join(env.cwd, "effect.txt"), "one retained tool execution");
			const verify = env.options.verifyOriginReceipt!;
			env.options.verifyOriginReceipt = async identity => ({ ...await verify(identity),
				approvalSettings: { timeout_seconds: 1, settings_revision: 1, settings_hash: hash("usage-deadline") } });
			await env.runtime.dispose();
			let runtime = await open(env.options);
			try {
				const prior = await env.start("usage-prior", { agentInstanceId: "usage-agent" }, runtime, execution);
				await runtime.drain();
				expect((await runtime.store.getAttempt(prior.attemptId))?.state).toBe("completed");
				const paused = Promise.withResolvers<void>();
				let requestId = "";
				runtime.subscribe(event => {
					if (event.kind === "tool_approval_requested") requestId = event.payload.id;
					if (event.kind === "paused" && event.payload?.cause) paused.resolve();
				});
				const started = await env.start("usage-current", { agentInstanceId: "usage-agent",
					explicitContinue: true, expectedIntentRevision: (await runtime.store.intent("usage-agent")).intentRevision },
					runtime, execution);
				await withTimeout(paused.promise, 15_000, "Measured response did not reach its approval pause");
				expect((await runtime.store.attemptToolEffects(started.attemptId))
					.filter(effect => effect.effect_kind === "model").map(effect => [effect.state, effect.outcome]))
					.toEqual([["settled", "completed"]]);
				expect(await runtime.store.durableApprovalPause(started.attemptId)).toBeDefined();
				expect(mock.calls).toHaveLength(2);
				await runtime.dispose();
				runtime = await open(env.options);
				const binding = (await runtime.store.getBinding(started.agentInstanceId))!;
				expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
				const approval = (await runtime.store.getApproval(requestId))!;
				const decision = approvalDecisionFor(execution, { ...binding, principalId: "owner" },
					"usage-late-approval", approval.request, "approve");
				const command: EngineCommandEnvelope = {
					schema: "grimoire.engine.command.v1", op: "resolve_approval", commandId: decision.command_id,
					deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine", engineGeneration: runtime.engineGeneration,
					agentInstanceId: binding.agentInstanceId, agentInstanceRef: binding.bindingSnapshot!.agentInstanceRef,
					bindingSnapshot: binding.bindingSnapshot, runtimeBindingId: binding.bindingId, bindingGeneration: binding.bindingGeneration,
					authorityGeneration: binding.authorityGeneration, executionId: binding.executionId, attemptId: binding.attemptId,
					principalId: "owner", issuedAt: Date.now(), payload: { originReceiptId: decision.origin_receipt_id, approvalDecision: decision },
				};
				execution.captureCommand(command);
				const options = { runtime, deviceId: command.deviceId, engineId: command.engineId };
				expect((await runEngineCommand(options, command)).outcome).toBe("applied");
				await withTimeout(runtime.drain(), 15_000, "Recovered measured Attempt did not complete");
				const attempt = (await runtime.store.getAttempt(started.attemptId))!;
				expect(attempt.state).toBe("completed");
				expect(attempt.execution!.executor_choice.actual_cost).toMatchObject(availability === "unavailable"
					? { input_tokens: null, output_tokens: null, cached_input_tokens: null, source: "provider_usage_unavailable" }
					: { input_tokens: availability === "measured" ? 38 : 25,
						output_tokens: availability === "measured" ? 7 : 4,
						cached_input_tokens: availability === "measured" ? 5 : 3, source: "provider_response" });
				expect((await runEngineCommand(options, command)).outcome).toBe("applied");
				expect(mock.calls).toHaveLength(3);
			} finally { await runtime.dispose(); }
		}, 60_000,
	);

	it.each(["admit", "late-child", "stop", "pause", "restart"] as const)(
		"keeps capacity-queued Resume pending with its exact receipt and lease high-watermark: %s", async outcome => {
			const entered = Promise.withResolvers<void>();
			const releaseInitial = Promise.withResolvers<void>();
			const occupied = Promise.withResolvers<void>();
			const releaseOccupant = Promise.withResolvers<void>();
			const mock = createMockModel({ handler: async (context, options) => {
				const input = JSON.stringify(context.messages.findLast(message => message.role === "user")?.content);
				if (input.includes("initial")) { entered.resolve(); await releaseInitial.promise; }
				if (input.includes("occupant")) {
					occupied.resolve();
					const abort = () => releaseOccupant.resolve();
					options?.signal?.addEventListener("abort", abort, { once: true });
					try { await releaseOccupant.promise; options?.signal?.throwIfAborted(); }
					finally { options?.signal?.removeEventListener("abort", abort); }
				}
				return { content: ["finished"] };
			} });
			const env = await setup(mock, (session, input, identity) => session.prompt(input, identity));
			const execution = admittedExecution(mock, env.registry, { scopeAgents: 1 });
			const lateChildExecution = admittedExecution(mock, env.registry, {
				taskRef: "grimoire://tasks/grimoire/late-child", scopeAgents: 1,
			});
			if (outcome === "late-child") {
				lateChildExecution.config.routes.routes[0]!.account_ref = "gctx:bbbbbbbbbbbbbbbb";
				for (const selected of [execution, lateChildExecution]) {
					selected.config.routingLimits.accounts = { "gctx:aaaaaaaaaaaaaaaa": 1, "gctx:bbbbbbbbbbbbbbbb": 1 };
					selected.config.routingLimits.providers[mock.model.provider] = 2;
				}
				env.executions.push(lateChildExecution);
			}
			env.executions.push(execution);
			let runtime = env.runtime;
			const events: EngineEvent[] = [];
			runtime.subscribe(event => { events.push(event); });
			const control = (target: EngineStartResult, op: "resume" | "cancel" | "pause", commandId: string, revision: number) =>
				execution.captureCommand({
					schema: "grimoire.engine.command.v1", op, commandId,
					deviceId: "engine-runtime-test-device", engineId: "engine-runtime-test-engine",
					engineGeneration: runtime.engineGeneration, agentInstanceId: target.agentInstanceId,
					agentInstanceRef: target.bindingSnapshot!.agentInstanceRef, bindingSnapshot: target.bindingSnapshot,
					runtimeBindingId: target.bindingId, bindingGeneration: target.bindingGeneration,
					executionId: target.executionId, attemptId: target.attemptId,
					authorityGeneration: target.authorityGeneration, principalId: "owner", issuedAt: Date.now(),
					payload: { originReceiptId: `origin:${commandId}`, expectedIntentRevision: revision },
				});
			try {
				const target = await env.start("fifo-initial", {}, runtime, execution);
				await withTimeout(entered.promise, 5_000, "Initial provider did not enter");
				const lateChildRef = `${lateChildExecution.taskRef}/agents/late-child`;
				const lateChild = outcome === "late-child" ? startEnvelope(runtime, lateChildExecution,
					startRequest(lateChildExecution, {
						commandId: "late-child-start", agentInstanceId: "late-child", agentInstanceRef: lateChildRef,
						executionId: "late-child-execution", attemptId: "late-child-attempt",
					}, {
						cwd: env.cwd, principalId: "owner", input: "late child",
						parentAgentInstanceId: target.agentInstanceId,
						parentAgentInstanceRef: target.bindingSnapshot!.agentInstanceRef,
						bindingSnapshot: { ...semanticBinding(lateChildRef, lateChildExecution.taskRef),
							parentAgentInstanceRef: target.bindingSnapshot!.agentInstanceRef,
							parentAttemptId: target.attemptId, parentBindingRevision: 0 },
					})) : undefined;
				const paused = Promise.withResolvers<void>();
				runtime.subscribe(event => { if (event.kind === "paused" && event.attemptId === target.attemptId) paused.resolve(); });
				const hold = await runtime.pause({ ...target, commandId: "fifo-pause", initiator: { kind: "human" } });
				releaseInitial.resolve();
				await withTimeout(paused.promise, 5_000, "Initial Attempt did not pause");
				const occupant = await env.start("fifo-occupant", {}, runtime, execution);
				await withTimeout(occupied.promise, 5_000, "Competing provider did not hold capacity");
				const resume = control(target, "resume", "fifo-resume", hold.intentRevision);
				const transport = { runtime, deviceId: resume.deviceId, engineId: resume.engineId };
				await expect(runEngineCommand(transport, resume)).rejects.toMatchObject({ code: "routing_queued" });
				const start = (await runtime.store.records.get("command", target.commandId)).value as unknown as RocksCommand;
				expect(start.routing).toMatchObject({ action: "enqueue", attempt_id: target.attemptId, lease_revision: 1 });
				expect((await runtime.store.records.get("command", resume.commandId)).value).toMatchObject({ state: "received", receipt: null });
				expect((await runtime.store.getAttempt(target.attemptId))?.state).toBe("paused");
				expect((await runtime.store.records.get("metadata", `slot-lease:${target.attemptId}`)).value).toBeNull();
				expect(mock.calls).toHaveLength(2);
				const queueId = start.routing!.queue_id!;
				if (lateChild) {
					expect((await runEngineCommand(transport, lateChild)).outcome).toBe("applied");
					await withTimeout(runtime.store.waitAttemptResult(lateChild.agentInstanceId, lateChild.commandId, lateChild.attemptId),
						5_000, "Late child did not complete");
					await expect(runEngineCommand(transport, resume)).rejects.toMatchObject({ code: "routing_queued" });
					expect((await runtime.store.records.get("command", resume.commandId)).value).toMatchObject({ state: "received", receipt: null });
					expect((await runtime.store.records.get("command", target.commandId)).value).toMatchObject({
						routing: { action: "enqueue", queue_id: queueId, lease_revision: 1 },
					});
				}
				if (outcome === "admit" || outcome === "late-child") {
					const laterRequest = startRequest(execution, {
						commandId: "fifo-later", agentInstanceId: "fifo-later", agentInstanceRef: `${execution.taskRef}/agents/fifo-later`,
						executionId: "fifo-later-execution", attemptId: "fifo-later-attempt",
					}, { cwd: env.cwd, principalId: "owner", input: "later" });
					const later = startEnvelope(runtime, execution, laterRequest);
					await expect(runEngineCommand(transport, later)).rejects.toMatchObject({ code: "routing_queued" });
					releaseOccupant.resolve();
					await withTimeout(Promise.all([
						runtime.store.waitAttemptResult(target.agentInstanceId, target.commandId, target.attemptId),
						runtime.store.waitAttemptResult(later.agentInstanceId, later.commandId, later.attemptId),
					]), 10_000, "FIFO Resume and following Start did not finish");
					expect((await runEngineCommand(transport, resume)).outcome).toBe("applied");
					expect((await runtime.store.records.get("command", target.commandId)).value).toMatchObject({
						routing: { action: "release", lease_revision: 2 },
					});
					expect(events.filter(event => event.kind === "resumed" && event.attemptId === target.attemptId)).toHaveLength(1);
					expect(events.findIndex(event => event.kind === "resumed" && event.attemptId === target.attemptId))
						.toBeLessThan(events.findIndex(event => event.kind === "model_started" && event.attemptId === later.attemptId));
					expect(mock.calls).toHaveLength(outcome === "late-child" ? 4 : 3);
				} else if (outcome === "stop" || outcome === "pause") {
					const newer = control(target, outcome === "stop" ? "cancel" : "pause", `fifo-${outcome}`,
						(await runtime.store.intent(target.agentInstanceId)).intentRevision);
					expect((await withTimeout(runEngineCommand(transport, newer), 5_000, "New control was blocked by queued Resume")).outcome).toBe("applied");
					if (outcome === "pause") {
						expect((await runtime.store.getAttempt(target.attemptId))?.state).toBe("paused");
						expect((await runtime.store.intent(target.agentInstanceId)).manualHold).toBe(true);
					}
					const refused = await runEngineCommand(transport, resume).then(() => false,
						error => error instanceof EngineTargetError && ["stale_target", "invalid_request"].includes(error.code));
					expect(refused).toBe(true);
					expect((await runtime.store.records.get("command", resume.commandId)).value).toMatchObject({
						state: "settled", receipt: { outcome: "rejected" },
					});
				} else {
					await runtime.dispose();
					runtime = await open(env.options);
					expect((await runtime.store.records.get("command", resume.commandId)).value).toMatchObject({
						state: "settled", receipt: { outcome: "rejected" },
					});
					expect((await runtime.store.getAttempt(target.attemptId))?.state).not.toBe("running");
				}
				expect((await runtime.store.records.get("metadata", queueId)).value).toMatchObject({
					status: outcome === "admit" || outcome === "late-child" ? "accepted" : "cancelled",
				});
				releaseOccupant.resolve();
				if (outcome !== "restart")
					await withTimeout(runtime.store.waitAttemptResult(occupant.agentInstanceId, occupant.commandId, occupant.attemptId),
						5_000, "Competing Attempt did not finish");
			} finally { releaseInitial.resolve(); releaseOccupant.resolve(); await runtime.dispose(); }
		}, 60_000,
	);
});
