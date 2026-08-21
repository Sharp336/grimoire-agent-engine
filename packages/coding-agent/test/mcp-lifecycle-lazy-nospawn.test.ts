/**
 * Contract: a lazy server with a WARM tool cache advertises its tools as
 * DeferredMCPTool placeholders WITHOUT spawning the subprocess at startup.
 * This is the memory win — the whole point of `lifecycle: "lazy"`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import {
	hasServerTool,
	inMemoryToolCache,
	lazyConfig,
	makeWorkDir,
	spawnCount,
	TOOL_DEF,
	waitFor,
} from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: warm cache does not spawn", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("advertises cached tools as deferred and never spawns the server", async () => {
		const spawnLog = path.join(workDir, "spawns.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", spawnLog });
		// Seed the cache so the server's tools are known without connecting.
		await cache.set("lazy", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		try {
			const result = await manager.connectServers({ lazy: config }, {});

			expect(manager.getConnectionStatus("lazy")).toBe("deferred");
			expect(hasServerTool(manager, "lazy")).toBe(true);
			expect(result.tools.length).toBeGreaterThan(0);
			expect(result.connectedServers).not.toContain("lazy");
			// The subprocess was never started.
			expect(spawnCount(spawnLog)).toBe(0);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("connects from a warm cache and stays live for tool-list changes", async () => {
		const spawnLog = path.join(workDir, "list-changed.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({
			lifecycle: "lazy",
			idleTimeout: 50,
			spawnLog,
			advertiseToolListChanged: true,
		});

		const first = new MCPManager(workDir, cache);
		try {
			await first.connectServers({ lazy: config }, {});
			expect(await waitFor(() => first.getConnectionStatus("lazy") === "connected")).toBe(true);
			expect(await waitFor(async () => (await cache.getEntry("lazy", config))?.requiresConnection === true)).toBe(
				true,
			);
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await first.disconnectAll();
		}

		const second = new MCPManager(workDir, cache);
		try {
			await second.connectServers({ lazy: config }, {});
			expect(second.getConnectionStatus("lazy")).toBe("connected");
			expect(spawnCount(spawnLog)).toBe(2);
			await Bun.sleep(300);
			expect(second.getConnectionStatus("lazy")).toBe("connected");
		} finally {
			await second.disconnectAll();
		}
	}, 20_000);

	it("removes stale deferred tools before rejecting an invalid replacement", async () => {
		const spawnLog = path.join(workDir, "stale-replacement.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", spawnLog });
		await cache.set("lazy", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(manager.getConnectionStatus("lazy")).toBe("deferred");
			const staleTool = manager.getTools().find(tool => tool.mcpServerName === "lazy");
			expect(staleTool).toBeDefined();
			if (!staleTool) throw new Error("Expected a deferred tool for the warm cache");

			const invalidConfig = { ...config, command: "" };
			const result = await manager.connectServers({ lazy: invalidConfig }, {});

			expect(result.errors.get("lazy")).toContain('Server "lazy": stdio server requires "command" field');
			expect(manager.getConnectionStatus("lazy")).toBe("disconnected");
			expect(manager.getServerConfig("lazy")).toBeUndefined();
			expect(manager.getTools()).not.toContain(staleTool);

			await staleTool.execute("stale-call", {}, undefined, undefined as never, undefined as never);
			expect(spawnCount(spawnLog)).toBe(0);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
