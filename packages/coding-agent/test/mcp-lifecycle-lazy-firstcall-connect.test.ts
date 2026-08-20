/**
 * Contract: executing a warm-cache lazy server's DeferredMCPTool connects the
 * server on demand (exactly one spawn) and returns the live tool result.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import {
	executeServerTool,
	inMemoryToolCache,
	lazyConfig,
	makeWorkDir,
	resultText,
	spawnCount,
	TOOL_DEF,
} from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: first call connects on demand", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("spawns once on the first tool call and returns the result", async () => {
		const spawnLog = path.join(workDir, "spawns.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", spawnLog });
		await cache.set("lazy", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});
			// Not connected, not spawned yet.
			expect(manager.getConnectionStatus("lazy")).toBe("deferred");
			expect(spawnCount(spawnLog)).toBe(0);

			const result = await executeServerTool(manager, "lazy");

			expect(result.isError).toBeFalsy();
			expect(resultText(result)).toBe("pong");
			expect(spawnCount(spawnLog)).toBe(1);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
