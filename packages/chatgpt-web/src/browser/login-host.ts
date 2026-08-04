import path from "node:path";
import type { ChatGptWebExecutableIdentity, ChatGptWebRuntimeConfig, SecureEntryReference } from "../config";

export interface BrowserLoginRequest {
	readonly profile: SecureEntryReference;
	readonly config: ChatGptWebRuntimeConfig;
	readonly profileGeneration: string;
	readonly ownerFence: string;
	readonly headed: true;
	readonly signal?: AbortSignal;
	readonly executableOverride?: string;
}

export interface BrowserLoginResult {
	readonly authenticated: true;
	readonly verifiedAt: string;
	readonly proAvailable: boolean;
	readonly profileIdentity: string;
	readonly executable: ChatGptWebExecutableIdentity;
}

export interface LoginHost {
	login(request: BrowserLoginRequest): Promise<BrowserLoginResult>;
	close(): Promise<void>;
}

export type BrowserLoginDiagnosticCode =
	| "aborted"
	| "browser-not-found"
	| "interactive-exit"
	| "interactive-failure"
	| "verification-failure"
	| "abnormal-eof";

export class BrowserLoginError extends Error {
	readonly code: BrowserLoginDiagnosticCode;

	constructor(code: BrowserLoginDiagnosticCode) {
		super(`ChatGPT Web browser login failed (${code})`);
		this.name = "BrowserLoginError";
		this.code = code;
	}
}

export interface VerifiedLoginExecutable extends ChatGptWebExecutableIdentity {
	readonly __verifiedExecutable: unique symbol;
}

export interface InteractiveLoginProcess {
	wait(): Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
	terminate(): Promise<void>;
	close(): Promise<void>;
}

export interface VerificationBrowserContext {
	verifyTemporaryChat(): Promise<{
		readonly authenticated: boolean;
		readonly temporaryChat: boolean;
		readonly proAvailable: boolean;
		readonly profileIdentity: string;
	}>;
	close(): Promise<void>;
}

export interface LoginBrowserDriver {
	openExecutable(candidate: string): Promise<VerifiedLoginExecutable | null>;
	launchInteractive(options: {
		readonly executable: VerifiedLoginExecutable;
		readonly profile: SecureEntryReference;
		readonly profileGeneration: string;
		readonly ownerFence: string;
		readonly headed: true;
		readonly featureToggles: readonly [
			"disable-background-networking",
			"disable-component-update",
			"disable-default-apps",
		];
	}): Promise<InteractiveLoginProcess>;
	launchVerification(options: {
		readonly executable: VerifiedLoginExecutable;
		readonly profile: SecureEntryReference;
		readonly profileGeneration: string;
		readonly ownerFence: string;
		readonly headed: true;
	}): Promise<VerificationBrowserContext>;
}

export interface ChromeDiscoveryEnvironment {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly home: string;
}

export function chromeExecutableCandidates(environment: ChromeDiscoveryEnvironment): readonly string[] {
	const { home, platform } = environment;
	if (platform === "win32") {
		const programFiles = ["C:\\Program Files", "C:\\Program Files (x86)"];
		const localAppData = path.win32.join(home, "AppData", "Local");
		return [
			...programFiles.map(root => path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe")),
			path.win32.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
			...programFiles.map(root => path.win32.join(root, "Chromium", "Application", "chrome.exe")),
			path.win32.join(localAppData, "Chromium", "Application", "chrome.exe"),
		];
	}
	if (platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			path.posix.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		];
	}
	if (platform === "linux") {
		return [
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		];
	}
	return [];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new BrowserLoginError("aborted");
}

async function waitForInteractiveExit(
	process: InteractiveLoginProcess,
	signal: AbortSignal | undefined,
): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> {
	throwIfAborted(signal);
	if (!signal) return process.wait();
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(new BrowserLoginError("aborted"));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([process.wait(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

const FEATURE_TOGGLES = ["disable-background-networking", "disable-component-update", "disable-default-apps"] as const;

export class LocalLoginHost implements LoginHost {
	readonly #driver: LoginBrowserDriver;
	readonly #environment: ChromeDiscoveryEnvironment;
	readonly #now: () => Date;
	readonly #operations = new Set<Promise<BrowserLoginResult>>();
	#interactive: InteractiveLoginProcess | undefined;
	#verification: VerificationBrowserContext | undefined;
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#activeCleanup: Promise<void> | undefined;

	constructor(
		driver: LoginBrowserDriver,
		environment: ChromeDiscoveryEnvironment,
		now: () => Date = () => new Date(),
	) {
		this.#driver = driver;
		this.#environment = environment;
		this.#now = now;
	}

	login(request: BrowserLoginRequest): Promise<BrowserLoginResult> {
		if (this.#closed || this.#operations.size > 0 || this.#interactive || this.#verification) {
			return Promise.reject(new BrowserLoginError("interactive-failure"));
		}
		const { promise: operation, resolve, reject } = Promise.withResolvers<BrowserLoginResult>();
		this.#operations.add(operation);
		void this.#runLogin(request).then(
			result => {
				if (this.#closed) reject(new BrowserLoginError("interactive-failure"));
				else resolve(result);
			},
			error => {
				reject(this.#closed ? new BrowserLoginError("interactive-failure") : error);
			},
		);
		void operation.then(
			() => this.#operations.delete(operation),
			() => this.#operations.delete(operation),
		);
		return operation;
	}

	async #runLogin(request: BrowserLoginRequest): Promise<BrowserLoginResult> {
		throwIfAborted(request.signal);
		const candidates = request.executableOverride
			? [request.executableOverride]
			: chromeExecutableCandidates(this.#environment);
		let executable: VerifiedLoginExecutable | null = null;
		for (const candidate of candidates) {
			throwIfAborted(request.signal);
			executable = await this.#driver.openExecutable(candidate);
			this.#assertOpen();
			if (executable) break;
		}
		if (!executable) throw new BrowserLoginError("browser-not-found");

		try {
			const interactive = await this.#driver.launchInteractive({
				executable,
				profile: request.profile,
				profileGeneration: request.profileGeneration,
				ownerFence: request.ownerFence,
				headed: true,
				featureToggles: FEATURE_TOGGLES,
			});
			if (this.#closed) {
				await this.#terminateInteractive(interactive);
				throw new BrowserLoginError("interactive-failure");
			}
			this.#interactive = interactive;
			let exit: { readonly exitCode: number | null; readonly signal: string | null };
			try {
				exit = await waitForInteractiveExit(interactive, request.signal);
			} catch (error) {
				if (error instanceof BrowserLoginError) throw error;
				throw new BrowserLoginError("abnormal-eof");
			}
			this.#assertOpen();
			if (exit.signal !== null || exit.exitCode !== 0) throw new BrowserLoginError("interactive-exit");
			if (this.#interactive === interactive) this.#interactive = undefined;
			try {
				await interactive.close();
			} catch (error) {
				if (!this.#interactive) this.#interactive = interactive;
				throw error;
			}
			this.#assertOpen();

			const verification = await this.#driver.launchVerification({
				executable,
				profile: request.profile,
				profileGeneration: request.profileGeneration,
				ownerFence: request.ownerFence,
				headed: true,
			});
			if (this.#closed) {
				try {
					await verification.close();
				} catch {
					// The lifecycle error remains authoritative after best-effort cleanup.
				}
				throw new BrowserLoginError("interactive-failure");
			}
			this.#verification = verification;
			const verified = await verification.verifyTemporaryChat();
			this.#assertOpen();
			throwIfAborted(request.signal);
			if (
				!verified.authenticated ||
				!verified.temporaryChat ||
				verified.profileIdentity !== request.profile.identity
			) {
				throw new BrowserLoginError("verification-failure");
			}
			return {
				authenticated: true,
				verifiedAt: this.#now().toISOString(),
				proAvailable: verified.proAvailable,
				profileIdentity: verified.profileIdentity,
				executable: {
					identity: executable.identity,
					sha256: executable.sha256,
					version: executable.version,
				},
			};
		} catch (error) {
			if (error instanceof BrowserLoginError) throw error;
			if (request.signal?.aborted) throw new BrowserLoginError("aborted");
			throw new BrowserLoginError(this.#interactive ? "interactive-failure" : "verification-failure");
		} finally {
			await this.#closeActive();
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw new BrowserLoginError("interactive-failure");
	}

	async #terminateInteractive(interactive: InteractiveLoginProcess): Promise<void> {
		let cleanupFailed = false;
		try {
			await interactive.terminate();
		} catch {
			cleanupFailed = true;
		}
		try {
			await interactive.close();
		} catch {
			cleanupFailed = true;
		}
		if (cleanupFailed) throw new BrowserLoginError("interactive-failure");
	}

	#closeActive(): Promise<void> {
		if (this.#activeCleanup) return this.#activeCleanup;
		const cleanup = Promise.resolve().then(() => this.#runCloseActive());
		this.#activeCleanup = cleanup;
		const clearCleanup = () => {
			if (this.#activeCleanup === cleanup) this.#activeCleanup = undefined;
		};
		void cleanup.then(clearCleanup, clearCleanup);
		return cleanup;
	}

	async #runCloseActive(): Promise<void> {
		let cleanupFailed = false;
		const verification = this.#verification;
		if (verification) {
			try {
				await verification.close();
				if (this.#verification === verification) this.#verification = undefined;
			} catch {
				cleanupFailed = true;
			}
		}
		const interactive = this.#interactive;
		if (interactive) {
			try {
				await this.#terminateInteractive(interactive);
				if (this.#interactive === interactive) this.#interactive = undefined;
			} catch {
				cleanupFailed = true;
			}
		}
		if (cleanupFailed) throw new BrowserLoginError("interactive-failure");
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#closePromise = this.#finishClose();
		return this.#closePromise;
	}

	async #finishClose(): Promise<void> {
		try {
			await this.#closeActive();
		} catch {
			// Active operations get another cleanup attempt before close resolves.
		}
		await Promise.allSettled([...this.#operations]);
		await this.#closeActive();
	}
}
