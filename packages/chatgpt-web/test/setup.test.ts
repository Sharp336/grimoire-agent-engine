import { describe, expect, test } from "bun:test";
import {
	type ChatGptWebExecutableIdentity,
	type ChatGptWebOwnershipRecord,
	type ChatGptWebPaths,
	type ChatGptWebProcessIdentity,
	type ChatGptWebStateName,
	decodeJson,
	encodeJson,
	type SecureConfigHost,
	type SecureEntryReference,
	type SecureExternalFile,
	type SecureReadResult,
	type SecureStateSession,
} from "../src/config";
import { setupChatGptWeb, uninstallChatGptWeb } from "../src/setup";

const OWNER: ChatGptWebOwnershipRecord = {
	version: 1,
	ownerNonce: "o".repeat(64),
	process: { pid: 11, processStartIdentity: "start-11" },
	profileGeneration: "p".repeat(64),
};

function entry(identity: string, kind: "directory" | "file" = "file"): SecureEntryReference {
	return { identity, kind, __secureEntry: Symbol("secure") } as SecureEntryReference;
}

class SetupExternalFile implements SecureExternalFile {
	readonly entry = entry("external-key");
	readonly bytes = new TextEncoder().encode("runtime-key-CANARY");
	consumed = false;
	closed = false;

	consume(): void {
		this.consumed = true;
	}

	close(): void {
		this.closed = true;
	}
}

class SetupSession implements SecureStateSession {
	readonly ownership = OWNER;
	readonly ownershipEntry = entry("ownership", "file");
	readonly ownerFence = OWNER.ownerNonce;
	readonly profile = entry("profile", "directory");
	readonly files = new Map<ChatGptWebStateName, SecureReadResult>();
	readonly external = new SetupExternalFile();
	mode: "read" | "mutate" = "mutate";
	externalFailure: Error | undefined;
	externalReplaced = false;
	destinationSwap = false;
	openExternalCalls = 0;
	removedAll = false;

	async read(name: ChatGptWebStateName): Promise<SecureReadResult | null> {
		return this.files.get(name) ?? null;
	}

	async assertCurrent(value: SecureEntryReference): Promise<void> {
		if (value === this.external.entry && this.externalReplaced) throw new Error("source identity changed");
	}

	async verifyExecutable(_identity: ChatGptWebExecutableIdentity): Promise<boolean> {
		return true;
	}

	async openExternalOwnerFile(_path: string): Promise<SecureExternalFile> {
		this.openExternalCalls++;
		if (this.externalFailure) throw this.externalFailure;
		return this.external;
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

	async importAtomic(
		name: "runtime-key",
		source: SecureExternalFile,
		expectedDestinationIdentity: string | null,
	): Promise<SecureEntryReference> {
		if (this.destinationSwap) {
			this.files.set(name, { entry: entry("attacker-destination"), bytes: new Uint8Array([1]) });
		}
		const current = this.files.get(name);
		if ((current?.entry.identity ?? null) !== expectedDestinationIdentity) throw new Error("destination changed");
		const replacement = entry("runtime-key-new");
		this.files.set(name, { entry: replacement, bytes: source.bytes.slice() });
		return replacement;
	}

	async removeAtomic(name: ChatGptWebStateName, expectedIdentity: string): Promise<void> {
		if (this.files.get(name)?.entry.identity !== expectedIdentity) throw new Error("destination changed");
		this.files.delete(name);
	}

	async removeAllOwnedState(): Promise<void> {
		this.removedAll = true;
		this.files.clear();
	}

	async close(): Promise<void> {}
}

class SetupHost implements SecureConfigHost {
	available = true;
	readonly session = new SetupSession();

	async currentProcessIdentity(): Promise<ChatGptWebProcessIdentity> {
		return { pid: 11, processStartIdentity: "start-11" };
	}

	async openState(
		_paths: ChatGptWebPaths,
		options: { readonly mode: "read" | "mutate" },
	): Promise<SecureStateSession> {
		this.session.mode = options.mode;
		return this.session;
	}
}

describe("ChatGPT Web setup", () => {
	test("browser-only mode stores no tunnel or runtime-key state and removes an old key", async () => {
		const host = new SetupHost();
		host.session.files.set("runtime-key", { entry: entry("old-key"), bytes: new Uint8Array([1, 2, 3]) });
		const result = await setupChatGptWeb({ mode: "browser-only", agentDir: "/secure/agent", secureHost: host });
		expect(result.config).toEqual({ mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false });
		expect(decodeJson(host.session.files.get("config.json")?.bytes ?? new Uint8Array())).toEqual(result.config);
		expect(host.session.files.has("runtime-key")).toBe(false);
	});

	test("full mode imports a held owner-only file and stores only opaque configuration", async () => {
		const host = new SetupHost();
		const tunnelId = `tunnel_${"a".repeat(32)}`;
		const result = await setupChatGptWeb({
			mode: "full",
			tunnelId,
			runtimeKeyFile: "/owner/input/runtime-key",
			agentDir: "/secure/agent",
			secureHost: host,
		});
		expect(result.config).toEqual({ mode: "full", tunnelId, runtimeKeyConfigured: true });
		expect(host.session.external.consumed).toBe(true);
		expect(host.session.external.closed).toBe(true);
		expect(new TextDecoder().decode(host.session.files.get("runtime-key")?.bytes)).toBe("runtime-key-CANARY");
		const configText = new TextDecoder().decode(host.session.files.get("config.json")?.bytes);
		expect(configText).not.toContain("/owner/input/runtime-key");
		expect(configText).not.toContain("runtime-key-CANARY");
	});

	test("rejects URLs and non-allowlisted tunnel identifiers before opening a key", async () => {
		for (const tunnelId of [
			"https://attacker.invalid/tunnel",
			"tunnel_ABCDEF0123456789ABCDEF0123456789",
			"tunnel_short",
			"../tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		]) {
			const host = new SetupHost();
			await expect(
				setupChatGptWeb({
					mode: "full",
					tunnelId,
					runtimeKeyFile: "/owner/runtime-key",
					agentDir: "/secure/agent",
					secureHost: host,
				}),
			).rejects.toThrow("allowlisted opaque");
			expect(host.session.openExternalCalls).toBe(0);
		}
	});

	for (const boundary of ["missing file", "non-owner file", "broad ACL", "inherited ACL", "reparse point"] as const) {
		test(`rejects a ${boundary} runtime key without importing bytes`, async () => {
			const host = new SetupHost();
			host.session.externalFailure = new Error(boundary);
			await expect(
				setupChatGptWeb({
					mode: "full",
					tunnelId: `tunnel_${"b".repeat(32)}`,
					runtimeKeyFile: "/owner/runtime-key",
					agentDir: "/secure/agent",
					secureHost: host,
				}),
			).rejects.toThrow(boundary);
			expect(host.session.files.has("runtime-key")).toBe(false);
		});
	}

	test("refuses source replacement and destination swaps", async () => {
		const replacedSource = new SetupHost();
		replacedSource.session.externalReplaced = true;
		await expect(
			setupChatGptWeb({
				mode: "full",
				tunnelId: `tunnel_${"c".repeat(32)}`,
				runtimeKeyFile: "/owner/runtime-key",
				agentDir: "/secure/agent",
				secureHost: replacedSource,
			}),
		).rejects.toThrow("source identity changed");

		const swappedDestination = new SetupHost();
		swappedDestination.session.files.set("runtime-key", {
			entry: entry("old-destination"),
			bytes: new Uint8Array([1]),
		});
		swappedDestination.session.destinationSwap = true;
		await expect(
			setupChatGptWeb({
				mode: "full",
				tunnelId: `tunnel_${"d".repeat(32)}`,
				runtimeKeyFile: "/owner/runtime-key",
				agentDir: "/secure/agent",
				secureHost: swappedDestination,
			}),
		).rejects.toThrow("destination changed");
	});

	test("uninstall delegates only package-owned deletion while the mutation lock is held", async () => {
		const host = new SetupHost();
		host.session.files.set("config.json", {
			entry: entry("config"),
			bytes: encodeJson({ mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false }),
		});
		await uninstallChatGptWeb({ agentDir: "/secure/agent", secureHost: host });
		expect(host.session.removedAll).toBe(true);
		expect(host.session.files.size).toBe(0);
	});
});
