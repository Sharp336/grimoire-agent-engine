import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import {
	REMOTE_RUNTIME_MAX_FRAME_BYTES,
	REMOTE_RUNTIME_REQUIRED_CAPABILITIES,
	RemoteRuntimeClient,
	RemoteRuntimeProtocolError,
	type RemoteRuntimeRequestEnvelope,
} from "@oh-my-pi/pi-coding-agent/remote-runtime/client";
import {
	parseRemoteRuntimeConfig,
	REMOTE_RUNTIME_PROTOCOL_VERSION,
	type RemoteRuntimeConfig,
} from "@oh-my-pi/pi-coding-agent/remote-runtime/config";
import { TempDir } from "@oh-my-pi/pi-utils";

interface ServerHarness {
	readonly socketPath: string;
	readonly server: net.Server;
	readonly sockets: Set<net.Socket>;
}

function runtimeConfig(socketPath: string, timeoutMs = 1_000): RemoteRuntimeConfig {
	return parseRemoteRuntimeConfig({
		version: REMOTE_RUNTIME_PROTOCOL_VERSION,
		socketPath,
		controllerId: "controller-a",
		executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		rootExecutionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		parentExecutionId: null,
		assignmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		depth: 0,
		revision: "a".repeat(40),
		grantId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
		policyDigest: `sha256:${"b".repeat(64)}`,
		budgetRef: "budget:root-1",
		schemaRef: "schema:root-1",
		requestTimeoutMs: timeoutMs,
	});
}
async function startServer(
	socketPath: string,
	onFrame: (socket: net.Socket, frame: Record<string, unknown>) => void,
	onConnect?: (socket: net.Socket) => void,
): Promise<ServerHarness> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		onConnect?.(socket);
		sockets.add(socket);
		let residual: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		socket.on("data", chunk => {
			const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			residual = residual.length === 0 ? Buffer.from(data) : Buffer.concat([residual, data]);
			while (true) {
				const newline = residual.indexOf(0x0a);
				if (newline === -1) return;
				const line = residual.subarray(0, newline).toString("utf8");
				residual = Buffer.from(residual.subarray(newline + 1));
				onFrame(socket, JSON.parse(line) as Record<string, unknown>);
			}
		});
		socket.on("close", () => sockets.delete(socket));
	});
	const listening = Promise.withResolvers<void>();
	server.once("listening", listening.resolve);
	server.once("error", listening.reject);
	server.listen(socketPath);
	await listening.promise;
	await fs.chmod(socketPath, 0o600);
	return { socketPath, server, sockets };
}

async function stopServer(harness: ServerHarness): Promise<void> {
	for (const socket of harness.sockets) socket.destroy();
	const closed = Promise.withResolvers<void>();
	harness.server.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

function resultFrame(requestId: string, result: unknown): string {
	return `${JSON.stringify({
		protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
		kind: "result",
		requestId,
		result,
	})}\n`;
}

function bootstrapAcknowledgement(capabilities: readonly string[] = REMOTE_RUNTIME_REQUIRED_CAPABILITIES): {
	readonly version: typeof REMOTE_RUNTIME_PROTOCOL_VERSION;
	readonly capabilities: readonly string[];
	readonly maxFrameBytes: number;
} {
	return {
		version: REMOTE_RUNTIME_PROTOCOL_VERSION,
		capabilities,
		maxFrameBytes: REMOTE_RUNTIME_MAX_FRAME_BYTES,
	};
}

function bootstrapAware(
	handle: (socket: net.Socket, frame: RemoteRuntimeRequestEnvelope) => void,
): (socket: net.Socket, frame: Record<string, unknown>) => void {
	return (socket, frame) => {
		if (frame.kind !== "request" || typeof frame.requestId !== "string") return;
		const request = frame as unknown as RemoteRuntimeRequestEnvelope;
		if (request.operation === "runtime.bootstrap") {
			socket.write(resultFrame(request.requestId, bootstrapAcknowledgement()));
			return;
		}
		handle(socket, request);
	};
}

describe("sealed remote runtime socket protocol", () => {
	it("requires an exact bootstrap capability set, protocol version, and frame limit", async () => {
		const cases: ReadonlyArray<{
			readonly acknowledgement: unknown;
			readonly code: string;
		}> = [
			{
				acknowledgement: bootstrapAcknowledgement(REMOTE_RUNTIME_REQUIRED_CAPABILITIES.slice(0, -1)),
				code: "CAPABILITY_MISMATCH",
			},
			{
				acknowledgement: bootstrapAcknowledgement([
					...REMOTE_RUNTIME_REQUIRED_CAPABILITIES,
					"unrequested-capability",
				]),
				code: "CAPABILITY_MISMATCH",
			},
			{
				acknowledgement: { ...bootstrapAcknowledgement(), version: "omp.remote-runtime.v2" },
				code: "VERSION_MISMATCH",
			},
			{
				acknowledgement: { ...bootstrapAcknowledgement(), maxFrameBytes: REMOTE_RUNTIME_MAX_FRAME_BYTES - 1 },
				code: "FRAME_LIMIT_MISMATCH",
			},
		];

		for (const testCase of cases) {
			using tempDir = TempDir.createSync("@rr-");
			const socketPath = tempDir.join("runtime.sock");
			const harness = await startServer(socketPath, (socket, frame) => {
				if (frame.kind === "request" && typeof frame.requestId === "string") {
					socket.write(resultFrame(frame.requestId, testCase.acknowledgement));
				}
			});
			const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
			try {
				await expect(client.start()).rejects.toMatchObject({ code: testCase.code });
			} finally {
				client.close();
				await stopServer(harness);
			}
		}
	});

	it("sends an exact authority-bound request frame with no endpoint or credential material", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const observed = Promise.withResolvers<RemoteRuntimeRequestEnvelope>();
		const harness = await startServer(
			socketPath,
			bootstrapAware((socket, request) => {
				observed.resolve(request);
				socket.write(resultFrame(request.requestId, { accepted: true }));
			}),
		);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		try {
			await client.start();
			await expect(client.request("registry.status", { identity: "logical" })).resolves.toEqual({ accepted: true });
			const request = await observed.promise;
			expect(Object.keys(request).sort()).toEqual(
				["context", "idempotencyKey", "kind", "operation", "payload", "protocol", "requestId"].sort(),
			);
			expect(request.context).toEqual({
				controllerId: "controller-a",
				executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				revision: "a".repeat(40),
				grantId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
				policyDigest: `sha256:${"b".repeat(64)}`,
				parentExecutionId: null,
				rootExecutionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				depth: 0,
				assignmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
				budgetRef: "budget:root-1",
				schemaRef: "schema:root-1",
			});
			expect(JSON.stringify(request)).not.toContain(socketPath);
			expect(JSON.stringify(request)).not.toMatch(/token|credential/i);
		} finally {
			client.close();
			await stopServer(harness);
		}
	});

	it("rejects symlinked, permissive, foreign-owned, and substitutable socket fixtures", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const realSocket = tempDir.join("runtime.sock");
		const harness = await startServer(
			realSocket,
			bootstrapAware(() => {}),
		);
		try {
			const symlinkSocket = tempDir.join("runtime-link.sock");
			await fs.symlink(realSocket, symlinkSocket);
			await expect(new RemoteRuntimeClient(runtimeConfig(symlinkSocket)).start()).rejects.toMatchObject({
				code: "UNTRUSTED_SOCKET",
			});

			await fs.chmod(realSocket, 0o660);
			await expect(new RemoteRuntimeClient(runtimeConfig(realSocket)).start()).rejects.toMatchObject({
				code: "UNTRUSTED_SOCKET",
			});
			await fs.chmod(realSocket, 0o600);

			if (typeof process.geteuid !== "function") throw new Error("test requires geteuid");
			const effectiveUid = process.geteuid();
			const uid = vi.spyOn(process, "geteuid").mockReturnValue(effectiveUid + 1);
			try {
				await expect(new RemoteRuntimeClient(runtimeConfig(realSocket)).start()).rejects.toMatchObject({
					code: "UNTRUSTED_SOCKET",
				});
			} finally {
				uid.mockRestore();
			}
		} finally {
			await stopServer(harness);
		}

		const openDirectory = tempDir.join("open");
		await fs.mkdir(openDirectory, { mode: 0o700 });
		const openSocket = `${openDirectory}/runtime.sock`;
		const openHarness = await startServer(
			openSocket,
			bootstrapAware(() => {}),
		);
		try {
			await fs.chmod(openDirectory, 0o777);
			await expect(new RemoteRuntimeClient(runtimeConfig(openSocket)).start()).rejects.toMatchObject({
				code: "UNTRUSTED_SOCKET",
			});
		} finally {
			await fs.chmod(openDirectory, 0o700);
			await stopServer(openHarness);
		}
	});

	it("rejects inbound frames before post-connect socket authority verification", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const connected = Promise.withResolvers<void>();
		const verificationGate = Promise.withResolvers<void>();
		const preVerificationDispatch = Promise.withResolvers<void>();
		const observed: number[] = [];
		const harness = await startServer(
			socketPath,
			bootstrapAware(() => {}),
			socket => {
				socket.write(
					`${JSON.stringify({
						protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
						kind: "observation",
						stream: "attacker",
						cursor: 1,
						observation: { injected: true },
					})}\n`,
				);
				connected.resolve();
			},
		);
		const originalRealpath = fs.realpath;
		let verificationPass = 0;
		const gatedRealpath = async (pathValue: Parameters<typeof fs.realpath>[0]): Promise<string> => {
			const resolved = await originalRealpath(pathValue);
			verificationPass += 1;
			if (verificationPass === 2) await verificationGate.promise;
			return resolved;
		};
		const realpath = vi.spyOn(fs, "realpath").mockImplementation(gatedRealpath as typeof fs.realpath);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		client.onObservation("attacker", envelope => {
			observed.push(envelope.cursor);
			preVerificationDispatch.resolve();
		});
		const started = client.start();
		try {
			await connected.promise;
			const outcome = await Promise.race([
				started.then(
					() => ({ kind: "started" as const }),
					error => ({ kind: "rejected" as const, error }),
				),
				preVerificationDispatch.promise.then(() => ({ kind: "dispatched" as const })),
			]);
			expect(outcome).toMatchObject({
				kind: "rejected",
				error: { code: "UNTRUSTED_SOCKET" },
			});
			expect(observed).toEqual([]);
		} finally {
			verificationGate.resolve();
			await started.catch(() => undefined);
			client.close();
			realpath.mockRestore();
			await stopServer(harness);
		}
	});

	it("reassembles fragmented frames and demultiplexes coalesced concurrent results", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const requests: RemoteRuntimeRequestEnvelope[] = [];
		const harness = await startServer(
			socketPath,
			bootstrapAware((socket, request) => {
				requests.push(request);
				if (requests.length !== 2) return;
				const second = resultFrame(requests[1].requestId, { order: 2 });
				const first = resultFrame(requests[0].requestId, { order: 1 });
				const combined = Buffer.from(`${second}${first}`);
				socket.write(combined.subarray(0, 13));
				socket.write(combined.subarray(13, 41));
				socket.write(combined.subarray(41));
			}),
		);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		try {
			await client.start();
			const [first, second] = await Promise.all([
				client.request("registry.status", { n: 1 }),
				client.request("registry.progress", { n: 2 }),
			]);
			expect(first).toEqual({ order: 1 });
			expect(second).toEqual({ order: 2 });
		} finally {
			client.close();
			await stopServer(harness);
		}
	});

	it("allows an explicitly unlimited subagent run to outlive the generic RPC timeout", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const harness = await startServer(
			socketPath,
			bootstrapAware((socket, request) => {
				setTimeout(() => socket.write(resultFrame(request.requestId, { completed: true })), 150);
			}),
		);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath, 100));
		try {
			await client.start();
			await expect(client.request("subagent.run", {}, { timeoutMs: null })).resolves.toEqual({ completed: true });
			await expect(client.request("registry.status", {}, { timeoutMs: null })).rejects.toMatchObject({
				code: "INVALID_TIMEOUT",
			});
		} finally {
			client.close();
			await stopServer(harness);
		}
	});

	it("emits exact cancellation frames for AbortSignal and request deadlines", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const cancels: Record<string, unknown>[] = [];
		const sawTwoCancels = Promise.withResolvers<void>();
		const sawAbortRequest = Promise.withResolvers<void>();
		const sawTimeoutRequest = Promise.withResolvers<void>();
		let requestCount = 0;
		const harness = await startServer(socketPath, (socket, frame) => {
			if (
				frame.kind === "request" &&
				frame.operation === "runtime.bootstrap" &&
				typeof frame.requestId === "string"
			) {
				socket.write(resultFrame(frame.requestId, bootstrapAcknowledgement()));
				return;
			}
			if (frame.kind === "request") {
				requestCount += 1;
				if (requestCount === 1) sawAbortRequest.resolve();
				if (requestCount === 2) sawTimeoutRequest.resolve();
				if (requestCount === 3 && typeof frame.requestId === "string") {
					socket.write(resultFrame(frame.requestId, { alive: true }));
				}
			}
			if (frame.kind === "cancel") {
				cancels.push(frame);
				if (cancels.length === 2) sawTwoCancels.resolve();
				if (typeof frame.requestId === "string") {
					socket.write(resultFrame(frame.requestId, { cancelled: true }));
				}
			}
		});
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		try {
			await client.start();
			const controller = new AbortController();
			const aborted = client.request("registry.status", {}, { signal: controller.signal });
			await sawAbortRequest.promise;
			controller.abort();
			await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
			vi.useFakeTimers();
			const timedOut = client.request("registry.progress", {}, { timeoutMs: 10 });
			await sawTimeoutRequest.promise;
			vi.advanceTimersByTime(10);
			await expect(timedOut).rejects.toMatchObject({ code: "TIMEOUT" });
			await sawTwoCancels.promise;
			expect(cancels.map(frame => frame.reason).sort()).toEqual(["aborted", "timeout"]);
			for (const cancel of cancels) {
				expect(Object.keys(cancel).sort()).toEqual(
					["context", "idempotencyKey", "kind", "protocol", "reason", "requestId", "targetRequestId"].sort(),
				);
			}
			vi.useRealTimers();
			await expect(client.request("registry.result", {})).resolves.toEqual({ alive: true });
		} finally {
			vi.useRealTimers();
			client.close();
			await stopServer(harness);
		}
	});

	it("rejects outgoing and residual incoming frames beyond the byte ceiling", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const harness = await startServer(
			socketPath,
			bootstrapAware((socket, request) => {
				if (request.operation === "registry.status") {
					socket.write(Buffer.alloc(REMOTE_RUNTIME_MAX_FRAME_BYTES + 1, 0x61));
				}
			}),
		);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		try {
			await client.start();
			await expect(
				client.request("peer.deliver", { body: "x".repeat(REMOTE_RUNTIME_MAX_FRAME_BYTES) }),
			).rejects.toMatchObject({
				code: "FRAME_TOO_LARGE",
			});
			await expect(client.request("registry.status", {})).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
		} finally {
			client.close();
			await stopServer(harness);
		}
	});

	it("rejects a non-empty residual buffer when the controller ends without a newline", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const harness = await startServer(
			socketPath,
			bootstrapAware((socket, request) => {
				socket.end(
					JSON.stringify({
						protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
						kind: "result",
						requestId: request.requestId,
						result: { incomplete: true },
					}),
				);
			}),
		);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		try {
			await client.start();
			await expect(client.request("registry.status", {})).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
		} finally {
			client.close();
			await stopServer(harness);
		}
	});

	it("rejects unknown envelope fields and protocol version mismatches terminally", async () => {
		for (const mode of ["unknown", "version"] as const) {
			using tempDir = TempDir.createSync("@rr-");
			const socketPath = tempDir.join("runtime.sock");
			const harness = await startServer(socketPath, (socket, frame) => {
				if (frame.kind !== "request" || typeof frame.requestId !== "string") return;
				socket.write(
					`${JSON.stringify({
						protocol: mode === "version" ? "omp.remote-runtime.v2" : REMOTE_RUNTIME_PROTOCOL_VERSION,
						kind: "result",
						requestId: frame.requestId,
						result: bootstrapAcknowledgement(),
						...(mode === "unknown" ? { extra: true } : {}),
					})}\n`,
				);
			});
			const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
			try {
				await expect(client.start()).rejects.toBeInstanceOf(RemoteRuntimeProtocolError);
				await expect(client.request("registry.status", {})).rejects.toMatchObject({ code: expect.any(String) });
			} finally {
				client.close();
				await stopServer(harness);
			}
		}
	});

	it("enforces contiguous observation cursors across coalesced frames", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const harness = await startServer(socketPath, (socket, frame) => {
			if (frame.kind !== "request" || typeof frame.requestId !== "string") return;
			const bootstrap = resultFrame(frame.requestId, bootstrapAcknowledgement());
			const observations = [1, 2]
				.map(cursor =>
					JSON.stringify({
						protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
						kind: "observation",
						stream: "peer:main",
						cursor,
						observation: { body: `message-${cursor}` },
					}),
				)
				.join("\n");
			socket.write(`${bootstrap}${observations}\n`);
		});
		const sawTwoObservations = Promise.withResolvers<void>();
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		const observed: number[] = [];
		client.onObservation("peer:main", envelope => {
			observed.push(envelope.cursor);
			if (observed.length === 2) sawTwoObservations.resolve();
		});
		try {
			await client.start();
			await sawTwoObservations.promise;
			expect(observed).toEqual([1, 2]);
		} finally {
			client.close();
			await stopServer(harness);
		}
	});

	it("isolates observation listener failures and ignores unowned streams while requests continue", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const harness = await startServer(
			socketPath,
			bootstrapAware((socket, request) => {
				if (request.operation === "registry.status") {
					socket.write(
						`${JSON.stringify({
							protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
							kind: "observation",
							stream: "subagent.owned",
							cursor: 1,
							observation: { registration: "conflict" },
						})}\n${JSON.stringify({
							protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
							kind: "observation",
							stream: "subagent.unowned",
							cursor: 999,
							observation: {},
						})}\n`,
					);
				}
				socket.write(resultFrame(request.requestId, { operation: request.operation }));
			}),
		);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		client.onObservation("subagent.owned", () => {
			throw new Error("launch-local registration collision");
		});
		try {
			await client.start();
			await expect(
				Promise.all([client.request("registry.status", {}), client.request("registry.progress", {})]),
			).resolves.toEqual([{ operation: "registry.status" }, { operation: "registry.progress" }]);
			await expect(client.request("registry.result", {})).resolves.toEqual({
				operation: "registry.result",
			});
		} finally {
			client.close();
			await stopServer(harness);
		}
	});

	it("retains a bounded exact set of abandoned request ids and fails closed after eviction", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("runtime.sock");
		const abandonedCount = 1_025;
		const controllers = Array.from({ length: abandonedCount }, () => new AbortController());
		const requestIds = new Array<string>(abandonedCount);
		let peerSocket: net.Socket | undefined;
		const harness = await startServer(
			socketPath,
			bootstrapAware((socket, request) => {
				peerSocket = socket;
				if (request.operation === "registry.abandon") {
					const payload = request.payload;
					if (
						typeof payload !== "object" ||
						payload === null ||
						!("index" in payload) ||
						typeof payload.index !== "number" ||
						!Number.isInteger(payload.index) ||
						payload.index < 0 ||
						payload.index >= controllers.length
					) {
						throw new Error("remote runtime test received an invalid abandonment index");
					}
					requestIds[payload.index] = request.requestId;
					controllers[payload.index].abort();
					return;
				}
				if (request.operation === "registry.probe") {
					socket.write(resultFrame(request.requestId, { alive: true }));
					return;
				}
				if (request.operation === "registry.evicted") {
					socket.write(
						`${resultFrame(requestIds[0], { late: "evicted" })}${resultFrame(request.requestId, {
							unsafe: true,
						})}`,
					);
				}
			}),
		);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath, 10_000));
		try {
			await client.start();
			const outcomes = await Promise.all(
				controllers.map((controller, index) =>
					client.request("registry.abandon", { index }, { signal: controller.signal }).then(
						() => "resolved",
						error => (error as RemoteRuntimeProtocolError).code,
					),
				),
			);
			expect(outcomes.every(code => code === "ABORTED")).toBe(true);
			expect(requestIds.every(requestId => typeof requestId === "string")).toBe(true);
			const connectedSocket = peerSocket;
			if (!connectedSocket) throw new Error("remote runtime test socket did not connect");

			connectedSocket.write(resultFrame(requestIds[abandonedCount - 1], { late: "retained" }));
			await expect(client.request("registry.probe", {})).resolves.toEqual({ alive: true });
			await expect(client.request("registry.evicted", {})).rejects.toMatchObject({ code: "UNKNOWN_REQUEST" });
		} finally {
			client.close();
			await stopServer(harness);
		}
	});

	it("never exposes controller error text, credentials, or private paths", async () => {
		using tempDir = TempDir.createSync("@rr-");
		const socketPath = tempDir.join("r.sock");
		const harness = await startServer(
			socketPath,
			bootstrapAware((socket, request) => {
				socket.write(
					`${JSON.stringify({
						protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
						kind: "error",
						requestId: request.requestId,
						error: {
							code: "DENIED",
							message: "token super-secret failed at /Users/private/controller.sock",
							retryable: false,
						},
					})}\n`,
				);
			}),
		);
		const client = new RemoteRuntimeClient(runtimeConfig(socketPath));
		try {
			await client.start();
			let failure: unknown;
			try {
				await client.request("registry.status", {});
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(RemoteRuntimeProtocolError);
			const message = String(failure);
			expect(message).toContain("DENIED");
			expect(message).not.toContain("super-secret");
			expect(message).not.toContain("/Users/private");
			expect(message).not.toContain(socketPath);
		} finally {
			client.close();
			await stopServer(harness);
		}
	});
});
