import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCPManager connection status events", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-status-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("emits connecting, connected, and failed updates for startup status", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const success: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const invalid: MCPServerConfig = { type: "stdio", command: "" };

		try {
			const result = await manager.connectServers({ alpha: success, broken: invalid }, {}, event =>
				events.push(event),
			);

			expect(result.connectedServers).toContain("alpha");
			expect(result.errors.get("broken")).toBe('Server "broken": stdio server requires "command" field');
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["alpha", "broken"] },
				{ type: "failed", serverName: "broken", error: 'Server "broken": stdio server requires "command" field' },
				{ type: "connected", serverName: "alpha" },
			]);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("includes the originating config path when a discovered server fails to start", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const missingCommand = path.join(workDir, "missing-mcp-server");
		const configPath = path.join(os.homedir(), ".codex", "config.toml");

		try {
			const result = await manager.connectServers(
				{
					broken: {
						type: "stdio",
						command: missingCommand,
					},
				},
				{
					broken: {
						provider: "codex",
						providerName: "Codex",
						path: configPath,
						level: "user",
					},
				},
				event => events.push(event),
			);

			const message = result.errors.get("broken") ?? "";
			expect(message).toMatch(/ENOENT|No such file|not found/i);
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["broken"] },
				{
					type: "failed",
					serverName: "broken",
					error: message,
					sourcePath: configPath,
				},
			]);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("surfaces a filter-empty failure (not connected) when tools/list lands after the startup window", async () => {
		// A server whose initialize stalls past the 250 ms startup window
		// resolves in the background continuation. When its filter excludes
		// every advertised tool, that path must emit a `failed` status (not a
		// silent `connected` with no tools) so the user sees the per-server error.
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const slowFiltered: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH, "--delay", "400"],
			enabledTools: ["never_advertised"],
		};

		try {
			const result = await manager.connectServers({ slow: slowFiltered }, {}, event => events.push(event));
			// The synchronous result sees the server still pending (no error set).
			expect(result.errors.has("slow")).toBe(false);
			expect(result.connectedServers).not.toContain("slow");

			// Wait for the background continuation to settle.
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && !events.some(e => e.type === "failed" || e.type === "connected")) {
				await Bun.sleep(25);
			}

			const terminal = events.filter(e => e.type === "failed" || e.type === "connected");
			expect(terminal).toHaveLength(1);
			expect(terminal[0].type).toBe("failed");
			if (terminal[0].type === "failed") {
				expect(terminal[0].serverName).toBe("slow");
				expect(terminal[0].error).toMatch(/tool filter excludes all 45 advertised tools/);
			}
		} finally {
			await manager.disconnectAll();
		}
	});
});
