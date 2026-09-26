import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { EngineProfileResolver } from "../src/engine/profile-resolver";
import { engineAgentInstanceId } from "../src/engine/route";
import { EngineRuntime, type EngineRuntimeOptions } from "../src/engine/runtime";
import { launchLocalEngineChild, runEngineService } from "../src/engine/service";
import * as storage from "../src/session/storage-client";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// The caller supplies an isolated real Rust owner, never an existing user contour.
it.skipIf(!Bun.env.ARTEL_STORAGE_TEST_BINDING || !Bun.env.ARTEL_STORAGE_TEST_RUN_ROOT || !Bun.env.GRIMOIRE_NATS_SERVER)(
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
		const profileRef = "gctx:aaaaaaaaaaaaaaaa";
		const cache = path.join(root, "cache");
		const profileFile = path.join(cache, `${profileRef.slice(5)}.json`);
		await Bun.write(
			profileFile,
			JSON.stringify({
				schema: "grimoire.client_cached_artifact.v1",
				artifact_ref: profileRef,
				revision: 1,
				content_hash: `sha256:${"a".repeat(64)}`,
				kind: "grimoire.agent_profile.v1",
				binding: { principal_id: "test-owner" },
				artifact: { owner_principal_id: "test-owner", effective_access_role: "owner" },
				content: JSON.stringify({ schema: "grimoire.agent_profile.v1", models: ["gctx:bbbbbbbbbbbbbbbb"] }),
			}),
		);
		const resolver = new EngineProfileResolver(cache, path.join(root, "credentials"));
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		let resolving: (() => void) | undefined;
		const options: EngineRuntimeOptions = {
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
				modelRegistry: new ModelRegistry(auth),
			},
			resolveSessionContinuation: async profile => profile.profileDigest,
			resolveSessionProfile: async (_profile, _cwd, signal) => {
				if (resolving) {
					const ready = resolving;
					await new Promise<void>((_resolve, reject) => {
						signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
						ready();
					});
				}
				return {
					options: {
						model: model.model,
						toolNames: [],
						restrictToolNames: true,
						enableMCP: false,
						enableLsp: false,
					},
					dispose() {},
				};
			},
		};
		let runtime: EngineRuntime | undefined;
		try {
			runtime = await EngineRuntime.create(options);
			const parentAgentInstanceRef = `grimoire://tasks/grimoire/child-test/agents/parent-${crypto.randomUUID()}`;
			const parentAgentInstanceId = engineAgentInstanceId(parentAgentInstanceRef);
			await runtime.store.registerAgent({
				agentInstanceId: parentAgentInstanceId,
				agentInstanceRef: parentAgentInstanceRef,
				principalId: "test-owner",
				authorityGeneration: 1,
			});
			const request = {
				parentAgentInstanceId,
				parentAgentInstanceRef,
				parentAttemptId: "parent-attempt",
				principalId: "test-owner",
				authorityGeneration: 1,
				profileRef,
				assignment: "Inspect local evidence 42",
				toolCallId: "call-1",
				cwd,
				maxSpawnDepth: 0,
				deviceId: "fixture-device",
				engineId: "fixture-engine",
				enrollChild: async () => {},
			};
			const [first, duplicate] = await Promise.all([
				launchLocalEngineChild(runtime, resolver, request),
				launchLocalEngineChild(runtime, resolver, request),
			]);
			expect(first).toMatchObject({ status: "completed", assistantFinal: "Verified local evidence 42" });
			expect(duplicate).toEqual(first);
			expect(first.agentInstanceRef).toMatch(
				/^grimoire:\/\/tasks\/grimoire\/child-test\/agents\/agent_[a-f0-9]{32}$/,
			);
			expect(calls).toBe(1);
			const childBinding = (await runtime.store.getBinding(first.agentInstanceId))!;
			const command = (await runtime.store.getStartConversationIdentity(childBinding.commandId))!;
			expect(JSON.parse(command.serializedCommand!).payload).toMatchObject({ input: request.assignment });
			await expect(
				launchLocalEngineChild(runtime, resolver, { ...request, assignment: "changed" }),
			).rejects.toThrow();
			await runtime.dispose();
			runtime = await EngineRuntime.create(options);
			// Replay uses the admitted snapshot and terminal result, without a fresh cache or provider call.
			await fs.rename(profileFile, `${profileFile}.parked`);
			expect(await launchLocalEngineChild(runtime, resolver, request)).toEqual(first);
			expect(calls).toBe(1);
			expect(JSON.stringify(await runtime.store.nativeHistoryPage(first.agentInstanceId))).toContain(
				"Verified local evidence 42",
			);
			await fs.rename(`${profileFile}.parked`, profileFile);
			await expect(
				launchLocalEngineChild(runtime, resolver, {
					...request,
					toolCallId: "too-large",
					assignment: "я".repeat(16_385),
				}),
			).rejects.toThrow("exceeds");
			const started = Promise.withResolvers<void>();
			resolving = started.resolve;
			const abort = new AbortController();
			const pending = launchLocalEngineChild(runtime, resolver, {
				...request,
				toolCallId: "cancel",
				signal: abort.signal,
			});
			await started.promise;
			abort.abort();
			expect(await pending).toMatchObject({ status: "cancelled" });
			expect(calls).toBe(1);
			await runtime.dispose();
			runtime = undefined;
			resolving = undefined;
			// Exercise the actual service callback with hosted configured but returning 503.
			let hostedRequests = 0;
			let online = false;
			const projected = new Map<string, Record<string, unknown>>();
			const hostedCalls: string[] = [];
			const hosted = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch(request) {
					hostedRequests++;
					const body = (await request.json()) as {
						id: number;
						params?: { name?: string; arguments?: Record<string, unknown> };
					};
					const name = body.params?.name ?? "mcp-handshake";
					hostedCalls.push(name);
					if (!online) return new Response("offline", { status: 503 });
					const args = body.params?.arguments ?? {};
					let result: Record<string, unknown> = { status: "no_job", generation: 1, changed: false };
					if (name === "grimoire_agent_instance") {
						const ref =
							args.action === "create"
								? `grimoire://tasks/${args.project_id}/${args.task_id}/agents/${args.agent_instance_id}`
								: String(args.agent_instance_ref);
						if (args.action === "create" && !projected.has(ref))
							projected.set(ref, {
								...args,
								agent_instance_ref: ref,
								owner_principal_id: "test-owner",
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
										profileRef,
										assignment: request.assignment,
									},
								},
							],
						};
					expect(result.isError).not.toBeTrue();
					expect(JSON.stringify(result)).toContain("Verified local evidence 42");
					return { content: ["Parent received local child result"] };
				},
			});
			const originalCreate = EngineRuntime.create.bind(EngineRuntime);
			const create = spyOn(EngineRuntime, "create").mockImplementation(async serviceOptions => {
				runtime = await originalCreate({
					...serviceOptions,
					sessionDefaults: options.sessionDefaults,
					resolveSessionContinuation: options.resolveSessionContinuation,
					resolveSessionProfile: async profile => ({
						options: {
							model: profile.spawns === "*" ? parentModel.model : model.model,
							enableMCP: profile.spawns !== "*",
							enableLsp: false,
						},
						childProfiles: [{ profileRef, displayName: "Local worker" }],
						dispose() {},
					}),
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
					databasePath: options.databasePath,
					artifactCacheRoot: cache,
					natsServerPath: Bun.env.GRIMOIRE_NATS_SERVER!,
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
				const started = await serviceRuntime.start(
					{
						commandId: serviceAttempt,
						agentInstanceId: parentAgentInstanceId,
						agentInstanceRef: parentAgentInstanceRef,
						executionId: serviceAttempt,
						attemptId: serviceAttempt,
						principalId: request.principalId,
						authorityGeneration: 1,
						cwd,
						input: "Delegate local work",
					},
					{
						spawns: "*",
						profileDigest: "parent",
						maxSpawnDepth: 1,
						maxChildren: 1,
						childProfileRefs: [profileRef],
					},
				);
				expect(
					await serviceRuntime.store.waitAttemptResult(
						started.agentInstanceId,
						started.commandId,
						started.attemptId,
						AbortSignal.timeout(15_000),
					),
				).toMatchObject({ state: "completed", payload: { assistantFinal: "Parent received local child result" } });
				expect(hostedRequests).toBeGreaterThan(0);
				expect(calls).toBe(2);
				expect(hostedCalls).not.toContain("grimoire_agent_engine_child_launch");
				online = true;
				const projectionDeadline = Date.now() + 15_000;
				while (
					![...projected.values()].some(
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
				hosted.stop(true);
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
