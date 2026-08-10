import { afterEach, describe, expect, it } from "bun:test";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import {
	applyModernRequestHeaders,
	buildToolParameterHeaders,
	collectToolHeaderBindings,
} from "@oh-my-pi/pi-coding-agent/mcp/transports/modern-http";

const PROTOCOL_VERSION = "2026-07-28";
let servers: Bun.Server<undefined>[] = [];

function serve(fetchHandler: (request: Request) => Response | Promise<Response>): Bun.Server<undefined> {
	const server = Bun.serve({ port: 0, fetch: fetchHandler });
	servers.push(server);
	return server;
}

afterEach(() => {
	for (const server of servers) server.stop(true);
	servers = [];
});

function rpcResult(requestBody: unknown): Response {
	const id = requestBody && typeof requestBody === "object" && "id" in requestBody ? requestBody.id : null;
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }), {
		headers: { "Content-Type": "application/json" },
	});
}

describe("MCP 2026-07-28 request headers", () => {
	it("adds standard headers only when _meta has a protocol version", () => {
		const headers: Record<string, string> = {
			"mcp-protocol-version": "configured",
			"MCP-METHOD": "configured",
			"mcp-name": "configured",
		};

		applyModernRequestHeaders(headers, "tools/call", {
			name: "weather",
			_meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION },
		});

		expect(headers).toEqual({
			"MCP-Protocol-Version": PROTOCOL_VERSION,
			"Mcp-Method": "tools/call",
			"Mcp-Name": "weather",
		});

		const legacy: Record<string, string> = {};
		applyModernRequestHeaders(legacy, "tools/call", { name: "weather" });
		expect(legacy).toEqual({});
	});

	it("encodes unsafe, edge, and sentinel-shaped values", () => {
		const headers = buildToolParameterHeaders(
			[
				{ headerName: "Mcp-Param-Plain", path: ["plain"], type: "string" },
				{ headerName: "Mcp-Param-Unicode", path: ["unicode"], type: "string" },
				{ headerName: "Mcp-Param-Padded", path: ["padded"], type: "string" },
				{ headerName: "Mcp-Param-Sentinel", path: ["sentinel"], type: "string" },
				{ headerName: "Mcp-Param-Count", path: ["count"], type: "integer" },
				{ headerName: "Mcp-Param-Enabled", path: ["enabled"], type: "boolean" },
			],
			{
				plain: "plain value",
				unicode: "Hello, 世界",
				padded: " padded ",
				sentinel: "=?base64?literal?=",
				count: -7,
				enabled: true,
			},
		);

		expect(headers).toEqual({
			"Mcp-Param-Plain": "plain value",
			"Mcp-Param-Unicode": "=?base64?SGVsbG8sIOS4lueVjA==?=",
			"Mcp-Param-Padded": "=?base64?IHBhZGRlZCA=?=",
			"Mcp-Param-Sentinel": "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=",
			"Mcp-Param-Count": "-7",
			"Mcp-Param-Enabled": "true",
		});
	});

	it("extracts valid nested properties and omits absent values", () => {
		const collected = collectToolHeaderBindings({
			type: "object",
			properties: {
				routing: {
					type: "object",
					properties: {
						tenant: { type: "string", "x-mcp-header": "Tenant" },
						attempt: { type: "integer", "x-mcp-header": "Attempt" },
						enabled: { type: "boolean", "x-mcp-header": "Enabled" },
					},
				},
			},
		});
		expect(collected.error).toBeUndefined();
		expect(collected.bindings).toEqual([
			{ headerName: "Mcp-Param-Tenant", path: ["routing", "tenant"], type: "string" },
			{ headerName: "Mcp-Param-Attempt", path: ["routing", "attempt"], type: "integer" },
			{ headerName: "Mcp-Param-Enabled", path: ["routing", "enabled"], type: "boolean" },
		]);
		expect(
			buildToolParameterHeaders(collected.bindings, {
				routing: { tenant: "acme", enabled: false },
			}),
		).toEqual({ "Mcp-Param-Tenant": "acme", "Mcp-Param-Enabled": "false" });
	});

	it("rejects invalid annotation placement, type, name, and duplicates", () => {
		const invalidSchemas: Record<string, unknown>[] = [
			{
				type: "object",
				properties: { values: { type: "array", items: { type: "string", "x-mcp-header": "Values" } } },
			},
			{
				type: "object",
				properties: { choice: { oneOf: [{ type: "string", "x-mcp-header": "Choice" }] } },
			},
			{
				type: "object",
				properties: { value: { type: "number", "x-mcp-header": "Value" } },
			},
			{
				type: "object",
				properties: { value: { type: "string", "x-mcp-header": "bad name" } },
			},
			{
				type: "object",
				properties: {
					first: { type: "string", "x-mcp-header": "Tenant" },
					second: { type: "string", "x-mcp-header": "tenant" },
				},
			},
		];

		for (const inputSchema of invalidSchemas) {
			const result = collectToolHeaderBindings(inputSchema);
			expect(result.bindings).toEqual([]);
			expect(result.error).toBeString();
		}
	});

	it("gives modern standard and parameter headers precedence over configured headers", async () => {
		let received: Headers | undefined;
		const server = serve(async request => {
			received = request.headers;
			return rpcResult(await request.json());
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			headers: {
				"mcp-protocol-version": "configured-version",
				"mcp-method": "configured-method",
				"mcp-name": "configured-name",
				"mcp-param-tenant": "configured-tenant",
			},
		});
		await transport.connect();

		await transport.request(
			"tools/call",
			{
				name: "weather",
				arguments: { tenant: "acme" },
				_meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION },
			},
			{ generatedHeaders: { "Mcp-Param-Tenant": "generated-tenant" } },
		);

		expect(received?.get("mcp-protocol-version")).toBe(PROTOCOL_VERSION);
		expect(received?.get("mcp-method")).toBe("tools/call");
		expect(received?.get("mcp-name")).toBe("weather");
		expect(received?.get("mcp-param-tenant")).toBe("generated-tenant");
	});

	it("does not send modern option headers on legacy requests", async () => {
		let received: Headers | undefined;
		const server = serve(async request => {
			received = request.headers;
			return rpcResult(await request.json());
		});
		const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp` });
		await transport.connect();

		await transport.request(
			"tools/call",
			{ name: "weather", arguments: {} },
			{
				generatedHeaders: { "Mcp-Param-Tenant": "must-not-send" },
			},
		);

		expect(received?.get("mcp-protocol-version")).toBeNull();
		expect(received?.get("mcp-method")).toBeNull();
		expect(received?.get("mcp-param-tenant")).toBeNull();
	});
});
