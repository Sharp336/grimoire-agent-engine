import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter, Http2SessionManager } from "@connectrpc/connect-node";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import {
	GetServerConfigResponseSchema,
	Http2Config,
	ServerConfigService,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import {
	__expireServerConfigEntry,
	disposeServerConfigCache,
	resolveCursorTransportMode,
} from "../src/providers/cursor/server-config";
import {
	BidiAppendResponseSchema,
	CursorAgentService,
	CursorBidiService,
} from "../src/providers/cursor/transport-descriptors";

async function runFallbackTestInIsolatedProcess(): Promise<boolean> {
	if (Bun.env.OMP_ISOLATED_CURSOR_FALLBACK_TEST === "1") return false;
	const child = Bun.spawn(
		[
			process.execPath,
			"test",
			import.meta.path,
			"-t",
			"falls back to the HTTP/1 bridge when H2 setup is unavailable before dispatch",
		],
		{
			cwd: new URL("..", import.meta.url).pathname,
			env: { ...process.env, TMPDIR: "/dev/shm", OMP_ISOLATED_CURSOR_FALLBACK_TEST: "1" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`${stderr}\n${stdout}`);
	return true;
}

const servers = new Set<http.Server>();

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeServerConfigCache();
	await Promise.all(
		Array.from(servers, server => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		}),
	);
	servers.clear();
});

async function unavailableDiscoveryServer(): Promise<string> {
	const server = http.createServer((_request, response) => {
		response.writeHead(404);
		response.end();
	});
	servers.add(server);
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
	return `http://127.0.0.1:${address.port}`;
}

async function configServer(http2Config: Http2Config): Promise<string> {
	const server = http.createServer(
		connectNodeAdapter({
			routes: router => {
				router.service(ServerConfigService, {
					getServerConfig: () => create(GetServerConfigResponseSchema, { http2Config }),
				});
			},
		}),
	);
	servers.add(server);
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
	return `http://127.0.0.1:${address.port}`;
}

describe("Cursor HTTP/1 fallback selection", () => {
	it.each([
		[Http2Config.FORCE_BIDI_DISABLED, "http1"],
		[Http2Config.FORCE_ALL_DISABLED, "http1"],
		[Http2Config.FORCE_ALL_ENABLED, "http2"],
	] as const)("honors authoritative server mode %s", async (http2Config, expectedMode) => {
		const baseUrl = await configServer(http2Config);
		const result = await resolveCursorTransportMode({
			baseUrl,
			apiKey: `mode-${http2Config}`,
			provider: "cursor",
		});
		expect(result.mode).toBe(expectedMode);
	});

	it("keeps HTTP/2 primary when config discovery is unavailable", async () => {
		const baseUrl = await unavailableDiscoveryServer();
		const result = await resolveCursorTransportMode({
			baseUrl,
			apiKey: "test-key",
			provider: "cursor",
		});
		expect(result.mode).toBe("http2");
	});

	it("retries discovery after a transient neutral result", async () => {
		let requests = 0;
		const server = http.createServer(
			connectNodeAdapter({
				routes: router => {
					router.service(ServerConfigService, {
						getServerConfig: () => {
							requests++;
							if (requests === 1) throw new Error("temporary discovery outage");
							return create(GetServerConfigResponseSchema, {
								http2Config: Http2Config.FORCE_BIDI_DISABLED,
							});
						},
					});
				},
			}),
		);
		servers.add(server);
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
		const options = {
			baseUrl: `http://127.0.0.1:${address.port}`,
			apiKey: "recovering-key",
			provider: "cursor",
		};

		expect((await resolveCursorTransportMode(options)).mode).toBe("http2");
		__expireServerConfigEntry(options.baseUrl, options.apiKey);
		expect((await resolveCursorTransportMode(options)).mode).toBe("http1");
		expect(requests).toBe(2);
	});

	it("re-discovers when the resolved client version changes for the same account", async () => {
		let requests = 0;
		const server = http.createServer(
			connectNodeAdapter({
				routes: router => {
					router.service(ServerConfigService, {
						getServerConfig: () => {
							requests++;
							return create(GetServerConfigResponseSchema, {
								http2Config: Http2Config.FORCE_BIDI_DISABLED,
							});
						},
					});
				},
			}),
		);
		servers.add(server);
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const apiKey = "version-key";

		// Default resolved version: caches after a single discovery.
		expect((await resolveCursorTransportMode({ baseUrl, apiKey, provider: "cursor" })).mode).toBe("http1");
		expect((await resolveCursorTransportMode({ baseUrl, apiKey, provider: "cursor" })).mode).toBe("http1");
		expect(requests).toBe(1);

		// A different resolved client version is a distinct cache key: it forces a fresh discovery
		// instead of reusing the default-version entry.
		expect(
			(await resolveCursorTransportMode({ baseUrl, apiKey, provider: "cursor", clientVersion: "0.99.0-test" })).mode,
		).toBe("http1");
		expect(requests).toBe(2);

		// The alt-version entry is itself cached for repeat calls.
		expect(
			(await resolveCursorTransportMode({ baseUrl, apiKey, provider: "cursor", clientVersion: "0.99.0-test" })).mode,
		).toBe("http1");
		expect(requests).toBe(2);
	});

	it("falls back to the HTTP/1 bridge when H2 setup is unavailable before dispatch", async () => {
		if (await runFallbackTestInIsolatedProcess()) return;
		const turnEnded = create(AgentServerMessageSchema, {
			message: {
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
				}),
			},
		});
		let appends = 0;
		const server = http.createServer(
			connectNodeAdapter({
				routes: router => {
					router.service(ServerConfigService, {
						getServerConfig: () =>
							create(GetServerConfigResponseSchema, { http2Config: Http2Config.FORCE_ALL_ENABLED }),
					});
					router.service(CursorBidiService, {
						bidiAppend: () => {
							appends++;
							return create(BidiAppendResponseSchema, {});
						},
					});
					router.service(CursorAgentService, {
						async *runSSE() {
							yield turnEnded;
						},
					});
				},
			}),
		);
		servers.add(server);
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
		vi.spyOn(Http2SessionManager.prototype, "connect").mockRejectedValue(
			Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" }),
		);
		const model = buildModel({
			id: "cursor-http1-fallback",
			name: "Cursor HTTP/1 fallback",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		}) satisfies Model<"cursor-agent">;
		const context: Context = { messages: [{ role: "user", content: "fallback", timestamp: 1 }] };

		const result = await streamCursor(model, context, { apiKey: "fallback-key" }).result();
		expect(result.stopReason).toBe("stop");
		expect(appends).toBeGreaterThan(0);
	});
});
