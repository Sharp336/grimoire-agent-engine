import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BitwardenProvider } from "../secrets/broker/provider-bitwarden";

/**
 * Tier-2 Task 2: Bitwarden provider adapter.
 *
 * The provider resolves a {@link SecretHandle} to a {@link SecretValue} by
 * shelling out to the `bw` CLI in array-form argv (never `bash -c`). These
 * tests mock `bw` with a temporary shell script prepended to PATH.
 *
 * The credential-vault wiring (agent 2) requires `BW_SESSION` to be sourced
 * from either the broker's vault or `process.env`. The tests below exercise
 * the LEGACY path (no vault, `BW_SESSION` in `process.env`); the vault-aware
 * path is covered by `broker-credential-vault.test.ts`.
 */
describe("Tier-2 Task 2: BitwardenProvider (legacy path)", () => {
	let tmpDir: string;
	let savedPath: string | undefined;
	let savedBwSession: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "bw-mock-"));
		savedPath = process.env.PATH;
		savedBwSession = process.env.BW_SESSION;
		// Prepend tmpDir so our mock `bw` shadows any real install.
		process.env.PATH = `${tmpDir}:${process.env.PATH ?? ""}`;
		// Provide a session so the provider does not fail-closed. The mock `bw`
		// scripts do not check the value — they only assert argv — so any
		// non-empty string works. Tests that exercise the "no session" path
		// delete this in their own setup.
		process.env.BW_SESSION = "test-session-legacy";
	});

	afterEach(() => {
		process.env.PATH = savedPath;
		if (savedBwSession === undefined) delete process.env.BW_SESSION;
		else process.env.BW_SESSION = savedBwSession;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Install a mock `bw` that handles the given subcommands. */
	function installMockBw(script: string): void {
		const path = join(tmpDir, "bw");
		writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	}

	it("resolve() returns SecretValue with the correct value from `bw get`", async () => {
		installMockBw(`if [ "$1" = "get" ] && [ "$2" = "password" ] && [ "$3" = "test-id" ] && [ "$4" = "--raw" ]; then
  printf 'super-secret-value-1234'
  exit 0
fi
echo "unexpected args: $*" >&2
exit 2`);

		const provider = new BitwardenProvider();
		const result = await provider.resolve({ provider: "bitwarden", itemId: "test-id" });
		expect(result.handle.itemId).toBe("test-id");
		expect(result.value).toBe("super-secret-value-1234");
	});

	it("resolve() uses handle.field when provided", async () => {
		installMockBw(`if [ "$1" = "get" ] && [ "$2" = "totp" ] && [ "$3" = "item-7" ] && [ "$4" = "--raw" ]; then
  printf '123456'
  exit 0
fi
exit 2`);

		const provider = new BitwardenProvider();
		const result = await provider.resolve({ provider: "bitwarden", itemId: "item-7", field: "totp" });
		expect(result.value).toBe("123456");
	});

	it("resolve() fails-closed (throws) when `bw get` exits non-zero", async () => {
		installMockBw(`echo "item not found" >&2
exit 1`);

		const provider = new BitwardenProvider();
		expect(provider.resolve({ provider: "bitwarden", itemId: "missing-id" })).rejects.toThrow();
	});

	it("resolve() rejects a wrong provider name", async () => {
		installMockBw(`exit 0`);
		const provider = new BitwardenProvider();
		expect(provider.resolve({ provider: "infisical", itemId: "test-id" })).rejects.toThrow(/bitwarden/i);
	});

	it("isAvailable() returns true when `bw status` shows 'unlocked'", async () => {
		installMockBw(`if [ "$1" = "status" ] && [ "$2" = "--raw" ]; then
  printf '{"status":"unlocked"}'
  exit 0
fi
exit 2`);

		const provider = new BitwardenProvider();
		expect(await provider.isAvailable()).toBe(true);
	});

	it("isAvailable() returns false when `bw status` shows 'locked'", async () => {
		installMockBw(`if [ "$1" = "status" ] && [ "$2" = "--raw" ]; then
  printf '{"status":"locked"}'
  exit 0
fi
exit 2`);

		const provider = new BitwardenProvider();
		expect(await provider.isAvailable()).toBe(false);
	});

	it("isAvailable() returns false when `bw` is not in PATH", async () => {
		// No mock installed — but ensure no real `bw` interferes: set PATH to only a dir without bw.
		const emptyDir = mkdtempSync(join(tmpdir(), "bw-empty-"));
		const saved = process.env.PATH;
		process.env.PATH = emptyDir;
		try {
			const provider = new BitwardenProvider();
			expect(await provider.isAvailable()).toBe(false);
		} finally {
			process.env.PATH = saved;
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});

	it("name is 'bitwarden'", () => {
		expect(new BitwardenProvider().name).toBe("bitwarden");
	});
});
