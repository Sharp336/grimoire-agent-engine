import { expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type EngineCommandEnvelope, engineCommandIdentity } from "../src/engine/nats-adapter";
import type { RocksAttempt, RocksBinding, RocksCommand } from "../src/engine/rocks-runtime-rows";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { engineAgentInstanceId } from "../src/engine/route";
import { EngineRuntime, type EngineRuntimeOptions } from "../src/engine/runtime";
import { launchLocalEngineChild, runEngineService } from "../src/engine/service";
import * as storage from "../src/session/storage-client";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { admittedExecution, admitRequest, admitStart, startRequest, type AdmittedExecutionFixture } from "./helpers/engine-runtime-admitted-fixture";
import { semanticBinding } from "./helpers/runtime-v1-rocks-fixture";

const natsServer =
	process.env.GRIMOIRE_NATS_SERVER ?? path.join(process.env.LOCALAPPDATA ?? "", "Grimoire", "bin", "nats-server.exe");

/**
 * One local Child prepare server over the exact HostedGrimoireRpc protocol: prepare_child_start answers with a
 * fully admitted typed Start command bound to the admitted execution, plus the exact AgentInstance projection
 * the service loop needs to see the child lifecycle after reconnect.
 */
function localChildPrepareServer(options: {
	execution: AdmittedExecutionFixture;
	runtime: () => EngineRuntime | undefined;
	onCommand?(command: EngineCommandEnvelope): void;
}) {
	const projected = new Map<string, Record<string, unknown>>();
	const calls: string[] = [];
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests++;
			const body = (await request.json()) as {
				id: number;
				params?: { name?: string; arguments?: Record<string, unknown> };
			};
			const name = body.params?.name ?? "mcp-handshake";
			calls.push(name);
			const args = body.params?.arguments ?? {};
			let result: Record<string, unknown> = { status: "no_job", generation: 1, changed: false };
			if (name === "prepare_child_start") {
				const runtime = options.runtime();
				if (!runtime) throw new Error("Prepare arrived before the runtime was created");
				const childExecution = options.childExecution?.() ?? options.execution;
				const suffix = String(args.toolCallId ?? "child");
				const agentInstanceRef = `grimoire://tasks/grimoire/child-test/agents/agent-${suffix}-${crypto.randomUUID()}`;
				const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
				const typed = startRequest(
					childExecution,
					{
						commandId: `child-command-${suffix}`,
						agentInstanceId,
						agentInstanceRef,
						executionId: `child-execution-${suffix}`,
						attemptId: `child-attempt-${suffix}`,
					},
					{
						cwd: String(args.cwd),
						principalId: String(args.principalId),
						input: String(args.assignment),
						parentAgentInstanceId: String(args.parentAgentInstanceId),
						parentAgentInstanceRef: String(args.parentAgentInstanceRef),
					},
				);
				// The wire Start the Engine transports perform: the captured immutable envelope from the typed request.
				const { commandId, agentInstanceId: _id, agentInstanceRef: _ref, bindingSnapshot, executionId, attemptId,
					authorityGeneration, principalId, ...payload } = typed;
				const command: EngineCommandEnvelope = {
					schema: "grimoire.engine.command.v1", op: "start", commandId,
					deviceId: "engine-runtime-test-device", engineId: "child-test-engine",
					engineGeneration: runtime.engineGeneration, agentInstanceId, agentInstanceRef, bindingSnapshot,
					parentAgentInstanceId: typed.parentAgentInstanceId, parentAgentInstanceRef: typed.parentAgentInstanceRef,
					executionId, attemptId, authorityGeneration, principalId,
					issuedAt: Date.now(), payload,
				};
				const settled = childExecution.captureCommand(command);
				options.onCommand?.(settled);
				result = {
					status: "prepared",
					command: settled,
					agentInstanceRef,
					agentInstanceId,
					bindingSnapshot: {
						...bindingSnapshot,
						parentAgentInstanceRef: typed.parentAgentInstanceRef,
						parentAttemptId: String(args.parentAttemptId),
						parentBindingRevision: 0,
					},
				};
			} else if (name === "grimoire_agent_instance") {
				const ref =
					args.action === "create"
						? `${args.task_ref}/agents/${args.agent_instance_id}`
						: String(args.agent_instance_ref);
				if (args.action === "create" && !projected.has(ref))
					projected.set(ref, {
						...args,
						agent_instance_ref: ref,
						owner_principal_id: "test-owner",
						binding_revision: 0,
						execution_owner_installation_id: null,
						revision: 1,
					});
				const agent = projected.get(ref)!;
				if (args.action === "update") {
					expect(args.expected_revision).toBe(agent.revision);
					Object.assign(agent, { status: args.status, revision: Number(agent.revision) + 1 });
				}
				result = { agent_instance: agent };
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: result } });
		},
	});
	return {
		server,
		projected,
		calls,
		get requests() {
			return requests;
		},
	};
}

// The caller supplies an isolated real Rust owner, never an existing user contour.
it.skipIf(!Bun.env.ARTEL_STORAGE_TEST_BINDING || !Bun.env.ARTEL_STORAGE_TEST_RUN_ROOT || !existsSync(natsServer))(
	"persists child assignment/result once across concurrent retries and Engine restart on RocksDB",
	async () => {
		const root = Bun.env.ARTEL_STORAGE_TEST_RUN_ROOT!;
		const binding = storage.readStorageBinding(Bun.env.ARTEL_STORAGE_TEST_BINDING)!;
		const readBinding = spyOn(storage, "readStorageBinding").mockReturnValue(binding);
		const auth = createInMemoryAuthStorage();
		auth.setRuntimeApiKey("mock", "test-key");
		registerMockApi("local-child-rocks");
		let calls = 0;
		const model = createMockModel({
			handler: context => {
				calls++;
				expect(JSON.stringify(context.messages.find(message => message.role === "user"))).toContain(
					"Inspect local evidence 42",
				);
				return { content: ["Verified local evidence 42"] };
			},
		});
		const modelRegistry = new ModelRegistry(auth);
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		const parentTaskRef = "grimoire://tasks/grimoire/child-test";
		// The admitted typed execution every local child Start consumes read-only.
		const execution = admittedExecution(model.model, modelRegistry, { taskRef: parentTaskRef });
		const executions = [execution];
		const fixtureOptionsFor = (deviceId: string): Pick<
			EngineRuntimeOptions,
			"deviceId" | "resolveExecution" | "verifyOriginReceipt" | "verifyApprovalReceipt"
		> => ({
			deviceId,
			resolveExecution: async (config, frozen, attempt, cwd, signal) => {
				for (const candidate of executions) {
					const options = candidate.optionsFor({ deviceId });
					try {
						return await options.resolveExecution!(config, frozen, attempt, cwd, signal);
					} catch {
						continue;
					}
				}
				throw new Error("Unregistered fixture execution");
			},
			verifyOriginReceipt: async identity => {
				for (const candidate of executions)
					if (candidate.receipts.has(identity.originReceiptId))
						return candidate.optionsFor({ deviceId }).verifyOriginReceipt!(identity);
				throw new Error("Unknown fixture origin");
			},
			verifyApprovalReceipt: async identity => {
				for (const candidate of executions)
					if (candidate.decisions.has(identity.originReceiptId))
						return candidate.optionsFor({ deviceId }).verifyApprovalReceipt!(identity);
				throw new Error("Unknown fixture approval");
			},
		});
		let runtime: EngineRuntime | undefined;
		let structuredExecution: AdmittedExecutionFixture | undefined;
		let hosted = localChildPrepareServer({
			execution,
			runtime: () => runtime,
			childExecution: () => structuredExecution ?? execution,
		});
		const parentAgentInstanceRef = `grimoire://tasks/grimoire/child-test/agents/parent-${crypto.randomUUID()}`;
		const request = {
			parentAgentInstanceId: engineAgentInstanceId(parentAgentInstanceRef),
			parentAgentInstanceRef,
			parentAttemptId: "parent-attempt",
			parentBindingSnapshot: semanticBinding(parentAgentInstanceRef, parentTaskRef),
			principalId: "test-owner",
			authorityGeneration: 1,
			target: { task_ref: parentTaskRef, work_step_id: null },
			assignment: "Inspect local evidence 42",
			toolCallId: "call-1",
			cwd,
			maxSpawnDepth: 0,
			deviceId: "fixture-device",
			engineId: "fixture-engine",
			enrollChild: async () => {},
		};
		try {
			runtime = await EngineRuntime.create({
				databasePath: path.join(root, "must-not-open.sqlite"),
				sessionDefaults: {
					cwd,
					agentDir: path.join(root, "agent"),
					settings: await Settings.loadReadOnly({
						cwd,
						agentDir: path.join(root, "agent"),
						overrides: { "compaction.enabled": false },
					}),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					modelRegistry,
				},
				...execution.optionsFor({ deviceId: "fixture-device" }),
			});
			await runtime.store.registerAgent({
				agentInstanceId: request.parentAgentInstanceId,
				agentInstanceRef: request.parentAgentInstanceRef,
				principalId: "test-owner",
				authorityGeneration: 1,
			});
			const [first, duplicate] = await Promise.all([
				launchLocalEngineChild(runtime, hosted.server, request),
				launchLocalEngineChild(runtime, hosted.server, request),
			]);
			expect(first).toMatchObject({ status: "completed", assistantFinal: "Verified local evidence 42" });
			expect(duplicate).toEqual(first);
			expect(first.agentInstanceRef).toMatch(
				/^grimoire:\/\/tasks\/grimoire\/child-test\/agents\/agent-[a-z0-9-]+-[a-f0-9-]{36}$/,
			);
			expect(calls).toBe(1);
			const childBinding = (await runtime.store.getBinding(first.agentInstanceId))!;
			const command = (await runtime.store.getStartConversationIdentity(childBinding.commandId))!;
			expect(JSON.parse(command.serializedCommand!).payload).toMatchObject({ input: request.assignment });
			expect(childBinding.bindingSnapshot).toEqual({
				...semanticBinding(first.agentInstanceRef!, parentTaskRef),
				parentAgentInstanceRef: request.parentAgentInstanceRef,
				parentAttemptId: request.parentAttemptId,
				parentBindingRevision: 0,
			});
			await expect(
				launchLocalEngineChild(runtime, hosted.server, { ...request, assignment: "changed" }),
			).rejects.toThrow();
			// Materialize the exact pre-S0 durable shape, not a new command with an old commandId.
			const legacyCommand: EngineCommandEnvelope = JSON.parse(command.serializedCommand!);
			delete legacyCommand.bindingSnapshot;
			if (!isRecord(legacyCommand.payload.localChild)) throw new Error("Child birth was not retained");
			delete legacyCommand.payload.localChild.agentInstanceId;
			delete legacyCommand.payload.localChild.workStepId;
			const legacyIdentity = engineCommandIdentity(legacyCommand);
			const legacyDigest = command.canonicalHash;
			await runtime.store.mutation(first.agentInstanceId, async tx => {
				const row = (await tx.get<RocksCommand>("command", childBinding.commandId))!;
				await tx.put("command", row.command_id, {
					...row, identity: legacyIdentity, canonical_hash: legacyIdentity.canonicalHash,
					payload_bytes: Buffer.byteLength(legacyIdentity.serializedCommand!),
				});
				const attempt = (await tx.get<RocksAttempt>("attempt", childBinding.attemptId))!;
				// Terminal Attempt rewrites must predicate the absence of open effects, even when only metadata changes.
				const effects = await tx.get<{ count: number }>("metadata", `effects:${attempt.attempt_id}:${attempt.binding_id}`);
				expect(effects?.count ?? 0).toBe(0);
				delete attempt.binding_snapshot;
				await tx.put("attempt", childBinding.attemptId, attempt);
				const binding = (await tx.get<RocksBinding>("binding", first.agentInstanceId))!;
				delete binding.binding_snapshot;
				await tx.put("binding", first.agentInstanceId, binding);
			});
			await runtime.dispose();
			runtime = await EngineRuntime.create({
				databasePath: path.join(root, "must-not-open.sqlite"),
				sessionDefaults: {
					cwd,
					agentDir: path.join(root, "agent"),
					settings: await Settings.loadReadOnly({
						cwd,
						agentDir: path.join(root, "agent"),
						overrides: { "compaction.enabled": false },
					}),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					modelRegistry,
				},
				...execution.optionsFor({ deviceId: "fixture-device" }),
			});
			// Replay uses the admitted snapshot and terminal result, without a fresh provider call.
			expect(await launchLocalEngineChild(runtime, hosted.server, request)).toEqual(first);
			expect(calls).toBe(1);
			expect((await runtime.store.getStartConversationIdentity(childBinding.commandId))?.serializedCommand)
				.toBe(legacyIdentity.serializedCommand);
			expect((await runtime.store.getBinding(first.agentInstanceId))?.sessionFile).toBe(childBinding.sessionFile);
			expect((await runtime.store.getStartConversationIdentity(childBinding.commandId))?.canonicalHash).toBe(
				legacyDigest,
			);
			expect(JSON.stringify(await runtime.store.nativeHistoryPage(first.agentInstanceId))).toContain(
				"Verified local evidence 42",
			);
			await expect(
				launchLocalEngineChild(runtime, hosted.server, {
					...request,
					toolCallId: "too-large",
					assignment: "я".repeat(16_385),
				}),
			).rejects.toThrow("exceeds");
			await expect(
				launchLocalEngineChild(runtime, hosted.server, {
					...request,
					toolCallId: "missing-target",
					target: { task_ref: "", work_step_id: null },
				}),
			).rejects.toThrow("real Task or WorkStep");
			await runtime.dispose();
			runtime = undefined;
			// The same prepare server also serves the Engine service's hosted callback below.
			const structuredChildModel = createMockModel({
				handler: context => {
					calls++;
					expect(JSON.stringify(context.messages.find(message => message.role === "user"))).toContain(
						"Inspect local evidence 42",
					);
					return {
						content: [
							{
								type: "toolCall",
								name: "yield",
								arguments: { result: { data: { evidence: 42, verified: true } } },
							},
						],
					};
				},
			});
			// The service-phase child yields structured output; its own admitted execution carries the yield contract.
			structuredExecution = admittedExecution(structuredChildModel.model, modelRegistry, {
				taskRef: parentTaskRef,
				continuation: { requireYieldTool: true, outputSchema: { type: "object", required: ["evidence", "verified"] } },
			});
			executions.push(structuredExecution);
			const parentModel = createMockModel({
				handler: context => {
					const result = context.messages.find(message => message.role === "toolResult");
					if (!result)
						return {
							content: [
								{
									type: "toolCall",
									name: "task",
									arguments: {
										target: { task_ref: parentTaskRef, work_step_id: null },
										assignment: request.assignment,
									},
								},
							],
						};
					expect(result.isError).not.toBeTrue();
					expect(result.details).toMatchObject({
						results: [
							{
								agentInstanceRef: expect.stringContaining("grimoire://tasks/grimoire/child-test/agents/"),
								transcriptRef: expect.stringContaining("history://"),
								output: '{"evidence":42,"verified":true}',
								exitCode: 0,
								structuredOutput: {
									source: "session",
									status: "valid",
									data: { evidence: 42, verified: true },
								},
							},
						],
					});
					expect(JSON.stringify(result)).toContain('{"evidence":42,"verified":true}');
					return { content: ["Parent received local child result"] };
				},
			});
			const parentExecution = admittedExecution(parentModel.model, modelRegistry, {
				taskRef: parentTaskRef,
				// The service parent spawns one local child then reports its structured result.
				spawn: { allowed: "yes", max_depth: 1, max_children: 1, on_exceed: "deny" },
			});
			executions.push(parentExecution);
			const originalCreate = EngineRuntime.create.bind(EngineRuntime);
			const create = spyOn(EngineRuntime, "create").mockImplementation(async serviceOptions => {
				runtime = await originalCreate({
					...serviceOptions,
					sessionDefaults: {
						cwd,
						agentDir: path.join(root, "agent"),
						settings: await Settings.loadReadOnly({
							cwd,
							agentDir: path.join(root, "agent"),
							overrides: { "compaction.enabled": false },
						}),
						disableExtensionDiscovery: true,
						skills: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						enableMCP: false,
						enableLsp: false,
						modelRegistry,
					},
					...fixtureOptionsFor(request.deviceId),
				});
				return runtime;
			});
			const stop = Promise.withResolvers<void>();
			const serviceAttempt = `service-parent-${crypto.randomUUID()}`;
			const runtimeDir = path.join(root, "service");
			const service = runEngineService(
				{
					deviceId: request.deviceId,
					engineId: request.engineId,
					runtimeDir,
					databasePath: path.join(root, "must-not-open.sqlite"),
					natsServerPath: natsServer,
					hosted: { serverUrl: hosted.url.toString(), token: "test-token", clientId: "fixture" },
				},
				stop.promise,
			);
			try {
				const deadline = Date.now() + 15_000;
				while (!(await Bun.file(path.join(runtimeDir, "status.json")).exists())) {
					if (Date.now() > deadline) throw new Error("Service did not become ready");
					await Promise.race([service, Bun.sleep(20)]);
				}
				const serviceRuntime = runtime! as EngineRuntime;
				const parentRequest = startRequest(
					parentExecution,
					{
						commandId: serviceAttempt,
						agentInstanceId: request.parentAgentInstanceId,
						agentInstanceRef: request.parentAgentInstanceRef,
						executionId: serviceAttempt,
						attemptId: serviceAttempt,
					},
					{ cwd, principalId: request.principalId, input: "Delegate local work" },
				);
				// The service Start goes through the same native admission the Engine transport performs.
				const started = await admitStart(serviceRuntime, parentExecution, parentRequest);
				expect(
					await serviceRuntime.store.waitAttemptResult(
						started.agentInstanceId,
						started.commandId,
						started.attemptId,
						AbortSignal.timeout(15_000),
					),
				).toMatchObject({ state: "completed", payload: { assistantFinal: "Parent received local child result" } });
				expect(hosted.requests).toBeGreaterThan(0);
				expect(calls).toBe(2);
				expect(hosted.calls).not.toContain("grimoire_agent_engine_child_launch");
				const projectionDeadline = Date.now() + 15_000;
				while (
					![...hosted.projected.values()].some(
						agent =>
							(agent.requested_execution as Record<string, unknown>).parent_attempt_id === serviceAttempt &&
							agent.status === "completed",
					)
				) {
					if (Date.now() > projectionDeadline)
						throw new Error("Local child lifecycle was not projected after reconnect");
					await Bun.sleep(50);
				}
				expect(calls).toBe(2);
			} finally {
				stop.resolve();
				await service;
				create.mockRestore();
				hosted.server.stop(true);
				runtime = undefined;
			}
		} finally {
			await runtime?.dispose();
			readBinding.mockRestore();
			auth.close();
		}
	},
	45_000,
);
