/**
 * Isolated subprocess fixture for Invariant 2: proxy precedence, NO_PROXY
 * bypass, and server-config HTTP/1 transport resolution. Runs in its own
 * process so Bun.env mutations never leak into the main test runner, and
 * restores the environment before exit. Emits a structured JSON result on
 * stdout so the parent test parses exact assertions rather than bare
 * exit codes.
 */
import * as http from "node:http";
import type * as net from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import { GetServerConfigResponseSchema, Http2Config } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import { resolveCursorTransportMode } from "../../src/providers/cursor/server-config";
import { __resetProxyCache, getProxyForProvider, shouldBypassProxy } from "../../src/utils/proxy";

interface Result {
	ok: boolean;
	steps: Array<{ name: string; passed: boolean; expected: string; actual: string }>;
	error?: string;
}

const PROXY_KEYS = [
	"PI_PROXY",
	"PI_PROXY_CURSOR",
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"NO_PROXY",
	"no_proxy",
	"ALL_PROXY",
	"all_proxy",
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const k of PROXY_KEYS) savedEnv[k] = process.env[k];

function clearAllProxyKeys(): void {
	for (const k of PROXY_KEYS) delete process.env[k];
}

function restoreEnv(): void {
	for (const k of PROXY_KEYS) {
		if (savedEnv[k] === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = savedEnv[k];
		}
	}
	__resetProxyCache();
}

async function closeServerAsync(server: net.Server): Promise<void> {
	(server as http.Server).closeAllConnections?.();
	server.unref();
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	await promise;
}

function check(
	name: string,
	expected: string,
	actual: string | undefined,
): { name: string; passed: boolean; expected: string; actual: string } {
	const a = actual ?? "";
	return { name, passed: expected === a, expected, actual: a };
}

async function main(): Promise<Result> {
	const steps: Result["steps"] = [];

	// Start from a clean slate so inherited proxy vars don't interfere.
	clearAllProxyKeys();

	// Step 1: HTTPS_PROXY precedence
	{
		__resetProxyCache();
		process.env.HTTPS_PROXY = "http://proxy-https:8080";
		__resetProxyCache();
		const actual = getProxyForProvider("cursor");
		steps.push(check("HTTPS_PROXY", "http://proxy-https:8080", actual));
	}

	// Step 2: PI_PROXY > HTTPS_PROXY
	{
		process.env.PI_PROXY = "http://proxy-pi:8080";
		__resetProxyCache();
		const actual = getProxyForProvider("cursor");
		steps.push(check("PI_PROXY > HTTPS_PROXY", "http://proxy-pi:8080", actual));
	}

	// Step 3: PI_PROXY_CURSOR > PI_PROXY
	{
		process.env.PI_PROXY_CURSOR = "http://proxy-cursor:8080";
		__resetProxyCache();
		const actual = getProxyForProvider("cursor");
		steps.push(check("PI_PROXY_CURSOR > PI_PROXY", "http://proxy-cursor:8080", actual));
	}

	// Step 4: NO_PROXY bypass — start clean, set only the keys this step needs
	{
		clearAllProxyKeys();
		process.env.PI_PROXY = "http://proxy-pi:8080";
		process.env.NO_PROXY = "bypassed.example.com";
		__resetProxyCache();
		const bypassed = shouldBypassProxy(new URL("http://bypassed.example.com:8080"));
		const other = shouldBypassProxy(new URL("http://other.example.com:8080"));
		steps.push(check("NO_PROXY bypass match", "true", String(bypassed)));
		steps.push(check("NO_PROXY bypass no-match", "false", String(other)));
	}

	// Step 5: server config HTTP/1 via FORCE_ALL_DISABLED.
	// Clear ALL proxy keys so the localhost mock server is never routed
	// through a proxy.
	{
		clearAllProxyKeys();
		__resetProxyCache();

		const mockServer = http.createServer((req, res) => {
			if (req.url?.includes("GetServerConfig")) {
				const body = toBinary(
					GetServerConfigResponseSchema,
					create(GetServerConfigResponseSchema, { http2Config: Http2Config.FORCE_ALL_DISABLED }),
				);
				res.writeHead(200, { "Content-Type": "application/proto" });
				res.end(body);
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		const listening = Promise.withResolvers<void>();
		mockServer.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const port = (mockServer.address() as net.AddressInfo).port;
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			const res = await resolveCursorTransportMode({
				baseUrl,
				apiKey: "test-key",
				provider: "cursor",
				useHttp1ForAgent: false,
			});
			steps.push(check("GetServerConfig HTTP/1 mode", "http1", res.mode));
		} finally {
			await closeServerAsync(mockServer);
		}
	}

	const ok = steps.every(s => s.passed);
	return { ok, steps };
}

try {
	const result = await main();
	restoreEnv();
	process.stdout.write(JSON.stringify(result));
	if (!result.ok) {
		process.exit(1);
	}
} catch (error) {
	restoreEnv();
	const result: Result = {
		ok: false,
		steps: [],
		error: error instanceof Error ? error.message : String(error),
	};
	process.stdout.write(JSON.stringify(result));
	process.exit(1);
}
