#!/usr/bin/env bun
/**
 * Test fixture: a minimal stdio MCP server whose advertised tool list CHANGES
 * between `tools/list` calls — first call serves [alpha, beta], every later
 * call serves [beta]. Used by `mcp-tool-filter-manager.test.ts` to prove that
 * when a server's toolset shrinks (a `tools/list_changed` refresh) and the
 * configured tool filter empties the advertised set, previously-registered
 * tools are cleared rather than left stale in the session.
 */
import * as readline from "node:readline";

export const FIRST_TOOL = "alpha";
export const SECOND_TOOL = "beta";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

let toolsListCalls = 0;

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "tool-change-fixture", version: "1.0.0" },
				capabilities: { tools: { listChanged: true } },
			};
		case "tools/list":
			toolsListCalls += 1;
			if (toolsListCalls === 1) {
				return {
					tools: [
						{ name: FIRST_TOOL, description: "First advertised tool", inputSchema: { type: "object" } },
						{ name: SECOND_TOOL, description: "Second advertised tool", inputSchema: { type: "object" } },
					],
				};
			}
			return {
				tools: [{ name: SECOND_TOOL, description: "Second advertised tool", inputSchema: { type: "object" } }],
			};
		default:
			return {};
	}
}

function startServer(): void {
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
			if (msg.id === undefined || msg.id === null) return;
			if (!msg.method) return;
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
