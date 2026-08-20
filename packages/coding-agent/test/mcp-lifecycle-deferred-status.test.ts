import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { MCPManager } from "../src/mcp/manager";
import type { McpConnectionStatusEvent } from "../src/mcp/startup-events";
import { inMemoryToolCache, lazyConfig, makeWorkDir, TOOL_DEF } from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: deferred startup status", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("settles a cache-backed server after announcing it as connecting", async () => {
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy" });
		await cache.set("lazy", config, [TOOL_DEF]);
		const events: McpConnectionStatusEvent[] = [];

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {}, event => events.push(event));
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["lazy"] },
				{ type: "connected", serverName: "lazy" },
			]);
			expect(manager.getConnectionStatus("lazy")).toBe("disconnected");
		} finally {
			await manager.disconnectAll();
		}
	});
});
