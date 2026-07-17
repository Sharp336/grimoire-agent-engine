#!/usr/bin/env bun
/**
 * Test fixture for `lifecycle: "lazy"` MCP server tests.
 *
 * A minimal, long-lived stdio MCP server that answers `initialize` +
 * `tools/list` with a single `echo` tool and answers `tools/call` for it.
 * Unlike `crash-after-init-mcp.ts` it does NOT exit after the handshake —
 * lazy-lifecycle tests need a connection that stays open until the manager
 * (or the test) tears it down, so idle-reap and reconnect-on-demand
 * behavior can be observed independently of process lifetime.
 *
 * Each invocation atomically appends the PID + timestamp to the path in
 * `$OMP_TEST_SPAWN_LOG`, so tests can assert exactly how many times the
 * manager connected (zero for a warm cache hit, one for a cold-cache
 * activation, two after an idle-reap + on-demand reconnect, etc.).
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

const spawnLog = Bun.env.OMP_TEST_SPAWN_LOG;
if (spawnLog) {
	fs.appendFileSync(spawnLog, `${process.pid} ${Date.now()}\n`);
}

const rl = readline.createInterface({ input: process.stdin });

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", line => {
	let message: { id?: number | string; method?: string; params?: { name?: string; arguments?: unknown } };
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}

	if (message.method === "initialize" && message.id !== undefined) {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "lazy-lifecycle-fixture", version: "1.0.0" },
			},
		});
		return;
	}

	if (message.method === "tools/list" && message.id !== undefined) {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				tools: [
					{
						name: "echo",
						description: "Echoes back its input",
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
					},
				],
			},
		});
		return;
	}

	if (message.method === "tools/call" && message.id !== undefined) {
		const text = (message.params?.arguments as { text?: string } | undefined)?.text ?? "";
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [{ type: "text", text }] },
		});
		return;
	}
});

rl.on("close", () => process.exit(0));
