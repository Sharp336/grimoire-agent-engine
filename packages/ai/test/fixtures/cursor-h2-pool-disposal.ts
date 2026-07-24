import * as http2 from "node:http2";
import { __getH2PoolStats, acquireH2Session, disposeCursorH2Pool } from "../../src/providers/cursor/h2-pool";

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();

async function startServer(): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	server = http2.createServer();
	server.on("session", (session: http2.Http2Session) => {
		sessions.add(session);
		session.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "text/plain" });
			stream.end("ok");
		});
	});
	server.listen(0, "127.0.0.1", () => {
		const addr = server?.address();
		if (addr && typeof addr === "object") {
			resolve(`http://127.0.0.1:${addr.port}`);
		}
	});
	return promise;
}

async function stopServer(): Promise<void> {
	if (server) {
		for (const session of sessions) session.destroy();
		sessions.clear();
		await new Promise<void>(resolve => server?.close(() => resolve()));
	}
}

try {
	const baseUrl = await startServer();
	const lease = await acquireH2Session(baseUrl, "cursor-agent");
	lease.release();

	await disposeCursorH2Pool();

	const stats = __getH2PoolStats();
	if (stats.poolCount !== 0 || stats.retiringCount !== 0) {
		throw new Error(
			`Expected poolCount=0, retiringCount=0, got poolCount=${stats.poolCount}, retiringCount=${stats.retiringCount}`,
		);
	}

	// Test idempotent disposal
	await disposeCursorH2Pool();

	await stopServer();
	process.stdout.write("OK\n");
} catch (error) {
	await stopServer();
	console.error(error);
	process.exit(1);
}
