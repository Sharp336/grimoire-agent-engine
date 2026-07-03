/**
 * Contract: the idle reaper never disconnects a lazy server while a tool call
 * is in flight. An in-flight call holds the per-server refcount, so the idle
 * timer is not armed until the call finishes — the connection survives an
 * elapsed `idleTimeout` mid-call.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { MCPManager } from "../src/mcp/manager";
import {
	executeServerTool,
	inMemoryToolCache,
	lazyConfig,
	makeWorkDir,
	resultText,
	TOOL_DEF,
	waitFor,
} from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: no idle disconnect mid-call", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("keeps the connection alive across an elapsed idleTimeout while a call runs", async () => {
		const cache = inMemoryToolCache();
		// idleTimeout (100ms) is far shorter than the call (600ms): a naive reaper
		// would fire mid-call.
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 100, callDelayMs: 600 });
		await cache.set("lazy", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});

			// Start a slow call but do not await it yet.
			const callPromise = executeServerTool(manager, "lazy");
			expect(await waitFor(() => manager.getConnectionStatus("lazy") === "connected")).toBe(true);

			// Genuine integration wait: let the idle window (100ms) elapse WHILE the
			// 600ms call is still in flight. Fake timers cannot drive the real
			// subprocess call, so a real delay is the only way to exercise this.
			await Bun.sleep(300);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");

			expect(resultText(await callPromise)).toBe("pong");
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);
});
