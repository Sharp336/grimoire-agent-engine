import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBroker } from "../secrets/broker/broker";
import { BitwardenProvider } from "../secrets/broker/provider-bitwarden";

/**
 * Credential vault for BW_SESSION — agent 2 implementation.
 *
 * The vault is a private Map<string, string> on SecretBroker. The agent's
 * process.env MUST NOT carry BW_SESSION after the broker has been
 * initialised. The BitwardenProvider accepts an optional credentials map and
 * injects BW_SESSION from there — never from process.env — so a malicious
 * or buggy tool cannot read the live session token.
 *
 * Fail-closed (R2): if BW_SESSION is missing from both the vault and
 * process.env, resolve() throws. No silent fallback, no empty value.
 */
describe("SecretBroker credential vault", () => {
	it("setCredential → getCredential round-trips the value", () => {
		const broker = new SecretBroker();
		broker.setCredential("BW_SESSION", "abc123");
		expect(broker.getCredential("BW_SESSION")).toBe("abc123");
	});

	it("getCredential returns undefined for an unknown key", () => {
		const broker = new SecretBroker();
		expect(broker.getCredential("NOT_REGISTERED")).toBeUndefined();
	});

	it("setCredential overwrites a previous value", () => {
		const broker = new SecretBroker();
		broker.setCredential("BW_SESSION", "old");
		broker.setCredential("BW_SESSION", "new");
		expect(broker.getCredential("BW_SESSION")).toBe("new");
	});

	it("clearCredentials empties the vault", () => {
		const broker = new SecretBroker();
		broker.setCredential("BW_SESSION", "abc");
		broker.setCredential("OTHER", "def");
		broker.clearCredentials();
		expect(broker.getCredential("BW_SESSION")).toBeUndefined();
		expect(broker.getCredential("OTHER")).toBeUndefined();
	});

	it("credentials are NOT placed into process.env by any broker method", () => {
		const saved = process.env.BW_SESSION;
		delete process.env.BW_SESSION;
		try {
			const broker = new SecretBroker();
			broker.setCredential("BW_SESSION", "vault-only");
			expect(process.env.BW_SESSION).toBeUndefined();
			broker.clearCredentials();
			expect(process.env.BW_SESSION).toBeUndefined();
		} finally {
			if (saved !== undefined) process.env.BW_SESSION = saved;
		}
	});

	it("exposes the credentials map via a readonly accessor for the provider", () => {
		const broker = new SecretBroker();
		broker.setCredential("BW_SESSION", "shared");
		const vault = broker.credentials;
		expect(vault).toBeInstanceOf(Map);
		expect(vault.get("BW_SESSION")).toBe("shared");
	});
});

describe("BitwardenProvider with credential vault", () => {
	let tmpDir: string;
	let savedPath: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "bw-mock-"));
		savedPath = process.env.PATH;
		process.env.PATH = `${tmpDir}:${process.env.PATH ?? ""}`;
	});

	afterEach(() => {
		process.env.PATH = savedPath;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Install a mock `bw` that handles the given subcommands. */
	function installMockBw(script: string): void {
		const path = join(tmpDir, "bw");
		writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	}

	it("uses BW_SESSION from the credentials map, not from process.env", async () => {
		// Mock verifies the value the spawned bw process actually receives.
		installMockBw(`if [ "$BW_SESSION" = "vault-secret-token-abc" ] && [ "$1" = "get" ]; then
  printf 'resolved'
  exit 0
fi
echo "wrong session: '$BW_SESSION'" >&2
exit 3`);

		const broker = new SecretBroker();
		broker.setCredential("BW_SESSION", "vault-secret-token-abc");
		const provider = new BitwardenProvider({ credentials: broker.credentials });
		const result = await provider.resolve({ provider: "bitwarden", itemId: "x" });
		expect(result.value).toBe("resolved");
	});

	it("vault-wired provider ignores BW_SESSION in process.env (the leak fix)", async () => {
		// Mock proves the agent's leaked process.env value is NOT used when the
		// vault is wired. The provider must source BW_SESSION from the vault
		// only; a stray env var from a misconfigured operator must not reach bw.
		installMockBw(`if [ "$BW_SESSION" = "vault-wins" ]; then
  printf 'safe'
  exit 0
fi
echo "wrong session: '$BW_SESSION'" >&2
exit 3`);

		const saved = process.env.BW_SESSION;
		process.env.BW_SESSION = "leaky-process-env-value";
		try {
			const broker = new SecretBroker();
			// Deliberately register a DIFFERENT value in the vault than is in
			// process.env. The provider must use the vault value and ignore
			// process.env.
			broker.setCredential("BW_SESSION", "vault-wins");
			const provider = new BitwardenProvider({ credentials: broker.credentials });
			const result = await provider.resolve({ provider: "bitwarden", itemId: "y" });
			expect(result.value).toBe("safe");
		} finally {
			if (saved === undefined) delete process.env.BW_SESSION;
			else process.env.BW_SESSION = saved;
		}
	});

	it("fails-closed when BW_SESSION is not in the vault AND not in process.env", async () => {
		const saved = process.env.BW_SESSION;
		delete process.env.BW_SESSION;
		try {
			installMockBw(`exit 0`); // mock proves never invoked
			const provider = new BitwardenProvider();
			await expect(provider.resolve({ provider: "bitwarden", itemId: "x" })).rejects.toThrow(/BW_SESSION/);
		} finally {
			if (saved !== undefined) process.env.BW_SESSION = saved;
		}
	});

	it("vault-wired provider fails-closed when vault is empty even if process.env has BW_SESSION", async () => {
		// Critical invariant: once the vault is wired, process.env is irrelevant.
		// A leaked env var must NOT mask a missing vault registration.
		installMockBw(`exit 0`);
		const saved = process.env.BW_SESSION;
		process.env.BW_SESSION = "leaky-but-vault-wins";
		try {
			const broker = new SecretBroker();
			const provider = new BitwardenProvider({ credentials: broker.credentials });
			// broker has NO setCredential call → vault is empty for BW_SESSION.
			await expect(provider.resolve({ provider: "bitwarden", itemId: "z" })).rejects.toThrow(/BW_SESSION/);
		} finally {
			if (saved === undefined) delete process.env.BW_SESSION;
			else process.env.BW_SESSION = saved;
		}
	});

	it("after moving BW_SESSION into the vault, process.env.BW_SESSION is undefined", () => {
		const saved = process.env.BW_SESSION;
		process.env.BW_SESSION = "from-env";
		try {
			const broker = new SecretBroker();
			const envValue = process.env.BW_SESSION;
			if (envValue) {
				broker.setCredential("BW_SESSION", envValue);
				delete process.env.BW_SESSION;
			}
			expect(broker.getCredential("BW_SESSION")).toBe("from-env");
			expect(process.env.BW_SESSION).toBeUndefined();
		} finally {
			if (saved !== undefined) process.env.BW_SESSION = saved;
		}
	});

	it("isAvailable() returns false when no BW_SESSION is registered anywhere (fail-closed)", async () => {
		const saved = process.env.BW_SESSION;
		delete process.env.BW_SESSION;
		try {
			installMockBw(`exit 0`); // mock proves never invoked
			const provider = new BitwardenProvider();
			expect(await provider.isAvailable()).toBe(false);
		} finally {
			if (saved !== undefined) process.env.BW_SESSION = saved;
		}
	});

	it("isAvailable() succeeds when BW_SESSION is in the vault", async () => {
		installMockBw(`if [ "$1" = "status" ] && [ "$2" = "--raw" ] && [ -n "$BW_SESSION" ]; then
  printf '{"status":"unlocked"}'
  exit 0
fi
exit 2`);

		const broker = new SecretBroker();
		broker.setCredential("BW_SESSION", "vault-token");
		const provider = new BitwardenProvider({ credentials: broker.credentials });
		expect(await provider.isAvailable()).toBe(true);
	});

	it("clearCredentials() forces the provider back to fail-closed on next call", async () => {
		const saved = process.env.BW_SESSION;
		delete process.env.BW_SESSION;
		try {
			installMockBw(`if [ "$1" = "status" ] && [ "$2" = "--raw" ] && [ -n "$BW_SESSION" ]; then
  printf '{"status":"unlocked"}'
  exit 0
fi
exit 2`);

			const broker = new SecretBroker();
			broker.setCredential("BW_SESSION", "ephemeral");
			const provider = new BitwardenProvider({ credentials: broker.credentials });

			// With the credential registered, isAvailable should succeed.
			expect(await provider.isAvailable()).toBe(true);

			// Wipe the vault — the same provider must now fail-closed.
			broker.clearCredentials();
			expect(await provider.isAvailable()).toBe(false);
		} finally {
			if (saved !== undefined) process.env.BW_SESSION = saved;
		}
	});
});
