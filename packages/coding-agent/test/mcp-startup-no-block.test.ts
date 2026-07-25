/**
 * Regression test for issue #2100: omp startup blocked >25s while connecting
 * to MCP servers.
 *
 * The scenario: a configured MCP server is reachable at the transport layer
 * but never answers `initialize`. Before the fix `MCPManager.connectServers`
 * awaited every still-pending server that had no cached tools with an
 * unbounded `Promise.allSettled`, so the slowest server's per-request timeout
 * (`OMP_MCP_TIMEOUT_MS`, default 30 000 ms) gated the entire UI.
 *
 * Contract this test defends: when an MCP server stalls and has no cached
 * tools, `connectServers` MUST return inside the bounded startup window
 * (currently `STARTUP_TIMEOUT_MS = 250 ms`, padded here for scheduling
 * jitter) so the rest of session bring-up — model registry, prompt setup,
 * UI ready signal — is not gated on slow/dead servers. The slow server is
 * left in flight; its tools surface via the background `#onToolsChanged`
 * path if/when it eventually connects.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import * as mcpClient from "../src/mcp/client";
import { MCPManager } from "../src/mcp/manager";
import type { MCPServerConnection, MCPStdioServerConfig } from "../src/mcp/types";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "hang-during-init-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCP startup (issue #2100)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-startup-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("returns promptly when a configured MCP server stalls on initialize", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};

		try {
			const start = performance.now();
			const result = await manager.connectServers({ hang: config }, {});
			const elapsedMs = performance.now() - start;

			// `STARTUP_TIMEOUT_MS` is 250 ms; allow generous headroom for
			// process spawn + scheduling jitter in CI. The pre-fix code path
			// blocked 30 000 ms, so anything under a few seconds proves the
			// regression is closed.
			expect(elapsedMs).toBeLessThan(5_000);

			// Slow server with no cached tools surfaces no tools at startup
			// and no error (it's still pending in the background). The fact
			// that startup returned at all is the contract.
			expect(result.tools).toEqual([]);
			expect(result.connectedServers).toEqual([]);
			expect(result.errors.has("hang")).toBe(false);

			// Manager retains the pending connection so reconnect/dedup logic
			// continues to function — a second `connectServers` call must not
			// double-spawn while the first is still in flight.
			const second = await manager.connectServers({ hang: config }, {});
			expect(second.tools).toEqual([]);
			expect(second.errors.has("hang")).toBe(false);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("aborts a pending connection when the manager disconnects", async () => {
		const manager = new MCPManager(workDir);
		const pending = Promise.withResolvers<MCPServerConnection>();
		let signal: AbortSignal | undefined;
		const connect = spyOn(mcpClient, "connectToServer").mockImplementation((_name, _config, options) => {
			signal = options?.signal;
			signal?.addEventListener(
				"abort",
				() => pending.reject(new DOMException("Connection cancelled", "AbortError")),
				{ once: true },
			);
			return pending.promise;
		});
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};

		try {
			const result = await manager.connectServers({ pending: config }, {}, undefined, 0);
			expect(result.tools).toEqual([]);
			expect(signal?.aborted).toBe(false);

			await manager.disconnectAll();
			expect(signal?.aborted).toBe(true);
		} finally {
			pending.reject(new DOMException("Test cleanup", "AbortError"));
			connect.mockRestore();
			await manager.disconnectAll();
		}
	});
});
