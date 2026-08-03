import type { Readable, Writable } from "node:stream";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { connectInheritedBroker, openInheritedBrokerBootstrap } from "@oh-my-pi/pi-natives";
import * as z from "zod/v4";
import { bootstrapPayloadDigest } from "./bootstrap";
import type { OmpMcpConnector, OmpMcpTool, OmpTurnBinding } from "./broker";
import type { OmpMcpBrokerClient } from "./server";
import { runOmpMcpServer } from "./server";

const MAX_BOOTSTRAP_BYTES = 16_384;
const MAX_BROKER_FRAME_BYTES = 1_048_576;

const BootstrapPayloadSchema = z
	.object({
		version: z.literal(1),
		runtimeEpoch: z.string().min(20).max(256),
		authenticator: z.string().min(32).max(512),
		bootstrapDigest: z.string().regex(/^[0-9a-f]{64}$/),
	})
	.strict();

const BrokerResponseSchema = z
	.object({
		id: z.string().min(1).max(256),
		result: z.unknown().optional(),
		error: z.string().max(4096).optional(),
	})
	.strict()
	.refine(value => (value.error === undefined) !== (value.result === undefined), {
		message: "broker response must contain exactly one result or error",
	});

const BrokerNotificationSchema = z.object({ method: z.literal("tools/list_changed") }).strict();

interface NativeOwnedBootstrapFile {
	readonly identity: string;
	read(): Uint8Array | Promise<Uint8Array>;
	consume(): void | Promise<void>;
	close(): void | Promise<void>;
}

interface NativeInheritedConnection {
	read(): Uint8Array | Promise<Uint8Array>;
	write(bytes: Uint8Array): void | Promise<void>;
	currentPeer(): object | Promise<object>;
	close(): void | Promise<void>;
}

interface NativeHandoffModule {
	openInheritedBrokerBootstrap(): NativeOwnedBootstrapFile | Promise<NativeOwnedBootstrapFile>;
	connectInheritedBroker(): NativeInheritedConnection | Promise<NativeInheritedConnection>;
}

const defaultNativeHandoffModule: NativeHandoffModule = {
	connectInheritedBroker,
	openInheritedBrokerBootstrap,
};

interface WireRequest {
	readonly id: string;
	readonly method: "proof" | "claim" | "list_tools" | "invoke" | "release" | "close";
	readonly params: Record<string, unknown>;
}

class NativeBrokerChannel {
	readonly #connection: NativeInheritedConnection;
	readonly #listeners = new Set<() => void>();
	readonly #pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	#buffer = Buffer.alloc(0);
	#sequence = 0;
	#closed = false;
	#writeBarrier = Promise.resolve();
	#reader?: Promise<void>;
	#failureClose?: Promise<void>;
	#closeError?: Error;

	constructor(connection: NativeInheritedConnection) {
		this.#connection = connection;
	}

	request<T>(method: WireRequest["method"], params: Record<string, unknown>): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("inherited broker connection is closed"));
		const id = `request-${++this.#sequence}`;
		const request: WireRequest = { id, method, params };
		const deferred = Promise.withResolvers<T>();
		this.#pending.set(id, { resolve: value => deferred.resolve(value as T), reject: deferred.reject });
		const write = this.#writeBarrier.then(async () => {
			await this.#connection.currentPeer();
			const encoded = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
			if (encoded.byteLength > MAX_BROKER_FRAME_BYTES) throw new Error("broker request exceeds size limit");
			await this.#connection.write(encoded);
			this.#reader ??= this.#readLoop();
		});
		this.#writeBarrier = write.then(
			() => undefined,
			() => undefined,
		);
		void write.catch(error => this.#fail(error instanceof Error ? error : new Error(String(error))));
		return deferred.promise;
	}

	onToolsChanged(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async close(): Promise<void> {
		if (this.#closed) {
			await this.#failureClose;
			if (this.#closeError) throw this.#closeError;
			return;
		}
		this.#closed = true;
		this.#listeners.clear();
		for (const pending of this.#pending.values()) pending.reject(new Error("inherited broker connection closed"));
		this.#pending.clear();
		await this.#connection.close();
		if (this.#reader) await this.#reader;
	}

	async #readLoop(): Promise<void> {
		try {
			while (!this.#closed) {
				const line = await this.#readLine();
				await this.#connection.currentPeer();
				const parsed: unknown = JSON.parse(line);
				const notification = BrokerNotificationSchema.safeParse(parsed);
				if (notification.success) {
					for (const listener of this.#listeners) listener();
					continue;
				}
				const response = BrokerResponseSchema.parse(parsed);
				const pending = this.#pending.get(response.id);
				if (!pending) throw new Error("broker response correlation mismatch");
				this.#pending.delete(response.id);
				if (response.error !== undefined) {
					pending.reject(new Error(response.error));
				} else if (!("result" in response)) {
					pending.reject(new Error("broker response omitted result"));
				} else {
					pending.resolve(response.result);
				}
			}
		} catch (error) {
			if (!this.#closed) this.#fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	async #readLine(): Promise<string> {
		while (true) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline >= 0) {
				if (newline > MAX_BROKER_FRAME_BYTES) throw new Error("broker response exceeds size limit");
				const line = this.#buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
				this.#buffer = this.#buffer.subarray(newline + 1);
				return line;
			}
			const chunk = Buffer.from(await this.#connection.read());
			if (chunk.byteLength === 0) throw new Error("broker connection closed before response");
			this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
			if (this.#buffer.byteLength > MAX_BROKER_FRAME_BYTES) throw new Error("broker response exceeds size limit");
		}
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#listeners.clear();
		this.#failureClose = Promise.resolve(this.#connection.close()).catch(closeError => {
			this.#closeError = closeError instanceof Error ? closeError : new Error(String(closeError));
		});
	}
}

class InheritedBrokerClient implements OmpMcpBrokerClient {
	readonly connector: OmpMcpConnector;
	readonly #channel: NativeBrokerChannel;
	#closed = false;

	constructor(channel: NativeBrokerChannel, connector: OmpMcpConnector) {
		this.#channel = channel;
		this.connector = connector;
	}

	claim(turnToken: string): Promise<OmpTurnBinding> {
		return this.#channel.request("claim", { turnToken });
	}

	listTools(): Promise<readonly OmpMcpTool[]> {
		return this.#channel.request("list_tools", {});
	}

	invoke(call: {
		callId: string;
		wireName: string;
		arguments?: Record<string, unknown>;
		input?: string;
	}): Promise<ToolResultMessage> {
		return this.#channel.request("invoke", { call });
	}

	async release(bindingId: string): Promise<void> {
		await this.#channel.request("release", { bindingId });
	}

	onToolsChanged(listener: () => void): () => void {
		return this.#channel.onToolsChanged(listener);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#channel.request("close", {});
		} finally {
			await this.#channel.close();
		}
	}
}

export interface McpHandoffChildOptions {
	/** Test seam; production always loads the package-owned native bridge. */
	readonly nativeModule?: NativeHandoffModule;
	readonly input?: Readable;
	readonly output?: Writable;
}

export async function runMcpHandoffChild(options: McpHandoffChildOptions = {}): Promise<void> {
	// Full-mode native peer transport starts only when the handoff child runs.
	const nativeModule = options.nativeModule ?? defaultNativeHandoffModule;
	if (
		typeof nativeModule.openInheritedBrokerBootstrap !== "function" ||
		typeof nativeModule.connectInheritedBroker !== "function"
	) {
		throw new Error("native inherited broker handoff is unavailable");
	}
	const bootstrap = await nativeModule.openInheritedBrokerBootstrap();
	let channel: NativeBrokerChannel | undefined;
	try {
		const bytes = await bootstrap.read();
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_BOOTSTRAP_BYTES)
			throw new Error("broker bootstrap size is invalid");
		const payload = BootstrapPayloadSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
		if (bootstrapPayloadDigest(payload.runtimeEpoch, payload.authenticator) !== payload.bootstrapDigest) {
			throw new Error("broker bootstrap digest is invalid");
		}
		const connection = await nativeModule.connectInheritedBroker();
		channel = new NativeBrokerChannel(connection);
		const proof = await channel.request<{
			connector: OmpMcpConnector;
			bootstrapDigest: string;
		}>("proof", {
			runtimeEpoch: payload.runtimeEpoch,
			authenticator: payload.authenticator,
			bootstrapIdentity: bootstrap.identity,
			bootstrapDigest: payload.bootstrapDigest,
		});
		if (proof.bootstrapDigest !== payload.bootstrapDigest)
			throw new Error("broker bootstrap acknowledgement mismatch");
		await bootstrap.consume();
		await runOmpMcpServer({
			client: new InheritedBrokerClient(channel, proof.connector),
			input: options.input,
			output: options.output,
		});
		channel = undefined;
	} finally {
		if (channel) await channel.close();
		await bootstrap.close();
	}
}
