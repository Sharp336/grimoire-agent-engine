/**
 * Contract: `lifecycle: "eager"` (and the absent-with-default-"eager" case)
 * preserve today's behavior — the server is connected (spawned) at startup.
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
	waitFor,
} from "./mcp-lifecycle-harness";

describe("MCP eager lifecycle: connects at startup", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("spawns an explicit eager server at startup", async () => {
		const spawnLog = path.join(workDir, "eager.log");
		const manager = new MCPManager(workDir, inMemoryToolCache());
		const config = lazyConfig({ lifecycle: "eager", spawnLog });
		try {
			await manager.connectServers({ srv: config }, {});
			expect(await waitFor(() => manager.getConnectionStatus("srv") === "connected")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(1);
			expect(hasServerTool(manager, "srv")).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("treats an absent lifecycle as eager (default) and spawns at startup", async () => {
		const spawnLog = path.join(workDir, "default.log");
		// No setLifecycleDefaults call → manager default lifecycle is "eager".
		const manager = new MCPManager(workDir, inMemoryToolCache());
		const config = lazyConfig({ spawnLog });
		try {
			await manager.connectServers({ srv: config }, {});
			expect(await waitFor(() => manager.getConnectionStatus("srv") === "connected")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
