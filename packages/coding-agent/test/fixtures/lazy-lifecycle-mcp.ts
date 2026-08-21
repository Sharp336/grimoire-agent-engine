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
 *   MCP_ADVERTISE_PROMPTS="1" advertise prompt capability.
 *   MCP_EMPTY_PROMPTS="1"     return no current prompts from prompts/list.
 *   MCP_INSTRUCTIONS    return these server instructions from `initialize`.
 *   MCP_NO_TOOLS="1"    return an empty `tools/list`, as a tool-less server does.
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
				capabilities: {
					tools: {
						...(process.env.MCP_ADVERTISE_TOOL_LIST_CHANGED === "1" ? { listChanged: true } : {}),
					},
					...(process.env.MCP_ADVERTISE_PROMPTS === "1" ? { prompts: {} } : {}),
				},
				...(process.env.MCP_INSTRUCTIONS ? { instructions: process.env.MCP_INSTRUCTIONS } : {}),
			};
		case "tools/list":
			if (process.env.MCP_NO_TOOLS === "1") return { tools: [] };
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
		case "prompts/list":
			return {
				prompts: process.env.MCP_EMPTY_PROMPTS === "1" ? [] : [{ name: "hello", description: "Fixture prompt" }],
			};
		case "prompts/get":
			return {
				description: "Fixture prompt",
				messages: [{ role: "user", content: { type: "text", text: "hello" } }],
			};
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
			if (msg.method === "initialize") {
				const initializeDelayMs = Number(process.env.MCP_INITIALIZE_DELAY_MS ?? "0") || 0;
				if (initializeDelayMs > 0) await Bun.sleep(initializeDelayMs);
			}
			if (msg.method === "tools/call" && callDelayMs > 0) {
				const callLog = process.env.MCP_CALL_LOG;
				if (callLog) fs.appendFileSync(callLog, `call ${process.pid}\\n`);
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
