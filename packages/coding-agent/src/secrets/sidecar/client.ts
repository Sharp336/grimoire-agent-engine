import { connect, type Socket } from "node:net";
import { encodeRequest, parseLine, type SidecarRequest, type SidecarResponse } from "./protocol";

/**
 * Client for the sidecar broker. OMP's SecretBroker uses this in client mode:
 * it proxies capability calls to the sidecar instead of resolving in-process.
 * The public broker API is unchanged — extensions can't tell the difference.
 */
export class SidecarClient {
	#sockPath: string;
	#token: string | undefined;
	#tcpHost?: string;
	#tcpPort?: number;
	#socket: Socket | undefined;
	#buffer = "";
	#pending = new Map<number, { resolve: (res: SidecarResponse) => void; reject: (err: Error) => void }>();
	#nextId = 1;
	#connectPromise: Promise<void> | undefined;

	constructor(sockPath: string, token?: string, tcp?: { host: string; port: number }) {
		this.#sockPath = sockPath;
		this.#token = token;
		this.#tcpHost = tcp?.host;
		this.#tcpPort = tcp?.port;
	}

	async connect(): Promise<void> {
		if (this.#socket && !this.#socket.destroyed) return;
		if (this.#connectPromise) return this.#connectPromise;
		this.#connectPromise = new Promise<void>((resolve, reject) => {
			// Mac Mini remote attach: TCP when configured, unix socket otherwise.
			const socket = this.#tcpHost && this.#tcpPort
				? connect(this.#tcpPort, this.#tcpHost)
				: connect(this.#sockPath);
			socket.on("connect", () => {
				this.#socket = socket;
				socket.on("data", (chunk) => this.#onData(chunk));
				socket.on("close", () => this.#onClose());
				socket.on("error", () => {
					// handled via close
				});
				resolve();
			});
			socket.on("error", (err) => reject(err));
		});
		return this.#connectPromise;
	}

	async request(req: { op: SidecarRequest["op"] } & Record<string, unknown>): Promise<SidecarResponse> {
		await this.connect();
		const id = (req.id as number | undefined) ?? this.#nextId++;
		const full = { ...req, id, token: this.#token } as SidecarRequest;
		return new Promise<SidecarResponse>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#socket!.write(encodeRequest(full));
		});
	}

	async ping(): Promise<boolean> {
		const res = await this.request({ op: "ping" });
		return res.ok === true;
	}

	async close(): Promise<void> {
		this.#socket?.end();
		this.#socket = undefined;
	}

	#onData(chunk: Buffer | string): void {
		this.#buffer += chunk.toString();
		let idx: number;
		while ((idx = this.#buffer.indexOf("\n")) !== -1) {
			const line = this.#buffer.slice(0, idx);
			this.#buffer = this.#buffer.slice(idx + 1);
			const res = parseLine<SidecarResponse>(line);
			if (!res) continue;
			const entry = this.#pending.get(res.id);
			if (entry) {
				this.#pending.delete(res.id);
				entry.resolve(res);
			}
		}
	}

	#onClose(): void {
		this.#socket = undefined;
		for (const [, entry] of this.#pending) {
			entry.reject(new Error("sidecar connection closed"));
		}
		this.#pending.clear();
	}
}
