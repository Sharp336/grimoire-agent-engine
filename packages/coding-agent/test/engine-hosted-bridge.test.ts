import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, nkeyAuthenticator, nkeys } from "@nats-io/transport-node";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EngineBindingSnapshot, EngineEvent } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import {
	type GrimoireRpc,
	HostedEngineBridge,
	HostedGrimoireRpc,
	launchHostedEngineChild,
} from "@oh-my-pi/pi-coding-agent/engine/hosted-bridge";
import {
	ENGINE_COMMAND_STREAM,
	ENGINE_EVENT_STREAM,
	type EngineCommandEnvelope,
	type EngineEventEnvelope,
	engineCommandIdentity,
	NatsEngineAdapter,
} from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import { engineAgentId, engineAgentInstanceId, engineRouteToken } from "@oh-my-pi/pi-coding-agent/engine/route";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import type { LegacyOwnershipCandidate } from "@oh-my-pi/pi-coding-agent/engine/runtime-ownership";
import { natsConfig, runEngineService } from "@oh-my-pi/pi-coding-agent/engine/service";
import { EngineStore } from "@oh-my-pi/pi-coding-agent/engine/store";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";

const installedNatsServer = path.join(process.env.LOCALAPPDATA ?? "", "Grimoire", "bin", "nats-server.exe");
const natsServer = process.env.GRIMOIRE_NATS_SERVER ?? installedNatsServer;

describe.skipIf(!fs.existsSync(natsServer))("HostedEngineBridge", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});

	it("exits the real Engine process after Resume with native observers and a deferred inbox timer", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-exit-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const tokenFile = path.join(tempDir, "bridge-token");
		await Bun.write(tokenFile, "private-fixture-only");
		const http = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				if (request.headers.get("authorization") !== "Bearer private-fixture-only")
					return new Response(null, { status: 401 });
				const body = (await request.json()) as { id: number; params: { arguments: Record<string, unknown> } };
				const args = body.params.arguments;
				const response = (value: Record<string, unknown>) =>
					Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: value } });
				if (args.action === "claim") return response({ status: "no_job" });
				if (args.action === "event") return response({ status: "already_terminal" });
				if (args.action === "ownership") return response({ status: "ok", results: [] });
				if (args.action === "wait") {
					const wait = Promise.withResolvers<Response>();
					const timer = setTimeout(() => wait.resolve(response({ generation: 1, changed: false })), 25_000);
					const abort = () => {
						clearTimeout(timer);
						wait.resolve(new Response(null, { status: 499 }));
					};
					request.signal.addEventListener("abort", abort, { once: true });
					try {
						return await wait.promise;
					} finally {
						clearTimeout(timer);
						request.signal.removeEventListener("abort", abort);
					}
				}
				throw new Error(`Unexpected shutdown fixture action ${String(args.action)}`);
			},
		});
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "fixtures/runtime-v1-smoke.ts"),
				path.join(tempDir, "engine"),
				"--nats-url",
				broker.url,
				"--bridge-url",
				`http://127.0.0.1:${http.port}/mcp/client_agents`,
				"--bridge-token-file",
				tokenFile,
			],
			{ stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
		try {
			const output = new Response(child.stdout).text();
			const errors = new Response(child.stderr).text();
			const code = await withTimeout(child.exited, 20_000, "Native shutdown fixture exceeded its process deadline");
			expect(await errors).toBe("");
			expect(code).toBe(0);
			const result = JSON.parse((await output).trim()) as {
				result: string;
				liveObservers: number;
				processExitAfterCompleteMs: number;
			};
			expect(result.result).toBe("PASS");
			expect(result.liveObservers).toBe(16);
			expect(result.processExitAfterCompleteMs).toBeLessThan(3000);
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			await http.stop(true);
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30_000);

	it.each([false, true])(
		"imports exact legacy proofs or stops an unavailable canonical pass (%s)",
		async unavailable => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-ownership-${Snowflake.next()}-`));
			const broker = await startNatsServer(tempDir);
			const connection = await connect({ servers: broker.url });
			await (await jetstreamManager(connection)).streams.add({
				name: ENGINE_EVENT_STREAM,
				subjects: ["grimoire.engine.v1.>"],
			});
			const store = await EngineStore.open(path.join(tempDir, "engine.sqlite"));
			await store.nextEngineGeneration();
			for (let index = 0; index < 2; index++) {
				const agentInstanceRef = `grimoire://tasks/grimoire/ownership/agents/${index}`;
				const envelope: EngineCommandEnvelope = {
					schema: "grimoire.engine.command.v1",
					commandId: `ownership-${index}`,
					issuedAt: Date.now(),
					op: "start",
					deviceId: "device",
					engineId: "engine",
					engineGeneration: 1,
					agentInstanceId: engineAgentInstanceId(agentInstanceRef),
					agentInstanceRef,
					authorityGeneration: 1,
					attemptId: `ownership-attempt-${index}`,
					executionId: `ownership-execution-${index}`,
					payload: { input: "legacy" },
				};
				await store.admitCommand(engineCommandIdentity(envelope), 1);
			}
			const canonicalRef = "grimoire://tasks/grimoire/ownership/agents/native-only";
			await store.registerAgent({
				agentInstanceRef: canonicalRef,
				agentInstanceId: engineAgentInstanceId(canonicalRef),
				authorityGeneration: 1,
			});
			const pageSizes: number[] = [];
			let waits = 0;
			const http = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch(request) {
					const body = (await request.json()) as { id: number; params: { arguments: Record<string, unknown> } };
					const args = body.params.arguments;
					const response = (value: Record<string, unknown>) =>
						Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: value } });
					if (args.action === "claim") return response({ status: "no_job" });
					if (args.action === "ownership") {
						const candidates = args.candidates as LegacyOwnershipCandidate[];
						pageSizes.push(candidates.length);
						return response({
							status: "ok",
							results: candidates.map((candidate, index) => ({
								...candidate,
								...(candidate.kind === "canonical_agi" ? { proofSource: "canonical_agi" } : {}),
								status:
									(unavailable && candidate.kind === "canonical_agi") ||
									(pageSizes.length === 1 && index === 1)
										? "deferred"
										: "verified",
								...(unavailable && candidate.kind === "canonical_agi"
									? { reason: "canonical_source_unavailable" }
									: {}),
								principalId: "owner",
							})),
						});
					}
					if (args.action === "wait") {
						waits++;
						return await new Promise<Response>(resolve => {
							const timer = setTimeout(() => resolve(response({ generation: 1, changed: false })), 15000);
							request.signal.addEventListener(
								"abort",
								() => {
									clearTimeout(timer);
									resolve(new Response(null, { status: 499 }));
								},
								{ once: true },
							);
						});
					}
					throw new Error("Unexpected fixture RPC");
				},
			});
			const errors: Error[] = [];
			const bridge = await HostedEngineBridge.connect({
				eventStore: store,
				deviceId: "device",
				engineId: "engine",
				engineGeneration: 1,
				servers: broker.url,
				onError: error => errors.push(error),
				rpc: new HostedGrimoireRpc({
					serverUrl: `http://127.0.0.1:${http.port}/mcp/client_agents`,
					token: "private-fixture-only",
					clientId: "fixture",
				}),
			});
			try {
				await waitFor(
					async () =>
						(await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).agents.length ===
						(unavailable ? 2 : 3),
				);
				await waitFor(
					async () =>
						(await store.ownershipMigrationStatus()).status === (unavailable ? "unavailable" : "complete") &&
						waits === 2,
				);
				if (unavailable) {
					expect(pageSizes.length).toBeLessThanOrEqual(3);
					const passes = pageSizes.length;
					await Bun.sleep(100);
					expect(pageSizes.length).toBe(passes);
					expect(errors.map(error => error.message)).toEqual(["Legacy ownership proof page made no progress"]);
				} else expect(pageSizes).toEqual([3, 1]);
				const began = performance.now();
				await bridge.stopAdmission();
				await bridge.dispose();
				expect(performance.now() - began).toBeLessThan(1000);
				if (!unavailable) expect(errors).toEqual([]);
			} finally {
				await bridge.dispose();
				await http.stop(true);
				await connection.drain();
				await store.close();
				broker.process.kill();
				await broker.process.exited;
			}
		},
		30000,
	);

	it("retries stranded claims and NAK-redelivers rejected wakes with the current generation", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-host-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir, true);
		const engineSeed = broker.engineSeed;
		const bridgeSeed = broker.bridgeSeed;
		if (!engineSeed || !bridgeSeed) throw new Error("authenticated NATS credentials were not created");
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: await Settings.loadReadOnly({ cwd, agentDir: path.join(tempDir, "agent") }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			},
		});
		const profile = { spawns: "", profileDigest: "leaf-profile-v1", enableMCP: false, enableLsp: false };
		const adapterErrors: Error[] = [];
		let adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			servers: broker.url,
			connectionOptions: { authenticator: nkeyAuthenticator(engineSeed) },
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => command.payload.launchProfile as typeof profile,
			onError: error => adapterErrors.push(error),
		});
		await adapter.dispose();
		const managerConnection = await connect({
			servers: broker.url,
			authenticator: nkeyAuthenticator(bridgeSeed),
		});
		const manager = await jetstreamManager(managerConnection);
		await manager.streams.delete(ENGINE_COMMAND_STREAM);
		const browserTarget = { agentInstanceRef: "grimoire://tasks/p/t/agents/hosted" };
		const rpc = new FakeRpc(
			{
				...startCommand(cwd, profile),
				agentInstanceRef: browserTarget.agentInstanceRef,
				principalId: "owner",
				browserPayloadHash: `sha256:${"a".repeat(64)}`,
				browserTarget,
				payload: { ...startCommand(cwd, profile).payload, expectedIntentRevision: 0 },
			},
			{ wakeFailures: 1 },
		);
		const bridgeErrors: Error[] = [];
		const bridge = await HostedEngineBridge.connect({
			rpc,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			engineGeneration: runtime.engineGeneration,
			servers: broker.url,
			connectionOptions: { authenticator: nkeyAuthenticator(bridgeSeed) },
			pollIntervalMs: 10,
			heartbeatIntervalMs: 100,
			onError: error => bridgeErrors.push(error),
		});
		await waitFor(() => bridgeErrors.length > 0);
		adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			servers: broker.url,
			connectionOptions: { authenticator: nkeyAuthenticator(engineSeed) },
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => command.payload.launchProfile as typeof profile,
			onError: error => adapterErrors.push(error),
		});
		const enginePublisherConnection = await connect({
			servers: broker.url,
			authenticator: nkeyAuthenticator(engineSeed),
		});
		try {
			await waitFor(
				() =>
					rpc.events.some(event => event.type === "attempt.completed") ||
					rpc.receipts.some(receipt => receipt.stage === "rejected") ||
					adapterErrors.length > 0,
			);
			expect(rpc.receipts.filter(receipt => receipt.stage === "rejected")).toEqual([]);
			expect(adapterErrors).toEqual([]);
			await waitFor(async () => {
				const [commands, events] = await Promise.all([
					manager.consumers.info(ENGINE_COMMAND_STREAM, `engine_${adapter.engineRoute}`),
					manager.consumers.info(ENGINE_EVENT_STREAM, `host_${adapter.deviceRoute}_${adapter.engineRoute}`),
				]);
				return commands.num_ack_pending === 0 && events.num_ack_pending === 0;
			});
			expect((await runtime.store.getAttempt("attempt-hosted"))?.state).toBe("completed");
			expect(rpc.events.map(event => event.type)).toEqual([
				"command.accepted",
				"attempt.started",
				"model.started",
				"model.settled",
				"attempt.completed",
			]);
			expect(rpc.terminalStatus).toBe("completed");
			expect(rpc.receipts.map(receipt => receipt.stage)).toEqual(["engine_accepted", "applied"]);
			for (const receipt of rpc.receipts) {
				expect(receipt.target).toEqual(browserTarget);
				expect(receipt.browserPayloadHash).toBe(`sha256:${"a".repeat(64)}`);
			}
			expect(rpc.claimGenerationRequests.length).toBeGreaterThan(0);
			expect([...new Set(rpc.claimGenerationRequests)]).toEqual([runtime.engineGeneration]);
			const terminalEvent = rpc.events.find(event => event.type === "attempt.completed");
			if (!terminalEvent) throw new Error("terminal Engine event was not recorded");
			const wakeEvent = {
				...terminalEvent,
				eventId: "event-hosted-wake",
				causationCommandId: "inbox-wake:queue-hosted:2",
				type: "attempt.inbox_changed",
				payload: {
					action: "wake_due",
					queueId: "queue-hosted",
					revision: 2,
					intentRevision: 0,
					manualHold: false,
				},
			};
			await jetstream(enginePublisherConnection).publish(
				adapter.eventSubject("agent-hosted", "inbox_changed"),
				JSON.stringify(wakeEvent),
				{ msgID: "event-hosted-wake" },
			);
			await waitFor(() => rpc.wakes.length === 1, 15_000);
			expect(rpc.wakes[0]).toEqual(wakeEvent);
			expect(rpc.wakeAttempts).toEqual([wakeEvent, wakeEvent]);
			expect(rpc.wakeGenerationRequests).toEqual([runtime.engineGeneration, runtime.engineGeneration]);
			await jetstream(enginePublisherConnection).publish(
				adapter.eventSubject("agent-hosted", "completed"),
				JSON.stringify({ ...terminalEvent, eventId: "event-terminal-redelivery" }),
				{ msgID: "event-terminal-redelivery" },
			);
			await waitFor(() => rpc.terminalReplayCalls === 1);
			await waitFor(
				async () =>
					(await manager.consumers.info(ENGINE_EVENT_STREAM, `host_${adapter.deviceRoute}_${adapter.engineRoute}`))
						.num_ack_pending === 0,
			);

			await bridge.dispose();
			const retainedCommand = {
				...startCommand(cwd, profile),
				commandId: "command-hosted-retained-generation",
				executionId: "execution-hosted-retained-generation",
				attemptId: "attempt-hosted-retained-generation",
			};
			const retainedRpc = new FakeRpc(retainedCommand, {
				storedEngineGeneration: runtime.engineGeneration,
			});
			const retainedBridge = await HostedEngineBridge.connect({
				rpc: retainedRpc,
				deviceId: "device-hosted",
				engineId: "engine-hosted",
				engineGeneration: runtime.engineGeneration + 1,
				servers: broker.url,
				connectionOptions: { authenticator: nkeyAuthenticator(bridgeSeed) },
				pollIntervalMs: 10,
				heartbeatIntervalMs: 100,
			});
			try {
				await waitFor(() => retainedRpc.terminalStatus === "completed");
				expect(retainedRpc.events.every(event => event.engineGeneration === runtime.engineGeneration)).toBeTrue();
				expect(retainedRpc.claimGenerationRequests[0]).toBe(runtime.engineGeneration + 1);
			} finally {
				await retainedBridge.dispose();
			}
			const retryRpc = new FakeRpc(startCommand(cwd, profile));
			const retryBridge = await HostedEngineBridge.connect({
				rpc: retryRpc,
				deviceId: "device-hosted",
				engineId: "engine-hosted",
				engineGeneration: runtime.engineGeneration + 1,
				servers: broker.url,
				connectionOptions: { authenticator: nkeyAuthenticator(bridgeSeed) },
				pollIntervalMs: 10,
				heartbeatIntervalMs: 100,
			});
			try {
				await waitFor(() => retryRpc.events.some(event => event.type === "command.rejected"));
			} finally {
				await retryBridge.dispose();
			}
		} finally {
			await enginePublisherConnection.drain();
			await managerConnection.drain();
			await bridge.dispose();
			await adapter.dispose();
			await runtime.dispose();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
			engineSeed.fill(0);
			bridgeSeed.fill(0);
		}
	}, 60_000);

	it("delivers other agents promptly while preserving failed-agent order and draining admitted callbacks", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `artel-bridge-concurrency-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const connection = await connect({ servers: broker.url });
		const manager = await jetstreamManager(connection);
		await manager.streams.add({ name: ENGINE_EVENT_STREAM, subjects: ["grimoire.engine.v1.>"] });
		const blocked = Promise.withResolvers<void>();
		const shutdown = Promise.withResolvers<void>();
		const heartbeat = Promise.withResolvers<void>();
		const heartbeats: string[] = [];
		const calls: string[] = [];
		const accepted: string[] = [];
		const errors: Error[] = [];
		let failures = 1;
		const rpc: GrimoireRpc = {
			async call(_tool, args) {
				if (args.action === "claim") {
					if (!args.job_id) return { status: "no_job" };
					return {
						status: "claimed",
						job_id: args.job_id,
						lease_token: "lease",
						operation_type: "agent_engine_command",
						work: { kind: "command", command: { ...startCommand(tempDir!, {}), commandId: args.job_id } },
					};
				}
				if (args.action === "heartbeat") {
					heartbeats.push(String(args.job_id));
					if (args.job_id === "command-A") await heartbeat.promise;
					return { status: "renewed" };
				}
				const event = args.event as EngineEventEnvelope;
				calls.push(event.eventId);
				if (event.eventId === "A1" && failures-- > 0) {
					await blocked.promise;
					throw new Error("A callback unavailable");
				}
				if (event.eventId === "A4") await shutdown.promise;
				accepted.push(event.eventId);
				return {
					status:
						args.action === "wake" ? "accepted" : event.type === "attempt.completed" ? "completed" : "recorded",
				};
			},
		};
		const bridge = await HostedEngineBridge.connect({
			rpc,
			deviceId: "device",
			engineId: "engine",
			engineGeneration: 1,
			servers: broker.url,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 25,
			onError: error => errors.push(error),
		});
		const publish = async (id: string, wake = false) => {
			const event: EngineEventEnvelope = {
				schema: "grimoire.engine.event.v1",
				eventId: id,
				agentSeq: Number(id.slice(1)),
				causationCommandId: `command-${id[0]}`,
				deviceId: "device",
				engineId: "engine",
				engineGeneration: 1,
				agentInstanceId: id[0]!,
				runtimeBindingId: `binding-${id[0]}`,
				bindingGeneration: 1,
				executionId: `execution-${id[0]}`,
				attemptId: `attempt-${id[0]}`,
				authorityGeneration: 1,
				type: wake ? "attempt.inbox_changed" : id.endsWith("1") ? "attempt.started" : "attempt.completed",
				at: Date.now(),
				...(wake ? { payload: { action: "wake_due", queueId: id, revision: 1 } } : {}),
			};
			await jetstream(connection).publish(
				`grimoire.engine.v1.d.${engineRouteToken("device")}.e.${engineRouteToken("engine")}.a.${engineRouteToken(id[0]!)}.evt.changed`,
				JSON.stringify(event),
			);
		};
		try {
			await publish("A1");
			await waitFor(() => calls.includes("A1"));
			await publish("A2", true);
			await publish("A3");
			const beforeB = Date.now();
			await publish("B1");
			await waitFor(() => accepted.includes("B1"), 1_000);
			expect(Date.now() - beforeB).toBeLessThan(1_000);
			expect(calls.filter(id => id.startsWith("A"))).toEqual(["A1"]);
			await waitFor(() => heartbeats.includes("command-B"), 1_000);
			expect(heartbeats).toContain("command-A");
			heartbeat.resolve();
			blocked.resolve();
			await waitFor(() => errors.length === 1);
			await publish("B2");
			await waitFor(() => accepted.includes("B2"), 1_000);
			expect(calls.filter(id => id.startsWith("A"))).toEqual(["A1"]);
			await waitFor(() => accepted.includes("A3"), 15_000);
			expect(calls.filter(id => id.startsWith("A"))).toEqual(["A1", "A1", "A2", "A3"]);
			expect(accepted.filter(id => id.startsWith("A"))).toEqual(["A1", "A2", "A3"]);
			await waitFor(
				async () =>
					(
						await manager.consumers.info(
							ENGINE_EVENT_STREAM,
							`host_${engineRouteToken("device")}_${engineRouteToken("engine")}`,
						)
					).num_ack_pending === 0,
			);
			await bridge.drain();

			await publish("A4", true);
			await publish("A5");
			await publish("B3");
			await waitFor(() => accepted.includes("B3"));
			await expect(bridge.drain(25)).rejects.toThrow("event(s)");
			await bridge.stopAdmission();
			let disposed = false;
			const disposal = bridge.dispose().then(() => {
				disposed = true;
			});
			await Bun.sleep(25);
			expect(disposed).toBe(false);
			shutdown.resolve();
			await disposal;
			expect(accepted.filter(id => id.startsWith("A"))).toEqual(["A1", "A2", "A3", "A4", "A5"]);
			expect(
				(
					await manager.consumers.info(
						ENGINE_EVENT_STREAM,
						`host_${engineRouteToken("device")}_${engineRouteToken("engine")}`,
					)
				).num_ack_pending,
			).toBe(0);
			expect(errors.map(error => error.message)).toEqual(["A callback unavailable"]);
		} finally {
			heartbeat.resolve();
			blocked.resolve();
			shutdown.resolve();
			await bridge.dispose();
			await connection.drain();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30_000);

	it("replays durable inbox notifications after restart without blocking command receipts or queued wakes", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `artel-bridge-inbox-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const connection = await connect({ servers: broker.url });
		const manager = await jetstreamManager(connection);
		const js = jetstream(connection);
		const store = await EngineStore.open(path.join(tempDir, "engine.sqlite"));
		const target = {
			agentInstanceId: "agent-inbox",
			sessionId: "session",
			executionId: "execution",
			attemptId: "attempt",
			bindingId: "binding",
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		await store.enqueueInboxItem(target, {
			sourceEventId: "queue",
			sourceType: "user",
			body: "queued",
			createdAt: 1,
		});
		await store.mutateInboxItem(target, {
			mutationId: "old-query-ack",
			queueId: "queue",
			expectedRevision: 1,
			op: "acknowledge",
		});
		const oldEvents = await store.eventsAfter(target.attemptId);
		const oldAck = oldEvents[1]!;
		const envelope = (event: EngineEvent): EngineEventEnvelope => ({
			...event,
			schema: "grimoire.engine.event.v1",
			eventId: String(event.eventId),
			agentSeq: event.seq,
			deviceId: "device",
			engineId: "engine",
			runtimeBindingId: event.bindingId,
			type: event.kind === "inbox_changed" ? "attempt.inbox_changed" : "attempt.completed",
			at: event.createdAt,
		});
		const publish = async (event: EngineEventEnvelope) => {
			await js.publish(
				`grimoire.engine.v1.d.${engineRouteToken("device")}.e.${engineRouteToken("engine")}.a.${engineRouteToken(event.agentInstanceId)}.evt.changed`,
				JSON.stringify(event),
			);
		};
		const durable = `host_${engineRouteToken("device")}_${engineRouteToken("engine")}`;
		await manager.streams.add({ name: ENGINE_EVENT_STREAM, subjects: ["grimoire.engine.v1.>"] });
		await manager.consumers.add(ENGINE_EVENT_STREAM, {
			durable_name: durable,
			ack_policy: AckPolicy.Explicit,
			max_ack_pending: 128,
			filter_subject: `grimoire.engine.v1.d.${engineRouteToken("device")}.e.${engineRouteToken("engine")}.a.*.evt.*`,
		});
		for (const event of oldEvents) await publish(envelope(event));
		const consumer = await js.consumers.get(ENGINE_EVENT_STREAM, durable);
		const oldDelivery = await consumer.fetch({ max_messages: oldEvents.length, expires: 1_000 });
		for await (const message of oldDelivery) message.nak(1);
		await connection.flush();
		expect((await manager.consumers.info(ENGINE_EVENT_STREAM, durable)).num_ack_pending).toBe(2);

		const delivered: string[] = [];
		const errors: Error[] = [];
		const bridge = await HostedEngineBridge.connect({
			eventStore: store,
			deviceId: "device",
			engineId: "engine",
			engineGeneration: 2,
			servers: broker.url,
			pollIntervalMs: 10,
			onError: error => errors.push(error),
			rpc: {
				async call(_tool, args) {
					if (args.action === "claim") return { status: "no_job" };
					const event = args.event as EngineEventEnvelope;
					delivered.push(event.causationCommandId);
					if (
						event.engineGeneration === 99 ||
						!["real-control", "start-command", "inbox-wake"].includes(event.causationCommandId)
					)
						return { status: "missing" };
					return { status: args.action === "wake" ? "accepted" : "already_terminal" };
				},
			},
		});
		try {
			await store.admitCommand(
				{
					...target,
					commandId: "real-control",
					operation: "steer",
					deviceId: "device",
					engineId: "engine",
					payloadHash: "payload",
					canonicalHash: "canonical",
				},
				2,
			);
			const commandAck = await store.appendEvent({ ...oldAck, causationCommandId: "real-control" });
			await store.admitCommand(
				{
					...target,
					commandId: "start-command",
					operation: "start",
					deviceId: "device",
					engineId: "engine",
					payloadHash: "start-payload",
					canonicalHash: "start-canonical",
				},
				1,
			);
			const terminal = await store.appendEvent({
				...oldAck,
				causationCommandId: "start-command",
				kind: "completed",
				payload: {},
			});
			const wake = await store.appendEvent({
				...oldAck,
				causationCommandId: "inbox-wake",
				payload: { action: "wake_due", queueId: "next", revision: 1 },
			});
			await publish(envelope(commandAck));
			await publish(envelope(terminal));
			const nativeEvent = await store.appendEvent({ ...terminal, causationCommandId: "native-created-no-job" });
			await publish(envelope(nativeEvent));
			await publish(envelope(wake));
			await waitFor(() => delivered.includes("inbox-wake"), 1_000);
			expect(delivered).toEqual(["real-control", "start-command", "inbox-wake"]);
			await waitFor(async () => (await manager.consumers.info(ENGINE_EVENT_STREAM, durable)).num_ack_pending === 0);

			// Same provenance check also handles new query acknowledgements, without a wire marker.
			await store.enqueueInboxItem(target, {
				sourceEventId: "next",
				sourceType: "user",
				body: "next",
				createdAt: 2,
			});
			await store.mutateInboxItem(target, {
				mutationId: "new-query-ack",
				queueId: "next",
				expectedRevision: 1,
				op: "acknowledge",
			});
			for (const event of await store.eventsAfter(target.attemptId, wake.eventId)) await publish(envelope(event));
			await publish({ ...envelope(oldAck), engineGeneration: 99 });
			await publish({ ...envelope(terminal), agentInstanceId: "unknown-agent", causationCommandId: "unknown-job" });
			await waitFor(() => errors.length === 2);
			expect(delivered).toEqual(["real-control", "start-command", "inbox-wake", "old-query-ack", "unknown-job"]);
			expect((await manager.consumers.info(ENGINE_EVENT_STREAM, durable)).num_ack_pending).toBe(2);
		} finally {
			await bridge.dispose();
			await connection.drain();
			await store.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 15_000);

	it("recovers the exact hosted lease for an event after bridge state is lost", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-host-recovery-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: await Settings.loadReadOnly({ cwd, agentDir: path.join(tempDir, "agent") }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			},
		});
		const profile = { spawns: "", profileDigest: "leaf-profile-v1", enableMCP: false, enableLsp: false };
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => command.payload.launchProfile as typeof profile,
		});
		const command = startCommand(cwd, profile);
		await runtime.start(
			{
				commandId: command.commandId,
				agentInstanceId: command.agentInstanceId,
				executionId: command.executionId ?? "",
				attemptId: command.attemptId ?? "",
				authorityGeneration: command.authorityGeneration,
				cwd,
				input: "RECOVER",
			},
			profile,
		);
		await runtime.drain();
		const rpc = new FakeRpc(command, { exactRecoveryOnly: true });
		const bridge = await HostedEngineBridge.connect({
			rpc,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			engineGeneration: runtime.engineGeneration,
			servers: broker.url,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 100,
		});
		try {
			await waitFor(() => rpc.terminalStatus === "completed");
			expect(rpc.exactRecoveryClaims).toBe(1);
		} finally {
			await bridge.dispose();
			await adapter.dispose();
			await runtime.dispose();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 60_000);

	it("releases a queued wake after an exact terminal claim replaces a failed hosted fallback", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `artel-bridge-terminal-claim-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const connection = await connect({ servers: broker.url });
		const manager = await jetstreamManager(connection);
		await manager.streams.add({ name: ENGINE_EVENT_STREAM, subjects: ["grimoire.engine.v1.>"] });
		const calls: string[] = [];
		const errors: Error[] = [];
		let terminalClaimAvailable = false;
		const bridge = await HostedEngineBridge.connect({
			rpc: {
				async call(_tool, args) {
					if (args.action === "claim") {
						if (!args.job_id) return { status: "no_job" };
						if (!terminalClaimAvailable) throw new Error("Hosted fallback cannot claim the local terminal job");
						return { status: "already_terminal" };
					}
					const event = args.event as EngineEventEnvelope;
					calls.push(`${args.action}:${event.eventId}`);
					return { status: args.action === "wake" ? "accepted" : "already_terminal" };
				},
			},
			deviceId: "device",
			engineId: "engine",
			engineGeneration: 1,
			servers: broker.url,
			pollIntervalMs: 10,
			onError: error => errors.push(error),
		});
		try {
			for (const [index, type] of ["model.settled", "attempt.completed", "attempt.inbox_changed"].entries()) {
				const event: EngineEventEnvelope = {
					schema: "grimoire.engine.event.v1",
					eventId: String(index + 1),
					agentSeq: index + 1,
					causationCommandId: "local-terminal-job",
					deviceId: "device",
					engineId: "engine",
					engineGeneration: 1,
					agentInstanceId: "agent",
					runtimeBindingId: "binding",
					bindingGeneration: 1,
					executionId: "execution",
					attemptId: "attempt",
					authorityGeneration: 1,
					type,
					at: Date.now(),
					...(index === 2 ? { payload: { action: "wake_due", queueId: "queued-B", revision: 2 } } : {}),
				};
				await jetstream(connection).publish(
					`grimoire.engine.v1.d.${engineRouteToken("device")}.e.${engineRouteToken("engine")}.a.${engineRouteToken("agent")}.evt.test`,
					new TextEncoder().encode(JSON.stringify(event)),
				);
			}
			await waitFor(() => errors.length > 0);
			expect(calls).toEqual([]);
			const durable = `host_${engineRouteToken("device")}_${engineRouteToken("engine")}`;
			await waitFor(async () => (await manager.consumers.info(ENGINE_EVENT_STREAM, durable)).num_ack_pending === 3);
			terminalClaimAvailable = true;
			await waitFor(() => calls.includes("wake:3"));
			expect(calls).toEqual(["event:1", "event:2", "wake:3"]);
			await waitFor(async () => (await manager.consumers.info(ENGINE_EVENT_STREAM, durable)).num_ack_pending === 0);
			await bridge.drain();
		} finally {
			await bridge.dispose();
			await connection.drain();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 30_000);

	it("keeps a live claim after one transient heartbeat failure", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-host-heartbeat-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const prompt = Promise.withResolvers<boolean>();
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: () => prompt.promise,
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: await Settings.loadReadOnly({ cwd, agentDir: path.join(tempDir, "agent") }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			},
		});
		const profile = { spawns: "", profileDigest: "leaf-profile-v1", enableMCP: false, enableLsp: false };
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => command.payload.launchProfile as typeof profile,
		});
		const rpc = new FakeRpc(startCommand(cwd, profile), { heartbeatFailures: 1 });
		const bridge = await HostedEngineBridge.connect({
			rpc,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			engineGeneration: runtime.engineGeneration,
			servers: broker.url,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 25,
		});
		try {
			await waitFor(() => rpc.heartbeatCalls >= 1);
			prompt.resolve(true);
			await waitFor(() => rpc.terminalStatus === "completed");
			expect(rpc.exactRecoveryClaims).toBe(0);
		} finally {
			await bridge.dispose();
			await adapter.dispose();
			await runtime.dispose();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 60_000);

	it("delivers a graceful interruption before disconnecting the event path", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-host-shutdown-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const dispatch = Promise.withResolvers<boolean>();
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async session => {
				const abort = session.abort.bind(session);
				session.abort = async options => {
					dispatch.resolve(false);
					return await abort(options);
				};
				return await dispatch.promise;
			},
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: await Settings.loadReadOnly({ cwd, agentDir: path.join(tempDir, "agent") }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			},
		});
		const profile = { spawns: "", profileDigest: "leaf-profile-v1", enableMCP: false, enableLsp: false };
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => command.payload.launchProfile as typeof profile,
		});
		const rpc = new FakeRpc(startCommand(cwd, profile));
		const bridge = await HostedEngineBridge.connect({
			rpc,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			engineGeneration: runtime.engineGeneration,
			servers: broker.url,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 100,
		});
		try {
			await waitFor(() => rpc.events.some(event => event.type === "attempt.started"));
			await bridge.stopAdmission();
			await adapter.stopAdmission();
			await runtime.dispose({ closeStore: false });
			await adapter.dispose();
			await bridge.drain();
			expect(rpc.terminalStatus).toBe("interrupted");
			expect(rpc.events.filter(event => event.type === "attempt.interrupted")).toHaveLength(1);
			expect(
				(await runtime.store.pendingEventsForSink(`nats:${adapter.deviceRoute}:${adapter.engineRoute}`)).events,
			).toEqual([]);
		} finally {
			await bridge.dispose();
			await adapter.dispose();
			await runtime.dispose({ closeStore: false });
			await runtime.store.close();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 60_000);

	it("allows only one service owner for a database across runtime directories", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-service-lock-${Snowflake.next()}-`));
		const stop = Promise.withResolvers<void>();
		const firstRuntimeDir = path.join(tempDir, "runtime-a");
		const secondRuntimeDir = path.join(tempDir, "runtime-b");
		const config = {
			deviceId: "device-lock",
			engineId: "engine-lock",
			runtimeDir: firstRuntimeDir,
			databasePath: path.join(tempDir, "data", "engine.sqlite"),
			natsServerPath: natsServer,
		};
		const first = runEngineService(config, stop.promise);
		await waitFor(async () => {
			try {
				return JSON.parse(await Bun.file(path.join(firstRuntimeDir, "status.json")).text()).status === "running";
			} catch {
				return false;
			}
		});
		await expect(
			runEngineService(
				{
					...config,
					runtimeDir: secondRuntimeDir,
					databasePath: path.join(tempDir, "data", "..", "data", "engine.sqlite"),
				},
				Promise.resolve(),
			),
		).rejects.toThrow("database is already owned");
		expect(await Bun.file(path.join(secondRuntimeDir, "nats.conf")).exists()).toBe(false);
		stop.resolve();
		await first;
	}, 60_000);
});

describe("HostedGrimoireRpc", () => {
	it("surfaces MCP child-launch failures before identity validation or follow-up calls", async () => {
		const calls: string[] = [];
		let result: Record<string, unknown>;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { id: number; params: { name: string } };
				calls.push(body.params.name);
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			},
		});
		try {
			const rpc = new HostedGrimoireRpc({
				serverUrl: `http://127.0.0.1:${server.port}/mcp/core`,
				token: "local-test-token",
				clientId: "test-client",
			});
			for (const failure of [
				{
					result: {
						isError: true,
						structuredContent: { error: "profile unavailable" },
						content: [{ type: "text", text: "Profile hydration failed" }],
					},
					message: "Profile hydration failed",
				},
				{
					result: { isError: true, content: [{ type: "text", text: "Permission denied" }] },
					message: "Permission denied",
				},
				{
					result: { isError: true, structuredContent: { error: { message: "Upstream unavailable" } } },
					message: "Upstream unavailable",
				},
				{ result: { isError: true }, message: "unknown error" },
			]) {
				result = failure.result;
				await expect(
					launchHostedEngineChild(rpc, {
						deviceId: "device",
						engineId: "engine",
						parentAgentInstanceRef: "grimoire://tasks/p/t/agents/parent",
						parentAttemptId: "attempt-parent",
						profileRef: "gctx:2222222222222222",
						workStepId: "implement",
						cwd: "/tmp",
						maxSpawnDepth: 0,
						cancelLocal: async () => {
							throw new Error("No child was allocated");
						},
						waitLocal: async () => {
							throw new Error("No child was allocated");
						},
					}),
				).rejects.toThrow(`Grimoire Host tool grimoire_agent_engine_child_launch failed: ${failure.message}`);
			}
			expect(calls).toEqual(Array(4).fill("grimoire_agent_engine_child_launch"));
		} finally {
			server.stop(true);
		}
	});

	it("uses an exact shared-host MCP surface endpoint", async () => {
		let requestPath = "";
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				requestPath = new URL(request.url).pathname;
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: { structuredContent: { status: "ok" } },
				});
			},
		});
		try {
			const rpc = new HostedGrimoireRpc({
				serverUrl: `http://127.0.0.1:${server.port}/mcp/core`,
				token: "local-test-token",
				clientId: "test-client",
			});
			expect(await rpc.call("test_tool", {})).toEqual({ status: "ok" });
			expect(requestPath).toBe("/mcp/core");
		} finally {
			server.stop(true);
		}
	});
});

describe("hosted child launch", () => {
	const stores: EngineStore[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		for (const store of stores.splice(0)) await store.close();
		for (const directory of directories.splice(0)) removeSyncWithRetries(directory);
	});
	async function childFixture(name: string) {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "engine-child-wait-"));
		directories.push(directory);
		const store = await EngineStore.open(path.join(directory, "engine.sqlite"));
		stores.push(store);
		const generation = await store.nextEngineGeneration();
		const agentInstanceRef = `grimoire://tasks/p/t/agents/${name}`;
		const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
		await store.registerAgent({ agentInstanceId, agentInstanceRef, authorityGeneration: 1, principalId: "owner" });
		const target: EngineBindingSnapshot = {
			agentInstanceId,
			bindingId: `binding-${name}`,
			commandId: `start-${name}`,
			executionId: `execution-${name}`,
			attemptId: `attempt-${name}`,
			engineAgentId: engineAgentId(agentInstanceId),
			profileDigest: "profile",
			state: "running",
			engineGeneration: generation,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		await store.admitCommand(
			{
				...target,
				operation: "start",
				agentInstanceRef,
				principalId: "owner",
				deviceId: "device",
				engineId: "engine",
				payloadHash: "payload",
				canonicalHash: "canonical",
			},
			generation,
		);
		await store.commitAttemptTransition(target, "running", [{ kind: "running" }]);
		const calls: string[] = [];
		const rpc: GrimoireRpc = {
			async call(tool, args) {
				calls.push(tool);
				if (tool === "grimoire_agent_engine_child_launch")
					return {
						agent_instance: { agent_instance_ref: agentInstanceRef },
						job: { job_id: target.commandId, payload: { command: { attemptId: target.attemptId } } },
					};
				if (tool === "grimoire_job_cancel") {
					expect(args.job_id).toBe(target.commandId);
					return { status: "cancelled" };
				}
				throw new Error(`Unexpected Core poll ${tool}`);
			},
		};
		const request = {
			deviceId: "device",
			engineId: "engine",
			parentAgentInstanceRef: "grimoire://tasks/p/t/agents/parent",
			parentAttemptId: "attempt-parent",
			profileRef: "gctx:2222222222222222",
			workStepId: "implement",
			cwd: "/tmp",
			maxSpawnDepth: 0,
			cancelLocal: async () => {},
			waitLocal: store.waitAttemptResult.bind(store),
		};
		return { store, target, calls, rpc, request, agentInstanceRef };
	}
	it("waits for the exact terminal Attempt full result without Core job polling", async () => {
		const { store, target, calls, rpc, request } = await childFixture("child-1");
		const answer = `${"large child result\n".repeat(4000)}CHILD-END`;
		const entered = Promise.withResolvers<void>();
		let settled = false;
		const pending = launchHostedEngineChild(rpc, {
			...request,
			waitLocal: (...args) => {
				entered.resolve();
				return store.waitAttemptResult(...args);
			},
		}).then(result => {
			settled = true;
			return result;
		});
		await entered.promise;
		expect(settled).toBeFalse();
		await store.commitAttemptTransition(
			target,
			"completed",
			[{ kind: "completed", payload: { assistantFinal: "compact preview", outputTruncated: true } }],
			{ terminalResult: { assistantFinal: answer, transcriptRef: "history://Engine-full-child" } },
		);
		const result = await pending;
		expect(result).toMatchObject({
			agentInstanceId: target.agentInstanceId,
			status: "completed",
			assistantFinal: answer,
			transcriptRef: "history://Engine-full-child",
		});
		expect(result.outputTruncated).toBeUndefined();
		expect(calls).toEqual(["grimoire_agent_engine_child_launch"]);
	});
	it("returns retained completion and enrolls the immutable child Attempt", async () => {
		const { store, target, calls, rpc, request, agentInstanceRef } = await childFixture("child-retained");
		await store.commitAttemptTransition(target, "completed", [
			{
				kind: "completed",
				payload: {
					assistantFinal: "done",
					transcriptRef: "history://Engine-child-transport",
					outputTruncated: true,
				},
			},
		]);
		const enrolled: Array<{ ref: string; attemptId?: string }> = [];
		const result = await launchHostedEngineChild(rpc, {
			...request,
			enrollChild: async (ref, attemptId) => {
				enrolled.push({ ref, attemptId });
			},
		});
		expect(result).toMatchObject({
			status: "completed",
			assistantFinal: "done",
			transcriptRef: "history://Engine-child-transport",
			outputTruncated: true,
		});
		expect(enrolled).toEqual(Array(2).fill({ ref: agentInstanceRef, attemptId: target.attemptId }));
		expect(calls).toEqual(["grimoire_agent_engine_child_launch"]);
	});
	it.each(["failed", "interrupted"] as const)("returns an exact %s child error and transcript", async state => {
		const { store, target, calls, rpc, request } = await childFixture(`child-${state}`);
		await store.commitAttemptTransition(target, state, [{ kind: state }], {
			terminalResult: { error: "Retry budget exhausted", transcriptRef: "history://Engine-failed-child" },
		});
		expect(await launchHostedEngineChild(rpc, request)).toMatchObject({
			status: "failed",
			error: "Retry budget exhausted",
			transcriptRef: "history://Engine-failed-child",
		});
		expect(calls).toEqual(["grimoire_agent_engine_child_launch"]);
	});
	it("cancels an aborted wait by its exact Engine identity without Core job polling", async () => {
		const { store, target, calls, rpc, request } = await childFixture("child-cancel");
		const controller = new AbortController();
		const cancelled: string[] = [];
		const result = await launchHostedEngineChild(rpc, {
			...request,
			signal: controller.signal,
			waitLocal: (...args) => {
				const pending = store.waitAttemptResult(...args);
				queueMicrotask(() => controller.abort());
				return pending;
			},
			cancelLocal: async agentId => {
				cancelled.push(agentId);
			},
		});
		expect(cancelled).toEqual([target.agentInstanceId]);
		expect(result).toMatchObject({ agentInstanceId: target.agentInstanceId, status: "cancelled" });
		expect(calls).toEqual(["grimoire_agent_engine_child_launch", "grimoire_job_cancel"]);
	});
});

class FakeRpc implements GrimoireRpc {
	readonly receipts: Array<Record<string, unknown>> = [];
	readonly events: Array<Record<string, unknown>> = [];
	readonly wakes: Array<Record<string, unknown>> = [];
	readonly wakeAttempts: Array<Record<string, unknown>> = [];
	readonly claimGenerationRequests: number[] = [];
	readonly wakeGenerationRequests: number[] = [];
	terminalStatus: string | undefined;
	terminalReplayCalls = 0;
	heartbeatCalls = 0;
	exactRecoveryClaims = 0;
	#claimed = false;
	#leaseToken = "lease-hosted";
	#heartbeatFailures: number;
	#wakeFailures: number;
	#storedEngineGeneration: number | undefined;

	constructor(
		readonly command: Omit<EngineCommandEnvelope, "engineGeneration">,
		readonly options: {
			exactRecoveryOnly?: boolean;
			heartbeatFailures?: number;
			storedEngineGeneration?: number;
			wakeFailures?: number;
		} = {},
	) {
		this.#heartbeatFailures = options.heartbeatFailures ?? 0;
		this.#wakeFailures = options.wakeFailures ?? 0;
		this.#storedEngineGeneration = options.storedEngineGeneration;
	}

	async call(_tool: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
		switch (arguments_.action) {
			case "accepted":
				if (arguments_.lease_token !== this.#leaseToken) throw new Error("active lease is required");
				this.receipts.push(arguments_.receipt as Record<string, unknown>);
				return { status: "accepted" };
			case "claim":
				if (!Number.isSafeInteger(arguments_.engine_generation) || Number(arguments_.engine_generation) <= 0) {
					throw new Error("claim engine_generation is required");
				}
				this.claimGenerationRequests.push(Number(arguments_.engine_generation));
				this.#storedEngineGeneration ??= Number(arguments_.engine_generation);
				if (this.#claimed || (this.options.exactRecoveryOnly && arguments_.job_id !== this.command.commandId)) {
					return { status: "no_job" };
				}
				this.#claimed = true;
				if (arguments_.job_id === this.command.commandId) this.exactRecoveryClaims++;
				return {
					status: "claimed",
					job_id: this.command.commandId,
					operation_type: "agent_engine_command",
					lease_token: this.#leaseToken,
					work: {
						kind: "command",
						command: { ...this.command, engineGeneration: this.#storedEngineGeneration },
					},
				};
			case "heartbeat":
				this.heartbeatCalls++;
				if (this.#heartbeatFailures-- > 0) throw new Error("temporary heartbeat failure");
				return { status: "renewed" };
			case "wake":
				if (!Number.isSafeInteger(arguments_.engine_generation) || Number(arguments_.engine_generation) <= 0) {
					throw new Error("wake engine_generation is required");
				}
				this.wakeGenerationRequests.push(Number(arguments_.engine_generation));
				this.wakeAttempts.push(arguments_.event as Record<string, unknown>);
				if (this.#wakeFailures-- > 0) throw new Error("temporary wake bridge failure");
				this.wakes.push(arguments_.event as Record<string, unknown>);
				return { status: this.wakes.length === 1 ? "accepted" : "duplicate", job_id: "command-hosted-wake" };
			case "event": {
				const event = arguments_.event as Record<string, unknown>;
				if (arguments_.lease_token !== this.#leaseToken) {
					if (!arguments_.lease_token && this.terminalStatus === "completed") {
						this.terminalReplayCalls++;
						return { status: "already_terminal" };
					}
					throw new Error("active lease is required");
				}
				this.events.push(event);
				const terminal = event.type === "attempt.completed" || event.type === "attempt.interrupted";
				if (terminal) this.terminalStatus = event.type === "attempt.completed" ? "completed" : "interrupted";
				return { status: terminal ? (event.type === "attempt.completed" ? "completed" : "cancelled") : "recorded" };
			}
			default:
				throw new Error(`Unexpected bridge action ${String(arguments_.action)}`);
		}
	}
}

function startCommand(cwd: string, profile: Record<string, unknown>): Omit<EngineCommandEnvelope, "engineGeneration"> {
	return {
		schema: "grimoire.engine.command.v1",
		commandId: "command-hosted",
		op: "start",
		deviceId: "device-hosted",
		engineId: "engine-hosted",
		agentInstanceId: "agent-hosted",
		executionId: "execution-hosted",
		attemptId: "attempt-hosted",
		authorityGeneration: 1,
		issuedAt: Date.now(),
		payload: {
			cwd,
			input: "HOSTED",
			profileDigest: profile.profileDigest,
			launchProfile: profile,
		},
	};
}

async function startNatsServer(root: string, authenticated = false) {
	const portsDir = path.join(root, "ports");
	const dataDir = path.join(root, "jetstream");
	fs.mkdirSync(portsDir);
	let engineSeed: Uint8Array | undefined;
	let bridgeSeed: Uint8Array | undefined;
	let args = [natsServer, "-js", "-a", "127.0.0.1", "-p", "-1", "--ports_file_dir", portsDir, "-sd", dataDir];
	if (authenticated) {
		const engineKey = nkeys.createUser();
		const bridgeKey = nkeys.createUser();
		engineSeed = engineKey.getSeed().slice();
		bridgeSeed = bridgeKey.getSeed().slice();
		const configPath = path.join(root, "nats.conf");
		fs.writeFileSync(configPath, natsConfig(dataDir, engineKey.getPublicKey(), bridgeKey.getPublicKey()));
		engineKey.clear();
		bridgeKey.clear();
		args = [natsServer, "-c", configPath, "--ports_file_dir", portsDir];
	}
	const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", windowsHide: true });
	try {
		let manifest: { nats?: string[] } | undefined;
		await waitFor(async () => {
			const files = await Array.fromAsync(new Bun.Glob("*.ports").scan({ cwd: portsDir, onlyFiles: true }));
			if (!files[0]) return false;
			manifest = (await Bun.file(path.join(portsDir, files[0])).json()) as { nats?: string[] };
			return Boolean(manifest.nats?.[0]);
		});
		return { process, url: manifest?.nats?.[0] ?? "", engineSeed, bridgeSeed };
	} catch (error) {
		process.kill();
		await process.exited;
		engineSeed?.fill(0);
		bridgeSeed?.fill(0);
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
