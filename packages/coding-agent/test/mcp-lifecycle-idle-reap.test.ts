/**
 * Contract: after a lazy server goes idle past `idleTimeout`, the manager
 * disconnects it (terminating the subprocess) but keeps its tools registered as
 * deferred placeholders, so the next call transparently re-spawns it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import {
	executeServerTool,
	hasServerTool,
	inMemoryToolCache,
	lazyConfig,
	makeWorkDir,
	resultText,
	spawnCount,
	waitFor,
} from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: idle disconnect and re-spawn", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("idle-disconnects after the timeout and re-spawns on the next call", async () => {
		const spawnLog = path.join(workDir, "spawns.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 150, spawnLog });
		await cache.set("lazy", config, [{ name: "ping", inputSchema: { type: "object" } }]);

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			expect(spawnCount(spawnLog)).toBe(1);

			// Idle reaper fires ~150ms after the call completes.
			expect(await waitFor(() => manager.getConnectionStatus("lazy") === "deferred")).toBe(true);
			// Tools survive the reap as deferred placeholders.
			expect(hasServerTool(manager, "lazy")).toBe(true);

			// Next call transparently re-spawns the server.
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			expect(spawnCount(spawnLog)).toBe(2);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);
	it("keeps a tool refresh live across the idle deadline", async () => {
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 50 });
		await cache.set("lazy", config, [{ name: "ping", inputSchema: { type: "object" } }]);

		const manager = new MCPManager(workDir, cache);
		const { promise: listGate, resolve: releaseList } = Promise.withResolvers<void>();
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			const connection = manager.getConnection("lazy");
			if (!connection) throw new Error("Expected lazy server connection");
			const originalRequest = connection.transport.request.bind(connection.transport);
			let refreshStarted = false;
			connection.transport.request = async (method, params, options) => {
				if (method === "tools/list") {
					refreshStarted = true;
					await listGate;
				}
				return originalRequest(method, params, options);
			};

			const refresh = manager.refreshServerTools("lazy");
			expect(await waitFor(() => refreshStarted)).toBe(true);
			await Bun.sleep(100);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			releaseList();
			await refresh;
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
		} finally {
			releaseList();
			await manager.disconnectAll();
		}
	}, 15_000);

	it("does not overflow long idle timeouts into an immediate reap", async () => {
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 30 * 24 * 60 * 60 * 1000 });
		await cache.set("lazy", config, [{ name: "ping", inputSchema: { type: "object" } }]);

		const manager = new MCPManager(workDir, cache);
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			await Bun.sleep(100);
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
	it("coalesces concurrent tool refreshes for one connection", async () => {
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 5_000 });
		await cache.set("lazy", config, [{ name: "ping", inputSchema: { type: "object" } }]);

		const manager = new MCPManager(workDir, cache);
		const listStarted = Promise.withResolvers<void>();
		const releaseList = Promise.withResolvers<void>();
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			const connection = manager.getConnection("lazy");
			if (!connection) throw new Error("Expected lazy server connection");
			const originalRequest = connection.transport.request.bind(connection.transport);
			let listCalls = 0;
			connection.transport.request = async (method, params, options) => {
				if (method === "tools/list") {
					listCalls++;
					listStarted.resolve();
					await releaseList.promise;
				}
				return originalRequest(method, params, options);
			};

			const first = manager.refreshServerTools("lazy");
			await listStarted.promise;
			const second = manager.refreshServerTools("lazy");
			await Bun.sleep(20);
			expect(listCalls).toBe(1);

			releaseList.resolve();
			await Promise.all([first, second]);
			expect(listCalls).toBe(1);
			expect(hasServerTool(manager, "lazy")).toBe(true);
		} finally {
			releaseList.resolve();
			await manager.disconnectAll();
		}
	}, 15_000);
	it("fences a refresh after a disconnect and same-config reconnect", async () => {
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 5_000 });
		await cache.set("lazy", config, [{ name: "ping", inputSchema: { type: "object" } }]);

		const manager = new MCPManager(workDir, cache);
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let changes = 0;
		let originalClose: (() => Promise<void>) | undefined;
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			const oldConnection = manager.getConnection("lazy");
			if (!oldConnection) throw new Error("Expected lazy server connection");
			originalClose = oldConnection.transport.close.bind(oldConnection.transport);
			oldConnection.transport.close = async () => {};
			const originalRequest = oldConnection.transport.request.bind(oldConnection.transport);
			oldConnection.transport.request = async (method, params, options) => {
				if (method === "tools/list") {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return originalRequest(method, params, options);
			};
			manager.setOnToolsChanged(() => {
				changes++;
			});

			const first = manager.refreshServerTools("lazy");
			await firstStarted.promise;
			await manager.disconnectServer("lazy");
			await manager.connectServers({ lazy: config }, {});
			expect(manager.getConnectionStatus("lazy")).toBe("deferred");
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			changes = 0;
			const second = manager.refreshServerTools("lazy");
			releaseFirst.resolve();
			await Promise.all([first, second]);

			expect(manager.getConnection("lazy")).not.toBe(oldConnection);
			expect(changes).toBe(1);
		} finally {
			releaseFirst.resolve();
			await manager.disconnectAll();
			await originalClose?.();
		}
	}, 15_000);
});
