/**
 * Shared helpers for the MCP lifecycle (lazy/eager + idleTimeout) test suites.
 *
 * NOT a test file — the `.ts` (not `.test.ts`) suffix keeps the bun runner from
 * executing it. Imported by the `mcp-lifecycle-*.test.ts` suites so each can
 * stay focused on one contract.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomToolResult } from "../src/extensibility/custom-tools/types";
import type { MCPManager } from "../src/mcp/manager";
import type { MCPToolDetails } from "../src/mcp/tool-bridge";
import { MCPToolCache } from "../src/mcp/tool-cache";
import type { MCPStdioServerConfig, MCPToolDefinition } from "../src/mcp/types";
import type { AgentStorage } from "../src/session/agent-storage";
import { LAZY_TOOL_NAME } from "./fixtures/lazy-lifecycle-mcp";

export { LAZY_TOOL_NAME };
export const FIXTURE = path.join(import.meta.dir, "fixtures", "lazy-lifecycle-mcp.ts");
export const BUN = process.execPath;

/** Single tool definition matching what the fixture advertises. */
export const TOOL_DEF: MCPToolDefinition = {
	name: LAZY_TOOL_NAME,
	description: "Lazy fixture tool",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export function makeWorkDir(prefix = "omp-mcp-lifecycle-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal in-memory MCPToolCache backed by a Map (getCache/setCache only). */
export function inMemoryToolCache(): MCPToolCache {
	const store = new Map<string, string>();
	const storage = {
		getCache: (key: string) => store.get(key) ?? null,
		setCache: (key: string, value: string) => {
			store.set(key, value);
		},
	} as unknown as AgentStorage;
	return new MCPToolCache(storage);
}

export interface LazyConfigOptions {
	lifecycle?: "lazy" | "eager";
	idleTimeout?: number;
	/** File the fixture appends a `spawn` line to on each startup. */
	spawnLog?: string;
	/** Make the fixture exit before `initialize` so the connect fails. */
	crashBeforeInit?: boolean;
	/** Delay each `tools/call` response by this many ms (hold a call in-flight). */
	callDelayMs?: number;
}

export function lazyConfig(options: LazyConfigOptions = {}): MCPStdioServerConfig {
	const env: Record<string, string> = {};
	if (options.spawnLog) env.MCP_SPAWN_LOG = options.spawnLog;
	if (options.crashBeforeInit) env.MCP_CRASH_BEFORE_INIT = "1";
	if (options.callDelayMs) env.MCP_CALL_DELAY_MS = String(options.callDelayMs);

	const config: MCPStdioServerConfig = { type: "stdio", command: BUN, args: [FIXTURE] };
	if (options.lifecycle) config.lifecycle = options.lifecycle;
	if (options.idleTimeout !== undefined) config.idleTimeout = options.idleTimeout;
	if (Object.keys(env).length > 0) config.env = env;
	return config;
}

/**
 * Genuine integration wait: lifecycle transitions (connect, idle-disconnect)
 * run fire-and-forget against a REAL MCP subprocess and expose no awaitable
 * signal; fake timers cannot drive a child process. Poll a predicate with a
 * generous ceiling, returning as soon as it holds.
 */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(20);
	}
}

/** Count the `spawn` lines a fixture appended to its spawn log (0 if never spawned). */
export function spawnCount(spawnLog: string): number {
	if (!fs.existsSync(spawnLog)) return 0;
	return fs
		.readFileSync(spawnLog, "utf8")
		.split("\n")
		.filter(line => line.startsWith("spawn")).length;
}

/** Find a server's registered tool and invoke it through the agent tool interface. */
export async function executeServerTool(
	manager: MCPManager,
	serverName: string,
	args: Record<string, unknown> = {},
): Promise<CustomToolResult<MCPToolDetails>> {
	const tool = manager.getTools().find(t => (t as unknown as { mcpServerName?: string }).mcpServerName === serverName);
	if (!tool) throw new Error(`No tool registered for MCP server "${serverName}"`);
	return tool.execute("call-1", args, undefined, {} as Parameters<typeof tool.execute>[3], undefined) as Promise<
		CustomToolResult<MCPToolDetails>
	>;
}

/** True when a server has a tool registered in the manager. */
export function hasServerTool(manager: MCPManager, serverName: string): boolean {
	return manager.getTools().some(t => (t as unknown as { mcpServerName?: string }).mcpServerName === serverName);
}

/** Extract the joined text content of a tool result. */
export function resultText(result: CustomToolResult<MCPToolDetails>): string {
	return result.content
		.map(part => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}
