/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 *
 * Note: command execution is async to avoid blocking the TUI.
 */

import { executeShell } from "@oh-my-pi/pi-natives";

/** Identifies whether a config value originates from a trusted or untrusted source. */
export enum ConfigSource {
	/** User-level config (~/.mcp.json) — fully trusted, !-prefix commands allowed. */
	User = "user",
	/** Project-level config (.omp/mcp.json) — untrusted, !-prefix commands blocked. */
	Project = "project",
}

/** Cache for successful shell command results (persists for process lifetime). */
const commandResultCache = new Map<string, string>();

/** De-duplicates concurrent executions for the same command. */
const commandInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 *
 * @param config - The raw config value string.
 * @param source - Whether this value came from a user or project config.
 *   Project-level configs are denied !-prefix shell execution to prevent RCE
 *   from malicious .omp/mcp.json files in cloned repositories.
 */
export async function resolveConfigValue(
	config: string,
	source: ConfigSource = ConfigSource.User,
): Promise<string | undefined> {
	if (config.startsWith("!")) {
		if (source === ConfigSource.Project) {
			throw new Error(
				"!command substitution is not allowed in project-level MCP config. Move this value to your user config (~/.mcp.json) or use an environment variable.",
			);
		}
		return await executeCommand(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

async function executeCommand(commandConfig: string): Promise<string | undefined> {
	const cached = commandResultCache.get(commandConfig);
	if (cached !== undefined) {
		return cached;
	}

	const existing = commandInFlight.get(commandConfig);
	if (existing) {
		return await existing;
	}

	const command = commandConfig.slice(1);
	const promise = runShellCommand(command, 10_000)
		.then(result => {
			if (result !== undefined) {
				commandResultCache.set(commandConfig, result);
			}
			return result;
		})
		.finally(() => {
			commandInFlight.delete(commandConfig);
		});

	commandInFlight.set(commandConfig, promise);
	return await promise;
}

async function runShellCommand(command: string, timeoutMs: number): Promise<string | undefined> {
	try {
		let output = "";
		const result = await executeShell({ command, timeoutMs }, (err, chunk) => {
			if (!err) {
				output += chunk;
			}
		});
		if (result.timedOut || result.exitCode !== 0) {
			return undefined;
		}
		const trimmed = output.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export async function resolveHeaders(
	headers: Record<string, string> | undefined,
	source: ConfigSource = ConfigSource.User,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = await resolveConfigValue(value, source);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
	commandInFlight.clear();
}
