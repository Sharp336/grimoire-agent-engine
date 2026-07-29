import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { disposeServerConfigCache, resolveCursorTransportMode } from "@oh-my-pi/pi-ai/providers/cursor/server-config";
import { CursorServerConfigService } from "@oh-my-pi/pi-ai/providers/cursor/transport-descriptors";
import {
	type GetServerConfigResponse,
	GetServerConfigResponseSchema,
	Http2Config,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";

const servers = new Set<http.Server>();

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeServerConfigCache();
	for (const server of servers) {
		const closed = Promise.withResolvers<void>();
		server.close(error => (error ? closed.reject(error) : closed.resolve()));
		await closed.promise;
	}
	servers.clear();
});
async function serve(handler: () => GetServerConfigResponse): Promise<string> {
	const adapter = connectNodeAdapter({
		routes: router => router.service(CursorServerConfigService, { getServerConfig: handler }),
	});
	const server = http.createServer(adapter);
	servers.add(server);
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing Cursor config fixture port");
	return `http://127.0.0.1:${address.port}`;
}

describe("Cursor server config", () => {
	it("retries discovery after the transient-failure TTL", async () => {
		let calls = 0;
		const baseUrl = await serve(() => {
			calls += 1;
			if (calls === 1) throw new ConnectError("temporary", Code.Unavailable);
			return create(GetServerConfigResponseSchema, { http2Config: Http2Config.FORCE_BIDI_DISABLED });
		});
		const options = { baseUrl, apiKey: "key", provider: "cursor" };

		expect((await resolveCursorTransportMode(options)).mode).toBe("http2");
		vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
		expect((await resolveCursorTransportMode(options)).mode).toBe("http1");
		expect(calls).toBe(2);
	});
});
