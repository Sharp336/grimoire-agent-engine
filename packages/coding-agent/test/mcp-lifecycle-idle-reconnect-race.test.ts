import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import {
	executeServerTool,
	inMemoryToolCache,
	lazyConfig,
	makeWorkDir,
	resultText,
	spawnCount,
	TOOL_DEF,
	waitFor,
} from "./mcp-lifecycle-harness";

describe("MCP lazy lifecycle: idle close race", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("cannot evict a newer connection after the old transport close settles", async () => {
		const spawnLog = path.join(workDir, "race.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 50, spawnLog });
		await cache.set("lazy", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		const { promise: closeGate, resolve: releaseClose } = Promise.withResolvers<void>();
		let closeStarted = false;
		try {
			await manager.connectServers({ lazy: config }, {});
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			const original = manager.getConnection("lazy");
			expect(original).toBeDefined();
			original!.transport.close = async () => {
				closeStarted = true;
				await closeGate;
			};

			expect(await waitFor(() => closeStarted)).toBe(true);
			const replacement = await manager.reconnectServer("lazy", { manual: true });
			if (!replacement) throw new Error("Expected reconnect to succeed");
			expect(replacement).not.toBe(original);
			expect(spawnCount(spawnLog)).toBe(2);

			releaseClose();
			await closeGate;
			expect(manager.getConnection("lazy")).toBe(replacement);
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
		} finally {
			releaseClose();
			await manager.disconnectAll();
		}
	}, 15_000);
	it("blocks a deferred tool from connecting while disconnectAll awaits close", async () => {
		const lazySpawnLog = path.join(workDir, "teardown-lazy.log");
		const cache = inMemoryToolCache();
		const lazy = lazyConfig({ lifecycle: "lazy", spawnLog: lazySpawnLog });
		const eager = lazyConfig({ lifecycle: "eager" });
		await cache.set("lazy", lazy, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		const { promise: closeGate, resolve: releaseClose } = Promise.withResolvers<void>();
		let closeStarted = false;
		try {
			await manager.connectServers({ lazy, eager }, {});
			const deferredTool = manager
				.getTools()
				.find(tool => (tool as unknown as { mcpServerName?: string }).mcpServerName === "lazy");
			if (!deferredTool) throw new Error("Expected deferred lazy tool");
			const eagerConnection = manager.getConnection("eager");
			if (!eagerConnection) throw new Error("Expected eager server connection");
			eagerConnection.transport.close = async () => {
				closeStarted = true;
				await closeGate;
			};

			const teardown = manager.disconnectAll();
			expect(await waitFor(() => closeStarted)).toBe(true);
			const result = await deferredTool.execute(
				"teardown-call",
				{},
				undefined,
				{} as Parameters<typeof deferredTool.execute>[3],
				undefined,
			);
			const text = resultText(result);
			const spawns = spawnCount(lazySpawnLog);
			const leaked = manager.getConnection("lazy");
			if (leaked) {
				leaked.transport.onClose = undefined;
				await leaked.transport.close();
			}
			releaseClose();
			await teardown;

			expect(text).toContain("not connected");
			expect(spawns).toBe(0);
		} finally {
			releaseClose();
			await manager.disconnectAll();
		}
	}, 15_000);
	it("does not publish a warm cache result after disconnectAll starts", async () => {
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy" });
		await cache.set("lazy", config, [TOOL_DEF]);

		const lookupStarted = Promise.withResolvers<void>();
		const releaseLookup = Promise.withResolvers<void>();
		const originalGetEntry = cache.getEntry.bind(cache);
		cache.getEntry = async (serverName, serverConfig) => {
			lookupStarted.resolve();
			await releaseLookup.promise;
			return originalGetEntry(serverName, serverConfig);
		};

		const manager = new MCPManager(workDir, cache);
		try {
			const connecting = manager.connectServers({ lazy: config }, {});
			await lookupStarted.promise;

			const tearingDown = manager.disconnectAll();
			releaseLookup.resolve();
			await tearingDown;
			await connecting;

			expect(manager.getTools()).toHaveLength(0);
			expect(manager.getConnectionStatus("lazy")).toBe("disconnected");
			expect(manager.getAllServerNames()).toEqual([]);

			// The same manager remains usable after teardown completes.
			await manager.connectServers({ lazy: config }, {});
			expect(manager.getConnectionStatus("lazy")).toBe("deferred");
		} finally {
			releaseLookup.resolve();
			await manager.disconnectAll();
		}
	}, 15_000);
	it("does not publish tools when listTools completes after disconnectAll", async () => {
		const releasePath = path.join(workDir, "release-list");
		const listStartedPath = path.join(workDir, "list-started");
		const serverPath = path.join(workDir, "delayed-list.ts");
		const serverSource = [
			'import * as fs from "node:fs";',
			'import * as readline from "node:readline";',
			"const rl = readline.createInterface({ input: process.stdin });",
			'rl.on("line", line => { void (async () => {',
			"  const message = JSON.parse(line);",
			"  if (message.id === undefined) return;",
			"  let result;",
			'  if (message.method === "initialize") {',
			'    result = { protocolVersion: "2025-03-26", serverInfo: { name: "delayed-list", version: "1" }, capabilities: { tools: {} } };',
			'  } else if (message.method === "tools/list") {',
			`    fs.writeFileSync(${JSON.stringify(listStartedPath)}, "started");`,
			`    while (!fs.existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(5);`,
			`    result = { tools: [${JSON.stringify(TOOL_DEF)}] };`,
			'  } else if (message.method === "tools/call") {',
			'    result = { content: [{ type: "text", text: "pong" }] };',
			"  } else {",
			"    result = {};",
			"  }",
			'  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
			"})(); });",
		].join("\n");
		fs.writeFileSync(serverPath, serverSource);

		const config = lazyConfig({ lifecycle: "eager" });
		config.args = [serverPath];
		const manager = new MCPManager(workDir);
		let originalClose: (() => Promise<void>) | undefined;
		try {
			const connecting = manager.connectServers({ delayed: config }, {});
			expect(await waitFor(() => fs.existsSync(listStartedPath))).toBe(true);
			const connection = manager.getConnection("delayed");
			if (!connection) throw new Error("Expected delayed-list connection");
			originalClose = connection.transport.close.bind(connection.transport);
			connection.transport.close = async () => {};

			const tearingDown = manager.disconnectAll();
			fs.writeFileSync(releasePath, "released");
			await tearingDown;
			await connecting;

			expect(manager.getTools()).toHaveLength(0);
			expect(manager.getConnection("delayed")).toBeUndefined();
		} finally {
			fs.writeFileSync(releasePath, "released");
			await manager.disconnectAll();
			await originalClose?.();
		}
	}, 15_000);
	it("aborts reconnect retries after a same-epoch config replacement", async () => {
		const spawnLog = path.join(workDir, "config-replacement.log");
		const initialConfig = lazyConfig({ lifecycle: "eager", spawnLog });
		const failedConfig = lazyConfig({ lifecycle: "eager", crashBeforeInit: true, spawnLog });
		const replacementConfig = lazyConfig({ lifecycle: "eager", crashBeforeInit: true, spawnLog });
		const manager = new MCPManager(workDir);
		let reconnecting: Promise<Awaited<ReturnType<typeof manager.reconnectServer>>> | undefined;
		try {
			await manager.connectServers({ lazy: initialConfig }, {});
			manager.setAuthHandler(async () => failedConfig);
			reconnecting = manager.reconnectServer("lazy", {
				manual: true,
				authChallenge: { wwwAuthenticate: ["Bearer"] },
			});
			expect(await waitFor(() => spawnCount(spawnLog) >= 2)).toBe(true);

			await Bun.sleep(50);
			await manager.connectServers({ lazy: replacementConfig }, {});
			const spawnCountAfterReplacement = spawnCount(spawnLog);
			await Bun.sleep(700);
			expect(spawnCount(spawnLog)).toBe(spawnCountAfterReplacement);
			await reconnecting;
		} finally {
			await manager.disconnectAll();
			await reconnecting;
		}
	}, 15_000);
	it("preserves unrequested tools across partial connects", async () => {
		const cache = inMemoryToolCache();
		const manager = new MCPManager(workDir, cache);
		const serverNames = () => Array.from(new Set(manager.getTools().map(tool => tool.mcpServerName))).sort();
		try {
			await manager.connectServers({ a: lazyConfig({ lifecycle: "eager" }) }, {});
			expect(serverNames()).toEqual(["a"]);

			await manager.connectServers({ b: lazyConfig({ lifecycle: "eager" }) }, {});
			expect(serverNames()).toEqual(["a", "b"]);

			const emptyLazy = lazyConfig({ lifecycle: "lazy" });
			await cache.set("empty", emptyLazy, []);
			await manager.connectServers({ empty: emptyLazy }, {});
			expect(manager.getConnectionStatus("empty")).toBe("deferred");
			expect(serverNames()).toEqual(["a", "b"]);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
	it("does not disable reconnects when a live config is replaced", async () => {
		const spawnLog = path.join(workDir, "live-config-replacement.log");
		const initialConfig = lazyConfig({ lifecycle: "eager", spawnLog });
		const replacementConfig = lazyConfig({ lifecycle: "eager", crashBeforeInit: true, spawnLog });
		const manager = new MCPManager(workDir);
		try {
			await manager.connectServers({ lazy: initialConfig }, {});
			const original = manager.getConnection("lazy");
			if (!original) throw new Error("Expected initial connection");

			await manager.connectServers({ lazy: replacementConfig }, {});
			expect(manager.getServerConfig("lazy")).toBe(initialConfig);
			original.transport.onClose?.();
			expect(await waitFor(() => spawnCount(spawnLog) >= 2)).toBe(true);
			expect(manager.getConnection("lazy")).not.toBe(original);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
	it("connects a replacement config after cancelling a pending reconnect", async () => {
		const spawnLog = path.join(workDir, "pending-replacement.log");
		const initialConfig = lazyConfig({ lifecycle: "eager", spawnLog });
		const failedConfig = lazyConfig({ lifecycle: "eager", crashBeforeInit: true, spawnLog });
		const replacementConfig = lazyConfig({ lifecycle: "eager", spawnLog });
		const manager = new MCPManager(workDir);
		let staleReconnect: Promise<Awaited<ReturnType<typeof manager.reconnectServer>>> | undefined;
		try {
			await manager.connectServers({ lazy: initialConfig }, {});
			manager.setAuthHandler(async () => failedConfig);
			staleReconnect = manager.reconnectServer("lazy", {
				manual: true,
				authChallenge: { wwwAuthenticate: ["Bearer"] },
			});
			expect(await waitFor(() => spawnCount(spawnLog) >= 2)).toBe(true);

			await manager.connectServers({ lazy: replacementConfig }, {});
			expect(manager.getConnectionStatus("lazy")).toBe("connected");
			expect(manager.getServerConfig("lazy")).toBe(replacementConfig);
			expect(resultText(await executeServerTool(manager, "lazy"))).toBe("pong");
			const replacementSpawns = spawnCount(spawnLog);
			await staleReconnect;
			expect(spawnCount(spawnLog)).toBe(replacementSpawns);
		} finally {
			await manager.disconnectAll();
			await staleReconnect;
		}
	}, 15_000);
});
