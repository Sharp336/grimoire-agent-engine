import { randomBytes } from "node:crypto";
import type { NativeLocalEndpoint, NativeProcessIdentity } from "@oh-my-pi/pi-natives";
import type { BrowserLoginRequest, BrowserLoginResult } from "../browser/login-host";
import type { ChatGptWebRuntimeAdmission } from "../provider/types";
import {
	assertBrowserFilterTarget,
	assertBrowserKey,
	assertBrowserRoleTarget,
	assertBrowserSelectorKey,
	type BrowserAttachment,
	BrowserContractError,
	type BrowserFilterTarget,
	type BrowserHost,
	type BrowserKey,
	type BrowserLease,
	type BrowserLeaseCapability,
	type BrowserLeaseRequest,
	type BrowserLocator,
	type BrowserNavigationTarget,
	type BrowserPage,
	type BrowserRoleTarget,
	type BrowserSelectorKey,
	validateComposerSnapshot,
	validateHealthSnapshot,
	validateLocatorCount,
	validateLocatorText,
	validateLocatorTexts,
	validateResponseSnapshot,
} from "./host";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const DESCRIPTOR_KEYS: Readonly<Record<string, true>> = Object.freeze({
	version: true,
	ownerId: true,
	runtimeEpoch: true,
	lifecycleGeneration: true,
	launcherPid: true,
	launcherNonce: true,
	launcherIdentity: true,
	endpoint: true,
});
const DESCRIPTOR_KEY_COUNT = 8;

interface NativePeerConnection {
	readonly peer: NativeProcessIdentity;
	currentPeer(): NativeProcessIdentity;
	read(): AsyncIterable<Uint8Array>;
	write(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
}
export interface LauncherNativeClient {
	connectLocal(endpoint: NativeLocalEndpoint): Promise<NativePeerConnection>;
	matchesProcessIdentity(expected: NativeProcessIdentity, actual: NativeProcessIdentity): boolean;
}

interface RawNativePeerConnection {
	readonly peer: NativeProcessIdentity;
	currentPeer(): NativeProcessIdentity;
	read(): Promise<Uint8Array>;
	write(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

interface LauncherNativeModule {
	connectLocal(endpoint: NativeLocalEndpoint): Promise<RawNativePeerConnection>;
	matchesProcessIdentity(expected: NativeProcessIdentity, actual: NativeProcessIdentity): boolean;
}

async function* readNativeConnection(connection: RawNativePeerConnection): AsyncIterable<Uint8Array> {
	for (;;) {
		const chunk = await connection.read();
		if (!(chunk instanceof Uint8Array)) throw new Error("native_stream_invalid_chunk");
		if (chunk.byteLength === 0) return;
		yield chunk;
	}
}

export function createLauncherNativeClient(nativeModule: LauncherNativeModule): LauncherNativeClient {
	if (
		!nativeModule ||
		typeof nativeModule.connectLocal !== "function" ||
		typeof nativeModule.matchesProcessIdentity !== "function"
	)
		throw new TypeError("invalid_launcher_native_module");
	return Object.freeze({
		async connectLocal(endpoint: NativeLocalEndpoint): Promise<NativePeerConnection> {
			const connection = await nativeModule.connectLocal(endpoint);
			return Object.freeze({
				peer: connection.peer,
				currentPeer: () => connection.currentPeer(),
				read: () => readNativeConnection(connection),
				write: (bytes: Uint8Array) => connection.write(bytes),
				close: () => connection.close(),
			});
		},
		matchesProcessIdentity: (expected: NativeProcessIdentity, actual: NativeProcessIdentity) =>
			nativeModule.matchesProcessIdentity(expected, actual),
	});
}

export async function loadLauncherNativeClient(): Promise<LauncherNativeClient> {
	// The native binary is platform-selected and must stay behind the async launcher startup boundary.
	const nativeModule = await import("@oh-my-pi/pi-natives");
	return createLauncherNativeClient(nativeModule);
}
export interface LauncherDescriptor {
	readonly version: 1;
	readonly ownerId: string;
	readonly runtimeEpoch: string;
	readonly lifecycleGeneration: number;
	readonly launcherPid: number;
	readonly launcherNonce: string;
	readonly launcherIdentity: NativeProcessIdentity;
	readonly endpoint: NativeLocalEndpoint;
}
export interface LauncherLifecycleAuthority {
	readonly ownerId: string;
	readonly runtimeEpoch: string;
	readonly lifecycleGeneration: number;
	readonly launcherPid: number;
	readonly launcherNonce: string;
	readonly controlToken: string;
}
export interface LauncherHostOptions {
	readonly native: LauncherNativeClient;
	readonly authority: LauncherLifecycleAuthority;
	readonly refreshDescriptor: () => Promise<unknown>;
	readonly clientPid?: number;
}

type LocatorStep =
	| { readonly kind: "nth"; readonly index: number }
	| { readonly kind: "last" }
	| { readonly kind: "filter"; readonly key: BrowserSelectorKey; readonly hasText?: string };
type LocatorDescriptor =
	| { readonly kind: "selector"; readonly key: BrowserSelectorKey; readonly chain: readonly LocatorStep[] }
	| { readonly kind: "role"; readonly target: BrowserRoleTarget; readonly chain: readonly LocatorStep[] };
interface LeaseAuthority {
	readonly leaseId: string;
	readonly leaseCapability: string;
}
interface RpcResponse {
	readonly version: number;
	readonly sequence: number;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: { readonly code?: unknown };
}

function nonce(bytes = 24): string {
	return randomBytes(bytes).toString("base64url");
}
function record(value: unknown, code: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new BrowserContractError("browser_unavailable", code);
	return value as Record<string, unknown>;
}
function boundedString(value: unknown, maximum: number, code: string): string {
	if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > maximum)
		throw new BrowserContractError("browser_unavailable", code);
	return value;
}
function assertIdentity(value: unknown): asserts value is NativeProcessIdentity {
	const identity = record(value, "invalid_launcher_identity");
	if (
		!Number.isSafeInteger(identity.pid) ||
		(identity.pid as number) <= 0 ||
		typeof identity.processStartIdentity !== "string" ||
		!identity.processStartIdentity ||
		typeof identity.executableIdentity !== "string" ||
		!identity.executableIdentity
	)
		throw new BrowserContractError("browser_unavailable", "invalid_launcher_identity");
}
function validateDescriptor(value: unknown, authority: LauncherLifecycleAuthority): LauncherDescriptor {
	const descriptor = record(value, "invalid_launcher_descriptor");
	if (
		Object.keys(descriptor).length !== DESCRIPTOR_KEY_COUNT ||
		Object.keys(descriptor).some(key => !DESCRIPTOR_KEYS[key]) ||
		descriptor.version !== PROTOCOL_VERSION
	)
		throw new BrowserContractError("browser_unavailable", "invalid_launcher_descriptor");
	if (descriptor.ownerId !== authority.ownerId)
		throw new BrowserContractError("browser_unavailable", "wrong_launcher_owner");
	if (descriptor.runtimeEpoch !== authority.runtimeEpoch)
		throw new BrowserContractError("runtime_draining", "stale_launcher_epoch");
	if (
		descriptor.lifecycleGeneration !== authority.lifecycleGeneration ||
		!Number.isSafeInteger(descriptor.lifecycleGeneration)
	)
		throw new BrowserContractError("runtime_draining", "stale_lifecycle_generation");
	if (descriptor.launcherPid !== authority.launcherPid || !Number.isSafeInteger(descriptor.launcherPid))
		throw new BrowserContractError("browser_unavailable", "wrong_launcher_pid");
	if (descriptor.launcherNonce !== authority.launcherNonce)
		throw new BrowserContractError("browser_unavailable", "stale_launcher_nonce");
	assertIdentity(descriptor.launcherIdentity);
	if (descriptor.launcherIdentity.pid !== descriptor.launcherPid)
		throw new BrowserContractError("browser_unavailable", "wrong_launcher_identity_pid");
	if (record(descriptor.endpoint, "invalid_launcher_endpoint").kind !== "owner-local")
		throw new BrowserContractError("browser_unavailable", "invalid_launcher_endpoint");
	return descriptor as unknown as LauncherDescriptor;
}

class RpcChannel {
	readonly #connection: NativePeerConnection;
	readonly #expectedPeer: NativeProcessIdentity;
	readonly #native: LauncherNativeClient;
	#buffer = Buffer.alloc(0);
	#pending: ((response: RpcResponse) => void) | undefined;
	#failure: Error | undefined;
	#closed = false;

	constructor(connection: NativePeerConnection, expectedPeer: NativeProcessIdentity, native: LauncherNativeClient) {
		this.#connection = connection;
		this.#expectedPeer = expectedPeer;
		this.#native = native;
		this.#assertPeer();
		void this.#readLoop();
	}
	#assertPeer(): void {
		if (
			!this.#native.matchesProcessIdentity(this.#expectedPeer, this.#connection.peer) ||
			!this.#native.matchesProcessIdentity(this.#expectedPeer, this.#connection.currentPeer())
		)
			throw new BrowserContractError("browser_unavailable", "launcher_peer_identity_changed");
	}
	async #readLoop(): Promise<void> {
		try {
			for await (const chunk of this.#connection.read()) {
				if (this.#closed) return;
				this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
				if (this.#buffer.length > MAX_FRAME_BYTES) throw new Error("launcher_response_too_large");
				for (;;) {
					const boundary = this.#buffer.indexOf(10);
					if (boundary < 0) break;
					const frame = this.#buffer.subarray(0, boundary);
					this.#buffer = this.#buffer.subarray(boundary + 1);
					if (frame.length === 0) continue;
					const pending = this.#pending;
					if (!pending) throw new Error("unsolicited_launcher_response");
					this.#pending = undefined;
					pending(JSON.parse(frame.toString("utf8")) as RpcResponse);
				}
			}
			throw new Error(this.#buffer.length === 0 ? "launcher_connection_closed" : "truncated_launcher_response");
		} catch (error) {
			this.#failure = error instanceof Error ? error : new Error("launcher_connection_failed");
			const pending = this.#pending;
			this.#pending = undefined;
			pending?.({ version: 0, sequence: 0, ok: false, error: { code: "launcher_connection_failed" } });
		}
	}
	async request(message: Readonly<Record<string, unknown>>): Promise<RpcResponse> {
		if (this.#failure || this.#closed || this.#pending)
			throw new BrowserContractError("browser_unavailable", "launcher_channel_unavailable");
		this.#assertPeer();
		const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
		if (bytes.length > MAX_FRAME_BYTES)
			throw new BrowserContractError("malformed_browser_output", "launcher_request_too_large");
		const response = new Promise<RpcResponse>(resolve => {
			this.#pending = resolve;
		});
		try {
			await this.#connection.write(bytes);
		} catch {
			this.#pending = undefined;
			throw new BrowserContractError("browser_unavailable", "launcher_connection_failed");
		}
		const result = await response;
		this.#assertPeer();
		return result;
	}
	async close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			await this.#connection.close();
		}
	}
}

function rpcError(code: unknown): BrowserContractError {
	const value = typeof code === "string" ? code : "launcher_operation_failed";
	if (value === "aborted") return new BrowserContractError("aborted", value);
	if (value === "stale_runtime_epoch") return new BrowserContractError("runtime_draining", value);
	if (value.includes("selector") || value.includes("locator") || value.includes("keyboard"))
		return new BrowserContractError("selector_drift", value);
	if (value.includes("attachment") || value.includes("malformed") || value.includes("too_large"))
		return new BrowserContractError("malformed_browser_output", value);
	return new BrowserContractError("browser_unavailable", value);
}

export class LauncherBrowserHost implements BrowserHost {
	readonly #native: LauncherNativeClient;
	readonly #authority: LauncherLifecycleAuthority;
	readonly #refreshDescriptor: () => Promise<unknown>;
	readonly #clientPid: number;
	readonly #connectionNonce = nonce();
	#sequence = 0;
	#channel: RpcChannel | undefined;
	#descriptor: LauncherDescriptor | undefined;
	#tail: Promise<void> = Promise.resolve();
	#closed = false;
	#closing = false;
	#closeTask: Promise<void> | undefined;

	constructor(options: LauncherHostOptions) {
		this.#native = options.native;
		this.#authority = Object.freeze({ ...options.authority });
		this.#refreshDescriptor = options.refreshDescriptor;
		this.#clientPid = options.clientPid ?? process.pid;
		if (!Number.isSafeInteger(this.#clientPid) || this.#clientPid <= 0) throw new TypeError("invalid_client_pid");
		boundedString(this.#authority.ownerId, 256, "invalid_launcher_owner");
		boundedString(this.#authority.runtimeEpoch, 256, "invalid_launcher_epoch");
		if (!Number.isSafeInteger(this.#authority.lifecycleGeneration) || this.#authority.lifecycleGeneration < 1)
			throw new TypeError("invalid_lifecycle_generation");
		boundedString(this.#authority.launcherNonce, 256, "invalid_launcher_nonce");
		boundedString(this.#authority.controlToken, 1024, "invalid_launcher_token");
	}
	async #connect(): Promise<void> {
		if (this.#closed) throw new BrowserContractError("browser_unavailable", "launcher_host_closed");
		const descriptor = validateDescriptor(await this.#refreshDescriptor(), this.#authority);
		if (
			this.#channel &&
			this.#descriptor &&
			this.#native.matchesProcessIdentity(this.#descriptor.launcherIdentity, descriptor.launcherIdentity)
		)
			return;
		await this.#channel?.close();
		const connection = await this.#native.connectLocal(descriptor.endpoint);
		try {
			if (
				!this.#native.matchesProcessIdentity(descriptor.launcherIdentity, connection.peer) ||
				!this.#native.matchesProcessIdentity(descriptor.launcherIdentity, connection.currentPeer())
			)
				throw new BrowserContractError("browser_unavailable", "wrong_launcher_peer");
			this.#channel = new RpcChannel(connection, descriptor.launcherIdentity, this.#native);
			this.#descriptor = descriptor;
			this.#sequence = 0;
		} catch (error) {
			await connection.close();
			throw error;
		}
	}
	async #rpc(
		operation: string,
		args: Readonly<Record<string, unknown>>,
		lease?: LeaseAuthority,
		signal?: AbortSignal,
		allowClosing = false,
	): Promise<unknown> {
		if (this.#closing && !allowClosing)
			throw new BrowserContractError("browser_unavailable", "launcher_host_closing");
		let release!: () => void;
		const before = this.#tail;
		this.#tail = new Promise<void>(resolve => {
			release = resolve;
		});
		let abortHandler: (() => void) | undefined;
		try {
			await before;
			if (signal?.aborted) throw new BrowserContractError("aborted", "aborted");
			await this.#connect();
			if (signal?.aborted) throw new BrowserContractError("aborted", "aborted");
			const sequence = ++this.#sequence;
			const responsePromise = this.#channel!.request({
				version: PROTOCOL_VERSION,
				ownerId: this.#authority.ownerId,
				runtimeEpoch: this.#authority.runtimeEpoch,
				lifecycleGeneration: this.#authority.lifecycleGeneration,
				launcherNonce: this.#authority.launcherNonce,
				controlToken: this.#authority.controlToken,
				clientPid: this.#clientPid,
				connectionNonce: this.#connectionNonce,
				requestNonce: nonce(),
				sequence,
				operation,
				...(lease ? { leaseId: lease.leaseId, leaseCapability: lease.leaseCapability } : {}),
				arguments: args,
			});
			const response = signal
				? await Promise.race([
						responsePromise,
						new Promise<never>((_, reject) => {
							abortHandler = () => reject(new BrowserContractError("aborted", "aborted"));
							signal.addEventListener("abort", abortHandler, { once: true });
							if (signal.aborted) abortHandler();
						}),
					])
				: await responsePromise;
			if (signal?.aborted) throw new BrowserContractError("aborted", "aborted");
			if (
				response.version !== PROTOCOL_VERSION ||
				response.sequence !== sequence ||
				typeof response.ok !== "boolean"
			) {
				throw new BrowserContractError("malformed_browser_output", "invalid_launcher_response");
			}
			if (!response.ok) throw rpcError(response.error?.code);
			return response.result;
		} catch (error) {
			if (signal?.aborted) {
				const channel = this.#channel;
				this.#channel = undefined;
				void channel?.close().catch(() => {});
				throw new BrowserContractError("aborted", "aborted");
			}
			throw error;
		} finally {
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			release();
		}
	}
	async login(request: BrowserLoginRequest): Promise<BrowserLoginResult> {
		if (request.headed !== true)
			throw new BrowserContractError("browser_unavailable", "launcher_login_requires_headed");
		if (request.signal?.aborted) throw new BrowserContractError("aborted", "aborted");
		const value = record(
			await this.#rpc(
				"host.login",
				{ profileGeneration: request.profileGeneration, ownerFence: request.ownerFence },
				undefined,
				request.signal,
			),
			"invalid_login_response",
		);
		const executable = record(value.executable, "invalid_login_executable");
		if (
			value.authenticated !== true ||
			typeof value.verifiedAt !== "string" ||
			typeof value.proAvailable !== "boolean" ||
			typeof value.profileIdentity !== "string" ||
			typeof executable.identity !== "string" ||
			typeof executable.sha256 !== "string" ||
			typeof executable.version !== "string"
		)
			throw new BrowserContractError("malformed_browser_output", "invalid_login_response");
		return value as unknown as BrowserLoginResult;
	}
	async lease(request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission): Promise<BrowserLease> {
		if (
			admission.runtimeEpoch !== this.#authority.runtimeEpoch ||
			admission.lifecycleGeneration !== this.#authority.lifecycleGeneration
		)
			throw new BrowserContractError("runtime_draining", "stale_launcher_epoch");
		if (request.signal?.aborted) throw new BrowserContractError("aborted", "aborted");
		const opened = record(
			await this.#rpc(
				"lease.open",
				{
					sessionId: request.sessionId,
					turnId: request.turnId,
					modelKey: request.modelKey,
					mode: request.mode,
					headed: request.headed,
					lifecycleGeneration: admission.lifecycleGeneration,
				},
				undefined,
				request.signal,
			),
			"invalid_lease_response",
		);
		const authority = Object.freeze({
			leaseId: boundedString(opened.leaseId, 256, "invalid_lease_id"),
			leaseCapability: boundedString(opened.leaseCapability, 256, "invalid_lease_capability"),
		});
		const capability = Object.freeze({
			__opaque: Symbol("launcher-browser-lease"),
		}) as unknown as BrowserLeaseCapability;
		let closed = false;
		const cancel = (): void => {
			if (!closed) {
				closed = true;
				void this.#rpc("lease.cancel", {}, authority).catch(() => {});
			}
		};
		const close = async (): Promise<void> => {
			if (!closed) {
				closed = true;
				request.signal?.removeEventListener("abort", cancel);
				await this.#rpc("lease.close", {}, authority);
			}
		};
		if (request.signal?.aborted) {
			cancel();
			throw new BrowserContractError("aborted", "aborted");
		}
		request.signal?.addEventListener("abort", cancel, { once: true });
		return Object.freeze({
			id: authority.leaseId,
			capability,
			page: this.#page(authority, () => closed),
			stageAttachment: async ({ name, bytes }: { name: string; bytes: Uint8Array }) => {
				if (closed) throw new BrowserContractError("browser_unavailable", "closed_lease");
				const value = record(
					await this.#rpc("attachment.stage", { name, base64: Buffer.from(bytes).toString("base64") }, authority),
					"invalid_attachment_response",
				);
				if (
					typeof value.id !== "string" ||
					typeof value.name !== "string" ||
					!Number.isSafeInteger(value.size) ||
					typeof value.sha256 !== "string"
				)
					throw new BrowserContractError("malformed_browser_output", "invalid_attachment_response");
				return Object.freeze({
					...value,
					__opaque: Symbol("launcher-browser-attachment"),
				}) as unknown as BrowserAttachment;
			},
			close,
		});
	}
	#page(authority: LeaseAuthority, isClosed: () => boolean): BrowserPage {
		const assertOpen = (): void => {
			if (isClosed()) throw new BrowserContractError("browser_unavailable", "closed_lease");
		};
		return Object.freeze({
			goto: async (target: BrowserNavigationTarget) => {
				assertOpen();
				await this.#rpc("page.goto", { target }, authority);
			},
			locator: (key: BrowserSelectorKey) => {
				assertOpen();
				assertBrowserSelectorKey(key);
				return this.#locator(authority, { kind: "selector", key, chain: [] }, isClosed);
			},
			getByRole: (target: BrowserRoleTarget) => {
				assertOpen();
				assertBrowserRoleTarget(target);
				return this.#locator(authority, { kind: "role", target, chain: [] }, isClosed);
			},
			readComposerSnapshot: async () => {
				assertOpen();
				return validateComposerSnapshot(await this.#rpc("page.read-composer", {}, authority));
			},
			readResponseSnapshot: async () => {
				assertOpen();
				return validateResponseSnapshot(await this.#rpc("page.read-response", {}, authority));
			},
			readHealthSnapshot: async () => {
				assertOpen();
				return validateHealthSnapshot(await this.#rpc("page.read-health", {}, authority));
			},
			state: async () => {
				if (isClosed()) return "closed";
				const value = await this.#rpc("page.state", {}, authority);
				if (value !== "temporary-chat" && value !== "other" && value !== "closed")
					throw new BrowserContractError("malformed_browser_output", "invalid_page_state");
				return value;
			},
			close: async () => {
				if (!isClosed()) await this.#rpc("page.close", {}, authority);
			},
		});
	}
	#locator(authority: LeaseAuthority, descriptor: LocatorDescriptor, isClosed: () => boolean): BrowserLocator {
		const invoke = async (operation: string, args: Record<string, unknown> = {}): Promise<unknown> => {
			if (isClosed()) throw new BrowserContractError("browser_unavailable", "closed_lease");
			return this.#rpc(operation, { locator: descriptor, ...args }, authority);
		};
		const append = (step: LocatorStep): BrowserLocator =>
			this.#locator(authority, { ...descriptor, chain: [...descriptor.chain, step] }, isClosed);
		return Object.freeze({
			click: async () => {
				await invoke("locator.click");
			},
			fill: async (text: string) => {
				await invoke("locator.fill", { text });
			},
			insertText: async (text: string) => {
				await invoke("locator.insert-text", { text });
			},
			press: async (key: BrowserKey) => {
				assertBrowserKey(key);
				await invoke("locator.press", { key });
			},
			pressSequentially: async (text: string) => {
				await invoke("locator.press-sequentially", { text });
			},
			setInputFiles: async (files: readonly BrowserAttachment[]) => {
				await invoke("locator.set-input-files", { attachmentIds: files.map(file => file.id) });
			},
			isVisible: async () => {
				const value = await invoke("locator.is-visible");
				if (typeof value !== "boolean")
					throw new BrowserContractError("malformed_browser_output", "invalid_locator_boolean");
				return value;
			},
			isEnabled: async () => {
				const value = await invoke("locator.is-enabled");
				if (typeof value !== "boolean")
					throw new BrowserContractError("malformed_browser_output", "invalid_locator_boolean");
				return value;
			},
			count: async () => validateLocatorCount(await invoke("locator.count")),
			nth: (index: number) => {
				if (!Number.isSafeInteger(index) || index < 0 || index >= 256)
					throw new BrowserContractError("selector_drift", "invalid_locator_index");
				return append({ kind: "nth", index });
			},
			last: () => append({ kind: "last" }),
			allInnerTexts: async () => validateLocatorTexts(await invoke("locator.all-inner-texts")),
			textContent: async () => validateLocatorText(await invoke("locator.text-content")),
			filter: (target: BrowserFilterTarget) => {
				assertBrowserFilterTarget(target);
				return append({
					kind: "filter",
					key: target.key,
					...(target.hasText === undefined ? {} : { hasText: target.hasText }),
				});
			},
		});
	}
	async close(): Promise<void> {
		if (this.#closeTask) return this.#closeTask;
		this.#closing = true;
		this.#closeTask = (async () => {
			try {
				await this.#rpc("host.close", {}, undefined, undefined, true);
			} finally {
				this.#closed = true;
				const channel = this.#channel;
				this.#channel = undefined;
				await channel?.close();
			}
		})();
		return this.#closeTask;
	}
}
