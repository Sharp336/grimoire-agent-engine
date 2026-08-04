import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { OmpMcpConnector, OmpMcpTool, OmpTurnBinding } from "../../src/mcp/broker";
import { type OmpMcpBrokerClient, runOmpMcpServer } from "../../src/mcp/server";

class FakeClient implements OmpMcpBrokerClient {
	readonly connector = {
		connectorId: "connector",
		sessionId: "session",
		runtimeEpoch: "epoch",
		sessionNonce: "nonce",
	} as OmpMcpConnector;
	readonly binding: OmpTurnBinding = {
		sessionId: "session",
		turnId: "turn",
		runtimeEpoch: "epoch",
		bindingId: "binding",
		expiresAt: Date.now() + 60_000,
		declaredToolSetHash: "a".repeat(64),
		tools: [],
	};
	bound = false;
	closed = false;
	invocations: string[] = [];
	listeners = new Set<() => void>();
	holdParallel = false;
	pendingInvocations: Array<{
		callId: string;
		wireName: string;
		resolve: (result: ToolResultMessage) => void;
	}> = [];

	async claim(turnToken: string) {
		if (turnToken !== "turn-token-that-is-long-enough") throw new Error("invalid token");
		this.bound = true;
		for (const listener of this.listeners) listener();
		return this.binding;
	}

	async listTools(): Promise<readonly OmpMcpTool[]> {
		if (!this.bound) {
			return [
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
		}
		return [
			{
				name: "echo",
				description: "echo",
				parameters: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			},
		];
	}

	async invoke(call: { callId: string; wireName: string }): Promise<ToolResultMessage> {
		this.invocations.push(call.callId);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.callId,
			toolName: call.wireName,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		};
		if (!this.holdParallel) return result;
		const deferred = Promise.withResolvers<ToolResultMessage>();
		this.pendingInvocations.push({ callId: call.callId, wireName: call.wireName, resolve: deferred.resolve });
		if (this.pendingInvocations.length === 2) {
			for (const pending of this.pendingInvocations.splice(0)) {
				pending.resolve({ ...result, toolCallId: pending.callId, toolName: pending.wireName });
			}
		}
		return deferred.promise;
	}

	async release(_bindingId: string) {
		this.bound = false;
		for (const listener of this.listeners) listener();
	}

	onToolsChanged(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close() {
		this.closed = true;
	}
}

class JsonLineHarness {
	readonly input = new PassThrough();
	readonly output = new PassThrough();
	readonly messages: unknown[] = [];
	readonly waiters = new Set<() => void>();
	#buffer = "";

	constructor() {
		this.output.setEncoding("utf8");
		this.output.on("data", chunk => {
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

	write(message: unknown) {
		this.input.write(`${JSON.stringify(message)}\n`);
	}

	async take(predicate: (message: unknown) => boolean): Promise<unknown> {
		while (true) {
			const index = this.messages.findIndex(predicate);
			if (index >= 0) return this.messages.splice(index, 1)[0];
			const waiting = Promise.withResolvers<void>();
			this.waiters.add(waiting.resolve);
			await waiting.promise;
		}
	}

	request(id: number, method: string, params: Record<string, unknown> = {}) {
		this.write({ jsonrpc: "2.0", id, method, params });
		return this.take(message => {
			return Boolean(message && typeof message === "object" && "id" in message && message.id === id);
		});
	}
}

async function initializedHarness() {
	const client = new FakeClient();
	const harness = new JsonLineHarness();
	const running = runOmpMcpServer({ client, input: harness.input, output: harness.output });
	await harness.request(1, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1" },
	});
	harness.write({ jsonrpc: "2.0", method: "notifications/initialized" });
	return { client, harness, running };
}

describe("OMP MCP stdio server", () => {
	test("exposes only bind pre-claim, notifies list transitions, validates schemas, and correlates calls", async () => {
		const { client, harness, running } = await initializedHarness();
		const listed = await harness.request(2, "tools/list");
		expect(JSON.stringify(listed)).toContain("chatgpt_web_bind_turn");
		const rejected = await harness.request(3, "tools/call", { name: "echo", arguments: { value: "x" } });
		expect(JSON.stringify(rejected)).toContain("must succeed");
		const bound = await harness.request(4, "tools/call", {
			name: "chatgpt_web_bind_turn",
			arguments: { turnToken: "turn-token-that-is-long-enough" },
		});
		expect(JSON.stringify(bound)).toContain("binding");
		const notification = await harness.take(message =>
			Boolean(
				message &&
					typeof message === "object" &&
					"method" in message &&
					message.method === "notifications/tools/list_changed",
			),
		);
		expect(notification).toBeDefined();
		const tools = await harness.request(5, "tools/list");
		expect(JSON.stringify(tools)).toContain("echo");
		expect(JSON.stringify(tools)).not.toContain("chatgpt_web_bind_turn");
		const invalid = await harness.request(6, "tools/call", { name: "echo", arguments: {} });
		expect(JSON.stringify(invalid)).toContain("declared schema");
		const forged = await harness.request(8, "tools/call", {
			name: "echo",
			arguments: { value: "x", approvalMode: "yolo" },
		});
		expect(JSON.stringify(forged)).toContain("reserved approval-control field");
		expect(client.invocations).toEqual([]);
		const invoked = await harness.request(7, "tools/call", { name: "echo", arguments: { value: "x" } });
		expect(JSON.stringify(invoked)).toContain("ok");
		expect(client.invocations).toEqual(["7"]);
		harness.input.end();
		await running;
		expect(client.closed).toBe(true);
	});

	test("accepts parallel MCP calls without serializing the second behind the first result", async () => {
		const { client, harness, running } = await initializedHarness();
		await harness.request(10, "tools/call", {
			name: "chatgpt_web_bind_turn",
			arguments: { turnToken: "turn-token-that-is-long-enough" },
		});
		client.holdParallel = true;
		harness.write({
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "echo", arguments: { value: "a" } },
		});
		harness.write({
			jsonrpc: "2.0",
			id: 12,
			method: "tools/call",
			params: { name: "echo", arguments: { value: "b" } },
		});
		const first = await harness.take(message =>
			Boolean(message && typeof message === "object" && "id" in message && message.id === 11),
		);
		const second = await harness.take(message =>
			Boolean(message && typeof message === "object" && "id" in message && message.id === 12),
		);
		expect(JSON.stringify(first)).toContain("ok");
		expect(JSON.stringify(second)).toContain("ok");
		expect(client.invocations).toEqual(["11", "12"]);
		harness.input.end();
		await running;
	});

	test("closes fail-closed on an oversized unterminated JSON frame", async () => {
		const client = new FakeClient();
		const input = new PassThrough();
		const output = new PassThrough();
		const running = runOmpMcpServer({ client, input, output, maxJsonBytes: 1024 });
		input.write("x".repeat(1025));
		await expect(running).rejects.toThrow(/size limit/);
	});
});
