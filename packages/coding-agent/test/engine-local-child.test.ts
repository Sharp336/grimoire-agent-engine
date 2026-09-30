import { expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { isRecord } from "@oh-my-pi/pi-utils";
import { EngineTargetError, type EngineSemanticBindingSnapshot, validateSemanticBinding } from "../src/engine/contracts";
import { type EngineCommandEnvelope, engineCommandIdentity } from "../src/engine/nats-adapter";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { engineAgentInstanceId } from "../src/engine/route";
import { EngineRuntime, type EngineRuntimeOptions } from "../src/engine/runtime";
import { launchLocalEngineChild, runEngineService } from "../src/engine/service";
import { validateRuntimeValue } from "../src/engine/runtime-protocol";
import { HostedGrimoireRpc } from "../src/engine/hosted-bridge";
import * as storage from "../src/session/storage-client";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { admittedExecution, admitStart, startEnvelope, startRequest, type AdmittedExecutionFixture } from "./helpers/engine-runtime-admitted-fixture";
import { semanticBinding } from "./helpers/runtime-v1-rocks-fixture";

const natsServer =
	process.env.GRIMOIRE_NATS_SERVER ?? path.join(process.env.LOCALAPPDATA ?? "", "Grimoire", "bin", "nats-server.exe");

/**
 * Fake only the hosted RPC boundary. A prepared child is an immutable admitted command,
 * keyed to the parent's Attempt and tool call; duplicate RPCs return the same receipt.
 */
function localChildPrepareServer(options: {
	childExecution: () => AdmittedExecutionFixture;
	runtime: () => EngineRuntime | undefined;
	deviceId: string;
	engineId: string;
}) {
	const prepared = new Map<string, { input: string; command: EngineCommandEnvelope }>();
	const calls: string[] = [];
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests++;
			const body: unknown = await request.json();
			if (!isRecord(body)) return Response.json({ error: "Invalid RPC envelope" }, { status: 400 });
			const internal = body.schema === "grimoire.client_internal_request.v1";
			const params = internal ? body.arguments : body.params;
			if (!isRecord(params) || typeof params.name !== "string" || !isRecord(params.arguments))
				return Response.json({ error: "Invalid RPC tool call" }, { status: 400 });
			const name = params.name;
			const args = params.arguments;
			calls.push(name);
			let result: Record<string, unknown> = { status: "no_job", generation: 1, changed: false };
			if (name === "prepare_child_start") {
				const runtime = options.runtime();
				if (!runtime) throw new Error("Prepare arrived before the runtime was created");
				if (typeof args.parentAgentInstanceRef !== "string" || typeof args.parentAttemptId !== "string" ||
					!isRecord(args.parentBindingSnapshot) || typeof args.principalId !== "string" ||
					(typeof args.authorityGeneration !== "number" || !Number.isSafeInteger(args.authorityGeneration)) ||
					!isRecord(args.target) ||
					typeof args.target.task_ref !== "string" ||
					(args.target.work_step_id !== null && typeof args.target.work_step_id !== "string") ||
					typeof args.assignment !== "string" || typeof args.toolCallId !== "string" ||
					typeof args.cwd !== "string")
					throw new EngineTargetError("invalid_request", "Prepare needs exact parent and child target");
				validateRuntimeValue("bindingSnapshot", args.parentBindingSnapshot);
				const parentBindingSnapshot = args.parentBindingSnapshot as unknown as EngineSemanticBindingSnapshot;
				validateSemanticBinding(parentBindingSnapshot, args.parentAgentInstanceRef);
				const childExecution = options.childExecution();
				const target = { task_ref: args.target.task_ref, work_step_id: args.target.work_step_id };
				if (storage.storageCanonicalJson(childExecution.config.dispatch.target) !== storage.storageCanonicalJson(target))
					throw new EngineTargetError("stale_target", "Child execution differs from its requested target");
				const key = storage.storageCanonicalJson([
					args.parentAgentInstanceRef, args.parentAttemptId, args.toolCallId,
				]);
				const input = storage.storageCanonicalJson({
					parentBindingSnapshot, principalId: args.principalId,
					authorityGeneration: args.authorityGeneration, target,
					assignment: args.assignment, cwd: args.cwd,
				});
				if (args.reserve === true)
					return Response.json({ error: "Child reservation is outside this fixture" }, { status: 400 });
				const prior = prepared.get(key);
				if (prior && prior.input !== input)
					return Response.json({ error: "Prepared child request changed on replay" }, { status: 409 });
				let command = prior?.command;
				if (!command) {
					const agentInstanceRef = `${target.task_ref}/agents/agent-${crypto.randomUUID()}`;
					const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
					const bindingSnapshot: EngineSemanticBindingSnapshot = {
						...semanticBinding(agentInstanceRef, target.task_ref, target.work_step_id),
						parentAgentInstanceRef: args.parentAgentInstanceRef,
						parentAttemptId: args.parentAttemptId,
						parentBindingRevision: parentBindingSnapshot.bindingRevision,
					};
					const id = crypto.randomUUID();
					const typed = startRequest(childExecution, {
						commandId: `child-command-${id}`, agentInstanceId, agentInstanceRef,
						executionId: `child-execution-${id}`, attemptId: `child-attempt-${id}`,
					}, {
						cwd: args.cwd, principalId: args.principalId, input: args.assignment,
						parentAgentInstanceId: engineAgentInstanceId(args.parentAgentInstanceRef),
						parentAgentInstanceRef: args.parentAgentInstanceRef, bindingSnapshot,
					});
					command = startEnvelope(runtime, childExecution, typed, {
						deviceId: options.deviceId, engineId: options.engineId,
					});
					prepared.set(key, { input, command });
				}
				result = {
					status: "prepared", command,
					agentInstanceRef: command.agentInstanceRef,
					agentInstanceId: command.agentInstanceId,
					bindingSnapshot: command.bindingSnapshot,
				};
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: result } });
		},
	});
	return {
		server,
		rpc: new HostedGrimoireRpc({ serverUrl: server.url.toString(), token: "test-token", clientId: "fixture" }),
		url: server.url,
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
		const directParentEntered = Promise.withResolvers<void>();
		const directParentRelease = Promise.withResolvers<void>();
		const directParentModel = createMockModel({
			handler: async () => {
				directParentEntered.resolve();
				await directParentRelease.promise;
				return { content: ["Parent admitted child delegation"] };
			},
		});
		const directParentExecution = admittedExecution(directParentModel.model, modelRegistry, {
			taskRef: parentTaskRef,
			spawn: { allowed: "yes", max_depth: 1, max_children: 1, on_exceed: "deny" },
			continuation: { systemPrompt: "Direct parent admission" },
		});
		const executions = [execution, directParentExecution];
		const fixtureOptionsFor = (deviceId: string): Pick<
			EngineRuntimeOptions,
			"deviceId" | "resolveExecution" | "verifyOriginReceipt" | "verifyApprovalReceipt"
		> => ({
			deviceId,
			resolveExecution: async (config, frozen, attempt, resolvedCwd, signal) => {
				const candidate = executions.find(entry =>
					storage.storageCanonicalJson(entry.config) === storage.storageCanonicalJson(config));
				if (!candidate) throw new EngineTargetError("stale_target", "Unregistered fixture execution");
				return candidate.optionsFor({ deviceId }).resolveExecution!(config, frozen, attempt, resolvedCwd, signal);
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
		const hosted = localChildPrepareServer({
			runtime: () => runtime,
			childExecution: () => structuredExecution ?? execution,
			deviceId: "fixture-device",
			engineId: "fixture-engine",
		});
		const parentAgentInstanceRef = `grimoire://tasks/grimoire/child-test/agents/parent-${crypto.randomUUID()}`;
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
				...fixtureOptionsFor("fixture-device"),
			});
			const parentAgentInstanceId = engineAgentInstanceId(parentAgentInstanceRef);
			const parentAttemptId = `direct-parent-attempt-${crypto.randomUUID()}`;
			const parentStarted = await admitStart(runtime, directParentExecution,
				startRequest(directParentExecution, {
					commandId: `direct-parent-start-${crypto.randomUUID()}`,
					agentInstanceId: parentAgentInstanceId, agentInstanceRef: parentAgentInstanceRef,
					executionId: `direct-parent-execution-${crypto.randomUUID()}`, attemptId: parentAttemptId,
				}, { cwd, principalId: "test-owner", input: "Authorize local child work" }),
				{ deviceId: "fixture-device", engineId: "fixture-engine" });
			await directParentEntered.promise;
			expect((await runtime.store.getAttempt(parentAttemptId))?.state).toBe("running");
			const parentBindingSnapshot = (await runtime.store.getBinding(parentAgentInstanceId))?.bindingSnapshot;
			if (!parentBindingSnapshot) throw new Error("Admitted parent lost its semantic binding");
			expect(parentStarted.attemptId).toBe(parentAttemptId);
			const enrolled = new Set<string>();
			const request = {
				parentAgentInstanceId, parentAgentInstanceRef,
				parentAttemptId: parentStarted.attemptId, parentBindingSnapshot,
				principalId: "test-owner", authorityGeneration: parentStarted.authorityGeneration,
				target: { task_ref: parentTaskRef, work_step_id: null },
				assignment: "Inspect local evidence 42", toolCallId: "call-1", cwd,
				deviceId: "fixture-device", engineId: "fixture-engine",
				enrollChild: async (ref: string, attemptId?: string) => {
					if (!attemptId) throw new Error("Child enrollment lost its Attempt");
					enrolled.add(`${ref}:${attemptId}`);
				},
			};
			const [first, duplicate] = await Promise.all([
				launchLocalEngineChild(runtime, hosted.rpc, request),
				launchLocalEngineChild(runtime, hosted.rpc, request),
			]);
			expect(first).toMatchObject({ status: "completed", assistantFinal: "Verified local evidence 42" });
			expect(duplicate).toEqual(first);
			expect(first.agentInstanceRef?.startsWith(`${parentTaskRef}/agents/`)).toBe(true);
			expect(first.agentInstanceId).toBe(engineAgentInstanceId(first.agentInstanceRef!));
			expect(calls).toBe(1);
			const childBinding = (await runtime.store.getBinding(first.agentInstanceId))!;
			expect(enrolled.has(`${first.agentInstanceRef}:${childBinding.attemptId}`)).toBe(true);
			const command = (await runtime.store.getStartConversationIdentity(childBinding.commandId))!;
			expect(JSON.parse(command.serializedCommand!)).toMatchObject({
				deviceId: request.deviceId, engineId: request.engineId,
				parentAgentInstanceId: request.parentAgentInstanceId,
				parentAgentInstanceRef: request.parentAgentInstanceRef,
				bindingSnapshot: {
					parentAttemptId: request.parentAttemptId,
					parentBindingRevision: request.parentBindingSnapshot.bindingRevision,
				},
				payload: { input: request.assignment },
			});
			expect(childBinding.bindingSnapshot).toEqual({
				...semanticBinding(first.agentInstanceRef!, parentTaskRef),
				parentAgentInstanceRef: request.parentAgentInstanceRef,
				parentAttemptId: request.parentAttemptId,
				parentBindingRevision: request.parentBindingSnapshot.bindingRevision,
			});
			await expect(
				launchLocalEngineChild(runtime, hosted.rpc, { ...request, assignment: "changed" }),
			).rejects.toMatchObject({ code: "stale_target" });
			const committedHash = command.canonicalHash;
			expect(engineCommandIdentity(JSON.parse(command.serializedCommand!)).canonicalHash).toBe(committedHash);
			directParentRelease.resolve();
			await runtime.drain();
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
			// Replay uses the same immutable admitted Start and terminal result, without a fresh provider call.
			expect(await launchLocalEngineChild(runtime, hosted.rpc, request)).toEqual(first);
			expect(calls).toBe(1);
			expect((await runtime.store.getStartConversationIdentity(childBinding.commandId))?.serializedCommand)
				.toBe(command.serializedCommand);
			expect((await runtime.store.getBinding(first.agentInstanceId))?.sessionFile).toBe(childBinding.sessionFile);
			expect((await runtime.store.getStartConversationIdentity(childBinding.commandId))?.canonicalHash).toBe(
				committedHash,
			);
			expect(JSON.stringify(await runtime.store.nativeHistoryPage(first.agentInstanceId))).toContain(
				"Verified local evidence 42",
			);
			const beforeRefusals = hosted.requests;
			await expect(
				launchLocalEngineChild(runtime, hosted.rpc, {
					...request,
					toolCallId: "too-large",
					assignment: "я".repeat(16_385),
				}),
			).rejects.toMatchObject({ code: "invalid_request" });
			await expect(
				launchLocalEngineChild(runtime, hosted.rpc, {
					...request,
					toolCallId: "missing-target",
					target: { task_ref: "", work_step_id: null },
				}),
			).rejects.toMatchObject({ code: "invalid_request" });
			expect(hosted.requests).toBe(beforeRefusals);
			expect(calls).toBe(1);
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
				continuation: {
					toolNames: ["yield"], restrictToolNames: true, requireYieldTool: true,
					outputSchema: { type: "object", required: ["evidence", "verified"] },
				},
			});
			executions.push(structuredExecution);
			let serviceChildAgentInstanceRef: string | undefined;
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
					const details = result.details;
					if (!isRecord(details) || !Array.isArray(details.results) ||
						!isRecord(details.results[0]) || typeof details.results[0].agentInstanceRef !== "string")
						throw new Error("Child result lost its AgentInstance identity");
					serviceChildAgentInstanceRef = details.results[0].agentInstanceRef;
					return { content: ["Parent received local child result"] };
				},
			});
			const parentExecution = admittedExecution(parentModel.model, modelRegistry, {
				taskRef: parentTaskRef,
				// The service parent spawns one local child then reports its structured result.
				spawn: { allowed: "yes", max_depth: 1, max_children: 1, on_exceed: "deny" },
				continuation: { toolNames: ["task"], restrictToolNames: true },
			});
			executions.push(parentExecution);
			const originalCreate = EngineRuntime.create.bind(EngineRuntime);
			const serviceRuntimeReady = Promise.withResolvers<EngineRuntime>();
			const create = spyOn(EngineRuntime, "create").mockImplementation(async serviceOptions => {
				const created = await originalCreate({
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
				runtime = created;
				serviceRuntimeReady.resolve(created);
				return created;
			});
			const stop = Promise.withResolvers<void>();
			const serviceAttempt = `service-parent-${crypto.randomUUID()}`;
			const serviceParentAgentInstanceRef =
				`grimoire://tasks/grimoire/child-test/agents/service-parent-${crypto.randomUUID()}`;
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
				const serviceRuntime = await serviceRuntimeReady.promise;
				const parentRequest = startRequest(
					parentExecution,
					{
						commandId: serviceAttempt,
						agentInstanceId: engineAgentInstanceId(serviceParentAgentInstanceRef),
						agentInstanceRef: serviceParentAgentInstanceRef,
						executionId: serviceAttempt,
						attemptId: serviceAttempt,
					},
					{ cwd, principalId: request.principalId, input: "Delegate local work" },
				);
				// The service Start goes through the same native admission the Engine transport performs.
				const started = await admitStart(serviceRuntime, parentExecution, parentRequest, {
					deviceId: request.deviceId, engineId: request.engineId,
				});
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
				if (!serviceChildAgentInstanceRef) throw new Error("Completed child lost its result identity");
				const child = await serviceRuntime.store.getBinding(engineAgentInstanceId(serviceChildAgentInstanceRef));
				if (!child) throw new Error("Completed child lost its durable binding");
				expect(child.bindingSnapshot).toMatchObject({
					agentInstanceRef: serviceChildAgentInstanceRef,
					parentAgentInstanceRef: serviceParentAgentInstanceRef,
					parentAttemptId: serviceAttempt,
					parentBindingRevision: started.bindingSnapshot?.bindingRevision,
				});
				expect((await serviceRuntime.store.getAttempt(child.attemptId))?.state).toBe("completed");
			} finally {
				stop.resolve();
				await service;
				create.mockRestore();
				hosted.server.stop(true);
				runtime = undefined;
			}
		} finally {
			directParentRelease.resolve();
			await runtime?.dispose();
			readBinding.mockRestore();
			auth.close();
		}
	},
	45_000,
);
