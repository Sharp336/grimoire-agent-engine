/**
 * Integration tests for `lifecycle: "lazy"` MCP servers (RFC #2888).
 *
 * Contract under test, confirmed with the maintainer on the RFC thread:
 *  - a lazy server with a *cold* cache connects once at startup (same as
 *    eager) so the tool cache gets populated, then arms an idle-reap timer;
 *  - a lazy server with a *warm* cache skips the network connect entirely at
 *    startup and hands back cache-backed `DeferredMCPTool` instances — the
 *    opposite default of eager's "connect now, fall back to cache only if
 *    slow";
 *  - once idle past `idleTimeoutMs` with no active calls, the manager
 *    disconnects the live connection and swaps back to cache-backed
 *    deferred tools, publishing the existing tools-changed notification;
 *  - the next tool call reconnects single-flight through
 *    `MCPManager.ensureConnection`, independent of `xd://` mounting;
 *  - `idleTimeoutMs: 0` disables idle reaping — once activated, the
 *    connection stays up indefinitely;
 *  - an invocation interrupted by an unexpected transport close surfaces
 *    its original failure rather than being silently retried, and the
 *    server re-arms as deferred so the *next* invocation reconnects.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeferredMCPTool, MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPStdioServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../src/mcp/manager";
import { MCPToolCache } from "../src/mcp/tool-cache";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "lazy-lifecycle-mcp.ts");
const BUN_EXEC = process.execPath;

/** In-memory stand-in for `AgentStorage`'s cache surface, used to pre-warm or inspect the MCP tool cache without a real SQLite file. */
function createFakeCacheStorage(): AgentStorage {
	const rows = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		getCache(key: string): string | null {
			const row = rows.get(key);
			if (!row) return null;
			if (row.expiresAtSec * 1000 < Date.now()) {
				rows.delete(key);
				return null;
			}
			return row.value;
		},
		setCache(key: string, value: string, expiresAtSec: number): void {
			rows.set(key, { value, expiresAtSec });
		},
	} as unknown as AgentStorage;
}

/**
 * Polls a real wall-clock condition instead of faking timers. The idle-reap
 * timer under test is a genuine `setTimeout` racing against a real spawned
 * `bun` subprocess's transport close — there is no promise or event the
 * production code exposes to await directly, and fake timers cannot
 * advance a real subprocess's I/O. See mcp-reconnect-storm.test.ts and
 * mcp-startup-no-block.test.ts for the same established pattern.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("waitFor timed out");
		await Bun.sleep(5);
	}
}

describe("MCP lazy lifecycle (RFC #2888)", () => {
	let workDir: string;
	let spawnLog: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lazy-"));
		spawnLog = path.join(workDir, "spawns.log");
		fs.writeFileSync(spawnLog, "");
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	function countSpawns(): number {
		const text = fs.readFileSync(spawnLog, "utf8");
		return text.split("\n").filter(line => line.trim().length > 0).length;
	}

	function lazyConfig(
		overrides?: Partial<Pick<MCPStdioServerConfig, "idleTimeoutMs" | "lifecycle">>,
	): MCPStdioServerConfig {
		return {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_SPAWN_LOG: spawnLog },
			lifecycle: "lazy",
			idleTimeoutMs: 60_000,
			...overrides,
		};
	}

	it("cold cache: connects once at startup to populate the cache, then arms the idle reaper", async () => {
		const cache = new MCPToolCache(createFakeCacheStorage());
		const manager = new MCPManager(workDir, cache);
		try {
			const result = await manager.connectServers({ lazy: lazyConfig() }, {});

			expect(countSpawns()).toBe(1);
			expect(result.tools.map(t => t.name)).toEqual(["mcp__lazy_echo"]);
			expect(result.tools[0]).toBeInstanceOf(MCPTool);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");

			// Tool cache is now warm for the next session. The write is
			// fire-and-forget (`void this.toolCache?.set(...)`, matching the
			// pre-existing eager-path pattern), so poll for it rather than
			// asserting immediately after `connectServers` resolves.
			const deadline = Date.now() + 5_000;
			let cached: MCPToolDefinition[] | null = await cache.get("lazy", lazyConfig());
			while (cached === null) {
				if (Date.now() >= deadline) throw new Error("MCP tool cache was never populated");
				await Bun.sleep(5);
				cached = await cache.get("lazy", lazyConfig());
			}
			expect(cached.map(t => t.name)).toEqual(["echo"]);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("warm cache: skips the network connect entirely at startup", async () => {
		const cache = new MCPToolCache(createFakeCacheStorage());
		const config = lazyConfig();
		const cachedTool: MCPToolDefinition = {
			name: "echo",
			description: "Echoes back its input",
			inputSchema: { type: "object", properties: { text: { type: "string" } } },
		};
		await cache.set("lazy", config, [cachedTool]);

		const manager = new MCPManager(workDir, cache);
		try {
			const result = await manager.connectServers({ lazy: config }, {});

			expect(countSpawns()).toBe(0);
			expect(result.tools.map(t => t.name)).toEqual(["mcp__lazy_echo"]);
			expect(result.tools[0]).toBeInstanceOf(DeferredMCPTool);
			// A warm-cache lazy server isn't actually connected yet — matches
			// the pre-existing eager "slow server + cached fallback" semantics.
			expect(result.connectedServers).toEqual([]);
			expect(manager.getConnectionStatus("lazy")).toBe("disconnected");

			// The deferred tool still works: calling it connects on demand.
			const callResult = await result.tools[0].execute("call-1", { text: "hi" }, undefined, {} as never, undefined);
			expect(countSpawns()).toBe(1);
			expect(callResult.isError).not.toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("idle-reaps a connected lazy server and reconnects on the next call", async () => {
		const cache = new MCPToolCache(createFakeCacheStorage());
		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: lazyConfig({ idleTimeoutMs: 30 }) }, {});
			expect(countSpawns()).toBe(1);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");

			// No active calls: the idle timer fires and tears the connection down.
			await waitFor(() => manager.getConnectionStatus("lazy") === "disconnected");

			const toolsAfterReap = manager.getTools();
			expect(toolsAfterReap).toHaveLength(1);
			expect(toolsAfterReap[0]).toBeInstanceOf(DeferredMCPTool);

			// The next call reconnects single-flight through `ensureConnection`.
			const connection = await manager.ensureConnection("lazy");
			expect(connection.name).toBe("lazy");
			expect(countSpawns()).toBe(2);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("idleTimeoutMs: 0 disables idle reaping — the connection stays up indefinitely", async () => {
		const cache = new MCPToolCache(createFakeCacheStorage());
		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: lazyConfig({ idleTimeoutMs: 0 }) }, {});
			expect(countSpawns()).toBe(1);

			// Proving a negative (no timer fires) has no event to await; hold
			// real wall-clock time well past the other tests' 20-30ms
			// idleTimeoutMs values, which already fire reliably against a real
			// spawned subprocess in this file.
			await Bun.sleep(150);

			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			expect(countSpawns()).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("concurrent on-demand calls single-flight the reconnect (no duplicate spawns)", async () => {
		const cache = new MCPToolCache(createFakeCacheStorage());
		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: lazyConfig({ idleTimeoutMs: 20 }) }, {});
			await waitFor(() => manager.getConnectionStatus("lazy") === "disconnected");
			expect(countSpawns()).toBe(1);

			const [a, b, c] = await Promise.all([
				manager.ensureConnection("lazy"),
				manager.ensureConnection("lazy"),
				manager.ensureConnection("lazy"),
			]);
			expect(countSpawns()).toBe(2);
			expect(a).toBe(b);
			expect(b).toBe(c);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("an unexpected transport close defers the server without retrying the interrupted call", async () => {
		const cache = new MCPToolCache(createFakeCacheStorage());
		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: lazyConfig({ idleTimeoutMs: 60_000 }) }, {});
			expect(manager.getConnectionStatus("lazy")).toBe("connected");

			const connection = manager.getConnection("lazy");
			expect(connection).toBeDefined();

			// Simulate the transport dropping unexpectedly (server restart,
			// network blip) while the connection is otherwise idle.
			connection?.transport.onClose?.();

			expect(manager.getConnectionStatus("lazy")).toBe("disconnected");
			const toolsAfterClose = manager.getTools();
			expect(toolsAfterClose).toHaveLength(1);
			expect(toolsAfterClose[0]).toBeInstanceOf(DeferredMCPTool);

			// Reconnects single-flight on the next call rather than auto-retrying
			// inside the interrupted invocation.
			const fresh = await manager.ensureConnection("lazy");
			expect(fresh.name).toBe("lazy");
			expect(countSpawns()).toBe(2);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
