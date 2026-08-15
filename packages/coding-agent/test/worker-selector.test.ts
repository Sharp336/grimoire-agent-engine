import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../src/cli";
import {
	connectMnemopiEmbedBroker,
	MNEMOPI_EMBED_BROKER_ENDPOINT_ENV,
	MNEMOPI_EMBED_BROKER_TOKEN_FILE_ENV,
	MNEMOPI_EMBED_BROKER_WORKER_ARG,
	mnemopiEmbedBrokerEndpoint,
	mnemopiEmbedBrokerReadyBanner,
} from "../src/mnemopi/embed-broker";
import type { MnemopiEmbedWorkerOutbound } from "../src/mnemopi/embed-protocol";
import * as computerWorkerEntry from "../src/tools/computer/worker-entry";

// The worker-host re-entry seam dispatches any `__omp_worker_*` selector to
// `runWorkerEntrypoint`. An unrecognized selector must fail loudly rather than
// exit 0 with empty output, so a stale/mistyped selector cannot look healthy to
// a parent process or install smoke path (issue #5712).
describe("worker selector dispatch", () => {
	beforeEach(() => {
		process.exitCode = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	it("fails with a nonzero exit and stderr error on an unknown selector", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runCli(["__omp_worker_does_not_exist"]);

		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("Error: unknown worker selector: __omp_worker_does_not_exist\n");
	});

	it("leaves normal root flags untouched", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runCli(["--version"]);

		expect(process.exitCode).toBe(0);
		expect(stdout).toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("unknown worker selector"));
	});
});

it("starts the authenticated embedding broker through the real CLI entry", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-selector-"));
	const token = "selector-test-token";
	const tokenFile = path.join(tempDir, "token");
	const endpoint = mnemopiEmbedBrokerEndpoint(tempDir, token);
	await fs.writeFile(tokenFile, token, { mode: 0o600 });
	const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
	const proc = Bun.spawn([process.execPath, cliEntry, MNEMOPI_EMBED_BROKER_WORKER_ARG], {
		env: {
			...process.env,
			[MNEMOPI_EMBED_BROKER_ENDPOINT_ENV]: endpoint,
			[MNEMOPI_EMBED_BROKER_TOKEN_FILE_ENV]: tokenFile,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = proc.stdout.getReader();
	try {
		const expectedBanner = mnemopiEmbedBrokerReadyBanner(endpoint);
		const ready = Promise.withResolvers<void>();
		const timer = setTimeout(() => ready.reject(new Error("embedding broker ready banner timed out")), 5_000);
		timer.unref();
		void (async () => {
			const decoder = new TextDecoder();
			let output = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error(`embedding broker exited before ready: ${output}`);
				output += decoder.decode(chunk.value, { stream: true });
				if (output.includes(expectedBanner)) return ready.resolve();
			}
		})().catch(ready.reject);
		await ready.promise.finally(() => clearTimeout(timer));

		const client = await connectMnemopiEmbedBroker({ endpoint, token });
		try {
			const response = Promise.withResolvers<MnemopiEmbedWorkerOutbound>();
			const unsubscribe = client.onMessage(response.resolve);
			client.send({ type: "ping", id: "selector-ping" });
			expect(await response.promise).toEqual({ type: "pong", id: "selector-ping" });
			unsubscribe();
		} finally {
			await client.terminate();
		}
	} finally {
		await reader.cancel();
		proc.kill("SIGTERM");
		await proc.exited;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}, 15_000);

describe("computer worker entry", () => {
	it("is side-effect-free to import outside a worker and exposes a named start function", () => {
		// Importing on the main thread (no parentPort) must not start the worker
		// core; the CLI host and bundled hosts call the exported hook explicitly.
		expect(computerWorkerEntry.startComputerWorker).toBeFunction();
	});
});
