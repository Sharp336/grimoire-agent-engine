import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { disposeCursorTransport, streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// A CONNECT proxy that records the tunnel request line and then refuses the
// tunnel (407) so the handshake fails deterministically without needing TLS.
interface CaptureProxy {
	url: string;
	connects: string[];
	close(): Promise<void>;
}

async function startCaptureProxy(): Promise<CaptureProxy> {
	const connects: string[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.once("data", chunk => {
			const firstLine = chunk.toString("utf8").split("\r\n")[0];
			connects.push(firstLine);
			socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
			socket.end();
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected proxy tcp port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		connects,
		async close() {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		},
	};
}

function makeModel(): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-proxy-fixture",
		name: "Cursor proxy fixture",
		api: "cursor-agent",
		provider: "cursor",
		// A non-local host so the proxy is not bypassed by the local-host rule.
		baseUrl: "https://cursor.example",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "proxy routing", timestamp: 1 }],
};

let proxy: CaptureProxy | undefined;
let savedProxyEnv: string | undefined;

beforeEach(() => {
	savedProxyEnv = Bun.env.PI_PROXY_CURSOR;
});

afterEach(async () => {
	if (savedProxyEnv === undefined) delete Bun.env.PI_PROXY_CURSOR;
	else Bun.env.PI_PROXY_CURSOR = savedProxyEnv;
	__resetProxyCache();
	disposeCursorTransport();
	await proxy?.close();
	proxy = undefined;
});

describe("Cursor pool CONNECT-proxy routing", () => {
	it("tunnels the Run request through the configured proxy for a non-local host", async () => {
		proxy = await startCaptureProxy();
		Bun.env.PI_PROXY_CURSOR = proxy.url;
		__resetProxyCache();

		const stream = streamCursor(makeModel(), context, { apiKey: "test-token" });
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();

		// The pool routed through the proxy (CONNECT observed) instead of dialing
		// the origin directly, and it targeted the model host on the TLS port.
		expect(proxy.connects.length).toBeGreaterThanOrEqual(1);
		for (const line of proxy.connects) {
			expect(line).toBe("CONNECT cursor.example:443 HTTP/1.1");
		}
		expect(result.stopReason).toBe("error");
	});
});
