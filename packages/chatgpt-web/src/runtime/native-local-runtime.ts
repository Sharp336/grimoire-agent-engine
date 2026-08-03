import { randomBytes } from "node:crypto";
import path from "node:path";
import * as defaultNativeModule from "@oh-my-pi/pi-natives";
import { readChatGptWebLoginStatus } from "../browser/login";
import type { BrowserLoginRequest, LoginHost } from "../browser/login-host";
import {
	type ChatGptWebPaths,
	type ChatGptWebRuntimeConfig,
	readChatGptWebConfig,
	resolveChatGptWebPaths,
	type SecureConfigHost,
	type SecureStateSession,
} from "../config";
import { OmpRuntimeGate } from "../mcp/broker";
import {
	type ChatGptWebRuntimeEpochFactory,
	ChatGptWebRuntimeLifecycle,
	createNativeFullRuntimeEpochFactory,
	type FullRuntimeDependencies,
	installTunnelClient,
	type LifecycleControlPeerHost,
	type NativeFullRuntimeEpochOptions,
	type NativeOwnedFile,
	type NativePeerConnection,
	type NativeRuntimeKeySource,
} from "../mcp/tunnel";
import { providerSessionState } from "../provider/session";
import type { ChatGptWebResolvedRuntime } from "../provider/stream";
import type { ChatGptWebRuntimeAdmission } from "../provider/types";
import type { BrowserHost, BrowserLeaseRequest } from "./host";
import { createNativeBrowserHost, createNativeLoginHost, createNativeSecureConfigHost } from "./native-secure-host";
import {
	createFetchTunnelHttpClient,
	createNativeRuntimeCommandHost,
	createNativeTunnelInstallHost,
	createNativeTunnelProcessHost,
	createTunnelConnectionProfile,
	createTunnelProfileWriter,
} from "./native-tunnel";

export type NativeLocalRuntimeUnavailableCode =
	| "native-addon-unavailable"
	| "native-secure-state-capability-unavailable"
	| "native-login-capability-unavailable"
	| "native-browser-capability-unavailable"
	| "chatgpt-web-configuration-required"
	| "chatgpt-web-login-required"
	| "native-runtime-key-capability-unavailable"
	| "full-runtime-key-unavailable"
	| "full-runtime-epoch-capability-unavailable"
	| "full-runtime-tunnel-configuration-unavailable";

export class NativeLocalRuntimeUnavailableError extends Error {
	readonly code: NativeLocalRuntimeUnavailableCode;

	constructor(code: NativeLocalRuntimeUnavailableCode) {
		super(`ChatGPT Web native runtime unavailable (${code})`);
		this.name = "NativeLocalRuntimeUnavailableError";
		this.code = code;
	}
}

interface NativeFullRuntimeRoot extends NativeOwnedFile {
	read(): Uint8Array;
}

interface NativeFullRuntimeModule {
	openPrivateDirectory(path: string): NativeFullRuntimeRoot;
	openOwnedChild(root: NativeFullRuntimeRoot, name: string, directory?: boolean): NativeOwnedFile | null;
	copyOwnedFilePrivate(
		root: NativeFullRuntimeRoot,
		source: NativeOwnedFile,
		nameHint?: string | null,
	): NativeOwnedFile;
}

export interface NativeLocalRuntimeBootstrapOptions {
	/** Already-verified native module identity. Packaged callers must prefer this over a loader. */
	readonly nativeModule?: unknown;
	readonly loadNativeModule?: () => Promise<unknown>;
	readonly readConfig?: (host: SecureConfigHost) => Promise<ChatGptWebRuntimeConfig | null>;
	readonly readLoginStatus?: (host: SecureConfigHost) => Promise<{ readonly authenticated: true } | null>;
	readonly createFullEpochFactory?: (options: NativeFullRuntimeEpochOptions) => ChatGptWebRuntimeEpochFactory;
	/** Fixed root of the verified packaged runtime bundle. Defaults to the package development root. */
	readonly runtimeBundleRoot?: string;
}

export interface NativeLocalRuntimeBootstrap {
	readonly secureHost: SecureConfigHost;
	createLoginHost(): LoginHost;
	resolveRuntime(): Promise<ChatGptWebResolvedRuntime>;
	closeRuntime(): Promise<void>;
}

function unavailable(code: NativeLocalRuntimeUnavailableCode): NativeLocalRuntimeUnavailableError {
	return new NativeLocalRuntimeUnavailableError(code);
}

async function defaultNativeModuleLoader(): Promise<unknown> {
	// Capability initialization stays lazy; packaged launchers can inject their verified module.
	return defaultNativeModule;
}
function isNativeOwnedFile(value: unknown): value is NativeOwnedFile {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as NativeOwnedFile).identity === "string" &&
		typeof (value as NativeOwnedFile).consume === "function" &&
		typeof (value as NativeOwnedFile).cleanup === "function" &&
		typeof (value as NativeOwnedFile).close === "function"
	);
}
function isNativeFullRuntimeRoot(value: unknown): value is NativeFullRuntimeRoot {
	return isNativeOwnedFile(value) && typeof (value as NativeFullRuntimeRoot).read === "function";
}

function asNativeFullRuntimeModule(value: object): NativeFullRuntimeModule {
	const native = value as Partial<NativeFullRuntimeModule>;
	if (
		typeof native.openPrivateDirectory !== "function" ||
		typeof native.openOwnedChild !== "function" ||
		typeof native.copyOwnedFilePrivate !== "function"
	) {
		throw unavailable("native-runtime-key-capability-unavailable");
	}
	return native as NativeFullRuntimeModule;
}

interface NativeLifecycleProcessIdentity {
	readonly pid: number;
	readonly processStartIdentity: string;
	readonly executableIdentity: string;
}

interface NativeLifecyclePeerConnection {
	readonly peer: NativeLifecycleProcessIdentity;
	currentPeer(): NativeLifecycleProcessIdentity;
}

interface NativeLifecyclePeerModule {
	currentProcessIdentity(): NativeLifecycleProcessIdentity;
	matchesProcessIdentity(expected: NativeLifecycleProcessIdentity, actual: NativeLifecycleProcessIdentity): boolean;
	verifyPeerDescendant(peer: NativeLifecycleProcessIdentity, ancestor: NativeLifecycleProcessIdentity): boolean;
}

function isCompleteNativeProcessIdentity(value: unknown): value is NativeLifecycleProcessIdentity {
	if (!value || typeof value !== "object") return false;
	const identity = value as Partial<NativeLifecycleProcessIdentity>;
	return (
		Number.isSafeInteger(identity.pid) &&
		(identity.pid as number) > 0 &&
		typeof identity.processStartIdentity === "string" &&
		identity.processStartIdentity.length > 0 &&
		typeof identity.executableIdentity === "string" &&
		identity.executableIdentity.length > 0
	);
}

/** Binds lifecycle control proofs to a live native connection and the process that owns this runtime. */
export function createNativeLifecycleControlPeerHost(value: object): LifecycleControlPeerHost {
	const candidate = value as Partial<NativeLifecyclePeerModule>;
	if (
		typeof candidate.currentProcessIdentity !== "function" ||
		typeof candidate.matchesProcessIdentity !== "function" ||
		typeof candidate.verifyPeerDescendant !== "function"
	) {
		throw unavailable("full-runtime-epoch-capability-unavailable");
	}
	const native = candidate as NativeLifecyclePeerModule;
	let owner: NativeLifecycleProcessIdentity;
	try {
		owner = native.currentProcessIdentity();
		if (!isCompleteNativeProcessIdentity(owner) || !native.matchesProcessIdentity(owner, owner)) {
			throw new Error("invalid owner");
		}
	} catch {
		throw unavailable("full-runtime-epoch-capability-unavailable");
	}

	const peerNonces = new WeakMap<object, string>();
	const noncePeers = new Map<string, object>();
	return Object.freeze({
		async verifyControlPeer(peer: NativePeerConnection, nonce: string): Promise<void> {
			try {
				if (!peer || typeof peer !== "object" || typeof nonce !== "string" || nonce.length < 16) {
					throw new Error("invalid control peer");
				}
				const connection = peer as unknown as Partial<NativeLifecyclePeerConnection>;
				if (typeof connection.currentPeer !== "function") throw new Error("invalid control peer");
				const capturedPeer = connection.peer;
				const currentPeer = connection.currentPeer();
				const currentOwner = native.currentProcessIdentity();
				if (
					!isCompleteNativeProcessIdentity(capturedPeer) ||
					!isCompleteNativeProcessIdentity(currentPeer) ||
					!isCompleteNativeProcessIdentity(currentOwner) ||
					!native.matchesProcessIdentity(owner, currentOwner) ||
					!native.matchesProcessIdentity(currentOwner, currentOwner) ||
					!native.matchesProcessIdentity(capturedPeer, capturedPeer) ||
					!native.matchesProcessIdentity(currentPeer, currentPeer) ||
					!native.matchesProcessIdentity(capturedPeer, currentPeer) ||
					!native.verifyPeerDescendant(currentPeer, currentOwner)
				) {
					throw new Error("unauthorized control peer");
				}

				const boundNonce = peerNonces.get(peer);
				const boundPeer = noncePeers.get(nonce);
				if ((boundNonce !== undefined && boundNonce !== nonce) || (boundPeer !== undefined && boundPeer !== peer)) {
					throw new Error("invalid connection nonce");
				}
				peerNonces.set(peer, nonce);
				noncePeers.set(nonce, peer);
			} catch {
				throw new Error("Lifecycle control peer verification failed");
			}
		},
	});
}

interface NativeFullRuntimeResources {
	readonly full: FullRuntimeDependencies;
	readonly close: () => Promise<void>;
}

async function createNativeFullRuntimeResources(
	module: object,
	config: ChatGptWebRuntimeConfig,
	paths: ChatGptWebPaths,
	runtimeRoot: NativeFullRuntimeRoot,
	bundleRoot: string,
): Promise<NativeFullRuntimeResources> {
	const installHost = createNativeTunnelInstallHost(module, runtimeRoot, paths.root);
	const processHost = createNativeTunnelProcessHost(module);
	const runtimeCommandHost = createNativeRuntimeCommandHost(module, bundleRoot);
	const connectionProfile = createTunnelConnectionProfile(config, paths, bundleRoot);
	const profileWriter = createTunnelProfileWriter(module, runtimeRoot, paths.root);
	try {
		await profileWriter.write(connectionProfile);
		const artifact = await installTunnelClient({
			http: createFetchTunnelHttpClient(),
			native: installHost,
		});
		return {
			full: Object.freeze({
				artifact,
				connectionProfile,
				installHost,
				processHost,
				runtimeCommandHost,
				bundleRoot,
			}),
			close: async () => {
				const errors: unknown[] = [];
				try {
					await profileWriter.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					artifact.executable.close();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length > 0) throw new AggregateError(errors, "Full runtime resource cleanup failed");
			},
		};
	} catch (error) {
		try {
			await profileWriter.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "Full runtime resource cleanup failed");
		}
		throw error;
	}
}

/**
 * Lazily initializes package-owned runtime capabilities. Constructing the bootstrap does not open
 * native files, start browser processes, or create local transports, and missing capabilities fail closed.
 */
export function createNativeLocalRuntimeBootstrap(
	options: NativeLocalRuntimeBootstrapOptions = {},
): NativeLocalRuntimeBootstrap {
	const loadNativeModule =
		options.nativeModule === undefined
			? (options.loadNativeModule ?? defaultNativeModuleLoader)
			: async () => options.nativeModule;
	const readConfig = options.readConfig ?? (host => readChatGptWebConfig({ host }));
	const readLoginStatus = options.readLoginStatus ?? (host => readChatGptWebLoginStatus({ secureHost: host }));
	let nativeModulePromise: Promise<object> | undefined;
	let secureHostPromise: Promise<SecureConfigHost> | undefined;

	const nativeModule = (): Promise<object> => {
		nativeModulePromise ??= loadNativeModule().then(
			value => {
				if (!value || typeof value !== "object") throw unavailable("native-addon-unavailable");
				return value;
			},
			() => {
				throw unavailable("native-addon-unavailable");
			},
		);
		return nativeModulePromise;
	};

	const loadSecureHost = (): Promise<SecureConfigHost> => {
		secureHostPromise ??= nativeModule().then(module => {
			try {
				const host = createNativeSecureConfigHost(module);
				if (!host) throw unavailable("native-secure-state-capability-unavailable");
				return host;
			} catch {
				throw unavailable("native-secure-state-capability-unavailable");
			}
		});
		return secureHostPromise;
	};

	const secureHost: SecureConfigHost = Object.freeze({
		available: true,
		async currentProcessIdentity() {
			return (await loadSecureHost()).currentProcessIdentity();
		},
		async openState(
			paths: Parameters<SecureConfigHost["openState"]>[0],
			stateOptions: Parameters<SecureConfigHost["openState"]>[1],
		): Promise<SecureStateSession> {
			return (await loadSecureHost()).openState(paths, stateOptions);
		},
	});

	const createLoginHost = (): LoginHost => {
		let delegatePromise: Promise<LoginHost> | undefined;
		const delegate = (): Promise<LoginHost> => {
			delegatePromise ??= Promise.all([nativeModule(), loadSecureHost()]).then(([module, host]) => {
				try {
					const loginHost = createNativeLoginHost(module, host);
					if (!loginHost) throw unavailable("native-login-capability-unavailable");
					return loginHost;
				} catch {
					throw unavailable("native-login-capability-unavailable");
				}
			});
			return delegatePromise;
		};
		return Object.freeze({
			async login(request: BrowserLoginRequest) {
				return (await delegate()).login(request);
			},
			async close() {
				if (delegatePromise) await (await delegatePromise).close();
			},
		});
	};

	const buildRuntime = async (): Promise<ChatGptWebResolvedRuntime> => {
		const config = await readConfig(secureHost);
		if (!config) throw unavailable("chatgpt-web-configuration-required");
		const login = await readLoginStatus(secureHost);
		if (!login?.authenticated) throw unavailable("chatgpt-web-login-required");

		let module: object;
		let host: SecureConfigHost;
		try {
			[module, host] = await Promise.all([nativeModule(), loadSecureHost()]);
		} catch (error) {
			if (error instanceof NativeLocalRuntimeUnavailableError) throw error;
			throw unavailable("native-browser-capability-unavailable");
		}

		if (config.mode === "browser-only") {
			const gate = new OmpRuntimeGate();
			let nativeBrowserHost: BrowserHost;
			try {
				const browserHost = await createNativeBrowserHost(module, host, config, gate);
				if (!browserHost) throw unavailable("native-browser-capability-unavailable");
				nativeBrowserHost = browserHost;
			} catch {
				await gate.drain().catch(() => undefined);
				throw unavailable("native-browser-capability-unavailable");
			}
			const opaqueBrowserHost: BrowserHost = Object.freeze({
				login: (request: BrowserLoginRequest) => nativeBrowserHost.login(request),
				lease: (request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission) =>
					nativeBrowserHost.lease(request, admission),
				close: () => nativeBrowserHost.close(),
			});
			return Object.freeze({ config, host: opaqueBrowserHost, gate });
		}

		const native = asNativeFullRuntimeModule(module);
		const paths = resolveChatGptWebPaths();
		const peerHost = createNativeLifecycleControlPeerHost(module);
		let runtimeRoot: NativeFullRuntimeRoot;
		let retainedRuntimeKey: NativeOwnedFile;
		try {
			const openedRoot = native.openPrivateDirectory(paths.root);
			if (!isNativeFullRuntimeRoot(openedRoot)) {
				throw unavailable("native-runtime-key-capability-unavailable");
			}
			runtimeRoot = openedRoot;
			const openedKey = native.openOwnedChild(runtimeRoot, "runtime-key", false);
			if (!openedKey) {
				await runtimeRoot.close();
				throw unavailable("full-runtime-key-unavailable");
			}
			if (!isNativeOwnedFile(openedKey)) {
				await runtimeRoot.close();
				throw unavailable("native-runtime-key-capability-unavailable");
			}
			retainedRuntimeKey = openedKey;
		} catch (error) {
			if (error instanceof NativeLocalRuntimeUnavailableError) throw error;
			throw unavailable("native-runtime-key-capability-unavailable");
		}

		let authorityClosed = false;
		const closeAuthority = async (): Promise<void> => {
			if (authorityClosed) return;
			authorityClosed = true;
			await Promise.allSettled([retainedRuntimeKey.close(), runtimeRoot.close()]);
		};
		const runtimeKeySourceFactory = (
			identity: Parameters<NativeFullRuntimeEpochOptions["runtimeKeySourceFactory"]>[0],
		): NativeRuntimeKeySource => {
			let sourceClosed = false;
			return Object.freeze({
				async duplicateForSpawn(runtimeEpoch: string, lifecycleGeneration: number) {
					if (
						authorityClosed ||
						sourceClosed ||
						runtimeEpoch !== identity.runtimeEpoch ||
						lifecycleGeneration !== identity.lifecycleGeneration
					) {
						throw unavailable("native-runtime-key-capability-unavailable");
					}
					let duplicate: NativeOwnedFile;
					try {
						duplicate = native.copyOwnedFilePrivate(runtimeRoot, retainedRuntimeKey, null);
					} catch {
						throw unavailable("native-runtime-key-capability-unavailable");
					}
					if (!isNativeOwnedFile(duplicate) || duplicate === retainedRuntimeKey) {
						if (isNativeOwnedFile(duplicate) && duplicate !== retainedRuntimeKey) {
							await Promise.allSettled([duplicate.cleanup(), duplicate.close()]);
						}
						throw unavailable("native-runtime-key-capability-unavailable");
					}
					return duplicate;
				},
				async close() {
					sourceClosed = true;
				},
			});
		};
		const epochOptions: NativeFullRuntimeEpochOptions = Object.freeze({
			nativeModule: module,
			runtimeRoot,
			runtimeKeySourceFactory,
			async waitForTunnelReady(
				broker: Parameters<NativeFullRuntimeEpochOptions["waitForTunnelReady"]>[0],
				process: Parameters<NativeFullRuntimeEpochOptions["waitForTunnelReady"]>[1],
				signal: Parameters<NativeFullRuntimeEpochOptions["waitForTunnelReady"]>[2],
				timeoutMs: Parameters<NativeFullRuntimeEpochOptions["waitForTunnelReady"]>[3],
			) {
				await broker.waitForTunnelReady(process, signal, timeoutMs);
			},
			async cancelBrowserTurns() {
				providerSessionState.clear();
			},
		});

		let epochFactory: ChatGptWebRuntimeEpochFactory;
		try {
			epochFactory = (options.createFullEpochFactory ?? createNativeFullRuntimeEpochFactory)(epochOptions);
			if (!epochFactory || typeof epochFactory.create !== "function") {
				throw unavailable("full-runtime-epoch-capability-unavailable");
			}
		} catch {
			await closeAuthority();
			throw unavailable("full-runtime-epoch-capability-unavailable");
		}

		let resources: NativeFullRuntimeResources;
		try {
			resources = await createNativeFullRuntimeResources(
				module,
				config,
				paths,
				runtimeRoot,
				options.runtimeBundleRoot ?? path.resolve(import.meta.dir, "../.."),
			);
		} catch {
			await closeAuthority();
			throw unavailable("full-runtime-tunnel-configuration-unavailable");
		}

		const lifecycle = new ChatGptWebRuntimeLifecycle({
			mode: "full",
			controlToken: randomBytes(32).toString("hex"),
			peerHost,
			epochFactory,
			full: resources.full,
		});
		let nativeBrowserHost: BrowserHost;
		try {
			await lifecycle.start();
			const epoch = lifecycle.currentEpoch();
			if (!epoch.broker || !epoch.orchestration || !epoch.runtimeKey) {
				throw new Error("Full runtime epoch is incomplete");
			}
			const browserHost = await createNativeBrowserHost(module, host, config, epoch.gate);
			if (!browserHost) throw unavailable("native-browser-capability-unavailable");
			nativeBrowserHost = browserHost;
			const opaqueBrowserHost: BrowserHost = Object.freeze({
				login: (request: BrowserLoginRequest) => nativeBrowserHost.login(request),
				lease: (request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission) =>
					nativeBrowserHost.lease(request, admission),
				close: () => nativeBrowserHost.close(),
			});
			const closeRuntime = async (): Promise<void> => {
				const errors: unknown[] = [];
				try {
					await nativeBrowserHost.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					await lifecycle.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					await resources.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					await closeAuthority();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length > 0) throw new AggregateError(errors, "Full runtime cleanup failed");
			};
			return Object.freeze({
				config,
				host: opaqueBrowserHost,
				gate: epoch.gate,
				orchestration: epoch.orchestration,
				close: closeRuntime,
			}) as ChatGptWebResolvedRuntime & { readonly close: () => Promise<void> };
		} catch (error) {
			try {
				await lifecycle.close();
			} catch {}
			try {
				await resources.close();
			} catch {}
			await closeAuthority();
			if (error instanceof NativeLocalRuntimeUnavailableError) throw error;
			throw unavailable("full-runtime-tunnel-configuration-unavailable");
		}
	};

	let runtime: ChatGptWebResolvedRuntime | undefined;
	let resolving: Promise<ChatGptWebResolvedRuntime> | undefined;
	const resolveRuntime = async (): Promise<ChatGptWebResolvedRuntime> => {
		if (runtime) return runtime;
		resolving ??= buildRuntime();
		try {
			runtime = await resolving;
			return runtime;
		} catch (error) {
			resolving = undefined;
			throw error;
		}
	};
	const closeRuntime = async (): Promise<void> => {
		const current = runtime;
		runtime = undefined;
		resolving = undefined;
		if (!current) return;
		const owned = current as ChatGptWebResolvedRuntime & { readonly close?: () => Promise<void> };
		if (owned.close) {
			await owned.close();
			return;
		}
		await current.gate.drain();
		await current.host.close();
	};

	return Object.freeze({ secureHost, createLoginHost, resolveRuntime, closeRuntime });
}

export const nativeLocalRuntimeBootstrap = createNativeLocalRuntimeBootstrap();
