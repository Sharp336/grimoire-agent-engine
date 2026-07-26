import * as path from "node:path";

import { isCompiledBinary, stripWindowsExtendedLengthPathPrefix, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { ConfiguredThinkingLevel } from "../thinking";

/** Environment variable used for one-hop restart handoff of runtime CLI API keys. */
export const RESTART_API_KEY_ENV = "OMP_RESTART_API_KEY";
/** Environment variable used for one-hop restart handoff of the runtime CLI API key's original provider. */
export const RESTART_API_KEY_PROVIDER_ENV = "OMP_RESTART_API_KEY_PROVIDER";
/** Environment variable used for one-hop restart handoff of the live advisor toggle. */
export const RESTART_ADVISOR_ENABLED_ENV = "OMP_RESTART_ADVISOR_ENABLED";
/** Environment variable used for one-hop restart handoff of the live computer-use toggle. */
export const RESTART_COMPUTER_ENABLED_ENV = "OMP_RESTART_COMPUTER_ENABLED";

/** Environment variable used for one-hop restart handoff of extension CLI flag values. */
export const RESTART_EXTENSION_FLAG_VALUES_ENV = "OMP_RESTART_EXTENSION_FLAG_VALUES";
/** Environment variable used to preserve CLI extension package roots across picker resumes and restarts. */
export const RESTART_EXTENSION_PACKAGE_ROOTS_ENV = "OMP_RESTART_EXTENSION_PACKAGE_ROOTS";
/** Environment variable used for one-hop restart handoff of literal system prompt values. */
export const RESTART_LITERAL_PROMPTS_ENV = "OMP_RESTART_LITERAL_PROMPTS";

/** Tool approval modes that can be restored across a process restart. */
export type RestartApprovalMode = "always-ask" | "write" | "yolo";

/** Tool filter that must be restored in the restarted process. */
export type RestartToolRestriction = { kind: "none" } | { kind: "allowlist"; toolNames: string[] };

/** Extension CLI flag value restored directly after extension discovery on restart. */
export type RestartExtensionFlagValue = readonly [name: string, value: boolean | string];

/** CLI launch state for time budget, auth, prompts, skills, context, config, and extensions that must survive restart. */
export interface RestartLaunchFlags {
	apiKey?: string;
	apiKeyProvider?: string;
	disableExtensions?: boolean;
	disableLsp?: boolean;
	disableRules?: boolean;
	disableSkills?: boolean;
	noPty?: boolean;
	noTitle?: boolean;
	configFiles?: string[];
	configEnvFiles?: string[];
	extensionPaths?: string[];
	extensionPackageRoots?: string[];
	hookPaths?: string[];
	pluginDirs?: string[];
	extensionFlagValues?: readonly RestartExtensionFlagValue[];
	provider?: string;
	model?: string;
	modelPatterns?: string[];
	smolModel?: string;
	slowModel?: string;
	planModel?: string;
	prewalk?: boolean;
	noPrewalk?: boolean;
	prewalkInto?: string;
	planYolo?: boolean;
	planYoloInto?: string;
	thinking?: ConfiguredThinkingLevel;
	hideThinking?: boolean;
	advisor?: boolean;
	computer?: boolean;
	providerSessionId?: string;
	providerPromptCacheKey?: string;
	skillPatterns?: string[];
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/** Literal system prompt classified at initial launch; restored through a restart-only env handoff. */
	restartLiteralSystemPrompt?: string;
	/** Literal append system prompt classified at initial launch; restored through a restart-only env handoff. */
	restartLiteralAppendSystemPrompt?: string;
	/** Absolute wall-clock deadline in epoch milliseconds for replaying remaining --max-time. */
	maxTimeDeadline?: number;
	autoApprove?: boolean;
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
	platform?: NodeJS.Platform;
	packageRoot: string;
}

/** Inputs copied from live interactive state into the restarted process argv/env. */
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

/** Minimal extension flag sink needed to restore restart-carried flag values. */
export interface RestartExtensionFlagSink {
	getFlags(): { has(name: string): boolean };
	setFlagValue(name: string, value: boolean | string): void;
}

/** Literal prompt values carried only by a restart child environment. */
export interface RestartLiteralPrompts {
	systemPrompt?: string;
	appendSystemPrompt?: string;
}

/** Consume literal prompt values from the one-hop restart environment payload. */
export function consumeRestartLiteralPrompts(
	env: Record<string, string | undefined> = process.env,
): RestartLiteralPrompts | undefined {
	const encoded = env[RESTART_LITERAL_PROMPTS_ENV];
	if (encoded === undefined) return undefined;
	delete env[RESTART_LITERAL_PROMPTS_ENV];
	let decoded: unknown;
	try {
		decoded = JSON.parse(encoded);
	} catch {
		return undefined;
	}
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
	const values: RestartLiteralPrompts = {};
	const source = decoded as Record<string, unknown>;
	if (typeof source.systemPrompt === "string") values.systemPrompt = source.systemPrompt;
	if (typeof source.appendSystemPrompt === "string") values.appendSystemPrompt = source.appendSystemPrompt;
	return values.systemPrompt !== undefined || values.appendSystemPrompt !== undefined ? values : undefined;
}

/** Consume the restart-only advisor toggle override from the one-hop restart environment. */
export function consumeRestartAdvisorEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean | undefined {
	const encoded = env[RESTART_ADVISOR_ENABLED_ENV];
	if (encoded === undefined) return undefined;
	delete env[RESTART_ADVISOR_ENABLED_ENV];
	if (encoded === "1") return true;
	if (encoded === "0") return false;
	return undefined;
}

/** Consume the restart-only computer-use toggle override from the one-hop restart environment. */
export function consumeRestartComputerEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean | undefined {
	const encoded = env[RESTART_COMPUTER_ENABLED_ENV];
	if (encoded === undefined) return undefined;
	delete env[RESTART_COMPUTER_ENABLED_ENV];
	if (encoded === "1") return true;
	if (encoded === "0") return false;
	return undefined;
}

/** Consume extension CLI flag values from the one-hop restart environment payload. */
export function consumeRestartExtensionFlagValues(
	env: Record<string, string | undefined> = process.env,
): RestartExtensionFlagValue[] | undefined {
	const encoded = env[RESTART_EXTENSION_FLAG_VALUES_ENV];
	if (encoded === undefined) return undefined;
	delete env[RESTART_EXTENSION_FLAG_VALUES_ENV];
	let decoded: unknown;
	try {
		decoded = JSON.parse(encoded);
	} catch {
		return undefined;
	}
	if (!Array.isArray(decoded)) return undefined;
	const values: RestartExtensionFlagValue[] = [];
	for (const entry of decoded) {
		if (!Array.isArray(entry) || entry.length !== 2) continue;
		const [name, value] = entry;
		if (typeof name !== "string") continue;
		if (typeof value !== "boolean" && typeof value !== "string") continue;
		values.push([name, value]);
	}
	return values;
}

/** Consume CLI extension package roots from the one-hop restart environment payload. */
export function consumeRestartExtensionPackageRoots(
	env: Record<string, string | undefined> = process.env,
): string[] | undefined {
	const encoded = env[RESTART_EXTENSION_PACKAGE_ROOTS_ENV];
	if (encoded === undefined) return undefined;
	delete env[RESTART_EXTENSION_PACKAGE_ROOTS_ENV];
	let decoded: unknown;
	try {
		decoded = JSON.parse(encoded);
	} catch {
		return undefined;
	}
	if (!Array.isArray(decoded)) return undefined;
	return decoded.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Prefer restart-carried package roots over CLI paths re-resolved in the restarted cwd. */
export function selectRestartExtensionPackageRoots(
	carriedRoots: readonly string[] | undefined,
	extensionPaths: readonly string[] | undefined,
	hookPaths: readonly string[] | undefined,
): string[] {
	return carriedRoots !== undefined ? [...carriedRoots] : [...(extensionPaths ?? []), ...(hookPaths ?? [])];
}

/** Restore restart-carried extension flag values for names still registered after discovery. */
export function restoreRestartExtensionFlagValues(
	sink: RestartExtensionFlagSink,
	values: readonly RestartExtensionFlagValue[] | undefined,
): void {
	if (!values) return;
	const registeredFlags = sink.getFlags();
	for (const [name, value] of values) {
		if (registeredFlags.has(name)) sink.setFlagValue(name, value);
	}
}

function defaultRestartCommandEnvironment(): RestartCommandEnvironment {
	return {
		isCompiledBinary,
		workerHostEntry,
		execPath: process.execPath,
		platform: process.platform,
		packageRoot: path.resolve(import.meta.dir, "..", ".."),
	};
}

function appendRepeatedFlag(cmd: string[], flag: string, values: readonly string[] | undefined): void {
	for (const value of values ?? []) {
		cmd.push(flag, value);
	}
}

function getRestartMaxTimeSeconds(deadline: number | undefined): number | undefined {
	if (deadline === undefined || !Number.isFinite(deadline)) return undefined;
	return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
}

function buildRestartEnv(options: RestartLaunchFlags): Record<string, string> | undefined {
	const childEnv: Record<string, string> = {};
	let hasChildEnv = false;
	if (options.apiKey) {
		childEnv[RESTART_API_KEY_ENV] = options.apiKey;
		if (options.apiKeyProvider) {
			childEnv[RESTART_API_KEY_PROVIDER_ENV] = options.apiKeyProvider;
		}
		hasChildEnv = true;
	}
	if (options.configEnvFiles !== undefined) {
		childEnv.PI_CONFIG_FILES = options.configEnvFiles.join(path.delimiter);
		hasChildEnv = true;
	}
	if (options.extensionFlagValues !== undefined) {
		childEnv[RESTART_EXTENSION_FLAG_VALUES_ENV] = JSON.stringify(options.extensionFlagValues);
		hasChildEnv = true;
	}
	if (options.extensionPackageRoots !== undefined) {
		childEnv[RESTART_EXTENSION_PACKAGE_ROOTS_ENV] = JSON.stringify(options.extensionPackageRoots);
		hasChildEnv = true;
	}
	if (options.restartLiteralSystemPrompt !== undefined || options.restartLiteralAppendSystemPrompt !== undefined) {
		childEnv[RESTART_LITERAL_PROMPTS_ENV] = JSON.stringify({
			...(options.restartLiteralSystemPrompt !== undefined
				? { systemPrompt: options.restartLiteralSystemPrompt }
				: {}),
			...(options.restartLiteralAppendSystemPrompt !== undefined
				? { appendSystemPrompt: options.restartLiteralAppendSystemPrompt }
				: {}),
		} satisfies RestartLiteralPrompts);
		hasChildEnv = true;
	}
	if (options.advisor !== undefined) {
		childEnv[RESTART_ADVISOR_ENABLED_ENV] = options.advisor ? "1" : "0";
		hasChildEnv = true;
	}
	if (options.computer !== undefined) {
		childEnv[RESTART_COMPUTER_ENABLED_ENV] = options.computer ? "1" : "0";
		hasChildEnv = true;
	}
	return hasChildEnv ? childEnv : undefined;
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
	const executable = stripWindowsExtendedLengthPathPrefix(env.execPath, env.platform);
	if (env.isCompiledBinary()) return { cmd: [executable] };
	const hostEntry = env.workerHostEntry();
	if (hostEntry) {
		return { cmd: [executable, hostEntry] };
	}

	return { cmd: [executable, path.join(env.packageRoot, "src/cli.ts")] };
}

/** Build a restart-safe argv that resumes the current persisted session only. */
export function buildRestartCommand(
	options: BuildRestartCommandOptions,
	env?: RestartCommandEnvironment,
): RestartCommand {
	const base = resolveRestartBaseCommand(env);
	const cmd = [...base.cmd];
	const childEnv = buildRestartEnv(options);
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
	if (options.provider !== undefined) {
		cmd.push("--provider", options.provider);
	}
	if (options.model !== undefined) {
		cmd.push("--model", options.model);
	}
	if (options.systemPrompt !== undefined) {
		cmd.push("--system-prompt", options.systemPrompt);
	}
	if (options.appendSystemPrompt !== undefined) {
		cmd.push("--append-system-prompt", options.appendSystemPrompt);
	}
	if (options.providerSessionId !== undefined) {
		cmd.push("--provider-session-id", options.providerSessionId);
	}
	if (options.providerPromptCacheKey !== undefined) {
		cmd.push("--prompt-cache-key", options.providerPromptCacheKey);
	}
	if (options.modelPatterns && options.modelPatterns.length > 0) {
		cmd.push("--models", options.modelPatterns.join(","));
	}
	if (options.smolModel !== undefined) {
		cmd.push("--smol", options.smolModel);
	}
	if (options.slowModel !== undefined) {
		cmd.push("--slow", options.slowModel);
	}
	if (options.planModel !== undefined) {
		cmd.push("--plan", options.planModel);
	}
	if (options.prewalk) {
		cmd.push("--prewalk");
	}
	if (options.noPrewalk) {
		cmd.push("--no-prewalk");
	}
	if (options.prewalkInto !== undefined) {
		cmd.push("--prewalk-into", options.prewalkInto);
	}
	if (options.planYolo) {
		cmd.push("--plan-yolo");
	}
	if (options.planYoloInto !== undefined) {
		cmd.push("--plan-yolo-into", options.planYoloInto);
	}
	if (options.thinking !== undefined) {
		cmd.push("--thinking", options.thinking);
	}
	if (options.hideThinking) {
		cmd.push("--hide-thinking");
	}
	if (options.advisor) {
		cmd.push("--advisor");
	}
	if (options.autoApprove) {
		cmd.push("--auto-approve");
	}

	const maxTimeSeconds = getRestartMaxTimeSeconds(options.maxTimeDeadline);
	if (maxTimeSeconds !== undefined) {
		cmd.push("--max-time", String(maxTimeSeconds));
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
	if (options.noPty) {
		cmd.push("--no-pty");
	}
	if (options.noTitle) {
		cmd.push("--no-title");
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
