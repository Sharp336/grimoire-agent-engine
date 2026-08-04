import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runChatGptWebCli } from "../../src/cli";
import { bootstrapPayloadDigest } from "../../src/mcp/bootstrap";
import { runMcpHandoffChild } from "../../src/mcp/main";

const runtimeEpoch = "epoch-that-is-long-enough-123";
const authenticator = "authenticator-that-is-at-least-thirty-two-characters";
const digest = bootstrapPayloadDigest(runtimeEpoch, authenticator);

class FakeBootstrapFile {
	readonly payloadDigest: string;
	constructor(payloadDigest = digest) {
		this.payloadDigest = payloadDigest;
	}
	readonly identity = "native-file-identity";
	consumed = false;
	closed = false;
	read() {
		return Buffer.from(
			JSON.stringify({
				version: 1,
				runtimeEpoch,
				authenticator,
				bootstrapDigest: this.payloadDigest,
			}),
		);
	}
	consume() {
		if (this.consumed) throw new Error("bootstrap replay");
		this.consumed = true;
	}
	close() {
		this.closed = true;
	}
}

class FakeInheritedConnection {
	readonly responses: Uint8Array[] = [];
	readonly readWaiters: Array<(bytes: Uint8Array) => void> = [];
	closed = false;
	peerChecks = 0;

	currentPeer() {
		this.peerChecks += 1;
		if (this.closed) throw new Error("connection closed");
		return {};
	}

	write(bytes: Uint8Array) {
		const request = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
			id: string;
			method: string;
			params: Record<string, unknown>;
		};
		let result: unknown;
		switch (request.method) {
			case "proof":
				if (request.params.bootstrapDigest !== digest) throw new Error("wrong digest");
				result = {
					bootstrapDigest: digest,
					connector: {
						connectorId: "connector",
						sessionId: "session",
						runtimeEpoch: "epoch-that-is-long-enough-123",
						sessionNonce: "nonce",
					},
				};
				break;
			case "list_tools":
				result = [
					{
						name: "chatgpt_web_bind_turn",
						description: "bind",
						inputSchema: {
							type: "object",
							required: ["turnToken"],
							properties: { turnToken: { type: "string" } },
							additionalProperties: false,
						},
					},
				];
				break;
			case "close":
				result = { closed: true };
				break;
			default:
				throw new Error(`unexpected broker request ${request.method}`);
		}
		const encoded = Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`);
		const waiter = this.readWaiters.shift();
		if (waiter) waiter(encoded);
		else this.responses.push(encoded);
	}

	read(): Uint8Array | Promise<Uint8Array> {
		const response = this.responses.shift();
		if (response) return response;
		const { promise, resolve } = Promise.withResolvers<Uint8Array>();
		this.readWaiters.push(resolve);
		return promise;
	}

	close() {
		this.closed = true;
		for (const resolve of this.readWaiters.splice(0)) resolve(new Uint8Array());
	}
}

class OutputLines {
	readonly stream = new PassThrough();
	readonly messages: unknown[] = [];
	readonly waiters = new Set<() => void>();
	#buffer = "";
	constructor() {
		this.stream.setEncoding("utf8");
		this.stream.on("data", chunk => {
			this.#buffer += chunk;
			while (true) {
				const newline = this.#buffer.indexOf("\n");
				if (newline < 0) break;
				this.messages.push(JSON.parse(this.#buffer.slice(0, newline)));
				this.#buffer = this.#buffer.slice(newline + 1);
			}
			for (const wake of this.waiters) wake();
			this.waiters.clear();
		});
	}
	async take(id: number) {
		while (true) {
			const index = this.messages.findIndex(message =>
				Boolean(message && typeof message === "object" && "id" in message && message.id === id),
			);
			if (index >= 0) return this.messages.splice(index, 1)[0];
			const waiting = Promise.withResolvers<void>();
			this.waiters.add(waiting.resolve);
			await waiting.promise;
		}
	}
}

describe("real stdio MCP child boundary", () => {
	test("CLI dispatches only the exact package-owned broker handoff command", async () => {
		let calls = 0;
		const io = { writeOut() {}, writeErr() {} };
		const handoff = async () => {
			calls += 1;
		};
		expect(await runChatGptWebCli(["mcp", "--broker-handoff"], { io, mcpHandoff: handoff })).toBe(0);
		expect(calls).toBe(1);
		expect(
			await runChatGptWebCli(["mcp", "--broker-handoff", "attacker-path"], {
				io,
				mcpHandoff: handoff,
			}),
		).toBe(1);
		expect(calls).toBe(1);
	});

	test("opens one inherited native bootstrap, proves it before consume, and serves MCP over stdio", async () => {
		const bootstrap = new FakeBootstrapFile();
		const connection = new FakeInheritedConnection();
		let opens = 0;
		const nativeModule = {
			openInheritedBrokerBootstrap() {
				opens += 1;
				if (opens !== 1) throw new Error("bootstrap replay");
				return bootstrap;
			},
			connectInheritedBroker() {
				return connection;
			},
		};
		const input = new PassThrough();
		const output = new OutputLines();
		const running = runMcpHandoffChild({ nativeModule, input, output: output.stream });
		input.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`,
		);
		await output.take(1);
		input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
		const listed = await output.take(2);
		expect(JSON.stringify(listed)).toContain("chatgpt_web_bind_turn");
		input.end();
		await running;
		expect(opens).toBe(1);
		expect(bootstrap.consumed).toBe(true);
		expect(bootstrap.closed).toBe(true);
		expect(connection.closed).toBe(true);
		expect(connection.peerChecks).toBeGreaterThanOrEqual(2);
	});

	test("rejects a tampered bootstrap digest before opening the inherited broker", async () => {
		const bootstrap = new FakeBootstrapFile("0".repeat(64));
		let connections = 0;
		await expect(
			runMcpHandoffChild({
				nativeModule: {
					openInheritedBrokerBootstrap: () => bootstrap,
					connectInheritedBroker() {
						connections += 1;
						return new FakeInheritedConnection();
					},
				},
			}),
		).rejects.toThrow(/digest/);
		expect(connections).toBe(0);
		expect(bootstrap.closed).toBe(true);
	});

	test("fails closed when inherited native handoff is unavailable", async () => {
		await expect(runMcpHandoffChild({ nativeModule: {} as never })).rejects.toThrow(/unavailable/);
	});
});
