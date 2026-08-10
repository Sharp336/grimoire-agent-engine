import { describe, expect, it } from "bun:test";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";

interface CacheRow {
	value: string;
	expiresAtSec: number;
}

const config: MCPServerConfig = { type: "stdio", command: "fixture" };
const tools: MCPToolDefinition[] = [{ name: "echo", inputSchema: { type: "object" } }];

function createCache(): { cache: MCPToolCache; rows: Map<string, CacheRow> } {
	const rows = new Map<string, CacheRow>();
	const storage = {
		getCache(key: string): string | null {
			const row = rows.get(key);
			return row && row.expiresAtSec * 1000 > Date.now() ? row.value : null;
		},
		setCache(key: string, value: string, expiresAtSec: number): void {
			rows.set(key, { value, expiresAtSec });
		},
	} as unknown as AgentStorage;
	return { cache: new MCPToolCache(storage), rows };
}

describe("MCP persistent tool cache policy", () => {
	it("retains the fixed legacy TTL when no modern cache policy is provided", async () => {
		const { cache, rows } = createCache();
		const before = Date.now();
		await cache.set("legacy", config, tools);

		expect(await cache.get("legacy", config)).toEqual(tools);
		const row = rows.get("mcp_tools:legacy");
		expect(row?.expiresAtSec).toBeGreaterThanOrEqual(Math.floor((before + 30 * 24 * 60 * 60 * 1000) / 1000));
	});

	it("uses a public modern result's shorter TTL", async () => {
		const { cache, rows } = createCache();
		const before = Date.now();
		await cache.set("public", config, tools, { cacheScope: "public", ttlMs: 2_000 });

		expect(await cache.get("public", config)).toEqual(tools);
		const row = rows.get("mcp_tools:public");
		expect(row?.expiresAtSec).toBeLessThanOrEqual(Math.floor((before + 2_000) / 1000));
	});

	for (const policy of [
		{ cacheScope: "public" as const, ttlMs: 0 },
		{ cacheScope: "private" as const, ttlMs: 60_000 },
	]) {
		it(`invalidates an older row for ${policy.cacheScope} ttl ${policy.ttlMs}`, async () => {
			const { cache } = createCache();
			await cache.set("replaced", config, tools);
			expect(await cache.get("replaced", config)).toEqual(tools);

			await cache.set("replaced", config, tools, policy);
			expect(await cache.get("replaced", config)).toBeNull();
		});
	}
});
