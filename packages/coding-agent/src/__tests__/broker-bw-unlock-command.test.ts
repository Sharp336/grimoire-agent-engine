import { describe, expect, it } from "bun:test";
import { SecretBroker } from "../secrets/broker/broker";
import {
	type BwUnlockNotifier,
	type BwPasswordPrompt,
	createSecretBrokerExtension,
	runBwUnlock,
} from "../secrets/broker/secret-broker-extension";

/**
 * `/bw-unlock` slash command — unlocks Bitwarden via the TUI password dialog
 * and stores the session token in the broker credential vault.
 *
 * The whole point of the vault (vs `process.env`): the token never enters the
 * agent's environment, so a malicious model cannot `env | grep BW_SESSION` to
 * exfiltrate it. The unlock path must:
 *
 *   - ask the user for the master password via `ctx.ui.input` (masked, paste-capable)
 *   - pipe the password to `bw unlock` over stdin (bw reads from stdin when not a TTY)
 *   - extract the session token from `bw unlock` stdout
 *   - store it in the broker vault — never in process.env, never on disk
 *
 * The `bw` subprocess is spawned through a stubbed `spawn` injected via the
 * Bun test harness — we patch `globalThis.Bun.spawn` per test.
 */

const TOKEN_BASH = "bash-token-AAAA-BBBB-CCCC-DDDD==";
const TOKEN_PS = "ps-token-AAAA-BBBB-CCCC-DDDD==";
const TOKEN_FISH = "fishtoken-XXYYZZ==";

function makeNotify() {
	const messages: string[] = [];
	const notify: BwUnlockNotifier = msg => messages.push(msg);
	return { notify, messages };
}

function makePrompt(password: string | undefined): BwPasswordPrompt {
	return async () => password;
}

/** SpawnFn stub that returns canned output synchronously. */
function makeSpawnFn(
	stdout: string,
	exitCode = 0,
): (opts: {
	bwPath: string;
	password: string;
	timeoutMs: number;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return async () => ({ exitCode, stdout, stderr: "" });
}

describe("/bw-unlock command", () => {
	it("is registered by the extension factory under the name 'bw-unlock'", () => {
		const broker = new SecretBroker();
		const commands = new Map<string, unknown>();
		const api = {
			registerTool: () => {},
			registerCommand: (name: string, def: unknown) => commands.set(name, def),
			// No-op event bus — the factory registers a `context` handler (Phase A1).
			on: () => {},
		};
		const factory = createSecretBrokerExtension(broker);
		factory(api as never);
		expect(commands.has("bw-unlock")).toBe(true);
	});

	it("captures BW_SESSION from bash-style export and stores it in the vault", async () => {
		const broker = new SecretBroker();
		const { notify, messages } = makeNotify();
		const spawnFn = makeSpawnFn(`Your vault is now unlocked!\n\n$ export BW_SESSION="${TOKEN_BASH}"\n`);

		const result = await runBwUnlock({
			broker,
			prompt: makePrompt("master-password"),
			notify,
			bwPath: "bw",
			spawnFn,
		});

		expect(result.ok).toBe(true);
		expect(result.tokenLength).toBe(TOKEN_BASH.length);
		expect(result).not.toHaveProperty("token");
		expect(broker.getCredential("BW_SESSION")).toBe(TOKEN_BASH);
		expect(messages.join("\n")).not.toContain(TOKEN_BASH); // never echo the raw token
	});

	it("captures BW_SESSION from PowerShell $env: format", async () => {
		const broker = new SecretBroker();
		const { notify } = makeNotify();
		const spawnFn = makeSpawnFn(`> $env:BW_SESSION="${TOKEN_PS}"`);

		const result = await runBwUnlock({ broker, prompt: makePrompt("pw"), notify, spawnFn });
		expect(result.ok).toBe(true);
		expect(broker.getCredential("BW_SESSION")).toBe(TOKEN_PS);
	});

	it("captures BW_SESSION from fish `set -x` format", async () => {
		const broker = new SecretBroker();
		const { notify } = makeNotify();
		const spawnFn = makeSpawnFn(`set -x BW_SESSION "${TOKEN_FISH}"`);

		const result = await runBwUnlock({ broker, prompt: makePrompt("pw"), notify, spawnFn });
		expect(result.ok).toBe(true);
		expect(broker.getCredential("BW_SESSION")).toBe(TOKEN_FISH);
	});

	it("does NOT write to the vault when exit code is non-zero", async () => {
		const broker = new SecretBroker();
		const { notify, messages } = makeNotify();
		const spawnFn = makeSpawnFn("ERROR decryption failed", 1);

		const result = await runBwUnlock({ broker, prompt: makePrompt("wrong-pw"), notify, spawnFn });
		expect(result.ok).toBe(false);
		expect(broker.getCredential("BW_SESSION")).toBeUndefined();
		expect(messages.join("\n")).toContain("wrong master password");
	});

	it("does NOT write to the vault when no BW_SESSION line appears in output", async () => {
		const broker = new SecretBroker();
		const { notify, messages } = makeNotify();
		const spawnFn = makeSpawnFn("Your vault is now unlocked! (no session line)");

		const result = await runBwUnlock({ broker, prompt: makePrompt("pw"), notify, spawnFn });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("no_token");
		expect(broker.getCredential("BW_SESSION")).toBeUndefined();
	});

	it("handles cancelled prompt gracefully — vault stays empty", async () => {
		const broker = new SecretBroker();
		const { notify, messages } = makeNotify();

		const result = await runBwUnlock({ broker, prompt: makePrompt(undefined), notify });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("cancelled");
		expect(broker.getCredential("BW_SESSION")).toBeUndefined();
		expect(messages.join("\n")).toContain("cancelled");
	});

	it("vault stores the new value even if it already had an old BW_SESSION", async () => {
		const broker = new SecretBroker();
		broker.setCredential("BW_SESSION", "old-stale-session");
		const { notify } = makeNotify();
		const spawnFn = makeSpawnFn(`$ export BW_SESSION="${TOKEN_BASH}"`);

		const result = await runBwUnlock({ broker, prompt: makePrompt("pw"), notify, spawnFn });
		expect(result.ok).toBe(true);
		expect(broker.getCredential("BW_SESSION")).toBe(TOKEN_BASH);
	});

	it("process.env.BW_SESSION is NEVER set by runBwUnlock (no env leak)", async () => {
		const broker = new SecretBroker();
		const { notify } = makeNotify();
		const spawnFn = makeSpawnFn(`$ export BW_SESSION="${TOKEN_BASH}"`);

		delete process.env.BW_SESSION;
		await runBwUnlock({ broker, prompt: makePrompt("pw"), notify, spawnFn });
		expect(process.env.BW_SESSION).toBeUndefined();
	});
});
