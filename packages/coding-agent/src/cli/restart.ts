import * as path from "node:path";

import { isCompiledBinary, workerHostEntry } from "@oh-my-pi/pi-utils";

/** Environment variable used for one-hop restart handoff of runtime CLI API keys. */
export const RESTART_API_KEY_ENV = "OMP_RESTART_API_KEY";

/** Tool approval modes that can be restored across a process restart. */
export type RestartApprovalMode = "always-ask" | "write" | "yolo";

/** Tool filter that must be restored in the restarted process. */
export type RestartToolRestriction = { kind: "none" } | { kind: "allowlist"; toolNames: string[] };

/** CLI launch flags for config, prompt, context, auth, and extension discovery that must survive restart. */
export interface RestartLaunchFlags {
	apiKey?: string;
	disableExtensions?: boolean;
	disableLsp?: boolean;
	disableRules?: boolean;
	disableSkills?: boolean;
	configFiles?: string[];
	extensionPaths?: string[];
	hookPaths?: string[];
	pluginDirs?: string[];
	skillPatterns?: string[];
	systemPrompt?: string;
	appendSystemPrompt?: string;
}

/** Self-entrypoint command before restart-specific CLI arguments are appended. */
export interface RestartCommandBase {
	cmd: string[];
	cwd?: string;
}

/** Complete restart command with the cwd/env used to spawn it. */
export interface RestartCommand {
	cmd: string[];
	cwd: string;
	env?: Record<string, string>;
}

/** Runtime dependencies used to resolve the current OMP entrypoint. */
export interface RestartCommandEnvironment {
	isCompiledBinary: () => boolean;
	workerHostEntry: () => string | null;
	execPath: string;
	packageRoot: string;
}

/** Inputs copied from live interactive state into the restarted process argv. */
export interface BuildRestartCommandOptions extends RestartLaunchFlags {
	sessionId: string;
	cwd: string;
	sessionDir: string;
	activeProfile?: string;
	toolRestriction?: RestartToolRestriction;
	approvalMode: RestartApprovalMode;
}

/** Minimal child process contract needed to await restart completion. */
export interface RestartSubprocess {
	exited: Promise<number>;
}

/** Bun.spawn-compatible options used to launch the restart child. */
export interface RestartSpawnInput {
	cmd: string[];
	cwd: string;
	env?: Record<string, string>;
	stdin: "inherit";
	stdout: "inherit";
	stderr: "inherit";
}

/** Injectable restart child spawner used by tests. */
export type RestartSpawn = (options: RestartSpawnInput) => RestartSubprocess;

/** Optional dependencies for spawning the restart process. */
export interface SpawnRestartProcessOptions {
	spawn?: RestartSpawn;
}

function defaultRestartCommandEnvironment(): RestartCommandEnvironment {
	return {
		isCompiledBinary,
		workerHostEntry,
		execPath: process.execPath,
		packageRoot: path.resolve(import.meta.dir, "..", ".."),
	};
}

function appendRepeatedFlag(cmd: string[], flag: string, values: readonly string[] | undefined): void {
	for (const value of values ?? []) {
		cmd.push(flag, value);
	}
}

function buildChildEnv(overrides: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!overrides) return undefined;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...overrides };
}

/** Resolve the base command that re-enters the same OMP build. */
export function resolveRestartBaseCommand(
	env: RestartCommandEnvironment = defaultRestartCommandEnvironment(),
): RestartCommandBase {
	if (env.isCompiledBinary()) return { cmd: [env.execPath] };

	const hostEntry = env.workerHostEntry();
	if (hostEntry) {
		return { cmd: [env.execPath, path.basename(hostEntry)], cwd: path.dirname(hostEntry) };
	}

	return { cmd: [env.execPath, "src/cli.ts"], cwd: env.packageRoot };
}

/** Build a restart-safe argv that resumes the current persisted session only. */
export function buildRestartCommand(
	options: BuildRestartCommandOptions,
	env?: RestartCommandEnvironment,
): RestartCommand {
	const base = resolveRestartBaseCommand(env);
	const cmd = [...base.cmd];
	const childEnv = options.apiKey ? { [RESTART_API_KEY_ENV]: options.apiKey } : undefined;
	if (options.activeProfile !== undefined) {
		cmd.push("--profile", options.activeProfile);
	}

	appendRepeatedFlag(cmd, "--config", options.configFiles);

	if (options.disableExtensions) {
		cmd.push("--no-extensions");
	}

	appendRepeatedFlag(cmd, "--extension", options.extensionPaths);
	appendRepeatedFlag(cmd, "--hook", options.hookPaths);
	appendRepeatedFlag(cmd, "--plugin-dir", options.pluginDirs);
	if (options.systemPrompt !== undefined) {
		cmd.push("--system-prompt", options.systemPrompt);
	}
	if (options.appendSystemPrompt !== undefined) {
		cmd.push("--append-system-prompt", options.appendSystemPrompt);
	}

	if (options.disableLsp) {
		cmd.push("--no-lsp");
	}
	if (options.disableSkills) {
		cmd.push("--no-skills");
	}
	if (options.disableRules) {
		cmd.push("--no-rules");
	}
	if (options.skillPatterns && options.skillPatterns.length > 0) {
		cmd.push("--skills", options.skillPatterns.join(","));
	}

	cmd.push("--cwd", options.cwd, "--approval-mode", options.approvalMode);

	if (options.toolRestriction?.kind === "none") {
		cmd.push("--no-tools");
	} else if (options.toolRestriction?.kind === "allowlist") {
		if (options.toolRestriction.toolNames.length === 0) {
			cmd.push("--no-tools");
		} else {
			cmd.push("--tools", options.toolRestriction.toolNames.join(","));
		}
	}

	cmd.push("--session-dir", options.sessionDir, "--resume", options.sessionId);

	return { cmd, cwd: base.cwd ?? options.cwd, ...(childEnv ? { env: childEnv } : {}) };
}

/** Spawn the replacement OMP process with inherited stdio and return its exit code. */
export async function spawnRestartProcess(
	command: RestartCommand,
	options: SpawnRestartProcessOptions = {},
): Promise<number> {
	const spawn = options.spawn ?? Bun.spawn;
	const spawnOptions: RestartSpawnInput = {
		cmd: command.cmd,
		cwd: command.cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	};
	const env = buildChildEnv(command.env);
	if (env) spawnOptions.env = env;
	const proc = spawn(spawnOptions);

	return await proc.exited;
}
