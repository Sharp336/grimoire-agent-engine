import { describe, expect, test } from "bun:test";
import type { Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type {
	OmpBootstrapAuthority,
	OmpBrokerEndpoint,
	OmpConnectorBootstrap,
	OmpTunnelBootstrap,
	OmpTunnelProcessIdentity,
} from "../../src/mcp/bootstrap";
import {
	canonicalizeOmpTools,
	createOmpTurnBroker,
	type OmpMcpConnector,
	OmpRuntimeGate,
	type OmpTurnBinding,
	type OmpTurnBrokerImpl,
} from "../../src/mcp/broker";

interface FakeConnection {
	live: boolean;
	peerValid: boolean;
}

interface BootstrapState {
	authorized: boolean;
	attached: boolean;
	connection: FakeConnection;
}

class FakeBootstrapAuthority implements OmpBootstrapAuthority {
	readonly states = new WeakMap<OmpConnectorBootstrap, BootstrapState>();
	readonly validProcesses = new WeakSet<object>();
	readonly aborted = new WeakSet<OmpConnectorBootstrap>();
	closed = false;
	lastConnection?: FakeConnection;
	failAttach = false;
	failCurrentPeer = false;
	closeCount = 0;
	abortPreparedCount = 0;
	failAbortPreparedCount = 0;
	failAuthorize = false;
	failCloseCount = 0;

	async listen(_runtimeEpoch: string): Promise<OmpBrokerEndpoint> {
		return { kind: "owner-local" } as OmpBrokerEndpoint;
	}

	async prepare(_runtimeEpoch: string) {
		const connectorBootstrap = {} as OmpConnectorBootstrap;
		const tunnelBootstrap = { kind: "private-owned-bootstrap-file" } as OmpTunnelBootstrap;
		const connection = { live: true, peerValid: true };
		this.lastConnection = connection;
		this.states.set(connectorBootstrap, {
			authorized: false,
			attached: false,
			connection,
		});
		return { connectorBootstrap, tunnelBootstrap };
	}
	async abortPrepared(bootstrap: OmpConnectorBootstrap) {
		if (this.aborted.has(bootstrap)) return;
		if (!this.states.has(bootstrap)) throw new Error("native bootstrap rejected");
		if (this.failAbortPreparedCount > 0) {
			this.failAbortPreparedCount -= 1;
			throw new Error("native bootstrap abort failed");
		}
		this.aborted.add(bootstrap);
		this.abortPreparedCount += 1;
	}

	process(): OmpTunnelProcessIdentity {
		const process = {
			pid: 42,
			processStartIdentity: "start-42",
			executableIdentity: "exe-42",
		} as OmpTunnelProcessIdentity;
		this.validProcesses.add(process);
		return process;
	}

	async authorize(bootstrap: OmpConnectorBootstrap, process: OmpTunnelProcessIdentity, _runtimeEpoch: string) {
		if (this.failAuthorize) throw new Error("native authorization failed");
		const state = this.states.get(bootstrap);
		if (!state || !this.validProcesses.has(process) || state.authorized)
			throw new Error("native authorization rejected");
		state.authorized = true;
	}

	async attach(bootstrap: OmpConnectorBootstrap, _runtimeEpoch: string) {
		if (this.failAttach) throw new Error("native attach failed");
		const state = this.states.get(bootstrap);
		if (!state || state.attached) throw new Error("native bootstrap rejected");
		state.attached = true;
		return {
			connection: state.connection,
			connectorId: "connector-1",
			sessionId: "native-session-1",
			sessionNonce: "nonce-1",
		};
	}

	async currentPeer(connection: object, _runtimeEpoch: string) {
		if (this.failCurrentPeer) throw new Error("native peer validation failed");
		const peer = connection as FakeConnection;
		if (!peer.live || !peer.peerValid) throw new Error("native peer changed");
	}

	async closeConnection(connection: object) {
		this.closeCount += 1;
		if (this.failCloseCount > 0) {
			this.failCloseCount -= 1;
			throw new Error("native connection close failed");
		}
		(connection as FakeConnection).live = false;
	}

	async close() {
		this.closed = true;
	}
}

class FailOnceReleaseGate extends OmpRuntimeGate {
	releaseAttempts = 0;

	override release(handle: Parameters<OmpRuntimeGate["release"]>[0]): void {
		this.releaseAttempts += 1;
		if (this.releaseAttempts === 1) throw new Error("runtime gate release failed");
		super.release(handle);
	}
}

const echoTool: Tool = {
	name: "echo",
	description: "Echo a value",
	parameters: {
		type: "object",
		properties: { value: { type: "string" } },
		required: ["value"],
		additionalProperties: false,
	},
};

function toolResult(callId: string, name = "echo"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

async function fixture(options: { maxBindings?: number } = {}) {
	const authority = new FakeBootstrapAuthority();
	const broker = createOmpTurnBroker({ bootstrapAuthority: authority, batchWindowMs: 0, ...options });
	await broker.listen();
	const spawn = await broker.prepareTunnelSpawn();
	await broker.authorizeTunnel(spawn.connectorBootstrap, authority.process(), spawn.tunnelAdmission);
	const connector = await broker.attachConnector(spawn.connectorBootstrap);
	return { authority, broker, connector };
}

async function issue(
	broker: OmpTurnBrokerImpl,
	tools: readonly Tool[] = [echoTool],
	overrides: Partial<OmpTurnBinding> = {},
) {
	const admission = await broker.gate.admit("turn");
	const canonical = canonicalizeOmpTools(tools);
	const binding: OmpTurnBinding = {
		sessionId: "omp-session",
		turnId: "turn-1",
		runtimeEpoch: admission.runtimeEpoch,
		bindingId: `binding-${crypto.randomUUID()}`,
		expiresAt: Date.now() + 60_000,
		declaredToolSetHash: canonical.hash,
		tools,
		...overrides,
	};
	try {
		return await broker.issue(binding, admission);
	} finally {
		broker.gate.release(admission);
	}
}

describe("OmpTurnBroker capability security", () => {
	test("starts pre-bind, atomically claims, is idempotent only on the same live connector, and rejects clones/replay", async () => {
		const { authority, broker, connector } = await fixture();
		const turn = await issue(broker);
		expect((await broker.listTools(connector)).map(tool => tool.name)).toEqual(["chatgpt_web_bind_turn"]);
		expect(await broker.claim(turn.turnToken, connector)).toEqual(turn.binding);
		expect(await broker.claim(turn.turnToken, connector)).toEqual(turn.binding);
		expect((await broker.listTools(connector)).map(tool => tool.name)).toEqual(["echo"]);
		const clone = { ...connector } as OmpMcpConnector;
		await expect(broker.listTools(clone)).rejects.toThrow(/cloned|invalid/);
		const state = authority.states.get((await broker.prepareTunnelSpawn()).connectorBootstrap);
		expect(state?.authorized).toBe(false);
		await broker.release(turn.binding.bindingId, connector);
		await expect(broker.claim(turn.turnToken, connector)).rejects.toThrow(/retired/);
		await broker.closeConnector(connector);
		await broker.drain();
	});

	test("rejects wrong native peer before every operation without consuming tool state", async () => {
		const { authority, broker, connector } = await fixture();
		const turn = await issue(broker);
		await broker.claim(turn.turnToken, connector);
		authority.lastConnection!.peerValid = false;
		await expect(broker.listTools(connector)).rejects.toThrow(/peer changed/);
		authority.lastConnection!.peerValid = true;
		expect((await broker.listTools(connector)).map(tool => tool.name)).toEqual(["echo"]);
		await broker.release(turn.binding.bindingId, connector);
		await broker.closeConnector(connector);
		await broker.drain();
	});

	test("coalesces parallel invocations and requires exact result IDs, cardinality, and metadata", async () => {
		const { broker, connector } = await fixture();
		const turn = await issue(broker);
		await broker.claim(turn.turnToken, connector);
		const first = broker.invoke(connector, { callId: "call-1", wireName: "echo", arguments: { value: "a" } });
		const second = broker.invoke(connector, { callId: "call-2", wireName: "echo", arguments: { value: "b" } });
		const batch = await broker.nextInvocationBatch(turn.binding.bindingId, connector);
		expect(batch.map(call => call.callId)).toEqual(["call-1", "call-2"]);
		await broker.resolveBatch(turn.binding.bindingId, connector, [
			{ callId: "call-2", result: toolResult("call-2") },
			{ callId: "call-1", result: toolResult("call-1") },
		]);
		expect((await Promise.all([first, second])).map(result => result.toolCallId)).toEqual(["call-1", "call-2"]);

		const third = broker.invoke(connector, { callId: "call-3", wireName: "echo", arguments: { value: "c" } });
		const thirdRejected = third.then(
			() => {
				throw new Error("expected third invocation to reject");
			},
			error => {
				expect(error instanceof Error ? error.message : String(error)).toMatch(/match/);
			},
		);
		await broker.nextInvocationBatch(turn.binding.bindingId, connector);
		const invalidBatch = broker.resolveBatch(turn.binding.bindingId, connector, [
			{ callId: "call-3", result: toolResult("wrong") },
		]);
		await invalidBatch.then(
			() => {
				throw new Error("expected invalid result batch to reject");
			},
			error => {
				expect(error instanceof Error ? error.message : String(error)).toMatch(/match/);
			},
		);
		await thirdRejected;
		expect((await broker.listTools(connector)).map(tool => tool.name)).toContain("chatgpt_web_bind_turn");
		await broker.closeConnector(connector);
		await broker.drain();
	});

	test("expires the binding on duplicate call IDs and keeps connector tool caches isolated", async () => {
		const { authority, broker, connector } = await fixture();
		const secondSpawn = await broker.prepareTunnelSpawn();
		await broker.authorizeTunnel(secondSpawn.connectorBootstrap, authority.process(), secondSpawn.tunnelAdmission);
		const secondConnector = await broker.attachConnector(secondSpawn.connectorBootstrap);
		const turn = await issue(broker);
		await broker.claim(turn.turnToken, connector);
		expect((await broker.listTools(secondConnector)).map(tool => tool.name)).toEqual(["chatgpt_web_bind_turn"]);
		const first = broker.invoke(connector, { callId: "duplicate", wireName: "echo", arguments: { value: "a" } });
		const firstRejected = first.then(
			() => {
				throw new Error("expected first invocation to reject");
			},
			error => {
				expect(error instanceof Error ? error.message : String(error)).toMatch(/duplicate/);
			},
		);
		const duplicate = broker.invoke(connector, { callId: "duplicate", wireName: "echo", arguments: { value: "b" } });
		await duplicate.then(
			() => {
				throw new Error("expected duplicate invocation to reject");
			},
			error => {
				expect(error instanceof Error ? error.message : String(error)).toMatch(/duplicate/);
			},
		);
		await firstRejected;
		expect((await broker.listTools(connector)).map(tool => tool.name)).toContain("chatgpt_web_bind_turn");
		await broker.closeConnector(connector);
		await broker.closeConnector(secondConnector);
		await broker.drain();
	});

	test("rejects duplicate names/aliases and hash/schema changes, preserving name-first collision precedence", async () => {
		const duplicate = [{ ...echoTool }, { ...echoTool }];
		expect(() => canonicalizeOmpTools(duplicate)).toThrow(/duplicate tool name/);
		expect(() =>
			canonicalizeOmpTools([
				{ ...echoTool, name: "one", customWireName: "alias" },
				{ ...echoTool, name: "two", customWireName: "alias" },
			]),
		).toThrow(/duplicate tool alias/);
		expect(() => canonicalizeOmpTools([{ ...echoTool, name: "chatgpt_web_bind_turn" }])).toThrow(/reserved/);
		const collision = canonicalizeOmpTools([
			{ ...echoTool, name: "exact" },
			{ ...echoTool, name: "other", customWireName: "exact" },
		]);
		expect(collision.hash).toHaveLength(64);
		const { broker, connector } = await fixture();
		await expect(issue(broker, [echoTool], { declaredToolSetHash: "0".repeat(64) })).rejects.toThrow(/hash mismatch/);
		await broker.closeConnector(connector);
		await broker.drain();
	});

	test("rejects structured arguments that do not match the canonical tool schema", async () => {
		const { broker, connector } = await fixture();
		const turn = await issue(broker);
		await broker.claim(turn.turnToken, connector);
		await expect(
			broker.invoke(connector, { callId: "bad-schema", wireName: "echo", arguments: { value: 42 } }),
		).rejects.toThrow(/declared schema/);
		await broker.release(turn.binding.bindingId, connector);
		await broker.closeConnector(connector);
		await broker.drain();
	});

	test("enforces capacity, aborts waiters, expires claims, and drains all owned references", async () => {
		const { broker, connector } = await fixture({ maxBindings: 1 });
		const turn = await issue(broker);
		await expect(issue(broker)).rejects.toThrow(/capacity/);
		await broker.claim(turn.turnToken, connector);
		const abort = new AbortController();
		const waiting = broker.nextInvocationBatch(turn.binding.bindingId, connector, abort.signal);
		abort.abort();
		await expect(waiting).rejects.toThrow(/aborted/);
		await broker.release(turn.binding.bindingId, connector);
		await broker.closeConnector(connector);
		await broker.drain();
	});

	test("rolls back attach failures without leaking a connection or wedging the one-time spawn", async () => {
		const authority = new FakeBootstrapAuthority();
		const broker = createOmpTurnBroker({ bootstrapAuthority: authority });
		const spawn = await broker.prepareTunnelSpawn();
		await broker.authorizeTunnel(spawn.connectorBootstrap, authority.process(), spawn.tunnelAdmission);
		authority.failCurrentPeer = true;
		await expect(broker.attachConnector(spawn.connectorBootstrap)).rejects.toThrow(/peer validation/);
		expect(authority.closeCount).toBe(1);
		await expect(broker.attachConnector(spawn.connectorBootstrap)).rejects.toThrow(/invalid|consumed/);
		await broker.drain();
	});

	test("aborts a pending spawn idempotently without a second gate or connection release", async () => {
		const authority = new FakeBootstrapAuthority();
		const broker = createOmpTurnBroker({ bootstrapAuthority: authority });
		const spawn = await broker.prepareTunnelSpawn();
		const attaching = broker.attachConnector(spawn.connectorBootstrap);
		await Promise.resolve();
		await broker.abortTunnelSpawn(spawn.connectorBootstrap, spawn.tunnelAdmission);
		await broker.abortTunnelSpawn(spawn.connectorBootstrap, spawn.tunnelAdmission);
		await expect(attaching).rejects.toThrow(/aborted|retired|authorization/);
		expect(authority.closeCount).toBe(1);
		expect(authority.abortPreparedCount).toBe(1);
		await expect(
			broker.authorizeTunnel(spawn.connectorBootstrap, authority.process(), spawn.tunnelAdmission),
		).rejects.toThrow(/invalid|replayed/);
		await broker.drain();
	});

	test("aborts an attached spawn once and leaves broker drain clean", async () => {
		const authority = new FakeBootstrapAuthority();
		const broker = createOmpTurnBroker({ bootstrapAuthority: authority });
		const spawn = await broker.prepareTunnelSpawn();
		await broker.authorizeTunnel(spawn.connectorBootstrap, authority.process(), spawn.tunnelAdmission);
		await broker.attachConnector(spawn.connectorBootstrap);
		await broker.abortTunnelSpawn(spawn.connectorBootstrap, spawn.tunnelAdmission);
		await broker.abortTunnelSpawn(spawn.connectorBootstrap, spawn.tunnelAdmission);
		expect(authority.closeCount).toBe(1);
		expect(authority.abortPreparedCount).toBe(1);
		await expect(broker.attachConnector(spawn.connectorBootstrap)).rejects.toThrow(/invalid|consumed/);
		await broker.drain();
	});

	test("drain racing a pending authorization rejects attach and closes its captured native connection", async () => {
		const authority = new FakeBootstrapAuthority();
		const broker = createOmpTurnBroker({ bootstrapAuthority: authority });
		const spawn = await broker.prepareTunnelSpawn();
		const attaching = broker.attachConnector(spawn.connectorBootstrap);
		await Promise.resolve();
		await broker.drain();
		await expect(attaching).rejects.toThrow(/drained|retired|authorization/);
		expect(authority.closeCount).toBe(1);
	});

	test("propagates authorization and rollback failures together, then retries rollback", async () => {
		const authority = new FakeBootstrapAuthority();
		authority.failAuthorize = true;
		authority.failAbortPreparedCount = 1;
		const broker = createOmpTurnBroker({ bootstrapAuthority: authority });
		const spawn = await broker.prepareTunnelSpawn();

		await expect(
			broker.authorizeTunnel(spawn.connectorBootstrap, authority.process(), spawn.tunnelAdmission),
		).rejects.toThrow("tunnel authorization and rollback failed");
		await broker.abortTunnelSpawn(spawn.connectorBootstrap, spawn.tunnelAdmission);
		expect(authority.abortPreparedCount).toBe(1);
		await broker.drain();
	});

	test("retries native connection cleanup instead of losing the failed connection", async () => {
		const authority = new FakeBootstrapAuthority();
		authority.failCloseCount = 1;
		const broker = createOmpTurnBroker({ bootstrapAuthority: authority });
		const spawn = await broker.prepareTunnelSpawn();
		await broker.authorizeTunnel(spawn.connectorBootstrap, authority.process(), spawn.tunnelAdmission);
		authority.failCurrentPeer = true;

		await expect(broker.attachConnector(spawn.connectorBootstrap)).rejects.toThrow(
			"connector attach and rollback failed",
		);
		expect(authority.lastConnection?.live).toBe(true);
		await broker.abortTunnelSpawn(spawn.connectorBootstrap, spawn.tunnelAdmission);
		expect(authority.closeCount).toBe(2);
		expect(authority.lastConnection?.live).toBe(false);
		await broker.drain();
	});

	test("retries failed admission and process-reference releases without hanging drain", async () => {
		for (const authorized of [false, true]) {
			const authority = new FakeBootstrapAuthority();
			const gate = new FailOnceReleaseGate();
			const broker = createOmpTurnBroker({ bootstrapAuthority: authority, gate });
			const spawn = await broker.prepareTunnelSpawn();
			if (authorized) {
				await broker.authorizeTunnel(spawn.connectorBootstrap, authority.process(), spawn.tunnelAdmission);
			}

			await expect(broker.abortTunnelSpawn(spawn.connectorBootstrap, spawn.tunnelAdmission)).rejects.toThrow(
				"runtime gate release failed",
			);
			await broker.abortTunnelSpawn(spawn.connectorBootstrap, spawn.tunnelAdmission);
			await broker.drain();
			expect(gate.releaseAttempts).toBe(authorized ? 3 : 2);
		}
	});
});
