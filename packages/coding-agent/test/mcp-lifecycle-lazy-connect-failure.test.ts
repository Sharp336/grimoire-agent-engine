/**
 * Contract: when a lazy server fails to connect on demand, the failure surfaces
 * as a tool ERROR result, not a thrown exception — the session stays usable.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { MCPManager } from "../src/mcp/manager";
import {
	executeServerTool,
	hasServerTool,
	inMemoryToolCache,
	lazyConfig,
	makeWorkDir,
	TOOL_DEF,
} from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: on-demand connect failure", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("returns an error result (does not throw) when the lazy connect fails", async () => {
		const cache = inMemoryToolCache();
		// Cache makes the tool discoverable; the server crashes before `initialize`
		// so every connect attempt fails.
		const config = lazyConfig({ lifecycle: "lazy", crashBeforeInit: true });
		await cache.set("lazy", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});

			const result = await executeServerTool(manager, "lazy");
			expect(result.isError).toBe(true);

			// The manager survives a failed lazy connect and stays usable.
			expect(hasServerTool(manager, "lazy")).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
		// Generous: the on-demand connect failure walks the reconnect backoff
		// (0.5s + 1s + 2s + 4s) before surfacing the error result.
	}, 30_000);
});
