import { z } from "zod/v4";
import type { ToolDefinition } from "../../extensibility/extensions/types";
import type { SecretBroker } from "./broker";
import type { ChainStep } from "./chain";
import { runWithChain } from "./chain";

/**
 * Tier-3 Task 3 — the `run_with_chain` extension tool.
 *
 * This is the agent's interface to the cross-provider chaining capability. The
 * agent passes an ordered array of steps (1..5). Each step resolves a secret
 * handle, runs a command with the resolved secret injected into a hardened
 * env, and optionally captures the step's stdout (trimmed) into an env var
 * available to subsequent steps. The broker runs the chain and returns ONLY the
 * final step's scrubbed {@link ExecResult} — intermediate steps' stdout is
 * captured internally and never returned. The raw secret values of every step
 * are tracked and scrubbed from the final output.
 *
 * Fail-closed (R2): any non-last step failure (non-zero exit) aborts the chain
 * with an error {@link ExecResult} (`exitCode: -1`). The execute function never
 * throws — the agent always receives a structured JSON result.
 */

const chainStepSchema = z.object({
	handle: z.object({
		provider: z.string().describe("Vault provider: bitwarden, infisical, ephemeral"),
		itemId: z.string().describe("Item ID in the provider's namespace"),
		field: z.string().optional().describe("Field name (password, username, totp)"),
	}),
	command: z.string().describe("Binary to execute (must be in the closed PATH allowlist)"),
	args: z.array(z.string()).describe("Arguments (array-form, not a shell string)"),
	envKey: z.string().describe("Env var name to inject the resolved secret as"),
	cwd: z.string().optional().describe("Working directory for the subprocess"),
	timeoutMs: z.number().optional().describe("Timeout in ms (default 30000)"),
	outputKey: z
		.string()
		.optional()
		.describe("If set, capture the step's stdout (trimmed) into this env var, available to subsequent steps"),
});

const runWithChainParams = z.object({
	steps: z
		.array(chainStepSchema)
		.min(1)
		.max(5)
		.describe(
			"Ordered chain of 1..5 steps. Each step resolves a handle, runs a command with the " +
				"resolved secret, and optionally captures stdout for the next step. Only the final " +
				"step's scrubbed output is returned.",
		),
});

/**
 * Build the `run_with_chain` tool bound to a {@link SecretBroker}. Registered by
 * the secret-broker extension alongside `run_with_secret`.
 */
export function createRunWithChainTool(broker: SecretBroker): ToolDefinition<typeof runWithChainParams> {
	return {
		name: "run_with_chain",
		label: "Run with Chain",
		description:
			"Execute a multi-step secret resolution chain where each step resolves a vault handle, " +
			"runs a command with the resolved secret injected into the subprocess env, and optionally " +
			"captures stdout for the next step's env. Only the final step's scrubbed output is returned — " +
			"intermediate steps' stdout never leaves the broker and all resolved secrets are scrubbed " +
			"from the result. Use this to resolve a credential from one provider, use it to obtain a " +
			"second credential from another provider, and run a final command — without the agent ever " +
			"holding any intermediate or final raw secret value.",
		parameters: runWithChainParams,
		approval: "exec",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const steps: ChainStep[] = params.steps.map(step => ({
				handle: step.handle,
				command: step.command,
				args: step.args,
				envKey: step.envKey,
				...(step.cwd ? { cwd: step.cwd } : {}),
				...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
				...(step.outputKey ? { outputKey: step.outputKey } : {}),
			}));
			const result = await runWithChain(broker, steps);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			};
		},
	};
}
