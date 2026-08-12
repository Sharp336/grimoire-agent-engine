import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type BridgeMessage,
	PRIME_DAEMON_PROTOCOL_NAME,
	PRIME_DAEMON_PROTOCOL_VERSION,
	type PrimeDaemonCommandEnvelope,
} from "@oh-my-pi/prime-bridge-protocol";
import type { PrimeBridgeFetch } from "../../../coding-agent/src/integrations/prime-bridge/client";
import { PrimeExternalPeerProvider } from "../../../coding-agent/src/integrations/prime-bridge/external-peer-provider";
import { resolveBridgeConfig } from "../../src/config";
import { PrimeDaemonClient } from "../../src/prime/client";
import { type PrimeBridgeServer, startPrimeBridgeServer } from "../../src/server";
import { BridgeStore } from "../../src/store";

const temporaryDirectories: string[] = [];

interface FakePrimeDaemon {
	listener: Bun.UnixSocketListener<undefined>;
	commands: PrimeDaemonCommandEnvelope<Record<string, unknown>>[];
	connections: Set<Bun.Socket<undefined>>;
	send(value: unknown): void;
	stop(): void;
}

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function hello(): Record<string, unknown> {
	return {
		type: "daemon_hello",
		socketPath: "test",
		protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
		clientId: "fake-prime-daemon",
		serverCapabilities: ["event_sequence"],
	};
}

function response(
	command: PrimeDaemonCommandEnvelope<Record<string, unknown>>,
	data: unknown,
): Record<string, unknown> {
	return {
		type: "response",
		id: command.id,
		command: command.command.type,
		success: true,
		data,
	};
}

function sessionEvent(sequence: number): Record<string, unknown> {
	return {
		type: "event",
		id: `prime-session-event-${sequence}`,
		protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
		activeSessionId: "prime-session",
		sequence,
		cursor: { generation: "prime-generation-1", sequence },
		emittedAt: new Date().toISOString(),
		event: {
			type: "session_status",
			activeSessionId: "prime-session",
			value: "ready",
		},
	};
}

function fakePrimeDaemon(socketPath: string): FakePrimeDaemon {
	const commands: PrimeDaemonCommandEnvelope<Record<string, unknown>>[] = [];
	const connections = new Set<Bun.Socket<undefined>>();
	const buffers = new Map<Bun.Socket<undefined>, string>();
	let sentSessionEvent = false;
	const daemon = {} as FakePrimeDaemon;
	const listener = Bun.listen<undefined>({
		unix: socketPath,
		socket: {
			open(socket) {
				connections.add(socket);
				buffers.set(socket, "");
				socket.write(line(hello()));
			},
			data(socket, data) {
				let buffer = `${buffers.get(socket) ?? ""}${data.toString()}`;
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const raw = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (raw.length > 0) {
						const command = JSON.parse(raw) as PrimeDaemonCommandEnvelope<Record<string, unknown>>;
						commands.push(command);
						const commandType = command.command.type;
						if (commandType === "list") {
							if (!sentSessionEvent) {
								sentSessionEvent = true;
								daemon.send(sessionEvent(1));
							}
							daemon.send(
								response(command, [
									{ id: "prime:prime-session", displayName: "Prime session", status: "active" },
								]),
							);
						} else if (commandType === "send_message") {
							daemon.send(
								response(command, {
									meshMessageId: command.id.replace(/^bridge:/, ""),
									status: "delivered",
								}),
							);
						} else if (commandType === "attach") {
							const activeSessionId = String(command.command.activeSessionId);
							daemon.send(
								response(command, {
									activeSessionId,
									snapshot: {
										activeSessionId,
										summary: { messageCount: 0 },
										messages: [],
									},
								}),
							);
						} else if (commandType !== "ack_result") {
							daemon.send(response(command, { ok: true }));
						}
					}
					newline = buffer.indexOf("\n");
				}
				buffers.set(socket, buffer);
			},
			close(socket) {
				connections.delete(socket);
				buffers.delete(socket);
			},
		},
	});
	daemon.listener = listener;
	daemon.commands = commands;
	daemon.connections = connections;
	daemon.send = value => {
		for (const socket of connections) if (socket.readyState === 1) socket.write(line(value));
	};
	daemon.stop = () => listener.stop(true);
	return daemon;
}

async function testPaths(): Promise<{
	directory: string;
	socketPath: string;
	databasePath: string;
	tokenPath: string;
	primeConfigPath: string;
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-control-mesh-"));
	temporaryDirectories.push(directory);
	return {
		directory,
		socketPath: path.join(directory, "daemon.sock"),
		databasePath: path.join(directory, "bridge.sqlite"),
		tokenPath: path.join(directory, "token"),
		primeConfigPath: path.join(directory, "prime-bridge.json"),
	};
}

function message(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
	return {
		meshMessageId: "prime-inbound-1",
		idempotencyKey: "one",
		originHarness: "prime",
		originSessionId: "prime-session",
		targetHarness: "omp",
		targetId: "omp-session",
		body: "message from Prime",
		projectRoot: "/tmp/project",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

async function postMessage(url: string, token: string, value: BridgeMessage): Promise<unknown> {
	const response = await fetch(`${url}/v1/messages`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(value),
	});
	expect(response.ok).toBe(true);
	return response.json();
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("Prime bridge control mesh", () => {
	it("delivers both directions and resumes durable sends and cursors after restart", async () => {
		const paths = await testPaths();
		const daemon = fakePrimeDaemon(paths.socketPath);
		let store: BridgeStore | undefined;
		let client: PrimeDaemonClient | undefined;
		let bridge: PrimeBridgeServer | undefined;
		try {
			const config = resolveBridgeConfig({
				stateDir: paths.directory,
				databasePath: paths.databasePath,
				tokenFile: paths.tokenPath,
				primeConfigFile: paths.primeConfigPath,
				port: 0,
			});
			store = BridgeStore.open(paths.databasePath);
			client = new PrimeDaemonClient({ store, socketPath: paths.socketPath, reconnectTimeoutMs: 5 });
			bridge = await startPrimeBridgeServer({ config, store, primeClient: client });
			let ompMessage: BridgeMessage | undefined;
			const waiterStarted = Promise.withResolvers<void>();
			const captureFetch: PrimeBridgeFetch = async (input, init) => {
				const requestUrl = String(input);
				if (requestUrl.endsWith("/v1/wait")) waiterStarted.resolve();
				if (typeof init?.body === "string" && requestUrl.endsWith("/v1/messages")) {
					ompMessage = JSON.parse(init.body) as BridgeMessage;
				}
				const headers = new Headers(init?.headers);
				headers.set("connection", "close");
				return globalThis.fetch(input, { ...init, headers });
			};
			let provider = new PrimeExternalPeerProvider({
				enabled: true,
				url: bridge.url,
				tokenPath: bridge.tokenFile,
				originSessionId: "omp-session",
				projectRoot: paths.directory,
				fetch: captureFetch,
			});

			expect(await provider.list()).toEqual([
				{
					id: "prime:prime:prime-session",
					activeSessionId: "prime:prime-session",
					displayName: "Prime session",
					status: "active",
				},
			]);
			expect(store.getCursor("prime-session")).toEqual({ generation: "prime-generation-1", sequence: 1 });

			const ompReceipt = await provider.send("prime:prime-session", "message from OMP");
			expect(ompReceipt.status).toBe("delivered");
			if (ompMessage === undefined) throw new Error("provider did not send a bridge message");
			expect(ompMessage.originHarness).toBe("omp");
			expect(ompMessage.targetHarness).toBe("prime");
			const sendCommands = (): PrimeDaemonCommandEnvelope<Record<string, unknown>>[] =>
				daemon.commands.filter(command => command.command.type === "send_message");
			expect(sendCommands()).toHaveLength(1);
			const primeCommand = sendCommands()[0];
			if (primeCommand === undefined) throw new Error("Prime send command was not recorded");
			expect(Object.hasOwn(primeCommand, "fromActiveSessionId")).toBe(false);
			expect(Object.hasOwn(primeCommand, "agentOrigin")).toBe(false);
			expect(Object.hasOwn(primeCommand.command, "fromActiveSessionId")).toBe(false);
			expect(Object.hasOwn(primeCommand.command, "agentOrigin")).toBe(false);
			const capturedOmpMessage = ompMessage;
			if (capturedOmpMessage === undefined) throw new Error("provider did not send a bridge message");
			expect(await postMessage(bridge.url, bridge.token, capturedOmpMessage)).toEqual(ompReceipt);
			expect(sendCommands()).toHaveLength(1);

			expect(await provider.inbox(true)).toEqual([]);
			const inbound = message();
			expect(await postMessage(bridge.url, bridge.token, inbound)).toEqual({
				meshMessageId: inbound.meshMessageId,
				status: "injected",
			});
			expect(await provider.inbox(true)).toEqual([inbound]);
			expect(await provider.inbox(false)).toEqual([inbound]);
			expect(await provider.inbox(false)).toEqual([]);

			const waitedFor = message({
				meshMessageId: "prime-inbound-2",
				idempotencyKey: "two",
				body: "message for wait",
			});
			const waiting = provider.wait("prime-session", 1_000);
			await waiterStarted.promise;
			expect(await postMessage(bridge.url, bridge.token, waitedFor)).toEqual({
				meshMessageId: waitedFor.meshMessageId,
				status: "injected",
			});
			const waitClaim = await waiting;
			expect(waitClaim?.message).toEqual(waitedFor);
			if (waitClaim === null) throw new Error("expected an external wait claim");
			expect(await provider.ack(waitClaim.claimToken)).toBe(true);

			const cursor = store.getCursor("prime-session");
			expect(cursor).toEqual({ generation: "prime-generation-1", sequence: 1 });
			await bridge.stop();
			bridge = undefined;
			client.close();
			client = undefined;
			store.close();
			store = undefined;

			const restartConfig = resolveBridgeConfig({
				stateDir: paths.directory,
				databasePath: paths.databasePath,
				tokenFile: paths.tokenPath,
				primeConfigFile: paths.primeConfigPath,
				port: 0,
			});
			store = BridgeStore.open(paths.databasePath);
			client = new PrimeDaemonClient({ store, socketPath: paths.socketPath, reconnectTimeoutMs: 5 });
			bridge = await startPrimeBridgeServer({ config: restartConfig, store, primeClient: client });
			expect(bridge.token).toBe(
				await Bun.file(paths.tokenPath)
					.text()
					.then(value => value.trim()),
			);
			provider = new PrimeExternalPeerProvider({
				enabled: true,
				url: bridge.url,
				tokenPath: bridge.tokenFile,
				originSessionId: "omp-session",
				projectRoot: paths.directory,
				fetch: captureFetch,
			});
			expect(await provider.list()).toEqual([
				{
					id: "prime:prime:prime-session",
					activeSessionId: "prime:prime-session",
					displayName: "Prime session",
					status: "active",
				},
			]);
			expect(await postMessage(bridge.url, bridge.token, capturedOmpMessage)).toEqual(ompReceipt);
			expect(sendCommands()).toHaveLength(1);

			await client.attach("prime-session");
			expect(
				daemon.commands.some(
					command =>
						command.command.type === "attach" &&
						JSON.stringify(command.command.resumeCursor) === JSON.stringify(cursor),
				),
			).toBe(true);
			expect(store.getCursor("prime-session")).toEqual(cursor);
		} finally {
			await bridge?.stop();
			client?.close();
			store?.close();
			daemon.stop();
		}
	});
});
