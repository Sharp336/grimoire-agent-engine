#!/usr/bin/env bun
/**
 * Test fixture: a configurable stdio MCP server for the lifecycle tests. It
 * advertises a single tool and answers tool calls, and is driven entirely by
 * environment variables so one fixture covers every scenario:
 *
 *   MCP_SPAWN_LOG       append `spawn <pid>` to this file on startup, so a test
 *                       can assert whether (and how many times) a lazy server
 *                       was actually spawned.
 *   MCP_CRASH_BEFORE_INIT="1"  exit(1) before speaking MCP, so the connect fails.
 *   MCP_CALL_DELAY_MS   delay each `tools/call` response by this many ms, used to
 *                       hold a call in-flight across an idle window.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`),
 * same shape as `many-tools-mcp.ts`. Exported constants are imported by tests;
 * the server only starts when run as the entry module (`import.meta.main`).
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

/** Name of the single tool the fixture advertises. */
export const LAZY_TOOL_NAME = "ping";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "lazy-lifecycle-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: LAZY_TOOL_NAME,
						description: "Lazy fixture tool",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		case "tools/call":
			return { content: [{ type: "text", text: "pong" }] };
		default:
			return {};
	}
}

function startServer(): void {
	const spawnLog = process.env.MCP_SPAWN_LOG;
	if (spawnLog) {
		fs.appendFileSync(spawnLog, `spawn ${process.pid}\n`);
	}
	if (process.env.MCP_CRASH_BEFORE_INIT === "1") {
		// Exit before speaking MCP so the connect attempt fails.
		process.exit(1);
	}
	const callDelayMs = Number(process.env.MCP_CALL_DELAY_MS ?? "0") || 0;

	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				return;
			}
			// Notifications (no `id`) get no response.
			if (msg.id === undefined || msg.id === null) return;
			if (msg.method === "tools/call" && callDelayMs > 0) {
				await Bun.sleep(callDelayMs);
			}
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
