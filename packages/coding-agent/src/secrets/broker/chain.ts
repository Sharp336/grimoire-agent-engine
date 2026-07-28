import type { SecretBroker } from "./broker";
import { hardenedSpawn } from "./exec-hardening";
import { scrubOutput } from "./scrub-output";
import type { ExecResult, SecretHandle, SecretValue } from "./types";

/**
 * Tier-3 Task 2: Cross-provider chaining capability.
 *
 * `runWithChain()` executes a multi-step resolution where each step:
 * 1. Resolves a handle via a provider (fail-closed on unknown provider or
 *    resolution failure).
 * 2. Spawns a subprocess with the resolved secret injected into a hardened
 *    env, plus any `outputKey`-captured values from prior steps.
 * 3. Optionally captures the step's stdout (trimmed) into an env var for
 *    subsequent steps.
 *
 * The agent sees only the final step's scrubbed {@link ExecResult}; intermediate
 * steps' stdout is captured by the broker but never returned. Fail-closed (R2):
 * any non-last step failure (non-zero exit) aborts the chain.
 */
export interface ChainStep {
	handle: SecretHandle;
	command: string;
	args: string[];
	/** Env var name to inject the resolved secret as. */
	envKey: string;
	cwd?: string;
	timeoutMs?: number;
	/** If set, capture stdout (trimmed) and inject as this env var in subsequent steps. */
	outputKey?: string;
}

/**
 * Run a multi-step secret-resolution chain. Each step resolves a handle,
 * spawns a command with the resolved secret + accumulated chain env, and
 * optionally captures stdout for the next step. Only the last step's output
 * is returned (scrubbed of all resolved secrets). Fail-closed: any non-last
 * step failure aborts the chain with an error {@link ExecResult}.
 */
export async function runWithChain(broker: SecretBroker, steps: ChainStep[]): Promise<ExecResult> {
	const chainEnv: Record<string, string> = {};
	const allResolvedSecrets: string[] = [];

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const isLast = i === steps.length - 1;

		// 1. Resolve handle → SecretValue (fail-closed).
		const provider = broker.getProvider(step.handle.provider);
		if (!provider) {
			return {
				exitCode: -1,
				stdout: "",
				stderr: `[CHAIN] Step ${i}: unknown provider "${step.handle.provider}"`,
			};
		}
		let secret: SecretValue;
		try {
			secret = await provider.resolve(step.handle);
		} catch (err) {
			return {
				exitCode: -1,
				stdout: "",
				stderr: `[CHAIN] Step ${i}: resolution failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		allResolvedSecrets.push(secret.value);

		// 2. Spawn with hardened env + resolved secret + chain env.
		const envSecrets: Record<string, string> = { [step.envKey]: secret.value, ...chainEnv };
		const result = await hardenedSpawn({
			command: step.command,
			args: step.args,
			envSecrets,
			cwd: step.cwd,
			timeoutMs: step.timeoutMs,
		});

		// 3. Capture output for the next step.
		if (step.outputKey) {
			chainEnv[step.outputKey] = result.stdout.trim();
		}

		// 4. Only the last step's output is returned (scrubbed).
		if (isLast) {
			const stdout = scrubOutput(result.stdout, allResolvedSecrets);
			const stderr = scrubOutput(result.stderr, allResolvedSecrets);
			return { exitCode: result.exitCode, stdout, stderr };
		}

		// 5. Fail-closed: if any non-last step fails, abort the chain.
		if (result.exitCode !== 0) {
			const stderr = scrubOutput(result.stderr, allResolvedSecrets);
			return {
				exitCode: result.exitCode,
				stdout: "",
				stderr: `[CHAIN] Step ${i} failed: ${stderr}`,
			};
		}
	}

	// Empty chain.
	return { exitCode: 0, stdout: "", stderr: "" };
}
