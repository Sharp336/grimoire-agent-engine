/**
 * Internal manager contract: only the exact value `lazy` defers startup.
 * Capability validation rejects unknown public configuration values before
 * they reach this layer; this pins the manager's fail-eager fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import { inMemoryToolCache, lazyConfig, makeWorkDir, spawnCount, waitFor } from "./mcp-lifecycle-harness";

describe("MCP lifecycle: unknown internal values never defer", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("connects a server with an unknown internal value at startup", async () => {
		const spawnLog = path.join(workDir, "unknown.log");
		const config = lazyConfig({ spawnLog });
		// Force a value outside the supported union; only "lazy" defers.
		(config as unknown as { lifecycle: string }).lifecycle = "keep-alive";

		const manager = new MCPManager(workDir, inMemoryToolCache());
		try {
			await manager.connectServers({ srv: config }, {});
			expect(await waitFor(() => manager.getConnectionStatus("srv") === "connected")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
