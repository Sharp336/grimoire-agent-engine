import { createHash, timingSafeEqual } from "node:crypto";
import { unzipSync } from "fflate";
import type { ChatGptWebMode } from "../config";
import type { ChatGptWebOrchestration } from "../provider/orchestration";
import type { ChatGptWebRuntimeAdmission, ChatGptWebRuntimeGate } from "../provider/types";
import {
	consumeTunnelSpawnEnvironment,
	createNativeOmpBootstrapAuthority,
	type NativeLaunchEnvironment,
	type NativeOwnedBootstrapFile,
	type OmpBootstrapAuthority,
	type OmpBrokerEndpoint,
	type OmpConnectorBootstrap,
	type OmpTunnelBootstrap,
	type OmpTunnelProcessIdentity,
	type OmpTunnelSpawnEnvironment,
	registerTunnelSpawnEnvironment,
} from "./bootstrap";
import {
	createBrokerOrchestration,
	createOmpTurnBroker,
	type OmpPreparedTunnelSpawn,
	type OmpTurnBroker,
} from "./broker";
import { type RuntimeCommand, type RuntimeCommandNativeHost, resolveRuntimeCommand } from "./runtime-command";

export type {
	NativeLaunchEnvironment,
	OmpBrokerEndpoint,
	OmpConnectorBootstrap,
	OmpTunnelBootstrap,
	OmpTunnelProcessIdentity,
} from "./bootstrap";
export type { OmpTurnBroker } from "./broker";

export const TUNNEL_VERSION = "0.0.10" as const;
export const MAX_TUNNEL_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_TUNNEL_BINARY_BYTES = 100 * 1024 * 1024;
export const DEFAULT_TUNNEL_DOWNLOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_TUNNEL_READY_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const RELEASE_ROOT = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}`;
const ALLOWED_RELEASE_HOSTS: Readonly<Record<string, true>> = Object.freeze({
	"github.com": true,
	"release-assets.githubusercontent.com": true,
});

export type TunnelPlatformTuple =
	| "darwin-arm64"
	| "darwin-x64"
	| "linux-arm64"
	| "linux-x64"
	| "win32-arm64"
	| "win32-x64";

export interface TunnelArtifact {
	readonly url: string;
	readonly sha256: string;
	readonly executableName: "tunnel-client" | "tunnel-client.exe";
	readonly semanticVersion: typeof TUNNEL_VERSION;
	readonly binaryVersion: typeof TUNNEL_VERSION;
}

export const TUNNEL_ARTIFACTS = Object.freeze({
	"darwin-arm64": Object.freeze({
		url: `${RELEASE_ROOT}/tunnel-client-v0.0.10-darwin-arm64.zip`,
		sha256: "288accc7fd20cfee1d495adb933773af9e19ebc0cdef3173f7fb544afa5065b2",
		executableName: "tunnel-client",
		semanticVersion: TUNNEL_VERSION,
		binaryVersion: TUNNEL_VERSION,
	}),
	"darwin-x64": Object.freeze({
		url: `${RELEASE_ROOT}/tunnel-client-v0.0.10-darwin-amd64.zip`,
		sha256: "1a48616e584484f8bef4c1128d515ac96cf44d0d9609c1462abccc1793f4b847",
		executableName: "tunnel-client",
		semanticVersion: TUNNEL_VERSION,
		binaryVersion: TUNNEL_VERSION,
	}),
	"linux-arm64": Object.freeze({
		url: `${RELEASE_ROOT}/tunnel-client-v0.0.10-linux-arm64.zip`,
		sha256: "b842a9b2352eebd80514cf01a1fbb1c0d400a7d24a4015e85a7ea5f1aeaa5b30",
		executableName: "tunnel-client",
		semanticVersion: TUNNEL_VERSION,
		binaryVersion: TUNNEL_VERSION,
	}),
	"linux-x64": Object.freeze({
		url: `${RELEASE_ROOT}/tunnel-client-v0.0.10-linux-amd64.zip`,
		sha256: "b9e0388a343f2d7adeff3992f411a0bd3d916a64bc56534aac5fd15ac1b20cd5",
		executableName: "tunnel-client",
		semanticVersion: TUNNEL_VERSION,
		binaryVersion: TUNNEL_VERSION,
	}),
	"win32-arm64": Object.freeze({
		url: `${RELEASE_ROOT}/tunnel-client-v0.0.10-windows-arm64.zip`,
		sha256: "08954ccda078abfeac9382f9b19d178ce0656cfe1e84f5941f0f8a5c4e91ea78",
		executableName: "tunnel-client.exe",
		semanticVersion: TUNNEL_VERSION,
		binaryVersion: TUNNEL_VERSION,
	}),
	"win32-x64": Object.freeze({
		url: `${RELEASE_ROOT}/tunnel-client-v0.0.10-windows-amd64.zip`,
		sha256: "5e64a056f1d96786da0a6f8db1da5f5f4a03fd19a90d951a25cf2ca8d9093d00",
		executableName: "tunnel-client.exe",
		semanticVersion: TUNNEL_VERSION,
		binaryVersion: TUNNEL_VERSION,
	}),
} satisfies Record<TunnelPlatformTuple, TunnelArtifact>);

export interface TunnelHttpResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly body: AsyncIterable<Uint8Array>;
	cancel(): void;
}

export interface TunnelHttpClient {
	request(
		url: URL,
		options: { readonly signal: AbortSignal; readonly redirect: "manual" },
	): Promise<TunnelHttpResponse>;
}

/** Opaque already-open installed executable and its owner-controlled install identity. */
export interface InstalledTunnelArtifact {
	readonly tuple: TunnelPlatformTuple;
	readonly archiveSha256: string;
	readonly binarySha256: string;
	readonly binaryVersion: typeof TUNNEL_VERSION;
	readonly fileIdentity: string;
	readonly executable: NativeVerifiedTunnelExecutable;
	readonly __installedTunnelArtifact: symbol;
}

export interface TunnelConnectionProfile {
	readonly __tunnelConnectionProfile: symbol;
}

export interface NativeTunnelInstallTransaction {
	/** Writes to an owner-only no-follow temporary regular file and keeps it open. */
	writeExecutable(bytes: Uint8Array): Promise<void>;
	/** Executes --version through the held file capability, never by reopening its pathname. */
	verifyBinaryVersion(expected: string): Promise<void>;
	/** Makes the held file non-writable where supported and atomically replaces the fixed destination. */
	commit(request: {
		readonly tuple: TunnelPlatformTuple;
		readonly archiveSha256: string;
		readonly binarySha256: string;
		readonly binaryVersion: typeof TUNNEL_VERSION;
	}): Promise<InstalledTunnelArtifact>;
	rollback(): Promise<void>;
}

export interface NativeTunnelInstallHost {
	/**
	 * Revalidates the owner-only install parent and destination without following links/reparse points,
	 * rejects hardlinks, and starts a same-directory atomic transaction for the fixed executable name.
	 */
	beginInstall(executableName: TunnelArtifact["executableName"]): Promise<NativeTunnelInstallTransaction>;
	/** Revalidates held file, parent, destination, digest, version, and executable identity before spawn. */
	assertLaunchIdentity(artifact: InstalledTunnelArtifact): Promise<void>;
}

function artifactTuple(platform: NodeJS.Platform, arch: NodeJS.Architecture): TunnelPlatformTuple {
	const tuple = `${platform}-${arch}`;
	if (!Object.hasOwn(TUNNEL_ARTIFACTS, tuple)) {
		throw new Error(`No pinned tunnel client exists for ${platform}/${arch}`);
	}
	return tuple as TunnelPlatformTuple;
}

function header(response: TunnelHttpResponse, name: string): string | undefined {
	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers)) {
		if (key.toLowerCase() === lowerName) return value;
	}
	return undefined;
}

function validateReleaseUrl(url: URL): void {
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		!Object.hasOwn(ALLOWED_RELEASE_HOSTS, url.hostname)
	) {
		throw new Error("Tunnel download URL is outside the pinned HTTPS release hosts");
	}
}

async function downloadArtifact(
	urlText: string,
	http: TunnelHttpClient,
	options: { readonly signal?: AbortSignal; readonly timeoutMs: number },
): Promise<Uint8Array> {
	const controller = new AbortController();
	const abortFromCaller = (): void => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) abortFromCaller();
	else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => controller.abort(new Error("Tunnel download timed out")), options.timeoutMs);
	let current = new URL(urlText);
	try {
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
			validateReleaseUrl(current);
			const response = await http.request(current, { signal: controller.signal, redirect: "manual" });
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				response.cancel();
				const location = header(response, "location");
				if (!location || redirects === MAX_REDIRECTS)
					throw new Error("Tunnel download exceeded its redirect policy");
				current = new URL(location, current);
				continue;
			}
			if (response.status < 200 || response.status >= 300) {
				response.cancel();
				throw new Error(`Tunnel download failed with status ${response.status}`);
			}
			const declaredLength = header(response, "content-length");
			if (declaredLength !== undefined) {
				if (!/^\d+$/u.test(declaredLength)) {
					response.cancel();
					throw new Error("Tunnel download has an invalid content length");
				}
				if (Number(declaredLength) > MAX_TUNNEL_DOWNLOAD_BYTES) {
					response.cancel();
					throw new Error("Tunnel download exceeds the maximum size");
				}
			}
			const chunks: Uint8Array[] = [];
			let total = 0;
			try {
				for await (const chunk of response.body) {
					if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Tunnel download cancelled");
					total += chunk.byteLength;
					if (total > MAX_TUNNEL_DOWNLOAD_BYTES) throw new Error("Tunnel download exceeds the maximum size");
					chunks.push(chunk);
				}
			} catch (error) {
				response.cancel();
				throw error;
			}
			const bytes = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return bytes;
		}
		throw new Error("Tunnel download exceeded its redirect policy");
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(options.signal?.aborted ? "Tunnel download cancelled" : "Tunnel download timed out", {
				cause: error,
			});
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

function u16(view: DataView, offset: number): number {
	if (offset < 0 || offset + 2 > view.byteLength) throw new Error("Tunnel archive is truncated");
	return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
	if (offset < 0 || offset + 4 > view.byteLength) throw new Error("Tunnel archive is truncated");
	return view.getUint32(offset, true);
}

export function extractPinnedTunnelExecutable(archive: Uint8Array, expectedName: string): Uint8Array {
	if (archive.byteLength < 22) throw new Error("Tunnel archive is corrupt");
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	let eocd = -1;
	const earliest = Math.max(0, archive.byteLength - 65_557);
	for (let offset = archive.byteLength - 22; offset >= earliest; offset -= 1) {
		if (u32(view, offset) === 0x0605_4b50) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0 || u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) {
		throw new Error("Tunnel archive must be a single-disk ZIP");
	}
	const entryCount = u16(view, eocd + 10);
	const centralSize = u32(view, eocd + 12);
	const centralOffset = u32(view, eocd + 16);
	if (entryCount !== 1 || centralOffset + centralSize > eocd || u32(view, centralOffset) !== 0x0201_4b50) {
		throw new Error("Tunnel archive must contain exactly the pinned executable");
	}
	const flags = u16(view, centralOffset + 8);
	const method = u16(view, centralOffset + 10);
	const compressedSize = u32(view, centralOffset + 20);
	const uncompressedSize = u32(view, centralOffset + 24);
	const nameLength = u16(view, centralOffset + 28);
	const extraLength = u16(view, centralOffset + 30);
	const commentLength = u16(view, centralOffset + 32);
	const externalAttributes = u32(view, centralOffset + 38);
	const localOffset = u32(view, centralOffset + 42);
	const centralEnd = centralOffset + 46 + nameLength + extraLength + commentLength;
	if (centralEnd !== centralOffset + centralSize || (flags & ~0x0800) !== 0 || (method !== 0 && method !== 8)) {
		throw new Error("Tunnel archive uses unsupported ZIP features");
	}
	if (uncompressedSize === 0 || uncompressedSize > MAX_TUNNEL_BINARY_BYTES || compressedSize > archive.byteLength) {
		throw new Error("Tunnel executable has an invalid size");
	}
	const unixFileType = (externalAttributes >>> 16) & 0o170000;
	const dosAttributes = externalAttributes & 0xffff;
	if ((unixFileType !== 0 && unixFileType !== 0o100000) || (dosAttributes & 0x10) !== 0) {
		throw new Error("Tunnel archive links and non-regular entries are forbidden");
	}
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const entryName = decoder.decode(archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength));
	if (entryName !== expectedName || /[\\/\0]/u.test(entryName) || entryName === "." || entryName === "..") {
		throw new Error("Tunnel archive entry path is not the pinned executable");
	}
	if (u32(view, localOffset) !== 0x0403_4b50) throw new Error("Tunnel archive local header is corrupt");
	const localFlags = u16(view, localOffset + 6);
	const localMethod = u16(view, localOffset + 8);
	const localNameLength = u16(view, localOffset + 26);
	const localExtraLength = u16(view, localOffset + 28);
	const localDataOffset = localOffset + 30 + localNameLength + localExtraLength;
	const localName = decoder.decode(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength));
	if (
		localFlags !== flags ||
		localMethod !== method ||
		localName !== expectedName ||
		localDataOffset + compressedSize > centralOffset
	) {
		throw new Error("Tunnel archive local entry does not match its signed directory");
	}
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(archive);
	} catch (error) {
		throw new Error("Tunnel archive decompression failed", { cause: error });
	}
	const names = Object.keys(files);
	const executable = files[expectedName];
	if (names.length !== 1 || !executable || executable.byteLength !== uncompressedSize) {
		throw new Error("Tunnel archive contents do not match the signed directory");
	}
	return executable;
}

/** Package-internal coordinator for an archive whose pinned digest has already been verified. */
export async function commitVerifiedTunnelExecutable(options: {
	readonly tuple: TunnelPlatformTuple;
	readonly archiveSha256: string;
	readonly executable: Uint8Array;
	readonly native: NativeTunnelInstallHost;
}): Promise<InstalledTunnelArtifact> {
	if (!Object.hasOwn(TUNNEL_ARTIFACTS, options.tuple)) throw new Error("Tunnel artifact tuple is unsupported");
	const artifact = TUNNEL_ARTIFACTS[options.tuple];
	if (options.archiveSha256 !== artifact.sha256) throw new Error("Tunnel archive checksum was not verified");
	if (options.executable.byteLength === 0 || options.executable.byteLength > MAX_TUNNEL_BINARY_BYTES) {
		throw new Error("Tunnel executable has an invalid size");
	}
	const binarySha256 = createHash("sha256").update(options.executable).digest("hex");
	const transaction = await options.native.beginInstall(artifact.executableName);
	try {
		await transaction.writeExecutable(options.executable);
		await transaction.verifyBinaryVersion(artifact.binaryVersion);
		const installed = await transaction.commit({
			tuple: options.tuple,
			archiveSha256: options.archiveSha256,
			binarySha256,
			binaryVersion: artifact.binaryVersion,
		});
		if (
			installed.tuple !== options.tuple ||
			installed.archiveSha256 !== options.archiveSha256 ||
			installed.binarySha256 !== binarySha256 ||
			installed.binaryVersion !== artifact.binaryVersion ||
			installed.fileIdentity === ""
		) {
			throw new Error("Native tunnel install returned a mismatched identity");
		}
		await options.native.assertLaunchIdentity(installed);
		return installed;
	} catch (error) {
		try {
			await transaction.rollback();
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Tunnel installation and rollback both failed");
		}
		throw error;
	}
}

export async function installTunnelClient(options: {
	readonly platform?: NodeJS.Platform;
	readonly arch?: NodeJS.Architecture;
	readonly http: TunnelHttpClient;
	readonly native: NativeTunnelInstallHost;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}): Promise<InstalledTunnelArtifact> {
	const tuple = artifactTuple(options.platform ?? process.platform, options.arch ?? process.arch);
	const artifact = TUNNEL_ARTIFACTS[tuple];
	const archive = await downloadArtifact(artifact.url, options.http, {
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? DEFAULT_TUNNEL_DOWNLOAD_TIMEOUT_MS,
	});
	const archiveSha256 = createHash("sha256").update(archive).digest("hex");
	if (archiveSha256 !== artifact.sha256) throw new Error("Tunnel archive checksum mismatch");
	const executable = extractPinnedTunnelExecutable(archive, artifact.executableName);
	return commitVerifiedTunnelExecutable({
		tuple,
		archiveSha256,
		executable,
		native: options.native,
	});
}

export interface NativeOwnedFile {
	readonly identity: string;
	consume(): void | Promise<void>;
	cleanup(): void | Promise<void>;
	close(): void | Promise<void>;
}

export interface NativeVerifiedTunnelExecutable {
	readonly identity: string;
	close(): void;
	readonly __nativeVerifiedTunnelExecutable: symbol;
}

export interface TunnelEnvironmentNativeHost {
	/** Resolves opaque broker/bootstrap capabilities and creates the native tunnel-child profile. */
	createLaunchEnvironment(request: {
		readonly runtimeKey: NativeOwnedFile;
		readonly endpoint: OmpBrokerEndpoint;
		readonly connectorBootstrap: OmpConnectorBootstrap;
		readonly tunnelBootstrap: OmpTunnelBootstrap;
		readonly runtimeEpoch: string;
		readonly lifecycleGeneration: number;
		readonly inheritedEnvironment: Readonly<Record<string, never>>;
	}): Promise<{
		readonly environment: NativeLaunchEnvironment;
		readonly close: () => void;
	}>;
}

export interface NativeLocalEndpointCapability {
	readonly __nativeLocalEndpoint: symbol;
}

export interface PiNativeTunnelLaunchModule {
	createLaunchEnvironment(profile: {
		readonly kind: "tunnel-child";
		readonly bootstrap: NativeOwnedFile;
		readonly broker: NativeLocalEndpointCapability;
		readonly runtimeKey: NativeOwnedFile;
		readonly runtimeEpoch: string;
	}): NativeLaunchEnvironment;
}

export interface PiNativeTunnelCapabilityResolver {
	takeBootstrap(
		connector: OmpConnectorBootstrap,
		tunnel: OmpTunnelBootstrap,
	): {
		readonly file: NativeOwnedFile;
		readonly close: () => void;
	};
	brokerEndpoint(endpoint: OmpBrokerEndpoint): NativeLocalEndpointCapability;
}

/** Concrete bridge to the package native launch profile; it never reads key/bootstrap bytes or paths in JS. */
export class PiNativeTunnelEnvironmentHost implements TunnelEnvironmentNativeHost {
	readonly #native: PiNativeTunnelLaunchModule;
	readonly #capabilities: PiNativeTunnelCapabilityResolver;

	constructor(native: PiNativeTunnelLaunchModule, capabilities: PiNativeTunnelCapabilityResolver) {
		this.#native = native;
		this.#capabilities = capabilities;
	}

	async createLaunchEnvironment(
		request: Parameters<TunnelEnvironmentNativeHost["createLaunchEnvironment"]>[0],
	): Promise<{ readonly environment: NativeLaunchEnvironment; readonly close: () => void }> {
		if (Object.keys(request.inheritedEnvironment).length !== 0) {
			throw new Error("Tunnel child environment must not inherit ambient variables");
		}
		const bootstrap = this.#capabilities.takeBootstrap(request.connectorBootstrap, request.tunnelBootstrap);
		try {
			const environment = this.#native.createLaunchEnvironment({
				kind: "tunnel-child",
				bootstrap: bootstrap.file,
				broker: this.#capabilities.brokerEndpoint(request.endpoint),
				runtimeKey: request.runtimeKey,
				runtimeEpoch: request.runtimeEpoch,
			});
			return { environment, close: bootstrap.close };
		} catch (error) {
			try {
				bootstrap.close();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Native tunnel environment creation cleanup failed");
			}
			throw error;
		}
	}
}

const consumedRuntimeKeyHandles = new WeakSet<object>();

export interface PreparedTunnelSpawnEnvironment {
	readonly environment: NativeLaunchEnvironment;
	/** Called only after native spawn and broker/child readiness agree on the current epoch. */
	completeSpawnHandoff(): Promise<void>;
	close(): Promise<void>;
}

/** Package-private held-key boundary; tests exercise it through this non-exported package subpath. */
export async function materializeTunnelSpawnEnvironment(request: {
	readonly runtimeKey: NativeOwnedFile;
	readonly endpoint: OmpBrokerEndpoint;
	readonly connectorBootstrap: OmpConnectorBootstrap;
	readonly tunnelBootstrap: OmpTunnelBootstrap;
	readonly runtimeEpoch: string;
	readonly lifecycleGeneration: number;
	readonly native: TunnelEnvironmentNativeHost;
}): Promise<PreparedTunnelSpawnEnvironment> {
	if (consumedRuntimeKeyHandles.has(request.runtimeKey)) throw new Error("Runtime-key handle was already consumed");
	if (typeof request.runtimeKey.cleanup !== "function") {
		const unavailable = new Error("Runtime-key cleanup capability is unavailable");
		try {
			await request.runtimeKey.close();
		} catch (closeError) {
			throw new AggregateError([unavailable, closeError], "Runtime-key cleanup capability is unavailable");
		}
		throw unavailable;
	}
	consumedRuntimeKeyHandles.add(request.runtimeKey);
	let spawnEnvironment: OmpTunnelSpawnEnvironment | undefined;
	let keyCleaned = false;
	try {
		const materialized = await request.native.createLaunchEnvironment({
			runtimeKey: request.runtimeKey,
			endpoint: request.endpoint,
			connectorBootstrap: request.connectorBootstrap,
			tunnelBootstrap: request.tunnelBootstrap,
			runtimeEpoch: request.runtimeEpoch,
			lifecycleGeneration: request.lifecycleGeneration,
			inheritedEnvironment: Object.freeze({}),
		});
		registerTunnelSpawnEnvironment(request.tunnelBootstrap, materialized.environment, materialized.close);
		spawnEnvironment = consumeTunnelSpawnEnvironment(request.tunnelBootstrap);
	} catch (error) {
		const errors: unknown[] = [error];
		try {
			spawnEnvironment?.close();
		} catch (closeEnvironmentError) {
			errors.push(closeEnvironmentError);
		}
		try {
			await request.runtimeKey.cleanup();
			keyCleaned = true;
		} catch (cleanupKeyError) {
			errors.push(cleanupKeyError);
		}
		try {
			await request.runtimeKey.close();
		} catch (closeKeyError) {
			errors.push(closeKeyError);
		}
		throw errors.length === 1 ? error : new AggregateError(errors, "Runtime-key handoff cleanup failed");
	}
	let handoffComplete = false;
	let closed = false;
	return {
		environment: spawnEnvironment.environment,
		async completeSpawnHandoff(): Promise<void> {
			if (closed || handoffComplete) throw new Error("Tunnel spawn handoff is closed or already completed");
			await request.runtimeKey.cleanup();
			keyCleaned = true;
			await request.runtimeKey.consume();
			handoffComplete = true;
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			const errors: unknown[] = [];
			try {
				spawnEnvironment.close();
			} catch (error) {
				errors.push(error);
			}
			if (!keyCleaned) {
				try {
					await request.runtimeKey.cleanup();
					keyCleaned = true;
				} catch (error) {
					errors.push(error);
				}
			}
			try {
				await request.runtimeKey.close();
			} catch (error) {
				errors.push(error);
			}
			if (errors.length > 0) throw new AggregateError(errors, "Tunnel spawn environment cleanup failed");
		},
	};
}

export type OmpTurnBrokerLifecycleHost = Pick<
	OmpTurnBroker,
	"abortTunnelSpawn" | "authorizeTunnel" | "close" | "drain" | "gate" | "listen" | "prepareTunnelSpawn"
> & {
	waitForTunnelReady(process: OmpTunnelProcessIdentity, signal: AbortSignal, timeoutMs: number): Promise<void>;
};

export interface NativeRuntimeKeySource {
	/** Duplicates the already-open owner capability; implementations must never reopen a configured pathname. */
	duplicateForSpawn(runtimeEpoch: string, lifecycleGeneration: number): Promise<NativeOwnedFile>;
	close(): Promise<void>;
}

export interface NativeOwnedProcess {
	readonly identity: OmpTunnelProcessIdentity;
	waitReady(signal: AbortSignal, timeoutMs: number): Promise<void>;
	/** Uses the retained pidfd/process/job handle and verifies executable/start identity before termination. */
	terminateOwnedTree(timeoutMs: number): Promise<void>;
	assertInactive(): Promise<void>;
}

export interface TunnelProcessNativeHost {
	/** Required marker for a nonblocking Job Object/process-group adapter; raw native sync processes are rejected. */
	readonly supportsOwnedTreeAsync: true;
	spawn(request: {
		readonly artifact: InstalledTunnelArtifact;
		readonly command: RuntimeCommand;
		readonly environment: NativeLaunchEnvironment;
		readonly tunnelBootstrap: OmpTunnelBootstrap;
		readonly profile: FullTunnelSpawnProfile;
		readonly signal: AbortSignal;
	}): Promise<NativeOwnedProcess>;
}

export interface FullTunnelSpawnProfile {
	readonly connection: TunnelConnectionProfile;
}

export interface RuntimeEpochIdentity {
	readonly runtimeEpoch: string;
	readonly lifecycleGeneration: number;
}

export interface ChatGptWebRuntimeEpoch extends RuntimeEpochIdentity {
	readonly gate: ChatGptWebRuntimeGate;
	readonly broker?: OmpTurnBrokerLifecycleHost;
	readonly runtimeKey?: NativeRuntimeKeySource;
	readonly orchestration?: ChatGptWebOrchestration;
	readonly environmentHost?: TunnelEnvironmentNativeHost;
	readonly materializeTunnelSpawn?: (spawn: OmpPreparedTunnelSpawn) => Promise<PreparedTunnelSpawnEnvironment>;
	cancelBrowserTurns(): Promise<void>;
	close?(): Promise<void>;
}

export interface ChatGptWebRuntimeEpochFactory {
	create(mode: ChatGptWebMode): Promise<ChatGptWebRuntimeEpoch>;
}

export type ChatGptWebRuntimeEpochWiring =
	| {
			readonly mode: "browser-only";
			readonly createBrowserEpoch: () => Promise<ChatGptWebRuntimeEpoch>;
	  }
	| {
			readonly mode: "full";
			readonly authorityFactory?: () =>
				| (OmpBootstrapAuthority & PiNativeTunnelCapabilityResolver)
				| Promise<OmpBootstrapAuthority & PiNativeTunnelCapabilityResolver>;
			readonly environmentHostFactory: (
				authority: OmpBootstrapAuthority & PiNativeTunnelCapabilityResolver,
			) => TunnelEnvironmentNativeHost | Promise<TunnelEnvironmentNativeHost>;
			readonly runtimeKeySourceFactory: (
				identity: RuntimeEpochIdentity,
			) => NativeRuntimeKeySource | Promise<NativeRuntimeKeySource>;
			readonly waitForTunnelReady: (
				broker: OmpTurnBroker,
				process: OmpTunnelProcessIdentity,
				signal: AbortSignal,
				timeoutMs: number,
			) => Promise<void>;
			readonly cancelBrowserTurns: () => Promise<void>;
	  };

/**
 * Constructs the real broker only for configured full mode. Missing native bootstrap authority is
 * a hard error; browser-only wiring never evaluates or retains a broker/authority factory.
 */
export function createChatGptWebRuntimeEpochFactory(
	wiring: ChatGptWebRuntimeEpochWiring,
): ChatGptWebRuntimeEpochFactory {
	return {
		async create(requestedMode): Promise<ChatGptWebRuntimeEpoch> {
			if (requestedMode !== wiring.mode) throw new Error("Runtime mode cannot change across epochs");
			if (wiring.mode === "browser-only") {
				const epoch = await wiring.createBrowserEpoch();
				if (
					epoch.broker ||
					epoch.runtimeKey ||
					epoch.orchestration ||
					epoch.environmentHost ||
					epoch.materializeTunnelSpawn
				) {
					throw new Error("Browser-only epoch factory returned full-mode state");
				}
				return epoch;
			}
			if (!wiring.authorityFactory) {
				throw new Error("Full mode native broker/bootstrap authority is unavailable");
			}
			const authority = await wiring.authorityFactory();
			const broker = createOmpTurnBroker({ bootstrapAuthority: authority });
			const identity = broker.gate.state;
			let runtimeKey: NativeRuntimeKeySource;
			let environmentHost: TunnelEnvironmentNativeHost;
			try {
				[runtimeKey, environmentHost] = await Promise.all([
					wiring.runtimeKeySourceFactory(identity),
					wiring.environmentHostFactory(authority),
				]);
			} catch (error) {
				try {
					await broker.close();
				} catch (closeError) {
					throw new AggregateError([error, closeError], "Full runtime epoch creation cleanup failed");
				}
				throw error;
			}
			let endpoint: OmpBrokerEndpoint | undefined;
			const lifecycleBroker: OmpTurnBrokerLifecycleHost = {
				gate: broker.gate,
				async listen() {
					const listening = await broker.listen();
					endpoint = listening.endpoint;
					return listening;
				},
				prepareTunnelSpawn: () => broker.prepareTunnelSpawn(),
				abortTunnelSpawn: (bootstrap, admission) => broker.abortTunnelSpawn(bootstrap, admission),
				authorizeTunnel: (bootstrap, process, admission) => broker.authorizeTunnel(bootstrap, process, admission),
				waitForTunnelReady: (process, signal, timeoutMs) =>
					wiring.waitForTunnelReady(broker, process, signal, timeoutMs),
				drain: () => broker.drain(),
				close: () => broker.close(),
			};
			const materializeEpochTunnelSpawn = async (
				spawn: Awaited<ReturnType<OmpTurnBroker["prepareTunnelSpawn"]>>,
			): Promise<PreparedTunnelSpawnEnvironment> => {
				if (closed) throw new Error("Full runtime epoch is closed");
				if (!endpoint) throw new Error("Full runtime broker is not listening");
				const key = await runtimeKey.duplicateForSpawn(identity.runtimeEpoch, identity.lifecycleGeneration);
				return materializeTunnelSpawnEnvironment({
					runtimeKey: key,
					endpoint,
					connectorBootstrap: spawn.connectorBootstrap,
					tunnelBootstrap: spawn.tunnelBootstrap,
					runtimeEpoch: identity.runtimeEpoch,
					lifecycleGeneration: identity.lifecycleGeneration,
					native: environmentHost,
				});
			};
			let closed = false;
			const close = async (): Promise<void> => {
				if (closed) return;
				closed = true;
				const results = await Promise.allSettled([broker.close(), runtimeKey.close()]);
				const errors = results
					.filter((result): result is PromiseRejectedResult => result.status === "rejected")
					.map(result => result.reason);
				if (errors.length > 0) throw new AggregateError(errors, "Full runtime epoch cleanup failed");
			};
			return {
				...identity,
				gate: broker.gate,
				broker: lifecycleBroker,
				runtimeKey,
				orchestration: createBrokerOrchestration(broker),
				environmentHost,
				materializeTunnelSpawn: materializeEpochTunnelSpawn,
				cancelBrowserTurns: wiring.cancelBrowserTurns,
				close,
			};
		},
	};
}

export interface NativeFullRuntimeEpochOptions {
	readonly nativeModule: unknown;
	readonly runtimeRoot: NativeOwnedBootstrapFile;
	readonly runtimeKeySourceFactory: (
		identity: RuntimeEpochIdentity,
	) => NativeRuntimeKeySource | Promise<NativeRuntimeKeySource>;
	readonly waitForTunnelReady: (
		broker: OmpTurnBroker,
		process: OmpTunnelProcessIdentity,
		signal: AbortSignal,
		timeoutMs: number,
	) => Promise<void>;
	readonly cancelBrowserTurns: () => Promise<void>;
}

/** Full-mode production wiring from an already-open owner-private runtime-root directory handle. */
export function createNativeFullRuntimeEpochFactory(
	options: NativeFullRuntimeEpochOptions,
): ChatGptWebRuntimeEpochFactory {
	return createChatGptWebRuntimeEpochFactory({
		mode: "full",
		authorityFactory: () => createNativeOmpBootstrapAuthority(options.runtimeRoot, options.nativeModule),
		environmentHostFactory(authority) {
			const nativeModule = options.nativeModule as Partial<PiNativeTunnelLaunchModule> | null;
			if (!nativeModule || typeof nativeModule.createLaunchEnvironment !== "function") {
				throw new Error("Native tunnel launch environment is unavailable");
			}
			return new PiNativeTunnelEnvironmentHost(nativeModule as PiNativeTunnelLaunchModule, authority);
		},
		runtimeKeySourceFactory: options.runtimeKeySourceFactory,
		waitForTunnelReady: options.waitForTunnelReady,
		cancelBrowserTurns: options.cancelBrowserTurns,
	});
}

export interface NativePeerConnection {
	readonly __nativePeerConnection: symbol;
}

export interface LifecycleControlPeerHost {
	/** Revalidates owner, peer start identity, native connection identity, and connection-bound nonce. */
	verifyControlPeer(peer: NativePeerConnection, nonce: string): Promise<void>;
}

export type LifecycleControlAction = "cancel-browser-turns" | "drain" | "restart" | "resume" | "shutdown";

export interface LifecycleControlRequest extends RuntimeEpochIdentity {
	readonly action: LifecycleControlAction;
	readonly controlToken: string;
	readonly connectionNonce: string;
	readonly sequence: number;
}

export interface ChatGptWebRuntimeHealth extends RuntimeEpochIdentity {
	readonly mode: ChatGptWebMode;
	readonly state: "drained" | "running" | "starting" | "stopped";
	readonly tunnelReady: boolean;
}

export interface FullRuntimeDependencies {
	readonly artifact: InstalledTunnelArtifact;
	readonly connectionProfile: TunnelConnectionProfile;
	readonly installHost: NativeTunnelInstallHost;
	readonly processHost: TunnelProcessNativeHost;
	readonly environmentHost?: TunnelEnvironmentNativeHost;
	readonly runtimeCommandHost: RuntimeCommandNativeHost;
	readonly bundleRoot: string;
	readonly readyTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly restartLimit?: number;
}

export interface ChatGptWebRuntimeDependencies {
	readonly mode: ChatGptWebMode;
	readonly controlToken: string;
	readonly peerHost: LifecycleControlPeerHost;
	readonly epochFactory: ChatGptWebRuntimeEpochFactory;
	readonly full?: FullRuntimeDependencies;
}

interface ActiveTunnel {
	readonly process: NativeOwnedProcess;
	readonly admission: ChatGptWebRuntimeAdmission;
	readonly connectorBootstrap: OmpConnectorBootstrap;
	brokerCleanupComplete?: boolean;
}

function equalSecret(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

function validateEpochIdentity(identity: RuntimeEpochIdentity): void {
	if (
		identity.runtimeEpoch === "" ||
		!Number.isSafeInteger(identity.lifecycleGeneration) ||
		identity.lifecycleGeneration < 0
	) {
		throw new Error("Invalid runtime epoch identity");
	}
}

function validateInstalledTunnelArtifact(artifact: InstalledTunnelArtifact): void {
	if (!Object.hasOwn(TUNNEL_ARTIFACTS, artifact.tuple)) throw new Error("Installed tunnel tuple is unsupported");
	const expected = TUNNEL_ARTIFACTS[artifact.tuple];
	if (
		artifact.archiveSha256 !== expected.sha256 ||
		!/^[a-f0-9]{64}$/u.test(artifact.binarySha256) ||
		artifact.fileIdentity === "" ||
		artifact.executable.identity === "" ||
		typeof artifact.executable.close !== "function"
	) {
		throw new Error("Installed tunnel artifact does not match the pinned manifest");
	}
}

export class ChatGptWebRuntimeLifecycle {
	readonly mode: ChatGptWebMode;
	readonly #dependencies: ChatGptWebRuntimeDependencies;
	#epoch?: ChatGptWebRuntimeEpoch;
	#state: ChatGptWebRuntimeHealth["state"] = "stopped";
	#activeTunnel?: ActiveTunnel;
	#activeAttempt?: AbortController;
	#command?: RuntimeCommand;
	#endpoint?: OmpBrokerEndpoint;
	#restartCount = 0;
	#transition: Promise<void> = Promise.resolve();
	readonly #controlSequences = new WeakMap<object, { nonce: string; sequence: number }>();

	constructor(dependencies: ChatGptWebRuntimeDependencies) {
		if (dependencies.controlToken.length < 32) throw new Error("Lifecycle control token is invalid");
		if (dependencies.mode === "full" && (!dependencies.full || !dependencies.full.connectionProfile)) {
			throw new Error("Full mode requires verified tunnel dependencies and credentials");
		}
		if (dependencies.mode === "browser-only" && dependencies.full) {
			throw new Error("Browser-only mode rejects full-mode tunnel dependencies");
		}
		if (dependencies.full) validateInstalledTunnelArtifact(dependencies.full.artifact);
		if (dependencies.full && dependencies.full.processHost.supportsOwnedTreeAsync !== true) {
			throw new Error("Full mode requires asynchronous owned process-tree control");
		}
		this.mode = dependencies.mode;
		this.#dependencies = dependencies;
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#transition.then(operation, operation);
		this.#transition = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async start(): Promise<ChatGptWebRuntimeHealth> {
		return this.#enqueue(async () => {
			if (this.#state !== "stopped") throw new Error("Runtime has already started");
			await this.#startFreshEpoch();
			return this.health();
		});
	}

	health(): ChatGptWebRuntimeHealth {
		if (!this.#epoch) throw new Error("Runtime has not established an epoch");
		return Object.freeze({
			mode: this.mode,
			state: this.#state,
			runtimeEpoch: this.#epoch.runtimeEpoch,
			lifecycleGeneration: this.#epoch.lifecycleGeneration,
			tunnelReady: this.#state === "running" && this.#activeTunnel !== undefined,
		});
	}
	/** Returns the epoch currently owned by this lifecycle while it is starting or running. */
	currentEpoch(): ChatGptWebRuntimeEpoch {
		if (!this.#epoch || (this.#state !== "starting" && this.#state !== "running")) {
			throw new Error("Runtime has no active epoch");
		}
		return this.#epoch;
	}

	async #startFreshEpoch(previous?: RuntimeEpochIdentity): Promise<void> {
		this.#state = "starting";
		let epoch: ChatGptWebRuntimeEpoch;
		try {
			epoch = await this.#dependencies.epochFactory.create(this.mode);
		} catch (error) {
			this.#state = previous ? "drained" : "stopped";
			throw error;
		}
		this.#epoch = epoch;
		try {
			validateEpochIdentity(epoch);
			if (
				previous &&
				(epoch.runtimeEpoch === previous.runtimeEpoch || epoch.lifecycleGeneration <= previous.lifecycleGeneration)
			) {
				throw new Error("Resume did not create a fresh runtime epoch");
			}
			if (this.mode === "browser-only") {
				if (epoch.broker || epoch.runtimeKey) throw new Error("Browser-only epoch created full-mode state");
				this.#state = "running";
				return;
			}
			const full = this.#dependencies.full;
			if (!full || !epoch.broker || !epoch.runtimeKey) {
				throw new Error("Full mode epoch is missing broker or runtime-key state");
			}
			const listening = await epoch.broker.listen();
			if (
				listening.endpoint.kind !== "owner-local" ||
				listening.runtimeEpoch !== epoch.runtimeEpoch ||
				listening.lifecycleGeneration !== epoch.lifecycleGeneration
			) {
				throw new Error("Broker listen identity does not match the runtime epoch");
			}
			this.#endpoint = listening.endpoint;
			this.#command = await resolveRuntimeCommand({ mode: "full" }, full.runtimeCommandHost);
			await this.#startTunnel(listening.endpoint);
			this.#state = "running";
		} catch (error) {
			await this.#drainEpochAfterFailure(error);
		}
	}

	async #startTunnel(endpoint: OmpBrokerEndpoint): Promise<void> {
		const epoch = this.#epoch;
		const full = this.#dependencies.full;
		const command = this.#command;
		const environmentHost = epoch?.environmentHost ?? full?.environmentHost;
		if (!epoch?.broker || !epoch.runtimeKey || !environmentHost || !full || !command) {
			throw new Error("Full runtime is incomplete");
		}
		const attempt = new AbortController();
		this.#activeAttempt = attempt;
		let process: NativeOwnedProcess | undefined;
		let admission: ChatGptWebRuntimeAdmission | undefined;
		let spawnEnvironment: PreparedTunnelSpawnEnvironment | undefined;
		let prepared: OmpPreparedTunnelSpawn | undefined;
		let processCleanupFailed = false;
		try {
			prepared = await epoch.broker.prepareTunnelSpawn();
			admission = prepared.tunnelAdmission;
			const runtimeKey = await epoch.runtimeKey.duplicateForSpawn(epoch.runtimeEpoch, epoch.lifecycleGeneration);
			await full.installHost.assertLaunchIdentity(full.artifact);
			spawnEnvironment = await materializeTunnelSpawnEnvironment({
				runtimeKey,
				endpoint,
				connectorBootstrap: prepared.connectorBootstrap,
				tunnelBootstrap: prepared.tunnelBootstrap,
				runtimeEpoch: epoch.runtimeEpoch,
				lifecycleGeneration: epoch.lifecycleGeneration,
				native: environmentHost,
			});
			if (attempt.signal.aborted) throw new Error("Tunnel start was cancelled");
			process = await full.processHost.spawn({
				artifact: full.artifact,
				command,
				environment: spawnEnvironment.environment,
				tunnelBootstrap: prepared.tunnelBootstrap,
				profile: Object.freeze({ connection: full.connectionProfile }),
				signal: attempt.signal,
			});
			await epoch.broker.authorizeTunnel(prepared.connectorBootstrap, process.identity, admission);
			await Promise.all([
				process.waitReady(attempt.signal, full.readyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS),
				epoch.broker.waitForTunnelReady(
					process.identity,
					attempt.signal,
					full.readyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS,
				),
			]);
			if (attempt.signal.aborted) throw new Error("Tunnel start was cancelled");
			await spawnEnvironment.completeSpawnHandoff();
			await spawnEnvironment.close();
			spawnEnvironment = undefined;
			if (attempt.signal.aborted) throw new Error("Tunnel start was cancelled");
			this.#activeTunnel = { process, admission, connectorBootstrap: prepared.connectorBootstrap };
			process = undefined;
			admission = undefined;
		} catch (error) {
			const cleanupErrors: unknown[] = [error];
			if (spawnEnvironment) {
				try {
					await spawnEnvironment.close();
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			if (process) {
				try {
					await process.terminateOwnedTree(full.shutdownTimeoutMs ?? 15_000);
					await process.assertInactive();
				} catch (cleanupError) {
					processCleanupFailed = true;
					cleanupErrors.push(cleanupError);
					if (prepared && admission) {
						this.#activeTunnel = {
							process,
							admission,
							connectorBootstrap: prepared.connectorBootstrap,
						};
					}
				}
			}
			if (prepared && admission && !processCleanupFailed) {
				try {
					await epoch.broker.abortTunnelSpawn(prepared.connectorBootstrap, admission);
				} catch (cleanupError) {
					if (process) {
						this.#activeTunnel = {
							process,
							admission,
							connectorBootstrap: prepared.connectorBootstrap,
						};
					}
					cleanupErrors.push(cleanupError);
				}
			}
			throw cleanupErrors.length === 1 ? error : new AggregateError(cleanupErrors, "Tunnel start cleanup failed");
		} finally {
			this.#activeAttempt = undefined;
		}
	}

	async #stopTunnel(): Promise<void> {
		const active = this.#activeTunnel;
		if (!active) return;
		const epoch = this.#epoch;
		const full = this.#dependencies.full;
		if (!epoch?.broker || !full) throw new Error("Active tunnel is missing its shutdown capabilities");
		try {
			await active.process.terminateOwnedTree(full.shutdownTimeoutMs ?? 15_000);
			await active.process.assertInactive();
			if (!active.brokerCleanupComplete) {
				await epoch.broker.abortTunnelSpawn(active.connectorBootstrap, active.admission);
				active.brokerCleanupComplete = true;
			}
		} catch (error) {
			throw new AggregateError([error], "Tunnel shutdown failed");
		}
		this.#activeTunnel = undefined;
	}

	async #drainEpochAfterFailure(originalError: unknown): Promise<never> {
		const errors: unknown[] = [originalError];
		try {
			await this.#drainCurrentEpoch();
		} catch (drainError) {
			errors.push(drainError);
		}
		throw errors.length === 1 ? originalError : new AggregateError(errors, "Runtime startup and cleanup failed");
	}
	async #drainCurrentEpoch(): Promise<void> {
		const epoch = this.#epoch;
		if (!epoch) throw new Error("Runtime has no epoch to drain");
		this.#activeAttempt?.abort(new Error("Runtime draining"));
		const errors: unknown[] = [];
		const gateDrain = Promise.resolve()
			.then(() => epoch.gate.drain())
			.catch(error => {
				errors.push(error);
			});
		const awaitGateDrain = !epoch.broker;
		try {
			await epoch.cancelBrowserTurns();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.#stopTunnel();
		} catch (error) {
			errors.push(error);
		}
		if (epoch.broker) {
			try {
				await epoch.broker.drain();
				if (this.#activeTunnel) this.#activeTunnel.brokerCleanupComplete = true;
			} catch (error) {
				errors.push(error);
			}
		}
		if (awaitGateDrain) await gateDrain;
		if (epoch.broker) {
			try {
				await epoch.broker.close();
			} catch (error) {
				errors.push(error);
			}
		}
		if (epoch.runtimeKey) {
			try {
				await epoch.runtimeKey.close();
			} catch (error) {
				errors.push(error);
			}
		}
		const command = this.#command;
		this.#command = undefined;
		try {
			command?.close?.();
		} catch (error) {
			errors.push(error);
		}
		this.#state = "drained";
		if (errors.length > 0) throw new AggregateError(errors, "Runtime drain failed");
	}
	/** Stops the owned tunnel and closes the current epoch before the host is released. */
	async close(): Promise<void> {
		await this.#enqueue(async () => {
			if (this.#state === "stopped") return;
			if (this.#epoch && (this.#state === "running" || this.#state === "starting" || this.#activeTunnel)) {
				await this.#drainCurrentEpoch();
			}
			this.#state = "stopped";
		});
	}

	async dispatchControl(
		request: LifecycleControlRequest,
		peer: NativePeerConnection,
	): Promise<ChatGptWebRuntimeHealth> {
		if (
			Object.keys(request).sort().join(",") !==
			"action,connectionNonce,controlToken,lifecycleGeneration,runtimeEpoch,sequence"
		) {
			throw new Error("Invalid lifecycle control request fields");
		}
		if (!equalSecret(request.controlToken, this.#dependencies.controlToken))
			throw new Error("Lifecycle control authentication failed");
		if (request.connectionNonce.length < 16 || !Number.isSafeInteger(request.sequence) || request.sequence <= 0) {
			throw new Error("Invalid lifecycle control proof");
		}
		await this.#dependencies.peerHost.verifyControlPeer(peer, request.connectionNonce);
		const previousSequence = this.#controlSequences.get(peer);
		if (
			previousSequence &&
			(previousSequence.nonce !== request.connectionNonce || request.sequence <= previousSequence.sequence)
		) {
			throw new Error("Lifecycle control replay or cross-connection proof rejected");
		}
		this.#controlSequences.set(peer, { nonce: request.connectionNonce, sequence: request.sequence });
		if (request.action === "drain" || request.action === "restart" || request.action === "shutdown") {
			this.#activeAttempt?.abort(new Error(`Runtime ${request.action}`));
		}
		return this.#enqueue(async () => {
			const epoch = this.#epoch;
			if (
				!epoch ||
				request.runtimeEpoch !== epoch.runtimeEpoch ||
				request.lifecycleGeneration !== epoch.lifecycleGeneration
			) {
				throw new Error("Lifecycle control targets a stale runtime epoch");
			}
			switch (request.action) {
				case "cancel-browser-turns":
					if (this.#state !== "running") throw new Error("Runtime is not accepting browser controls");
					await epoch.cancelBrowserTurns();
					break;
				case "drain":
					if (this.#state === "running" || this.#state === "starting" || this.#activeTunnel)
						await this.#drainCurrentEpoch();
					else if (this.#state !== "drained") throw new Error("Runtime cannot be drained from its current state");
					break;
				case "restart": {
					if (this.mode !== "full") throw new Error("Browser-only mode rejects tunnel restart");
					if (this.#state !== "running") throw new Error("Only a running full runtime can restart its tunnel");
					const full = this.#dependencies.full;
					if (!full || this.#restartCount >= (full.restartLimit ?? 3))
						throw new Error("Tunnel restart budget exhausted");
					await this.#stopTunnel();
					this.#restartCount += 1;
					if (!this.#endpoint) throw new Error("Broker endpoint is unavailable during restart");
					await this.#startTunnel(this.#endpoint);
					break;
				}
				case "resume": {
					if (this.#state !== "drained") throw new Error("Only a drained runtime can resume");
					if (this.#activeTunnel) throw new Error("Runtime still has an active tunnel");
					const previous = { runtimeEpoch: epoch.runtimeEpoch, lifecycleGeneration: epoch.lifecycleGeneration };
					this.#restartCount = 0;
					await this.#startFreshEpoch(previous);
					break;
				}
				case "shutdown":
					if (this.#state === "running" || this.#state === "starting" || this.#activeTunnel)
						await this.#drainCurrentEpoch();
					if (this.#state !== "drained") throw new Error("Runtime cannot shut down from its current state");
					this.#state = "stopped";
					break;
				default:
					throw new Error("Unknown lifecycle control action");
			}
			return this.health();
		});
	}
}
