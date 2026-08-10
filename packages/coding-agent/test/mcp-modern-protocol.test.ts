import { afterEach, describe, expect, it } from "bun:test";
import {
	callTool,
	connectToServer,
	disconnectServer,
	getToolCachePolicy,
	listTools,
	subscribeToResources,
} from "@oh-my-pi/pi-coding-agent/mcp/client";
import { isRecord } from "@oh-my-pi/pi-utils";

interface RpcRequest {
	id?: string | number;
	method: string;
	params: Record<string, unknown>;
}

let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

async function readRpcRequest(request: Request): Promise<RpcRequest> {
	const value = await request.json();
	if (!isRecord(value) || typeof value.method !== "string") throw new Error("Invalid JSON-RPC request");
	if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number") {
		throw new Error("Invalid JSON-RPC request id");
	}
	return {
		id: value.id,
		method: value.method,
		params: isRecord(value.params) ? value.params : {},
	};
}

function rpcResult(id: string | number | undefined, result: Record<string, unknown>): Response {
	return Response.json({ jsonrpc: "2.0", id, result });
}

describe("MCP 2026-07-28 protocol negotiation", () => {
	it("uses stateless discovery and per-request metadata without legacy initialization", async () => {
		const requests: Array<{
			id?: string | number;
			method: string;
			protocolHeader: string | null;
			methodHeader: string | null;
			params: Record<string, unknown>;
		}> = [];
		let toolCallCount = 0;
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const rpc = await readRpcRequest(request);
				requests.push({
					id: rpc.id,
					method: rpc.method,
					protocolHeader: request.headers.get("MCP-Protocol-Version"),
					methodHeader: request.headers.get("Mcp-Method"),
					params: rpc.params,
				});
				switch (rpc.method) {
					case "server/discover":
						return rpcResult(rpc.id, {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: { tools: {} },
							ttlMs: 60_000,
							cacheScope: "public",
							_meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-test", version: "1.0.0" } },
						});
					case "tools/list":
						return rpcResult(rpc.id, {
							resultType: "complete",
							tools: [{ name: "echo", inputSchema: { type: "object" } }],
							ttlMs: 60_000,
							cacheScope: "public",
						});
					case "tools/call":
						toolCallCount++;
						if (toolCallCount === 1) {
							return rpcResult(rpc.id, {
								resultType: "input_required",
								inputRequests: {
									projectRoot: { method: "roots/list" },
								},
								requestState: "opaque-✓",
							});
						}
						return rpcResult(rpc.id, {
							resultType: "complete",
							content: [{ type: "text", text: "ok" }],
						});
					default:
						return new Response("unexpected method", { status: 500 });
				}
			},
		});

		const connection = await connectToServer("modern", {
			type: "http",
			protocolMode: "auto",
			url: `http://127.0.0.1:${server.port}/mcp`,
		});
		expect(connection.protocolVersion).toBe("2026-07-28");
		expect(connection.serverInfo).toEqual({ name: "modern-test", version: "1.0.0" });
		expect((await listTools(connection)).map(tool => tool.name)).toEqual(["echo"]);
		const cachePolicy = getToolCachePolicy(connection);
		expect(cachePolicy?.cacheScope).toBe("public");
		expect(cachePolicy?.ttlMs).toBeGreaterThan(0);
		expect(cachePolicy?.ttlMs).toBeLessThanOrEqual(60_000);
		expect(await callTool(connection, "echo", { value: "hello" })).toMatchObject({
			content: [{ type: "text", text: "ok" }],
		});
		await disconnectServer(connection);

		expect(requests.map(request => request.method)).toEqual([
			"server/discover",
			"tools/list",
			"tools/call",
			"tools/call",
		]);
		expect(requests[3]?.id).not.toBe(requests[2]?.id);
		expect(requests[3]?.params.requestState).toBe("opaque-✓");
		expect(requests[3]?.params.inputResponses).toEqual({
			projectRoot: {
				roots: [expect.objectContaining({ uri: expect.stringMatching(/^file:/) })],
			},
		});
		for (const request of requests) {
			expect(request.protocolHeader).toBe("2026-07-28");
			expect(request.methodHeader).toBe(request.method);
			const meta = request.params._meta;
			expect(isRecord(meta) && meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
			expect(isRecord(meta) && meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({ roots: {} });
		}
	});

	it("does not reinterpret a recognized modern version error as a legacy server", async () => {
		const rpcMethods: string[] = [];
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const rpc = await readRpcRequest(request);
				rpcMethods.push(rpc.method);
				return Response.json(
					{
						jsonrpc: "2.0",
						id: rpc.id,
						error: {
							code: -32022,
							message: "Unsupported protocol version",
							data: { supported: ["2027-01-01"], requested: "2026-07-28" },
						},
					},
					{ status: 400 },
				);
			},
		});

		await expect(
			connectToServer("future", {
				type: "http",
				protocolMode: "auto",
				url: `http://127.0.0.1:${server.port}/mcp`,
			}),
		).rejects.toThrow("MCP error -32022: Unsupported protocol version");
		expect(rpcMethods).toEqual(["server/discover"]);
	});

	for (const status of [401, 403, 500]) {
		it(`surfaces HTTP ${status} discovery failures without sending initialize`, async () => {
			const rpcMethods: string[] = [];
			server = Bun.serve({
				port: 0,
				async fetch(request) {
					const rpc = await readRpcRequest(request);
					rpcMethods.push(rpc.method);
					return new Response("discovery failed", { status });
				},
			});

			await expect(
				connectToServer(`http-${status}`, {
					type: "http",
					protocolMode: "auto",
					url: `http://127.0.0.1:${server.port}/mcp`,
				}),
			).rejects.toThrow(`HTTP ${status}: discovery failed`);
			expect(rpcMethods).toEqual(["server/discover"]);
		});
	}

	it("surfaces malformed HTTP discovery results without sending initialize", async () => {
		const rpcMethods: string[] = [];
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const rpc = await readRpcRequest(request);
				rpcMethods.push(rpc.method);
				return rpcResult(rpc.id, {});
			},
		});

		await expect(
			connectToServer("malformed", {
				type: "http",
				protocolMode: "auto",
				url: `http://127.0.0.1:${server.port}/mcp`,
			}),
		).rejects.toThrow('MCP server "malformed" returned an invalid server/discover result');
		expect(rpcMethods).toEqual(["server/discover"]);
	});

	it("waits for the correlated subscription acknowledgment and returns only accepted resources", async () => {
		const listenRequest = Promise.withResolvers<RpcRequest>();
		const acceptedUri = "file:///workspace/config.json";
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const rpc = await readRpcRequest(request);
				if (rpc.method === "server/discover") {
					return rpcResult(rpc.id, {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: { resources: { subscribe: true } },
						ttlMs: 0,
						cacheScope: "public",
					});
				}
				if (rpc.method === "subscriptions/listen") {
					listenRequest.resolve(rpc);
					const acknowledgment = {
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": rpc.id },
							notifications: { resourceSubscriptions: [acceptedUri] },
						},
					};
					const wrongAcknowledgment = {
						...acknowledgment,
						params: {
							...acknowledgment.params,
							_meta: { "io.modelcontextprotocol/subscriptionId": `${rpc.id}-wrong` },
							notifications: { resourceSubscriptions: ["file:///workspace/wrong-id.json"] },
						},
					};
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify(wrongAcknowledgment)}\n\ndata: ${JSON.stringify(acknowledgment)}\n\n`,
									),
								);
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				return new Response("unexpected method", { status: 500 });
			},
		});

		const connection = await connectToServer("subscriptions", {
			type: "http",
			protocolMode: "2026-07-28",
			url: `http://127.0.0.1:${server.port}/mcp`,
		});
		const accepted = await subscribeToResources(connection, [acceptedUri, "file:///workspace/rejected.json"]);
		const listen = await listenRequest.promise;
		expect(accepted).toEqual([acceptedUri]);
		expect(listen.params.notifications).toEqual({
			toolsListChanged: false,
			promptsListChanged: false,
			resourcesListChanged: false,
			resourceSubscriptions: [acceptedUri, "file:///workspace/rejected.json"],
		});

		await disconnectServer(connection);
	});
	it("bounds the wait for a subscription acknowledgment", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const rpc = await readRpcRequest(request);
				if (rpc.method === "server/discover") {
					return rpcResult(rpc.id, {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: { resources: { subscribe: true } },
						ttlMs: 0,
						cacheScope: "public",
					});
				}
				if (rpc.method === "subscriptions/listen") {
					return new Response(new ReadableStream<Uint8Array>(), {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return new Response("unexpected method", { status: 500 });
			},
		});

		const connection = await connectToServer("missing-ack", {
			type: "http",
			protocolMode: "2026-07-28",
			url: `http://127.0.0.1:${server.port}/mcp`,
		});
		await expect(
			subscribeToResources(connection, ["file:///workspace/config.json"], { timeout: 50 }),
		).rejects.toThrow("MCP subscription acknowledgment timed out after 50ms");
		await disconnectServer(connection);
	});

	it("keeps the legacy initialize lifecycle when protocolMode is omitted", async () => {
		const rpcMethods: string[] = [];
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "GET") return new Response(null, { status: 405 });
				const rpc = await readRpcRequest(request);
				rpcMethods.push(rpc.method);
				if (rpc.method === "initialize") {
					return rpcResult(rpc.id, {
						protocolVersion: "2025-03-26",
						capabilities: {},
						serverInfo: { name: "legacy-default", version: "1.0.0" },
					});
				}
				if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
				return new Response("unexpected method", { status: 500 });
			},
		});

		const connection = await connectToServer("legacy-default", {
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
		});
		expect(connection.protocolVersion).toBe("2025-03-26");
		expect(rpcMethods).toEqual(["initialize", "notifications/initialized"]);
		await disconnectServer(connection);
	});

	it("does not fall back when the modern protocol is required", async () => {
		const rpcMethods: string[] = [];
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const rpc = await readRpcRequest(request);
				rpcMethods.push(rpc.method);
				return Response.json(
					{ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } },
					{ status: 404 },
				);
			},
		});

		await expect(
			connectToServer("modern-required", {
				type: "http",
				protocolMode: "2026-07-28",
				url: `http://127.0.0.1:${server.port}/mcp`,
			}),
		).rejects.toThrow("MCP error -32601: Method not found");
		expect(rpcMethods).toEqual(["server/discover"]);
	});

	it("does not reinterpret an HTTP 404 method error as legacy evidence", async () => {
		const rpcMethods: string[] = [];
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const rpc = await readRpcRequest(request);
				rpcMethods.push(rpc.method);
				return Response.json(
					{ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } },
					{ status: 404 },
				);
			},
		});

		await expect(
			connectToServer("modern-method-error", {
				type: "http",
				protocolMode: "auto",
				url: `http://127.0.0.1:${server.port}/mcp`,
			}),
		).rejects.toThrow("MCP error -32601: Method not found");
		expect(rpcMethods).toEqual(["server/discover"]);
	});

	for (const status of [400, 404, 405]) {
		it(`falls back after a plain HTTP ${status} discovery response`, async () => {
			const rpcMethods: string[] = [];
			server = Bun.serve({
				port: 0,
				async fetch(request) {
					if (request.method === "GET") return new Response(null, { status: 405 });
					const rpc = await readRpcRequest(request);
					rpcMethods.push(rpc.method);
					if (rpc.method === "server/discover") return new Response("legacy endpoint", { status });
					if (rpc.method === "initialize") {
						return rpcResult(rpc.id, {
							protocolVersion: "2025-03-26",
							capabilities: {},
							serverInfo: { name: "legacy-http", version: "1.0.0" },
						});
					}
					if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
					return new Response("unexpected method", { status: 500 });
				},
			});

			const connection = await connectToServer(`legacy-http-${status}`, {
				type: "http",
				protocolMode: "auto",
				url: `http://127.0.0.1:${server.port}/mcp`,
			});
			expect(connection.protocolVersion).toBe("2025-03-26");
			expect(rpcMethods).toEqual(["server/discover", "initialize", "notifications/initialized"]);
			await disconnectServer(connection);
		});
	}
});
