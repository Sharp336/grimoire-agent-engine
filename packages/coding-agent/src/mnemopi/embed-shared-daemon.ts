import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getGlobalDaemonRuntimeDir, isEexist, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { daemonClientForGlobal } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";
import {
	connectMnemopiEmbedBroker,
	MNEMOPI_EMBED_BROKER_DAEMON_NAME,
	MNEMOPI_EMBED_BROKER_ENDPOINT_ENV,
	MNEMOPI_EMBED_BROKER_READY_PATTERN,
	MNEMOPI_EMBED_BROKER_SCOPE,
	MNEMOPI_EMBED_BROKER_TOKEN_FILE_ENV,
	MNEMOPI_EMBED_BROKER_WORKER_ARG,
	mnemopiEmbedBrokerEndpoint,
} from "./embed-broker";
import type { MnemopiEmbedWorkerHandle } from "./embed-client";

const TOKEN_FILE = "mnemopi-embed.token";
const READY_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;
const ENSURE_ATTEMPTS = 3;

async function readOrCreateToken(runtimeDir: string): Promise<{ path: string; token: string }> {
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const tokenPath = path.join(runtimeDir, TOKEN_FILE);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const token = (await fs.readFile(tokenPath, "utf8")).trim();
			if (token) return { path: tokenPath, token };
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		try {
			const handle = await fs.open(tokenPath, "wx", 0o600);
			try {
				const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
				await handle.writeFile(token, "utf8");
				return { path: tokenPath, token };
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out initializing Mnemopi embed broker token in ${runtimeDir}`);
}

async function connectVerified(endpoint: string, token: string): Promise<MnemopiEmbedWorkerHandle> {
	const worker = await connectMnemopiEmbedBroker({ endpoint, token, timeoutMs: PROBE_TIMEOUT_MS });
	const id = `probe:${crypto.randomUUID()}`;
	const result = Promise.withResolvers<void>();
	const timer = setTimeout(() => result.reject(new Error("Mnemopi embed broker ping timed out")), PROBE_TIMEOUT_MS);
	timer.unref();
	const unsubscribeMessage = worker.onMessage(message => {
		if (message.type === "log" || message.id !== id) return;
		if (message.type === "pong") result.resolve();
		else result.reject(new Error(message.type === "error" ? message.error : "Mnemopi embed broker ping mismatch"));
	});
	const unsubscribeError = worker.onError(result.reject);
	try {
		worker.send({ type: "ping", id });
		await result.promise;
		return worker;
	} catch (error) {
		await worker.terminate();
		throw error;
	} finally {
		clearTimeout(timer);
		unsubscribeMessage();
		unsubscribeError();
	}
}

async function tryConnect(endpoint: string, token: string): Promise<MnemopiEmbedWorkerHandle | undefined> {
	try {
		return await connectVerified(endpoint, token);
	} catch {
		return undefined;
	}
}

/** Acquire one authenticated link to the machine-global, protocol-versioned embedding broker. */
export async function acquireGlobalMnemopiEmbedWorker(): Promise<MnemopiEmbedWorkerHandle> {
	const runtimeDir = getGlobalDaemonRuntimeDir(MNEMOPI_EMBED_BROKER_SCOPE);
	const credentials = await readOrCreateToken(runtimeDir);
	const endpoint = mnemopiEmbedBrokerEndpoint(runtimeDir, credentials.token);
	const client = await daemonClientForGlobal(MNEMOPI_EMBED_BROKER_SCOPE);
	// Establish the launch-broker lease before probing or starting its child.
	await client.request({ op: "ping" });
	const connected = await tryConnect(endpoint, credentials.token);
	if (connected) return connected;

	const spawn = resolveWorkerSpawnCmd(MNEMOPI_EMBED_BROKER_WORKER_ARG);
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		const raced = await tryConnect(endpoint, credentials.token);
		if (raced) return raced;
		const existing = await describeQuietly(client, MNEMOPI_EMBED_BROKER_DAEMON_NAME, "Mnemopi embed broker");
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) {
				await waitReady(
					client,
					MNEMOPI_EMBED_BROKER_DAEMON_NAME,
					"Mnemopi embed broker",
					undefined,
					READY_TIMEOUT_MS,
				);
			}
			const adopted = await tryConnect(endpoint, credentials.token);
			if (adopted) return adopted;
			await stopQuietly(client, MNEMOPI_EMBED_BROKER_DAEMON_NAME, "Mnemopi embed broker");
			continue;
		}
		try {
			await client.request({
				op: "start",
				spec: {
					name: MNEMOPI_EMBED_BROKER_DAEMON_NAME,
					application: spawn.cmd[0]!,
					args: spawn.cmd.slice(1),
					env: {
						[MNEMOPI_EMBED_BROKER_ENDPOINT_ENV]: endpoint,
						[MNEMOPI_EMBED_BROKER_TOKEN_FILE_ENV]: credentials.path,
					},
					cwd: spawn.cwd ?? client.projectDir,
					pty: false,
					ready: { log: MNEMOPI_EMBED_BROKER_READY_PATTERN, timeoutMs: READY_TIMEOUT_MS },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const started = await tryConnect(endpoint, credentials.token);
			if (started) return started;
			await stopQuietly(client, MNEMOPI_EMBED_BROKER_DAEMON_NAME, "Mnemopi embed broker");
		} catch (error) {
			logger.debug("Mnemopi embed broker start contention", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	throw new Error("Mnemopi embed broker could not be started");
}
