/**
 * Contract: a lazy server with a COLD cache (no known tools) connects once at
 * startup to populate the cache and advertise its real tools. A later session
 * reading the now-warm cache must connect lazily (no startup spawn).
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

describe("MCP lazy lifecycle: cold cache populates once", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("connects once on a cold cache, then a warm-cache session does not spawn", async () => {
		const spawnLog = path.join(workDir, "spawns.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", spawnLog });

		const first = new MCPManager(workDir, cache);
		try {
			await first.connectServers({ lazy: config }, {});
			// Cold cache → fall through to a one-time connect this session.
			expect(await waitFor(() => first.getConnectionStatus("lazy") === "connected")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(1);
			expect(hasServerTool(first, "lazy")).toBe(true);
			// Cache is populated for the next session.
			expect(await waitFor(async () => (await cache.get("lazy", config)) !== null)).toBe(true);
		} finally {
			await first.disconnectAll();
		}

		// Second session over the now-warm cache must advertise from cache only.
		const second = new MCPManager(workDir, cache);
		try {
			await second.connectServers({ lazy: config }, {});
			expect(second.getConnectionStatus("lazy")).toBe("disconnected");
			expect(hasServerTool(second, "lazy")).toBe(true);
			// No additional spawn — still just the one from the cold-cache session.
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await second.disconnectAll();
		}
	}, 20_000);
});
