import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	connectMnemopiEmbedBroker,
	MNEMOPI_EMBED_BROKER_DAEMON_NAME,
	MnemopiEmbedBroker,
	type MnemopiEmbedBrokerOptions,
	mnemopiEmbedBrokerEndpoint,
	mnemopiEmbedBrokerPipeName,
} from "../src/mnemopi/embed-broker";
import {
	encodeMnemopiEmbedBrokerResponse,
	parseMnemopiEmbedBrokerResponse,
} from "../src/mnemopi/embed-broker-protocol";
import type { MnemopiEmbedWorkerHandle } from "../src/mnemopi/embed-client";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "../src/mnemopi/embed-protocol";

class FakeEmbedWorker implements MnemopiEmbedWorkerHandle {
	readonly messages: MnemopiEmbedWorkerInbound[] = [];
	readonly #listeners = new Set<(message: MnemopiEmbedWorkerOutbound) => void>();
	readonly #errors = new Set<(error: Error) => void>();
	terminated = false;
	respond = true;
	readonly terminatedSignal = Promise.withResolvers<void>();
	blockInit = false;
	readonly initBlocked = Promise.withResolvers<void>();
	readonly blockedInits: Array<() => void> = [];

	send(message: MnemopiEmbedWorkerInbound): void {
		this.messages.push(message);
		if (message.type === "init" && this.blockInit) {
			this.blockedInits.push(() => this.#emit({ type: "ready", id: message.id }));
			this.initBlocked.resolve();
			return;
		}
		if (!this.respond) return;
		queueMicrotask(() => {
			if (message.type === "ping") this.#emit({ type: "pong", id: message.id });
			else if (message.type === "init") this.#emit({ type: "ready", id: message.id });
			else {
				const vectors = message.texts.map((_, index) => new Float32Array([index, 1]));
				this.#emit({ type: "vectors", id: message.id, vectors: vectors as unknown as number[][] });
			}
		});
	}

	onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void {
		this.#listeners.add(handler);
		return () => this.#listeners.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errors.add(handler);
		return () => this.#errors.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
		this.terminatedSignal.resolve();
	}

	#emit(message: MnemopiEmbedWorkerOutbound): void {
		for (const listener of this.#listeners) listener(message);
	}
}

function responseFor(
	handle: MnemopiEmbedWorkerHandle,
	message: MnemopiEmbedWorkerInbound,
): Promise<MnemopiEmbedWorkerOutbound> {
	const { promise, resolve } = Promise.withResolvers<MnemopiEmbedWorkerOutbound>();
	const unsubscribe = handle.onMessage(response => {
		if (response.type === "log" || response.id !== message.id) return;
		unsubscribe();
		resolve(response);
	});
	handle.send(message);
	return promise;
}

async function responseErrorFor(handle: MnemopiEmbedWorkerHandle, message: MnemopiEmbedWorkerInbound): Promise<string> {
	const response = await responseFor(handle, message);
	if (response.type !== "error") throw new Error(`Expected error response, received ${response.type}`);
	return response.error;
}

describe("MnemopiEmbedBroker", () => {
	const brokers: MnemopiEmbedBroker[] = [];
	const clients: MnemopiEmbedWorkerHandle[] = [];

	afterEach(async () => {
		await Promise.all(clients.splice(0).map(client => client.terminate()));
		await Promise.all(brokers.splice(0).map(broker => broker.shutdown()));
	});

	async function start(
		tempDir: string,
		options: Partial<MnemopiEmbedBrokerOptions> = {},
	): Promise<{ broker: MnemopiEmbedBroker; endpoint: string; token: string; workers: FakeEmbedWorker[] }> {
		const endpoint = path.join(tempDir, "embed.sock");
		const token = "test-token";
		const workers: FakeEmbedWorker[] = [];
		const broker = new MnemopiEmbedBroker({
			token,
			spawnWorker: () => {
				const worker = new FakeEmbedWorker();
				workers.push(worker);
				return worker;
			},
			...options,
		});
		brokers.push(broker);
		await broker.listen(endpoint);
		return { broker, endpoint, token, workers };
	}

	async function connect(endpoint: string, token: string): Promise<MnemopiEmbedWorkerHandle> {
		const client = await connectMnemopiEmbedBroker({ endpoint, token });
		clients.push(client);
		return client;
	}
	it("versions the daemon identity and endpoint with the authenticated wire protocol", () => {
		expect(MNEMOPI_EMBED_BROKER_DAEMON_NAME).toBe("omp.mnemopi.embed.v2");
		expect(mnemopiEmbedBrokerEndpoint("/tmp/runtime", "first-token")).toBe(
			process.platform === "win32"
				? `\\\\.\\pipe\\${mnemopiEmbedBrokerPipeName("first-token")}`
				: "/tmp/runtime/mnemopi-embed-v2.sock",
		);
		expect(mnemopiEmbedBrokerPipeName("first-token")).not.toBe(mnemopiEmbedBrokerPipeName("second-token"));
		expect(mnemopiEmbedBrokerPipeName("first-token")).not.toContain("first-token");
	});
	it("rejects a correctly signed outbound message with an unsupported variant", () => {
		const token = "test-token";
		const response = encodeMnemopiEmbedBrokerResponse(token, {
			id: "wire-1",
			ok: true,
			message: { type: "mystery", id: "caller-1" } as unknown as MnemopiEmbedWorkerOutbound,
		});
		expect(() => parseMnemopiEmbedBrokerResponse(response, token)).toThrow("unsupported message.type");
	});

	it("authenticates error responses before validating their fields", () => {
		expect(() =>
			parseMnemopiEmbedBrokerResponse(
				{
					protocol: 2,
					id: "wire-1",
					ok: false,
					error: 42,
					mac: "00".repeat(32),
				},
				"test-token",
			),
		).toThrow("authentication failed");
	});

	it("authenticates success responses before validating their message", () => {
		expect(() =>
			parseMnemopiEmbedBrokerResponse(
				{
					protocol: 2,
					id: "wire-1",
					ok: true,
					message: 42,
					mac: "00".repeat(32),
				},
				"test-token",
			),
		).toThrow("authentication failed");
	});

	it("shares one keyed worker across independent clients and preserves equal request ids", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-broker-"));
		const { endpoint, token, workers } = await start(tempDir);
		const first = await connect(endpoint, token);
		const second = await connect(endpoint, token);

		const [firstReady, secondReady] = await Promise.all([
			responseFor(first, { type: "init", id: "same-id", model: "fast-test", cacheDir: tempDir }),
			responseFor(second, { type: "init", id: "same-id", model: "fast-test", cacheDir: tempDir }),
		]);

		expect(firstReady).toEqual({ type: "ready", id: "same-id" });
		expect(secondReady).toEqual({ type: "ready", id: "same-id" });
		expect(workers).toHaveLength(1);
		expect(workers[0]?.messages).toHaveLength(2);
	});

	it("isolates distinct model and cache keys", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-broker-"));
		const firstCache = path.join(tempDir, "one");
		const secondCache = path.join(tempDir, "two");
		await Promise.all([fs.mkdir(firstCache), fs.mkdir(secondCache)]);
		const { endpoint, token, workers } = await start(tempDir);
		const first = await connect(endpoint, token);
		const second = await connect(endpoint, token);

		await Promise.all([
			responseFor(first, { type: "init", id: "1", model: "fast-test", cacheDir: firstCache }),
			responseFor(second, { type: "init", id: "2", model: "fast-test", cacheDir: secondCache }),
			responseFor(second, { type: "init", id: "3", model: "fast-other", cacheDir: firstCache }),
		]);

		expect(workers).toHaveLength(3);
	});

	it("disconnecting clients leaves the shared worker alive until broker shutdown", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-broker-"));
		const { broker, endpoint, token, workers } = await start(tempDir);
		const first = await connect(endpoint, token);
		const second = await connect(endpoint, token);
		await responseFor(first, { type: "init", id: "1", model: "fast-test" });

		await first.terminate();
		expect(
			await Promise.race([
				workers[0]!.terminatedSignal.promise.then(() => "terminated"),
				Bun.sleep(50).then(() => "alive"),
			]),
		).toBe("alive");
		expect(await responseFor(second, { type: "init", id: "2", model: "fast-test" })).toEqual({
			type: "ready",
			id: "2",
		});
		expect(workers).toHaveLength(1);
		expect(workers[0]?.terminated).toBe(false);
		await broker.shutdown();
		expect(workers[0]?.terminated).toBe(true);
	});

	it("rejects a client with the wrong key as a transport failure", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-broker-"));
		const { endpoint } = await start(tempDir);
		const client = await connect(endpoint, "wrong-token");
		const failure = Promise.withResolvers<Error>();
		client.onError(failure.resolve);

		client.send({ type: "init", id: "caller-id", model: "fast-test" });
		expect((await failure.promise).message).toContain("connection closed");
	}, 1_000);

	it("never sends the bearer token and rejects an unsigned fake broker response", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-hostile-"));
		const endpoint = path.join(tempDir, "hostile.sock");
		const token = "secret-bearer-token";
		const captured = Promise.withResolvers<string>();
		const server = net.createServer(socket => {
			socket.setEncoding("utf8");
			socket.once("data", chunk => {
				const line = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				captured.resolve(line);
				const request = JSON.parse(line) as { id: string; message: { id: string } };
				socket.write(
					`${JSON.stringify({
						protocol: 2,
						id: request.id,
						ok: true,
						message: { type: "pong", id: request.message.id },
						mac: "00",
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(endpoint, resolve);
		});
		try {
			const client = await connect(endpoint, token);
			const failure = Promise.withResolvers<Error>();
			client.onError(failure.resolve);
			client.send({ type: "ping", id: "challenge" });
			const frame = await captured.promise;
			expect(frame).not.toContain(token);
			expect((await failure.promise).message).toContain("authentication failed");
			await client.terminate();
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}, 1_000);

	it("allows model initialization to outlive the steady-state request deadline", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-broker-"));
		const { endpoint, token, workers } = await start(tempDir, { workerRequestTimeoutMs: 20 });
		const client = await connect(endpoint, token);
		await responseFor(client, { type: "init", id: "warm-init", model: "fast-other" });
		workers[0]!.blockInit = true;
		const slowInitializing = responseFor(client, { type: "init", id: "slower-init", model: "fast-other" });
		await workers[0].initBlocked.promise;
		const deadlinePassed = Promise.withResolvers<void>();
		setTimeout(deadlinePassed.resolve, 40);
		await deadlinePassed.promise;
		expect(workers[0].terminated).toBe(false);
		workers[0].blockedInits.shift()?.();
		expect(await slowInitializing).toEqual({ type: "ready", id: "slower-init" });
	}, 1_000);
	it("reaps a worker when its client disconnects during unbounded initialization", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-broker-"));
		const { endpoint, token, workers } = await start(tempDir);
		const client = await connect(endpoint, token);
		await responseFor(client, { type: "init", id: "warm-init", model: "fast-test" });
		workers[0]!.blockInit = true;
		client.send({ type: "init", id: "abandoned-init", model: "fast-test" });
		await workers[0]!.initBlocked.promise;

		await client.terminate();
		await workers[0]!.terminatedSignal.promise;
		expect(workers[0]?.terminated).toBe(true);
	}, 1_000);

	it("reaps a hung keyed worker and uses a fresh worker for the next request", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemopi-broker-"));
		const { endpoint, token, workers } = await start(tempDir, { workerRequestTimeoutMs: 20 });
		const client = await connect(endpoint, token);
		await responseFor(client, { type: "init", id: "ready", model: "fast-test" });
		workers[0]!.respond = false;

		expect(
			await responseErrorFor(client, { type: "embed", id: "hung", model: "fast-test", texts: ["one"] }),
		).toContain("timed out");
		expect(workers[0]?.terminated).toBe(true);

		expect(await responseFor(client, { type: "embed", id: "retry", model: "fast-test", texts: ["two"] })).toEqual({
			type: "vectors",
			id: "retry",
			vectors: [[0, 1]],
		});
		expect(workers).toHaveLength(2);
	}, 1_000);
});
