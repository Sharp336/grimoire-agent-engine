import { describe, expect, it } from "bun:test";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	createOmpExtensionCapabilities,
	createOmpExtensionEnvelope,
	createOmpExtensionSequenceState,
	OMP_EXTENSION_METHODS,
	parseOmpExtensionRequest,
} from "@oh-my-pi/pi-coding-agent/modes/acp/omp-extension-protocol";
import { OmpAcpExtensionRuntime } from "@oh-my-pi/pi-coding-agent/modes/acp/omp-extension-runtime";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonSnapshot } from "@oh-my-pi/pi-coding-agent/launch/protocol";

describe("OMP ACP extension protocol", () => {
	it("bounds requests and emits monotonic versioned envelopes", () => {
		const request = parseOmpExtensionRequest({ sessionId: "session-1", correlationId: "turn-7", timeoutMs: 99_000 });
		expect(request.timeoutMs).toBe(15_000);
		const state = createOmpExtensionSequenceState();
		const first = createOmpExtensionEnvelope(state, request, { state: "running" });
		const second = createOmpExtensionEnvelope(state, request, { state: "idle" });
		expect(first.schemaVersion).toBe(1);
		expect(first.generation).toBe(second.generation);
		expect(second.sequence).toBe(first.sequence + 1);
		expect(second.correlationId).toBe("turn-7");
	});

	it("advertises only implemented methods and marks managed skills unavailable", () => {
		const capabilities = createOmpExtensionCapabilities({
			advisor: true,
			autolearn: true,
			memory: true,
			launch: true,
		});
		const features = capabilities.features as Record<string, Record<string, unknown>>;
		expect(features.advisor.methods).toContain(OMP_EXTENSION_METHODS.advisorDrain);
		expect(features.launch.observable).toBe(true);
		expect(features.managedSkills.available).toBe(false);
	});

	it("rejects malformed session identity instead of guessing a target", () => {
		expect(() => parseOmpExtensionRequest({})).toThrow("sessionId");
		expect(() => parseOmpExtensionRequest({ sessionId: "" })).toThrow("sessionId");
	});
});

class FakeExtensionSession {
	sessionId = "session-1";
	readonly sessionManager = { getCwd: () => "C:/isolated/project" };
	readonly settings = {
		get: (key: string): unknown => {
			if (key === "advisor.enabled" || key === "autolearn.enabled" || key === "autolearn.autoContinue") return true;
			if (key === "memory.backend") return "off";
			return undefined;
		},
	};
	readonly obfuscator = undefined;
	readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
	readonly #sessionChangeListeners = new Set<() => void>();

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	registerSessionChangeCallback(listener: () => void): () => void {
		this.#sessionChangeListeners.add(listener);
		return () => this.#sessionChangeListeners.delete(listener);
	}

	changeSession(sessionId: string): void {
		this.sessionId = sessionId;
		for (const listener of this.#sessionChangeListeners) listener();
	}

	getAdvisorStats(): Record<string, unknown> {
		return {
			configured: true,
			active: true,
			contextWindow: 10,
			contextTokens: 2,
			tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
			cost: 0,
			messages: { user: 1, assistant: 1, total: 2 },
				advisors: [
					{
						name: "reviewer",
						status: "running",
						contextWindow: 10,
						contextTokens: 2,
						tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
						cost: 0,
						messages: { user: 1, assistant: 1, total: 2 },
						backlog: 0,
						inFlight: false,
					},
				],
		};
	}

	getAdvisorAvailableToolNames(): string[] {
		return ["read", "bash"];
	}

	setAdvisorEnabled(enabled: boolean): boolean {
		return enabled;
	}

	waitForAdvisorCatchup(): Promise<boolean> {
		return Promise.resolve(true);
	}

	getAutolearnStatus(): Record<string, unknown> {
		return { enabled: true, autoContinue: true, state: "idle", captureGeneration: 0, pending: false };
	}

	drainAutolearnCaptureForAcp(): Promise<Record<string, unknown>> {
		return Promise.resolve({ settled: true, cancelled: false });
	}
}

describe("OMP ACP extension runtime", () => {
	it("fails closed when a client offers only an unknown breaking schema", async () => {
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection: { extNotification: async () => {} } as unknown as AgentSideConnection,
			getSession: () => session as unknown as AgentSession,
		});
		const response = await runtime.handleMethod(OMP_EXTENSION_METHODS.capabilities, {
			sessionId: session.sessionId,
			supportedSchemaVersions: [2],
		});
		expect(response.error).toMatchObject({ code: "UNSUPPORTED", recoverable: false });
	});

	it("negotiates effective capabilities and publishes correlated typed events", async () => {
		const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
		const connection = {
			extNotification: async (method: string, params: Record<string, unknown>) => {
				notifications.push({ method, params });
			},
		} as unknown as AgentSideConnection;
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection,
			getSession: sessionId => (sessionId === session.sessionId ? (session as unknown as AgentSession) : undefined),
		});
		runtime.attachSession(session as unknown as AgentSession);

		const negotiated = await runtime.handleMethod(OMP_EXTENSION_METHODS.capabilities, {
			sessionId: session.sessionId,
			correlationId: "start-1",
			supportedSchemaVersions: [1],
		});
		expect(negotiated.schemaVersion).toBe(1);
		expect((negotiated.data as Record<string, unknown>).protocol).toBe("omp-acp-extensions");

		session.emit({
			type: "omp_advisor_note",
			advisorId: "reviewer",
			severity: "concern",
			delivery: "steer",
			content: "typed note",
			turn: 4,
		} as AgentSessionEvent);
		await Promise.resolve();
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.method).toBe("_omp/advisor/note");
		const event = notifications[0]?.params;
		expect(event?.generation).toBe(negotiated.generation);
		expect(event?.sequence).toBe((negotiated.sequence as number) + 1);
		expect((event?.data as Record<string, unknown>).content).toBe("typed note");

		session.changeSession("session-2");
		session.emit({
			type: "omp_advisor_note",
			advisorId: "reviewer",
			severity: "nit",
			delivery: "aside",
			content: "must wait for renegotiation",
			turn: 5,
		} as AgentSessionEvent);
		await Promise.resolve();
		expect(notifications).toHaveLength(1);
		const resumed = await runtime.handleMethod(OMP_EXTENSION_METHODS.capabilities, {
			sessionId: session.sessionId,
		});
		expect(resumed.generation).not.toBe(negotiated.generation);
		expect(resumed.sequence).toBe(1);
	});

	it("reports advisor mutation risk from the real granted tool set", async () => {
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection: { extNotification: async () => {} } as unknown as AgentSideConnection,
			getSession: () => session as unknown as AgentSession,
		});
		runtime.attachSession(session as unknown as AgentSession);
		const response = await runtime.handleMethod(OMP_EXTENSION_METHODS.advisorStatus, {
			sessionId: session.sessionId,
		});
		const data = response.data as Record<string, unknown>;
		expect(data.toolRisk).toBe("write-or-exec");
		expect(data.grantedTools).toEqual(["read", "bash"]);
	});

	it("controls and drains Advisor and Auto-Learn from their real session owners", async () => {
		const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection: {
				extNotification: async (method: string, params: Record<string, unknown>) =>
					void notifications.push({ method, params }),
			} as unknown as AgentSideConnection,
			getSession: () => session as unknown as AgentSession,
		});
		runtime.attachSession(session as unknown as AgentSession);
		await runtime.handleMethod(OMP_EXTENSION_METHODS.capabilities, { sessionId: session.sessionId });

		const advisorSet = await runtime.handleMethod(OMP_EXTENSION_METHODS.advisorSet, {
			sessionId: session.sessionId,
			enabled: true,
		});
		const advisorDrain = await runtime.handleMethod(OMP_EXTENSION_METHODS.advisorDrain, {
			sessionId: session.sessionId,
			timeoutMs: 25,
		});
		const autolearnStatus = await runtime.handleMethod(OMP_EXTENSION_METHODS.autolearnStatus, {
			sessionId: session.sessionId,
		});
		const autolearnDrain = await runtime.handleMethod(OMP_EXTENSION_METHODS.autolearnDrain, {
			sessionId: session.sessionId,
			cancel: true,
		});
			expect((advisorSet.data as Record<string, unknown>).active).toBe(true);
			expect((advisorDrain.data as Record<string, unknown>).settled).toBe(true);
			expect(((advisorDrain.data as Record<string, unknown>).status as Record<string, unknown>).backlog).toBe(0);
			expect(((advisorDrain.data as Record<string, unknown>).status as Record<string, unknown>).inFlight).toBe(false);
		expect((autolearnStatus.data as Record<string, unknown>).state).toBe("idle");
		expect((autolearnDrain.data as Record<string, unknown>).settled).toBe(true);

		session.emit({
			type: "omp_autolearn_lifecycle",
			event: "completed",
			captureGeneration: 2,
			turn: 3,
		} as AgentSessionEvent);
		await Promise.resolve();
		expect(notifications.at(-1)?.method).toBe("_omp/autolearn/lifecycle");
		expect((notifications.at(-1)?.params.data as Record<string, unknown>).captureGeneration).toBe(2);
	});

	it("does not report Advisor drain settled before an accepted typed note reaches the ACP connection", async () => {
		const { promise: notificationGate, resolve: releaseNotification } = Promise.withResolvers<void>();
		const { promise: notificationStarted, resolve: markNotificationStarted } = Promise.withResolvers<void>();
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection: {
				extNotification: async () => {
					markNotificationStarted();
					await notificationGate;
				},
			} as unknown as AgentSideConnection,
			getSession: () => session as unknown as AgentSession,
		});
		runtime.attachSession(session as unknown as AgentSession);
		await runtime.handleMethod(OMP_EXTENSION_METHODS.capabilities, { sessionId: session.sessionId });

		session.emit({
			type: "omp_advisor_note",
			advisorId: "reviewer",
			severity: "concern",
			delivery: "steer",
			content: "must be delivered before drain settles",
			turn: 1,
		} as AgentSessionEvent);
		await notificationStarted;

		let drainResolved = false;
		const draining = runtime
			.handleMethod(OMP_EXTENSION_METHODS.advisorDrain, { sessionId: session.sessionId, timeoutMs: 1_000 })
			.then(response => {
				drainResolved = true;
				return response;
			});
		await Promise.resolve();
		expect(drainResolved).toBe(false);

		releaseNotification();
		const response = await draining;
		expect((response.data as Record<string, unknown>).settled).toBe(true);
		expect((response.data as Record<string, unknown>).notificationsSettled).toBe(true);
	});

	it("reports notification backpressure instead of settling after a typed event is dropped", async () => {
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection: { extNotification: async () => {} } as unknown as AgentSideConnection,
			getSession: () => session as unknown as AgentSession,
		});
		runtime.attachSession(session as unknown as AgentSession);
		await runtime.handleMethod(OMP_EXTENSION_METHODS.capabilities, { sessionId: session.sessionId });

		for (let index = 0; index < 257; index++) {
			session.emit({
				type: "omp_advisor_note",
				advisorId: "reviewer",
				severity: "concern",
				delivery: "steer",
				content: `typed note ${index}`,
				turn: index,
			} as AgentSessionEvent);
		}

		const response = await runtime.handleMethod(OMP_EXTENSION_METHODS.advisorDrain, {
			sessionId: session.sessionId,
			timeoutMs: 1_000,
		});
		const data = response.data as Record<string, unknown>;
		expect(data.notificationsSettled).toBe(true);
		expect(data.settled).toBe(false);
		expect(data.notificationBackpressure).toEqual({ dropped: 1, recoverable: false });
	});

	it("requires a typed confirmation challenge before clearing isolated memory", async () => {
		let enqueued = 0;
		let cleared = 0;
		const backend: MemoryBackend = {
			id: "local",
			start: () => {},
			buildDeveloperInstructions: async () => undefined,
			status: async () => ({
				backend: "local",
				active: true,
				writable: true,
				searchable: true,
				scope: "isolated",
				database: "C:/temp/omp-phase3/memory.sqlite",
				workingCount: 2,
			}),
			stats: async () => "two memories",
			diagnose: async () => "healthy",
			enqueue: async () => void (enqueued += 1),
			clear: async () => void (cleared += 1),
		};
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection: { extNotification: async () => {} } as unknown as AgentSideConnection,
			getSession: () => session as unknown as AgentSession,
			getAgentDir: () => "C:/temp/omp-phase3/agent",
			resolveMemoryBackend: async () => backend,
		});

		const status = await runtime.handleMethod(OMP_EXTENSION_METHODS.memoryStatus, { sessionId: session.sessionId });
		const stats = await runtime.handleMethod(OMP_EXTENSION_METHODS.memoryStats, { sessionId: session.sessionId });
		const diagnose = await runtime.handleMethod(OMP_EXTENSION_METHODS.memoryDiagnose, {
			sessionId: session.sessionId,
		});
		await runtime.handleMethod(OMP_EXTENSION_METHODS.memoryEnqueue, { sessionId: session.sessionId });
		const challenge = await runtime.handleMethod(OMP_EXTENSION_METHODS.memoryClear, { sessionId: session.sessionId });
		const challengeData = challenge.data as Record<string, unknown>;
		expect((status.data as Record<string, unknown>).storage).toEqual({ kind: "database", pathId: "memory.sqlite" });
		expect((stats.data as Record<string, unknown>).text).toBe("two memories");
		expect((diagnose.data as Record<string, unknown>).text).toBe("healthy");
		expect(challengeData.confirmationRequired).toBe(true);
		expect(challengeData.scope).toBe("project");
		expect(cleared).toBe(0);

		const confirmed = await runtime.handleMethod(OMP_EXTENSION_METHODS.memoryClear, {
			sessionId: session.sessionId,
			confirmationId: challengeData.confirmationId,
		});
		expect((confirmed.data as Record<string, unknown>).cleared).toBe(true);
		expect(enqueued).toBe(1);
		expect(cleared).toBe(1);
	});

	it("bounds Launch access to the session owner and exposes every typed control", async () => {
		const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
		const owned: DaemonSnapshot = {
			name: "fixture-service",
			id: "service-1",
			state: "ready",
			pid: 4242,
			createdAt: 1,
			startedAt: 2,
			restartCount: 0,
			outputBytes: 12,
			owner: "session-1",
			persist: false,
			detached: false,
		};
		const foreign = { ...owned, id: "service-2", name: "foreign", owner: "other-session" };
		const client = {
			request: async (operation: { op: string }) => {
				if (operation.op === "list") return { op: "list", daemons: [owned, foreign] };
				if (operation.op === "describe") {
					return {
						op: "describe",
						daemon: owned,
						spec: {
							application: "bun",
							args: ["server.ts"],
							env: {},
							cwd: "C:/temp/omp-phase3",
							pty: true,
							restart: "no",
							persist: false,
							detached: false,
						},
					};
				}
				if (operation.op === "logs")
					return {
						op: "logs",
						name: owned.name,
						text: "ready",
						terminalRows: ["ready"],
						cursor: 12,
						timedOut: false,
						state: "ready",
					};
				return { op: operation.op, daemon: owned };
			},
		} as unknown as DaemonBrokerClient;
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection: {
				extNotification: async (method: string, params: Record<string, unknown>) =>
					void notifications.push({ method, params }),
			} as unknown as AgentSideConnection,
			getSession: () => session as unknown as AgentSession,
			daemonClientForProject: async () => client,
		});
		await runtime.handleMethod(OMP_EXTENSION_METHODS.capabilities, { sessionId: session.sessionId });

		const list = await runtime.handleMethod(OMP_EXTENSION_METHODS.launchList, { sessionId: session.sessionId });
		expect((list.data as { services: unknown[] }).services).toHaveLength(1);
		for (const method of [
			OMP_EXTENSION_METHODS.launchDescribe,
			OMP_EXTENSION_METHODS.launchLogs,
			OMP_EXTENSION_METHODS.launchSend,
			OMP_EXTENSION_METHODS.launchStop,
			OMP_EXTENSION_METHODS.launchRestart,
		]) {
			const response = await runtime.handleMethod(method, {
				sessionId: session.sessionId,
				name: owned.name,
				...(method === OMP_EXTENSION_METHODS.launchSend ? { data: "status\n" } : {}),
			});
			expect(response.error).toBeUndefined();
		}
		expect(notifications.filter(item => item.method === "_omp/launch/lifecycle")).toHaveLength(3);

		const denied = await runtime.handleMethod(OMP_EXTENSION_METHODS.launchStop, {
			sessionId: session.sessionId,
			name: foreign.name,
		});
		expect((denied.error as Record<string, unknown>).code).toBe("PERMISSION_DENIED");
	});

	it("returns structured recoverable errors for bounded handler timeouts", async () => {
		const session = new FakeExtensionSession();
		const runtime = new OmpAcpExtensionRuntime({
			connection: { extNotification: async () => {} } as unknown as AgentSideConnection,
			getSession: () => session as unknown as AgentSession,
			resolveMemoryBackend: async () =>
				({
					id: "local",
					start: () => {},
					buildDeveloperInstructions: async () => undefined,
					enqueue: async () => await new Promise(() => {}),
					clear: async () => {},
				}) as MemoryBackend,
		});
		const response = await runtime.handleMethod(OMP_EXTENSION_METHODS.memoryEnqueue, {
			sessionId: session.sessionId,
			timeoutMs: 1,
		});
		expect(response.error).toMatchObject({ code: "TIMEOUT", recoverable: true });
		expect((response.error as Record<string, unknown>).detail).toEqual({
			method: OMP_EXTENSION_METHODS.memoryEnqueue,
		});
	});
});
