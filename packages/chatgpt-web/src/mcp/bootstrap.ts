import { createHash, randomBytes } from "node:crypto";
import * as defaultNativeModule from "@oh-my-pi/pi-natives";
import type { NativeLocalEndpointCapability, PiNativeTunnelCapabilityResolver } from "./tunnel";
/** Opaque native launch profile. Only the native bridge can create a usable instance. */
export interface NativeLaunchEnvironment {
	readonly __opaqueNativeLaunchEnvironment: unique symbol;
}

const CONNECTOR_BOOTSTRAP = Symbol("chatgpt-web.connector-bootstrap");
const TUNNEL_BOOTSTRAP = Symbol("chatgpt-web.tunnel-bootstrap");
const BROKER_ENDPOINT = Symbol("chatgpt-web.broker-endpoint");
const PROCESS_IDENTITY = Symbol("chatgpt-web.tunnel-process-identity");

export function bootstrapPayloadDigest(runtimeEpoch: string, authenticator: string): string {
	return createHash("sha256")
		.update(JSON.stringify({ version: 1, runtimeEpoch, authenticator }))
		.digest("hex");
}

export interface OmpConnectorBootstrap {
	readonly kind: "private-owned-bootstrap-file";
	readonly __opaque: typeof CONNECTOR_BOOTSTRAP;
}

export interface OmpTunnelBootstrap {
	readonly kind: "private-owned-bootstrap-file";
	readonly __opaque: typeof TUNNEL_BOOTSTRAP;
}

export interface OmpBrokerEndpoint {
	readonly kind: "owner-local";
	readonly __opaque: typeof BROKER_ENDPOINT;
}

/** Native-produced identity. Its public fields are diagnostics, never authority. */
export interface OmpTunnelProcessIdentity {
	readonly pid: number;
	readonly processStartIdentity: string;
	readonly executableIdentity: string;
	readonly __opaque: typeof PROCESS_IDENTITY;
}

export interface OmpTunnelSpawnEnvironment {
	readonly environment: NativeLaunchEnvironment;
	close(): void;
}

/**
 * Package-private native authority consumed by the broker. Implementations keep every returned
 * connection and bootstrap in identity-keyed native state; records are never sufficient authority.
 */
export interface OmpBootstrapBrokerHandler {
	attach(bootstrap: OmpConnectorBootstrap): Promise<object>;
	dispatch(
		connector: object,
		method: "claim" | "list_tools" | "invoke" | "release",
		params: Record<string, unknown>,
	): Promise<unknown>;
	onToolsChanged(connector: object, listener: () => void): () => void;
	close(connector: object): Promise<void>;
}

function isBrokerWireMethod(value: string): value is "claim" | "list_tools" | "invoke" | "release" {
	return value === "claim" || value === "list_tools" || value === "invoke" || value === "release";
}

export interface OmpBootstrapAuthority {
	listen(runtimeEpoch: string): Promise<OmpBrokerEndpoint>;
	prepare(runtimeEpoch: string): Promise<{
		connectorBootstrap: OmpConnectorBootstrap;
		tunnelBootstrap: OmpTunnelBootstrap;
	}>;
	/** Releases a prepared bootstrap that was never handed to a tunnel child. */
	abortPrepared?(bootstrap: OmpConnectorBootstrap): Promise<void>;
	authorize(bootstrap: OmpConnectorBootstrap, process: OmpTunnelProcessIdentity, runtimeEpoch: string): Promise<void>;
	attach(
		bootstrap: OmpConnectorBootstrap,
		runtimeEpoch: string,
	): Promise<{
		/** Live native connection handle. Structural copies are rejected by currentPeer(). */
		connection: object;
		connectorId: string;
		sessionId: string;
		sessionNonce: string;
	}>;
	/** Revalidates PID, ancestry, start identity, executable identity, and the live connection. */
	currentPeer(connection: object, runtimeEpoch: string): Promise<void>;
	closeConnection(connection: object): Promise<void>;
	bindBroker?(handler: OmpBootstrapBrokerHandler): void;
	close(): Promise<void>;
}

interface SpawnState {
	environment: NativeLaunchEnvironment;
	closed: boolean;
	consumed: boolean;
	closeNative: () => void;
}

const spawnStates = new WeakMap<OmpTunnelBootstrap, SpawnState>();

/** Called only after the native authority has created and validated held file handles. */
export function registerTunnelSpawnEnvironment(
	bootstrap: OmpTunnelBootstrap,
	environment: NativeLaunchEnvironment,
	closeNative: () => void,
): void {
	if (spawnStates.has(bootstrap)) throw new Error("tunnel bootstrap environment is already registered");
	spawnStates.set(bootstrap, { environment, closeNative, closed: false, consumed: false });
}

/** One-time materialization immediately before native tunnel spawn. */
export function consumeTunnelSpawnEnvironment(bootstrap: OmpTunnelBootstrap): OmpTunnelSpawnEnvironment {
	const state = spawnStates.get(bootstrap);
	if (!state || state.closed || state.consumed) throw new Error("tunnel bootstrap is invalid, consumed, or closed");
	state.consumed = true;
	let wrapperClosed = false;
	return {
		environment: state.environment,
		close() {
			if (wrapperClosed) return;
			wrapperClosed = true;
			state.closed = true;
			state.closeNative();
		},
	};
}

export interface NativeProcessIdentityLike {
	readonly pid: number;
	readonly processStartIdentity: string;
	readonly executableIdentity: string;
}

export interface NativeOwnedBootstrapFile {
	readonly identity: string;
	read(): Uint8Array;
	consume(): void;
	cleanup(): void;
	close(): void;
}

interface NativePeerConnectionLike {
	readonly peer: NativeProcessIdentityLike;
	currentPeer(): NativeProcessIdentityLike;
	read(): Promise<Uint8Array>;
	write(bytes: Uint8Array): Promise<void>;
	close(): void;
}

interface NativeLocalListenerLike {
	readonly endpoint: NativeLocalEndpointCapability;
	accept(): Promise<NativePeerConnectionLike>;
	close(): void;
}

export interface NativeBootstrapModule {
	readonly NativeLocalListener: { create(): NativeLocalListenerLike };
	readonly NativeOwnedFile: {
		createPrivate(
			root: NativeOwnedBootstrapFile,
			nameHint: string | undefined,
			bytes: Uint8Array,
		): NativeOwnedBootstrapFile;
	};
	matchesProcessIdentity(expected: NativeProcessIdentityLike, actual: NativeProcessIdentityLike): boolean;
	connectLocal(endpoint: NativeLocalEndpointCapability): NativePeerConnectionLike;
	verifyPeerDescendant(peer: NativeProcessIdentityLike, ancestor: NativeProcessIdentityLike): boolean;
}

export interface NativeBootstrapAuthorityOptions {
	readonly runtimeRoot: NativeOwnedBootstrapFile;
	readonly nativeModule: NativeBootstrapModule;
	readonly maxPendingProofs?: number;
	readonly maxFrameBytes?: number;
}

interface NativePreparedState {
	readonly connectorBootstrap: OmpConnectorBootstrap;
	readonly tunnelBootstrap: OmpTunnelBootstrap;
	readonly file: NativeOwnedBootstrapFile;
	readonly authenticator: string;
	readonly runtimeEpoch: string;
	readonly digest: string;
	readonly authorization: ReturnType<typeof Promise.withResolvers<void>>;
	process?: NativeProcessIdentityLike;
	connection?: NativePeerConnectionLike;
	proofAccepted: boolean;
	attached: boolean;
	consumed: boolean;
	closed: boolean;
}

const nativeProcessIdentities = new WeakMap<OmpTunnelProcessIdentity, NativeProcessIdentityLike>();

/** Converts a native-owned process identity to the broker's opaque authority handle. */
export function createOmpTunnelProcessIdentity(identity: NativeProcessIdentityLike): OmpTunnelProcessIdentity {
	const wrapped = Object.freeze({
		pid: identity.pid,
		processStartIdentity: identity.processStartIdentity,
		executableIdentity: identity.executableIdentity,
		__opaque: PROCESS_IDENTITY,
	});
	nativeProcessIdentities.set(wrapped, identity);
	return wrapped;
}

/** Owner-local full-mode bootstrap authority. Construction itself has no native side effects. */
export class NativeOmpBootstrapAuthority implements OmpBootstrapAuthority, PiNativeTunnelCapabilityResolver {
	readonly #native: NativeBootstrapModule;
	readonly #runtimeRoot: NativeOwnedBootstrapFile;
	readonly #maxPendingProofs: number;
	readonly #maxFrameBytes: number;
	readonly #states = new WeakMap<OmpConnectorBootstrap, NativePreparedState>();
	readonly #liveStates = new Set<NativePreparedState>();
	readonly #authenticators = new Map<string, NativePreparedState>();
	readonly #endpointHandles = new WeakMap<OmpBrokerEndpoint, NativeLocalEndpointCapability>();
	readonly #connections = new WeakSet<object>();
	readonly #nativeConnections = new Set<NativePeerConnectionLike>();
	readonly #readBuffers = new WeakMap<NativePeerConnectionLike, Buffer>();
	readonly #writeBarriers = new WeakMap<NativePeerConnectionLike, Promise<void>>();
	readonly #connectionTasks = new Set<Promise<void>>();
	#handler?: OmpBootstrapBrokerHandler;
	#listener?: NativeLocalListenerLike;
	#endpoint?: OmpBrokerEndpoint;
	#runtimeEpoch?: string;
	#acceptLoop?: Promise<void>;
	#acceptFailure?: Error;
	#pendingProofs = 0;
	#closed = false;

	constructor(options: NativeBootstrapAuthorityOptions) {
		this.#native = options.nativeModule;
		this.#runtimeRoot = options.runtimeRoot;
		this.#maxPendingProofs = options.maxPendingProofs ?? 16;
		this.#maxFrameBytes = options.maxFrameBytes ?? 1_048_576;
	}

	bindBroker(handler: OmpBootstrapBrokerHandler): void {
		if (this.#handler) throw new Error("native bootstrap authority is already bound");
		this.#handler = handler;
	}

	async listen(runtimeEpoch: string): Promise<OmpBrokerEndpoint> {
		if (this.#acceptFailure) throw this.#acceptFailure;
		if (this.#closed) throw new Error("native bootstrap authority is closed");
		if (this.#endpoint) {
			if (runtimeEpoch !== this.#runtimeEpoch) throw new Error("native broker runtime epoch changed");
			return this.#endpoint;
		}
		if (!this.#handler) throw new Error("native bootstrap authority has no broker handler");
		const listener = this.#native.NativeLocalListener.create();
		const endpoint = Object.freeze({ kind: "owner-local" as const, __opaque: BROKER_ENDPOINT });
		this.#listener = listener;
		this.#endpoint = endpoint;
		this.#runtimeEpoch = runtimeEpoch;
		this.#endpointHandles.set(endpoint, listener.endpoint);
		this.#acceptLoop = this.#runAcceptLoop(listener).catch(error => {
			const errors: unknown[] = [error];
			for (const connection of this.#nativeConnections) {
				try {
					connection.close();
				} catch (closeError) {
					errors.push(closeError);
				}
			}
			const cause = error instanceof Error ? error : new Error(String(error));
			this.#acceptFailure =
				errors.length === 1 ? cause : new AggregateError(errors, "native broker listener failed");
		});
		return endpoint;
	}

	async prepare(runtimeEpoch: string): Promise<{
		connectorBootstrap: OmpConnectorBootstrap;
		tunnelBootstrap: OmpTunnelBootstrap;
	}> {
		if (this.#closed || this.#acceptFailure || !this.#endpoint || runtimeEpoch !== this.#runtimeEpoch) {
			throw this.#acceptFailure ?? new Error("native broker endpoint is not listening for this epoch");
		}
		const connectorBootstrap = Object.freeze({
			kind: "private-owned-bootstrap-file" as const,
			__opaque: CONNECTOR_BOOTSTRAP,
		});
		const tunnelBootstrap = Object.freeze({
			kind: "private-owned-bootstrap-file" as const,
			__opaque: TUNNEL_BOOTSTRAP,
		});
		const authenticator = randomBytes(32).toString("base64url");
		const digest = bootstrapPayloadDigest(runtimeEpoch, authenticator);
		const file = this.#native.NativeOwnedFile.createPrivate(
			this.#runtimeRoot,
			`mcp-${randomBytes(12).toString("hex")}`,
			Buffer.from(JSON.stringify({ version: 1, runtimeEpoch, authenticator, bootstrapDigest: digest })),
		);
		const state: NativePreparedState = {
			connectorBootstrap,
			tunnelBootstrap,
			file,
			authenticator,
			runtimeEpoch,
			digest,
			authorization: Promise.withResolvers<void>(),
			proofAccepted: false,
			attached: false,
			consumed: false,
			closed: false,
		};
		this.#states.set(connectorBootstrap, state);
		this.#liveStates.add(state);
		this.#authenticators.set(authenticator, state);
		return { connectorBootstrap, tunnelBootstrap };
	}
	/**
	 * Closes the authority state for a prepared spawn. This is intentionally
	 * keyed only by the opaque connector capability so callers cannot forge or
	 * substitute the paired tunnel bootstrap.
	 */
	async abortPrepared(connector: OmpConnectorBootstrap): Promise<void> {
		const state = this.#states.get(connector);
		if (!state || state.closed) return;
		this.#closeState(state);
	}

	async authorize(
		bootstrap: OmpConnectorBootstrap,
		process: OmpTunnelProcessIdentity,
		runtimeEpoch: string,
	): Promise<void> {
		const state = this.#state(bootstrap, runtimeEpoch);
		const identity = nativeProcessIdentities.get(process);
		if (!identity || state.process || state.closed) throw new Error("native tunnel identity is invalid or replayed");
		if (!this.#native.matchesProcessIdentity(identity, identity)) throw new Error("native tunnel identity is stale");
		state.process = identity;
		state.authorization.resolve();
	}

	async attach(bootstrap: OmpConnectorBootstrap, runtimeEpoch: string) {
		const state = this.#state(bootstrap, runtimeEpoch);
		if (state.attached) throw new Error("native connector bootstrap was already attached");
		await state.authorization.promise;
		if (state.closed) throw new Error("native connector bootstrap closed during authorization");
		if (!state.connection || !state.proofAccepted || !state.process)
			throw new Error("native connector proof is incomplete");
		await this.#validatePeer(state.connection, state);
		state.attached = true;
		return {
			connection: state.connection,
			connectorId: `connector_${randomBytes(18).toString("base64url")}`,
			sessionId: `session_${randomBytes(18).toString("base64url")}`,
			sessionNonce: randomBytes(24).toString("base64url"),
		};
	}

	async currentPeer(connection: object, runtimeEpoch: string): Promise<void> {
		if (!this.#connections.has(connection) || runtimeEpoch !== this.#runtimeEpoch) {
			throw new Error("native connector connection is invalid or stale");
		}
		const nativeConnection = connection as NativePeerConnectionLike;
		const state = [...this.#liveStates].find(candidate => candidate.connection === nativeConnection);
		if (!state) throw new Error("native connector connection is not active");
		await this.#validatePeer(nativeConnection, state);
	}

	async closeConnection(connection: object): Promise<void> {
		if (!this.#connections.has(connection)) throw new Error("native connector connection is invalid or closed");
		this.#connections.delete(connection);
		(connection as NativePeerConnectionLike).close();
	}

	takeBootstrap(
		connector: OmpConnectorBootstrap,
		tunnel: OmpTunnelBootstrap,
	): { readonly file: NativeOwnedBootstrapFile; readonly close: () => void } {
		const state = this.#states.get(connector);
		if (!state || state.tunnelBootstrap !== tunnel || state.consumed || state.closed) {
			throw new Error("native tunnel bootstrap capability is invalid or consumed");
		}
		state.consumed = true;
		return { file: state.file, close: () => this.#closeState(state) };
	}

	brokerEndpoint(endpoint: OmpBrokerEndpoint): NativeLocalEndpointCapability {
		const nativeEndpoint = this.#endpointHandles.get(endpoint);
		if (!nativeEndpoint || endpoint !== this.#endpoint) throw new Error("native broker endpoint is invalid");
		return nativeEndpoint;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const errors: unknown[] = [];
		for (const connection of this.#nativeConnections) {
			try {
				connection.close();
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			this.#listener?.close();
		} catch (error) {
			errors.push(error);
		}
		for (const state of [...this.#liveStates]) {
			try {
				this.#closeState(state);
			} catch (error) {
				errors.push(error);
			}
		}
		await Promise.allSettled([...this.#connectionTasks]);
		if (this.#acceptLoop) await this.#acceptLoop;
		if (this.#acceptFailure) errors.push(this.#acceptFailure);
		if (errors.length > 0) throw new AggregateError(errors, "native MCP bootstrap authority cleanup failed");
	}

	async #runAcceptLoop(listener: NativeLocalListenerLike): Promise<void> {
		while (!this.#closed) {
			let connection: NativePeerConnectionLike;
			try {
				connection = await listener.accept();
			} catch (error) {
				if (this.#closed) return;
				throw error;
			}
			this.#nativeConnections.add(connection);
			const task = this.#serveConnection(connection);
			this.#connectionTasks.add(task);
			void task.then(
				() => this.#connectionTasks.delete(task),
				() => this.#connectionTasks.delete(task),
			);
		}
	}

	async #serveConnection(connection: NativePeerConnectionLike): Promise<void> {
		let connector: object | undefined;
		let unsubscribe: (() => void) | undefined;
		const requestTasks = new Set<Promise<void>>();
		let pendingProof = false;
		try {
			if (this.#pendingProofs >= this.#maxPendingProofs)
				throw new Error("native broker pending proof capacity exceeded");
			this.#pendingProofs += 1;
			pendingProof = true;
			const proof = await this.#readRequest(connection);
			if (proof.method !== "proof") throw new Error("native broker requires connector proof first");
			if (
				Object.keys(proof.params).length !== 4 ||
				!["authenticator", "runtimeEpoch", "bootstrapIdentity", "bootstrapDigest"].every(key =>
					Object.hasOwn(proof.params, key),
				)
			) {
				throw new Error("native connector proof contains unsupported fields");
			}
			const { authenticator, runtimeEpoch, bootstrapIdentity, bootstrapDigest } = proof.params;
			if (
				typeof authenticator !== "string" ||
				typeof runtimeEpoch !== "string" ||
				typeof bootstrapIdentity !== "string" ||
				typeof bootstrapDigest !== "string"
			) {
				throw new Error("native connector proof is malformed");
			}
			const state = this.#authenticators.get(authenticator);
			if (
				!state ||
				state.closed ||
				state.proofAccepted ||
				state.runtimeEpoch !== runtimeEpoch ||
				state.file.identity !== bootstrapIdentity ||
				state.digest !== bootstrapDigest
			) {
				throw new Error("native connector proof is invalid or replayed");
			}
			connection.currentPeer();
			state.connection = connection;
			state.proofAccepted = true;
			this.#authenticators.delete(authenticator);
			await state.authorization.promise;
			await this.#validatePeer(connection, state);
			this.#connections.add(connection);
			connector = await this.#handler!.attach(state.connectorBootstrap);
			unsubscribe = this.#handler!.onToolsChanged(connector, () => {
				void this.#write(connection, { method: "tools/list_changed" }).catch(() => connection.close());
			});
			await this.#write(connection, {
				id: proof.id,
				result: { connector, bootstrapDigest: state.digest },
			});
			this.#pendingProofs -= 1;
			pendingProof = false;
			while (!this.#closed) {
				const request = await this.#readRequest(connection);
				await this.#validatePeer(connection, state);
				if (request.method === "close") {
					if (Object.keys(request.params).length !== 0)
						throw new Error("native broker close parameters are malformed");
					await this.#write(connection, { id: request.id, result: { closed: true } });
					break;
				}
				const method = request.method;
				if (!isBrokerWireMethod(method)) throw new Error("native broker method is invalid");
				const task = (async () => {
					try {
						const result = await this.#handler!.dispatch(connector, method, request.params);
						await this.#write(connection, { id: request.id, result: result ?? null });
					} catch (error) {
						await this.#write(connection, {
							id: request.id,
							error: error instanceof Error ? error.message : "native broker request failed",
						});
					}
				})();
				requestTasks.add(task);
				void task.then(
					() => requestTasks.delete(task),
					() => requestTasks.delete(task),
				);
			}
		} finally {
			if (pendingProof) this.#pendingProofs -= 1;
			unsubscribe?.();
			try {
				if (connector) await this.#handler!.close(connector);
				await Promise.allSettled([...requestTasks]);
			} finally {
				this.#nativeConnections.delete(connection);
				if (this.#connections.has(connection)) this.#connections.delete(connection);
				connection.close();
			}
		}
	}

	async #readRequest(connection: NativePeerConnectionLike): Promise<{
		id: string;
		method: string;
		params: Record<string, unknown>;
	}> {
		let bytes = this.#readBuffers.get(connection) ?? Buffer.alloc(0);
		while (true) {
			const newline = bytes.indexOf(0x0a);
			if (newline >= 0) {
				const frame = bytes.subarray(0, newline);
				this.#readBuffers.set(connection, bytes.subarray(newline + 1));
				const parsed: unknown = JSON.parse(frame.toString("utf8"));
				if (
					!parsed ||
					typeof parsed !== "object" ||
					Array.isArray(parsed) ||
					!("id" in parsed) ||
					typeof parsed.id !== "string" ||
					!("method" in parsed) ||
					typeof parsed.method !== "string" ||
					!("params" in parsed) ||
					!parsed.params ||
					typeof parsed.params !== "object" ||
					Array.isArray(parsed.params)
				) {
					throw new Error("native broker frame is malformed");
				}
				if (
					Object.keys(parsed).length !== 3 ||
					!Object.hasOwn(parsed, "id") ||
					!Object.hasOwn(parsed, "method") ||
					!Object.hasOwn(parsed, "params")
				) {
					throw new Error("native broker frame contains unsupported fields");
				}
				if (parsed.id.length === 0 || parsed.id.length > 256) {
					throw new Error("native broker request id is invalid");
				}
				return { id: parsed.id, method: parsed.method, params: parsed.params as Record<string, unknown> };
			}
			const chunk = Buffer.from(await connection.read());
			if (chunk.byteLength === 0) throw new Error("native broker connection closed");
			bytes = bytes.length === 0 ? chunk : Buffer.concat([bytes, chunk]);
			if (bytes.byteLength > this.#maxFrameBytes) throw new Error("native broker frame exceeds size limit");
		}
	}

	async #write(connection: NativePeerConnectionLike, value: unknown): Promise<void> {
		connection.currentPeer();
		const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
		if (bytes.byteLength > this.#maxFrameBytes) throw new Error("native broker response exceeds size limit");
		const previous = this.#writeBarriers.get(connection) ?? Promise.resolve();
		const next = previous.then(() => connection.write(bytes));
		this.#writeBarriers.set(connection, next);
		try {
			await next;
		} finally {
			if (this.#writeBarriers.get(connection) === next) this.#writeBarriers.delete(connection);
		}
	}

	async #validatePeer(connection: NativePeerConnectionLike, state: NativePreparedState): Promise<void> {
		const process = state.process;
		if (!process || !this.#native.matchesProcessIdentity(process, process)) {
			throw new Error("native tunnel is not authorized or is stale");
		}
		const capturedPeer = connection.peer;
		const currentPeer = connection.currentPeer();
		if (
			!this.#native.matchesProcessIdentity(capturedPeer, currentPeer) ||
			!this.#native.verifyPeerDescendant(currentPeer, process)
		) {
			throw new Error("native connector peer is not an authorized descendant");
		}
	}

	#state(bootstrap: OmpConnectorBootstrap, runtimeEpoch: string): NativePreparedState {
		const state = this.#states.get(bootstrap);
		if (!state || state.closed || state.runtimeEpoch !== runtimeEpoch) {
			throw new Error("native connector bootstrap is invalid or stale");
		}
		return state;
	}

	#closeState(state: NativePreparedState): void {
		if (state.closed) return;
		state.closed = true;
		state.authorization.resolve();
		this.#authenticators.delete(state.authenticator);
		this.#liveStates.delete(state);
		const errors: unknown[] = [];
		try {
			state.file.cleanup();
		} catch (error) {
			errors.push(error);
		}
		try {
			state.file.close();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "native MCP bootstrap cleanup failed");
	}
}

/** Uses an injected native bridge when supplied; direct development callers use the package bridge. */
export async function createNativeOmpBootstrapAuthority(
	runtimeRoot: NativeOwnedBootstrapFile,
	injectedNativeModule?: unknown,
): Promise<NativeOmpBootstrapAuthority> {
	const nativeModule = (
		injectedNativeModule === undefined ? defaultNativeModule : injectedNativeModule
	) as Partial<NativeBootstrapModule>;
	if (
		typeof nativeModule.NativeLocalListener?.create !== "function" ||
		typeof nativeModule.NativeOwnedFile?.createPrivate !== "function" ||
		typeof nativeModule.connectLocal !== "function" ||
		typeof nativeModule.matchesProcessIdentity !== "function" ||
		typeof nativeModule.verifyPeerDescendant !== "function"
	) {
		throw new Error("native MCP bootstrap authority is unavailable");
	}
	return new NativeOmpBootstrapAuthority({
		runtimeRoot,
		nativeModule: nativeModule as NativeBootstrapModule,
	});
}
