import { afterEach, describe, expect, it } from "bun:test";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
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

let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

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

describe("MCP cached deferred tools", () => {
	it("propagates cached x-mcp-header arguments before live tools/list resolves", async () => {
		const modernConfig: MCPServerConfig = {
			type: "http",
			protocolMode: "2026-07-28",
			url: "http://placeholder",
			timeout: 0,
		};
		const cachedTool: MCPToolDefinition = {
			name: "echo",
			inputSchema: {
				type: "object",
				properties: {
					tenant: { type: "string", "x-mcp-header": "Tenant" },
				},
				required: ["tenant"],
			},
		};
		const { cache } = createCache();

		const listStarted = Promise.withResolvers<void>();
		const listGate = Promise.withResolvers<void>();
		const captured = { header: null as string | null };
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { id?: string | number; method?: string };
				switch (body.method) {
					case "server/discover":
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								resultType: "complete",
								supportedVersions: ["2026-07-28"],
								capabilities: { tools: {} },
								ttlMs: 60_000,
								cacheScope: "public",
							},
						});
					case "tools/list":
						listStarted.resolve();
						await listGate.promise;
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								resultType: "complete",
								tools: [cachedTool],
								ttlMs: 60_000,
								cacheScope: "public",
							},
						});
					case "tools/call":
						captured.header = request.headers.get("Mcp-Param-Tenant");
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								resultType: "complete",
								content: [{ type: "text", text: "ok" }],
							},
						});
					default:
						return new Response("unexpected method", { status: 500 });
				}
			},
		});

		const config = { ...modernConfig, url: `http://127.0.0.1:${server.port}/mcp` };
		await cache.set("modern", config, [cachedTool], { cacheScope: "public", ttlMs: 60_000 });
		const manager = new MCPManager(process.cwd(), cache);
		const resultPromise = manager.connectServers({ modern: config }, {});
		await listStarted.promise;

		try {
			const result = await resultPromise;
			const deferred = result.tools[0];
			expect(deferred).toBeDefined();
			if (!deferred) throw new Error("cached deferred tool was not loaded");

			await deferred.execute("call-1", { tenant: "acme" }, undefined, {} as CustomToolContext);
			expect(captured.header).toBe("acme");
		} finally {
			listGate.resolve();
			await manager.disconnectAll();
		}
	});
});
