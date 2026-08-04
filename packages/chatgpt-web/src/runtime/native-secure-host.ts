import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { Locator } from "playwright-core";
import {
	type BrowserLoginRequest,
	type ChromeDiscoveryEnvironment,
	chromeExecutableCandidates,
	type InteractiveLoginProcess,
	LocalLoginHost,
	type LoginBrowserDriver,
	type LoginHost,
	type VerificationBrowserContext,
	type VerifiedLoginExecutable,
} from "../browser/login-host";
import {
	type ChatGptWebExecutableIdentity,
	type ChatGptWebOwnershipRecord,
	type ChatGptWebPaths,
	type ChatGptWebProcessIdentity,
	type ChatGptWebRuntimeConfig,
	type ChatGptWebStateName,
	decodeJson,
	encodeJson,
	parseChatGptWebOwnership,
	parseChatGptWebVerificationMarker,
	resolveChatGptWebPaths,
	type SecureConfigHost,
	type SecureEntryKind,
	type SecureEntryReference,
	type SecureStateSession,
} from "../config";
import type { ChatGptWebRuntimeGate } from "../provider/types";
import type { BrowserHost } from "./host";
import {
	connectLocalBrowserPipe,
	createLocalBrowserHost,
	type LocalBrowserConnection,
	type LocalBrowserLeaseBinding,
	type NativeOwnedBrowserProcessLike,
	openLocalTemporaryChat,
	type SecureBrowserRuntimeAuthority,
	type SecureStagedAttachment,
	verifyLocalBrowserContext,
} from "./local-host";

const MAX_SECURE_STATE_BYTES = 1024 * 1024;
const STATE_NAMES: readonly ChatGptWebStateName[] = [
	"config.json",
	"control-token",
	"runtime-key",
	"verification.json",
];

interface NativeOwnedFile {
	readonly identity: string;
	readonly directory: boolean;
	read(): Uint8Array;
	consume(): void;
	cleanup(): void;
	close(): void;
}

interface NativeOwnedFileConstructor {
	createPrivate(root: NativeOwnedFile, nameHint: string, bytes: Uint8Array): NativeOwnedFile;
}

interface NativeVerifiedExecutable {
	readonly identity: string;
	readonly sha256: string;
	readonly version: string;
	close(): void;
}

interface NativeBrowserPipe {
	read(): Promise<Uint8Array>;
	write(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

interface NativeOwnedProcess {
	wait(timeoutMs?: number): Promise<{ readonly exitCode?: number; readonly signal?: string }>;
	terminate(): Promise<void>;
	close(): void;
}

interface NativeOwnedBrowserProcess {
	readonly process: NativeOwnedProcess;
	readonly pipe: NativeBrowserPipe;
}

interface NativeLaunchEnvironment {}

interface NativeLaunchEnvironmentConstructor {
	browserChild(profileRoot: NativeOwnedFile, profileGeneration: string, ownerFence: string): NativeLaunchEnvironment;
}

interface NativeSecureHostModule {
	NativeOwnedFile?: NativeOwnedFileConstructor;
	NativeLaunchEnvironment?: NativeLaunchEnvironmentConstructor;
	createChatGptWebSecureConfigHost?: () => SecureConfigHost;
	createChatGptWebLoginHost?: (secureHost: SecureConfigHost) => LoginHost;
	createChatGptWebBrowserHost?: (
		secureHost: SecureConfigHost,
		config: ChatGptWebRuntimeConfig,
	) => BrowserHost | Promise<BrowserHost>;
	openExecutable?: (path: string) => Promise<NativeVerifiedExecutable>;
	launchVerifiedBrowser?: (spec: {
		readonly executable: NativeVerifiedExecutable;
		readonly environment: NativeLaunchEnvironment;
		readonly options: {
			readonly headed: boolean;
			readonly featureToggles: readonly [
				"disable-background-networking",
				"disable-component-update",
				"disable-default-apps",
			];
		};
	}) => NativeOwnedBrowserProcess | Promise<NativeOwnedBrowserProcess>;
	currentProcessIdentity?: () => ChatGptWebProcessIdentity;
	isProcessIdentityLive?: (pid: number, processStartIdentity: string) => boolean;
	openPrivateDirectory?: (path: string) => NativeOwnedFile;
	openOrCreatePrivateDirectory?: (path: string) => NativeOwnedFile;
	openOwnerPrivateFile?: (path: string) => NativeOwnedFile;
	openOwnedChild?: (root: NativeOwnedFile, name: string, directory?: boolean) => NativeOwnedFile | null;
	openOrCreateOwnedDirectory?: (root: NativeOwnedFile, name: string) => NativeOwnedFile;
	acquireOwnedFileLock?: (root: NativeOwnedFile, name: string) => NativeOwnedFile;
	replaceOwnedFileAtomic?: (
		root: NativeOwnedFile,
		name: string,
		bytes: Uint8Array,
		expectedIdentity: string | null,
	) => NativeOwnedFile;
	removeOwnedFileAtomic?: (root: NativeOwnedFile, name: string, expectedIdentity: string) => void;
	removeOwnedTreeAtomic?: (root: NativeOwnedFile, name: string, expectedIdentity: string) => void;
	matchesOwnedChild?: (root: NativeOwnedFile, name: string, expectedIdentity: string, directory?: boolean) => boolean;
	openVerifiedExecutableMatching?: (
		spec: { path: string; sha256: string; version: string },
		expectedIdentity: string,
	) => Promise<NativeVerifiedExecutable | null>;
}

type NativeBrowserModule = NativeSecureHostModule &
	Required<
		Pick<
			NativeSecureHostModule,
			| "NativeLaunchEnvironment"
			| "NativeOwnedFile"
			| "launchVerifiedBrowser"
			| "openExecutable"
			| "openVerifiedExecutableMatching"
		>
	>;

const nativeEntryCapabilities = new WeakMap<object, NativeOwnedFile>();

type NativeSecureConfigModule = Required<
	Pick<
		NativeSecureHostModule,
		| "acquireOwnedFileLock"
		| "currentProcessIdentity"
		| "isProcessIdentityLive"
		| "matchesOwnedChild"
		| "openOrCreateOwnedDirectory"
		| "openOrCreatePrivateDirectory"
		| "openPrivateDirectory"
		| "openOwnedChild"
		| "openOwnerPrivateFile"
		| "openVerifiedExecutableMatching"
		| "removeOwnedFileAtomic"
		| "removeOwnedTreeAtomic"
		| "replaceOwnedFileAtomic"
	>
>;

interface EntryRecord {
	readonly file: NativeOwnedFile;
	readonly parent?: NativeOwnedFile;
	readonly name?: string;
	readonly directory: boolean;
	readonly external: boolean;
	closed: boolean;
	consumed: boolean;
}

function moduleObject(value: unknown): NativeSecureHostModule | null {
	return value && typeof value === "object" ? (value as NativeSecureHostModule) : null;
}

function isSecureConfigHost(value: unknown): value is SecureConfigHost {
	if (!value || typeof value !== "object") return false;
	const host = value as Partial<SecureConfigHost>;
	return (
		host.available === true &&
		typeof host.currentProcessIdentity === "function" &&
		typeof host.openState === "function"
	);
}

function isLoginHost(value: unknown): value is LoginHost {
	if (!value || typeof value !== "object") return false;
	const host = value as Partial<LoginHost>;
	return typeof host.login === "function" && typeof host.close === "function";
}

function isBrowserHost(value: unknown): value is BrowserHost {
	if (!isLoginHost(value)) return false;
	return typeof (value as Partial<BrowserHost>).lease === "function";
}

function isNativeSecureConfigModule(
	module: NativeSecureHostModule,
): module is NativeSecureHostModule & NativeSecureConfigModule {
	const names: readonly (keyof NativeSecureConfigModule)[] = [
		"acquireOwnedFileLock",
		"currentProcessIdentity",
		"isProcessIdentityLive",
		"matchesOwnedChild",
		"openOrCreateOwnedDirectory",
		"openOrCreatePrivateDirectory",
		"openPrivateDirectory",
		"openOwnedChild",
		"openOwnerPrivateFile",
		"openVerifiedExecutableMatching",
		"removeOwnedFileAtomic",
		"removeOwnedTreeAtomic",
		"replaceOwnedFileAtomic",
	];
	return names.every(name => typeof module[name] === "function");
}

function assertNativeFile(file: NativeOwnedFile, directory: boolean, label: string): NativeOwnedFile {
	if (
		!file ||
		typeof file !== "object" ||
		typeof file.identity !== "string" ||
		file.identity === "" ||
		file.directory !== directory ||
		typeof file.cleanup !== "function" ||
		typeof file.read !== "function" ||
		typeof file.consume !== "function" ||
		typeof file.close !== "function"
	) {
		throw new Error(`Invalid native ${label} capability`);
	}
	return file;
}

function readBounded(file: NativeOwnedFile, label: string): Uint8Array {
	const bytes = file.read();
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_SECURE_STATE_BYTES) {
		throw new Error(`Invalid native ${label} bytes`);
	}
	return bytes.slice();
}

function sameProcessIdentity(left: ChatGptWebProcessIdentity, right: ChatGptWebProcessIdentity): boolean {
	return left.pid === right.pid && left.processStartIdentity === right.processStartIdentity;
}

function validateCurrentProcessIdentity(identity: ChatGptWebProcessIdentity): ChatGptWebProcessIdentity {
	if (
		!Number.isSafeInteger(identity.pid) ||
		identity.pid <= 0 ||
		typeof identity.processStartIdentity !== "string" ||
		identity.processStartIdentity === ""
	) {
		throw new Error("Invalid native process identity");
	}
	return Object.freeze({
		pid: identity.pid,
		processStartIdentity: identity.processStartIdentity,
	});
}

function createLowLevelSecureConfigHost(native: NativeSecureConfigModule): SecureConfigHost {
	return Object.freeze({
		available: true,
		async currentProcessIdentity(): Promise<ChatGptWebProcessIdentity> {
			return validateCurrentProcessIdentity(native.currentProcessIdentity());
		},
		async openState(
			paths: ChatGptWebPaths,
			options: {
				readonly mode: "read" | "mutate";
				readonly proposedOwnership?: ChatGptWebOwnershipRecord;
			},
		): Promise<SecureStateSession> {
			const held = new Set<NativeOwnedFile>();
			let lockCapability: NativeOwnedFile | undefined;
			const closeHeld = (): void => {
				for (const file of held) {
					if (file === lockCapability) continue;
					try {
						file.close();
					} catch {
						// All authority checks fail closed; cleanup cannot transfer authority.
					}
				}
				try {
					lockCapability?.close();
				} catch {
					// Releasing the OS lock is the final cleanup action.
				}
				held.clear();
			};
			try {
				const root = assertNativeFile(
					options.mode === "mutate"
						? native.openOrCreatePrivateDirectory(paths.root)
						: native.openPrivateDirectory(paths.root),
					true,
					"secure-state root",
				);
				held.add(root);
				const lock = assertNativeFile(native.acquireOwnedFileLock(root, ".state.lock"), false, "state lock");
				lockCapability = lock;
				held.add(lock);
				const currentProcess = validateCurrentProcessIdentity(native.currentProcessIdentity());
				let ownershipFile = native.openOwnedChild(root, "ownership", false);
				let ownership: ChatGptWebOwnershipRecord;
				if (ownershipFile) {
					held.add(ownershipFile);
					ownership = parseChatGptWebOwnership(decodeJson(readBounded(ownershipFile, "ownership")));
					if (options.mode === "mutate" && !sameProcessIdentity(ownership.process, currentProcess)) {
						if (native.isProcessIdentityLive(ownership.process.pid, ownership.process.processStartIdentity)) {
							throw new Error("ChatGPT Web secure state is owned by a live process");
						}
						if (!options.proposedOwnership) throw new Error("Invalid proposed ChatGPT Web ownership");
						const proposed = parseChatGptWebOwnership(options.proposedOwnership);
						if (!sameProcessIdentity(proposed.process, currentProcess)) {
							throw new Error("Invalid proposed ChatGPT Web ownership");
						}
						const replacement = assertNativeFile(
							native.replaceOwnedFileAtomic(root, "ownership", encodeJson(proposed), ownershipFile.identity),
							false,
							"ownership",
						);
						const previousOwnershipFile = ownershipFile;
						held.add(replacement);
						ownershipFile = replacement;
						previousOwnershipFile.close();
						held.delete(previousOwnershipFile);
						ownership = proposed;
					}
				} else {
					if (options.mode !== "mutate" || !options.proposedOwnership) {
						throw new Error("ChatGPT Web secure-state ownership is absent");
					}
					ownership = parseChatGptWebOwnership(options.proposedOwnership);
					if (!sameProcessIdentity(ownership.process, currentProcess)) {
						throw new Error("Invalid proposed ChatGPT Web ownership");
					}
					ownershipFile = assertNativeFile(
						native.replaceOwnedFileAtomic(root, "ownership", encodeJson(ownership), null),
						false,
						"ownership",
					);
					held.add(ownershipFile);
				}

				let profileFile = native.openOwnedChild(root, "browser-profile", true);
				if (!profileFile) {
					if (options.mode !== "mutate") throw new Error("ChatGPT Web browser profile is absent");
					profileFile = native.openOrCreateOwnedDirectory(root, "browser-profile");
				}
				const profileCapability = assertNativeFile(profileFile, true, "browser profile");
				held.add(profileCapability);

				const records = new WeakMap<object, EntryRecord>();
				let closed = false;
				let removed = false;
				const entryFor = (
					file: NativeOwnedFile,
					kind: SecureEntryKind,
					record: Omit<EntryRecord, "file" | "closed" | "consumed">,
				): SecureEntryReference => {
					held.add(file);
					const entry = Object.freeze({ identity: file.identity, kind }) as SecureEntryReference;
					records.set(entry as object, { file, ...record, closed: false, consumed: false });
					nativeEntryCapabilities.set(entry as object, file);
					return entry;
				};
				const ownershipEntry = entryFor(assertNativeFile(ownershipFile, false, "ownership"), "file", {
					parent: root,
					name: "ownership",
					directory: false,
					external: false,
				});
				const profile = entryFor(profileCapability, "directory", {
					parent: root,
					name: "browser-profile",
					directory: true,
					external: false,
				});
				const requireOpen = (): void => {
					if (closed || removed) throw new Error("Secure state session is closed");
				};
				const requireMutation = (): void => {
					requireOpen();
					if (options.mode !== "mutate") throw new Error("Secure state session is read-only");
				};
				const recordFor = (entry: SecureEntryReference): EntryRecord => {
					requireOpen();
					const record = entry && typeof entry === "object" ? records.get(entry as object) : undefined;
					if (!record || record.closed || record.file.identity !== entry.identity) {
						throw new Error("Unknown or closed secure entry capability");
					}
					return record;
				};
				const assertCurrent = async (entry: SecureEntryReference): Promise<void> => {
					const record = recordFor(entry);
					if (record.external) {
						if (record.consumed) throw new Error("Secure external file was consumed");
						return;
					}
					if (
						!record.parent ||
						!record.name ||
						!native.matchesOwnedChild(record.parent, record.name, record.file.identity, record.directory)
					) {
						throw new Error("Secure state entry identity changed");
					}
				};
				const session: SecureStateSession = {
					mode: options.mode,
					ownership,
					ownershipEntry,
					ownerFence: ownership.ownerNonce,
					profile,
					async read(name) {
						requireOpen();
						const file = native.openOwnedChild(root, name, false);
						if (!file) return null;
						const capability = assertNativeFile(file, false, name);
						const entry = entryFor(capability, "file", {
							parent: root,
							name,
							directory: false,
							external: false,
						});
						return { entry, bytes: readBounded(capability, name) };
					},
					assertCurrent,
					async verifyExecutable(identity: ChatGptWebExecutableIdentity): Promise<boolean> {
						requireOpen();
						for (const candidate of chromeExecutableCandidates({
							platform: process.platform,
							env: process.env,
							home: homedir(),
						})) {
							let executable: NativeVerifiedExecutable | undefined;
							try {
								executable =
									(await native.openVerifiedExecutableMatching(
										{
											path: candidate,
											sha256: identity.sha256,
											version: identity.version,
										},
										identity.identity,
									)) ?? undefined;
								if (
									executable &&
									executable.identity === identity.identity &&
									executable.sha256 === identity.sha256 &&
									executable.version === identity.version
								)
									return true;
							} catch {
								// Candidate absence or mismatch is not authority; continue the fixed allowlist.
							} finally {
								executable?.close();
							}
						}
						return false;
					},
					async openExternalOwnerFile(path) {
						requireOpen();
						const capability = assertNativeFile(native.openOwnerPrivateFile(path), false, "external file");
						const entry = entryFor(capability, "file", { directory: false, external: true });
						const bytes = readBounded(capability, "external file");
						return Object.freeze({
							entry,
							bytes,
							consume() {
								const record = recordFor(entry);
								if (record.consumed) throw new Error("Secure external file was already consumed");
								record.file.consume();
								record.consumed = true;
							},
							close() {
								const record = records.get(entry as object);
								if (!record || record.closed) return;
								record.file.close();
								record.closed = true;
								held.delete(record.file);
							},
						});
					},
					async replaceAtomic(name, bytes, expectedDestinationIdentity) {
						requireMutation();
						if (
							!(bytes instanceof Uint8Array) ||
							bytes.byteLength === 0 ||
							bytes.byteLength > MAX_SECURE_STATE_BYTES
						) {
							throw new Error("Invalid secure state replacement bytes");
						}
						const capability = assertNativeFile(
							native.replaceOwnedFileAtomic(root, name, bytes, expectedDestinationIdentity),
							false,
							name,
						);
						return entryFor(capability, "file", {
							parent: root,
							name,
							directory: false,
							external: false,
						});
					},
					async importAtomic(name, source, expectedDestinationIdentity) {
						requireMutation();
						const record = recordFor(source.entry);
						if (!record.external || record.consumed) throw new Error("Invalid secure external source");
						return session.replaceAtomic(
							name,
							readBounded(record.file, "external file"),
							expectedDestinationIdentity,
						);
					},
					async removeAtomic(name, expectedIdentity) {
						requireMutation();
						native.removeOwnedFileAtomic(root, name, expectedIdentity);
					},
					async removeAllOwnedState() {
						requireMutation();
						await assertCurrent(profile);
						native.removeOwnedTreeAtomic(root, "browser-profile", profileCapability.identity);
						for (const name of STATE_NAMES) {
							const file = native.openOwnedChild(root, name, false);
							if (!file) continue;
							try {
								native.removeOwnedFileAtomic(root, name, file.identity);
							} finally {
								file.close();
							}
						}
						native.removeOwnedFileAtomic(root, "ownership", ownershipFile.identity);
						removed = true;
					},
					async close() {
						if (closed) return;
						closed = true;
						closeHeld();
					},
				};
				return session;
			} catch (error) {
				closeHeld();
				throw error;
			}
		},
	});
}

const BROWSER_FEATURE_TOGGLES = [
	"disable-background-networking",
	"disable-component-update",
	"disable-default-apps",
] as const;

function isNativeBrowserModule(module: NativeSecureHostModule): module is NativeBrowserModule {
	return (
		typeof module.openExecutable === "function" &&
		typeof module.openVerifiedExecutableMatching === "function" &&
		typeof module.launchVerifiedBrowser === "function" &&
		typeof module.NativeOwnedFile?.createPrivate === "function" &&
		typeof module.NativeLaunchEnvironment?.browserChild === "function"
	);
}

function assertNativeExecutable(value: NativeVerifiedExecutable): NativeVerifiedExecutable {
	if (
		!value ||
		typeof value !== "object" ||
		typeof value.identity !== "string" ||
		value.identity === "" ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.sha256) ||
		typeof value.version !== "string" ||
		value.version === "" ||
		typeof value.close !== "function"
	) {
		throw new Error("Invalid native verified executable capability");
	}
	return value;
}

function nativeFileFor(entry: SecureEntryReference, directory: boolean): NativeOwnedFile {
	const file = entry && typeof entry === "object" ? nativeEntryCapabilities.get(entry as object) : undefined;
	if (!file || file.identity !== entry.identity || file.directory !== directory) {
		throw new Error("Secure entry is not backed by a live native capability");
	}
	return file;
}

function assertNativeBrowserProcess(value: NativeOwnedBrowserProcess): NativeOwnedBrowserProcess {
	if (
		!value ||
		typeof value !== "object" ||
		!value.process ||
		typeof value.process !== "object" ||
		typeof value.process.wait !== "function" ||
		typeof value.process.terminate !== "function" ||
		typeof value.process.close !== "function" ||
		!value.pipe ||
		typeof value.pipe !== "object" ||
		typeof value.pipe.read !== "function" ||
		typeof value.pipe.write !== "function" ||
		typeof value.pipe.close !== "function"
	) {
		throw new Error("Invalid native browser process capability");
	}
	return value;
}

function adaptedBrowserProcess(value: NativeOwnedBrowserProcess): NativeOwnedBrowserProcessLike {
	const native = assertNativeBrowserProcess(value);
	return Object.freeze({
		process: Object.freeze({
			async wait(timeoutMs?: number) {
				const exit = await native.process.wait(timeoutMs);
				return { exitCode: exit.exitCode ?? null, signal: exit.signal ?? null };
			},
			async terminate() {
				await native.process.terminate();
			},
			close() {
				native.process.close();
			},
		}),
		pipe: Object.freeze({
			nonBlocking: true as const,
			async read() {
				const bytes = await native.pipe.read();
				if (!(bytes instanceof Uint8Array)) throw new Error("Invalid native browser pipe read");
				return bytes;
			},
			async write(bytes: Uint8Array) {
				await native.pipe.write(bytes);
			},
			async close() {
				await native.pipe.close();
			},
		}),
	});
}
async function closeConnectedBrowser(
	connected: LocalBrowserConnection,
	adapted: NativeOwnedBrowserProcessLike,
): Promise<void> {
	const errors: unknown[] = [];
	for (const result of await Promise.allSettled([
		connected.browser.close(),
		adapted.pipe.close(),
		adapted.process.terminate(),
	])) {
		if (result.status === "rejected") errors.push(result.reason);
	}
	try {
		adapted.process.close();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) throw new AggregateError(errors, "Native login browser cleanup failed");
}

async function launchNativeBrowser(
	native: NativeBrowserModule,
	executable: NativeVerifiedExecutable,
	profile: NativeOwnedFile,
	profileGeneration: string,
	ownerFence: string,
	headed: boolean,
): Promise<NativeOwnedBrowserProcess> {
	const environment = native.NativeLaunchEnvironment.browserChild(profile, profileGeneration, ownerFence);
	if (!environment || typeof environment !== "object") {
		throw new Error("Invalid native browser launch environment");
	}
	return assertNativeBrowserProcess(
		await native.launchVerifiedBrowser({
			executable,
			environment,
			options: { headed, featureToggles: BROWSER_FEATURE_TOGGLES },
		}),
	);
}

class NativeLoginBrowserDriver implements LoginBrowserDriver {
	readonly #native: NativeBrowserModule;
	readonly #allowedCandidates: ReadonlySet<string>;
	readonly #executables = new WeakMap<object, NativeVerifiedExecutable>();
	readonly #opened = new Set<NativeVerifiedExecutable>();

	constructor(native: NativeBrowserModule, environment: ChromeDiscoveryEnvironment) {
		this.#native = native;
		this.#allowedCandidates = new Set(chromeExecutableCandidates(environment));
	}

	async openExecutable(candidate: string): Promise<VerifiedLoginExecutable | null> {
		if (!this.#allowedCandidates.has(candidate)) return null;
		let executable: NativeVerifiedExecutable;
		try {
			executable = assertNativeExecutable(await this.#native.openExecutable(candidate));
		} catch {
			return null;
		}
		const reference = Object.freeze({
			identity: executable.identity,
			sha256: executable.sha256,
			version: executable.version,
		}) as VerifiedLoginExecutable;
		this.#executables.set(reference as object, executable);
		this.#opened.add(executable);
		return reference;
	}

	#resolveExecutable(reference: VerifiedLoginExecutable): NativeVerifiedExecutable {
		const executable =
			reference && typeof reference === "object" ? this.#executables.get(reference as object) : undefined;
		if (
			!executable ||
			executable.identity !== reference.identity ||
			executable.sha256 !== reference.sha256 ||
			executable.version !== reference.version
		) {
			throw new Error("Unknown native executable capability");
		}
		return executable;
	}

	async launchInteractive(
		options: Parameters<LoginBrowserDriver["launchInteractive"]>[0],
	): Promise<InteractiveLoginProcess> {
		const executable = this.#resolveExecutable(options.executable);
		const profile = nativeFileFor(options.profile, true);
		const owned = await launchNativeBrowser(
			this.#native,
			executable,
			profile,
			options.profileGeneration,
			options.ownerFence,
			true,
		);
		const adapted = adaptedBrowserProcess(owned);
		let connected: LocalBrowserConnection;
		try {
			connected = await connectLocalBrowserPipe(adapted.pipe);
			await openLocalTemporaryChat(connected.context);
		} catch (error) {
			await Promise.allSettled([Promise.resolve(adapted.pipe.close()), adapted.process.terminate()]);
			adapted.process.close();
			throw error;
		}
		let closed = false;
		return Object.freeze({
			wait: () => adapted.process.wait(),
			terminate: () => adapted.process.terminate(),
			async close() {
				if (closed) return;
				closed = true;
				await closeConnectedBrowser(connected, adapted);
			},
		});
	}

	async launchVerification(
		options: Parameters<LoginBrowserDriver["launchVerification"]>[0],
	): Promise<VerificationBrowserContext> {
		const executable = this.#resolveExecutable(options.executable);
		const profile = nativeFileFor(options.profile, true);
		const owned = await launchNativeBrowser(
			this.#native,
			executable,
			profile,
			options.profileGeneration,
			options.ownerFence,
			true,
		);
		const adapted = adaptedBrowserProcess(owned);
		let connected: LocalBrowserConnection;
		try {
			connected = await connectLocalBrowserPipe(adapted.pipe);
		} catch (error) {
			await Promise.allSettled([Promise.resolve(adapted.pipe.close()), adapted.process.terminate()]);
			adapted.process.close();
			throw error;
		}
		let closed = false;
		return Object.freeze({
			verifyTemporaryChat: () => verifyLocalBrowserContext(connected.context, options.profile.identity),
			async close() {
				if (closed) return;
				closed = true;
				await closeConnectedBrowser(connected, adapted);
			},
		});
	}

	close(): void {
		const errors: unknown[] = [];
		for (const executable of this.#opened) {
			try {
				executable.close();
			} catch (error) {
				errors.push(error);
			}
		}
		this.#opened.clear();
		if (errors.length > 0) throw new AggregateError(errors, "Native browser executable cleanup failed");
	}
}

function createLowLevelLoginHost(native: NativeBrowserModule): LoginHost {
	const environment: ChromeDiscoveryEnvironment = {
		platform: process.platform,
		env: process.env,
		home: homedir(),
	};
	const driver = new NativeLoginBrowserDriver(native, environment);
	const host = new LocalLoginHost(driver, environment);
	return Object.freeze({
		login: (request: BrowserLoginRequest) => host.login(request),
		async close() {
			const errors: unknown[] = [];
			try {
				await host.close();
			} catch (error) {
				errors.push(error);
			}
			try {
				driver.close();
			} catch (error) {
				errors.push(error);
			}
			if (errors.length > 0) throw new AggregateError(errors, "Native login host cleanup failed");
		},
	});
}

async function matchingBrowserExecutable(
	native: NativeBrowserModule,
	identity: ChatGptWebExecutableIdentity,
): Promise<NativeVerifiedExecutable | null> {
	for (const path of chromeExecutableCandidates({
		platform: process.platform,
		env: process.env,
		home: homedir(),
	})) {
		let executable: NativeVerifiedExecutable | null = null;
		try {
			executable = await native.openVerifiedExecutableMatching(
				{
					path,
					sha256: identity.sha256,
					version: identity.version,
				},
				identity.identity,
			);
			if (executable) return assertNativeExecutable(executable);
		} catch {
			executable?.close();
		}
	}
	return null;
}

function validateLeaseBinding(binding: LocalBrowserLeaseBinding, ownerGeneration: string): void {
	if (
		!binding ||
		typeof binding !== "object" ||
		binding.ownerGeneration !== ownerGeneration ||
		typeof binding.leaseId !== "string" ||
		binding.leaseId === "" ||
		typeof binding.sessionId !== "string" ||
		binding.sessionId === "" ||
		typeof binding.turnId !== "string" ||
		binding.turnId === "" ||
		!binding.capability ||
		typeof binding.capability !== "object"
	) {
		throw new Error("Invalid native browser lease binding");
	}
}

async function createLowLevelBrowserHost(
	native: NativeBrowserModule,
	secureHost: SecureConfigHost,
	config: ChatGptWebRuntimeConfig,
	gate?: ChatGptWebRuntimeGate,
): Promise<BrowserHost | null> {
	if (config.mode !== "browser-only" && config.mode !== "full") return null;
	const session = await secureHost.openState(resolveChatGptWebPaths(), { mode: "read" });
	let executable: NativeVerifiedExecutable | null = null;
	try {
		const assertOwner = async (): Promise<void> => {
			const currentProcess = await secureHost.currentProcessIdentity();
			if (!sameProcessIdentity(session.ownership.process, currentProcess)) {
				throw new Error("ChatGPT Web browser profile is owned by another process");
			}
			await session.assertCurrent(session.ownershipEntry);
		};
		await assertOwner();
		const markerRead = await session.read("verification.json");
		if (!markerRead) {
			await session.close();
			return null;
		}
		await Promise.all([session.assertCurrent(session.profile), session.assertCurrent(markerRead.entry)]);
		const marker = parseChatGptWebVerificationMarker(decodeJson(markerRead.bytes));
		if (
			marker.profileGeneration !== session.ownership.profileGeneration ||
			marker.ownerFence !== session.ownerFence ||
			marker.profileIdentity !== session.profile.identity
		) {
			await session.close();
			return null;
		}
		const profile = nativeFileFor(session.profile, true);
		executable = await matchingBrowserExecutable(native, marker.executable);
		if (!executable) {
			await session.close();
			return null;
		}
		const verifiedExecutable = executable;
		const ownerGeneration = session.ownership.profileGeneration;
		const stagedRecords = new WeakMap<
			object,
			{
				readonly binding: LocalBrowserLeaseBinding;
				readonly file: NativeOwnedFile;
				readonly reference: SecureStagedAttachment;
				closed: boolean;
			}
		>();
		const stagedFiles = new Set<SecureStagedAttachment>();
		let closed = false;
		const requireOpen = (): void => {
			if (closed) throw new Error("Native browser authority is closed");
		};
		const revalidateMarker = async (): Promise<void> => {
			requireOpen();
			await assertOwner();
			if (!(await session.verifyExecutable(marker.executable))) {
				throw new Error("Native browser executable identity changed");
			}
			await Promise.all([session.assertCurrent(session.profile), session.assertCurrent(markerRead.entry)]);
			if (
				marker.profileGeneration !== session.ownership.profileGeneration ||
				marker.ownerFence !== session.ownerFence ||
				marker.profileIdentity !== session.profile.identity ||
				verifiedExecutable.identity !== marker.executable.identity ||
				verifiedExecutable.sha256 !== marker.executable.sha256 ||
				verifiedExecutable.version !== marker.executable.version
			) {
				throw new Error("Native browser authority identity changed");
			}
		};
		const authority: SecureBrowserRuntimeAuthority = {
			available: true,
			ownerGeneration,
			async revalidate(request, admission) {
				if (
					request.mode !== config.mode ||
					typeof request.sessionId !== "string" ||
					request.sessionId === "" ||
					typeof request.turnId !== "string" ||
					request.turnId === "" ||
					typeof request.headed !== "boolean" ||
					!admission ||
					typeof admission !== "object" ||
					typeof admission.runtimeEpoch !== "string" ||
					admission.runtimeEpoch === "" ||
					!Number.isSafeInteger(admission.lifecycleGeneration) ||
					admission.lifecycleGeneration <= 0
				) {
					throw new Error("Invalid native browser admission");
				}
				if (gate) {
					const reference = gate.retain(admission, "browser-lease");
					gate.release(reference);
				}
				await revalidateMarker();
			},
			async launch(request) {
				await revalidateMarker();
				const owned = await launchNativeBrowser(
					native,
					verifiedExecutable,
					profile,
					session.ownership.profileGeneration,
					session.ownerFence,
					request.headed,
				);
				return adaptedBrowserProcess(owned);
			},
			async stageAttachment(binding, input) {
				requireOpen();
				validateLeaseBinding(binding, ownerGeneration);
				const id = randomBytes(24).toString("hex");
				const file = assertNativeFile(
					native.NativeOwnedFile.createPrivate(profile, `attachment-${id}`, input.bytes),
					false,
					"staged attachment",
				);
				const digest = createHash("sha256").update(input.bytes).digest("hex");
				let record: {
					readonly binding: LocalBrowserLeaseBinding;
					readonly file: NativeOwnedFile;
					readonly reference: SecureStagedAttachment;
					closed: boolean;
				};
				const reference = Object.freeze({
					id,
					name: input.name,
					size: input.bytes.byteLength,
					sha256: digest,
					async close() {
						if (record.closed) return;
						record.closed = true;
						stagedFiles.delete(reference);
						try {
							file.consume();
						} finally {
							try {
								file.cleanup();
							} finally {
								file.close();
							}
						}
					},
				}) as SecureStagedAttachment;
				record = { binding, file, reference, closed: false };
				stagedRecords.set(reference as object, record);
				stagedFiles.add(reference);
				return reference;
			},
			async uploadAttachments(
				binding: LocalBrowserLeaseBinding,
				attachments: readonly SecureStagedAttachment[],
				locator: Locator,
			) {
				requireOpen();
				validateLeaseBinding(binding, ownerGeneration);
				const payloads = attachments.map(attachment => {
					const record =
						attachment && typeof attachment === "object" ? stagedRecords.get(attachment as object) : undefined;
					if (
						!record ||
						record.closed ||
						record.reference !== attachment ||
						record.binding.capability !== binding.capability ||
						record.binding.leaseId !== binding.leaseId ||
						record.binding.sessionId !== binding.sessionId ||
						record.binding.turnId !== binding.turnId
					) {
						throw new Error("Unknown native staged attachment");
					}
					const bytes = record.file.read();
					if (
						!(bytes instanceof Uint8Array) ||
						bytes.byteLength !== attachment.size ||
						createHash("sha256").update(bytes).digest("hex") !== attachment.sha256
					) {
						throw new Error("Native staged attachment changed");
					}
					return {
						name: attachment.name,
						mimeType: "application/octet-stream",
						buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
					};
				});
				await locator.setInputFiles(payloads);
				await Promise.all(attachments.map(attachment => attachment.close()));
			},
			async close() {
				if (closed) return;
				closed = true;
				const errors: unknown[] = [];
				for (const result of await Promise.allSettled([...stagedFiles].map(staged => staged.close()))) {
					if (result.status === "rejected") errors.push(result.reason);
				}
				stagedFiles.clear();
				try {
					verifiedExecutable.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					await session.close();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length > 0) throw new AggregateError(errors, "Native browser authority cleanup failed");
			},
		};
		const loginHost = createLowLevelLoginHost(native);
		return createLocalBrowserHost({ authority, loginHost });
	} catch (error) {
		try {
			executable?.close();
		} catch {
			// Preserve the construction failure after attempting remaining cleanup.
		}
		await session.close().catch(() => undefined);
		throw error;
	}
}

export function createNativeSecureConfigHost(moduleValue: unknown): SecureConfigHost | null {
	const module = moduleObject(moduleValue);
	if (!module) return null;
	if (typeof module.createChatGptWebSecureConfigHost === "function") {
		const host = module.createChatGptWebSecureConfigHost();
		return isSecureConfigHost(host) ? host : null;
	}
	return isNativeSecureConfigModule(module) ? createLowLevelSecureConfigHost(module) : null;
}

export function createNativeLoginHost(moduleValue: unknown, secureHost: SecureConfigHost): LoginHost | null {
	const module = moduleObject(moduleValue);
	if (!module || !secureHost.available) return null;
	if (typeof module.createChatGptWebLoginHost === "function") {
		const host = module.createChatGptWebLoginHost(secureHost);
		return isLoginHost(host) ? host : null;
	}
	return isNativeBrowserModule(module) ? createLowLevelLoginHost(module) : null;
}

export async function createNativeBrowserHost(
	moduleValue: unknown,
	secureHost: SecureConfigHost,
	config: ChatGptWebRuntimeConfig,
	gate?: ChatGptWebRuntimeGate,
): Promise<BrowserHost | null> {
	const module = moduleObject(moduleValue);
	if (!module || !secureHost.available) return null;
	if (typeof module.createChatGptWebBrowserHost === "function") {
		const host = await module.createChatGptWebBrowserHost(secureHost, config);
		return isBrowserHost(host) ? host : null;
	}
	return isNativeBrowserModule(module) ? createLowLevelBrowserHost(module, secureHost, config, gate) : null;
}
