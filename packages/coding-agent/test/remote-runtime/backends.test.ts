import { describe, expect, it, vi } from "bun:test";
import { IrcBus, type PeerTransportDelivery } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type RemoteRegistryBackend } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	SocketPeerTransportBackend,
	SocketRemoteRegistryBackend,
	SocketStructuredSubagentBackend,
} from "@oh-my-pi/pi-coding-agent/remote-runtime/backends";
import type { RemoteRuntimeClient } from "@oh-my-pi/pi-coding-agent/remote-runtime/client";
import {
	parseRemoteRuntimeConfig,
	REMOTE_RUNTIME_PROTOCOL_VERSION,
} from "@oh-my-pi/pi-coding-agent/remote-runtime/config";
import type { StructuredSubagentBackendContext } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";

function config(executionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV") {
	return parseRemoteRuntimeConfig({
		version: REMOTE_RUNTIME_PROTOCOL_VERSION,
		socketPath: "/var/run/omp-runtime.sock",
		controllerId: "controller-a",
		executionId,
		rootExecutionId: executionId,
		parentExecutionId: null,
		assignmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		depth: 0,
		revision: "a".repeat(40),
		grantId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
		policyDigest: `sha256:${"b".repeat(64)}`,
		budgetRef: "budget:root-1",
		schemaRef: "schema:root-1",
		requestTimeoutMs: 1_000,
	});
}

function context(
	registry: AgentRegistry,
	index = 0,
	maxRuntimeMs = 5_000,
	schema: unknown = {},
	effort?: "lo" | "med" | "hi",
): StructuredSubagentBackendContext {
	return {
		request: {
			session: {
				cwd: "/Users/private/workspace",
				agentRegistry: registry,
			} as never,
			invocationKind: "task",
			assignment: "Review the logical source reference.",
			context: "bounded context",
			identity: { id: "RemoteChild", label: "remote child" },
			index,
			parentToolCallId: "tool-call-1",
			maxRuntimeMs,
			effort,
		},
		policy: {
			agent: { name: "reviewer", source: "bundled" },
			modelOverride: "slow",
			modelRole: "slow",
			planMode: false,
			schema: { schema, source: "caller", mode: "strict", outputSchemaOverridesAgent: true },
			isIsolated: false,
			mergeMode: "patch",
			applyChanges: false,
			enableLsp: false,
			enableIrc: true,
		} as never,
		outputSchema: { source: "caller", mode: "strict", schema, outputSchemaOverridesAgent: true },
	};
}

function response(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		execution: {
			result: {
				index: 0,
				id: "RemoteChild",
				agent: "reviewer",
				agentSource: "bundled",
				task: "Review the logical source reference.",
				assignment: "Review the logical source reference.",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 1,
				requests: 1,
			},
			mergeSummary: "",
			changesApplied: null,
			temporaryArtifacts: false,
		},
		registration: {
			id: "RemoteChild",
			displayName: "remote child",
			kind: "sub",
			parentId: "Main",
			status: "idle",
			identity: {
				controllerId: "controller-a",
				executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
				generation: 1,
			},
			createdAt: 1,
			lastActivity: 2,
		},
		...extra,
	};
}

function runningRegistration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const registration = response().registration as Record<string, unknown>;
	return { ...registration, status: "running", ...overrides };
}

function requireObservationStream(value: unknown): string {
	if (!value || typeof value !== "object" || !("observationStream" in value)) {
		throw new Error("missing observation stream");
	}
	const stream = value.observationStream;
	if (typeof stream !== "string") throw new Error("malformed observation stream");
	return stream;
}

describe("remote runtime structured backend", () => {
	it("publishes a running child, sends logical launch data only, and commits the terminal registration", async () => {
		const registry = new AgentRegistry();
		let payload: unknown;
		let observation: ((envelope: { stream: string; observation: unknown }) => void) | undefined;
		let sawRunning = false;
		const request = vi.fn(async (_operation: string, candidate: unknown) => {
			payload = candidate;
			const stream = requireObservationStream(candidate);
			observation?.({ stream, observation: { type: "registry.register", registration: runningRegistration() } });
			sawRunning = registry.get("RemoteChild")?.status === "running";
			return response();
		});
		const client = {
			request,
			onObservation: (_stream: string, listener: typeof observation) => {
				observation = listener;
				return () => {
					observation = undefined;
				};
			},
		} as unknown as RemoteRuntimeClient;
		const backend = new SocketStructuredSubagentBackend(client, config());
		const launch = context(registry);

		const settled = await backend.run(launch);
		expect(sawRunning).toBe(true);
		expect(registry.get("RemoteChild")?.status).toBe("running");
		backend.accept(launch);

		expect(request).toHaveBeenCalledWith(
			"subagent.run",
			expect.objectContaining({
				observationStream: expect.stringMatching(/^subagent\./),
				planMode: false,
				restrictToolNames: false,
				enableMCP: true,
			}),
			{
				signal: undefined,
				idempotencyKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV:tool-call-1:0",
				timeoutMs: 35_000,
			},
		);
		const encoded = JSON.stringify(payload);
		expect(encoded).toContain('"reference":"schema:root-1"');
		expect(encoded).toContain('"schema":{}');
		expect(encoded).not.toContain("/Users/private/workspace");
		expect(encoded).not.toContain("socketPath");
		expect(encoded).not.toContain("grantId");
		expect(settled.artifactsDir).toBe("");
		expect(registry.get("RemoteChild")).toMatchObject({
			locality: "remote",
			status: "idle",
			session: null,
			sessionFile: null,
		});
	});

	it("scopes deterministic idempotency to the execution and forwards each invocation schema and effort", async () => {
		const timeouts: Array<number | null | undefined> = [];
		const keys: Array<string | undefined> = [];
		const payloads: unknown[] = [];
		const client = {
			onObservation: () => () => {},
			request: async (
				_operation: string,
				payload: unknown,
				options: { idempotencyKey?: string; timeoutMs?: number | null },
			) => {
				payloads.push(payload);
				keys.push(options.idempotencyKey);
				timeouts.push(options.timeoutMs);
				return response();
			},
		} as unknown as RemoteRuntimeClient;
		const firstExecution = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		const secondExecution = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
		const firstBackend = new SocketStructuredSubagentBackend(client, config(firstExecution));
		const secondBackend = new SocketStructuredSubagentBackend(client, config(secondExecution));
		const firstSchema = { type: "object", required: ["first"] };
		const secondSchema = { type: "object", required: ["second"] };
		const first = context(new AgentRegistry(), 0, 5_000, firstSchema, "lo");
		const second = context(new AgentRegistry(), 0, 0, secondSchema, "hi");

		await firstBackend.run(first);
		await secondBackend.run(second);
		firstBackend.discard(first);
		secondBackend.discard(second);

		expect(keys).toEqual([`${firstExecution}:tool-call-1:0`, `${secondExecution}:tool-call-1:0`]);
		expect(timeouts).toEqual([35_000, null]);
		expect(payloads).toEqual([
			expect.objectContaining({
				effort: "lo",
				outputSchema: {
					schema: firstSchema,
					outputSchemaOverridesAgent: true,
					source: "caller",
					mode: "strict",
					reference: "schema:root-1",
				},
			}),
			expect.objectContaining({
				effort: "hi",
				outputSchema: {
					schema: secondSchema,
					outputSchemaOverridesAgent: true,
					source: "caller",
					mode: "strict",
					reference: "schema:root-1",
				},
			}),
		]);
	});

	it("preserves explicit null and absent effective schema bodies", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const client = {
			onObservation: () => () => {},
			request: async (_operation: string, payload: Record<string, unknown>) => {
				payloads.push(payload);
				return response();
			},
		} as unknown as RemoteRuntimeClient;
		const backend = new SocketStructuredSubagentBackend(client, config());
		const explicitNull = context(new AgentRegistry(), 0, 5_000, null);
		const absentBase = context(new AgentRegistry());
		const absent = {
			...absentBase,
			policy: {
				...absentBase.policy,
				schema: { schema: undefined, source: "none", mode: "permissive", outputSchemaOverridesAgent: false },
			},
			outputSchema: {
				schema: undefined,
				source: "none",
				mode: "permissive",
				outputSchemaOverridesAgent: false,
			},
		} satisfies StructuredSubagentBackendContext;

		await backend.run(explicitNull);
		await backend.run(absent);
		backend.discard(explicitNull);
		backend.discard(absent);
		expect(payloads[0]?.outputSchema).toEqual({
			schema: null,
			outputSchemaOverridesAgent: true,
			source: "caller",
			mode: "strict",
			reference: "schema:root-1",
		});
		expect(payloads[1]?.outputSchema).toEqual({
			outputSchemaOverridesAgent: false,
			source: "none",
			mode: "permissive",
			reference: "schema:root-1",
		});
	});

	it("validates and forwards admitted child result metadata", async () => {
		const remoteResponse = response();
		const execution = remoteResponse.execution as Record<string, unknown>;
		const childResult = execution.result as Record<string, unknown>;
		const usage = {
			input: 10,
			output: 4,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 19,
			contextTokens: 17,
			orchestration: { input: 1, cacheRead: 2, output: 3 },
			premiumRequests: 1,
			reasoningTokens: 2,
			cttl: { ephemeral5m: 1, ephemeral1h: 1 },
			server: { webSearch: 1, webFetch: 2 },
			cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
		};
		const extractedToolData = { task: [{ id: "Nested", state: "completed" }] };
		Object.assign(childResult, {
			description: "remote child",
			lastIntent: "Return the verdict",
			contextTokens: 17,
			contextWindow: 200_000,
			modelOverride: ["slow", "fast"],
			modelRole: "slow",
			resolvedModel: "anthropic/claude-sonnet-4-6:high",
			resolvedModelIsFallback: true,
			usage,
			extractedToolData,
			retryFailure: { attempt: 2, errorMessage: "rate limited" },
			outputMeta: { lineCount: 1, charCount: 4 },
		});
		const client = {
			onObservation: () => () => {},
			request: async () => remoteResponse,
		} as unknown as RemoteRuntimeClient;
		const launch = context(new AgentRegistry());
		const backend = new SocketStructuredSubagentBackend(client, config());

		const settled = await backend.run(launch);
		backend.discard(launch);

		expect(settled.result).toMatchObject({
			description: "remote child",
			lastIntent: "Return the verdict",
			contextTokens: 17,
			contextWindow: 200_000,
			modelOverride: ["slow", "fast"],
			modelRole: "slow",
			resolvedModel: "anthropic/claude-sonnet-4-6:high",
			resolvedModelIsFallback: true,
			usage,
			extractedToolData,
			retryFailure: { attempt: 2, errorMessage: "rate limited" },
			outputMeta: { lineCount: 1, charCount: 4 },
		});
	});

	it("rejects malformed admitted child result metadata instead of dropping it", async () => {
		const malformedMetadata = [
			{
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					credential: "must-not-be-admitted",
				},
			},
			{ extractedToolData: { task: { state: "completed" } } },
			{ resolvedModel: 42 },
		];
		for (const metadata of malformedMetadata) {
			const remoteResponse = response();
			const execution = remoteResponse.execution as Record<string, unknown>;
			Object.assign(execution.result as Record<string, unknown>, metadata);
			const client = {
				onObservation: () => () => {},
				request: async () => remoteResponse,
			} as unknown as RemoteRuntimeClient;
			const backend = new SocketStructuredSubagentBackend(client, config());

			await expect(backend.run(context(new AgentRegistry()))).rejects.toMatchObject({
				code: "MALFORMED_RESULT",
			});
		}
	});

	it("keeps an in-flight child visible, messageable, and controller-cancellable", async () => {
		const identity = {
			controllerId: "controller-a",
			executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
			generation: 1,
		};
		const cancel = vi.fn(async () => ({ identity, value: "cancelled" as const }));
		const authority: RemoteRegistryBackend = {
			status: async () => ({ identity, value: "running" }),
			progress: async () => ({ identity, value: { sequence: 1 } }),
			cancel,
			result: async () => ({ identity, value: { outcome: "cancelled" } }),
		};
		const registry = new AgentRegistry({ remoteBackend: authority });
		registry.register({ id: "Main", displayName: "main", kind: "main", session: {} as never });
		const observed = Promise.withResolvers<void>();
		const terminal = Promise.withResolvers<Record<string, unknown>>();
		let observation: ((envelope: { stream: string; observation: unknown }) => void) | undefined;
		const client = {
			onObservation: (_stream: string, listener: typeof observation) => {
				observation = listener;
				return () => {
					observation = undefined;
				};
			},
			request: async (_operation: string, candidate: unknown) => {
				observation?.({
					stream: requireObservationStream(candidate),
					observation: { type: "registry.register", registration: runningRegistration() },
				});
				observed.resolve();
				return terminal.promise;
			},
		} as unknown as RemoteRuntimeClient;
		const backend = new SocketStructuredSubagentBackend(client, config(), authority);
		const launch = context(registry);
		const execution = backend.run(launch);
		await observed.promise;

		expect(registry.list().map(ref => ref.id)).toContain("RemoteChild");
		const deliver = vi.fn(async delivery => ({ ...delivery, outcome: "accepted" as const }));
		const bus = new IrcBus(registry, new AgentLifecycleManager(registry), {
			deliver,
			cancel: async () => {},
		});
		await expect(bus.send({ from: "Main", to: "RemoteChild", body: "status?" })).resolves.toMatchObject({
			outcome: "remote",
		});
		expect(deliver).toHaveBeenCalledTimes(1);
		await registry.cancelRemote("RemoteChild");
		expect(cancel).toHaveBeenCalledTimes(1);

		terminal.resolve(
			response({
				registration: { ...runningRegistration(), status: "aborted" },
			}),
		);
		await execution;
		backend.accept(launch);
		expect(registry.get("RemoteChild")?.status).toBe("aborted");
	});

	it("rejects unknown nested result fields and rolls back an observed running child", async () => {
		const registry = new AgentRegistry();
		let observation: ((envelope: { stream: string; observation: unknown }) => void) | undefined;
		const client = {
			onObservation: (_stream: string, listener: typeof observation) => {
				observation = listener;
				return () => {
					observation = undefined;
				};
			},
			request: async (_operation: string, candidate: unknown) => {
				observation?.({
					stream: requireObservationStream(candidate),
					observation: { type: "registry.register", registration: runningRegistration() },
				});
				return response({ controllerCredential: "must-not-be-admitted" });
			},
		} as unknown as RemoteRuntimeClient;
		const backend = new SocketStructuredSubagentBackend(client, config());

		await expect(backend.run(context(registry))).rejects.toMatchObject({ code: "MALFORMED_RESULT" });
		expect(registry.get("RemoteChild")).toBeUndefined();
	});

	it("requires the controller to publish a running registration before terminal acceptance", async () => {
		const registry = new AgentRegistry();
		const client = {
			onObservation: () => () => {},
			request: async () => response(),
		} as unknown as RemoteRuntimeClient;
		const backend = new SocketStructuredSubagentBackend(client, config());
		const launch = context(registry);
		await backend.run(launch);

		expect(() => backend.accept(launch)).toThrow("did not publish a running child registration");
		backend.discard(launch);
		expect(registry.get("RemoteChild")).toBeUndefined();
	});

	it("normalizes bounded display names and rejects roster-breaking child ids", async () => {
		const displayName = `${"x".repeat(180)}\nprivate`;
		const acceptedRegistry = new AgentRegistry();
		let acceptedObservation: ((envelope: { stream: string; observation: unknown }) => void) | undefined;
		const acceptedClient = {
			onObservation: (_stream: string, listener: typeof acceptedObservation) => {
				acceptedObservation = listener;
				return () => {
					acceptedObservation = undefined;
				};
			},
			request: async (_operation: string, candidate: unknown) => {
				acceptedObservation?.({
					stream: requireObservationStream(candidate),
					observation: {
						type: "registry.register",
						registration: runningRegistration({ displayName }),
					},
				});
				return response({
					registration: { ...runningRegistration({ displayName }), status: "idle" },
				});
			},
		} as unknown as RemoteRuntimeClient;
		const acceptedBackend = new SocketStructuredSubagentBackend(acceptedClient, config());
		const acceptedLaunch = context(acceptedRegistry);
		await acceptedBackend.run(acceptedLaunch);
		acceptedBackend.accept(acceptedLaunch);
		const storedName = acceptedRegistry.get("RemoteChild")?.displayName ?? "";
		expect(storedName).not.toContain("\n");
		expect([...storedName].length).toBeLessThanOrEqual(128);

		const rejectedRegistry = new AgentRegistry();
		let rejectedObservation: ((envelope: { stream: string; observation: unknown }) => void) | undefined;
		const rejectedClient = {
			onObservation: (_stream: string, listener: typeof rejectedObservation) => {
				rejectedObservation = listener;
				return () => {
					rejectedObservation = undefined;
				};
			},
			request: async (_operation: string, candidate: unknown) => {
				rejectedObservation?.({
					stream: requireObservationStream(candidate),
					observation: {
						type: "registry.register",
						registration: runningRegistration({ id: "Remote\nInjected" }),
					},
				});
				return response();
			},
		} as unknown as RemoteRuntimeClient;
		const rejectedBackend = new SocketStructuredSubagentBackend(rejectedClient, config());
		await expect(rejectedBackend.run(context(rejectedRegistry))).rejects.toMatchObject({
			code: "REGISTRATION_REJECTED",
		});
		expect(rejectedRegistry.get("RemoteChild")).toBeUndefined();
	});
	it("forwards the plan-mode authority restriction instead of requesting an unrestricted child", async () => {
		let payload: Record<string, unknown> | undefined;
		const client = {
			onObservation: () => () => {},
			request: async (_operation: string, candidate: Record<string, unknown>) => {
				payload = candidate;
				return response();
			},
		} as unknown as RemoteRuntimeClient;
		const backend = new SocketStructuredSubagentBackend(client, config());
		const launch = context(new AgentRegistry());
		(launch.policy as { planMode: boolean }).planMode = true;

		await backend.run(launch);
		backend.discard(launch);

		expect(payload).toMatchObject({
			planMode: true,
			restrictToolNames: true,
			enableMCP: false,
		});
	});

	it("strictly parses registry terminal results and redacts controller failure text", async () => {
		const identity = {
			controllerId: "controller-a",
			executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
			generation: 1,
		};
		const client = {
			request: async () => ({
				identity,
				value: {
					outcome: "failed",
					error: "token secret failed at /Users/private/controller.sock",
				},
			}),
		} as unknown as RemoteRuntimeClient;
		const backend = new SocketRemoteRegistryBackend(client);

		const terminal = await backend.result(identity);

		expect(terminal.value).toEqual({ outcome: "failed", error: "Remote execution failed." });
		expect(JSON.stringify(terminal)).not.toContain("secret");
		expect(JSON.stringify(terminal)).not.toContain("/Users/private");
	});
});

describe("remote runtime peer backend", () => {
	it("scopes delivery and cancellation idempotency to the sealed execution", async () => {
		const keys: string[] = [];
		const client = {
			request: async (
				operation: string,
				payload: { delivery?: PeerTransportDelivery },
				options: { idempotencyKey: string },
			) => {
				keys.push(options.idempotencyKey);
				if (operation === "peer.cancel") return { cancelled: true };
				if (!payload.delivery) throw new Error("missing delivery");
				return {
					deliveryId: payload.delivery.deliveryId,
					sequence: payload.delivery.sequence,
					sender: payload.delivery.sender,
					recipient: payload.delivery.recipient,
					outcome: "accepted",
				};
			},
		} as unknown as RemoteRuntimeClient;
		const executionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		const backend = new SocketPeerTransportBackend(client, config(executionId));
		const delivery: PeerTransportDelivery = {
			deliveryId: "shared-process-local-id",
			sequence: 1,
			kind: "message",
			sender: {
				locality: "remote",
				agentId: "RemoteChild",
				controllerId: "controller-a",
				executionId,
				generation: 1,
			},
			recipient: { locality: "local", agentId: "Main", generation: 1 },
			payload: { body: "bounded message" },
		};

		await expect(backend.deliver(delivery)).resolves.toMatchObject({ outcome: "accepted" });
		await backend.cancel(delivery);

		expect(keys).toEqual([
			`${executionId}:peer:${delivery.deliveryId}`,
			`${executionId}:peer:${delivery.deliveryId}:cancel`,
		]);
	});
});
