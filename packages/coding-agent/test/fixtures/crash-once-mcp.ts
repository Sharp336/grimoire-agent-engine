#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server that answers `initialize` + `tools/list`
 * exactly once, then exits — simulating a server that crashes right after a
 * successful connect. On the NEXT spawn (marker file exists from the first
 * run) it behaves normally forever.
 *
 * Used by `mcp-reconnect-notices.test.ts` to drive the manager's automatic
 * reconnect path: first spawn connects and dies → transport onClose →
 * reconnect (which spawns a fresh, now-healthy process) → reconnect succeeds.
 *
 * Protocol identical to ./instructions-mcp.ts (newline-delimited JSON-RPC).
 * argv[2] is the marker file path; argv[2] missing means "always healthy".
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

export const CRASH_TOOL_NAME = "crash_probe";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

const markerPath = process.argv[2];
const alreadyCrashed = markerPath === undefined || fs.existsSync(markerPath);

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "crash-once-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: CRASH_TOOL_NAME,
						description: "Probe tool for the reconnect fixture.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		default:
			return {};
	}
}

function startServer(): void {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let msg: JsonRpcRequest;
		try {
			msg = JSON.parse(trimmed) as JsonRpcRequest;
		} catch {
			return;
		}
		if (msg.id === undefined || msg.id === null) return;
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: buildResult(msg.method) })}\n`);
		if (!alreadyCrashed && msg.method === "tools/list") {
			// Let the response flush, then "crash": mark and exit so the
			// transport sees a dead child and the manager starts a reconnect.
			fs.writeFileSync(markerPath as string, "crashed");
			setTimeout(() => process.exit(1), 100);
		}
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
