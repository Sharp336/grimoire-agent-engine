import { describe, expect, test } from "bun:test";
import type { BrowserLoginRequest } from "../src/browser/login-host";
import {
	BrowserLoginError,
	chromeExecutableCandidates,
	type InteractiveLoginProcess,
	LocalLoginHost,
	type LoginBrowserDriver,
	type VerificationBrowserContext,
	type VerifiedLoginExecutable,
} from "../src/browser/login-host";
import type { SecureEntryReference } from "../src/config";

const SHA = "a".repeat(64);
const EXECUTABLE = {
	identity: "exe-identity",
	sha256: SHA,
	version: "123.0.0",
	__verifiedExecutable: Symbol("verified"),
} as VerifiedLoginExecutable;
const PROFILE = {
	identity: "profile-identity",
	kind: "directory",
	__secureEntry: Symbol("secure"),
} as SecureEntryReference;

function request(overrides: Partial<BrowserLoginRequest> = {}): BrowserLoginRequest {
	return {
		profile: PROFILE,
		config: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false },
		profileGeneration: "g".repeat(64),
		ownerFence: "f".repeat(64),
		headed: true,
		...overrides,
	};
}

class FakeInteractive implements InteractiveLoginProcess {
	closed = 0;
	terminated = 0;
	waitResult: Promise<{ exitCode: number | null; signal: string | null }> = Promise.resolve({
		exitCode: 0,
		signal: null,
	});

	wait(): Promise<{ exitCode: number | null; signal: string | null }> {
		return this.waitResult;
	}

	async terminate(): Promise<void> {
		this.terminated++;
	}

	async close(): Promise<void> {
		this.closed++;
	}
}

class FakeVerification implements VerificationBrowserContext {
	closed = 0;
	result = Promise.resolve({
		authenticated: true,
		temporaryChat: true,
		proAvailable: true,
		profileIdentity: PROFILE.identity,
	});

	verifyTemporaryChat(): Promise<{
		authenticated: boolean;
		temporaryChat: boolean;
		proAvailable: boolean;
		profileIdentity: string;
	}> {
		return this.result;
	}

	async close(): Promise<void> {
		this.closed++;
	}
}

class FakeDriver implements LoginBrowserDriver {
	readonly interactive = new FakeInteractive();
	readonly verification = new FakeVerification();
	readonly candidates: string[] = [];
	interactiveOptions: unknown;
	verificationOptions: unknown;

	async openExecutable(candidate: string): Promise<VerifiedLoginExecutable | null> {
		this.candidates.push(candidate);
		return EXECUTABLE;
	}

	async launchInteractive(
		options: Parameters<LoginBrowserDriver["launchInteractive"]>[0],
	): Promise<InteractiveLoginProcess> {
		this.interactiveOptions = options;
		return this.interactive;
	}

	async launchVerification(
		options: Parameters<LoginBrowserDriver["launchVerification"]>[0],
	): Promise<VerificationBrowserContext> {
		this.verificationOptions = options;
		return this.verification;
	}
}

const ENVIRONMENT = { platform: "linux" as const, env: {}, home: "/home/owner" };

describe("minimal native login host", () => {
	test("uses the deterministic per-platform Chrome discovery order", () => {
		expect(
			chromeExecutableCandidates({
				platform: "win32",
				env: {
					ProgramFiles: "C:\\Attacker\\Program Files",
					"ProgramFiles(x86)": "C:\\Attacker\\Program Files (x86)",
					LOCALAPPDATA: "C:\\Attacker\\AppData\\Local",
				},
				home: "C:\\Users\\Owner",
			}),
		).toEqual([
			"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Users\\Owner\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Program Files\\Chromium\\Application\\chrome.exe",
			"C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
			"C:\\Users\\Owner\\AppData\\Local\\Chromium\\Application\\chrome.exe",
		]);
		expect(chromeExecutableCandidates(ENVIRONMENT)).toEqual([
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		]);
	});

	test("runs interactive exit before Temporary Chat verification and returns metadata only", async () => {
		const driver = new FakeDriver();
		const host = new LocalLoginHost(driver, ENVIRONMENT, () => new Date("2026-08-02T12:00:00.000Z"));
		const result = await host.login(request());
		expect(result).toEqual({
			authenticated: true,
			verifiedAt: "2026-08-02T12:00:00.000Z",
			proAvailable: true,
			profileIdentity: PROFILE.identity,
			executable: { identity: "exe-identity", sha256: SHA, version: "123.0.0" },
		});
		expect(driver.interactive.closed).toBe(1);
		expect(driver.verification.closed).toBe(1);
		expect(result).not.toHaveProperty("cookie");
		expect(result).not.toHaveProperty("token");
		expect(result).not.toHaveProperty("url");
	});

	test("passes no argv/environment secret channel to the native driver", async () => {
		const credentialCanary = "sk-credential-CANARY-high-entropy";
		const loaderCanary = "NODE_OPTIONS=--require-loader-CANARY";
		const proxyCanary = "HTTPS_PROXY=https://proxy-CANARY.invalid";
		const pathOverrideCanary = "/secret/path-override-CANARY/chrome";
		const driver = new FakeDriver();
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		await host.login(request({ executableOverride: pathOverrideCanary }));
		const launchSurface = JSON.stringify({
			interactive: driver.interactiveOptions,
			verification: driver.verificationOptions,
		});
		expect(driver.candidates).toEqual([pathOverrideCanary]);
		expect(launchSurface).not.toContain(credentialCanary);
		expect(launchSurface).not.toContain(loaderCanary);
		expect(launchSurface).not.toContain(proxyCanary);
		expect(launchSurface).not.toContain(pathOverrideCanary);
		expect(driver.interactiveOptions).not.toHaveProperty("args");
		expect(driver.interactiveOptions).not.toHaveProperty("environment");
	});

	test("closes the temporary browser on verification failure without leaking diagnostics", async () => {
		const driver = new FakeDriver();
		driver.verification.result = Promise.resolve({
			authenticated: false,
			temporaryChat: false,
			proAvailable: false,
			profileIdentity: PROFILE.identity,
		});
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const error = await host.login(request({ executableOverride: "/secret/CANARY/chrome" })).catch(value => value);
		expect(error).toBeInstanceOf(BrowserLoginError);
		expect(String(error)).not.toContain("CANARY");
		expect(driver.interactive.closed).toBe(1);
		expect(driver.verification.closed).toBe(1);
	});

	test("cancellation terminates and closes a still-running interactive browser", async () => {
		const driver = new FakeDriver();
		driver.interactive.waitResult = Promise.withResolvers<{
			exitCode: number | null;
			signal: string | null;
		}>().promise;
		const controller = new AbortController();
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const pending = host.login(request({ signal: controller.signal }));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		expect(driver.interactive.terminated).toBe(1);
		expect(driver.interactive.closed).toBe(1);
	});

	test("abnormal EOF is structured and closes the child", async () => {
		const driver = new FakeDriver();
		driver.interactive.waitResult = Promise.reject(new Error("raw child EOF /secret/CANARY"));
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const error = await host.login(request()).catch(value => value);
		expect(error).toMatchObject({ code: "abnormal-eof" });
		expect(String(error)).not.toContain("CANARY");
		expect(driver.interactive.terminated).toBe(1);
		expect(driver.interactive.closed).toBe(1);
	});

	test("rejects a concurrent login before it can acquire or close the active login resources", async () => {
		const driver = new FakeDriver();
		const firstExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const firstLaunched = Promise.withResolvers<void>();
		const siblingInteractive = new FakeInteractive();
		siblingInteractive.waitResult = Promise.resolve({ exitCode: 1, signal: null });
		driver.interactive.waitResult = firstExit.promise;
		let launches = 0;
		driver.launchInteractive = async options => {
			driver.interactiveOptions = options;
			launches++;
			if (launches === 1) {
				firstLaunched.resolve();
				return driver.interactive;
			}
			return siblingInteractive;
		};
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const first = host.login(request({ ownerFence: "1".repeat(64) }));
		await firstLaunched.promise;

		await expect(host.login(request({ ownerFence: "2".repeat(64) }))).rejects.toMatchObject({
			code: "interactive-failure",
		});
		expect(launches).toBe(1);
		expect(driver.interactive.closed).toBe(0);
		expect(driver.interactive.terminated).toBe(0);
		expect(siblingInteractive.closed).toBe(0);

		firstExit.resolve({ exitCode: 0, signal: null });
		await expect(first).resolves.toMatchObject({ authenticated: true });
		expect(driver.interactive.closed).toBe(1);
		expect(siblingInteractive.closed).toBe(0);
	});

	test("records operation ownership before invoking driver callbacks", async () => {
		const driver = new FakeDriver();
		let opens = 0;
		let siblingResult: Promise<unknown> | undefined;
		let host: LocalLoginHost;
		driver.openExecutable = async () => {
			opens++;
			if (opens === 1) {
				siblingResult = host.login(request({ ownerFence: "2".repeat(64) })).catch(error => error);
			}
			return EXECUTABLE;
		};
		host = new LocalLoginHost(driver, ENVIRONMENT);

		await expect(host.login(request({ ownerFence: "1".repeat(64) }))).resolves.toMatchObject({
			authenticated: true,
		});
		expect(siblingResult).toBeDefined();
		await expect(siblingResult).resolves.toMatchObject({ code: "interactive-failure" });
		expect(opens).toBe(1);
	});

	test("retains failed cleanup ownership until close retries it", async () => {
		const driver = new FakeDriver();
		let verificationLaunches = 0;
		let closeAttempts = 0;
		driver.launchVerification = async options => {
			driver.verificationOptions = options;
			verificationLaunches++;
			return driver.verification;
		};
		driver.verification.close = async () => {
			closeAttempts++;
			if (closeAttempts === 1) throw new Error("transient close failure");
		};
		const host = new LocalLoginHost(driver, ENVIRONMENT);

		await expect(host.login(request())).rejects.toMatchObject({ code: "interactive-failure" });
		await expect(host.login(request({ ownerFence: "2".repeat(64) }))).rejects.toMatchObject({
			code: "interactive-failure",
		});
		expect(verificationLaunches).toBe(1);
		expect(closeAttempts).toBe(1);

		await expect(host.close()).resolves.toBeUndefined();
		expect(closeAttempts).toBe(2);
	});

	test("does not launch after close while executable verification is in flight", async () => {
		const driver = new FakeDriver();
		const opened = Promise.withResolvers<VerifiedLoginExecutable | null>();
		let launches = 0;
		driver.openExecutable = async () => opened.promise;
		driver.launchInteractive = async () => {
			launches++;
			return driver.interactive;
		};
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const pending = host.login(request({ executableOverride: "/verified/chrome" }));
		const closing = host.close();
		expect(await Promise.race([closing.then(() => "closed"), Promise.resolve("pending")])).toBe("pending");
		expect(host.close()).toBe(closing);
		opened.resolve(EXECUTABLE);
		await expect(pending).rejects.toMatchObject({ code: "interactive-failure" });
		await closing;
		expect(launches).toBe(0);
	});

	test("close waits for a late interactive process and cleans it up", async () => {
		const driver = new FakeDriver();
		const launched = Promise.withResolvers<void>();
		const released = Promise.withResolvers<InteractiveLoginProcess>();
		driver.launchInteractive = async () => {
			launched.resolve();
			return released.promise;
		};
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const pending = host.login(request());
		await launched.promise;
		const closing = host.close();
		expect(await Promise.race([closing.then(() => "closed"), Promise.resolve("pending")])).toBe("pending");
		released.resolve(driver.interactive);
		await expect(pending).rejects.toMatchObject({ code: "interactive-failure" });
		await closing;
		expect(driver.interactive.terminated).toBe(1);
		expect(driver.interactive.closed).toBe(1);
	});

	test("close waits for graceful interactive cleanup without closing the process twice", async () => {
		const driver = new FakeDriver();
		const closeStarted = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		driver.interactive.close = async () => {
			driver.interactive.closed++;
			closeStarted.resolve();
			await releaseClose.promise;
		};
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const pending = host.login(request());
		await closeStarted.promise;

		const closing = host.close();
		expect(await Promise.race([closing.then(() => "closed"), Promise.resolve("pending")])).toBe("pending");
		expect(driver.interactive.closed).toBe(1);
		expect(driver.interactive.terminated).toBe(0);

		releaseClose.resolve();
		await expect(pending).rejects.toMatchObject({ code: "interactive-failure" });
		await expect(closing).resolves.toBeUndefined();
		expect(driver.interactive.closed).toBe(1);
		expect(driver.interactive.terminated).toBe(0);
	});

	test("close waits for a late verification context and closes it", async () => {
		const driver = new FakeDriver();
		const launched = Promise.withResolvers<void>();
		const released = Promise.withResolvers<VerificationBrowserContext>();
		driver.launchVerification = async () => {
			launched.resolve();
			return released.promise;
		};
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const pending = host.login(request());
		await launched.promise;
		const closing = host.close();
		expect(await Promise.race([closing.then(() => "closed"), Promise.resolve("pending")])).toBe("pending");
		released.resolve(driver.verification);
		await expect(pending).rejects.toMatchObject({ code: "interactive-failure" });
		await closing;
		expect(driver.verification.closed).toBe(1);
	});

	test("close retries a transient active-resource cleanup failure before resolving", async () => {
		const driver = new FakeDriver();
		const verificationStarted = Promise.withResolvers<void>();
		const verified = Promise.withResolvers<{
			authenticated: boolean;
			temporaryChat: boolean;
			proAvailable: boolean;
			profileIdentity: string;
		}>();
		const firstCloseAttempted = Promise.withResolvers<void>();
		let closeAttempts = 0;
		driver.verification.verifyTemporaryChat = () => {
			verificationStarted.resolve();
			return verified.promise;
		};
		driver.verification.close = async () => {
			closeAttempts++;
			firstCloseAttempted.resolve();
			if (closeAttempts === 1) throw new Error("transient close failure");
		};
		const host = new LocalLoginHost(driver, ENVIRONMENT);
		const pending = host.login(request());
		await verificationStarted.promise;

		const closing = host.close();
		await firstCloseAttempted.promise;
		verified.resolve({
			authenticated: true,
			temporaryChat: true,
			proAvailable: true,
			profileIdentity: PROFILE.identity,
		});

		await expect(pending).rejects.toMatchObject({ code: "interactive-failure" });
		await expect(closing).resolves.toBeUndefined();
		expect(closeAttempts).toBe(2);
	});
});
