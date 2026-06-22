import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting } from "./tools-manager";

const { downloadFile } = __internalsForTesting;

afterEach(() => {
	vi.restoreAllMocks();
});

// A chunked streaming body. `Bun.write(dest, response)` deadlocks on a body like
// this (oven-sh/bun#30594) — many small chunks are enough; no timers needed — so
// this test hangs (and fails on the suite timeout) against the old code and
// passes against the streamed `pipeline` write.
function streamingResponse(chunks: number, chunkSize: number): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(chunkSize));
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

test("downloadFile streams a chunked response body to disk without deadlocking", async () => {
	const chunks = 300;
	const chunkSize = 64 * 1024;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(streamingResponse(chunks, chunkSize));
	const dest = path.join(os.tmpdir(), `omp-dl-${process.pid}-${Math.random().toString(36).slice(2)}`);
	try {
		await downloadFile("https://example.test/asset", dest);
		expect(fs.statSync(dest).size).toBe(chunks * chunkSize);
	} finally {
		fs.rmSync(dest, { force: true });
	}
}, 10_000);
