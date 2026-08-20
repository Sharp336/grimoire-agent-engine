/**
 * Contract: after a lazy server goes idle past `idleTimeout`, the manager
 * disconnects it (terminating the subprocess) but keeps its tools registered as
 * deferred placeholders, so the next call transparently re-spawns it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import {
	executeServerTool,
	hasServerTool,
	inMemoryToolCache,
	lazyConfig,
	makeWorkDir,
	resultText,
	spawnCount,
	waitFor,
} from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: idle disconnect and re-spawn", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("idle-disconnects after the timeout and re-spawns on the next call", async () => {
		const spawnLog = path.join(workDir, "spawns.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 150, spawnLog });
		await cache.set("lazy", config, [{ name: "ping", inputSchema: { type: "object" } }]);

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			expect(spawnCount(spawnLog)).toBe(1);

			// Idle reaper fires ~150ms after the call completes.
			expect(await waitFor(() => manager.getConnectionStatus("lazy") === "disconnected")).toBe(true);
			// Tools survive the reap as deferred placeholders.
			expect(hasServerTool(manager, "lazy")).toBe(true);

			// Next call transparently re-spawns the server.
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			expect(spawnCount(spawnLog)).toBe(2);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);
});
