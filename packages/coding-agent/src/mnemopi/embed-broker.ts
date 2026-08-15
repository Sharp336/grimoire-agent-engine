import { createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import {
	encodeMnemopiEmbedBrokerRequest,
	encodeMnemopiEmbedBrokerResponse,
	MNEMOPI_EMBED_BROKER_PROTOCOL,
	parseMnemopiEmbedBrokerRequest,
	parseMnemopiEmbedBrokerResponse,
} from "./embed-broker-protocol";
import type { MnemopiEmbedWorkerHandle } from "./embed-client";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

const MAX_LINE_BYTES = 16 * 1024 * 1024;

const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 120_000;

export const MNEMOPI_EMBED_BROKER_SCOPE = `mnemopi-embed-v${MNEMOPI_EMBED_BROKER_PROTOCOL}`;
export const MNEMOPI_EMBED_BROKER_DAEMON_NAME = `omp.mnemopi.embed.v${MNEMOPI_EMBED_BROKER_PROTOCOL}`;
export const MNEMOPI_EMBED_BROKER_WORKER_ARG = "__omp_worker_mnemopi_embed_broker";
export const MNEMOPI_EMBED_BROKER_ENDPOINT_ENV = "OMP_MNEMOPI_EMBED_BROKER_ENDPOINT";
export const MNEMOPI_EMBED_BROKER_TOKEN_FILE_ENV = "OMP_MNEMOPI_EMBED_BROKER_TOKEN_FILE";
export const MNEMOPI_EMBED_BROKER_READY_PATTERN = String.raw`omp mnemopi embed broker listening on \S+`;

export function mnemopiEmbedBrokerPipeName(token: string): string {
	const key = createHmac("sha256", token).update(MNEMOPI_EMBED_BROKER_SCOPE).digest("hex").slice(0, 32);
	return `omp-mnemopi-embed-v${MNEMOPI_EMBED_BROKER_PROTOCOL}-${key}`;
}

export function mnemopiEmbedBrokerEndpoint(runtimeDir: string, token: string): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\${mnemopiEmbedBrokerPipeName(token)}`;
	return path.join(runtimeDir, `mnemopi-embed-v${MNEMOPI_EMBED_BROKER_PROTOCOL}.sock`);
}

export function mnemopiEmbedBrokerReadyBanner(endpoint: string): string {
	return `omp mnemopi embed broker listening on ${endpoint}`;
}
interface PendingWorkerRequest {
	socket: net.Socket;
	resolve: (message: MnemopiEmbedWorkerOutbound) => void;
	reject: (error: Error) => void;
}

interface WorkerSlot {
	worker: MnemopiEmbedWorkerHandle;
	queue: Promise<void>;
	pending: Map<string, PendingWorkerRequest>;
	retired: boolean;
	unsubscribeMessage: () => void;
	unsubscribeError: () => void;
}

export interface MnemopiEmbedBrokerOptions {
	token: string;
	spawnWorker: () => MnemopiEmbedWorkerHandle;
	workerRequestTimeoutMs?: number;
}

function cacheKey(message: Extract<MnemopiEmbedWorkerInbound, { type: "init" | "embed" }>): string {
	const cacheDir = message.cacheDir === undefined ? "" : path.resolve(message.cacheDir);
	return `${message.model}\u0000${cacheDir}`;
}

/** Owns one disposable embedding worker per model/cache key and multiplexes independent OMP clients onto it. */
export class MnemopiEmbedBroker {
	readonly #token: string;
	readonly #spawnWorker: () => MnemopiEmbedWorkerHandle;
	readonly #workerRequestTimeoutMs: number;
	readonly #slots = new Map<string, WorkerSlot>();
	readonly #sockets = new Set<net.Socket>();
	#server: net.Server | undefined;
	#endpoint: string | undefined;
	#nextWorkerRequestId = 0;
	#shuttingDown = false;

	constructor(options: MnemopiEmbedBrokerOptions) {
		if (!options.token) throw new Error("Mnemopi embed broker token is empty");
		this.#token = options.token;
		this.#spawnWorker = options.spawnWorker;
		this.#workerRequestTimeoutMs = options.workerRequestTimeoutMs ?? DEFAULT_WORKER_REQUEST_TIMEOUT_MS;
	}

	get workerCount(): number {
		return this.#slots.size;
	}

	async listen(endpoint: string): Promise<void> {
		if (this.#server) throw new Error("Mnemopi embed broker is already listening");
		if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		this.#endpoint = endpoint;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(endpoint);
		await promise;
		if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return;
		this.#shuttingDown = true;
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		await Promise.all([...this.#slots.values()].map(slot => this.#retireSlot(slot, new Error("broker shutdown"))));
		this.#slots.clear();
		const server = this.#server;
		this.#server = undefined;
		if (server) {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			await promise;
		}
		if (process.platform !== "win32" && this.#endpoint) await fs.rm(this.#endpoint, { force: true });
	}

	#accept(socket: net.Socket): void {
		this.#sockets.add(socket);
		let buffer = "";
		let bufferBytes = 0;
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			buffer += text;
			bufferBytes += Buffer.byteLength(text);
			if (bufferBytes > MAX_LINE_BYTES) {
				socket.destroy(new Error("Mnemopi embed broker request exceeds size limit"));
				return;
			}
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				bufferBytes -= Buffer.byteLength(line) + 1;
				buffer = buffer.slice(newline + 1);
				if (line) void this.#handleLine(socket, line);
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => this.#clientDisconnected(socket));
	}

	#clientDisconnected(socket: net.Socket): void {
		this.#sockets.delete(socket);
		for (const slot of this.#slots.values()) {
			if ([...slot.pending.values()].some(pending => pending.socket === socket)) {
				void this.#dropSlot(slot, new Error("Embedding client disconnected"));
			}
		}
	}
	async #handleLine(socket: net.Socket, line: string): Promise<void> {
		let wireId = "unknown";
		let callerId = "unknown";
		try {
			const request = parseMnemopiEmbedBrokerRequest(JSON.parse(line) as unknown, this.#token);
			wireId = request.id;
			callerId = request.message.id;
			const message = request.message;
			if (message.type === "ping") {
				this.#reply(socket, wireId, { type: "pong", id: message.id });
				return;
			}
			const response = await this.#dispatch(socket, message);
			if (response.type === "log") throw new Error("Mnemopi embed worker returned an uncorrelated log response");
			this.#reply(socket, wireId, { ...response, id: message.id });
		} catch (error) {
			if (callerId === "unknown") {
				socket.destroy();
				return;
			}
			const detail = error instanceof Error ? error.message : String(error);
			this.#reply(socket, wireId, { type: "error", id: callerId, error: detail });
		}
	}
	#dispatch(
		socket: net.Socket,
		message: Extract<MnemopiEmbedWorkerInbound, { type: "init" | "embed" }>,
	): Promise<MnemopiEmbedWorkerOutbound> {
		const key = cacheKey(message);
		const slot = this.#slot(key);
		const { promise, resolve, reject } = Promise.withResolvers<MnemopiEmbedWorkerOutbound>();
		slot.queue = slot.queue
			.then(async () => {
				if (socket.destroyed) throw new Error("Embedding client disconnected");
				if (slot.retired) return this.#dispatch(socket, message).then(resolve, reject);
				const id = `broker:${++this.#nextWorkerRequestId}`;
				const response = Promise.withResolvers<MnemopiEmbedWorkerOutbound>();
				slot.pending.set(id, { socket, resolve: response.resolve, reject: response.reject });
				const timer =
					message.type === "embed"
						? setTimeout(
								() => void this.#dropSlot(slot, new Error("Mnemopi embed worker request timed out")),
								this.#workerRequestTimeoutMs,
							)
						: undefined;
				timer?.unref();
				try {
					slot.worker.send({ ...message, id });
					resolve(await response.promise);
				} finally {
					if (timer) clearTimeout(timer);
					slot.pending.delete(id);
				}
			})
			.catch(reject);
		return promise;
	}

	#slot(key: string): WorkerSlot {
		const existing = this.#slots.get(key);
		if (existing && !existing.retired) return existing;
		const worker = this.#spawnWorker();
		const slot: WorkerSlot = {
			worker,
			queue: Promise.resolve(),
			pending: new Map(),
			retired: false,
			unsubscribeMessage: () => {},
			unsubscribeError: () => {},
		};
		slot.unsubscribeMessage = worker.onMessage(message => {
			if (message.type === "log") return;
			const pending = slot.pending.get(message.id);
			if (pending) pending.resolve(message);
		});
		slot.unsubscribeError = worker.onError(error => void this.#dropSlot(slot, error));
		this.#slots.set(key, slot);
		return slot;
	}

	async #dropSlot(slot: WorkerSlot, error: Error): Promise<void> {
		for (const [key, candidate] of this.#slots) if (candidate === slot) this.#slots.delete(key);
		await this.#retireSlot(slot, error);
	}

	async #retireSlot(slot: WorkerSlot, error: Error): Promise<void> {
		if (slot.retired) return;
		slot.retired = true;
		slot.unsubscribeMessage();
		slot.unsubscribeError();
		for (const pending of slot.pending.values()) pending.reject(error);
		slot.pending.clear();
		await slot.worker.terminate();
	}

	#reply(socket: net.Socket, id: string, message: MnemopiEmbedWorkerOutbound): void {
		if (socket.destroyed) return;
		const response = encodeMnemopiEmbedBrokerResponse(this.#token, { id, ok: true, message });
		socket.write(`${JSON.stringify(response)}\n`);
	}
}

class SocketMnemopiEmbedHandle implements MnemopiEmbedWorkerHandle {
	readonly #socket: net.Socket;
	readonly #token: string;
	readonly #listeners = new Set<(message: MnemopiEmbedWorkerOutbound) => void>();
	readonly #errors = new Set<(error: Error) => void>();
	#buffer = "";
	#nextWireId = 0;
	#closed = false;

	constructor(socket: net.Socket, token: string) {
		this.#socket = socket;
		this.#token = token;
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
		socket.on("error", error => this.#emitError(error));
		socket.on("close", () => {
			if (!this.#closed) this.#emitError(new Error("Mnemopi embed broker connection closed"));
		});
	}

	send(message: MnemopiEmbedWorkerInbound): void {
		if (this.#closed || this.#socket.destroyed) throw new Error("Mnemopi embed broker connection is closed");
		const request = encodeMnemopiEmbedBrokerRequest(this.#token, String(++this.#nextWireId), message);
		this.#socket.write(`${JSON.stringify(request)}\n`);
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
		this.#closed = true;
		this.#socket.destroy();
		this.#listeners.clear();
		this.#errors.clear();
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) continue;
			try {
				const response = parseMnemopiEmbedBrokerResponse(JSON.parse(line) as unknown, this.#token);
				if (!response.ok) {
					for (const listener of this.#listeners)
						listener({ type: "error", id: response.id, error: response.error });
					continue;
				}
				for (const listener of this.#listeners) listener(response.message);
			} catch (error) {
				this.#emitError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	#emitError(error: Error): void {
		for (const listener of this.#errors) listener(error);
	}
}

export async function connectMnemopiEmbedBroker(options: {
	endpoint: string;
	token: string;
	timeoutMs?: number;
}): Promise<MnemopiEmbedWorkerHandle> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection({ path: options.endpoint });
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`Timed out connecting to Mnemopi embed broker at ${options.endpoint}`));
	}, options.timeoutMs ?? 1_000);
	const cleanup = (): void => {
		clearTimeout(timer);
		socket.off("connect", onConnect);
		socket.off("error", onError);
	};
	const onConnect = (): void => {
		cleanup();
		resolve(socket);
	};
	const onError = (error: Error): void => {
		cleanup();
		socket.destroy();
		reject(error);
	};
	socket.once("connect", onConnect);
	socket.once("error", onError);
	return new SocketMnemopiEmbedHandle(await promise, options.token);
}

export async function removeStaleMnemopiEmbedEndpoint(endpoint: string): Promise<void> {
	if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
}
