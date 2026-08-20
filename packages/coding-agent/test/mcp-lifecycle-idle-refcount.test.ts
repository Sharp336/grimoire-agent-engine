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
	for (const resetMode of ["server", "all"] as const) {
		it(`ignores a stale completion after disconnect${resetMode === "all" ? "All" : "Server"}`, async () => {
			const cache = inMemoryToolCache();
			const callLog = `${workDir}/calls.log`;
			const config = lazyConfig({
				lifecycle: "lazy",
				idleTimeout: 100,
				initializeDelayMs: 250,
				callDelayMs: 600,
				callLog,
			});
			await cache.set("lazy", config, [TOOL_DEF]);

			const manager = new MCPManager(workDir, cache);
			try {
				await manager.connectServers({ lazy: config }, {});
				const oldTool = manager.getTools()[0];
				if (!oldTool) throw new Error("missing cached lazy tool");
				const oldAbort = new AbortController();
				const oldCall = oldTool.execute(
					"old-call",
					{},
					undefined,
					{} as Parameters<typeof oldTool.execute>[3],
					oldAbort.signal,
				);
				expect(await waitFor(() => manager.getConnectionStatus("lazy") === "connecting")).toBe(true);

				if (resetMode === "all") await manager.disconnectAll();
				else await manager.disconnectServer("lazy");

				await manager.connectServers({ lazy: config }, {});
				const replacementTool = manager.getTools()[0];
				if (!replacementTool) throw new Error("missing replacement lazy tool");
				const replacementCall = replacementTool.execute(
					"replacement-call",
					{},
					undefined,
					{} as Parameters<typeof replacementTool.execute>[3],
					undefined,
				);
				expect(
					await waitFor(() => fs.existsSync(callLog) && fs.readFileSync(callLog, "utf8").includes("call ")),
				).toBe(true);

				// Release the old completion only after the replacement generation has
				// entered its call. A name-only refcount would now decrement the
				// replacement call to zero and arm its idle reaper.
				oldAbort.abort();
				await oldCall.catch(() => undefined);
				expect(await waitFor(() => manager.getConnectionStatus("lazy") === "disconnected", 500)).toBe(false);
				expect(resultText(await replacementCall)).toBe("pong");
			} finally {
				await manager.disconnectAll();
			}
		}, 20_000);
	}
});
