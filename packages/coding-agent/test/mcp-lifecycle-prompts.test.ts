import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import { inMemoryToolCache, lazyConfig, makeWorkDir, spawnCount, waitFor } from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: prompt-capable servers", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("persists capability metadata and reconnects at startup to keep prompts discoverable", async () => {
		const spawnLog = path.join(workDir, "prompt-cache.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", spawnLog, advertisePrompts: true });

		const first = new MCPManager(workDir, cache);
		try {
			await first.connectServers({ lazy: config }, {});
			expect(await waitFor(() => first.getServerPrompts("lazy")?.length === 1)).toBe(true);
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await first.disconnectAll();
		}

		const cached = await cache.getEntry("lazy", config);
		expect(cached?.requiresConnection).toBe(true);

		const second = new MCPManager(workDir, cache);
		try {
			await second.connectServers({ lazy: config }, {});
			expect(await waitFor(() => second.getServerPrompts("lazy")?.length === 1)).toBe(true);
			expect(second.getServerPrompts("lazy")?.[0]?.name).toBe("hello");
			expect(spawnCount(spawnLog)).toBe(2);
		} finally {
			await second.disconnectAll();
		}
	}, 15_000);

	it("does not idle-reap prompt capability when the current list is empty", async () => {
		const spawnLog = path.join(workDir, "empty-prompts.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({
			lifecycle: "lazy",
			idleTimeout: 100,
			spawnLog,
			advertisePrompts: true,
			emptyPrompts: true,
		});

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(await waitFor(() => manager.getServerPrompts("lazy") !== undefined)).toBe(true);
			expect(manager.getServerPrompts("lazy")).toEqual([]);
			// Integration boundary: the production reaper uses an unref'd real timer
			// around a real subprocess, so fake timers cannot drive this transition.
			await Bun.sleep(300);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			expect(manager.getServerPrompts("lazy")).toEqual([]);
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
