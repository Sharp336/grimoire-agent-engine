import { afterEach, describe, expect, it } from "bun:test";
import * as http from "node:http";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
	GetServerConfigResponseSchema,
	Http2Config,
	ServerConfigService,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import { disposeServerConfigCache, resolveCursorTransportMode } from "../src/providers/cursor/server-config";

const servers = new Set<http.Server>();

afterEach(async () => {
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
});
