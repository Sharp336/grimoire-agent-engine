/**
 * Contract: `keep-alive` was deliberately dropped — only `lazy` and `eager`
 * exist. Any non-"lazy" lifecycle value (including a legacy "keep-alive") is
 * treated as eager and connects at startup. Pins the "no keep-alive code path"
 * decision so a future reader does not reintroduce it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import { inMemoryToolCache, lazyConfig, makeWorkDir, spawnCount, waitFor } from "./mcp-lifecycle-harness";

describe("MCP lifecycle: legacy keep-alive is treated as eager", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("connects a 'keep-alive' server at startup, like eager", async () => {
		const spawnLog = path.join(workDir, "keepalive.log");
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
