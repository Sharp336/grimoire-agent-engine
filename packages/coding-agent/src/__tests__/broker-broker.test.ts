import { describe, expect, it } from "bun:test";
import { SecretBroker } from "../secrets/broker/broker";
import type { ExecResult, SecretHandle, SecretValue, VaultProvider } from "../secrets/broker/types";

/** A mock provider whose resolution is fully controlled by the test. */
class MockProvider implements VaultProvider {
	readonly name: string;
	readonly #resolveImpl: (handle: SecretHandle) => Promise<SecretValue>;

	constructor(name: string, resolveImpl: (handle: SecretHandle) => Promise<SecretValue>) {
		this.name = name;
		this.#resolveImpl = resolveImpl;
	}

	resolve(handle: SecretHandle): Promise<SecretValue> {
		return this.#resolveImpl(handle);
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}
}

/**
 * Tier-2 Task 5: SecretBroker.
 *
 * The broker resolves a handle via a provider, spawns a subprocess with the
 * resolved value injected into a hardened env, scrubs stdout/stderr of the
 * resolved value, and returns a typed ExecResult. The agent never holds the
 * raw secret. Fail-closed (R2): unknown provider or resolution failure yields
 * an error ExecResult, never a raw value.
 */
describe("Tier-2 Task 5: SecretBroker", () => {
	const RAW_SECRET = "super-secret-value-1234";

	it("runWithSecret injects the secret into the subprocess env and scrubs it from stdout", async () => {
		const provider = new MockProvider("mock", async handle => ({
			handle,
			value: RAW_SECRET,
		}));
		const broker = new SecretBroker();
		broker.registerProvider(provider);

		// `env` prints KEY=VALUE lines; the broker must redact the value, keep the key.
		const result = await broker.runWithSecret({
			handle: { provider: "mock", itemId: "x" },
			command: "env",
			args: [],
			envKey: "MY_SECRET",
		});

		expect(result.exitCode).toBe(0);
		// The env key is visible, but the value must be redacted.
		expect(result.stdout).toContain("MY_SECRET=");
		expect(result.stdout).toContain("[REDACTED]");
		expect(result.stdout).not.toContain(RAW_SECRET);
	});

	it("unknown provider → exitCode -1, error in stderr", async () => {
		const broker = new SecretBroker();
		const result = await broker.runWithSecret({
			handle: { provider: "nope", itemId: "x" },
			command: "echo",
			args: ["hi"],
			envKey: "MY_SECRET",
		});
		const r: ExecResult = result;
		expect(r.exitCode).toBe(-1);
		expect(r.stderr).toContain("Unknown provider");
		expect(r.stdout).toBe("");
	});

	it("resolution failure → exitCode -1, error in stderr", async () => {
		const provider = new MockProvider("mock", async () => {
			throw new Error("vault down");
		});
		const broker = new SecretBroker();
		broker.registerProvider(provider);

		const result = await broker.runWithSecret({
			handle: { provider: "mock", itemId: "x" },
			command: "echo",
			args: ["hi"],
			envKey: "MY_SECRET",
		});
		expect(result.exitCode).toBe(-1);
		expect(result.stderr).toContain("Resolution failed");
		expect(result.stderr).toContain("vault down");
	});

	it("ExecResult has no field carrying the raw secret value (stdout+stderr scrubbed)", async () => {
		const provider = new MockProvider("mock", async handle => ({
			handle,
			value: RAW_SECRET,
		}));
		const broker = new SecretBroker();
		broker.registerProvider(provider);

		// Force the subprocess to emit the secret on both stdout and stderr.
		const result = await broker.runWithSecret({
			handle: { provider: "mock", itemId: "x" },
			command: "sh",
			args: ["-c", `printf '%s' "${RAW_SECRET}"; printf '%s' "${RAW_SECRET}" >&2`],
			envKey: "MY_SECRET",
		});

		expect(result.stdout).not.toContain(RAW_SECRET);
		expect(result.stderr).not.toContain(RAW_SECRET);
		// Concatenation of all returned fields must not contain the raw secret.
		const allOutput = `${result.exitCode}${result.stdout}${result.stderr}`;
		expect(allOutput).not.toContain(RAW_SECRET);
	});

	it("clearResolvedSecrets() empties the scrub list so prior values pass through unscrubbed", async () => {
		const provider = new MockProvider("mock", async handle => ({
			handle,
			value: RAW_SECRET,
		}));
		const broker = new SecretBroker();
		broker.registerProvider(provider);

		// First call resolves + scrubs the raw value.
		const first = await broker.runWithSecret({
			handle: { provider: "mock", itemId: "x" },
			command: "printenv",
			args: ["MY_SECRET"],
			envKey: "MY_SECRET",
		});
		expect(first.stdout).not.toContain(RAW_SECRET);

		// Register a second provider that resolves to a DIFFERENT value, then
		// clear the scrub list. The next call resolves the new value (which is
		// tracked + scrubbed) but the OLD value — no longer in the scrub list —
		// passes through unscrubbed, proving clearResolvedSecrets() emptied it.
		const provider2 = new MockProvider("other", async handle => ({
			handle,
			value: "different-secret-5678",
		}));
		broker.registerProvider(provider2);
		broker.clearResolvedSecrets();
		const second = await broker.runWithSecret({
			handle: { provider: "other", itemId: "x" },
			command: "echo",
			args: [RAW_SECRET],
			envKey: "OTHER_KEY",
		});
		expect(second.exitCode).toBe(0);
		// OLD value cleared from scrub list → passes through.
		expect(second.stdout).toContain(RAW_SECRET);
		// NEW value freshly resolved → still scrubbed.
		expect(second.stdout).not.toContain("different-secret-5678");
	});
});
