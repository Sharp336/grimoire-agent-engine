import { describe, expect, it } from "bun:test";
import { SecretBroker } from "../secrets/broker/broker";
import { type ChainStep, runWithChain } from "../secrets/broker/chain";
import type { SecretHandle, SecretValue, VaultProvider } from "../secrets/broker/types";

/**
 * Tier-3 Task 2: Cross-provider chaining capability.
 *
 * `runWithChain()` executes a multi-step resolution where each step resolves a
 * handle, runs a command with the resolved secret injected, optionally captures
 * stdout for the next step's env, and returns only the last step's scrubbed
 * ExecResult. Fail-closed (R2): any non-last step failure aborts the chain.
 */

/** A mock provider whose resolved value is fixed at construction time. */
class MockProvider implements VaultProvider {
	readonly name: string;
	readonly #value: string;

	constructor(name: string, value: string) {
		this.name = name;
		this.#value = value;
	}

	async resolve(handle: SecretHandle): Promise<SecretValue> {
		if (handle.provider !== this.name) {
			throw new Error(`MockProvider[${this.name}]: wrong provider "${handle.provider}"`);
		}
		return { handle, value: this.#value };
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}
}

/** A mock provider that throws on resolve — used to test fail-closed chaining. */
class FailingProvider implements VaultProvider {
	readonly name: string;
	constructor(name: string) {
		this.name = name;
	}
	async resolve(): Promise<SecretValue> {
		throw new Error("FailingProvider: resolution failed");
	}
	async isAvailable(): Promise<boolean> {
		return false;
	}
}

describe("Tier-3 Task 2: runWithChain", () => {
	it("2-step chain returns only the last step's output, with both secrets scrubbed", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(new MockProvider("provider-a", "alpha-secret-1234"));
		broker.registerProvider(new MockProvider("provider-b", "beta-secret-5678"));

		const steps: ChainStep[] = [
			{
				handle: { provider: "provider-a", itemId: "item-1" },
				command: "printenv",
				args: ["SECRET_A"],
				envKey: "SECRET_A",
			},
			{
				handle: { provider: "provider-b", itemId: "item-2" },
				command: "printenv",
				args: ["SECRET_B"],
				envKey: "SECRET_B",
			},
		];

		const result = await runWithChain(broker, steps);
		expect(result.exitCode).toBe(0);
		// Only the last step's stdout is returned; the last step's secret is scrubbed.
		expect(result.stdout.trim()).toBe("[REDACTED]");
		// The first step's secret must NOT appear anywhere in the output.
		expect(result.stdout).not.toContain("alpha-secret-1234");
		expect(result.stderr).not.toContain("alpha-secret-1234");
		// The last step's secret MUST be scrubbed from the returned output.
		expect(result.stdout).not.toContain("beta-secret-5678");
		expect(result.stdout).toContain("[REDACTED]");
	});

	it("fail-closed: step 1 exits non-zero → chain aborts with an error ExecResult", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(new MockProvider("provider-a", "alpha-secret-1234"));

		const steps: ChainStep[] = [
			{
				handle: { provider: "provider-a", itemId: "item-1" },
				// `false` exits non-zero.
				command: "false",
				args: [],
				envKey: "SECRET_A",
			},
			{
				handle: { provider: "provider-a", itemId: "item-2" },
				command: "echo",
				args: ["should-not-run"],
				envKey: "SECRET_A",
			},
		];

		const result = await runWithChain(broker, steps);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("[CHAIN]");
		// The resolved secret must be scrubbed from the error stderr.
		expect(result.stderr).not.toContain("alpha-secret-1234");
	});

	it("intermediate output captured: step 1 outputKey is available as $CAPTURED in step 2 env", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(new MockProvider("provider-a", "alpha-secret-1234"));

		const steps: ChainStep[] = [
			{
				handle: { provider: "provider-a", itemId: "item-1" },
				// Echo a known string into stdout, which is captured to CAPTURED.
				command: "echo",
				args: ["captured-host.example.com"],
				envKey: "SECRET_A",
				outputKey: "CAPTURED",
			},
			{
				handle: { provider: "provider-a", itemId: "item-2" },
				// Print the captured env var.
				command: "printenv",
				args: ["CAPTURED"],
				envKey: "SECRET_A",
			},
		];

		const result = await runWithChain(broker, steps);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("captured-host.example.com");
	});

	it("all intermediate secrets are scrubbed from the final output", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(new MockProvider("provider-a", "intermediate-secret-AAAA"));
		broker.registerProvider(new MockProvider("provider-b", "final-secret-BBBB"));

		const steps: ChainStep[] = [
			{
				// Printenv dumps all env vars including the intermediate secret.
				handle: { provider: "provider-a", itemId: "item-1" },
				command: "printenv",
				args: ["SECRET_A"],
				envKey: "SECRET_A",
				outputKey: "CAPTURED",
			},
			{
				// Concatenate both env vars so the final stdout contains both secrets pre-scrub.
				handle: { provider: "provider-b", itemId: "item-2" },
				command: "sh",
				args: ["-c", "echo $SECRET_A $SECRET_B"],
				envKey: "SECRET_B",
			},
		];

		const result = await runWithChain(broker, steps);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("intermediate-secret-AAAA");
		expect(result.stdout).not.toContain("final-secret-BBBB");
		expect(result.stdout).toContain("[REDACTED]");
	});

	it("unknown provider in any step → fail-closed error", async () => {
		const broker = new SecretBroker();
		// No providers registered.

		const steps: ChainStep[] = [
			{
				handle: { provider: "nonexistent", itemId: "item-1" },
				command: "echo",
				args: ["hello"],
				envKey: "SECRET_A",
			},
		];

		const result = await runWithChain(broker, steps);
		expect(result.exitCode).toBe(-1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("[CHAIN]");
		expect(result.stderr).toContain("unknown provider");
	});

	it("resolution failure in any step → fail-closed error", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(new FailingProvider("failing"));

		const steps: ChainStep[] = [
			{
				handle: { provider: "failing", itemId: "item-1" },
				command: "echo",
				args: ["should-not-run"],
				envKey: "SECRET_A",
			},
		];

		const result = await runWithChain(broker, steps);
		expect(result.exitCode).toBe(-1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("[CHAIN]");
		expect(result.stderr).toContain("resolution failed");
	});

	it("empty chain → returns {exitCode: 0, stdout: '', stderr: ''}", async () => {
		const broker = new SecretBroker();
		const result = await runWithChain(broker, []);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});
});
