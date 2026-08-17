import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER,
	type AuthGatewayAuthorizationRequest,
	type AuthGatewayObservation,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import {
	type AuthGatewayPolicySocketClient,
	createAuthGatewayPolicyReadinessProbe,
	createAuthGatewayPolicySocketClient,
	runAuthGatewayCommand,
	validateAuthGatewayPolicySocketPath,
} from "../../src/cli/auth-gateway-cli";

type PolicyRequestHandler = (request: unknown, raw: string, socket: net.Socket) => void;

async function createSocketDir(): Promise<string> {
	return await fs.mkdtemp(path.join("/tmp", "omp-gateway-policy-"));
}

async function listenPolicyServer(socketPath: string, handler: PolicyRequestHandler): Promise<net.Server> {
	await fs.rm(socketPath, { force: true });
	const server = net.createServer(socket => {
		let bytes = Buffer.alloc(0);
		socket.on("data", chunk => {
			bytes = Buffer.concat([bytes, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
			for (;;) {
				const newline = bytes.indexOf(0x0a);
				if (newline === -1) return;
				const raw = bytes.subarray(0, newline).toString("utf8");
				bytes = bytes.subarray(newline + 1);
				handler(JSON.parse(raw), raw, socket);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	await listening.promise;
	return server;
}

async function closePolicyServer(server: net.Server): Promise<void> {
	const closed = Promise.withResolvers<void>();
	server.close(error => {
		if (error) closed.reject(error);
		else closed.resolve();
	});
	await closed.promise;
}

function writeJson(socket: net.Socket, value: unknown): void {
	socket.write(`${JSON.stringify(value)}\n`);
}

function authorizationRequest(secret: string): AuthGatewayAuthorizationRequest {
	return {
		requestId: "request-1",
		format: "openai-chat",
		requestedModelId: "mock/requested",
		requestedSessionId: "caller-hint",
		method: "POST",
		path: "/v1/chat/completions",
		payloadByteLength: 321,
		payloadSha256: "a".repeat(64),
		authorization: secret,
		signal: new AbortController().signal,
	};
}

const OBSERVATION: AuthGatewayObservation = {
	type: "authorization",
	requestId: "request-1",
	format: "openai-chat",
	requestedModelId: "mock/requested",
	outcome: "authorized",
	authorizationId: "authorization-1",
	resolvedModelId: "mock/resolved",
	sessionId: "workspace:session",
};

const TERMINAL_OBSERVATION: AuthGatewayObservation = {
	type: "terminal",
	requestId: "request-1",
	format: "openai-chat",
	authorizationId: "authorization-1",
	requestedModelId: "mock/requested",
	resolvedModelId: "mock/resolved",
	sessionId: "workspace:session",
	outcome: "success",
};

describe("auth-gateway policy socket", () => {
	test("reuses one request-scoped connection for authorization and acknowledged secret-free observations", async () => {
		const dir = await createSocketDir();
		const socketPath = path.join(dir, "policy.sock");
		const rawFrames: string[] = [];
		const types: string[] = [];
		const connections = new Set<net.Socket>();
		const server = await listenPolicyServer(socketPath, (value, raw, socket) => {
			connections.add(socket);
			const envelope = value as Record<string, unknown>;
			rawFrames.push(raw);
			types.push(String(envelope.type));
			if (envelope.type === "authorize") {
				writeJson(socket, {
					version: 1,
					type: "authorize_result",
					decision: {
						authorized: true,
						authorizationId: "authorization-1",
						requestedModelId: "mock/requested",
						resolvedModelId: "mock/resolved",
						sessionId: "workspace:session",
						allowedOAuthCredentialIds: [7, 3],
					},
				});
				return;
			}
			if (envelope.type === "observe") {
				writeJson(socket, { version: 1, type: "observe_ack", ack: true });
				return;
			}
			writeJson(socket, { version: 1, type: "probe_ack", ack: true });
		});

		try {
			const secret = "synthetic-one-time-authorization-value";
			const client = createAuthGatewayPolicySocketClient(socketPath, { timeoutMs: 100 });
			const decision = await client.authorizeRequest(authorizationRequest(secret));
			expect(decision).toEqual({
				authorized: true,
				authorizationId: "authorization-1",
				requestedModelId: "mock/requested",
				resolvedModelId: "mock/resolved",
				sessionId: "workspace:session",
				allowedOAuthCredentialIds: [7, 3],
			});
			await client.observe(OBSERVATION);
			await client.observe(TERMINAL_OBSERVATION);
			expect(await client.probe()).toBe(true);

			expect(types).toEqual(["authorize", "observe", "observe", "probe"]);
			expect(connections.size).toBe(2);
			expect(JSON.parse(rawFrames[0] ?? "null")).toEqual({
				version: 1,
				type: "authorize",
				request: {
					requestId: "request-1",
					format: "openai-chat",
					requestedModelId: "mock/requested",
					requestedSessionId: "caller-hint",
					method: "POST",
					path: "/v1/chat/completions",
					payloadByteLength: 321,
					payloadSha256: "a".repeat(64),
					authorization: secret,
				},
			});
			expect(rawFrames.slice(1).join("\n")).not.toContain(secret);
			expect(rawFrames.join("\n").split(secret)).toHaveLength(2);
		} finally {
			await closePolicyServer(server);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("rejects unknown decision fields and fails observation delivery without the exact acknowledgement", async () => {
		const dir = await createSocketDir();
		const socketPath = path.join(dir, "policy.sock");
		let authorizationCount = 0;
		const server = await listenPolicyServer(socketPath, (value, _raw, socket) => {
			const envelope = value as Record<string, unknown>;
			if (envelope.type === "authorize") {
				authorizationCount++;
				writeJson(socket, {
					version: 1,
					type: "authorize_result",
					decision:
						authorizationCount === 1
							? { authorized: false, reasonCode: "denied", unknown: true }
							: {
									authorized: true,
									authorizationId: "authorization-1",
									requestedModelId: "mock/requested",
									resolvedModelId: "mock/resolved",
									sessionId: "workspace:session",
									allowedOAuthCredentialIds: [7],
								},
				});
				return;
			}
			writeJson(socket, { version: 1, type: "observe_ack", ack: false });
		});
		try {
			const client = createAuthGatewayPolicySocketClient(socketPath, { timeoutMs: 100 });
			await expect(client.authorizeRequest(authorizationRequest("one-time-secret"))).rejects.toThrow(
				"invalid authorization decision",
			);
			await client.authorizeRequest(authorizationRequest("valid-second-authorization"));
			await expect(client.observe(OBSERVATION)).rejects.toThrow("invalid observation acknowledgement");
		} finally {
			await closePolicyServer(server);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("rejects unknown, oversized, malformed, timed-out, EOF, and unavailable responses", async () => {
		const cases: Array<{
			name: string;
			handler?: PolicyRequestHandler;
			error: string;
			maxFrameBytes?: number;
		}> = [
			{
				name: "unknown field",
				handler: (_value, _raw, socket) => {
					writeJson(socket, { version: 1, type: "probe_ack", ack: true, extra: true });
				},
				error: "invalid readiness acknowledgement",
			},
			{
				name: "oversized",
				handler: (_value, _raw, socket) => {
					socket.write("x".repeat(128));
				},
				error: "exceeds the frame limit",
				maxFrameBytes: 64,
			},
			{
				name: "malformed",
				handler: (_value, _raw, socket) => {
					socket.write("not-json\n");
				},
				error: "malformed JSON",
			},
			{
				name: "timeout",
				handler: () => {},
				error: "timed out",
			},
			{
				name: "EOF",
				handler: (_value, _raw, socket) => {
					socket.end('{"version":1');
				},
				error: "closed before a complete response",
			},
		];

		for (const testCase of cases) {
			const dir = await createSocketDir();
			const socketPath = path.join(dir, "policy.sock");
			const server = await listenPolicyServer(socketPath, testCase.handler ?? (() => {}));
			try {
				const client = createAuthGatewayPolicySocketClient(socketPath, {
					timeoutMs: 30,
					...(testCase.maxFrameBytes === undefined ? {} : { maxFrameBytes: testCase.maxFrameBytes }),
				});
				await expect(client.probe()).rejects.toThrow(testCase.error);
			} finally {
				await closePolicyServer(server);
				await fs.rm(dir, { recursive: true, force: true });
			}
		}

		const dir = await createSocketDir();
		try {
			const client = createAuthGatewayPolicySocketClient(path.join(dir, "missing.sock"), { timeoutMs: 30 });
			await expect(client.probe()).rejects.toThrow("ENOENT");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("enforces the filesystem trust anchor without claiming unavailable peer credentials", async () => {
		const dir = await createSocketDir();
		const regularPath = path.join(dir, "regular");
		const realSocketPath = path.join(dir, "real.sock");
		const symlinkPath = path.join(dir, "linked.sock");
		await fs.writeFile(regularPath, "not a socket");
		const realServer = await listenPolicyServer(realSocketPath, (_value, _raw, socket) => {
			writeJson(socket, { version: 1, type: "probe_ack", ack: true });
		});
		await fs.symlink(realSocketPath, symlinkPath);
		try {
			const effectiveUid = process.geteuid?.();
			if (effectiveUid === undefined) throw new Error("expected effective user ID on Unix");
			expect((await fs.lstat(realSocketPath)).uid).toBe(effectiveUid);
			expect(await createAuthGatewayPolicySocketClient(realSocketPath).probe()).toBe(true);
			await expect(createAuthGatewayPolicySocketClient(regularPath).probe()).rejects.toThrow(
				"must name a Unix socket",
			);
			await expect(createAuthGatewayPolicySocketClient(symlinkPath).probe()).rejects.toThrow("not a symlink");
		} finally {
			await closePolicyServer(realServer);
		}

		const unsafeDir = path.join(dir, "unsafe");
		await fs.mkdir(unsafeDir);
		await fs.chmod(unsafeDir, 0o777);
		const unsafeSocketPath = path.join(unsafeDir, "policy.sock");
		const unsafeServer = await listenPolicyServer(unsafeSocketPath, (_value, _raw, socket) => {
			writeJson(socket, { version: 1, type: "probe_ack", ack: true });
		});
		try {
			await expect(createAuthGatewayPolicySocketClient(unsafeSocketPath).probe()).rejects.toThrow(
				"unsafe writable directory",
			);
		} finally {
			await closePolicyServer(unsafeServer);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("aborts an in-flight authorization exchange and closes its connection", async () => {
		const dir = await createSocketDir();
		const socketPath = path.join(dir, "policy.sock");
		const received = Promise.withResolvers<void>();
		const connectionClosed = Promise.withResolvers<void>();
		const server = await listenPolicyServer(socketPath, (_value, _raw, socket) => {
			socket.once("close", () => connectionClosed.resolve());
			received.resolve();
		});
		try {
			const controller = new AbortController();
			const client = createAuthGatewayPolicySocketClient(socketPath, { timeoutMs: 1_000 });
			const pending = client.authorizeRequest({
				...authorizationRequest("abort-only-secret"),
				signal: controller.signal,
			});
			await received.promise;
			controller.abort();
			await expect(pending).rejects.toThrow("exchange aborted");
			await connectionClosed.promise;
		} finally {
			await closePolicyServer(server);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("settles and closes every post-grant cancellation window exactly once", async () => {
		for (const phase of ["preflight", "credential", "upstream"] as const) {
			registerMockApi();
			const dir = await createSocketDir();
			const socketPath = path.join(dir, "policy.sock");
			const phaseEntered = Promise.withResolvers<void>();
			const phaseRelease = Promise.withResolvers<void>();
			const terminalArrived = Promise.withResolvers<AuthGatewayObservation>();
			const sessionClosed = Promise.withResolvers<void>();
			const observations: AuthGatewayObservation[] = [];
			const policyServer = await listenPolicyServer(socketPath, (value, _raw, socket) => {
				const envelope = value as Record<string, unknown>;
				if (envelope.type === "authorize") {
					socket.once("close", () => sessionClosed.resolve());
					writeJson(socket, {
						version: 1,
						type: "authorize_result",
						decision: {
							authorized: true,
							authorizationId: `authorization-${phase}`,
							requestedModelId: "cancel-model",
							resolvedModelId: "cancel-model",
							sessionId: `workspace:${phase}`,
							allowedOAuthCredentialIds: [7],
						},
					});
					return;
				}
				if (envelope.type !== "observe") return;
				const observationValue = envelope.observation;
				if (
					!observationValue ||
					typeof observationValue !== "object" ||
					!("type" in observationValue) ||
					typeof observationValue.type !== "string"
				) {
					throw new Error("expected policy observation frame");
				}
				const observation = observationValue as AuthGatewayObservation;
				observations.push(observation);
				if (phase === "preflight" && observation.type === "authorization") {
					phaseEntered.resolve();
					void phaseRelease.promise.then(() => writeJson(socket, { version: 1, type: "observe_ack", ack: true }));
					return;
				}
				writeJson(socket, { version: 1, type: "observe_ack", ack: true });
				if (observation.type === "terminal") terminalArrived.resolve(observation);
			});
			const storage = {
				getOAuthApiKeyFromCredentialIds: async () => {
					if (phase === "credential") {
						phaseEntered.resolve();
						await phaseRelease.promise;
					}
					return { apiKey: "authorized-key", credentialId: 7 };
				},
			} as unknown as AuthStorage;
			const mock = createMockModel({
				provider: "mock",
				id: "cancel-model",
				handler: async () => {
					if (phase === "upstream") {
						phaseEntered.resolve();
						await phaseRelease.promise;
					}
					return { content: ["cancelled output"] };
				},
			});
			const policyClient = createAuthGatewayPolicySocketClient(socketPath, { timeoutMs: 1_000 });
			const gateway = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: [],
				storage,
				authorizeRequest: policyClient.authorizeRequest,
				observer: policyClient.observe,
				readinessProbe: createAuthGatewayPolicyReadinessProbe(policyClient),
				resolveModel: () => mock,
			});
			try {
				const controller = new AbortController();
				const request = fetch(`${gateway.url}/v1/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						[AUTH_GATEWAY_POLICY_AUTHORIZATION_HEADER]: "one-time-cancel-authorization",
					},
					body: JSON.stringify({
						model: "cancel-model",
						messages: [{ role: "user", content: "cancel me" }],
						stream: false,
					}),
					signal: controller.signal,
				}).catch(() => undefined);
				await phaseEntered.promise;
				controller.abort();
				phaseRelease.resolve();
				await request;
				const terminal = await terminalArrived.promise;
				await sessionClosed.promise;
				expect(terminal.type).toBe("terminal");
				if (terminal.type !== "terminal") throw new Error("expected terminal observation");
				// Client cancellation and server completion race after the request
				// reaches the gateway; either terminal outcome is valid, but the
				// policy session must still settle exactly once.
				expect(["aborted", "success"]).toContain(terminal.outcome);
				expect(observations.filter(observation => observation.type === "terminal")).toHaveLength(1);
			} finally {
				await gateway.close();
				await closePolicyServer(policyServer);
				await fs.rm(dir, { recursive: true, force: true });
				clearCustomApis();
			}
		}
	});

	test("lets callers stop waiting while one shared readiness probe finishes and populates the cache", async () => {
		const probeStarted = Promise.withResolvers<AbortSignal>();
		const probeResult = Promise.withResolvers<boolean>();
		let probeCalls = 0;
		const client = {
			probe: (signal?: AbortSignal): Promise<boolean> => {
				if (!signal) return Promise.reject(new Error("expected readiness signal"));
				probeCalls++;
				probeStarted.resolve(signal);
				return probeResult.promise;
			},
		} as AuthGatewayPolicySocketClient;
		const readiness = createAuthGatewayPolicyReadinessProbe(client);
		const controller = new AbortController();
		const cancelledWait = readiness(controller.signal);
		const sharedSignal = await probeStarted.promise;
		controller.abort();
		expect(await cancelledWait).toBe(false);
		expect(sharedSignal.aborted).toBe(false);

		const nextWait = readiness();
		expect(probeCalls).toBe(1);
		probeResult.resolve(true);
		expect(await nextWait).toBe(true);
		expect(await readiness()).toBe(true);
		expect(probeCalls).toBe(1);
	});

	test("tracks readiness across malformed acknowledgements, recovery, and outage", async () => {
		const dir = await createSocketDir();
		const socketPath = path.join(dir, "policy.sock");
		let now = 0;
		const client = createAuthGatewayPolicySocketClient(socketPath, { timeoutMs: 250 });
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			storage: {} as AuthStorage,
			resolveModel: () => undefined,
			authorizeRequest: client.authorizeRequest,
			observer: client.observe,
			readinessProbe: createAuthGatewayPolicyReadinessProbe(client, { cacheMs: 250, now: () => now }),
			version: "policy-test",
		});
		let policyServer: net.Server | undefined;
		try {
			let response = await fetch(`${gateway.url}/healthz`);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ ok: false, version: "policy-test" });
			now = 251;

			let validAck = false;
			let probeCount = 0;
			policyServer = await listenPolicyServer(socketPath, (_value, _raw, socket) => {
				probeCount++;
				writeJson(
					socket,
					validAck
						? { version: 1, type: "probe_ack", ack: true }
						: { version: 1, type: "probe_ack", ack: true, unknown: true },
				);
			});
			response = await fetch(`${gateway.url}/healthz`);
			expect(response.status).toBe(503);
			expect(probeCount).toBe(1);

			validAck = true;
			now = 502;
			const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${gateway.url}/healthz`)));
			expect(responses.every(item => item.status === 200)).toBe(true);
			response = responses[0]!;
			expect(probeCount).toBe(2);
			expect((await fetch(`${gateway.url}/healthz`)).status).toBe(200);
			expect(probeCount).toBe(2);
			expect(await response.json()).toEqual({ ok: true, version: "policy-test" });
			expect((await fetch(`${gateway.url}/v1/models`)).status).toBe(403);

			await closePolicyServer(policyServer);
			policyServer = undefined;
		} finally {
			if (policyServer) await closePolicyServer(policyServer);
			await gateway.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("validates launch-only socket paths and leaves legacy readiness unchanged", async () => {
		expect(() => validateAuthGatewayPolicySocketPath("")).toThrow("non-empty absolute path");
		expect(() => validateAuthGatewayPolicySocketPath("relative.sock")).toThrow("non-empty absolute path");
		expect(() => validateAuthGatewayPolicySocketPath("/tmp/policy\0.sock")).toThrow("without NUL bytes");
		await expect(
			runAuthGatewayCommand({ action: "status", flags: { policySocket: "/tmp/policy.sock" } }),
		).rejects.toThrow("only valid with `auth-gateway serve`");

		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			storage: {} as AuthStorage,
			resolveModel: () => undefined,
			version: "legacy-test",
		});
		try {
			const response = await fetch(`${gateway.url}/healthz`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, version: "legacy-test" });
		} finally {
			await gateway.close();
		}
	});
});
