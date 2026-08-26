/**
 * Broker protocol version handshake: a new CLI connecting to a broker left
 * over from a previous CLI version (persistent/detached daemons keep it
 * alive across upgrades) must refuse wait operations that need generation
 * binding or the omitted-`for` auto condition with a classified
 * upgrade-required refusal — without killing the foreign broker and without
 * silently downgrading to the legacy contract. Waits that never used the new
 * semantics (explicit `for`, no `id`) pass through unchanged.
 *
 * The legacy broker is simulated over a real Unix socket: it answers `ping`
 * without `protocolVersion`, ignores the wait `id`, and rejects an omitted
 * `for` with its pre-upgrade parse error, exactly like a broker from before
 * the wait-generation-binding protocol.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import { type DaemonOperation, decodeDaemonWaitReject } from "../../src/launch/protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LEGACY_WAIT_SNAPSHOT = {
	name: "web",
	id: "daemon-1",
	state: "exited",
	createdAt: 1,
	startedAt: 1,
	exitedAt: 2,
	exitCode: 0,
	restartCount: 0,
	outputBytes: 0,
	persist: true,
	detached: false,
};

interface LegacyBroker {
	server: net.Server;
	/** Every request the broker received, in order (for no-downgrade assertions). */
	requests: unknown[];
	stop(): Promise<void>;
}

/** A broker that predates wait generation binding, listening on the scope endpoint. */
async function startLegacyBroker(projectDir: string, runtimeDir: string): Promise<LegacyBroker> {
	const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
	await fs.rm(endpoint, { force: true });
	const requests: unknown[] = [];
	const sockets = new Set<net.Socket>();
	const { promise, resolve, reject } = Promise.withResolvers<net.Server>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", chunk => {
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request: unknown = JSON.parse(line);
				requests.push(request);
				if (!isRecord(request) || typeof request.id !== "string") continue;
				const operation = isRecord(request.operation) ? request.operation : {};
				const respond = (ok: boolean, payload: unknown): void => {
					socket.write(
						`${JSON.stringify(ok ? { id: request.id, ok, result: payload } : { id: request.id, ok, error: payload })}\n`,
					);
				};
				switch (operation.op) {
					case "ping":
						// Legacy brokers never heard of protocol versions.
						respond(true, { op: "ping", projectDir });
						break;
					case "wait":
						// Legacy parse: `for` is required; the `id` field is ignored.
						if (operation.for === undefined) {
							respond(false, "operation.for must be a non-empty string");
						} else {
							respond(true, { op: "wait", daemon: LEGACY_WAIT_SNAPSHOT, timedOut: false });
						}
						break;
					case "list":
						respond(true, { op: "list", daemons: [] });
						break;
					default:
						respond(true, { op: operation.op });
				}
			}
		});
	});
	server.on("error", reject);
	server.listen(endpoint, () => resolve(server));
	const serverReady = await promise;
	return {
		server: serverReady,
		requests,
		stop: async () => {
			// Destroy every accepted socket first so `close` cannot wait on a
			// lingering connection; the bounded fallback keeps the test from
			// hanging even if a close callback is never delivered.
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			const { promise: closed, resolve: resolveClose } = Promise.withResolvers<void>();
			const timer = setTimeout(resolveClose, 1_000);
			serverReady.close(() => {
				clearTimeout(timer);
				resolveClose();
			});
			await closed;
			await fs.rm(endpoint, { force: true });
		},
	};
}

function waitOperations(requests: unknown[]): unknown[] {
	return requests.filter(
		request => isRecord(request) && isRecord(request.operation) && request.operation.op === "wait",
	);
}

describe("daemon broker protocol version handshake", () => {
	it("refuses a generation-bound wait against a legacy broker without killing it", async () => {
		using tempDir = TempDir.createSync("@omp-proto-legacy-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(runtimeDir, { recursive: true });

		const legacy = await startLegacyBroker(projectDir, runtimeDir);
		try {
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
			try {
				const error = await client
					.request({ op: "wait", name: "web", id: "daemon-1", for: "exit", timeoutMs: 1_000 })
					.then(
						() => null,
						(e: unknown) => e,
					);
				expect(error).not.toBeNull();
				expect(error).toBeInstanceOf(DaemonBrokerRejectedError);
				const reject = decodeDaemonWaitReject((error as Error).message);
				expect(reject?.code).toBe("upgrade-required");

				// No silent downgrade: the id-bound wait never reached the legacy
				// broker, which would have ignored the id.
				expect(waitOperations(legacy.requests)).toHaveLength(0);

				// Non-destructive: the foreign broker is untouched and still
				// serves requests — the client never shut it down or broke the
				// connection.
				const listed = await client.request({ op: "list" });
				expect(listed.op).toBe("list");
			} finally {
				client.close();
			}
		} finally {
			await legacy.stop();
		}
	}, 20_000);

	it("refuses an auto wait (omitted for) against a legacy broker before its parse error surfaces", async () => {
		using tempDir = TempDir.createSync("@omp-proto-legacy-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(runtimeDir, { recursive: true });

		const legacy = await startLegacyBroker(projectDir, runtimeDir);
		try {
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
			try {
				const error = await client.request({ op: "wait", name: "web", timeoutMs: 1_000 }).then(
					() => null,
					(e: unknown) => e,
				);
				expect(error).not.toBeNull();
				const reject = decodeDaemonWaitReject((error as Error).message);
				expect(reject?.code).toBe("upgrade-required");

				// The auto wait was refused client-side; the legacy broker never
				// saw a wait it could only reject with an unclassified parse error.
				expect(waitOperations(legacy.requests)).toHaveLength(0);
			} finally {
				client.close();
			}
		} finally {
			await legacy.stop();
		}
	}, 20_000);

	it("passes legacy-shaped waits (explicit for, no id) through unchanged", async () => {
		using tempDir = TempDir.createSync("@omp-proto-legacy-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(runtimeDir, { recursive: true });

		const legacy = await startLegacyBroker(projectDir, runtimeDir);
		try {
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
			try {
				const result = await client.request({
					op: "wait",
					name: "web",
					for: "exit",
					timeoutMs: 1_000,
				} satisfies DaemonOperation);
				// The legacy broker's own contract is honored unchanged: the wait
				// round-tripped with an explicit `for` and no generation id.
				expect(result.op).toBe("wait");
				if (result.op === "wait") expect(result.daemon.id).toBe("daemon-1");
				expect(waitOperations(legacy.requests)).toHaveLength(1);
			} finally {
				client.close();
			}
		} finally {
			await legacy.stop();
		}
	}, 20_000);
});
