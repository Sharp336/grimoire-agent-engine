/**
 * Quality gates for goal mode: verification commands that must pass before a
 * goal can be completed. When the agent calls `goal({op: "complete"})`, each
 * configured gate command runs sequentially. A non-zero exit code blocks
 * completion and feeds the failure output back to the agent.
 *
 * Gate attempts are tracked per command. After `maxRetries` failed attempts
 * for a command, the gate is bypassed so the agent is never permanently
 * blocked by a gate it cannot satisfy.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { execCommand } from "../exec/exec";

const MAX_GATE_OUTPUT_CHARS = 6_000;

export interface GoalGateConfig {
	commands: string[];
	maxRetries: number;
	timeoutMs: number;
}

export interface GoalGateFailure {
	command: string;
	attempt: number;
	maxRetries: number;
	exitText: string;
	output: string;
}

export interface GoalGateResult {
	passed: boolean;
	failure?: GoalGateFailure;
}

export const DEFAULT_GATE_MAX_RETRIES = 3;
export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Run all gate commands sequentially. Returns after the first failure or after
 * all commands pass.
 *
 * `attempts` is a mutable map of command → current attempt count. It is
 * incremented and read in place so callers can track state across invocations.
 */
export async function runGoalGates(
	config: GoalGateConfig,
	cwd: string,
	attempts: Map<string, number>,
	signal?: AbortSignal,
): Promise<GoalGateResult> {
	if (config.commands.length === 0) return { passed: true };

	for (const command of config.commands) {
		signal?.throwIfAborted();

		const currentAttempts = attempts.get(command) ?? 0;

		// After maxRetries, bypass this gate — the agent has had enough chances.
		if (currentAttempts >= config.maxRetries) {
			logger.warn("goal gate: max retries exhausted, bypassing", { command, attempts: currentAttempts });
			continue;
		}

		const result = await execCommand("sh", ["-c", command], cwd, {
			signal,
			timeout: config.timeoutMs,
		});
		signal?.throwIfAborted();

		if (result.code === 0 && !result.killed) {
			attempts.set(command, 0);
			continue;
		}

		const attempt = currentAttempts + 1;
		attempts.set(command, attempt);

		const exitText = result.killed ? "timed out or aborted" : `exit code ${result.code}`;
		const output = truncateOutput([result.stdout, result.stderr].filter(Boolean).join("\n").trim());

		return {
			passed: false,
			failure: { command, attempt, maxRetries: config.maxRetries, exitText, output },
		};
	}

	return { passed: true };
}

/** Format a gate failure into a message suitable for the agent. */
export function formatGateFailureMessage(failure: GoalGateFailure): string {
	const lines = [
		`Quality gate failed (attempt ${failure.attempt}/${failure.maxRetries}):`,
		`  Command: \`${failure.command}\``,
		`  Result: ${failure.exitText}`,
	];
	if (failure.output) {
		lines.push("  Output:", failure.output);
	}
	lines.push("", 'Fix the failure, then call goal({op: "complete"}) again.');
	return lines.join("\n");
}

function truncateOutput(combined: string): string {
	if (combined.length > MAX_GATE_OUTPUT_CHARS) {
		return `${combined.slice(0, MAX_GATE_OUTPUT_CHARS)}\n...(output truncated)`;
	}
	return combined;
}
