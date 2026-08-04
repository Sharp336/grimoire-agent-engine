import { createHash } from "node:crypto";
import path from "node:path";
import { CHATGPT_WEB_TUNNEL_ID_PATTERN, type ChatGptWebPaths, type ChatGptWebRuntimeConfig } from "../config";
import {
	createOmpTunnelProcessIdentity,
	type NativeLaunchEnvironment,
	type NativeProcessIdentityLike,
} from "../mcp/bootstrap";
import type {
	RuntimeCommandNativeHost,
	NativeVerifiedExecutable as RuntimeNativeVerifiedExecutable,
} from "../mcp/runtime-command";
import {
	type FullTunnelSpawnProfile,
	type InstalledTunnelArtifact,
	type NativeOwnedProcess,
	type NativeTunnelInstallHost,
	type NativeTunnelInstallTransaction,
	type NativeVerifiedTunnelExecutable,
	TUNNEL_ARTIFACTS,
	TUNNEL_VERSION,
	type TunnelArtifact,
	type TunnelConnectionProfile,
	type TunnelHttpClient,
	type TunnelHttpResponse,
	type TunnelProcessNativeHost,
} from "../mcp/tunnel";

const PACKAGE_NAME = "@oh-my-pi/pi-chatgpt-web" as const;
const PACKAGE_VERSION = "17.2.7" as const;
const PACKAGE_CLI_NAME = "chatgpt-web" as const;
const PACKAGE_CLI_RELATIVE_PATH = "app/cli.js" as const;
const PACKAGE_CLI_ARGV = Object.freeze(["mcp", "--broker-handoff"] as const);
const RUNTIME_BUNDLE_PLATFORM = process.platform;
const RUNTIME_BUNDLE_ARCH = process.arch;
const RUNTIME_BUNDLE_EXPECTED = Object.freeze({
	version: PACKAGE_VERSION,
	platform: RUNTIME_BUNDLE_PLATFORM,
	arch: RUNTIME_BUNDLE_ARCH,
});
const TUNNEL_PROFILE_NAME = "tunnel-profile.json";
const TUNNEL_INSTALL_LOCK_NAME = "tunnel-install.lock";
const TUNNEL_STAGING_NAME = "tunnel-client.staging";
const MAX_PATH_BYTES = 4_096;
const MAX_COMMAND_BYTES = 8_192;
const MAX_PROCESS_TIMEOUT_MS = 120_000;
const textEncoder = new TextEncoder();

type Awaitable<T> = T | Promise<T>;

interface NativeOwnedFileCapability {
	readonly identity: string;
	close(): Awaitable<void>;
}

interface NativeVerifiedExecutableCapability {
	readonly identity: string;
	readonly sha256: string;
	readonly version: string;
	close(): void;
}

interface NativeProcessExit {
	readonly exitCode?: number;
	readonly signal?: string;
}
interface NativeRuntimeBundleCapability {
	close(): void;
}

interface RuntimeBundleInspection {
	readonly checksums: Record<string, unknown>;
}

interface NativeOwnedProcessCapability {
	readonly identity: NativeProcessIdentityLike;
	wait(timeoutMs?: number | null): Promise<NativeProcessExit>;
	terminate(): Promise<void>;
	close(): void;
}

interface NativeTunnelModule {
	isProcessIdentityLive(pid: number, processStartIdentity: string): boolean;
	acquireOwnedFileLock(root: NativeOwnedFileCapability, name: string): NativeOwnedFileCapability;
	openOwnedChild(root: NativeOwnedFileCapability, name: string, directory?: boolean): NativeOwnedFileCapability | null;
	replaceOwnedFileAtomic(
		root: NativeOwnedFileCapability,
		name: string,
		bytes: Uint8Array,
		expectedIdentity: string | null,
	): NativeOwnedFileCapability;
	removeOwnedFileAtomic(root: NativeOwnedFileCapability, name: string, expectedIdentity: string): void;
	matchesOwnedChild(
		root: NativeOwnedFileCapability,
		name: string,
		expectedIdentity: string,
		directory?: boolean,
	): boolean;
	openRuntimeBundle(spec: {
		readonly root: string;
		readonly expected: { readonly version: string; readonly platform: string; readonly arch: string };
	}): NativeRuntimeBundleCapability;
	verifyRuntimeBundle(spec: {
		readonly bundle: NativeRuntimeBundleCapability;
		readonly expected: { readonly version: string; readonly platform: string; readonly arch: string };
	}): RuntimeBundleInspection;
	openVerifiedExecutable(spec: {
		readonly path: string;
		readonly sha256: string;
		readonly version: string;
	}): Promise<NativeVerifiedExecutableCapability>;
	openVerifiedExecutableMatching(
		spec: { readonly path: string; readonly sha256: string; readonly version: string },
		expectedIdentity: string,
	): Promise<NativeVerifiedExecutableCapability | null>;
	verifyExecutableVersion(
		executable: NativeVerifiedExecutableCapability,
		expected: string,
		timeoutMs?: number | null,
	): Promise<void>;
	launchVerifiedProcess(spec: {
		readonly executable: NativeVerifiedExecutableCapability;
		readonly args: string[];
		readonly environment: NativeLaunchEnvironment;
	}): Promise<NativeOwnedProcessCapability>;
}

interface TunnelExecutableDetails {
	readonly native: NativeVerifiedExecutableCapability;
}

interface RuntimeExecutableDetails {
	readonly native: NativeVerifiedExecutableCapability;
	readonly cliPath: string;
}

interface MaterializedProfile {
	readonly root: NativeOwnedFileCapability;
	readonly file: NativeOwnedFileCapability;
	readonly identity: string;
}

interface TunnelProfileDetails {
	readonly rootPath: string;
	readonly profilePath: string;
	readonly runtimeKeyPath: string;
	readonly cliPath: string;
	readonly commandArgv: readonly ["mcp", "--broker-handoff"];
	readonly bytes: Uint8Array;
	materialized?: MaterializedProfile;
}

const tunnelExecutableDetails = new WeakMap<NativeVerifiedTunnelExecutable, TunnelExecutableDetails>();
const runtimeExecutableDetails = new WeakMap<RuntimeNativeVerifiedExecutable, RuntimeExecutableDetails>();
const tunnelProfileDetails = new WeakMap<TunnelConnectionProfile, TunnelProfileDetails>();

function requireFunction(module: object, name: keyof NativeTunnelModule): void {
	if (typeof (module as Partial<NativeTunnelModule>)[name] !== "function") {
		throw new Error(`Native tunnel capability is unavailable: ${name}`);
	}
}

function requireCapabilities<K extends keyof NativeTunnelModule>(
	value: object,
	names: readonly K[],
): Pick<NativeTunnelModule, K> {
	for (const name of names) requireFunction(value, name);
	return value as Pick<NativeTunnelModule, K>;
}

function pathApi(value: string): typeof path.posix | typeof path.win32 {
	return path.win32.isAbsolute(value) ? path.win32 : path.posix;
}

function normalizedAbsolutePath(value: string, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value) > MAX_PATH_BYTES ||
		value.includes("\0") ||
		/[\r\n]/u.test(value) ||
		(!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))
	) {
		throw new Error(`${label} must be a bounded absolute path`);
	}
	const api = pathApi(value);
	const normalized = api.normalize(value);
	const root = api.parse(value).root;
	const provided = value.replace(/[\\/]+$/u, "") || root;
	const canonical = normalized.replace(/[\\/]+$/u, "") || api.parse(normalized).root;
	if (provided !== canonical) throw new Error(`${label} must already be normalized`);
	return normalized;
}

function fixedChildPath(root: string, name: string, label: string): string {
	const api = pathApi(root);
	const child = api.join(root, name);
	if (api.dirname(child) !== root) throw new Error(`${label} escapes its fixed root`);
	return child;
}

function fixedRelativePath(root: string, relative: string, label: string): string {
	if (
		relative.length === 0 ||
		Buffer.byteLength(relative) > MAX_PATH_BYTES ||
		relative.includes("\0") ||
		/[\r\n,]/u.test(relative) ||
		path.posix.isAbsolute(relative) ||
		path.win32.isAbsolute(relative) ||
		relative.split(/[\\/]+/u).some(segment => segment === "..")
	) {
		throw new Error(`${label} is not a safe fixed relative path`);
	}
	const api = pathApi(root);
	const child = api.join(root, ...relative.split("/"));
	const childRelative = api.relative(root, child);
	if (childRelative === "" || childRelative.startsWith(`..${api.sep}`) || api.isAbsolute(childRelative)) {
		throw new Error(`${label} escapes its fixed root`);
	}
	return child;
}

function assertOwnedFile(value: unknown, label: string): NativeOwnedFileCapability {
	if (
		!value ||
		typeof value !== "object" ||
		typeof (value as NativeOwnedFileCapability).identity !== "string" ||
		(value as NativeOwnedFileCapability).identity === "" ||
		typeof (value as NativeOwnedFileCapability).close !== "function"
	) {
		throw new Error(`Native ${label} capability is invalid`);
	}
	return value as NativeOwnedFileCapability;
}

function assertVerifiedExecutable(value: unknown, label: string): NativeVerifiedExecutableCapability {
	if (
		!value ||
		typeof value !== "object" ||
		typeof (value as NativeVerifiedExecutableCapability).identity !== "string" ||
		(value as NativeVerifiedExecutableCapability).identity === "" ||
		!/^[a-f0-9]{64}$/u.test((value as NativeVerifiedExecutableCapability).sha256) ||
		typeof (value as NativeVerifiedExecutableCapability).version !== "string" ||
		typeof (value as NativeVerifiedExecutableCapability).close !== "function"
	) {
		throw new Error(`Native ${label} executable capability is invalid`);
	}
	return value as NativeVerifiedExecutableCapability;
}
function assertRuntimeBundle(value: unknown): NativeRuntimeBundleCapability {
	if (!value || typeof value !== "object" || typeof (value as NativeRuntimeBundleCapability).close !== "function") {
		throw new Error("Native runtime bundle capability is invalid");
	}
	return value as NativeRuntimeBundleCapability;
}

function runtimeCliDigest(inspection: RuntimeBundleInspection): string {
	const files = inspection.checksums.files;
	const digest =
		files && typeof files === "object" && !Array.isArray(files)
			? (files as Record<string, unknown>)[PACKAGE_CLI_RELATIVE_PATH]
			: undefined;
	if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
		throw new Error("Runtime bundle CLI checksum is missing");
	}
	return digest;
}

function assertNativeProcess(value: unknown): NativeOwnedProcessCapability {
	if (!value || typeof value !== "object") throw new Error("Native tunnel process capability is invalid");
	const process = value as NativeOwnedProcessCapability;
	const identity = process.identity;
	if (
		!identity ||
		!Number.isSafeInteger(identity.pid) ||
		identity.pid <= 0 ||
		typeof identity.processStartIdentity !== "string" ||
		identity.processStartIdentity === "" ||
		typeof identity.executableIdentity !== "string" ||
		identity.executableIdentity === "" ||
		typeof process.wait !== "function" ||
		typeof process.terminate !== "function" ||
		typeof process.close !== "function"
	) {
		throw new Error("Native tunnel process capability is invalid");
	}
	return process;
}

async function closeCapability(capability: NativeOwnedFileCapability | undefined): Promise<void> {
	if (capability) await capability.close();
}

function processTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PROCESS_TIMEOUT_MS) {
		throw new Error("Native tunnel process timeout is out of range");
	}
	return value;
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error("Tunnel process start was aborted");
}

function quoteTunnelCommandArgument(value: string): string {
	if (
		value.length === 0 ||
		Buffer.byteLength(value) > MAX_PATH_BYTES ||
		value.includes("\0") ||
		/[,\r\n]/u.test(value)
	) {
		throw new Error("Tunnel MCP command argument is invalid");
	}
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function encodeTunnelProfile(details: {
	readonly tunnelId: string;
	readonly runtimeKeyPath: string;
	readonly command: readonly string[];
}): Uint8Array {
	const command = details.command.map(quoteTunnelCommandArgument).join(" ");
	if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error("Tunnel MCP command is too long");
	return textEncoder.encode(
		`${JSON.stringify({
			config_version: 1,
			control_plane: {
				tunnel_id: details.tunnelId,
				api_key: `file:${details.runtimeKeyPath}`,
			},
			health: { listen_addr: "127.0.0.1:0" },
			admin_ui: { open_browser: false },
			mcp: {
				commands: [{ channel: "main", command }],
			},
		})}\n`,
	);
}

function verifiedNativeVersion(binarySha256: string): string {
	return `sha256:${binarySha256}`;
}

function wrapTunnelExecutable(native: NativeVerifiedExecutableCapability): NativeVerifiedTunnelExecutable {
	let closed = false;
	const wrapped = Object.freeze({
		identity: native.identity,
		close(): void {
			if (closed) return;
			closed = true;
			native.close();
		},
		__nativeVerifiedTunnelExecutable: Symbol("native-verified-tunnel-executable"),
	});
	tunnelExecutableDetails.set(wrapped, { native });
	return wrapped;
}

function requireTunnelExecutable(executable: NativeVerifiedTunnelExecutable): NativeVerifiedExecutableCapability {
	const details = tunnelExecutableDetails.get(executable);
	if (!details || details.native.identity !== executable.identity) {
		throw new Error("Tunnel executable was not created by the native tunnel adapter");
	}
	return details.native;
}

function requireProfile(profile: TunnelConnectionProfile): TunnelProfileDetails {
	const details = tunnelProfileDetails.get(profile);
	if (!details) throw new Error("Tunnel profile was not created by the native tunnel adapter");
	return details;
}

export function createNativeTunnelInstallHost(
	value: object,
	rootValue: NativeOwnedFileCapability,
	rootPathValue: string,
): NativeTunnelInstallHost {
	const native = requireCapabilities(value, [
		"acquireOwnedFileLock",
		"matchesOwnedChild",
		"openOwnedChild",
		"openVerifiedExecutableMatching",
		"removeOwnedFileAtomic",
		"replaceOwnedFileAtomic",
		"verifyExecutableVersion",
	] as const);
	const root = assertOwnedFile(rootValue, "tunnel install root");
	const rootPath = normalizedAbsolutePath(rootPathValue, "Tunnel install root");

	return Object.freeze({
		async beginInstall(executableName: TunnelArtifact["executableName"]): Promise<NativeTunnelInstallTransaction> {
			if (executableName !== "tunnel-client" && executableName !== "tunnel-client.exe") {
				throw new Error("Tunnel executable name is not fixed by the pinned manifest");
			}
			const executablePath = fixedChildPath(rootPath, executableName, "Tunnel executable");
			const stagingPath = fixedChildPath(rootPath, TUNNEL_STAGING_NAME, "Tunnel staging executable");
			const lock = assertOwnedFile(
				native.acquireOwnedFileLock(root, TUNNEL_INSTALL_LOCK_NAME),
				"tunnel install lock",
			);
			let state: "open" | "written" | "verified" | "committed" | "rolled-back" = "open";
			let bytes: Uint8Array | undefined;
			let stagingFile: NativeOwnedFileCapability | undefined;
			let stagingExecutable: NativeVerifiedExecutableCapability | undefined;
			let committedIdentity: string | undefined;
			let committedExecutable: NativeVerifiedExecutableCapability | undefined;

			const removeStaging = async (): Promise<void> => {
				if (!stagingFile) return;
				const current = stagingFile;
				stagingFile = undefined;
				try {
					native.removeOwnedFileAtomic(root, TUNNEL_STAGING_NAME, current.identity);
				} finally {
					await current.close();
				}
			};
			const closeTransactionCapabilities = async (): Promise<void> => {
				const errors: unknown[] = [];
				if (stagingExecutable) {
					try {
						stagingExecutable.close();
					} catch (error) {
						errors.push(error);
					}
					stagingExecutable = undefined;
				}
				try {
					await removeStaging();
				} catch (error) {
					errors.push(error);
				}
				try {
					await lock.close();
				} catch (error) {
					errors.push(error);
				}
				bytes = undefined;
				if (errors.length > 0) throw new AggregateError(errors, "Native tunnel install cleanup failed");
			};

			return Object.freeze({
				async writeExecutable(input: Uint8Array): Promise<void> {
					if (state !== "open") throw new Error("Tunnel install transaction is not writable");
					if (!(input instanceof Uint8Array) || input.byteLength === 0) {
						throw new Error("Tunnel executable bytes are invalid");
					}
					bytes = input.slice();
					let previous: NativeOwnedFileCapability | null = null;
					try {
						previous = native.openOwnedChild(root, TUNNEL_STAGING_NAME, false);
						if (previous) assertOwnedFile(previous, "existing tunnel staging file");
						stagingFile = assertOwnedFile(
							native.replaceOwnedFileAtomic(root, TUNNEL_STAGING_NAME, bytes, previous?.identity ?? null),
							"tunnel staging file",
						);
						state = "written";
					} finally {
						await closeCapability(previous ?? undefined);
					}
				},
				async verifyBinaryVersion(expected: string): Promise<void> {
					if (state !== "written" || !bytes || !stagingFile) {
						throw new Error("Tunnel executable must be written before version verification");
					}
					if (expected !== TUNNEL_VERSION) throw new Error("Tunnel binary version is not pinned");
					const binarySha256 = createHash("sha256").update(bytes).digest("hex");
					const executable = await native.openVerifiedExecutableMatching(
						{ path: stagingPath, sha256: binarySha256, version: verifiedNativeVersion(binarySha256) },
						stagingFile.identity,
					);
					stagingExecutable = assertVerifiedExecutable(executable, "staged tunnel");
					await native.verifyExecutableVersion(stagingExecutable, expected);
					state = "verified";
				},
				async commit(
					request: Parameters<NativeTunnelInstallTransaction["commit"]>[0],
				): Promise<InstalledTunnelArtifact> {
					if (state !== "verified" || !bytes || !stagingFile || !stagingExecutable) {
						throw new Error("Tunnel executable must be verified before commit");
					}
					if (!Object.hasOwn(TUNNEL_ARTIFACTS, request.tuple))
						throw new Error("Tunnel artifact tuple is unsupported");
					const expected = TUNNEL_ARTIFACTS[request.tuple];
					if (
						request.archiveSha256 !== expected.sha256 ||
						expected.executableName !== executableName ||
						request.binaryVersion !== expected.binaryVersion ||
						request.binarySha256 !== stagingExecutable.sha256
					) {
						throw new Error("Tunnel commit identity does not match the verified staging executable");
					}
					let previous: NativeOwnedFileCapability | null = null;
					let published: NativeOwnedFileCapability | undefined;
					try {
						previous = native.openOwnedChild(root, executableName, false);
						if (previous) assertOwnedFile(previous, "existing tunnel executable");
						published = assertOwnedFile(
							native.replaceOwnedFileAtomic(root, executableName, bytes, previous?.identity ?? null),
							"installed tunnel executable",
						);
						const executable = await native.openVerifiedExecutableMatching(
							{
								path: executablePath,
								sha256: request.binarySha256,
								version: verifiedNativeVersion(request.binarySha256),
							},
							published.identity,
						);
						committedExecutable = assertVerifiedExecutable(executable, "installed tunnel");
						await native.verifyExecutableVersion(committedExecutable, request.binaryVersion);
						committedIdentity = published.identity;
						state = "committed";
						const wrapped = wrapTunnelExecutable(committedExecutable);
						await closeTransactionCapabilities();
						return Object.freeze({
							tuple: request.tuple,
							archiveSha256: request.archiveSha256,
							binarySha256: request.binarySha256,
							binaryVersion: request.binaryVersion,
							fileIdentity: committedIdentity,
							executable: wrapped,
							__installedTunnelArtifact: Symbol("installed-tunnel-artifact"),
						});
					} catch (error) {
						const errors: unknown[] = [error];
						if (published) {
							try {
								native.removeOwnedFileAtomic(root, executableName, published.identity);
							} catch (cleanupError) {
								errors.push(cleanupError);
							}
						}
						if (committedExecutable) {
							try {
								committedExecutable.close();
							} catch (cleanupError) {
								errors.push(cleanupError);
							}
							committedExecutable = undefined;
						}
						try {
							await closeTransactionCapabilities();
						} catch (cleanupError) {
							errors.push(cleanupError);
						}
						state = "rolled-back";
						throw errors.length === 1 ? error : new AggregateError(errors, "Tunnel commit cleanup failed");
					} finally {
						await closeCapability(previous ?? undefined);
						await closeCapability(published);
					}
				},
				async rollback(): Promise<void> {
					if (state === "rolled-back") return;
					const errors: unknown[] = [];
					if (state === "committed" && committedIdentity) {
						try {
							native.removeOwnedFileAtomic(root, executableName, committedIdentity);
						} catch (error) {
							errors.push(error);
						}
						if (committedExecutable) {
							try {
								committedExecutable.close();
							} catch (error) {
								errors.push(error);
							}
							committedExecutable = undefined;
						}
					}
					try {
						await closeTransactionCapabilities();
					} catch (error) {
						errors.push(error);
					}
					state = "rolled-back";
					if (errors.length > 0) throw new AggregateError(errors, "Tunnel install rollback failed");
				},
			});
		},
		async assertLaunchIdentity(artifact: InstalledTunnelArtifact): Promise<void> {
			if (!Object.hasOwn(TUNNEL_ARTIFACTS, artifact.tuple)) throw new Error("Tunnel artifact tuple is unsupported");
			const expected = TUNNEL_ARTIFACTS[artifact.tuple];
			if (
				artifact.archiveSha256 !== expected.sha256 ||
				artifact.binaryVersion !== expected.binaryVersion ||
				artifact.executable.identity !== artifact.fileIdentity ||
				!/^[a-f0-9]{64}$/u.test(artifact.binarySha256)
			) {
				throw new Error("Installed tunnel artifact does not match the pinned manifest");
			}
			const nativeExecutable = requireTunnelExecutable(artifact.executable);
			if (
				nativeExecutable.identity !== artifact.fileIdentity ||
				nativeExecutable.sha256 !== artifact.binarySha256 ||
				!native.matchesOwnedChild(root, expected.executableName, artifact.fileIdentity, false)
			) {
				throw new Error("Installed tunnel executable identity changed");
			}
			const confirmation = await native.openVerifiedExecutableMatching(
				{
					path: fixedChildPath(rootPath, expected.executableName, "Tunnel executable"),
					sha256: artifact.binarySha256,
					version: verifiedNativeVersion(artifact.binarySha256),
				},
				artifact.fileIdentity,
			);
			const executable = assertVerifiedExecutable(confirmation, "launch tunnel");
			try {
				await native.verifyExecutableVersion(executable, artifact.binaryVersion);
			} finally {
				executable.close();
			}
		},
	});
}

export function createTunnelConnectionProfile(
	config: ChatGptWebRuntimeConfig,
	paths: ChatGptWebPaths,
	bundleRootValue: string,
): TunnelConnectionProfile {
	if (config.mode !== "full" || !config.runtimeKeyConfigured || !config.tunnelId) {
		throw new Error("A full-mode tunnel profile requires configured runtime credentials");
	}
	if (!CHATGPT_WEB_TUNNEL_ID_PATTERN.test(config.tunnelId)) throw new Error("Tunnel identifier is invalid");
	const rootPath = normalizedAbsolutePath(paths.root, "ChatGPT Web root");
	const runtimeKeyPath = normalizedAbsolutePath(paths.runtimeKey, "Tunnel runtime-key path");
	if (runtimeKeyPath !== fixedChildPath(rootPath, "runtime-key", "Tunnel runtime-key")) {
		throw new Error("Tunnel runtime-key path is outside the fixed ChatGPT Web root");
	}
	const bundleRoot = normalizedAbsolutePath(bundleRootValue, "Runtime bundle root");
	const cliPath = fixedRelativePath(bundleRoot, PACKAGE_CLI_RELATIVE_PATH, "Runtime package CLI");
	const profilePath = fixedChildPath(rootPath, TUNNEL_PROFILE_NAME, "Tunnel profile");
	const bytes = encodeTunnelProfile({
		tunnelId: config.tunnelId,
		runtimeKeyPath,
		command: [cliPath, ...PACKAGE_CLI_ARGV],
	});
	const profile = Object.freeze({ __tunnelConnectionProfile: Symbol("tunnel-connection-profile") });
	tunnelProfileDetails.set(profile, {
		rootPath,
		profilePath,
		runtimeKeyPath,
		cliPath,
		commandArgv: PACKAGE_CLI_ARGV,
		bytes,
	});
	return profile;
}

export interface NativeTunnelProfileWriter {
	write(profile: TunnelConnectionProfile): Promise<void>;
	close(): Promise<void>;
}

export function createTunnelProfileWriter(
	value: object,
	rootValue: NativeOwnedFileCapability,
	rootPathValue: string,
): NativeTunnelProfileWriter {
	const native = requireCapabilities(value, [
		"matchesOwnedChild",
		"openOwnedChild",
		"removeOwnedFileAtomic",
		"replaceOwnedFileAtomic",
	] as const);
	const root = assertOwnedFile(rootValue, "tunnel profile root");
	const rootPath = normalizedAbsolutePath(rootPathValue, "Tunnel profile root");
	const retained = new Set<TunnelProfileDetails>();
	let closed = false;
	return Object.freeze({
		async write(profile: TunnelConnectionProfile): Promise<void> {
			if (closed) throw new Error("Tunnel profile writer is closed");
			const details = requireProfile(profile);
			if (details.rootPath !== rootPath) throw new Error("Tunnel profile root does not match its writer");
			let previous: NativeOwnedFileCapability | null = null;
			let replacement: NativeOwnedFileCapability | undefined;
			try {
				previous = native.openOwnedChild(root, TUNNEL_PROFILE_NAME, false);
				if (previous) assertOwnedFile(previous, "existing tunnel profile");
				replacement = assertOwnedFile(
					native.replaceOwnedFileAtomic(root, TUNNEL_PROFILE_NAME, details.bytes, previous?.identity ?? null),
					"tunnel profile",
				);
				if (!native.matchesOwnedChild(root, TUNNEL_PROFILE_NAME, replacement.identity, false)) {
					throw new Error("Materialized tunnel profile identity changed");
				}
				const prior = details.materialized;
				const materialized = { root, file: replacement, identity: replacement.identity };
				details.materialized = materialized;
				retained.add(details);
				replacement = undefined;
				if (prior) await prior.file.close();
			} catch (error) {
				if (!replacement) throw error;
				try {
					native.removeOwnedFileAtomic(root, TUNNEL_PROFILE_NAME, replacement.identity);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Tunnel profile materialization cleanup failed");
				}
				throw error;
			} finally {
				await closeCapability(previous ?? undefined);
				await closeCapability(replacement);
			}
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			const entries = [...retained];
			const results = await Promise.allSettled(entries.map(entry => entry.materialized?.file.close()));
			for (const entry of entries) entry.materialized = undefined;
			retained.clear();
			const errors = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length > 0) throw new AggregateError(errors, "Tunnel profile writer cleanup failed");
		},
	});
}
export function createNativeRuntimeCommandHost(value: object, bundleRootValue?: string): RuntimeCommandNativeHost {
	const native = requireCapabilities(value, [
		"openRuntimeBundle",
		"verifyRuntimeBundle",
		"openVerifiedExecutable",
	] as const);
	const bundleRoot = normalizedAbsolutePath(
		bundleRootValue ?? path.resolve(import.meta.dir, "../.."),
		"Runtime bundle root",
	);
	return Object.freeze({
		async openVerifiedPackageCli(
			request: Parameters<RuntimeCommandNativeHost["openVerifiedPackageCli"]>[0],
		): Promise<RuntimeNativeVerifiedExecutable> {
			if (
				request.packageName !== PACKAGE_NAME ||
				request.packageVersion !== PACKAGE_VERSION ||
				request.cliName !== PACKAGE_CLI_NAME ||
				request.cliRelativePath !== PACKAGE_CLI_RELATIVE_PATH
			) {
				throw new Error("Runtime package CLI request does not match this package");
			}
			const expected = RUNTIME_BUNDLE_EXPECTED;
			const bundle = assertRuntimeBundle(native.openRuntimeBundle({ root: bundleRoot, expected }));
			try {
				const inspection = native.verifyRuntimeBundle({ bundle, expected });
				const cliPath = fixedRelativePath(bundleRoot, PACKAGE_CLI_RELATIVE_PATH, "Runtime package CLI");
				const executable = assertVerifiedExecutable(
					await native.openVerifiedExecutable({
						path: cliPath,
						sha256: runtimeCliDigest(inspection),
						version: PACKAGE_VERSION,
					}),
					"runtime package CLI",
				);
				let closed = false;
				const wrapped = Object.freeze({
					identity: executable.identity,
					packageName: PACKAGE_NAME,
					packageVersion: PACKAGE_VERSION,
					cliName: PACKAGE_CLI_NAME,
					close(): void {
						if (closed) return;
						closed = true;
						executable.close();
					},
					__nativeVerifiedExecutable: Symbol("native-verified-runtime-package-cli"),
				});
				runtimeExecutableDetails.set(wrapped, { native: executable, cliPath });
				return wrapped;
			} finally {
				bundle.close();
			}
		},
	});
}

class NativeTunnelProcess implements NativeOwnedProcess {
	readonly identity;
	readonly #native: NativeOwnedProcessCapability;
	readonly #isIdentityLive: NativeTunnelModule["isProcessIdentityLive"];
	#inactive = false;
	#closed = false;

	constructor(native: NativeOwnedProcessCapability, isIdentityLive: NativeTunnelModule["isProcessIdentityLive"]) {
		this.#native = native;
		this.#isIdentityLive = isIdentityLive;
		this.identity = createOmpTunnelProcessIdentity(native.identity);
	}

	async waitReady(signal: AbortSignal, timeoutMs: number): Promise<void> {
		processTimeout(timeoutMs);
		throwIfAborted(signal);
		await this.#native.wait(0);
		throwIfAborted(signal);
		if (this.#isIdentityLive(this.identity.pid, this.identity.processStartIdentity) !== true) {
			this.#inactive = true;
			this.#close();
			throw new Error("Tunnel process exited before readiness");
		}
	}

	async terminateOwnedTree(timeoutMs: number): Promise<void> {
		if (this.#inactive) return;
		const timeout = processTimeout(timeoutMs);
		await this.#native.terminate();
		await this.#native.wait(timeout);
		if (this.#isIdentityLive(this.identity.pid, this.identity.processStartIdentity) !== false) {
			throw new Error("Native tunnel process tree did not terminate within its deadline");
		}
		this.#inactive = true;
		this.#close();
	}

	async assertInactive(): Promise<void> {
		if (this.#inactive) return;
		await this.#native.wait(0);
		if (this.#isIdentityLive(this.identity.pid, this.identity.processStartIdentity) !== false) {
			throw new Error("Native tunnel process remains active");
		}
		this.#inactive = true;
		this.#close();
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#native.close();
	}
}

async function cleanupSpawnedProcess(
	process: NativeOwnedProcessCapability,
	isIdentityLive: NativeTunnelModule["isProcessIdentityLive"],
): Promise<void> {
	const errors: unknown[] = [];
	try {
		await process.terminate();
	} catch (error) {
		errors.push(error);
	}
	try {
		await process.wait(15_000);
		if (isIdentityLive(process.identity.pid, process.identity.processStartIdentity) !== false) {
			errors.push(new Error("Tunnel process cleanup timed out"));
		}
	} catch (error) {
		errors.push(error);
	}
	try {
		process.close();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) throw new AggregateError(errors, "Tunnel process spawn cleanup failed");
}

function validateSpawnProfile(profile: FullTunnelSpawnProfile): TunnelProfileDetails {
	if (!profile || typeof profile !== "object" || !profile.connection) {
		throw new Error("Tunnel spawn profile is invalid");
	}
	return requireProfile(profile.connection);
}

export function createNativeTunnelProcessHost(value: object): TunnelProcessNativeHost {
	const native = requireCapabilities(value, [
		"isProcessIdentityLive",
		"launchVerifiedProcess",
		"matchesOwnedChild",
	] as const);
	return Object.freeze({
		supportsOwnedTreeAsync: true as const,
		async spawn(request: Parameters<TunnelProcessNativeHost["spawn"]>[0]): Promise<NativeOwnedProcess> {
			throwIfAborted(request.signal);
			const profile = validateSpawnProfile(request.profile);
			const materialized = profile.materialized;
			if (
				!materialized ||
				materialized.file.identity !== materialized.identity ||
				!native.matchesOwnedChild(materialized.root, TUNNEL_PROFILE_NAME, materialized.identity, false)
			) {
				throw new Error("Tunnel profile is not materialized with its retained native identity");
			}
			const runtime = runtimeExecutableDetails.get(request.command.executable);
			if (
				!runtime ||
				runtime.native.identity !== request.command.executable.identity ||
				runtime.cliPath !== profile.cliPath ||
				request.command.command !== PACKAGE_CLI_NAME ||
				request.command.mode !== "full" ||
				request.command.argv.length !== PACKAGE_CLI_ARGV.length ||
				!request.command.argv.every((argument, index) => argument === PACKAGE_CLI_ARGV[index])
			) {
				throw new Error("Tunnel MCP command does not match the materialized package profile");
			}
			const executable = requireTunnelExecutable(request.artifact.executable);
			if (
				executable.identity !== request.artifact.fileIdentity ||
				executable.sha256 !== request.artifact.binarySha256
			) {
				throw new Error("Tunnel launch executable does not match the installed artifact");
			}
			let owned: NativeOwnedProcessCapability | undefined;
			try {
				owned = assertNativeProcess(
					await native.launchVerifiedProcess({
						executable,
						args: ["run", "--profile-file", profile.profilePath],
						environment: request.environment,
					}),
				);
				throwIfAborted(request.signal);
				if (owned.identity.executableIdentity !== executable.identity) {
					throw new Error("Native tunnel process executable identity does not match its launch capability");
				}
				return new NativeTunnelProcess(owned, native.isProcessIdentityLive);
			} catch (error) {
				if (!owned) throw error;
				try {
					await cleanupSpawnedProcess(owned, native.isProcessIdentityLive);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Tunnel process launch and cleanup both failed");
				}
				throw error;
			}
		},
	});
}

export function createFetchTunnelHttpClient(fetchImpl: typeof fetch = globalThis.fetch): TunnelHttpClient {
	if (typeof fetchImpl !== "function") throw new Error("Tunnel fetch implementation is unavailable");
	return Object.freeze({
		async request(
			url: Parameters<TunnelHttpClient["request"]>[0],
			options: Parameters<TunnelHttpClient["request"]>[1],
		): Promise<TunnelHttpResponse> {
			if (!(url instanceof URL) || options.redirect !== "manual") throw new Error("Tunnel HTTP request is invalid");
			const controller = new AbortController();
			const abort = (): void => controller.abort(options.signal.reason);
			if (options.signal.aborted) abort();
			else options.signal.addEventListener("abort", abort, { once: true });
			let response: Response;
			try {
				response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal });
			} catch (error) {
				options.signal.removeEventListener("abort", abort);
				throw error;
			}
			const stream = response.body;
			let finished = false;
			const finish = (): void => {
				if (finished) return;
				finished = true;
				options.signal.removeEventListener("abort", abort);
			};
			const body = (async function* (): AsyncGenerator<Uint8Array> {
				if (!stream) {
					finish();
					return;
				}
				const reader = stream.getReader();
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) return;
						if (!(chunk.value instanceof Uint8Array))
							throw new Error("Tunnel HTTP response returned invalid bytes");
						yield chunk.value;
					}
				} finally {
					reader.releaseLock();
					finish();
				}
			})();
			return Object.freeze({
				status: response.status,
				headers: Object.freeze(Object.fromEntries(response.headers.entries())),
				body,
				cancel(): void {
					controller.abort(new Error("Tunnel HTTP response was cancelled"));
					finish();
				},
			});
		},
	});
}
