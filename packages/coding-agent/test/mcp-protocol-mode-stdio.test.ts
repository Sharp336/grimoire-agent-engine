import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connectToServer, disconnectServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPProtocolMode, MCPServerConnection, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

interface ProtocolLogEntry {
	pid: number;
	method: string;
}

const fixture = path.join(import.meta.dir, "fixtures", "protocol-mode-mcp.ts");
let tempDir = "";
let logPath = "";
let connection: MCPServerConnection | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-protocol-mode-"));
	logPath = path.join(tempDir, "requests.jsonl");
});

afterEach(async () => {
	if (connection) await disconnectServer(connection);
	connection = undefined;
	await removeWithRetries(tempDir);
});

function config(
	serverMode: "modern" | "legacy" | "close" | "invalid-params" | "ignore" | "malformed",
	protocolMode?: MCPProtocolMode,
): MCPStdioServerConfig {
	return {
		type: "stdio",
		command: process.execPath,
		args: [fixture],
		env: {
			MCP_PROTOCOL_FIXTURE_MODE: serverMode,
			MCP_PROTOCOL_FIXTURE_LOG: logPath,
		},
		protocolMode,
	};
}

async function readLog(expectedCount: number): Promise<ProtocolLogEntry[]> {
	const deadline = Date.now() + 1_000;
	do {
		try {
			const entries = Bun.JSONL.parse(await Bun.file(logPath).text()) as ProtocolLogEntry[];
			if (entries.length >= expectedCount) return entries;
		} catch {}
		await Bun.sleep(5);
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${expectedCount} MCP fixture log entries`);
}

describe("MCP stdio protocol rollout", () => {
	it("uses one legacy process without probing by default", async () => {
		connection = await connectToServer("legacy-default", config("legacy"));
		const entries = await readLog(2);
		expect(entries.map(entry => entry.method)).toEqual(["initialize", "notifications/initialized"]);
		expect(new Set(entries.map(entry => entry.pid)).size).toBe(1);
	});

	it("probes auto mode in a disposable process before legacy initialization", async () => {
		connection = await connectToServer("legacy-auto", config("legacy", "auto"));
		const entries = await readLog(3);
		expect(entries.map(entry => entry.method)).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
		]);
		expect(entries[0]?.pid).not.toBe(entries[1]?.pid);
		expect(entries[1]?.pid).toBe(entries[2]?.pid);
	});

	it("uses the modern lifecycle in a fresh process after auto discovery", async () => {
		connection = await connectToServer("modern-auto", config("modern", "auto"));
		await listTools(connection);
		const entries = await readLog(2);
		expect(entries.map(entry => entry.method)).toEqual(["server/discover", "tools/list"]);
		expect(entries[0]?.pid).not.toBe(entries[1]?.pid);
	});

	for (const serverMode of ["close", "invalid-params", "ignore", "malformed"] as const) {
		it(`falls back after a ${serverMode} auto probe outcome`, async () => {
			connection = await connectToServer(`${serverMode}-probe`, config(serverMode, "auto"));
			const entries = await readLog(3);
			expect(entries.map(entry => entry.method)).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
			]);
			expect(entries[0]?.pid).not.toBe(entries[1]?.pid);
			expect(entries[1]?.pid).toBe(entries[2]?.pid);
		});
	}

	it("does not fall back when modern mode is required", async () => {
		await expect(connectToServer("modern-required", config("legacy", "2026-07-28"))).rejects.toThrow(
			"MCP error -32601: Method not found",
		);
		const entries = await readLog(1);
		expect(entries.map(entry => entry.method)).toEqual(["server/discover"]);
		expect(new Set(entries.map(entry => entry.pid)).size).toBe(1);
	});
});
