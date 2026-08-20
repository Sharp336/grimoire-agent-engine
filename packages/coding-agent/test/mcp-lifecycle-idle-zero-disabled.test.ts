/**
 * Contract: `idleTimeout: 0` disables idle disconnect. A lazy server connects on
 * first use and then stays connected — it is never reaped.
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

describe("MCP lazy lifecycle: idleTimeout 0 disables reaping", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("connects on first use then never idle-disconnects", async () => {
		const spawnLog = path.join(workDir, "spawns.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 0, spawnLog });
		await cache.set("lazy", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			expect(manager.getConnectionStatus("lazy")).toBe("connected");

			// Genuine integration wait: idleTimeout 0 must arm no reaper, so let real
			// wall-clock pass and confirm the connection is still up. Fake timers
			// cannot stand in for "no timer was scheduled at all".
			await Bun.sleep(300);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
