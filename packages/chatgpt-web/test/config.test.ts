import { describe, expect, test } from "bun:test";
import {
	type ChatGptWebOwnershipRecord,
	type ChatGptWebPaths,
	type ChatGptWebProcessIdentity,
	type ChatGptWebStateName,
	decodeJson,
	encodeJson,
	NativeSecurityUnavailableError,
	openChatGptWebState,
	parseChatGptWebOwnership,
	readChatGptWebConfig,
	resolveChatGptWebPaths,
	type SecureConfigHost,
	type SecureEntryReference,
	type SecureExternalFile,
	type SecureReadResult,
	type SecureStateSession,
} from "../src/config";

const OWNER: ChatGptWebOwnershipRecord = {
	version: 1,
	ownerNonce: "a".repeat(64),
	process: { pid: 42, processStartIdentity: "start-42" },
	profileGeneration: "b".repeat(64),
};

function entry(identity: string, kind: "directory" | "file" = "file"): SecureEntryReference {
	return { identity, kind, __secureEntry: Symbol("secure") } as SecureEntryReference;
}

class FakeSession implements SecureStateSession {
	readonly ownership = OWNER;
	readonly ownershipEntry = entry("ownership-1");
	readonly ownerFence = OWNER.ownerNonce;
	readonly profile = entry("profile-1", "directory");
	readonly files = new Map<ChatGptWebStateName, SecureReadResult>();
	mode: "read" | "mutate" = "read";
	swapDestination = false;
	swapProfile = false;
	closed = false;

	async read(name: ChatGptWebStateName): Promise<SecureReadResult | null> {
		return this.files.get(name) ?? null;
	}

	async assertCurrent(value: SecureEntryReference): Promise<void> {
		if (this.swapProfile && value === this.profile) throw new Error("profile identity changed");
	}

	async verifyExecutable(): Promise<boolean> {
		return true;
	}

	async openExternalOwnerFile(): Promise<SecureExternalFile> {
		throw new Error("not used");
	}

	async replaceAtomic(
		name: ChatGptWebStateName,
		bytes: Uint8Array,
		expectedDestinationIdentity: string | null,
	): Promise<SecureEntryReference> {
		if (this.swapDestination) {
			this.files.set(name, { entry: entry("attacker-swap"), bytes: encodeJson({}) });
		}
		const current = this.files.get(name);
		if ((current?.entry.identity ?? null) !== expectedDestinationIdentity) {
			throw new Error("destination identity changed");
		}
		const replacement = entry(`replacement-${name}`);
		this.files.set(name, { entry: replacement, bytes });
		return replacement;
	}

	async importAtomic(): Promise<SecureEntryReference> {
		throw new Error("not used");
	}

	async removeAtomic(): Promise<void> {
		throw new Error("not used");
	}

	async removeAllOwnedState(): Promise<void> {
		this.files.clear();
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeHost implements SecureConfigHost {
	available = true;
	readonly session = new FakeSession();
	failure: Error | undefined;
	capturedPaths: ChatGptWebPaths | undefined;
	capturedProcess: ChatGptWebProcessIdentity = { pid: 7, processStartIdentity: "start-7" };

	async currentProcessIdentity(): Promise<ChatGptWebProcessIdentity> {
		return this.capturedProcess;
	}

	async openState(
		paths: ChatGptWebPaths,
		options: { readonly mode: "read" | "mutate"; readonly proposedOwnership?: ChatGptWebOwnershipRecord },
	): Promise<SecureStateSession> {
		if (this.failure) throw this.failure;
		this.capturedPaths = paths;
		this.session.mode = options.mode;
		return this.session;
	}
}

describe("secure ChatGPT Web configuration", () => {
	test("normalizes Windows case and rejects traversal before any filesystem access", () => {
		const upper = resolveChatGptWebPaths("C:\\Users\\Owner\\OMP");
		const lower = resolveChatGptWebPaths("c:\\users\\owner\\omp");
		expect(upper).toEqual(lower);
		expect(upper.root).toBe("c:\\users\\owner\\omp\\chatgpt-web");
		expect(() => resolveChatGptWebPaths("C:\\Users\\Owner\\..\\Other")).toThrow("Invalid");
		expect(() => resolveChatGptWebPaths("/home/owner/../other")).toThrow("Invalid");
		expect(() => resolveChatGptWebPaths("relative/root")).toThrow("absolute");
	});

	test("returns every package-owned path without placing state outside its root", () => {
		const paths = resolveChatGptWebPaths("/home/owner/.omp/agent");
		expect(paths).toEqual({
			agentDir: "/home/owner/.omp/agent",
			root: "/home/owner/.omp/agent/chatgpt-web",
			config: "/home/owner/.omp/agent/chatgpt-web/config.json",
			controlToken: "/home/owner/.omp/agent/chatgpt-web/control-token",
			runtimeKey: "/home/owner/.omp/agent/chatgpt-web/runtime-key",
			browserProfile: "/home/owner/.omp/agent/chatgpt-web/browser-profile",
			ownership: "/home/owner/.omp/agent/chatgpt-web/ownership",
			verification: "/home/owner/.omp/agent/chatgpt-web/verification.json",
			logs: "/home/owner/.omp/agent/chatgpt-web/logs",
			evidence: "/home/owner/.omp/agent/chatgpt-web/local-evidence",
		});
	});

	test("fails closed when the native security host is unavailable", async () => {
		await expect(openChatGptWebState({ mode: "read" })).rejects.toBeInstanceOf(NativeSecurityUnavailableError);
	});
	test("treats an absent native state root as an unconfigured profile", async () => {
		const host = new FakeHost();
		host.failure = new Error("native-open-error-2: The system cannot find the file specified. (os error 2)");
		await expect(readChatGptWebConfig({ agentDir: "/secure/agent", host })).resolves.toBeNull();
	});

	for (const boundary of [
		"POSIX symlink root",
		"POSIX symlink child",
		"Windows junction root",
		"Windows reparse child",
		"POSIX non-owner mode",
		"Windows broad ACL",
		"Windows inherited ACL",
	] as const) {
		test(`propagates native rejection for ${boundary}`, async () => {
			const host = new FakeHost();
			host.failure = new Error(boundary);
			await expect(openChatGptWebState({ agentDir: "/secure/agent", host, mode: "read" })).rejects.toThrow(boundary);
		});
	}

	test("requires PID plus start identity and propagates owner-lock contention", async () => {
		expect(() =>
			parseChatGptWebOwnership({
				...OWNER,
				process: { pid: 42, processStartIdentity: "" },
			}),
		).toThrow();
		const host = new FakeHost();
		host.failure = new Error("owner lock contention: live PID/start identity");
		await expect(openChatGptWebState({ agentDir: "/secure/agent", host, mode: "mutate" })).rejects.toThrow(
			"contention",
		);
	});

	test("reads only atomically opened configuration and rechecks its identity", async () => {
		const host = new FakeHost();
		host.session.files.set("config.json", {
			entry: entry("config-v1"),
			bytes: encodeJson({ mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false }),
		});
		expect(await readChatGptWebConfig({ agentDir: "/secure/agent", host })).toEqual({
			mode: "browser-only",
			tunnelId: null,
			runtimeKeyConfigured: false,
		});
		expect(host.session.closed).toBe(true);
	});

	test("refuses destination swaps during atomic replacement", async () => {
		const host = new FakeHost();
		host.session.mode = "mutate";
		host.session.files.set("config.json", { entry: entry("config-v1"), bytes: encodeJson({}) });
		host.session.swapDestination = true;
		await expect(host.session.replaceAtomic("config.json", encodeJson({ safe: true }), "config-v1")).rejects.toThrow(
			"destination identity changed",
		);
		expect(decodeJson(host.session.files.get("config.json")?.bytes ?? new Uint8Array())).toEqual({});
	});

	test("refuses a profile identity swap after secure open", async () => {
		const host = new FakeHost();
		host.session.swapProfile = true;
		await expect(openChatGptWebState({ agentDir: "/secure/agent", host, mode: "read" })).rejects.toThrow(
			"profile identity changed",
		);
		expect(host.session.closed).toBe(true);
	});
});
