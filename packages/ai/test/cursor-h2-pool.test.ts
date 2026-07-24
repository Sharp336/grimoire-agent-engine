import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import * as path from "node:path";
import { __evictH2PoolEntry, __getH2PoolStatsForOrigin, acquireH2Session } from "../src/providers/cursor/h2-pool";

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let sessionCount = 0;
const activeBaseUrls: string[] = [];
async function startServer(): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	server = http2.createServer();
	server.on("session", (session: http2.Http2Session) => {
		sessions.add(session);
		sessionCount++;
		session.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "text/plain" });
			stream.end("ok");
		});
	});
	server.listen(0, "127.0.0.1", () => {
		const addr = server?.address();
		if (addr && typeof addr === "object") {
			const baseUrl = `http://127.0.0.1:${addr.port}`;
			activeBaseUrls.push(baseUrl);
			resolve(baseUrl);
		}
	});
	return promise;
}

let server2: http2.Http2Server | undefined;
const sessions2 = new Set<http2.Http2Session>();

async function startServer2(): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	server2 = http2.createServer();
	server2.on("session", (session: http2.Http2Session) => {
		sessions2.add(session);
		session.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "text/plain" });
			stream.end("ok");
		});
	});
	server2.listen(0, "127.0.0.1", () => {
		const addr = server2?.address();
		if (addr && typeof addr === "object") {
			const baseUrl = `http://127.0.0.1:${addr.port}`;
			activeBaseUrls.push(baseUrl);
			resolve(baseUrl);
		}
	});
	return promise;
}

async function stopServer(): Promise<void> {
	const s = server;
	server = undefined;
	if (s) {
		for (const session of sessions) session.destroy();
		sessions.clear();
		await new Promise<void>(resolve => s.close(() => resolve()));
	}
	const s2 = server2;
	server2 = undefined;
	if (s2) {
		for (const session of sessions2) session.destroy();
		sessions2.clear();
		await new Promise<void>(resolve => s2.close(() => resolve()));
	}
	sessionCount = 0;
}

afterEach(async () => {
	for (const url of activeBaseUrls) {
		__evictH2PoolEntry(url);
	}
	activeBaseUrls.length = 0;
	await stopServer();
});

describe("H2 pool cold acquisition", () => {
	it("creates at most 4 managers for 5 concurrent cold acquisitions", async () => {
		const baseUrl = await startServer();
		const leases = await Promise.all(
			Array.from({ length: 5 }, () =>
				acquireH2Session(baseUrl, "cursor-agent").then(lease => {
					lease.release();
				}),
			),
		);
		expect(leases.length).toBe(5);
		// At most 4 HTTP/2 sessions should have been created.
		expect(sessionCount).toBeLessThanOrEqual(4);
		const stats = __getH2PoolStatsForOrigin(baseUrl);
		expect(stats.poolCount).toBe(1);
	});

	it("leases and releases a healthy session, reuses on re-acquisition", async () => {
		const baseUrl = await startServer();
		const lease = await acquireH2Session(baseUrl, "cursor-agent");
		expect(lease.manager).toBeDefined();
		lease.release();
		const countBefore = sessionCount;
		const lease2 = await acquireH2Session(baseUrl, "cursor-agent");
		lease2.release();
		// Re-acquisition should reuse the existing session, not create a new one.
		expect(sessionCount).toBe(countBefore);
	});
});

describe("H2 pool cancellation isolation", () => {
	it("aborting one acquisition does not fail another", async () => {
		const baseUrl = await startServer();
		const ac1 = new AbortController();
		const ac2 = new AbortController();

		const p1 = acquireH2Session(baseUrl, "cursor-agent", ac1.signal).then(lease => {
			lease.release();
			return "ok";
		});
		const p2 = acquireH2Session(baseUrl, "cursor-agent", ac2.signal).then(lease => {
			lease.release();
			return "ok";
		});

		ac1.abort();

		// The second should still succeed.
		const result2 = await p2;
		expect(result2).toBe("ok");

		// The first should reject with an AbortError.
		await expect(p1).rejects.toThrow();
		try {
			await p1;
		} catch (error) {
			expect((error as Error).name).toBe("AbortError");
		}
	});
});

describe("H2 pool disposal", () => {
	it("closes all pooled sessions on disposal and operates idempotently in an isolated process", async () => {
		const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-h2-pool-disposal.ts")], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stderr.trim()).toBe("");
		expect(stdout.trim()).toBe("OK");
	});
});

describe("H2 pool key isolation", () => {
	it("different origins use different pool entries", async () => {
		const baseUrl1 = await startServer();
		const baseUrl2 = await startServer2();

		const lease1 = await acquireH2Session(baseUrl1, "cursor-agent");
		lease1.release();
		const lease2 = await acquireH2Session(baseUrl2, "cursor-agent");
		lease2.release();

		expect(__getH2PoolStatsForOrigin(baseUrl1).poolCount).toBe(1);
		expect(__getH2PoolStatsForOrigin(baseUrl2).poolCount).toBe(1);
	});
});
