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

	it("does not announce a cache-backed lazy server as connected", async () => {
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy" });
		await cache.set("lazy", config, [TOOL_DEF]);
		const events: McpConnectionStatusEvent[] = [];

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {}, event => events.push(event));
			expect(events).toEqual([]);
			expect(manager.getConnectionStatus("lazy")).toBe("deferred");
		} finally {
			await manager.disconnectAll();
		}
	});
	it("reports only real startup connections when cached and eager servers are mixed", async () => {
		const cache = inMemoryToolCache();
		const cachedConfig = lazyConfig({ lifecycle: "lazy" });
		const eagerConfig = lazyConfig({ lifecycle: "eager" });
		await cache.set("cached", cachedConfig, [TOOL_DEF]);
		const events: McpConnectionStatusEvent[] = [];

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ cached: cachedConfig, eager: eagerConfig }, {}, event => events.push(event));
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["eager"] },
				{ type: "connected", serverName: "eager" },
			]);
			expect(manager.getConnectionStatus("cached")).toBe("deferred");
			expect(manager.getConnectionStatus("eager")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	});
});
