/**
 * Contract: lifecycle resolution precedence is per-server > manager default. A
 * server with an explicit `lifecycle` ignores `mcp.defaultLifecycle`; a server
 * without one inherits the default.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import { hasServerTool, inMemoryToolCache, lazyConfig, makeWorkDir, spawnCount, TOOL_DEF, waitFor } from "./mcp-lifecycle-harness";

describe("MCP lifecycle precedence: per-server overrides the default", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("an explicit eager server connects even when the default is lazy", async () => {
		const spawnLog = path.join(workDir, "explicit-eager.log");
		const manager = new MCPManager(workDir, inMemoryToolCache());
		manager.setLifecycleDefaults("lazy", 300_000);
		const config = lazyConfig({ lifecycle: "eager", spawnLog });
		try {
			await manager.connectServers({ srv: config }, {});
			// Per-server "eager" wins over the "lazy" default.
			expect(await waitFor(() => manager.getConnectionStatus("srv") === "connected")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("a server without a lifecycle inherits the lazy default (no startup spawn)", async () => {
		const spawnLog = path.join(workDir, "default-lazy.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ spawnLog }); // no per-server lifecycle
		await cache.set("srv", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		manager.setLifecycleDefaults("lazy", 300_000);
		try {
			await manager.connectServers({ srv: config }, {});
			// Inherited lazy → advertised from cache, not spawned.
			expect(manager.getConnectionStatus("srv")).toBe("disconnected");
			expect(hasServerTool(manager, "srv")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(0);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
