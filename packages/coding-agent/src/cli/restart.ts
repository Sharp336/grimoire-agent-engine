import * as path from "node:path";

import { isCompiledBinary, workerHostEntry } from "@oh-my-pi/pi-utils";

/** Tool approval modes that can be restored across a process restart. */
export type RestartApprovalMode = "always-ask" | "write" | "yolo";

/** Tool filter that must be restored in the restarted process. */
export type RestartToolRestriction = { kind: "none" } | { kind: "allowlist"; toolNames: string[] };

/** CLI launch flags for config and extension discovery that must survive restart. */
export interface RestartLaunchFlags {
	disableExtensions?: boolean;
	configFiles?: string[];
	extensionPaths?: string[];
	hookPaths?: string[];
	pluginDirs?: string[];
}

/** Self-entrypoint command before restart-specific CLI arguments are appended. */
export interface RestartCommandBase {
	cmd: string[];
	cwd?: string;
}

/** Complete restart command with the cwd used to spawn it. */
export interface RestartCommand {
	cmd: string[];
	cwd: string;
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

/** Injectable restart child spawner used by tests. */
export type RestartSpawn = (options: {
	cmd: string[];
	cwd: string;
	stdin: "inherit";
	stdout: "inherit";
	stderr: "inherit";
}) => RestartSubprocess;

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

	return { cmd, cwd: base.cwd ?? options.cwd };
}

/** Spawn the replacement OMP process with inherited stdio and return its exit code. */
export async function spawnRestartProcess(
	command: RestartCommand,
	options: SpawnRestartProcessOptions = {},
): Promise<number> {
	const spawn = options.spawn ?? Bun.spawn;
	const proc = spawn({
		cmd: command.cmd,
		cwd: command.cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	return await proc.exited;
}
