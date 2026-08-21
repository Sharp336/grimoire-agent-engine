/**
 * Contract: lifecycle resolution precedence is per-server > manager default. A
 * server with an explicit `lifecycle` ignores `mcp.defaultLifecycle`; a server
 * without one inherits the default.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { type MCPServer, mcpCapability } from "../src/capability/mcp";
import { MCPManager } from "../src/mcp/manager";
import {
	hasServerTool,
	inMemoryToolCache,
	lazyConfig,
	makeWorkDir,
	spawnCount,
	TOOL_DEF,
	waitFor,
} from "./mcp-lifecycle-harness";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("MCP lifecycle precedence: per-server overrides the default", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("an explicit eager server connects even when the default is lazy", async () => {
		const spawnLog = path.join(workDir, "explicit-eager.log");
		const manager = new MCPManager(workDir, inMemoryToolCache());
		manager.setLifecycleDefaults("lazy", 300_000);
		const config = lazyConfig({ lifecycle: "eager", spawnLog });
		try {
			await manager.connectServers({ srv: config }, {});
			// Per-server "eager" wins over the "lazy" default.
			expect(await waitFor(() => manager.getConnectionStatus("srv") === "connected")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("a server without a lifecycle inherits the lazy default (no startup spawn)", async () => {
		const spawnLog = path.join(workDir, "default-lazy.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ spawnLog }); // no per-server lifecycle
		await cache.set("srv", config, [TOOL_DEF]);

		const manager = new MCPManager(workDir, cache);
		manager.setLifecycleDefaults("lazy", 300_000);
		try {
			await manager.connectServers({ srv: config }, {});
			// Inherited lazy → advertised from cache, not spawned.
			expect(manager.getConnectionStatus("srv")).toBe("deferred");
			expect(hasServerTool(manager, "srv")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(0);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});

describe("project MCP config preserves lifecycle settings", () => {
	it("discovers and reaps a lazy stdio server from project config", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-convert-agent-"));
		setAgentDir(agentDir);
		clearFsCache();

		const projectDir = makeWorkDir();
		const spawnLog = path.join(projectDir, "project-discovery.log");
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 50, spawnLog });
		const projectConfigPath = path.join(projectDir, ".omp", "mcp.json");
		fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
		fs.writeFileSync(projectConfigPath, JSON.stringify({ mcpServers: { lazy: config } }));

		const manager = new MCPManager(projectDir);
		try {
			const result = await manager.discoverAndConnect({ enableProjectConfig: true });

			expect(result.errors.has("lazy")).toBe(false);
			expect(result.connectedServers).toContain("lazy");
			expect(spawnCount(spawnLog)).toBe(1);
			expect(await waitFor(() => manager.getConnectionStatus("lazy") === "deferred")).toBe(true);
		} finally {
			await manager.disconnectAll();
			clearFsCache();
			if (originalAgentDirEnv) {
				setAgentDir(originalAgentDirEnv);
			} else {
				setAgentDir(fallbackAgentDir);
				delete process.env.PI_CODING_AGENT_DIR;
			}
			fs.rmSync(agentDir, { recursive: true, force: true });
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("mcpCapability validates lifecycle fields", () => {
	const validate = (server: Partial<MCPServer>): string | undefined =>
		mcpCapability.validate?.({ name: "s", command: "cmd", ...server } as MCPServer);

	it("accepts eager, lazy, and an omitted lifecycle", () => {
		expect(validate({ lifecycle: "eager" })).toBeUndefined();
		expect(validate({ lifecycle: "lazy" })).toBeUndefined();
		expect(validate({})).toBeUndefined();
	});

	it("rejects any other lifecycle value, including the never-shipped keep-alive", () => {
		expect(validate({ lifecycle: "lazyy" as MCPServer["lifecycle"] })).toContain("Invalid lifecycle");
		expect(validate({ lifecycle: "keep-alive" as MCPServer["lifecycle"] })).toContain("Invalid lifecycle");
	});

	it("accepts non-negative idleTimeout values and rejects the rest", () => {
		expect(validate({ idleTimeout: 0 })).toBeUndefined();
		expect(validate({ idleTimeout: 5000 })).toBeUndefined();
		expect(validate({ idleTimeout: -1 })).toContain("non-negative");
		expect(validate({ idleTimeout: Number.POSITIVE_INFINITY })).toContain("non-negative");
		expect(validate({ idleTimeout: "300" as unknown as number })).toContain("non-negative");
	});
});
