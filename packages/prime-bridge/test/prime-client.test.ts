import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	PRIME_DAEMON_PROTOCOL_NAME,
	PRIME_DAEMON_PROTOCOL_VERSION,
	type PrimeDaemonCommandEnvelope,
} from "@oh-my-pi/prime-bridge-protocol";
import { CommandResultUncertainError, PrimeDaemonClient } from "../src/prime/client";
import { defaultPrimeDaemonSocketPath } from "../src/prime/socket-path";
import { BridgeStore } from "../src/store";

const tempDirectories: string[] = [];

interface FakeDaemon {
	listener: Bun.UnixSocketListener<undefined>;
	commands: PrimeDaemonCommandEnvelope<Record<string, unknown>>[];
	connections: Set<Bun.Socket<undefined>>;
	send(value: unknown): void;
	stop(): void;
}

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function hello(
	capabilities: readonly string[] = ["event_sequence"],
	protocolVersion: number = PRIME_DAEMON_PROTOCOL_VERSION,
	identity: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "daemon_hello",
		socketPath: "test",
		protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: protocolVersion },
		clientId: "daemon-client",
		serverCapabilities: capabilities,
		...identity,
	};
}

function fakeDaemon(
	socketPath: string,
	onCommand: (daemon: FakeDaemon, command: PrimeDaemonCommandEnvelope<Record<string, unknown>>) => void,
	helloDelayMs = 0,
	helloValue: Record<string, unknown> = hello(),
): FakeDaemon {
	const commands: PrimeDaemonCommandEnvelope<Record<string, unknown>>[] = [];
	const connections = new Set<Bun.Socket<undefined>>();
	const buffers = new Map<Bun.Socket<undefined>, string>();
	const daemon = {} as FakeDaemon;
	const listener = Bun.listen<undefined>({
		unix: socketPath,
		socket: {
			open(socket) {
				connections.add(socket);
				buffers.set(socket, "");
				if (helloDelayMs === 0) socket.write(line(helloValue));
				else setTimeout(() => socket.readyState === 1 && socket.write(line(helloValue)), helloDelayMs);
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
						onCommand(daemon, command);
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

async function paths(): Promise<{ directory: string; socketPath: string; databasePath: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-client-"));
	tempDirectories.push(directory);
	return {
		directory,
		socketPath: path.join(directory, "daemon.sock"),
		databasePath: path.join(directory, "bridge.sqlite"),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
	if (!predicate()) throw new Error("condition did not become true");
}

function response(
	command: PrimeDaemonCommandEnvelope<Record<string, unknown>>,
	data: unknown = { ok: true },
): Record<string, unknown> {
	return { type: "response", id: command.id, command: command.command.type, success: true, data };
}

function event(sequence: number, generation: string, value: string): Record<string, unknown> {
	return {
		type: "session_status",
		activeSessionId: "s",
		value,
		meta: {
			id: `${generation}-${sequence}`,
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
			cursor: { generation, sequence },
			sequence,
			emittedAt: new Date().toISOString(),
		},
	};
}

afterEach(async () => {
	for (const directory of tempDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("PrimeDaemonClient", () => {
	it("waits for hello before writing and intersects capabilities", async () => {
		const { socketPath, databasePath } = await paths();
		const daemon = fakeDaemon(socketPath, (server, command) => server.send(response(command)), 30);
		const store = BridgeStore.open(databasePath);
		const client = new PrimeDaemonClient({
			store,
			socketPath,
			clientCapabilities: ["attach_snapshot", "event_sequence"],
		});
		const connecting = client.connect();
		await Bun.sleep(5);
		expect(daemon.commands).toHaveLength(0);
		await connecting;
		expect(client.capabilities).toEqual(["event_sequence"]);
		await client.listSessions();
		expect(daemon.commands[0]?.clientId).toBe(store.getOrCreateClientId());
		client.close();
		store.close();
		daemon.stop();
	});
	it("accepts newer daemon protocol versions while emitting protocol 7", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(
			socketPath,
			(server, command) => server.send(response(command)),
			0,
			hello(["event_sequence"], 8, {
				schemaId: "prime-schema",
				schemaRevision: 12,
				appVersion: "8.1.0",
				supervisorGeneration: "generation-8",
			}),
		);
		const client = new PrimeDaemonClient({ store, socketPath, clientCapabilities: ["event_sequence"] });
		await client.connect();
		expect(client.daemonHello).toMatchObject({
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: 8 },
			schemaId: "prime-schema",
			schemaRevision: 12,
			appVersion: "8.1.0",
			supervisorGeneration: "generation-8",
		});
		await client.listSessions();
		expect(daemon.commands[0]?.protocol).toEqual({ name: PRIME_DAEMON_PROTOCOL_NAME, version: 7 });
		client.close();
		store.close();
		daemon.stop();
	});

	it("does not advertise unsupported headless extension UI capabilities", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "attach")
				server.send(
					response(command, {
						activeSessionId: "s",
						snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
					}),
				);
		});
		const client = new PrimeDaemonClient({
			store,
			socketPath,
			clientCapabilities: ["extension_ui", "supportsExtensionUi", "event_sequence"],
		});
		await client.attach("s");
		const attach = daemon.commands.find(command => command.command.type === "attach");
		expect(attach?.command.capabilities).toEqual(["event_sequence"]);
		expect(client.capabilities).toEqual(["event_sequence"]);
		client.close();
		store.close();
		daemon.stop();
	});
	it("negotiates capabilities before a direct first attach", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "attach") {
				server.send(
					response(command, {
						activeSessionId: "s",
						snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
					}),
				);
			}
		});
		const client = new PrimeDaemonClient({
			store,
			socketPath,
			clientCapabilities: ["attach_snapshot", "event_sequence"],
		});
		await client.attach("s");
		const attach = daemon.commands.find(command => command.command.type === "attach");
		expect(attach?.command.capabilities).toEqual(["event_sequence"]);
		client.close();
		store.close();
		daemon.stop();
	});
	it("persists and resumes an inline attach cursor across generation reset", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const first = fakeDaemon(socketPath, (server, command) =>
			server.send(
				response(command, {
					activeSessionId: "s",
					snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
					lastEventCursor: { generation: "new-generation", sequence: 3 },
				}),
			),
		);
		store.setCursor("s", { generation: "old-generation", sequence: 99 });
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5 });
		await client.attach("s");
		expect(store.getCursor("s")).toEqual({ generation: "new-generation", sequence: 3 });
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => server.send(response(command)));
		await waitFor(() => second.commands.some(command => command.command.type === "attach"));
		const resumed = second.commands.find(command => command.command.type === "attach");
		expect(resumed?.command.resumeCursor).toEqual({ generation: "new-generation", sequence: 3 });
		client.close();
		store.close();
		second.stop();
	});

	it("persists client identity and deduplicates by generation plus sequence", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			server.send(event(1, "g1", "first"));
			server.send(event(1, "g1", "duplicate"));
			server.send(event(1, "g2", "new-generation"));
			server.send(response(command));
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		const received: string[] = [];
		client.subscribe(frame => {
			received.push(String(frame.event.value));
		});
		await client.connect();
		await client.listSessions();
		await waitFor(() => received.length === 2);
		expect(received).toEqual(["first", "new-generation"]);
		expect(store.getCursor("s")).toEqual({ generation: "g2", sequence: 1 });
		const clientId = store.getOrCreateClientId();
		client.close();
		store.close();
		const reopened = BridgeStore.open(databasePath);
		expect(reopened.getOrCreateClientId()).toBe(clientId);
		reopened.close();
		daemon.stop();
	});
	it("applies an event before resolving a same-chunk response", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type !== "list") return;
			const frames = `${line(event(1, "ordered", "before"))}${line(response(command))}`;
			for (const socket of server.connections) socket.write(frames);
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		await client.listSessions();
		expect(store.getCursor("s")).toEqual({ generation: "ordered", sequence: 1 });
		client.close();
		store.close();
		daemon.stop();
	});

	it("stores interleaved cursors per active session and resumes both after reconnect", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = (activeSessionId: string) => ({
			activeSessionId,
			snapshot: { activeSessionId, summary: { messageCount: 0 }, messages: [] },
		});
		const status = (activeSessionId: string, sequence: number) => ({
			type: "event",
			id: `${activeSessionId}-${sequence}`,
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
			activeSessionId,
			cursor: { generation: activeSessionId, sequence },
			emittedAt: new Date().toISOString(),
			event: {
				type: "session_status",
				activeSessionId,
				value: "ok",
				meta: { cursor: { generation: activeSessionId, sequence }, sequence, emittedAt: new Date().toISOString() },
			},
		});
		const first = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "attach")
				server.send(response(command, attachData(String(command.command.activeSessionId))));
			else if (command.command.type === "list") {
				server.send(status("a", 1));
				server.send(status("b", 1));
				server.send(response(command));
			}
		});
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5, reconnectDeadlineMs: 250 });
		const received: string[] = [];
		client.subscribe(frame => {
			received.push(String(frame.activeSessionId));
		});
		await client.connect();
		await client.attach("a");
		await client.attach("b");
		await client.listSessions();
		await waitFor(() => received.length === 2);
		expect(store.getCursor("a")).toEqual({ generation: "a", sequence: 1 });
		expect(store.getCursor("b")).toEqual({ generation: "b", sequence: 1 });
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) =>
			server.send(response(command, attachData(String(command.command.activeSessionId)))),
		);
		await waitFor(() => second.commands.filter(command => command.command.type === "attach").length === 2);
		const resumed = second.commands
			.filter(command => command.command.type === "attach")
			.map(command => command.command.resumeCursor);
		expect(resumed).toContainEqual({ generation: "a", sequence: 1 });
		expect(resumed).toContainEqual({ generation: "b", sequence: 1 });
		client.close();
		store.close();
		second.stop();
	});

	it("rejects a top-level sequence without a generation cursor", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			server.send({
				type: "event",
				id: "bad",
				protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
				sequence: 1,
				emittedAt: new Date().toISOString(),
				event: { type: "session_status" },
			});
			server.send(response(command));
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		await client.connect();
		await expect(client.listSessions()).rejects.toBeInstanceOf(Error);
		await waitFor(() => !client.connected);
		client.close();
		store.close();
		daemon.stop();
	});

	it("does not delay responses behind a slow event subscriber", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const daemon = fakeDaemon(socketPath, (server, command) => {
			server.send({
				type: "session_status",
				activeSessionId: "s",
				meta: {
					id: "slow",
					protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
					emittedAt: new Date().toISOString(),
				},
			});
			server.send(response(command));
		});
		const client = new PrimeDaemonClient({ store, socketPath, requestTimeoutMs: 50 });
		client.subscribe(async () => gate);
		await client.connect();
		await client.listSessions();
		release();
		client.close();
		store.close();
		daemon.stop();
	});

	it("assembles complete snapshots and rejects incomplete snapshots", async () => {
		const first = await paths();
		const store = BridgeStore.open(first.databasePath);
		const daemon = fakeDaemon(first.socketPath, (server, command) => {
			if (command.command.type !== "attach") return;
			server.send(
				response(command, {
					activeSessionId: "s",
					snapshot: { activeSessionId: "s", summary: { messageCount: 2 }, messages: [] },
				}),
			);
			server.send({
				type: "session_snapshot_begin",
				activeSessionId: "s",
				snapshotId: "snap",
				snapshot: { activeSessionId: "s", summary: { messageCount: 2 }, lastEventSequence: 2 },
				messageCount: 2,
				targetChunkBytes: 1,
			});
			server.send({
				type: "session_snapshot_chunk",
				activeSessionId: "s",
				snapshotId: "snap",
				index: 0,
				messages: [{ role: "user", content: "a" }],
			});
			server.send({
				type: "session_snapshot_chunk",
				activeSessionId: "s",
				snapshotId: "snap",
				index: 1,
				messages: [{ role: "assistant", content: "b" }],
			});
			server.send({
				type: "session_snapshot_end",
				activeSessionId: "s",
				snapshotId: "snap",
				chunkCount: 2,
				lastEventSequence: 2,
			});
		});
		const client = new PrimeDaemonClient({ store, socketPath: first.socketPath, requestTimeoutMs: 200 });
		await client.connect();
		const result = await client.attach("s");
		expect((result.snapshot as Record<string, unknown>).messages).toEqual([
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
		]);
		client.close();
		store.close();
		daemon.stop();

		const incomplete = await paths();
		const incompleteStore = BridgeStore.open(incomplete.databasePath);
		const incompleteDaemon = fakeDaemon(incomplete.socketPath, (server, command) => {
			if (command.command.type !== "attach") return;
			server.send(
				response(command, {
					activeSessionId: "s",
					snapshot: { activeSessionId: "s", summary: { messageCount: 1 }, messages: [] },
				}),
			);
			server.send({
				type: "session_snapshot_begin",
				activeSessionId: "s",
				snapshotId: "snap",
				snapshot: { activeSessionId: "s", lastEventSequence: 1 },
				messageCount: 1,
				targetChunkBytes: 1,
			});
		});
		const incompleteClient = new PrimeDaemonClient({
			store: incompleteStore,
			socketPath: incomplete.socketPath,
			requestTimeoutMs: 25,
		});
		await incompleteClient.connect();
		await expect(incompleteClient.attach("s")).rejects.toThrow("timed out");
		incompleteClient.close();
		incompleteStore.close();

		incompleteDaemon.stop();
	});
	it("reattaches active sessions with the durable cursor after transport recovery", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = {
			activeSessionId: "s",
			snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
		};
		const first = fakeDaemon(socketPath, (server, command) => server.send(response(command, attachData)));
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5, reconnectDeadlineMs: 250 });
		await client.connect();
		await client.attach("s");
		store.setCursor("s", { generation: "g", sequence: 4 });
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => server.send(response(command, attachData)));
		await waitFor(() => second.commands.some(command => command.command.type === "attach"));
		const recovered = second.commands.find(command => command.command.type === "attach");
		expect(recovered?.command).toHaveProperty("resumeCursor", { generation: "g", sequence: 4 });
		await client.listSessions();
		expect(second.commands.some(command => command.command.type === "list")).toBe(true);
		client.close();
		store.close();
		second.stop();
	});
	it("isolates application reattach failure without losing later sessions or transport", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = (activeSessionId: string) => ({
			activeSessionId,
			snapshot: { activeSessionId, summary: { messageCount: 0 }, messages: [] },
		});
		const first = fakeDaemon(socketPath, (server, command) =>
			server.send(response(command, attachData(String(command.command.activeSessionId)))),
		);
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5, reconnectDeadlineMs: 250 });
		await client.attach("a");
		await client.attach("b");
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "attach" && command.command.activeSessionId === "a") {
				server.send({
					type: "response",
					id: command.id,
					command: command.command.type,
					success: false,
					error: "session unavailable",
				});
			} else if (command.command.type === "attach") {
				server.send(response(command, attachData(String(command.command.activeSessionId))));
			} else if (command.command.type === "list") {
				server.send(response(command, { sessions: [] }));
			}
		});
		await waitFor(() =>
			second.commands.some(command => command.command.type === "attach" && command.command.activeSessionId === "b"),
		);
		await client.listSessions();
		expect(second.commands.some(command => command.command.type === "list")).toBe(true);
		client.close();
		store.close();
		second.stop();
	});
	it("bounds recovery when an accepted socket delays hello beyond the deadline", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = {
			activeSessionId: "s",
			snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
		};
		const first = fakeDaemon(socketPath, (server, command) => server.send(response(command, attachData)));
		const client = new PrimeDaemonClient({
			store,
			socketPath,
			reconnectTimeoutMs: 5,
			reconnectDeadlineMs: 40,
			requestTimeoutMs: 10_000,
		});
		await client.connect();
		await client.attach("s");
		first.stop();
		const delayed = fakeDaemon(socketPath, (server, command) => server.send(response(command, attachData)), 100);
		await waitFor(() => delayed.connections.size === 1);
		await waitFor(() => delayed.connections.size === 0);
		expect(delayed.commands).toHaveLength(0);
		client.close();
		store.close();
		delayed.stop();
	});
	it("bounds recovery through a delayed reattach snapshot", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = {
			activeSessionId: "s",
			snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
		};
		const first = fakeDaemon(socketPath, (server, command) => server.send(response(command, attachData)));
		const client = new PrimeDaemonClient({
			store,
			socketPath,
			reconnectTimeoutMs: 5,
			reconnectDeadlineMs: 40,
			requestTimeoutMs: 10_000,
		});
		await client.connect();
		await client.attach("s");
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type !== "attach") return;
			server.send(response(command, { activeSessionId: "s", snapshotStream: { id: "snap" } }));
			server.send({
				type: "session_snapshot_begin",
				activeSessionId: "s",
				snapshotId: "snap",
				snapshot: { activeSessionId: "s", summary: { messageCount: 1 } },
				messageCount: 1,
				targetChunkBytes: 1,
			});
		});
		await waitFor(() => second.commands.some(command => command.command.type === "attach"));
		await waitFor(() => second.connections.size === 0);
		expect(second.commands.filter(command => command.command.type === "attach")).toHaveLength(1);
		client.close();
		store.close();
		second.stop();
	});

	it("sends bridge-originated messages without Prime family identity fields", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => server.send(response(command)));
		const client = new PrimeDaemonClient({ store, socketPath });
		await client.connect();
		await client.sendMessage("target", "hello", undefined, "bridge-retry-key");
		const sent = daemon.commands.find(command => command.command.type === "send_message");
		expect(sent?.id).toBe("bridge:bridge-retry-key");
		expect(sent?.command).not.toHaveProperty("fromActiveSessionId");
		expect(sent?.command).not.toHaveProperty("agentOrigin");
		expect(sent?.command).not.toHaveProperty("bridgeMessageId");
		await expect(client.sendMessage("target", "hello", undefined, "")).rejects.toThrow("must not be empty");
		client.close();
		store.close();

		daemon.stop();
	});
	it("returns a cached bridge response without resending after restart", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const commandId = "bridge:cached-message";
		const envelope = JSON.stringify({
			type: "command",
			id: commandId,
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
			clientId: store.getOrCreateClientId(),
			command: { type: "send_message", targetActiveSessionId: "target", message: "hello" },
		});
		store.persistCommand(commandId, envelope);
		store.recordCommandResponse(
			commandId,
			JSON.stringify({
				type: "response",
				id: commandId,
				command: "send_message",
				success: true,
				data: { delivered: true },
			}),
		);
		const daemon = fakeDaemon(socketPath, () => {});
		const client = new PrimeDaemonClient({ store, socketPath });
		await expect(client.sendMessage("target", "hello", undefined, "cached-message")).resolves.toEqual({
			delivered: true,
		});
		expect(daemon.commands).toHaveLength(0);
		client.close();
		store.close();
		daemon.stop();
	});
	it("joins a replayed bridge command after a disconnected retry", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const commandId = "bridge:retry-message";
		const envelope = JSON.stringify({
			type: "command",
			id: commandId,
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
			clientId: store.getOrCreateClientId(),
			command: { type: "send_message", targetActiveSessionId: "target", message: "hello" },
		});
		store.persistCommand(commandId, envelope);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "send_message") server.send(response(command, { delivered: true }));
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		const first = client.sendMessage("target", "hello", undefined, "retry-message");
		const second = client.sendMessage("target", "hello", undefined, "retry-message");
		await expect(Promise.all([first, second])).resolves.toEqual([{ delivered: true }, { delivered: true }]);
		expect(daemon.commands.filter(command => command.command.type === "send_message")).toHaveLength(1);
		client.close();
		store.close();
		daemon.stop();
	});
	it("replays a bridge response ACK only after a durable receipt", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const commandId = "bridge:receipt-message";
		const envelope = JSON.stringify({
			type: "command",
			id: commandId,
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
			clientId: store.getOrCreateClientId(),
			command: { type: "send_message", targetActiveSessionId: "target", message: "hello" },
		});
		store.persistCommand(commandId, envelope);
		store.recordCommandResponse(
			commandId,
			JSON.stringify({
				type: "response",
				id: commandId,
				command: "send_message",
				success: true,
				data: { delivered: true },
			}),
		);
		store.putInbox({
			meshMessageId: "receipt-message",
			idempotencyKey: "receipt-key",
			originHarness: "omp",
			originSessionId: "origin",
			targetHarness: "prime",
			targetId: "target",
			body: "hello",
			projectRoot: "/tmp",
			createdAt: new Date().toISOString(),
		});
		const daemon = fakeDaemon(socketPath, () => {});
		const client = new PrimeDaemonClient({ store, socketPath });
		await expect(client.acknowledgeBridgeMessage("receipt-message")).rejects.toThrow("receipt");
		await client.connect();
		expect(daemon.commands.filter(command => command.command.type === "ack_result")).toHaveLength(0);
		client.close();
		store.recordReceipt({ meshMessageId: "receipt-message", status: "delivered" });
		const recovered = new PrimeDaemonClient({ store, socketPath });
		await recovered.connect();
		await waitFor(() => daemon.commands.some(command => command.command.type === "ack_result"));
		expect(store.listPendingCommands()).toHaveLength(0);
		recovered.close();
		store.close();
		daemon.stop();
	});

	it("preserves an emoji when its UTF-8 bytes split across socket writes", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type !== "list") return;
			const frame = Buffer.from(
				line({
					type: "event",
					id: "emoji",
					protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
					cursor: { generation: "emoji", sequence: 1 },
					emittedAt: new Date().toISOString(),
					event: {
						type: "session_status",
						activeSessionId: "s",
						value: "😀",
						meta: {
							cursor: { generation: "emoji", sequence: 1 },
							sequence: 1,
							emittedAt: new Date().toISOString(),
						},
					},
				}),
			);
			const split = frame.indexOf(Buffer.from("😀")) + 1;
			for (const socket of server.connections) {
				socket.write(frame.subarray(0, split));
				socket.write(frame.subarray(split));
			}
			server.send(response(command));
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		const received: string[] = [];
		client.subscribe(event => {
			received.push(String(event.event.value));
		});
		await client.connect();
		await client.listSessions();
		expect(received).toEqual(["😀"]);
		client.close();
		store.close();
		daemon.stop();
	});
	it("terminates on a positive short UTF-8 write and retains the mutation journal", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => server.send(response(command)));
		const bun = Bun as unknown as {
			connect: (options: Bun.UnixSocketOptions<undefined>) => Promise<Bun.Socket<undefined>>;
		};
		const originalConnect = bun.connect;
		bun.connect = options =>
			originalConnect({
				...options,
				socket: {
					...options.socket,
					open(socket) {
						const originalWrite = socket.write.bind(socket);
						socket.write = (data, byteOffset, byteLength) => {
							if (typeof data === "string" && data.includes("😀"))
								return Math.max(1, Buffer.byteLength(data) - 1);
							return originalWrite(data, byteOffset, byteLength);
						};
						options.socket.open?.(socket);
					},
				},
			});
		const client = new PrimeDaemonClient({ store, socketPath, requestTimeoutMs: 100 });
		try {
			await client.connect();
			const prompt = client.prompt("s", "😀");
			await expect(prompt).rejects.toBeInstanceOf(CommandResultUncertainError);
			expect(store.listPendingCommands()).toHaveLength(1);
			expect(client.connected).toBe(false);
		} finally {
			client.close();
			bun.connect = originalConnect;
			store.close();
			daemon.stop();
		}
	});

	it("does not reattach a session after a successful detach", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = {
			activeSessionId: "s",
			snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
		};
		const first = fakeDaemon(socketPath, (server, command) =>
			server.send(response(command, command.command.type === "attach" ? attachData : { ok: true })),
		);
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5, reconnectDeadlineMs: 100 });
		await client.connect();
		await client.attach("s");
		await client.detach("s");
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => server.send(response(command)));
		await Bun.sleep(40);
		expect(second.commands.filter(command => command.command.type === "attach")).toHaveLength(0);
		client.close();
		store.close();
		second.stop();
	});
	it("does not reattach after detach result when its ACK transport fails", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = {
			activeSessionId: "s",
			snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
		};
		const first = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "attach") server.send(response(command, attachData));
			if (command.command.type === "detach") {
				server.send(response(command));
				for (const socket of server.connections) socket.terminate();
			}
		});
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5, reconnectDeadlineMs: 250 });
		await client.connect();
		await client.attach("s");
		await client.detach("s").catch(() => undefined);
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "ack_result") server.send(response(command));
			if (command.command.type === "attach") server.send(response(command, attachData));
		});
		await Bun.sleep(40);
		expect(second.commands.filter(command => command.command.type === "attach")).toHaveLength(0);
		client.close();
		store.close();
		second.stop();
	});

	it("completes mutation journal after fire-and-forget ACK without ACK response", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "detach") server.send(response(command));
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		await client.detach("s");
		await waitFor(() => daemon.commands.some(command => command.command.type === "ack_result"));
		await waitFor(() => store.listPendingCommands().length === 0);
		client.close();
		store.close();
		daemon.stop();
	});
	it("does not replay a mutation after an initial write failure", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const originalPersist = store.persistCommand.bind(store);
		let client!: PrimeDaemonClient;
		store.persistCommand = (...args) => {
			const result = originalPersist(...args);
			client.close();
			return result;
		};
		const initial = fakeDaemon(socketPath, (server, command) => server.send(response(command)));
		client = new PrimeDaemonClient({ store, socketPath });
		await client.connect();
		await expect(client.detach("s")).rejects.toBeInstanceOf(CommandResultUncertainError);
		const pending = store.listPendingCommands();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.responseJson).not.toBeNull();
		initial.stop();
		store.persistCommand = originalPersist;
		const seen: PrimeDaemonCommandEnvelope<Record<string, unknown>>[] = [];
		const daemon = fakeDaemon(socketPath, (_server, command) => {
			seen.push(command);
		});
		const recovered = new PrimeDaemonClient({ store, socketPath });
		await recovered.connect();
		await waitFor(() => seen.some(command => command.command.type === "ack_result"));
		expect(seen.some(command => command.id === pending[0]?.commandId)).toBe(false);
		recovered.close();
		store.close();
		daemon.stop();
	});

	it("does not replay a transport-uncertain mutation after disconnect", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const first = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "detach") for (const socket of server.connections) socket.terminate();
		});
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 25, reconnectDeadlineMs: 250 });
		await client.connect();
		await expect(client.detach("s")).rejects.toBeInstanceOf(CommandResultUncertainError);
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "ack_result") server.send(response(command));
		});
		await waitFor(() => second.commands.some(command => command.command.type === "ack_result"));
		expect(second.commands.filter(command => command.command.type === "detach")).toHaveLength(0);
		await waitFor(() => store.listPendingCommands().length === 0);
		client.close();
		store.close();
		second.stop();
	});

	it("defers a bridge uncertainty ACK until its failed receipt is durable", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const first = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "send_message") for (const socket of server.connections) socket.terminate();
		});
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 25, reconnectDeadlineMs: 250 });
		await client.connect();
		await expect(client.sendMessage("prime-session", "hello", undefined, "mesh-uncertain")).rejects.toBeInstanceOf(
			CommandResultUncertainError,
		);
		first.stop();
		const second = fakeDaemon(socketPath, () => {});
		await client.connect();
		await Bun.sleep(30);
		expect(second.commands.filter(command => command.command.type === "send_message")).toHaveLength(0);
		expect(second.commands.filter(command => command.command.type === "ack_result")).toHaveLength(0);

		store.enqueueMessage({
			meshMessageId: "mesh-uncertain",
			idempotencyKey: "idem-uncertain",
			originHarness: "omp",
			originSessionId: "omp-session",
			targetHarness: "prime",
			targetId: "prime-session",
			body: "hello",
			projectRoot: "/repo",
			createdAt: new Date().toISOString(),
		});
		const [claim] = store.claimPendingMessages();
		if (claim === undefined) throw new Error("expected pending bridge message");
		expect(store.recordReceipt({ meshMessageId: "mesh-uncertain", status: "failed" }, claim.claimToken)).toBe(true);
		await client.acknowledgeBridgeMessage("mesh-uncertain");
		await waitFor(() => second.commands.some(command => command.command.type === "ack_result"));
		expect(second.commands.filter(command => command.command.type === "ack_result")).toHaveLength(1);
		expect(store.listPendingCommands()).toHaveLength(0);
		client.close();
		store.close();
		second.stop();
	});

	it("does not replay a timed-out mutation after reconnect", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const first = fakeDaemon(socketPath, () => {});
		const client = new PrimeDaemonClient({
			store,
			socketPath,
			requestTimeoutMs: 15,
			reconnectTimeoutMs: 25,
			reconnectDeadlineMs: 250,
		});
		await client.connect();
		await expect(client.detach("s")).rejects.toBeInstanceOf(CommandResultUncertainError);
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "ack_result") server.send(response(command));
		});
		await waitFor(() => second.commands.some(command => command.command.type === "ack_result"));
		expect(second.commands.filter(command => command.command.type === "detach")).toHaveLength(0);
		await waitFor(() => store.listPendingCommands().length === 0);
		client.close();
		store.close();
		second.stop();
	});

	it("recovers a persisted result by sending only its ACK", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const commandId = "result-before-ack";
		const envelope = JSON.stringify({
			type: "command",
			id: commandId,
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
			clientId: store.getOrCreateClientId(),
			command: { type: "detach", activeSessionId: "s" },
		});
		store.persistCommand(commandId, envelope);
		store.recordCommandResponse(
			commandId,
			JSON.stringify({ type: "response", id: commandId, command: "detach", success: true, data: { ok: true } }),
		);
		const daemon = fakeDaemon(socketPath, () => {});
		const client = new PrimeDaemonClient({ store, socketPath });
		await client.connect();
		await waitFor(() => daemon.commands.some(command => command.command.type === "ack_result"));
		expect(daemon.commands.filter(command => command.command.type === "detach")).toHaveLength(0);
		await waitFor(() => store.listPendingCommands().length === 0);
		client.close();
		store.close();
		daemon.stop();
	});

	it("replays the exact journal envelope after restart", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		store.setCursor("s", { generation: "g", sequence: 4 });
		const commandId = "replay-command";
		const envelope = JSON.stringify({
			type: "command",
			id: commandId,
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
			clientId: store.getOrCreateClientId(),
			command: { type: "detach", activeSessionId: "s" },
		});
		store.persistCommand(commandId, envelope);
		const seen: string[] = [];
		const daemon = fakeDaemon(socketPath, (server, command) => {
			seen.push(JSON.stringify(command));
			server.send({
				type: "response",
				id: command.id,
				command: command.command.type,
				success: true,
				data: { ok: true },
			});
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		await client.connect();
		await waitFor(() => seen.some(value => JSON.parse(value).id === commandId));
		expect(seen.find(value => JSON.parse(value).id === commandId)).toBe(envelope);
		await waitFor(() => daemon.commands.some(command => command.command.type === "ack_result"));
		expect(JSON.parse(seen.at(-1) as string).command.type).toBe("ack_result");
		client.close();
		store.close();
		daemon.stop();
	});

	it("records mutation response before ack and reports uncertainty without a new id", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const order: string[] = [];
		const persist = store.persistCommand.bind(store);
		const record = store.recordCommandResponse.bind(store);
		const complete = store.completeCommand.bind(store);
		store.persistCommand = (...args) => {
			order.push("persist");
			return persist(...args);
		};
		store.recordCommandResponse = (...args) => {
			order.push("record");
			return record(...args);
		};
		store.completeCommand = (...args) => {
			order.push("complete");
			return complete(...args);
		};
		let uncertain = true;
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "ack_result") {
				order.push("ack");
				server.send(response(command));
			}
			if (command.command.type === "detach") {
				server.send({
					type: "response",
					id: command.id,
					command: "detach",
					success: false,
					error: "uncertain",
					errorInfo: uncertain ? { code: "command_result_uncertain" } : { code: "other" },
				});
			}
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		await expect(client.detach("s")).rejects.toBeInstanceOf(CommandResultUncertainError);
		await waitFor(() => order.includes("ack"));
		await waitFor(() => order.includes("complete"));
		expect(order.indexOf("persist")).toBeLessThan(order.indexOf("record"));
		expect(order.indexOf("record")).toBeLessThan(order.indexOf("complete"));
		expect(order.indexOf("ack")).toBeGreaterThan(order.indexOf("record"));
		expect(
			new Set(daemon.commands.filter(command => command.command.type === "detach").map(command => command.id)).size,
		).toBe(1);
		uncertain = false;
		client.close();
		store.close();
		daemon.stop();
	});
	it("keeps a recorded result for ACK-only recovery when local completion fails", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const originalComplete = store.completeCommand.bind(store);
		let completeCalls = 0;
		store.completeCommand = (...args) => {
			completeCalls += 1;
			if (completeCalls === 1) throw new Error("simulated local delete failure");
			return originalComplete(...args);
		};
		const first = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "detach") server.send(response(command));
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		const operation = client.detach("s").catch(() => undefined);
		await waitFor(() => store.listPendingCommands().some(record => record.responseJson !== null));
		first.send({
			type: "response",
			id: first.commands.find(command => command.command.type === "detach")?.id,
			command: "detach",
			success: true,
			data: { ok: true },
		});
		await Bun.sleep(5);
		client.close();
		await operation;
		first.stop();
		store.completeCommand = originalComplete;
		const second = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "ack_result") server.send(response(command));
		});
		const recovered = new PrimeDaemonClient({ store, socketPath });
		await recovered.connect();
		await waitFor(() => second.commands.some(command => command.command.type === "ack_result"));
		expect(second.commands.filter(command => command.command.type === "detach")).toHaveLength(0);
		await waitFor(() => store.listPendingCommands().length === 0);
		recovered.close();
		store.close();
		second.stop();
	});
	it("suppresses reattach for persisted detach journals in missing and recorded response branches", async () => {
		const run = async (recordResponse: boolean): Promise<void> => {
			const { socketPath, databasePath } = await paths();
			const store = BridgeStore.open(databasePath);
			const attachData = {
				activeSessionId: "s",
				snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
			};
			const first = fakeDaemon(socketPath, (server, command) => server.send(response(command, attachData)));
			const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5, reconnectDeadlineMs: 150 });
			await client.connect();
			await client.attach("s");
			const id = `journal-detach-${recordResponse}`;
			const envelope = JSON.stringify({
				type: "command",
				id,
				protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
				clientId: store.getOrCreateClientId(),
				command: { type: "detach", activeSessionId: "s" },
			});
			store.persistCommand(id, envelope);
			if (recordResponse)
				store.recordCommandResponse(
					id,
					JSON.stringify({ type: "response", id, command: "detach", success: true, data: { ok: true } }),
				);
			first.stop();
			const second = fakeDaemon(socketPath, (server, command) => {
				if (command.command.type === "ack_result") server.send(response(command));
				else if (command.command.type === "detach") server.send(response(command));
			});
			await waitFor(() =>
				second.commands.some(command => command.command.type === "ack_result" || command.command.type === "detach"),
			);
			expect(second.commands.filter(command => command.command.type === "attach")).toHaveLength(0);
			client.close();
			store.close();
			second.stop();
		};
		await run(false);
		await run(true);
	});
	it("does not reattach an externally closed session but preserves update closures", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = {
			activeSessionId: "s",
			snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
		};
		const first = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "attach") server.send(response(command, attachData));
			else if (command.command.type === "list") {
				server.send({
					type: "event",
					id: "closed",
					protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
					emittedAt: new Date().toISOString(),
					event: { type: "session_closed", activeSessionId: "s", reason: "killed" },
				});
				server.send(response(command));
			}
		});
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5, reconnectDeadlineMs: 100 });
		await client.connect();
		await client.attach("s");
		await client.listSessions();
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => server.send(response(command, attachData)));
		await Bun.sleep(35);
		expect(second.commands.filter(command => command.command.type === "attach")).toHaveLength(0);
		client.close();
		store.close();
		second.stop();
	});
	it("reattaches an updated session but not a terminally closed session", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const attachData = {
			activeSessionId: "s",
			snapshot: { activeSessionId: "s", summary: { messageCount: 0 }, messages: [] },
		};
		const first = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "attach") server.send(response(command, attachData));
			else if (command.command.type === "list") {
				server.send({
					type: "event",
					id: "update",
					protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
					emittedAt: new Date().toISOString(),
					event: { type: "session_closed", activeSessionId: "s", reason: "update" },
				});
				server.send(response(command));
			}
		});
		const client = new PrimeDaemonClient({ store, socketPath, reconnectTimeoutMs: 5, reconnectDeadlineMs: 100 });
		await client.connect();
		await client.attach("s");
		await client.listSessions();
		first.stop();
		const second = fakeDaemon(socketPath, (server, command) => server.send(response(command, attachData)));
		await waitFor(() => second.commands.some(command => command.command.type === "attach"));
		expect(second.commands.some(command => command.command.type === "attach")).toBe(true);
		client.close();
		store.close();
		second.stop();
	});
	it("delivers an event to later listeners after an earlier listener rejects", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "list") {
				server.send({
					type: "session_status",
					activeSessionId: "s",
					meta: {
						id: "listener",
						protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
						emittedAt: new Date().toISOString(),
					},
				});
				server.send(response(command));
			}
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		const received: string[] = [];
		client.subscribe(() => {
			throw new Error("first listener failed");
		});
		client.subscribe(event => {
			received.push(String(event.event.type));
		});
		await client.connect();
		await client.listSessions();
		await waitFor(() => received.length === 1);
		expect(received).toEqual(["session_status"]);
		client.close();
		store.close();
		daemon.stop();
	});

	it("does not let a rejecting listener block snapshot cursor or mutation ACK", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type === "attach") {
				server.send(response(command, { activeSessionId: "s", snapshotStream: { id: "snap" } }));
				server.send({
					type: "session_snapshot_begin",
					activeSessionId: "s",
					snapshotId: "snap",
					snapshot: { activeSessionId: "s", summary: { messageCount: 1 } },
					messageCount: 1,
					targetChunkBytes: 1,
				});
				server.send({
					type: "session_snapshot_chunk",
					activeSessionId: "s",
					snapshotId: "snap",
					index: 0,
					messages: [{ content: "x" }],
				});
				server.send({
					type: "session_snapshot_end",
					activeSessionId: "s",
					snapshotId: "snap",
					chunkCount: 1,
					lastEventSequence: 1,
					lastEventCursor: { generation: "s", sequence: 1 },
				});
			} else if (command.command.type === "prompt") server.send(response(command));
			else if (command.command.type === "ack_result") server.send(response(command));
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		client.subscribe(async () => {
			await gate;
			throw new Error("listener failed");
		});
		const attached = client.attach("s");
		await waitFor(() => store.getCursor("s")?.sequence === 1);
		await attached;
		await client.prompt("s", "hello");
		release();
		client.close();
		store.close();
		daemon.stop();
	});
	it("isolates concurrent snapshot timeout for A from B assembly", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const daemon = fakeDaemon(socketPath, (server, command) => {
			const session = String(command.command.activeSessionId);
			if (command.command.type !== "attach") return;
			server.send(response(command, { activeSessionId: session, snapshotStream: { id: session } }));
			server.send({
				type: "session_snapshot_begin",
				activeSessionId: session,
				snapshotId: session,
				snapshot: { activeSessionId: session, summary: { messageCount: 1 } },
				messageCount: 1,
				targetChunkBytes: 1,
			});
			if (session === "b") {
				server.send({
					type: "session_snapshot_chunk",
					activeSessionId: session,
					snapshotId: session,
					index: 0,
					messages: [{ content: "b" }],
				});
				server.send({
					type: "session_snapshot_end",
					activeSessionId: session,
					snapshotId: session,
					chunkCount: 1,
					lastEventSequence: 1,
				});
			}
		});
		const client = new PrimeDaemonClient({ store, socketPath, requestTimeoutMs: 25 });
		const a = client.attach("a");
		const b = client.attach("b");
		await expect(a).rejects.toThrow("timed out");
		await expect(b).resolves.toMatchObject({ activeSessionId: "b" });
		client.close();
		store.close();
		daemon.stop();
	});
	it("clears ignored snapshot terminal state for a later same-session retry", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		let attempts = 0;
		const daemon = fakeDaemon(socketPath, (server, command) => {
			if (command.command.type !== "attach") return;
			attempts += 1;
			server.send(response(command, { activeSessionId: "s", snapshotStream: { id: "snap" } }));
			server.send({
				type: "session_snapshot_begin",
				activeSessionId: "s",
				snapshotId: "snap",
				snapshot: { activeSessionId: "s", summary: { messageCount: 1 } },
				messageCount: 1,
				targetChunkBytes: 1,
			});
			if (attempts === 1)
				server.send({ type: "session_snapshot_failed", activeSessionId: "s", snapshotId: "snap", error: "retry" });
			else {
				server.send({
					type: "session_snapshot_chunk",
					activeSessionId: "s",
					snapshotId: "snap",
					index: 0,
					messages: [{ content: "ok" }],
				});
				server.send({
					type: "session_snapshot_end",
					activeSessionId: "s",
					snapshotId: "snap",
					chunkCount: 1,
					lastEventSequence: 1,
				});
			}
		});
		const client = new PrimeDaemonClient({ store, socketPath });
		await expect(client.attach("s")).rejects.toThrow("retry");
		await expect(client.attach("s")).resolves.toMatchObject({ activeSessionId: "s" });
		client.close();
		store.close();
		daemon.stop();
	});
	it("close before connect rejects and leaves cursor storage untouched", async () => {
		const { socketPath, databasePath } = await paths();
		const store = BridgeStore.open(databasePath);
		const client = new PrimeDaemonClient({ store, socketPath, requestTimeoutMs: 25 });
		const pending = client.listSessions().catch(error => error);
		client.close();
		const error = await pending;
		expect(error).toBeInstanceOf(Error);
		await Bun.sleep(10);
		expect(store.getCursor("s")).toBeNull();
	});
});

describe("defaultPrimeDaemonSocketPath", () => {
	it("uses an explicit path and Prime's non-Windows default shape", () => {
		expect(defaultPrimeDaemonSocketPath("/tmp/custom.sock")).toBe("/tmp/custom.sock");
		expect(defaultPrimeDaemonSocketPath()).toMatch(/prime-agent-[^/]+[\\/]daemon\.sock$/);
	});
});
