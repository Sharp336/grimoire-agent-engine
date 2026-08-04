import { describe, expect, test } from "bun:test";
import type { Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	createOmpTunnelProcessIdentity,
	type NativeBootstrapModule,
	NativeOmpBootstrapAuthority,
	type NativeOwnedBootstrapFile,
} from "../../src/mcp/bootstrap";
import { canonicalizeOmpTools, createOmpTurnBroker } from "../../src/mcp/broker";

interface FakeIdentity {
	readonly pid: number;
	readonly processStartIdentity: string;
	readonly executableIdentity: string;
	alive: boolean;
	readonly parent?: FakeIdentity;
}

class FakeFile implements NativeOwnedBootstrapFile {
	readonly identity: string;
	readonly bytes: Uint8Array;
	closed = false;
	consumed = false;
	cleaned = false;

	constructor(identity: string, bytes: Uint8Array) {
		this.identity = identity;
		this.bytes = bytes;
	}
	read() {
		if (this.closed) throw new Error("file closed");
		return this.bytes;
	}
	consume() {
		if (this.closed || this.consumed) throw new Error("file consumed");
		this.consumed = true;
	}
	cleanup() {
		this.cleaned = true;
	}
	close() {
		this.closed = true;
	}
}

class FakeConnection {
	readonly peer: FakeIdentity;
	readonly #reads: Uint8Array[] = [];
	readonly closedEvent = Promise.withResolvers<void>();
	readonly peerCheckedEvent = Promise.withResolvers<void>();
	readonly #readWaiters: Array<(bytes: Uint8Array) => void> = [];
	readonly #messages: unknown[] = [];
	readonly #messageWaiters = new Set<() => void>();
	#output = "";
	closed = false;

	constructor(peer: FakeIdentity) {
		this.peer = peer;
	}
	currentPeer() {
		if (this.closed || !this.peer.alive) throw new Error("peer closed");
		this.peerCheckedEvent.resolve();
		return this.peer;
	}
	read(): Promise<Uint8Array> {
		const bytes = this.#reads.shift();
		if (bytes) return Promise.resolve(bytes);
		if (this.closed) return Promise.resolve(new Uint8Array());
		const waiting = Promise.withResolvers<Uint8Array>();
		this.#readWaiters.push(waiting.resolve);
		return waiting.promise;
	}
	async write(bytes: Uint8Array) {
		this.currentPeer();
		this.#output += Buffer.from(bytes).toString("utf8");
		while (true) {
			const newline = this.#output.indexOf("\n");
			if (newline < 0) break;
			this.#messages.push(JSON.parse(this.#output.slice(0, newline)));
			this.#output = this.#output.slice(newline + 1);
		}
		for (const wake of this.#messageWaiters) wake();
		this.#messageWaiters.clear();
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.closedEvent.resolve();
		for (const resolve of this.#readWaiters.splice(0)) resolve(new Uint8Array());
	}
	send(value: unknown) {
		const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
		const resolve = this.#readWaiters.shift();
		if (resolve) resolve(bytes);
		else this.#reads.push(bytes);
	}
	async response(id: string): Promise<{ result?: unknown; error?: string }> {
		while (true) {
			const index = this.#messages.findIndex(message =>
				Boolean(message && typeof message === "object" && "id" in message && message.id === id),
			);
			if (index >= 0) return this.#messages.splice(index, 1)[0] as { result?: unknown; error?: string };
			const waiting = Promise.withResolvers<void>();
			this.#messageWaiters.add(waiting.resolve);
			await waiting.promise;
		}
	}
}

class FakeListener {
	readonly endpoint = { __nativeLocalEndpoint: Symbol("endpoint") };
	readonly #connections: FakeConnection[] = [];
	readonly #waiters: Array<ReturnType<typeof Promise.withResolvers<FakeConnection>>> = [];
	closed = false;
	accept(): Promise<FakeConnection> {
		const connection = this.#connections.shift();
		if (connection) return Promise.resolve(connection);
		if (this.closed) return Promise.reject(new Error("listener closed"));
		const waiting = Promise.withResolvers<FakeConnection>();
		this.#waiters.push(waiting);
		return waiting.promise;
	}
	connect(connection: FakeConnection) {
		const waiting = this.#waiters.shift();
		if (waiting) waiting.resolve(connection);
		else this.#connections.push(connection);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const waiting of this.#waiters.splice(0)) waiting.reject(new Error("listener closed"));
	}
}

const echoTool: Tool = {
	name: "echo",
	description: "echo",
	parameters: {
		type: "object",
		properties: { value: { type: "string" } },
		required: ["value"],
		additionalProperties: false,
	},
};

function toolResult(callId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "echo",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
	};
}

function nativeFixture() {
	const listener = new FakeListener();
	let createdFile: FakeFile | undefined;
	const nativeModule: NativeBootstrapModule = {
		NativeLocalListener: { create: () => listener },
		NativeOwnedFile: {
			createPrivate(_root, _nameHint, bytes) {
				createdFile = new FakeFile("private-bootstrap-identity", bytes);
				return createdFile;
			},
		},
		matchesProcessIdentity: (expected, actual) => expected === actual && (expected as FakeIdentity).alive,
		verifyPeerDescendant: (peer, ancestor) => peer === ancestor || (peer as FakeIdentity).parent === ancestor,
		connectLocal() {
			throw new Error("direct client connections are forbidden in this fixture");
		},
	};
	const runtimeRoot = new FakeFile("runtime-root", new Uint8Array());
	const authority = new NativeOmpBootstrapAuthority({ runtimeRoot, nativeModule, maxPendingProofs: 2 });
	return { authority, listener, createdFile: () => createdFile };
}

async function rpc(connection: FakeConnection, id: string, method: string, params: Record<string, unknown>) {
	connection.send({ id, method, params });
	return connection.response(id);
}

describe("native MCP bootstrap authority", () => {
	test("proves an authorized descendant and routes the closed broker protocol", async () => {
		const native = nativeFixture();
		const broker = createOmpTurnBroker({ bootstrapAuthority: native.authority, batchWindowMs: 0 });
		await broker.listen();
		const admission = await broker.gate.admit("turn");
		const canonical = canonicalizeOmpTools([echoTool]);
		const binding = {
			sessionId: "omp-session",
			turnId: "turn-1",
			runtimeEpoch: admission.runtimeEpoch,
			bindingId: "binding-1",
			expiresAt: Date.now() + 60_000,
			declaredToolSetHash: canonical.hash,
			tools: [echoTool],
		};
		const turn = await broker.issue(binding, admission);
		broker.gate.release(admission);
		const spawn = await broker.prepareTunnelSpawn();
		const parent: FakeIdentity = {
			pid: 41,
			processStartIdentity: "parent-start",
			executableIdentity: "parent-exe",
			alive: true,
		};
		const bootstrapFile = native.createdFile();
		expect(bootstrapFile).toBeDefined();
		const payload = JSON.parse(Buffer.from(bootstrapFile!.read()).toString("utf8"));
		const peer: FakeIdentity = {
			pid: 42,
			processStartIdentity: "peer-start",
			executableIdentity: "peer-exe",
			alive: true,
			parent,
		};
		const connection = new FakeConnection(peer);
		native.listener.connect(connection);
		connection.send({
			id: "proof-1",
			method: "proof",
			params: {
				runtimeEpoch: payload.runtimeEpoch,
				authenticator: payload.authenticator,
				bootstrapIdentity: bootstrapFile!.identity,
				bootstrapDigest: payload.bootstrapDigest,
			},
		});
		const pendingProof = connection.response("proof-1");
		await connection.peerCheckedEvent.promise;
		await broker.authorizeTunnel(
			spawn.connectorBootstrap,
			createOmpTunnelProcessIdentity(parent),
			spawn.tunnelAdmission,
		);
		const proof = await pendingProof;
		expect(proof.error).toBeUndefined();
		const claimed = await rpc(connection, "claim-1", "claim", { turnToken: turn.turnToken });
		const replay = new FakeConnection(peer);
		native.listener.connect(replay);
		replay.send({
			id: "proof-replay",
			method: "proof",
			params: {
				runtimeEpoch: payload.runtimeEpoch,
				authenticator: payload.authenticator,
				bootstrapIdentity: bootstrapFile!.identity,
				bootstrapDigest: payload.bootstrapDigest,
			},
		});
		await replay.closedEvent.promise;
		expect(replay.closed).toBe(true);
		expect(claimed.error).toBeUndefined();
		const tools = await rpc(connection, "tools-1", "list_tools", {});
		expect(JSON.stringify(tools.result)).toContain("echo");

		connection.send({
			id: "invoke-1",
			method: "invoke",
			params: { call: { callId: "call-1", wireName: "echo", arguments: { value: "x" } } },
		});
		const batch = await broker.nextInvocationBatch(
			turn.binding.bindingId,
			await broker.waitForConnector(turn.binding.bindingId),
		);
		expect(batch.map(call => call.callId)).toEqual(["call-1"]);
		await broker.resolveBatch(turn.binding.bindingId, await broker.waitForConnector(turn.binding.bindingId), [
			{ callId: "call-1", result: toolResult("call-1") },
		]);
		expect((await connection.response("invoke-1")).error).toBeUndefined();
		expect(
			(await rpc(connection, "release-1", "release", { bindingId: turn.binding.bindingId })).error,
		).toBeUndefined();
		expect((await rpc(connection, "close-1", "close", {})).error).toBeUndefined();
		await broker.close();
		await connection.closedEvent.promise;
	});

	test("rejects unsupported proof fields without accepting an unrelated peer", async () => {
		const native = nativeFixture();
		const broker = createOmpTurnBroker({ bootstrapAuthority: native.authority });
		await broker.listen();
		const spawn = await broker.prepareTunnelSpawn();
		const parent: FakeIdentity = {
			pid: 51,
			processStartIdentity: "parent-start",
			executableIdentity: "parent-exe",
			alive: true,
		};
		await broker.authorizeTunnel(
			spawn.connectorBootstrap,
			createOmpTunnelProcessIdentity(parent),
			spawn.tunnelAdmission,
		);
		const file = native.createdFile()!;
		const payload = JSON.parse(Buffer.from(file.read()).toString("utf8"));
		const unrelated: FakeIdentity = {
			pid: 99,
			processStartIdentity: "wrong-start",
			executableIdentity: "wrong-exe",
			alive: true,
		};
		const connection = new FakeConnection(unrelated);
		native.listener.connect(connection);
		connection.send({
			id: "bad-proof",
			method: "proof",
			params: {
				runtimeEpoch: payload.runtimeEpoch,
				authenticator: payload.authenticator,
				bootstrapIdentity: file.identity,
				bootstrapDigest: payload.bootstrapDigest,
				extra: "forbidden",
			},
		});
		await connection.closedEvent.promise;
		expect(connection.closed).toBe(true);
		await broker.close();
	});
	test("aborts an unmaterialized prepared bootstrap and cleans its owned file", async () => {
		const native = nativeFixture();
		const broker = createOmpTurnBroker({ bootstrapAuthority: native.authority });
		await broker.listen();
		const prepared = await broker.prepareTunnelSpawn();
		const file = native.createdFile();
		expect(file).toBeDefined();
		await broker.abortTunnelSpawn(prepared.connectorBootstrap, prepared.tunnelAdmission);
		expect(file!.cleaned).toBe(true);
		expect(file!.closed).toBe(true);
		await broker.abortTunnelSpawn(prepared.connectorBootstrap, prepared.tunnelAdmission);
		await broker.close();
	});
});
