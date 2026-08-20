/**
 * Contract: lifecycle resolution precedence is per-server > manager default. A
 * server with an explicit `lifecycle` ignores `mcp.defaultLifecycle`; a server
 * without one inherits the default.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "../src/capability/mcp";
import { convertToLegacyConfig } from "../src/mcp/config";
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
			expect(manager.getConnectionStatus("srv")).toBe("disconnected");
			expect(hasServerTool(manager, "srv")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(0);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});

describe("convertToLegacyConfig threads lifecycle + idleTimeout", () => {
	it("carries both fields onto a stdio legacy config", () => {
		const legacy = convertToLegacyConfig({
			name: "s",
			command: "cmd",
			lifecycle: "lazy",
			idleTimeout: 1000,
		} as unknown as MCPServer);
		expect(legacy.type).toBe("stdio");
		expect(legacy.lifecycle).toBe("lazy");
		expect(legacy.idleTimeout).toBe(1000);
	});

	it("carries both fields onto an http legacy config", () => {
		const legacy = convertToLegacyConfig({
			name: "h",
			transport: "http",
			url: "https://example.test/mcp",
			lifecycle: "eager",
			idleTimeout: 0,
		} as unknown as MCPServer);
		expect(legacy.type).toBe("http");
		expect(legacy.lifecycle).toBe("eager");
		// idleTimeout 0 ("never reap") must survive, not be dropped as falsy.
		expect(legacy.idleTimeout).toBe(0);
	});

	it("carries both fields onto an sse legacy config", () => {
		const legacy = convertToLegacyConfig({
			name: "e",
			transport: "sse",
			url: "https://example.test/sse",
			lifecycle: "lazy",
			idleTimeout: 5000,
		} as unknown as MCPServer);
		expect(legacy.type).toBe("sse");
		expect(legacy.lifecycle).toBe("lazy");
		expect(legacy.idleTimeout).toBe(5000);
	});

	it("leaves both fields undefined when the canonical server omits them", () => {
		const legacy = convertToLegacyConfig({ name: "s", command: "cmd" } as unknown as MCPServer);
		expect(legacy.lifecycle).toBeUndefined();
		expect(legacy.idleTimeout).toBeUndefined();
	});
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
