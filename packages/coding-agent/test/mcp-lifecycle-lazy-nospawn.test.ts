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
});
