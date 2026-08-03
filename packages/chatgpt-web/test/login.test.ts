import { describe, expect, test } from "bun:test";
import { hasChatGptWebLogin, loginChatGptWeb, readChatGptWebLoginStatus } from "../src/browser/login";
import type { BrowserLoginRequest, BrowserLoginResult, LoginHost } from "../src/browser/login-host";
import {
	type ChatGptWebExecutableIdentity,
	type ChatGptWebOwnershipRecord,
	type ChatGptWebPaths,
	type ChatGptWebProcessIdentity,
	type ChatGptWebStateName,
	type ChatGptWebVerificationMarker,
	decodeJson,
	encodeJson,
	type SecureConfigHost,
	type SecureEntryReference,
	type SecureExternalFile,
	type SecureReadResult,
	type SecureStateSession,
} from "../src/config";

const OWNER: ChatGptWebOwnershipRecord = {
	version: 1,
	ownerNonce: "f".repeat(64),
	process: { pid: 9, processStartIdentity: "start-9" },
	profileGeneration: "g".repeat(64),
};
const EXECUTABLE: ChatGptWebExecutableIdentity = {
	identity: "executable-identity",
	sha256: "a".repeat(64),
	version: "125.0.1",
};
const NOW = Date.parse("2026-08-02T12:00:00.000Z");

function entry(identity: string, kind: "directory" | "file" = "file"): SecureEntryReference {
	return { identity, kind, __secureEntry: Symbol("secure") } as SecureEntryReference;
}

class LoginSession implements SecureStateSession {
	readonly ownership = OWNER;
	readonly ownershipEntry = entry("ownership-identity");
	readonly ownerFence = OWNER.ownerNonce;
	readonly profile = entry("profile-identity", "directory");
	readonly files = new Map<ChatGptWebStateName, SecureReadResult>();
	mode: "read" | "mutate" = "read";
	executableValid = true;
	redirectedMarker = false;
	swappedEntryIdentity: string | undefined;
	profileSwapped = false;
	closed = 0;

	constructor() {
		this.files.set("config.json", {
			entry: entry("config-v1"),
			bytes: encodeJson({ mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false }),
		});
	}

	async read(name: ChatGptWebStateName): Promise<SecureReadResult | null> {
		if (name === "verification.json" && this.redirectedMarker) throw new Error("redirected marker");
		return this.files.get(name) ?? null;
	}

	async assertCurrent(value: SecureEntryReference): Promise<void> {
		if (value === this.profile && this.profileSwapped) throw new Error("profile replaced");
		if (this.swappedEntryIdentity === value.identity) throw new Error("entry replaced");
	}

	async verifyExecutable(): Promise<boolean> {
		return this.executableValid;
	}

	async openExternalOwnerFile(): Promise<SecureExternalFile> {
		throw new Error("not used");
	}

	async replaceAtomic(
		name: ChatGptWebStateName,
		bytes: Uint8Array,
		expectedDestinationIdentity: string | null,
	): Promise<SecureEntryReference> {
		const current = this.files.get(name);
		if ((current?.entry.identity ?? null) !== expectedDestinationIdentity) throw new Error("destination changed");
		const replacement = entry(`${name}-new`);
		this.files.set(name, { entry: replacement, bytes });
		return replacement;
	}

	async importAtomic(): Promise<SecureEntryReference> {
		throw new Error("not used");
	}

	async removeAtomic(name: ChatGptWebStateName, expectedIdentity: string): Promise<void> {
		if (this.files.get(name)?.entry.identity !== expectedIdentity) throw new Error("destination changed");
		this.files.delete(name);
	}

	async removeAllOwnedState(): Promise<void> {
		this.files.clear();
	}

	async close(): Promise<void> {
		this.closed++;
	}
}

class LoginSecureHost implements SecureConfigHost {
	available = true;
	readonly session = new LoginSession();

	async currentProcessIdentity(): Promise<ChatGptWebProcessIdentity> {
		return { pid: 9, processStartIdentity: "start-9" };
	}

	async openState(
		_paths: ChatGptWebPaths,
		options: { readonly mode: "read" | "mutate" },
	): Promise<SecureStateSession> {
		this.session.mode = options.mode;
		return this.session;
	}
}

class FakeLoginHost implements LoginHost {
	closed = 0;
	failure: Error | undefined;
	closeFailure: Error | undefined;
	capturedRequest: BrowserLoginRequest | undefined;
	result: BrowserLoginResult = {
		authenticated: true,
		verifiedAt: "2026-08-02T12:00:00.000Z",
		proAvailable: true,
		profileIdentity: "profile-identity",
		executable: EXECUTABLE,
	};

	async login(request: BrowserLoginRequest): Promise<BrowserLoginResult> {
		this.capturedRequest = request;
		if (this.failure) throw this.failure;
		return this.result;
	}

	async close(): Promise<void> {
		this.closed++;
		if (this.closeFailure) throw this.closeFailure;
	}
}

function marker(overrides: Partial<ChatGptWebVerificationMarker> = {}): ChatGptWebVerificationMarker {
	return {
		version: 1,
		authenticated: true,
		verifiedAt: "2026-08-02T12:00:00.000Z",
		proAvailable: true,
		profileGeneration: OWNER.profileGeneration,
		profileIdentity: "profile-identity",
		executable: EXECUTABLE,
		ownerFence: OWNER.ownerNonce,
		...overrides,
	};
}

function putMarker(host: LoginSecureHost, value: unknown, identity = "marker-v1"): void {
	host.session.files.set("verification.json", { entry: entry(identity), bytes: encodeJson(value) });
}

describe("ChatGPT Web login persistence", () => {
	test("writes only a versioned generation/fence-bound marker after host close", async () => {
		const secureHost = new LoginSecureHost();
		const loginHost = new FakeLoginHost();
		const status = await loginChatGptWeb({ agentDir: "/secure/agent", secureHost, loginHost });
		expect(status).toEqual({
			authenticated: true,
			proAvailable: true,
			verifiedAt: "2026-08-02T12:00:00.000Z",
		});
		expect(loginHost.closed).toBe(1);
		expect(loginHost.capturedRequest).toMatchObject({
			profileGeneration: OWNER.profileGeneration,
			ownerFence: OWNER.ownerNonce,
			headed: true,
		});
		const stored = secureHost.session.files.get("verification.json");
		expect(decodeJson(stored?.bytes ?? new Uint8Array())).toEqual(marker());
		const serialized = new TextDecoder().decode(stored?.bytes);
		expect(serialized).not.toContain("cookie");
		expect(serialized).not.toContain("token");
		expect(serialized).not.toContain("/secure/agent");
	});

	test("failure and cancellation close the host and leave no partial marker", async () => {
		for (const failure of [new Error("verification failed CANARY"), new DOMException("cancelled", "AbortError")]) {
			const secureHost = new LoginSecureHost();
			putMarker(secureHost, marker());
			const loginHost = new FakeLoginHost();
			loginHost.failure = failure;
			await expect(loginChatGptWeb({ agentDir: "/secure/agent", secureHost, loginHost })).rejects.toBe(failure);
			expect(loginHost.closed).toBe(1);
			expect(secureHost.session.files.has("verification.json")).toBe(false);
		}
	});

	test("browser cleanup failure prevents marker issuance but still releases the owner session", async () => {
		const secureHost = new LoginSecureHost();
		const loginHost = new FakeLoginHost();
		loginHost.closeFailure = new Error("browser close failed");
		await expect(loginChatGptWeb({ agentDir: "/secure/agent", secureHost, loginHost })).rejects.toThrow(
			"browser close failed",
		);
		expect(secureHost.session.files.has("verification.json")).toBe(false);
		expect(secureHost.session.closed).toBe(1);
	});

	test("accepts a fresh marker only after marker, profile, fence, and executable identity rechecks", async () => {
		const secureHost = new LoginSecureHost();
		putMarker(secureHost, marker());
		expect(await hasChatGptWebLogin({ agentDir: "/secure/agent", secureHost, now: NOW })).toBe(true);
		expect(await readChatGptWebLoginStatus({ agentDir: "/secure/agent", secureHost, now: NOW })).toEqual({
			authenticated: true,
			proAvailable: true,
			verifiedAt: "2026-08-02T12:00:00.000Z",
		});
	});

	test("rejects corrupt, stale, redirected, tampered, generation, profile, fence, and executable mismatches", async () => {
		const cases: Array<(host: LoginSecureHost) => void> = [
			host =>
				host.session.files.set("verification.json", {
					entry: entry("marker"),
					bytes: new TextEncoder().encode("{"),
				}),
			host => putMarker(host, marker({ verifiedAt: "2026-07-20T00:00:00.000Z" })),
			host => {
				host.session.redirectedMarker = true;
			},
			host => putMarker(host, { ...marker(), cookie: "secret" }),
			host => putMarker(host, marker({ profileGeneration: "x".repeat(64) })),
			host => putMarker(host, marker({ profileIdentity: "replaced-profile" })),
			host => putMarker(host, marker({ ownerFence: "x".repeat(64) })),
			host => {
				putMarker(host, marker());
				host.session.executableValid = false;
			},
			host => {
				putMarker(host, marker());
				host.session.profileSwapped = true;
			},
			host => {
				putMarker(host, marker(), "marker-swapped");
				host.session.swappedEntryIdentity = "marker-swapped";
			},
		];
		for (const mutate of cases) {
			const host = new LoginSecureHost();
			mutate(host);
			expect(await hasChatGptWebLogin({ agentDir: "/secure/agent", secureHost: host, now: NOW })).toBe(false);
			expect(host.session.closed).toBe(1);
		}
	});
});
