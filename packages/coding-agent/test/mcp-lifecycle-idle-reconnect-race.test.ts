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
});
