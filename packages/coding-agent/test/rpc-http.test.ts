import { afterEach, describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	DEFAULT_RPC_HTTP_BIND,
	isLoopbackHostname,
	type RpcHttpServer,
	resolveRpcHttpAuth,
	startRpcHttpServer,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-http";

const servers: RpcHttpServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.close()));
});

async function readNdjsonLine(res: Response): Promise<Record<string, unknown>> {
	const reader = res.body?.getReader();
	if (!reader) throw new Error("missing body");
	const decoder = new TextDecoder();
	let buf = "";
	while (!buf.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error("stream ended before a JSON line");
		buf += decoder.decode(value, { stream: true });
	}
	await reader.cancel();
	return JSON.parse(buf.slice(0, buf.indexOf("\n"))) as Record<string, unknown>;
}

describe("parseArgs --http", () => {
	it("defaults to loopback:8765 when bare", () => {
		const result = parseArgs(["--mode", "rpc", "--http"]);
		expect(result.http).toBe(DEFAULT_RPC_HTTP_BIND);
		expect(result.mode).toBe("rpc");
	});

	it("accepts a bind value and equals form", () => {
		expect(parseArgs(["--http", "9000"]).http).toBe("9000");
		expect(parseArgs(["--http=0.0.0.0:8765"]).http).toBe("0.0.0.0:8765");
	});

	it("does not swallow the next flag", () => {
		const result = parseArgs(["--http", "--no-session"]);
		expect(result.http).toBe(DEFAULT_RPC_HTTP_BIND);
		expect(result.noSession).toBe(true);
	});

	it("parses token and no-auth flags", () => {
		const result = parseArgs(["--http", "--http-token", "secret", "--http-no-auth"]);
		expect(result.httpToken).toBe("secret");
		expect(result.httpNoAuth).toBe(true);
	});
});

describe("resolveRpcHttpAuth", () => {
	it("rejects --http-no-auth on non-loopback binds", () => {
		expect(() => resolveRpcHttpAuth({ bind: "0.0.0.0:8765", noAuth: true })).toThrow(/loopback/);
	});

	it("allows --http-no-auth on loopback", () => {
		const auth = resolveRpcHttpAuth({ bind: "127.0.0.1:8765", noAuth: true });
		expect(auth.token).toBeNull();
		expect(auth.tokens.size).toBe(0);
	});

	it("generates a bearer token by default", () => {
		const auth = resolveRpcHttpAuth({ bind: "127.0.0.1:0" });
		expect(auth.token).toBeTruthy();
		expect(auth.tokens.has(auth.token!)).toBe(true);
	});
});

describe("isLoopbackHostname", () => {
	it("recognizes ipv4, ipv6, and localhost", () => {
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("0.0.0.0")).toBe(false);
	});
});

describe("startRpcHttpServer", () => {
	it("serves healthz without a bearer token", async () => {
		const server = startRpcHttpServer({ bind: "127.0.0.1:0", token: "secret" });
		servers.push(server);
		const res = await fetch(`${server.url}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	it("rejects unauthorized /rpc", async () => {
		const server = startRpcHttpServer({ bind: "127.0.0.1:0", token: "secret" });
		servers.push(server);
		const res = await fetch(`${server.url}/rpc`);
		expect(res.status).toBe(401);
	});

	it("streams buffered outbound frames as NDJSON and accepts POST commands", async () => {
		const server = startRpcHttpServer({ bind: "127.0.0.1:0", noAuth: true });
		servers.push(server);
		expect(server.sink.write(`${JSON.stringify({ type: "ready" })}\n`)).toBe(true);

		const inbound: unknown[] = [];
		const consume = (async () => {
			for await (const chunk of server.input) {
				inbound.push(JSON.parse(new TextDecoder().decode(chunk)));
			}
		})();

		const stream = fetch(`${server.url}/rpc`);
		const posted = await fetch(`${server.url}/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "s1", type: "get_state" }),
		});
		expect(posted.status).toBe(202);

		const res = await stream;
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		expect(await readNdjsonLine(res)).toEqual({ type: "ready" });

		await server.close();
		await consume;
		expect(inbound).toEqual([{ id: "s1", type: "get_state" }]);
	});

	it("returns 409 when a second stream attaches", async () => {
		const server = startRpcHttpServer({ bind: "127.0.0.1:0", noAuth: true });
		servers.push(server);
		server.sink.write(`${JSON.stringify({ type: "ready" })}\n`);
		const first = await fetch(`${server.url}/rpc`);
		expect(first.status).toBe(200);
		const second = await fetch(`${server.url}/rpc`);
		expect(second.status).toBe(409);
		await first.body?.cancel();
	});
});
