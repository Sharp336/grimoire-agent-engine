#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as readline from "node:readline";

interface RpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

const mode = process.env.MCP_PROTOCOL_FIXTURE_MODE ?? "modern";
const logPath = process.env.MCP_PROTOCOL_FIXTURE_LOG;
const input = readline.createInterface({ input: process.stdin, terminal: false });

async function record(method: string): Promise<void> {
	if (!logPath) return;
	await fs.appendFile(logPath, `${JSON.stringify({ pid: process.pid, method })}\n`);
}

function respond(id: string | number | undefined, result: unknown, exit = false): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`, () => {
		if (exit) process.exit(0);
	});
}

function reject(id: string | number | undefined, code: number, message: string, exit = false): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`, () => {
		if (exit) process.exit(0);
	});
}

input.on("line", line => {
	void (async () => {
		const request = JSON.parse(line) as RpcRequest;
		await record(request.method);
		switch (request.method) {
			case "server/discover":
				if (mode === "close") process.exit(0);
				if (mode === "ignore") return;
				if (mode === "invalid-params") {
					reject(request.id, -32602, "Invalid params", true);
					return;
				}
				if (mode === "malformed") {
					respond(request.id, null, true);
					return;
				}
				if (mode === "legacy") {
					reject(request.id, -32601, "Method not found", true);
					return;
				}
				respond(
					request.id,
					{
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
						_meta: { "io.modelcontextprotocol/serverInfo": { name: "protocol-mode-fixture", version: "1.0.0" } },
					},
					true,
				);
				return;
			case "initialize":
				respond(request.id, {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "protocol-mode-fixture", version: "1.0.0" },
				});
				return;
			case "tools/list":
				respond(request.id, { resultType: "complete", tools: [] }, true);
				return;
			case "notifications/initialized":
				process.exit(0);
		}
	})();
});
