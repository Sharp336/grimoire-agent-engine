import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DiscardPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	EngineControlQueryClient,
	type EngineControlQueryServer,
	startEngineControlQueryServer,
} from "@oh-my-pi/pi-coding-agent/engine/control-query";
import { EngineBindingPendingError } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import {
	AGENT_MESSAGE_STREAM,
	ENGINE_COMMAND_STREAM,
	ENGINE_EVENT_STREAM,
	type EngineCommandEnvelope,
	engineCommandIdentity,
	NatsEngineAdapter,
} from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import { engineAgentId, engineAgentInstanceId } from "@oh-my-pi/pi-coding-agent/engine/route";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { runtimeLimits } from "@oh-my-pi/pi-coding-agent/engine/runtime-protocol";
import { EngineCommandConflictError } from "@oh-my-pi/pi-coding-agent/engine/store";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { bindTestsToStorageWorker, storageWorkerUnavailable } from "./helpers/storage-worker-fixture";
import { semanticBinding } from "./helpers/runtime-v1-rocks-fixture";
import {
	admitStart,
	admittedExecution,
	approvalDecisionFor,
	startRequest,
	type AdmittedExecutionFixture,
} from "./helpers/engine-runtime-admitted-fixture";

const installedNatsServer = path.join(process.env.LOCALAPPDATA ?? "", "Grimoire", "bin", "nats-server.exe");
const natsServer = process.env.GRIMOIRE_NATS_SERVER ?? installedNatsServer;

describe.skipIf(!fs.existsSync(natsServer) || storageWorkerUnavailable)("NatsEngineAdapter", () => {
	bindTestsToStorageWorker();
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});
	it("acknowledges oversized retained receipts through NATS and native IPC without starting another Attempt", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-receipt-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const mock = createMockModel({ handler: { content: ["done"] } });
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "isolated-test");
		const execution = admittedExecution(mock.model, new ModelRegistry(auth, path.join(tempDir, "models.yml")));
		let resolverCalls = 0;
		const baseOptions = execution.optionsFor({ deviceId: "device-1" });
		const executionRuntime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			...baseOptions,
			resolveExecution: async (config, frozen, attempt, resolverCwd, signal) => {
				resolverCalls++;
				return baseOptions.resolveExecution!(config, frozen, attempt, resolverCwd, signal);
			},
		});
		const client = await connect({ servers: broker.url });
		const command = startCommand(executionRuntime.engineGeneration, "legacy-receipt-agent", "legacy-receipt", tempDir);
		command.agentInstanceRef = "grimoire://tasks/grimoire/legacy-receipt/agents/agent";
		command.bindingSnapshot = semanticBinding(command.agentInstanceRef);
		command.principalId = "owner";
		command.browserPayloadHash = `sha256:${"a".repeat(64)}`;
		command.browserTarget = { agentInstanceRef: command.agentInstanceRef };
		const identity = engineCommandIdentity(command);
		const errors: Error[] = [];
		const options = {
			runtime: executionRuntime,
			runtimeDir: tempDir,
			deviceId: command.deviceId,
			engineId: command.engineId,
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			onError: (error: Error) => errors.push(error),
		};
		let server: EngineControlQueryServer | undefined;
		let adapter: NatsEngineAdapter | undefined;
		try {
			await executionRuntime.store.admitCommand(identity, executionRuntime.engineGeneration);
			// Beyond one live change, below one storage write: the receipt is retained whole but projected bounded.
			await executionRuntime.store.settleCommand(identity.commandId, identity.canonicalHash, {
				outcome: "applied",
				detail: { text: "legacy".repeat(20_000) },
			});
			server = await startEngineControlQueryServer(options);
			adapter = await NatsEngineAdapter.connect(options);
			const native = new EngineControlQueryClient(tempDir);
			const receipt = await native.request("command", { command });
			expect(receipt).toEqual({
				outcome: "applied",
				detail: { partial: true, unavailable: "result_exceeds_projection_limit" },
			});
			expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(runtimeLimits.liveChangeBytes);
			expect(
				await native.request("runtime.command.get", { commandId: command.commandId, principalId: "owner" }),
			).toMatchObject({
				stage: "applied",
				lookup: "known",
				target: command.browserTarget,
				payloadHash: command.browserPayloadHash,
			});
			const manager = await jetstreamManager(client);
			await jetstream(client).publish(
				adapter.commandSubject(command.agentInstanceId, command.op),
				JSON.stringify(command),
				{ msgID: "retained-replay" },
			);
			await waitFor(async () => {
				const info = await manager.consumers.info(ENGINE_COMMAND_STREAM, `engine_${adapter!.engineRoute}`);
				return info.delivered.consumer_seq > 0 && info.num_ack_pending === 0;
			});
			expect(resolverCalls).toBe(0);
			expect(await executionRuntime.store.getAttempt(command.attemptId!)).toBeUndefined();
			expect(errors).toEqual([]);
		} finally {
			await server?.close();
			await adapter?.dispose();
			await executionRuntime.dispose();
			await client.drain();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30_000);

	it("opens before backlog delivery and stops after one final page without losing restart delivery", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-stop-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const databasePath = path.join(tempDir, "engine.sqlite");
		const mock = createMockModel({ handler: { content: ["done"] } });
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "isolated-test");
		const execution = admittedExecution(mock.model, new ModelRegistry(auth, path.join(tempDir, "models.yml")));
		const typedOptions = execution.optionsFor({ deviceId: "stop-device" });
		let runtime = await EngineRuntime.create({ databasePath, ...typedOptions });
		const client = await connect({ servers: broker.url });
		const options = {
			deviceId: "stop-device",
			engineId: "stop-engine",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
		};
		const pending = runtime.store.pendingEventsForSink.bind(runtime.store);
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const deliveryFailed = Promise.withResolvers<void>();
		let pages = 0,
			adapter: NatsEngineAdapter | undefined,
			connecting: Promise<NatsEngineAdapter> | undefined;
		try {
			for (let index = 0; index < 201; index++)
				await runtime.store.appendEvent({
					causationCommandId: `stop-event-${index}`,
					agentInstanceId: "stop-agent",
					executionId: "stop-execution",
					attemptId: "stop-attempt",
					bindingId: "stop-binding",
					engineGeneration: runtime.engineGeneration,
					bindingGeneration: 1,
					authorityGeneration: 1,
					kind: "trace_reasoning",
					payload: { index },
				});
			runtime.store.pendingEventsForSink = async (...args) => {
				pages++;
				const page = await pending(...args);
				entered.resolve();
				await release.promise;
				return page;
			};
			connecting = NatsEngineAdapter.connect({ ...options, runtime }).then(value => {
				adapter = value;
				return value;
			});
			await entered.promise;
			await waitFor(async () => Boolean(adapter), 2000);
			const current = adapter!;
			const sink = `nats:${current.deviceRoute}:${current.engineRoute}`;
			let disposed = false;
			const stopping = current.dispose().then(() => {
				disposed = true;
			});
			await Bun.sleep(25);
			expect(disposed).toBe(false);
			release.resolve();
			await stopping;
			expect(pages).toBe(2);
			const acknowledged = await pending(sink);
			expect(acknowledged.events).toEqual([]);
			expect(acknowledged.scannedRecords).toBe(100);
			const finalPage = await pending(sink, 100, acknowledged.throughCursor);
			expect(finalPage.events).toEqual([]);
			expect(finalPage.scannedRecords).toBe(100);
			expect((await pending(sink, 100, finalPage.throughCursor)).events).toHaveLength(1);
			const manager = await jetstreamManager(client);
			expect((await manager.streams.info(ENGINE_EVENT_STREAM)).state.messages).toBe(200);
			runtime.store.pendingEventsForSink = pending;
			await runtime.dispose();
			runtime = await EngineRuntime.create({ databasePath, ...typedOptions });
			// The retained final event meets a real broker rejection during cold recovery.
			await manager.streams.update(ENGINE_EVENT_STREAM, { max_msgs: 200, discard: DiscardPolicy.New });
			adapter = await NatsEngineAdapter.connect({ ...options, runtime, onError: () => deliveryFailed.resolve() });
			await deliveryFailed.promise;
			expect((await runtime.store.pendingEventsForSink(sink, 100, finalPage.throughCursor)).events).toHaveLength(1);
			await manager.streams.update(ENGINE_EVENT_STREAM, { max_msgs: -1, discard: DiscardPolicy.Old });
			// No new runtime event or explicit flush wakes the adapter after recovery.
			await waitFor(
				async () =>
					(await runtime.store.pendingEventsForSink(sink, 100, finalPage.throughCursor)).events.length === 0,
				20_000,
			);
			expect((await runtime.store.pendingEventsForSink(sink)).events).toEqual([]);
			expect((await manager.streams.info(ENGINE_EVENT_STREAM)).state.messages).toBe(201);
		} finally {
			release.resolve();
			if (connecting) adapter ??= await connecting;
			await adapter?.dispose();
			await runtime.dispose();
			await client.drain();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30000);

	it("applies a paused queue command before an unrelated event delivery drain completes", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-queue-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "isolated-test");
		const models = new ModelRegistry(auth, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const boundaryPath = path.join(cwd, "boundary.txt");
		fs.writeFileSync(boundaryPath, "safe boundary");
		registerMockApi("nats-queue-boundary");
		const providerEntered = Promise.withResolvers<void>();
		const providerBoundary = Promise.withResolvers<void>();
		let providerCalls = 0;
		const mock = createMockModel({
			handler: async () => {
				providerCalls++;
				providerEntered.resolve();
				await providerBoundary.promise;
				return {
					content: [{ type: "toolCall", id: "read-boundary", name: "read", arguments: { path: boundaryPath } }],
				};
			},
		});
		const execution = admittedExecution(mock.model, models);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: (session, input, identity) => session.prompt(input, identity),
			...execution.optionsFor({ deviceId: "queue-device", sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: await Settings.loadReadOnly({ cwd, agentDir: path.join(tempDir, "agent") }),
				model: mock.model,
				modelRegistry: models,
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
			} }),
		});
		const errors: Error[] = [];
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "queue-device",
			engineId: "queue-engine",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			onError: error => errors.push(error),
		});
		const client = await connect({ servers: broker.url });
		const pending = runtime.store.pendingEventsForSink.bind(runtime.store);
		const releaseDelivery = Promise.withResolvers<void>();
		try {
			const agentInstanceRef = "grimoire://tasks/grimoire/queue-boundary/agents/paused";
			const started = await admitStart(runtime, execution, startRequest(execution, {
				commandId: "queue-start",
				agentInstanceId: engineAgentInstanceId(agentInstanceRef),
				agentInstanceRef,
				executionId: "queue-execution",
				attemptId: "queue-attempt",
			}, { cwd, principalId: "queue-owner", input: "work" }), { deviceId: "queue-device", engineId: "queue-engine" });
			await providerEntered.promise;
			const hold = await runtime.pause({ ...started, commandId: "queue-pause", initiator: { kind: "human" } });
			providerBoundary.resolve();
			await waitFor(async () => (await runtime.store.getAttempt(started.attemptId))?.state === "paused");
			await adapter.flushEvents();
			const deliveryEntered = Promise.withResolvers<void>();
			runtime.store.pendingEventsForSink = async (...args) => {
				deliveryEntered.resolve();
				await releaseDelivery.promise;
				return await pending(...args);
			};
			const draining = adapter.flushEvents();
			await deliveryEntered.promise;
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "queued-while-delivery-busy",
				op: "enqueue",
				deviceId: "queue-device",
				engineId: "queue-engine",
				engineGeneration: runtime.engineGeneration,
				agentInstanceRef,
				agentInstanceId: started.agentInstanceId,
				principalId: "queue-owner",
				browserPayloadHash: `sha256:${"a".repeat(64)}`,
				browserTarget: { agentInstanceRef },
				authorityGeneration: 1,
				issuedAt: Date.now(),
				payload: {
					clientMessageId: "paused-queue-item",
					text: "remain queued",
					expectedIntentRevision: hold.intentRevision,
				},
			};
			command.payload.originReceiptId = "origin:queued-while-delivery-busy";
			execution.captureCommand(command);
			await jetstream(client).publish(
				adapter.commandSubject(started.agentInstanceId, "enqueue"),
				JSON.stringify(command),
			);
			await waitFor(
				async () =>
					(await runtime.store.runtimeCommand(command.commandId, { principalId: "queue-owner" })).stage ===
					"applied",
				2000,
			);
			expect(await runtime.listInbox(started)).toMatchObject([
				{ queueId: "paused-queue-item", disposition: "pending", deliveryPayload: "remain queued" },
			]);
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");
			expect((await runtime.store.intent(started.agentInstanceId)).manualHold).toBe(true);
			expect(providerCalls).toBe(1);
			expect(errors).toEqual([]);
			releaseDelivery.resolve();
			await draining;
		} finally {
			providerBoundary.resolve();
			releaseDelivery.resolve();
			runtime.store.pendingEventsForSink = pending;
			await client.drain();
			await adapter.dispose();
			await runtime.dispose();
			auth.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30000);

	it("redelivers a released paused message Resume claim through NATS without a second user entry or Attempt", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-resume-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "isolated-test");
		const models = new ModelRegistry(auth, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		registerMockApi("nats-paused-resume");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["initial"] };
				},
				{ content: ["corrected"] },
			],
		});
		const execution = admittedExecution(mock.model, models);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: (session, input, identity) => session.prompt(input, identity),
			...execution.optionsFor({ deviceId: "resume-device", sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: await Settings.loadReadOnly({ cwd, agentDir: path.join(tempDir, "agent") }),
				model: mock.model,
				modelRegistry: models,
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
			} }),
		});
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "resume-device",
			engineId: "resume-engine",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
		});
		const client = await connect({ servers: broker.url });
		try {
			const agentInstanceRef = "grimoire://tasks/grimoire/resume-boundary/agents/paused";
			const started = await admitStart(runtime, execution, startRequest(execution, {
				commandId: "nats-resume-start",
				agentInstanceId: engineAgentInstanceId(agentInstanceRef),
				agentInstanceRef,
				executionId: "nats-resume-execution",
				attemptId: "nats-resume-attempt",
			}, { cwd, principalId: "owner", input: "initial work" }), { deviceId: "resume-device", engineId: "resume-engine" });
			await entered.promise;
			const hold = await runtime.pause({
				...started,
				commandId: "nats-resume-pause",
				initiator: { kind: "human" },
				expectedIntentRevision: started.intentRevision,
			});
			release.resolve();
			await waitFor(async () => (await runtime.store.getAttempt(started.attemptId))?.state === "paused");
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "nats-resume-message",
				op: "resume",
				deviceId: "resume-device",
				engineId: "resume-engine",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId: started.agentInstanceId,
				agentInstanceRef,
				runtimeBindingId: started.bindingId,
				bindingGeneration: started.bindingGeneration,
				executionId: started.executionId,
				attemptId: started.attemptId,
				authorityGeneration: started.authorityGeneration,
				principalId: "owner",
				browserPayloadHash: `sha256:${"a".repeat(64)}`,
				browserTarget: { agentInstanceRef, executionId: started.executionId, attemptId: started.attemptId },
				issuedAt: Date.now(),
				payload: {
					initiator: { kind: "human" },
					expectedIntentRevision: hold.intentRevision,
					text: "correct this answer",
					clientMessageId: "nats-resume-user-message",
				},
			};
			command.payload.originReceiptId = "origin:nats-resume-message";
			execution.captureCommand(command);
			const identity = engineCommandIdentity(command);
			expect(await runtime.store.admitCommand(identity, runtime.engineGeneration)).toMatchObject({ status: "claimed" });
			await runtime.store.releaseCommand(command.commandId, identity.canonicalHash, runtime.engineGeneration);
			const subject = adapter.commandSubject(started.agentInstanceId, "resume");
			await jetstream(client).publish(subject, JSON.stringify(command), { msgID: "resume-released-claim" });
			await waitFor(async () =>
				(await runtime.store.runtimeCommand(command.commandId, { principalId: "owner" })).stage === "applied",
			);
			await runtime.drain();
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
			expect(mock.calls).toHaveLength(2);
			const session = runtime.agentRegistry.get(started.engineAgentId)?.session;
			expect(session?.sessionManager.getContextBranch().filter(entry =>
				entry.type === "message" && entry.clientMessageId === "nats-resume-user-message",
			)).toHaveLength(1);
			expect(await runtime.store.admitCommand(identity, runtime.engineGeneration)).toMatchObject({
				status: "replay",
				receipt: { outcome: "applied" },
			});
			expect(mock.calls).toHaveLength(2);
			expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
		} finally {
			release.resolve();
			await client.drain();
			await adapter.dispose();
			await runtime.dispose();
			auth.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 60_000);

	it("runs two agent command routes, event outbox and an offline durable mailbox", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("mock", "isolated-test");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		fs.writeFileSync(path.join(cwd, "permit.txt"), "approved through broker");
		let dispatchCount = 0;
		let permitExecuted = false;
		let hubQueueId = "";
		const runningA = Promise.withResolvers<void>();
		const releaseA = Promise.withResolvers<void>();
		registerMockApi("nats-native-tool-turns");
		const toolModel = createMockModel({
			handler: async context => {
				const results = context.messages.filter(message => message.role === "toolResult");
				const user = context.messages.findLast(message => message.role === "user");
				if (JSON.stringify(user?.content ?? "").includes("NATIVE HUB")) {
					const steps = [
						{ id: "hub-inbox-list", args: { op: "inbox" } },
						{ id: "hub-inbox-edit", args: { op: "inbox", inboxAction: "edit", queueId: hubQueueId,
							expectedRevision: 1, deliveryPayload: "edited through native hub" } },
						{ id: "hub-inbox-edit-replay", args: { op: "inbox", inboxAction: "edit", queueId: hubQueueId,
							expectedRevision: 1, deliveryPayload: "edited through native hub" } },
						{ id: "hub-inbox-defer", args: { op: "inbox", inboxAction: "defer", queueId: hubQueueId,
							expectedRevision: 2, deliverAt: Date.now() + 50 } },
					];
					for (const step of steps) {
						const result = results.find(message => message.toolCallId === step.id);
						if (!result) {
							if (step.id === "hub-inbox-defer")
								expect(await runtime.store.getInboxItemByQueueId(hubQueueId)).toMatchObject({
									sourceBody: "broker round trip", deliveryPayload: "edited through native hub", revision: 2,
								});
							return { content: [{ type: "toolCall" as const, id: step.id, name: "hub", arguments: step.args }] };
						}
						expect(result.isError).toBeFalse();
						if (step.id === "hub-inbox-list") expect(JSON.stringify(result.content)).toContain("broker round trip");
					}
					return { content: ["Inbox updated through native hub"] };
				}
				const readResult = results.find(message => message.toolCallId === "read-permit");
				if (!readResult)
					return { content: [{ type: "toolCall" as const, id: "read-permit", name: "read", arguments: { path: "permit.txt" } }] };
				expect(readResult.isError).toBeFalse();
				expect(JSON.stringify(readResult.content)).toContain("approved through broker");
				permitExecuted = true;
				return { content: ["Approved file read completed"] };
			},
		});
		const execution = admittedExecution(toolModel.model, modelRegistry, {
			continuation: { toolPolicies: { read: "permit" } },
			scopeAgents: 8,
		});
		const runtime: EngineRuntime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async (session, input, identity) => {
				dispatchCount++;
				// Tracked tools must run through the agent loop so their toolResult is durably persisted.
				if (session.getAgentId() === engineAgentId("agent-permit") || input === "NATIVE HUB")
					return session.prompt(input, identity);
				session.sessionManager.appendMessage({ role: "user", content: input, timestamp: Date.now() }, identity);
				if (session.getAgentId() === engineAgentId("agent-a") && input === "A") {
					runningA.resolve();
					await releaseA.promise;
				}
				return true;
			},
			...execution.optionsFor({ deviceId: "device-1", sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: await Settings.loadReadOnly({
					cwd,
					agentDir: path.join(tempDir, "agent"),
					overrides: { "bash.autoBackground.enabled": true },
				}),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
				model: toolModel.model,
			} }),
		});
		const errors: Error[] = [];
		const reportFailure = new Error("Conflict reporter failed");
		let failConflictReport = false;
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-1",
			engineId: "engine-1",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			onError: error => {
				errors.push(error);
				if (failConflictReport && error instanceof EngineCommandConflictError) {
					failConflictReport = false;
					throw reportFailure;
				}
			},
		});
		const client = await connect({ servers: broker.url });
		try {
			const js = jetstream(client);
			const manager = await jetstreamManager(client);
			const decoder = new TextDecoder();
			const eventsA: Array<Record<string, unknown>> = [];
			const eventsB: Array<Record<string, unknown>> = [];
			const permitEvents: Array<Record<string, unknown>> = [];
			const subA = client.subscribe(adapter.eventSubject("agent-a", "*"), {
				callback: (_error, message) => {
					eventsA.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const subB = client.subscribe(adapter.eventSubject("agent-b", "*"), {
				callback: (_error, message) => {
					eventsB.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const permitSub = client.subscribe(adapter.eventSubject("agent-permit", "*"), {
				callback: (_error, message) => {
					permitEvents.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const commandConsumer = `engine_${adapter.engineRoute}`;
			const terminatedCommands: Array<Record<string, unknown>> = [];
			const terminatedSub = client.subscribe(
				`$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${ENGINE_COMMAND_STREAM}.${commandConsumer}`,
				{ callback: (_error, message) => { terminatedCommands.push(JSON.parse(decoder.decode(message.data))); } },
			);
			await client.flush();

			const commandA = startCommand(runtime.engineGeneration, "agent-a", "a", cwd, execution);
			commandA.agentInstanceRef = "grimoire://tasks/grimoire/nats-test/agents/agent-a";
			commandA.bindingSnapshot = semanticBinding(commandA.agentInstanceRef, execution.taskRef);
			commandA.payload.clientMessageId = "client-message-a";
			commandA.payload = {
				...commandA.payload,
				displayName: "Runtime Gardener",
				delegationHint: "Engine broker integration",
			};
			execution.captureCommand(commandA);
			const commandB = startCommand(runtime.engineGeneration, "agent-b", "b", cwd, execution);
			execution.captureCommand(commandB);
			await Promise.all([
				js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(commandA), {
					msgID: commandA.commandId,
				}),
				js.publish(adapter.commandSubject("agent-b", "start"), JSON.stringify(commandB), {
					msgID: commandB.commandId,
				}),
			]);
			await runningA.promise;
			await waitFor(async () =>
				(await runtime.store.admitCommand(engineCommandIdentity(commandA), runtime.engineGeneration)).status === "replay",
			);
			const originalAReceipt = await runtime.store.admitCommand(engineCommandIdentity(commandA), runtime.engineGeneration);
			const originalAIdentity = await runtime.store.getStartConversationIdentity(commandA.commandId);
			const originalAAttempt = (await runtime.store.getAttempt(commandA.attemptId!))!;
			expect(originalAAttempt.state).toBe("running");
			const conflictDelivery = await js.publish(
				adapter.commandSubject("agent-a", "start"),
				JSON.stringify({ ...commandA, issuedAt: Date.now(), payload: { ...commandA.payload, input: "CHANGED" } }),
				{ msgID: "transport-command-a-conflict" },
			);
			await waitFor(async () =>
				terminatedCommands.some(event => event.stream_seq === conflictDelivery.seq) &&
				(await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).num_ack_pending === 0,
			);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toBeInstanceOf(EngineCommandConflictError);
			expect(errors[0]).toMatchObject({ reason: "canonical_content" });
			errors.splice(0, 1);
			await adapter.flushEvents();
			await waitFor(() => eventsA.some(event => event.type === "attempt.started"));
			expect(eventsA.filter(event =>
				event.type === "command.rejected" || ["attempt.completed", "attempt.failed", "attempt.cancelled", "attempt.interrupted"].includes(String(event.type)),
			)).toEqual([]);
			expect((await runtime.store.pendingEventsForSink("test-running-conflict-audit")).events.filter(event =>
				event.causationCommandId === commandA.commandId &&
				["rejected", "completed", "failed", "cancelled", "interrupted"].includes(event.kind),
			)).toEqual([]);
			expect(await runtime.store.admitCommand(engineCommandIdentity(commandA), runtime.engineGeneration)).toEqual(originalAReceipt);
			expect(await runtime.store.getStartConversationIdentity(commandA.commandId)).toEqual(originalAIdentity);
			// The original running Attempt may advance its transcript while the collision is terminated.
			const retainedAAttempt = (await runtime.store.getAttempt(commandA.attemptId!))!;
			expect(retainedAAttempt.binding_snapshot).toEqual(originalAAttempt.binding_snapshot);
			expect(retainedAAttempt).toMatchObject({
				agent_instance_id: originalAAttempt.agent_instance_id,
				execution_id: originalAAttempt.execution_id,
				attempt_id: originalAAttempt.attempt_id,
				command_id: originalAAttempt.command_id,
				binding_id: originalAAttempt.binding_id,
				engine_generation: originalAAttempt.engine_generation,
				binding_generation: originalAAttempt.binding_generation,
				authority_generation: originalAAttempt.authority_generation,
				state: "running",
				cause: originalAAttempt.cause,
			});
			releaseA.resolve();
			await waitFor(async () =>
				(await Promise.all([runtime.store.getAttempt("attempt-a"), runtime.store.getAttempt("attempt-b")])).every(
					attempt => attempt?.state === "completed",
				),
			);
			await adapter.flushEvents();
			await waitFor(
				() =>
					eventsA.some(event => event.type === "attempt.completed") &&
					eventsB.some(event => event.type === "attempt.completed"),
			);
			expect(eventsA.every(event => event.agentInstanceId === "agent-a")).toBeTrue();
			expect(eventsB.every(event => event.agentInstanceId === "agent-b")).toBeTrue();
			for (const [events, command] of [[eventsA, commandA], [eventsB, commandB]] as const) {
				// A durable checkpoint may be observed between model lifecycle events.
				// It must retain this exact occurrence, not masquerade as another lifecycle transition.
				for (const event of events.filter(event => event.type === "reconcile.snapshot")) {
					expect(event).toMatchObject({
						agentInstanceId: command.agentInstanceId,
						attemptId: command.attemptId,
						executionId: command.executionId,
						causationCommandId: command.commandId,
						bindingSnapshot: command.bindingSnapshot,
						payload: { transcriptCheckpoint: { sessionPath: expect.stringMatching(/^native:/) } },
					});
					const payload = event.payload;
					if (!payload || typeof payload !== "object" || !("transcriptCheckpoint" in payload))
						throw new Error("Reconciliation observation has no checkpoint");
					const checkpoint = payload.transcriptCheckpoint;
					if (!checkpoint || typeof checkpoint !== "object" || !("revision" in checkpoint))
						throw new Error("Reconciliation checkpoint has no revision");
					expect(checkpoint.revision).toBeGreaterThan(0);
				}
				expect(events.filter(event => event.type !== "reconcile.snapshot").map(event => event.type)).toEqual([
					"attempt.agent_registered",
					"command.accepted",
					"attempt.started",
					"model.started",
					"model.settled",
					"attempt.completed",
				]);
			}
			expect(dispatchCount).toBe(2);
			expect(await runtime.sessionHistoryPage("agent-a", "grimoire://tasks/grimoire/nats/agents/a")).toMatchObject({
				entries: [
					{
						role: "user",
						text: "A",
						sourceCommandId: commandA.commandId,
						clientMessageId: "client-message-a",
					},
				],
			});
			expect(runtime.agentRegistry.get(engineAgentId("agent-a"))).toMatchObject({
				id: engineAgentId("agent-a"),
				displayName: "Runtime Gardener",
				delegationHint: "Engine broker integration",
			});

			const permitStart = startCommand(runtime.engineGeneration, "agent-permit", "permit", cwd, execution);
			execution.captureCommand(permitStart);
			await js.publish(
				adapter.commandSubject("agent-permit", "start"), JSON.stringify(permitStart), {
				msgID: permitStart.commandId,
			});
			await waitFor(() => permitEvents.some(event => event.type === "tool.approval_requested"));
			expect(permitExecuted).toBeFalse();
			const approval = permitEvents.find(event => event.type === "tool.approval_requested")!;
			const approvalPayload = approval.payload;
			if (!approvalPayload || typeof approvalPayload !== "object" || !("id" in approvalPayload) || typeof approvalPayload.id !== "string")
				throw new Error("Approval event has no request identity");
			const approvalId = approvalPayload.id;
			const permitTarget = runtime.getBinding("agent-permit")!;
			const decision = approvalDecisionFor(execution, { ...permitTarget, principalId: "owner" },
				"command-resolve-permit", (await runtime.store.getApproval(approvalId))!.request, "approve");
			const resolveApproval: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "command-resolve-permit",
				op: "resolve_approval",
				deviceId: "device-1",
				engineId: "engine-1",
				engineGeneration: Number(approval.engineGeneration),
				agentInstanceId: "agent-permit",
				agentInstanceRef: permitTarget.bindingSnapshot?.agentInstanceRef,
				runtimeBindingId: String(approval.runtimeBindingId),
				bindingGeneration: Number(approval.bindingGeneration),
				executionId: String(approval.executionId),
				attemptId: String(approval.attemptId),
				authorityGeneration: Number(approval.authorityGeneration),
				principalId: "owner",
				issuedAt: Date.now(),
				payload: { approvalDecision: decision, expectedInputRevision: (await runtime.store.getAttempt(permitTarget.attemptId))!.input_revision },
			};
			resolveApproval.payload.originReceiptId = decision.origin_receipt_id;
			execution.captureCommand(resolveApproval);
			await js.publish(
				adapter.commandSubject("agent-permit", "resolve_approval"),
				JSON.stringify(resolveApproval),
				{ msgID: resolveApproval.commandId },
			);
			await waitFor(async () => (await runtime.store.getAttempt("attempt-permit"))?.state === "completed");
			await adapter.flushEvents();
			await waitFor(() => permitEvents.some(event => event.type === "attempt.completed"));
			expect(permitExecuted).toBeTrue();
			expect(permitEvents.filter(event =>
				/^(?:command|tool|model)\./.test(String(event.type)) ||
				/^attempt\.(?:agent_registered|started|completed|failed|cancelled|interrupted)$/.test(String(event.type)),
			).map(event => event.type)).toEqual([
				"attempt.agent_registered",
				"command.accepted",
				"attempt.started",
				"model.started",
				"tool.approval_requested",
				"tool.approval_resolved",
				"tool.started",
				"tool.settled",
				"model.settled",
				"attempt.completed",
			]);
			permitSub.unsubscribe();

			const receipt = await runtime.ircBus.send({
				from: engineAgentId("agent-a"),
				to: engineAgentId("agent-b"),
				body: "broker round trip",
			});
			expect(receipt.outcome).toBe("queued");
			const rootB = runtime.agentRegistry.get(engineAgentId("agent-b"));
			if (!rootB?.session) throw new Error("root B session is unavailable");
			const initialBindingB = await runtime.store.getBinding("agent-b");
			if (!initialBindingB) throw new Error("root B binding is unavailable");
			await waitFor(async () => (await runtime.listInbox(initialBindingB)).length === 1);
			expect(await runtime.listInbox(initialBindingB)).toMatchObject([
				{ sourceType: "agent", sender: "agent-a", deliveryPayload: "broker round trip", disposition: "pending" },
			]);
			expect(JSON.stringify(rootB.session.messages)).not.toContain("broker round trip");
			expect(JSON.stringify(rootB.session.messages)).not.toContain("engine:inbox_changed");
			hubQueueId = (await runtime.listInbox(initialBindingB))[0]!.queueId;
			const hubStart = startCommand(runtime.engineGeneration, "agent-b", "native-hub", cwd, execution);
			hubStart.payload.input = "NATIVE HUB";
			execution.captureCommand(hubStart);
			await js.publish(adapter.commandSubject("agent-b", "start"), JSON.stringify(hubStart), {
				msgID: hubStart.commandId,
			});
			await waitFor(async () => (await runtime.store.getAttempt(hubStart.attemptId!))?.state === "completed");
			const bindingB = await runtime.store.getBinding("agent-b");
			if (!bindingB) throw new Error("Native hub Attempt binding is unavailable");
			await adapter.flushEvents();
			expect(
				eventsB.filter(
					event =>
						event.type === "attempt.inbox_changed" &&
						(event.payload as Record<string, unknown>).action === "edit",
				),
			).toHaveLength(1);
			expect((await runtime.listInbox(bindingB))[0]).toMatchObject({
				sourceBody: "broker round trip",
				deliveryPayload: "edited through native hub",
			});
			await waitFor(() =>
				eventsB.some(
					event =>
						event.type === "attempt.inbox_changed" &&
						(event.payload as Record<string, unknown>).action === "wake_due",
				),
			);
			await Bun.sleep(150);
			expect(
				eventsB.filter(
					event =>
						event.type === "attempt.inbox_changed" &&
						(event.payload as Record<string, unknown>).action === "wake_due",
				),
			).toHaveLength(1);
			expect((await runtime.listInbox(bindingB))[0]).toMatchObject({ wakeIntent: true, revision: 4 });
			runtime.agentRegistry.register({
				id: "native-child-b1",
				displayName: "child B1",
				kind: "sub",
				parentId: engineAgentId("agent-b"),
				session: rootB.session,
				status: "idle",
			});
			const childReceipt = await runtime.ircBus.send({
				from: engineAgentId("agent-a"),
				to: "native-child-b1",
				body: "durable child mailbox",
			});
			expect(childReceipt.outcome).toBe("queued");
			await waitFor(async () => (await runtime.listInbox(bindingB)).length === 2);
			expect((await runtime.listInbox(bindingB)).map(item => item.deliveryPayload)).toEqual([
				"edited through native hub",
				"durable child mailbox",
			]);
			runtime.agentRegistry.unregister("native-child-b1", rootB.session);

			const deliveredBefore = (await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).delivered
				.consumer_seq;
			const duplicateA = { ...commandA, commandId: "command-a-redelivery", issuedAt: Date.now() };
			duplicateA.payload.originReceiptId = "origin:command-a-redelivery";
			execution.captureCommand(duplicateA);
			await js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(duplicateA), {
				msgID: duplicateA.commandId,
			});
			await waitFor(
				async () =>
					(await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).delivered.consumer_seq >
					deliveredBefore,
			);
			expect(dispatchCount).toBe(4);

			const deliveredBeforeReplay = (await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).delivered
				.consumer_seq;
			await js.publish(
				adapter.commandSubject("agent-a", "start"),
				JSON.stringify({ ...commandA, issuedAt: Date.now() }),
				{
					msgID: "transport-command-a-replay",
				},
			);
			await waitFor(async () => {
				const info = await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer);
				return info.delivered.consumer_seq > deliveredBeforeReplay && info.num_pending === 0 && info.num_ack_pending === 0;
			});
			expect(dispatchCount).toBe(4);
			// Reconcile settles inside commitEvent, before the adapter's final settleCommand call.
			// Hold dispatch after admission so the known winner is durable before the real loser runs.
			const settlementCommand: EngineCommandEnvelope = {
				...commandA, commandId: "command-settlement-race", op: "reconcile", payload: {},
			};
			settlementCommand.payload.originReceiptId = "origin:command-settlement-race";
			execution.captureCommand(settlementCommand);
			const winningReceipt = { outcome: "rejected" as const, detail: { code: "cancelled" } };
			const settlementIdentity = engineCommandIdentity(settlementCommand);
			const settlementEntered = Promise.withResolvers<void>();
			const releaseSettlement = Promise.withResolvers<void>();
			const reconcile = runtime.reconcile.bind(runtime);
			const racingSettlement = spyOn(runtime, "reconcile").mockImplementation(async request => {
				if (request.commandId === settlementCommand.commandId) {
					settlementEntered.resolve();
					await releaseSettlement.promise;
				}
				return reconcile(request);
			});
			failConflictReport = true;
			try {
				const delivery = await js.publish(
					adapter.commandSubject("agent-a", "reconcile"), JSON.stringify(settlementCommand),
					{ msgID: settlementCommand.commandId },
				);
				await settlementEntered.promise;
				expect(await runtime.store.admitCommand(settlementIdentity, runtime.engineGeneration)).toEqual({
					status: "in_progress",
				});
				await runtime.store.settleCommand(
					settlementIdentity.commandId, settlementIdentity.canonicalHash, winningReceipt,
				);
				expect(await runtime.store.admitCommand(settlementIdentity, runtime.engineGeneration)).toEqual({
					status: "replay", receipt: winningReceipt,
				});
				releaseSettlement.resolve();
				await waitFor(async () =>
					terminatedCommands.some(event => event.stream_seq === delivery.seq) &&
					(await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).num_ack_pending === 0,
				);
				await waitFor(() => errors.includes(reportFailure));
				expect(errors).toHaveLength(2);
				expect(errors[0]).toBeInstanceOf(EngineCommandConflictError);
				expect(errors[0]).toMatchObject({ reason: "receipt" });
				expect(errors[1]).toBe(reportFailure);
				errors.splice(0, 2);
				expect(await runtime.store.admitCommand(
					settlementIdentity, runtime.engineGeneration,
				)).toEqual({ status: "replay", receipt: winningReceipt });
				expect((await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).num_redelivered).toBe(0);
				await adapter.flushEvents();
				expect(eventsA.filter(event =>
					event.causationCommandId === settlementCommand.commandId ||
					(event.type === "command.rejected" && event.causationCommandId === commandA.commandId),
				)).toEqual([]);
				expect((await runtime.store.pendingEventsForSink("test-settlement-conflict-audit")).events.filter(event =>
					event.causationCommandId === settlementCommand.commandId ||
					(event.kind === "rejected" && event.causationCommandId === commandA.commandId),
				)).toEqual([]);
				expect(await runtime.store.admitCommand(engineCommandIdentity(commandA), runtime.engineGeneration)).toEqual(originalAReceipt);
				expect(await runtime.store.getStartConversationIdentity(commandA.commandId)).toEqual(originalAIdentity);
				expect(await runtime.store.getAttempt(commandA.attemptId!)).toMatchObject({
					state: "completed", command_id: commandA.commandId, execution_id: commandA.executionId,
					binding_id: originalAAttempt.binding_id, binding_generation: originalAAttempt.binding_generation,
					binding_snapshot: originalAAttempt.binding_snapshot,
				});
				expect(dispatchCount).toBe(4);
			} finally {
				releaseSettlement.resolve();
				racingSettlement.mockRestore();
			}

			const deliveredAfterDuplicate = (await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer))
				.delivered.consumer_seq;
			const oldGenerationA = {
				...startCommand(runtime.engineGeneration - 1, "agent-a", "old-generation", cwd, execution),
				commandId: "command-a-old-generation",
			};
			await js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(oldGenerationA), {
				msgID: oldGenerationA.commandId,
			});
			await waitFor(async () => {
				const info = await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer);
				return info.delivered.consumer_seq > deliveredAfterDuplicate && info.num_ack_pending === 0;
			});
			await adapter.flushEvents();
			await waitFor(() =>
				eventsA.some(
					event =>
						event.causationCommandId === oldGenerationA.commandId &&
						event.type === "command.rejected" &&
						(event.payload as Record<string, unknown>).code === "interrupted",
				),
			);
			expect(
				await runtime.store.admitCommand(engineCommandIdentity(oldGenerationA), runtime.engineGeneration),
			).toMatchObject({
				status: "replay",
				receipt: { outcome: "rejected", detail: { code: "interrupted", requiresExplicitContinue: true } },
			});
			expect(dispatchCount).toBe(4);

			const invalidHistoryBranch = startCommand(runtime.engineGeneration, "agent-a", "invalid-history", cwd, execution);
			invalidHistoryBranch.payload.historyEdit = {
				mode: "branch",
				source: runtime.getBinding("agent-b"),
				sourceSessionId: "source-session",
				expectedLeafEntryId: "source-leaf",
				entryId: "source-entry",
				replacementText: "must not be silently discarded",
			};
			execution.captureCommand(invalidHistoryBranch);
			await js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(invalidHistoryBranch), {
				msgID: invalidHistoryBranch.commandId,
			});
			await waitFor(() =>
				eventsA.some(
					event =>
						event.type === "command.rejected" && event.causationCommandId === invalidHistoryBranch.commandId,
				),
			);
			expect(
				await runtime.store.admitCommand(engineCommandIdentity(invalidHistoryBranch), runtime.engineGeneration),
			).toMatchObject({
				status: "replay",
				receipt: { outcome: "rejected", detail: { code: "invalid_request" } },
			});
			expect(await runtime.store.getAttempt(invalidHistoryBranch.attemptId!)).toBeUndefined();
			expect(dispatchCount).toBe(4);

			const mismatchedIdentityA = {
				...startCommand(runtime.engineGeneration, "agent-a", "mismatched-identity", cwd),
				commandId: "command-a-mismatched-identity",
				agentInstanceRef: "grimoire://tasks/other/task/agents/agent-a",
				bindingSnapshot: semanticBinding("grimoire://tasks/other/task/agents/agent-a"),
			};
			await js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(mismatchedIdentityA), {
				msgID: mismatchedIdentityA.commandId,
			});
			await waitFor(() =>
				eventsA.some(
					event => event.type === "command.rejected" && event.causationCommandId === mismatchedIdentityA.commandId,
				),
			);
			expect(dispatchCount).toBe(4);

			const futureGenerationA = {
				...startCommand(runtime.engineGeneration + 1, "agent-a", "stale", cwd, execution),
				commandId: "command-a-stale",
			};
			await js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(futureGenerationA), {
				msgID: futureGenerationA.commandId,
			});
			await waitFor(() =>
				eventsA.some(
					event => event.type === "command.rejected" && event.causationCommandId === futureGenerationA.commandId,
				),
			);
			expect(eventsA.find(event => event.causationCommandId === futureGenerationA.commandId &&
				event.type === "command.rejected")).toMatchObject({
				agentInstanceId: futureGenerationA.agentInstanceId,
				attemptId: futureGenerationA.attemptId,
				executionId: futureGenerationA.executionId,
				engineGeneration: runtime.engineGeneration,
				payload: { code: "stale_target" },
			});
			expect(await runtime.store.admitCommand(engineCommandIdentity(futureGenerationA), runtime.engineGeneration))
				.toMatchObject({ status: "replay", receipt: { outcome: "rejected", detail: { code: "stale_target" } } });
			expect(await runtime.store.getAttempt(futureGenerationA.attemptId!)).toBeUndefined();
			expect((await runtime.store.getStartConversationIdentity(futureGenerationA.commandId))?.engineGeneration)
				.toBe(futureGenerationA.engineGeneration);
			expect(dispatchCount).toBe(4);
			subA.unsubscribe();
			subB.unsubscribe();
			terminatedSub.unsubscribe();

			await adapter.provisionMailbox("agent-c");
			const message = {
				schema: "grimoire.agent.message.v1",
				messageId: "message-a-c",
				fromAgentInstanceId: "agent-a",
				toAgentInstanceId: "agent-c",
				authorityGeneration: 1,
				sentAt: Date.now(),
				kind: "text",
				payload: { body: "hello from A" },
			};
			await js.publish(adapter.messageSubject("agent-a", "agent-c"), JSON.stringify(message), {
				msgID: message.messageId,
			});
			const mailboxName = `agent_${adapter.messageSubject("agent-a", "agent-c").split(".")[6]}`;
			await waitFor(async () => (await manager.streams.info(AGENT_MESSAGE_STREAM)).state.messages === 1);

			const commandC = startCommand(runtime.engineGeneration, "agent-c", "c", cwd, execution);
			execution.captureCommand(commandC);
			await js.publish(
				adapter.commandSubject("agent-c", "start"), JSON.stringify(commandC), {
				msgID: commandC.commandId,
			});
			await waitFor(async () => (await manager.streams.info(AGENT_MESSAGE_STREAM)).state.messages === 0);
			expect((await manager.consumers.info(AGENT_MESSAGE_STREAM, mailboxName)).num_ack_pending).toBe(0);

			expect((await manager.streams.info(ENGINE_COMMAND_STREAM)).config.retention).toBe("workqueue");
			expect((await manager.streams.info(ENGINE_EVENT_STREAM)).config.retention).toBe("limits");
			expect((await manager.streams.info(AGENT_MESSAGE_STREAM)).config.retention).toBe("workqueue");
			expect(errors).toEqual([]);
		} finally {
			releaseA.resolve();
			const cleanupErrors: unknown[] = [];
			for (const close of [
				() => client.drain(),
				() => adapter.stopAdmission(),
				() => runtime.dispose({ closeStore: false }),
				() => adapter.dispose(),
				() => runtime.store.close(),
				() => authStorage.close(),
				async () => { broker.process.kill(); await broker.process.exited; },
			]) {
				try { await close(); } catch (error) { cleanupErrors.push(error); }
			}
			if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "NATS route fixture teardown failed");
		}
	}, 60000);

	it("settles launch failures once and lets Stop cancel a command before an Attempt exists", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-launch-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd);
		const mock = createMockModel({ handler: { content: ["done"] } });
		const liveExecution = admittedExecution(mock.model, modelRegistry);
		const retainedExecution = admittedExecution(mock.model, modelRegistry);
		const reuseExecution = admittedExecution(mock.model, modelRegistry);
		let pendingReject: ((error: Error) => void) | undefined;
		let reuseReject: ((error: Error) => void) | undefined;
		let pendingResolverEntered = false;
		let reuseResolverEntered = false;
		let pendingGateResolve: (() => void) | undefined;
		let reuseGateResolve: (() => void) | undefined;
		const pendingGate = new Promise<void>(resolve => { pendingGateResolve = resolve; });
		const reuseGate = new Promise<void>(resolve => { reuseGateResolve = resolve; });
		const pendingFail = new Promise<void>((_resolve, reject) => { pendingReject = reject; });
		const reuseFail = new Promise<void>((_resolve, reject) => { reuseReject = reject; });
		const plainExecution = admittedExecution(mock.model, modelRegistry);
		// agent-failed / agent-unsafe-error / retained-rejected resolve through a refusing typed resolver.
		const refusingBase = plainExecution.optionsFor({ deviceId: "device-1" });
		const refusingResolve = refusingBase.resolveExecution!;
		const refusedExecution = admittedExecution(mock.model, modelRegistry);
		refusedExecution.optionsFor = () => ({
			...refusedExecution.optionsFor({ deviceId: "device-1" }),
			resolveExecution: async (config, frozen, attempt, resolverCwd, signal) => {
				if (attempt.attemptId === "attempt-failed") {
					const databaseError = new Error(
						"Failed to open auth database at 'C:/Users/private/.omp/agent/agent.db': database is locked",
					);
					databaseError.name = "ConfigurationError";
					throw new Error("No usable AvailableModelRoute in AgentProfile", {
						cause: new Error(
							'ProviderAccount credential token=do-not-expose Authorization: Bearer bearer-secret "access_token":"json-secret" sk-proj-0123456789abcdef is unavailable',
							{ cause: databaseError },
						),
					});
				}
				if (attempt.attemptId === "attempt-unsafe-error")
					throw new Error("custom startup failed with raw prompt SUPER_SECRET_PROMPT");
				if (attempt.attemptId === "attempt-retained-rejected")
					throw new Error("replacement profile is unavailable");
				if (attempt.attemptId === "attempt-pending") {
					pendingResolverEntered = true;
					await Promise.race([pendingGate, pendingFail]);
					return refusingResolve(config, frozen, attempt, resolverCwd, signal);
				}
				if (attempt.attemptId === "attempt-reuse-pending") {
					reuseResolverEntered = true;
					await Promise.race([reuseGate, reuseFail]);
					return refusingResolve(config, frozen, attempt, resolverCwd, signal);
				}
				return refusingResolve(config, frozen, attempt, resolverCwd, signal);
			},
		});
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async session =>
				session.getAgentId() === engineAgentId("agent-live") ? await livePrompt.promise : true,
			...liveExecution.optionsFor({ deviceId: "device-1", sessionDefaults: {
				cwd,
				agentDir,
				settings: await Settings.loadReadOnly({ cwd, agentDir }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			} }),
		});
		const errors: Error[] = [];
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-1",
			engineId: "engine-1",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			onError: error => errors.push(error),
		});
		const client = await connect({ servers: broker.url });
		try {
			const js = jetstream(client);
			const decoder = new TextDecoder();
			const events: Array<Record<string, unknown>> = [];
			const failedSubscription = client.subscribe(adapter.eventSubject("agent-failed", "*"), {
				callback: (_error, message) => {
					events.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const pendingSubscription = client.subscribe(adapter.eventSubject("agent-pending", "*"), {
				callback: (_error, message) => {
					events.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const unsafeSubscription = client.subscribe(adapter.eventSubject("agent-unsafe-error", "*"), {
				callback: (_error, message) => {
					events.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const liveSubscription = client.subscribe(adapter.eventSubject("agent-live", "*"), {
				callback: (_error, message) => {
					events.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const reuseSubscription = client.subscribe(adapter.eventSubject("agent-reuse", "*"), {
				callback: (_error, message) => {
					events.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const retainedSubscription = client.subscribe(adapter.eventSubject("agent-retained", "*"), {
				callback: (_error, message) => {
					events.push(JSON.parse(decoder.decode(message.data)));
				},
			});

			const failed = startCommand(runtime.engineGeneration, "agent-failed", "failed", cwd, refusedExecution);
			refusedExecution.captureCommand(failed);
			await js.publish(
				adapter.commandSubject(failed.agentInstanceId, "start"), JSON.stringify(failed), {
				msgID: failed.commandId,
			});
			await waitFor(() => events.some(event => event.causationCommandId === failed.commandId));
			const failedAdmission = await runtime.store.admitCommand(
				engineCommandIdentity(failed),
				runtime.engineGeneration,
			);
			expect(failedAdmission).toMatchObject({
				status: "replay",
				receipt: {
					outcome: "rejected",
					detail: {
						code: "launch_failed",
						message:
							'Agent session initialization failed: No usable AvailableModelRoute in AgentProfile: ProviderAccount credential token="[redacted]" Authorization: Bearer [redacted] "access_token":"[redacted]" [redacted credential] is unavailable: Failed to open auth database at \'[local auth database]\': database is locked',
					},
				},
			});
			const publicFailure = JSON.stringify(failedAdmission);
			expect(publicFailure).not.toContain("do-not-expose");
			expect(publicFailure).not.toContain("bearer-secret");
			expect(publicFailure).not.toContain("json-secret");
			expect(publicFailure).not.toContain("0123456789abcdef");
			expect(await runtime.store.getAttempt(failed.attemptId!)).toBeUndefined();
			const failedEvent = events.find(event => event.causationCommandId === failed.commandId);
			expect(failedEvent).toMatchObject({
				type: "command.rejected",
				payload: { code: "launch_failed", sessionState: "absent" },
			});

			const retainedFirst = startCommand(runtime.engineGeneration, "agent-retained", "retained-first", cwd, retainedExecution);
		retainedExecution.captureCommand(retainedFirst);
			await js.publish(
				adapter.commandSubject(retainedFirst.agentInstanceId, "start"),
				JSON.stringify(retainedFirst),
				{ msgID: retainedFirst.commandId },
			);
			await waitFor(async () => (await runtime.store.getAttempt(retainedFirst.attemptId!))?.state === "completed");
			const retainedHistory = (agentInstanceId: string) =>
				runtime.sessionHistoryPage(agentInstanceId, "grimoire://tasks/grimoire/nats/agents/retained");
			const retainedSessionId = (await retainedHistory(retainedFirst.agentInstanceId)).sessionId;
			const retainedRejected = startCommand(runtime.engineGeneration, "agent-retained", "retained-rejected", cwd, refusedExecution);
		refusedExecution.captureCommand(retainedRejected);
			await js.publish(
				adapter.commandSubject(retainedRejected.agentInstanceId, "start"),
				JSON.stringify(retainedRejected),
				{ msgID: retainedRejected.commandId },
			);
			await waitFor(() => events.some(event => event.causationCommandId === retainedRejected.commandId));
			const retainedRejectedEvent = events.find(event => event.causationCommandId === retainedRejected.commandId);
			expect(retainedRejectedEvent).toMatchObject({
				type: "command.rejected",
				payload: { code: "launch_failed" },
			});
			expect((retainedRejectedEvent?.payload as Record<string, unknown> | undefined)?.sessionState).toBeUndefined();
			expect((await retainedHistory(retainedRejected.agentInstanceId)).sessionId).toBe(retainedSessionId);

			const unsafe = startCommand(runtime.engineGeneration, "agent-unsafe-error", "unsafe", cwd, refusedExecution);
		refusedExecution.captureCommand(unsafe);
			await js.publish(adapter.commandSubject(unsafe.agentInstanceId, "start"), JSON.stringify(unsafe), {
				msgID: unsafe.commandId,
			});
			await waitFor(() => events.some(event => event.causationCommandId === unsafe.commandId));
			const unsafeAdmission = await runtime.store.admitCommand(
				engineCommandIdentity(unsafe),
				runtime.engineGeneration,
			);
			const publicUnsafeFailure = JSON.stringify(unsafeAdmission);
			expect(publicUnsafeFailure).toContain("Error (diagnostic ");
			expect(publicUnsafeFailure).not.toContain("SUPER_SECRET_PROMPT");

			const pending = startCommand(runtime.engineGeneration, "agent-pending", "pending", cwd, refusedExecution);
		refusedExecution.captureCommand(pending);
			await js.publish(adapter.commandSubject(pending.agentInstanceId, "start"), JSON.stringify(pending), {
				msgID: pending.commandId,
			});
			await waitFor(() => pendingResolverEntered);
			const cancel: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "command-cancel-pending",
				op: "cancel",
				deviceId: "device-1",
				engineId: "engine-1",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId: pending.agentInstanceId,
				executionId: pending.executionId,
				attemptId: pending.attemptId,
				authorityGeneration: pending.authorityGeneration,
				issuedAt: Date.now(),
				payload: { reason: "Stopped from Artel before binding" },
			};
			cancel.payload.originReceiptId = "origin:command-cancel-pending";
			refusedExecution.captureCommand(cancel);
			await js.publish(adapter.commandSubject(cancel.agentInstanceId, "cancel"), JSON.stringify(cancel), {
				msgID: cancel.commandId,
			});
			await waitFor(() =>
				events.some(
					event =>
						event.causationCommandId === pending.commandId &&
						event.type === "command.rejected" &&
						(event.payload as Record<string, unknown>).code === "cancelled",
				),
			);
			pendingReject?.(new Error("late profile resolution must not revive the Attempt"));
			await waitFor(async () => {
				const admission = await runtime.store.admitCommand(engineCommandIdentity(cancel), runtime.engineGeneration);
				return admission.status === "replay";
			});
			const pendingAdmission = await runtime.store.admitCommand(
				engineCommandIdentity(pending),
				runtime.engineGeneration,
			);
			expect(pendingAdmission).toMatchObject({
				status: "replay",
				receipt: { outcome: "rejected", detail: { code: "cancelled" } },
			});
			expect(await runtime.store.getAttempt(pending.attemptId!)).toBeUndefined();

			const reuseFirst = startCommand(runtime.engineGeneration, "agent-reuse", "reuse-first", cwd, reuseExecution);
		reuseExecution.captureCommand(reuseFirst);
			await js.publish(adapter.commandSubject(reuseFirst.agentInstanceId, "start"), JSON.stringify(reuseFirst), {
				msgID: reuseFirst.commandId,
			});
			await waitFor(async () => (await runtime.store.getAttempt(reuseFirst.attemptId!))?.state === "completed");
			const reusePending = startCommand(runtime.engineGeneration, "agent-reuse", "reuse-pending", cwd, refusedExecution);
		refusedExecution.captureCommand(reusePending);
			await js.publish(adapter.commandSubject(reusePending.agentInstanceId, "start"), JSON.stringify(reusePending), {
				msgID: reusePending.commandId,
			});
			await waitFor(() => reuseResolverEntered);
			const reuseCancel: EngineCommandEnvelope = {
				...cancel,
				commandId: "command-cancel-reuse-pending",
				agentInstanceId: reusePending.agentInstanceId,
				executionId: reusePending.executionId,
				attemptId: reusePending.attemptId,
				issuedAt: Date.now(),
			};
			reuseCancel.payload = { ...reuseCancel.payload, originReceiptId: "origin:command-cancel-reuse-pending" };
			refusedExecution.captureCommand(reuseCancel);
			await js.publish(adapter.commandSubject(reuseCancel.agentInstanceId, "cancel"), JSON.stringify(reuseCancel), {
				msgID: reuseCancel.commandId,
			});
			await waitFor(() =>
				events.some(
					event =>
						event.causationCommandId === reusePending.commandId &&
						(event.payload as Record<string, unknown>).code === "cancelled",
				),
			);
			expect(await runtime.store.getBinding("agent-reuse")).toMatchObject({
				attemptId: reuseFirst.attemptId,
				manualHold: true,
				intentRevision: 1,
				intentCommandId: reuseCancel.commandId,
			});
			reuseReject?.(new Error("late reused profile must not revive the Attempt"));
			expect(await runtime.store.getAttempt(reusePending.attemptId!)).toBeUndefined();

			const live = startCommand(runtime.engineGeneration, "agent-live", "live", cwd, liveExecution);
		liveExecution.captureCommand(live);
			await js.publish(adapter.commandSubject(live.agentInstanceId, "start"), JSON.stringify(live), {
				msgID: live.commandId,
			});
			await waitFor(async () => (await runtime.store.getAttempt(live.attemptId!))?.state === "running");
			const racedCancel: EngineCommandEnvelope = {
				...cancel,
				commandId: "command-cancel-live-without-binding",
				agentInstanceId: live.agentInstanceId,
				executionId: live.executionId,
				attemptId: live.attemptId,
				issuedAt: Date.now(),
			};
			racedCancel.payload = { ...racedCancel.payload, originReceiptId: "origin:command-cancel-live-without-binding" };
			liveExecution.captureCommand(racedCancel);
			await js.publish(adapter.commandSubject(racedCancel.agentInstanceId, "cancel"), JSON.stringify(racedCancel), {
				msgID: racedCancel.commandId,
			});
			await waitFor(async () => {
				const state = (await runtime.store.getAttempt(live.attemptId!))?.state;
				return state === "cancel_requested" || state === "cancelled";
			});
			await waitFor(async () => {
				const admission = await runtime.store.admitCommand(
					engineCommandIdentity(racedCancel),
					runtime.engineGeneration,
				);
				return admission.status === "replay";
			});
			livePrompt.resolve(true);
			await Bun.sleep(1_100);
			expect(errors).toEqual([]);
			failedSubscription.unsubscribe();
			pendingSubscription.unsubscribe();
			unsafeSubscription.unsubscribe();
			liveSubscription.unsubscribe();
			reuseSubscription.unsubscribe();
			retainedSubscription.unsubscribe();
		} finally {
			livePrompt.resolve(true);
			reuseReject?.(new Error("test cleanup"));
			await client.drain();
			await adapter.dispose();
			await runtime.dispose();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30000);

	it("keeps a received pre-start command interrupted across an Engine generation upgrade without launching it", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-upgrade-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const databasePath = path.join(tempDir, "engine.sqlite");
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const mock = createMockModel({ handler: { content: ["done"] } });
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "isolated-test");
		const execution = admittedExecution(mock.model, new ModelRegistry(auth, path.join(tempDir, "models.yml")));
		const typedOptions = execution.optionsFor({ deviceId: "device-1" });
		const firstRuntime = await EngineRuntime.create({ databasePath, dispatchPrompt: async () => true, ...typedOptions });
		const oldStart = startCommand(firstRuntime.engineGeneration, "agent-upgrade", "upgrade", cwd, execution);
		execution.captureCommand(oldStart);
		expect(
			await firstRuntime.store.admitCommand(engineCommandIdentity(oldStart), firstRuntime.engineGeneration),
		).toEqual({ status: "claimed" });
		await firstRuntime.dispose();

		const secondRuntime = await EngineRuntime.create({ databasePath, dispatchPrompt: async () => true, ...typedOptions });
		expect(secondRuntime.engineGeneration).toBe(oldStart.engineGeneration + 1);
		expect(
			(await secondRuntime.store.pendingEventsForSink("test-recovery-audit")).events.filter(
				event => event.causationCommandId === oldStart.commandId && event.kind === "rejected",
			),
		).toMatchObject([{ payload: { code: "interrupted", requiresExplicitContinue: true } }]);
		const errors: Error[] = [];
		const adapter = await NatsEngineAdapter.connect({
			runtime: secondRuntime,
			deviceId: "device-1",
			engineId: "engine-1",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			onError: error => errors.push(error),
		});
		const client = await connect({ servers: broker.url });
		try {
			const js = jetstream(client);
			const manager = await jetstreamManager(client);
			const decoder = new TextDecoder();
			const events: Array<Record<string, unknown>> = [];
			const subscription = client.subscribe(adapter.eventSubject(oldStart.agentInstanceId, "*"), {
				callback: (_error, message) => {
					events.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const cancel: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "command-cancel-upgrade",
				op: "cancel",
				deviceId: "device-1",
				engineId: "engine-1",
				engineGeneration: secondRuntime.engineGeneration,
				agentInstanceId: oldStart.agentInstanceId,
				executionId: oldStart.executionId,
				attemptId: oldStart.attemptId,
				authorityGeneration: oldStart.authorityGeneration,
				issuedAt: Date.now(),
				payload: { reason: "Persisted Stop before Engine upgrade" },
			};
			cancel.payload.originReceiptId = "origin:command-cancel-upgrade";
			execution.captureCommand(cancel);
			await js.publish(adapter.commandSubject(cancel.agentInstanceId, "cancel"), JSON.stringify(cancel), {
				msgID: cancel.commandId,
			});
			await waitFor(() =>
				events.some(event => event.causationCommandId === cancel.commandId && event.type === "command.rejected"),
			);
			const oldReceipt = await secondRuntime.store.admitCommand(
				engineCommandIdentity(oldStart),
				secondRuntime.engineGeneration,
			);
			expect(oldReceipt).toMatchObject({
				status: "replay",
				receipt: { outcome: "rejected", detail: { code: "interrupted", requiresExplicitContinue: true } },
			});

			const commandConsumer = `engine_${adapter.engineRoute}`;
			const deliveredBefore = (await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).delivered
				.consumer_seq;
			await js.publish(adapter.commandSubject(oldStart.agentInstanceId, "start"), JSON.stringify(oldStart), {
				msgID: oldStart.commandId,
			});
			await waitFor(async () => {
				const info = await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer);
				return info.delivered.consumer_seq > deliveredBefore && info.num_ack_pending === 0;
			});
			expect(mock.calls).toEqual([]);
			expect(await secondRuntime.store.getAttempt(oldStart.attemptId!)).toBeUndefined();
			expect(
				(await secondRuntime.store.pendingEventsForSink("test-recovery-audit")).events.filter(
					event => event.causationCommandId === oldStart.commandId && event.kind === "rejected",
				),
			).toHaveLength(1);
			expect(errors).toEqual([]);
			subscription.unsubscribe();
		} finally {
			await client.drain();
			await adapter.dispose();
			await secondRuntime.dispose();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30000);

	it("settles a command that keeps failing as one terminal failed receipt and replays it on resend", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-failing-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
		});
		let dispatches = 0;
		const failing = spyOn(runtime, "reconcile").mockImplementation(async () => {
			dispatches++;
			throw new Error("ENOENT: reconcile fixture storage is offline");
		});
		const refusedExecutionForCommands = admittedExecution(mock.model, new ModelRegistry(auth, path.join(tempDir, "models.yml")));
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-1",
			engineId: "engine-1",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			commandAttempts: 2,
		});
		const client = await connect({ servers: broker.url });
		try {
			const js = jetstream(client);
			const manager = await jetstreamManager(client);
			const consumer = `engine_${adapter.engineRoute}`;
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "command-always-failing",
				op: "reconcile",
				deviceId: "device-1",
				engineId: "engine-1",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId: "agent-failing",
				authorityGeneration: 1,
				issuedAt: Date.now(),
				payload: {},
			};
			command.payload.originReceiptId = "origin:command-always-failing";
			refusedExecutionForCommands.captureCommand(command);
			const settled = async () => {
				const info = await manager.consumers.info(ENGINE_COMMAND_STREAM, consumer);
				return info.num_pending === 0 && info.num_ack_pending === 0;
			};
			await js.publish(adapter.commandSubject(command.agentInstanceId, "reconcile"), JSON.stringify(command), {
				msgID: "delivery-1",
			});
			// The first failure is redelivered after its backoff; the second is terminal.
			await waitFor(async () => dispatches === 2 && (await settled()), 15_000);
			const receipt = await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration);
			expect(receipt).toMatchObject({
				status: "replay",
				receipt: {
					outcome: "rejected",
					detail: {
						code: "command_failed",
						message: "Command failed after 2 attempts: ENOENT: reconcile fixture storage is offline",
					},
				},
			});

			await js.publish(adapter.commandSubject(command.agentInstanceId, "reconcile"), JSON.stringify(command), {
				msgID: "delivery-2",
			});
			await waitFor(
				async () => (await manager.consumers.info(ENGINE_COMMAND_STREAM, consumer)).delivered.stream_seq >= 2,
			);
			await waitFor(settled);
			expect(dispatches).toBe(2);
			expect(await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration)).toEqual(
				receipt,
			);
		} finally {
			failing.mockRestore();
			await client.drain();
			await adapter.dispose();
			await runtime.dispose();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30000);

	it("takes back its own claim after a failed release instead of redelivering it as in progress forever", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-release-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const mock = createMockModel({ handler: { content: ["done"] } });
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "isolated-test");
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
		});
		let dispatches = 0;
		const failing = spyOn(runtime, "reconcile").mockImplementation(async () => {
			dispatches++;
			throw new Error("ENOENT: reconcile fixture storage is offline");
		});
		let releases = 0;
		const refusedExecutionForCommands = admittedExecution(mock.model, new ModelRegistry(auth, path.join(tempDir, "models.yml")));
		const release = spyOn(runtime.store, "releaseCommand").mockImplementation(async () => {
			releases++;
			throw new Error("release fixture storage is offline");
		});
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-1",
			engineId: "engine-1",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			onError: () => {},
			commandAttempts: 3,
		});
		const client = await connect({ servers: broker.url });
		try {
			const js = jetstream(client);
			const manager = await jetstreamManager(client);
			const consumer = `engine_${adapter.engineRoute}`;
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "command-release-failing",
				op: "reconcile",
				deviceId: "device-1",
				engineId: "engine-1",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId: "agent-release-failing",
				authorityGeneration: 1,
				issuedAt: Date.now(),
				payload: {},
			};
			command.payload.originReceiptId = "origin:command-release-failing";
			refusedExecutionForCommands.captureCommand(command);
			await js.publish(adapter.commandSubject(command.agentInstanceId, "reconcile"), JSON.stringify(command), {
				msgID: "delivery-1",
			});
			// Every failed release leaves the claim on this generation; the next delivery is the next attempt.
			await waitFor(async () => {
				const info = await manager.consumers.info(ENGINE_COMMAND_STREAM, consumer);
				return dispatches === 3 && info.num_pending === 0 && info.num_ack_pending === 0;
			}, 15_000);
			expect(releases).toBe(2);
			expect(
				await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration),
			).toMatchObject({
				status: "replay",
				receipt: {
					outcome: "rejected",
					detail: {
						code: "command_failed",
						message: "Command failed after 3 attempts: ENOENT: reconcile fixture storage is offline",
					},
				},
			});
		} finally {
			failing.mockRestore();
			release.mockRestore();
			await client.drain();
			await adapter.dispose();
			await runtime.dispose();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30000);

	it("keeps binding-pending peer messages without spending the bounded failure budget", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-mailbox-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
		});
		let deliveries = 0;
		let bindingPending = true;
		let failures = 0;
		const delivering = spyOn(runtime, "deliverPeerMessage").mockImplementation(async message => {
			deliveries++;
			if (bindingPending) throw new EngineBindingPendingError();
			failures++;
			return { to: message.toAgentInstanceId, outcome: "failed", error: "Unknown Engine peer" };
		});
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-1",
			engineId: "engine-1",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			commandAttempts: 2,
		});
		const client = await connect({ servers: broker.url });
		try {
			const js = jetstream(client);
			const manager = await jetstreamManager(client);
			await adapter.provisionMailbox("agent-c");
			const message = {
				schema: "grimoire.agent.message.v1",
				messageId: "message-failing",
				fromAgentInstanceId: "agent-a",
				toAgentInstanceId: "agent-c",
				authorityGeneration: 1,
				sentAt: Date.now(),
				kind: "text",
				payload: { body: "never delivered" },
			};
			await js.publish(adapter.messageSubject("agent-a", "agent-c"), JSON.stringify(message), {
				msgID: message.messageId,
			});
			await waitFor(async () => deliveries >= 3, 15_000);
			expect((await manager.streams.info(AGENT_MESSAGE_STREAM)).state.messages).toBe(1);
			expect(failures).toBe(0);
			bindingPending = false;
			// Work-queue retention drops the message once it is terminated; a redelivered one stays in the stream.
			await waitFor(async () => (await manager.streams.info(AGENT_MESSAGE_STREAM)).state.messages === 0, 15_000);
			expect(failures).toBe(2);
		} finally {
			delivering.mockRestore();
			await client.drain();
			await adapter.dispose();
			await runtime.dispose();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30000);

	it("rejects a Start whose admission keeps failing with a durable receipt instead of dropping it", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-admission-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
		});
		const admit = runtime.store.admitCommand.bind(runtime.store);
		let admissions = 0;
		const failing = spyOn(runtime.store, "admitCommand").mockImplementation(async () => {
			admissions++;
			throw new Error("ENOENT: admission fixture storage is offline");
		});
		const mock = createMockModel({ handler: { content: ["done"] } });
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "isolated-test");
		const execution = admittedExecution(mock.model, new ModelRegistry(auth, path.join(tempDir, "models.yml")));
		const start = startCommand(runtime.engineGeneration, "agent-unadmitted", "unadmitted", cwd, execution);
		execution.captureCommand(start);
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-1",
			engineId: "engine-1",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			commandAttempts: 2,
		});
		const client = await connect({ servers: broker.url });
		try {
			const js = jetstream(client);
			const manager = await jetstreamManager(client);
			const consumer = `engine_${adapter.engineRoute}`;
			const settled = async () => {
				const info = await manager.consumers.info(ENGINE_COMMAND_STREAM, consumer);
				return info.num_pending === 0 && info.num_ack_pending === 0;
			};
			await js.publish(adapter.commandSubject(start.agentInstanceId, "start"), JSON.stringify(start), {
				msgID: "delivery-1",
			});
			await waitFor(async () => admissions === 2 && (await settled()), 15_000);
			failing.mockRestore();
			const failure = {
				code: "command_failed",
			};
			const receipt = await admit(engineCommandIdentity(start), runtime.engineGeneration);
			expect(receipt).toMatchObject({ status: "replay", receipt: { outcome: "rejected", detail: failure } });
			expect(
				(await runtime.store.pendingEventsForSink("test-admission-audit")).events.filter(
					event => event.causationCommandId === start.commandId && event.kind === "rejected",
				),
			).toMatchObject([{ payload: failure }]);

			await js.publish(adapter.commandSubject(start.agentInstanceId, "start"), JSON.stringify(start), {
				msgID: "delivery-2",
			});
			await waitFor(
				async () => (await manager.consumers.info(ENGINE_COMMAND_STREAM, consumer)).delivered.stream_seq >= 2,
			);
			await waitFor(settled);
			expect(await runtime.store.getAttempt(start.attemptId!)).toBeUndefined();
			expect(await admit(engineCommandIdentity(start), runtime.engineGeneration)).toEqual(receipt);
		} finally {
			failing.mockRestore();
			await client.drain();
			await adapter.dispose();
			await runtime.dispose();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30000);
});

function startCommand(
	engineGeneration: number,
	agentInstanceId: string,
	suffix: string,
	cwd: string,
	execution?: AdmittedExecutionFixture,
): EngineCommandEnvelope {
	const agentInstanceRef = `grimoire://tasks/grimoire/nats-test/agents/${agentInstanceId}`;
	const command: EngineCommandEnvelope = {
		schema: "grimoire.engine.command.v1",
		commandId: `command-${suffix}`,
		op: "start",
		deviceId: "device-1",
		engineId: "engine-1",
		engineGeneration,
		agentInstanceId,
		agentInstanceRef,
		bindingSnapshot: execution ? semanticBinding(agentInstanceRef, execution.taskRef) : semanticBinding(agentInstanceRef),
		executionId: `execution-${suffix}`,
		attemptId: `attempt-${suffix}`,
		authorityGeneration: 1,
		principalId: "owner",
		issuedAt: Date.now(),
		payload: execution ? {
			cwd, input: suffix.toUpperCase(),
			executionConfiguration: execution.config,
			dispatchRef: execution.dispatchRef,
			dispatchHash: execution.dispatchHash,
			executionKind: "ordinary",
			specialRef: null,
			originReceiptId: "origin:command-" + suffix,
		} : { cwd, input: suffix.toUpperCase() },
	};
	return command;
}

async function startNatsServer(root: string) {
	const portsDir = path.join(root, "ports");
	const dataDir = path.join(root, "jetstream");
	fs.mkdirSync(portsDir);
	const process = Bun.spawn(
		[natsServer, "-js", "-a", "127.0.0.1", "-p", "-1", "--ports_file_dir", portsDir, "-sd", dataDir],
		{ stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	try {
		let manifest: { nats?: string[] } | undefined;
		await waitFor(async () => {
			const files = await Array.fromAsync(new Bun.Glob("*.ports").scan({ cwd: portsDir, onlyFiles: true }));
			if (!files[0]) return false;
			manifest = (await Bun.file(path.join(portsDir, files[0])).json()) as { nats?: string[] };
			return Boolean(manifest.nats?.[0]);
		});
		return { process, url: manifest?.nats?.[0] ?? "" };
	} catch (error) {
		process.kill();
		await process.exited;
		throw error;
	}
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
		await Bun.sleep(25);
	}
}
