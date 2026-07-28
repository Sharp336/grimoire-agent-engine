import { z } from "zod/v4";
import type { ToolDefinition } from "../../extensibility/extensions/types";
import type { SecretBroker } from "./broker";

/**
 * Tier-2 Task 6 — the `run_with_secret` extension tool.
 *
 * This is the agent's ONLY interface to the {@link SecretBroker}. The agent
 * passes a secret handle, a command, and the env-var name to inject the
 * resolved secret as. The broker resolves the handle, spawns the subprocess
 * with a hardened env, scrubs stdout/stderr of the resolved value, and
 * returns a typed {@link ExecResult}. The raw secret value is never visible to
 * the agent — only scrubbed stdout/stderr and the exit code are returned.
 *
 * Fail-closed (R2): a broker failure (unknown provider, resolution failure,
 * spawn error) yields an error {@link ExecResult} with `exitCode: -1`; the
 * execute function never throws, so the agent always receives a structured
 * result rather than a raw value leaking through an exception.
 */

const runWithSecretParams = z.object({
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
});

/** Default subprocess timeout when the caller omits `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Build the `run_with_secret` tool bound to a {@link SecretBroker}. Registered
 * by the secret-broker extension at session start.
 */
export function createRunWithSecretTool(broker: SecretBroker): ToolDefinition<typeof runWithSecretParams> {
	return {
		name: "run_with_secret",
		label: "Run with Secret",
		description:
			"Execute a command with a resolved secret injected into the subprocess environment. " +
			"The secret value is never visible to the agent — only the scrubbed stdout/stderr and " +
			"the exit code are returned.",
		parameters: runWithSecretParams,
		approval: "exec",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await broker.runWithSecret({
				handle: params.handle,
				command: params.command,
				args: params.args,
				envKey: params.envKey,
				cwd: params.cwd,
				timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			});
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			};
		},
	};
}
