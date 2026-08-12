import * as fs from "node:fs";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import type { Subprocess } from "bun";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "./dirs";
import { $env, filterChildShellEnv } from "./env";
import { $which } from "./which";

export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string>;
	prefix: string | undefined;
}

/** Identifies the settings source users should edit when shell resolution fails. */
export interface ShellConfigOptions {
	/** File path or runtime layer that supplied the active shell setting. */
	configSource?: string;
	/** Environment used for shell selection and the spawned shell. Supplying it bypasses the process-global cache. */
	env?: Record<string, string | undefined>;
}
let cachedShellConfig: ShellConfig | null = null;

/**
 * Check if a shell binary is executable.
 */
export function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
const SHELL_ENV_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Whether a shell-selection environment value is safe to use as a path or PATH list. */
export function isSafeShellEnvValue(value: string | undefined): value is string {
	return value !== undefined && !SHELL_ENV_CONTROL_RE.test(value);
}

/**
 * Build the spawn environment (cached).
 */
function buildSpawnEnv(shell: string, env: Record<string, string | undefined> = Bun.env): Record<string, string> {
	const noCI = env.PI_BASH_NO_CI || env.CLAUDE_BASH_NO_CI;
	return {
		...filterChildShellEnv(env),
		SHELL: shell,
		GIT_EDITOR: "true",
		GPG_TTY: "not a tty",
		OMPCODE: "1",
		CLAUDECODE: "1",
		...(noCI ? {} : { CI: "true" }),
	} as Record<string, string>;
}

/**
 * Get shell args for the resolved shell.
 * cmd.exe takes `/c`; PowerShell (powershell.exe / pwsh) takes
 * `-NoLogo -Command`, with `-NoProfile` when PI_BASH_NO_LOGIN /
 * CLAUDE_BASH_NO_LOGIN is set (profile scripts are PowerShell's login-shell
 * analog); POSIX shells take `-c`, with `-l` unless the same env is set.
 *
 * Exported for tests; `env` overrides the process env gate.
 */
export function getShellArgs(shell: string, env: Record<string, string | undefined> = $env): string[] {
	if (isCmdShell(shell)) return ["/c"];
	const noLogin = env.PI_BASH_NO_LOGIN || env.CLAUDE_BASH_NO_LOGIN;
	if (isPowerShell(shell)) {
		return noLogin ? ["-NoLogo", "-NoProfile", "-Command"] : ["-NoLogo", "-Command"];
	}
	return noLogin ? ["-c"] : ["-l", "-c"];
}

/** Whether the shell is Windows cmd.exe (spawn paths must use `/c`, not `-c`). */
export function isCmdShell(shell: string): boolean {
	const basename = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return basename === "cmd.exe" || basename === "cmd";
}

/**
 * Whether the shell is Windows PowerShell or PowerShell Core (pwsh). Spawn
 * paths must use `-Command`: passing the POSIX `-l -c` pair makes PowerShell
 * parse `-l` as the command and fail with `The term '-l' is not recognized`.
 */
export function isPowerShell(shell: string): boolean {
	const basename = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return basename === "powershell.exe" || basename === "powershell" || basename === "pwsh.exe" || basename === "pwsh";
}

/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 */
function getShellPrefix(env: Record<string, string | undefined> = Bun.env): string | undefined {
	return env.PI_SHELL_PREFIX || env.CLAUDE_CODE_SHELL_PREFIX;
}

/**
 * Build full shell config from a shell path.
 */
function buildConfig(shell: string, env: Record<string, string | undefined> = Bun.env): ShellConfig {
	return {
		shell,
		args: getShellArgs(shell, env),
		env: buildSpawnEnv(shell, env),
		prefix: getShellPrefix(env),
	};
}

/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export function resolveBasicShell(searchPath?: string): string | undefined {
	for (const name of ["bash", "bash.exe", "sh", "sh.exe"]) {
		const resolved =
			searchPath === undefined
				? $which(name)
				: searchPath.length > 0 && isSafeShellEnvValue(searchPath)
					? $which(name, { PATH: searchPath })
					: null;
		if (resolved) return resolved;
	}

	if (process.platform !== "win32") {
		const searchPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
		const candidates = ["bash", "sh"];

		for (const name of candidates) {
			for (const dir of searchPaths) {
				const fullPath = path.join(dir, name);
				if (fs.existsSync(fullPath)) return fullPath;
			}
		}
	}

	return undefined;
}

/**
 * Resolve the external shell to advertise on Windows.
 *
 * A host bash is OPTIONAL: bash tool commands always execute in the embedded
 * brush-core shell. The resolved binary only serves the spawn-a-shell paths
 * (interactive PTY sessions, ACP client terminals, SHELL env), so this
 * prefers a real Git Bash when one exists and otherwise falls back to
 * cmd.exe — it never fails.
 *
 * Search order:
 * 1. Git for Windows install roots (machine + per-user installers)
 * 2. scoop installs — scoop's git manifest sets GIT_INSTALL_ROOT and shims
 *    sh.exe/git.exe but never bash.exe, so PATH lookup alone misses it
 * 3. bash.exe on PATH (Cygwin, MSYS2, ...)
 * 4. sh.exe on PATH (Git for Windows' sh.exe is bash; prefer a sibling
 *    bash.exe when present)
 * 5. cmd.exe from ComSpec
 *
 * Exported for tests; `env` overrides Bun.env-based discovery.
 */
export function resolveWindowsShell(env: Record<string, string | undefined> = Bun.env): string {
	const gitRoots = [
		env.ProgramFiles && path.join(env.ProgramFiles, "Git"),
		env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Git"),
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Git"),
		env.GIT_INSTALL_ROOT,
		env.SCOOP && path.join(env.SCOOP, "apps", "git", "current"),
		env.USERPROFILE && path.join(env.USERPROFILE, "scoop", "apps", "git", "current"),
	];
	for (const root of gitRoots) {
		if (!root || !isSafeShellEnvValue(root)) continue;
		const candidate = path.join(root, "bin", "bash.exe");
		if (fs.existsSync(candidate)) return candidate;
	}
	const trustedPath = isSafeShellEnvValue(env.PATH) ? env.PATH : "";
	const bashOnPath = trustedPath.length > 0 ? $which("bash.exe", { PATH: trustedPath }) : null;
	if (bashOnPath) return bashOnPath;

	const shOnPath = trustedPath.length > 0 ? $which("sh.exe", { PATH: trustedPath }) : null;
	if (shOnPath) {
		const siblingBash = path.join(path.dirname(shOnPath), "bash.exe");
		return fs.existsSync(siblingBash) ? siblingBash : shOnPath;
	}

	const commandShell = env.ComSpec || env.COMSPEC;
	return isSafeShellEnvValue(commandShell) ? commandShell : "C:\\Windows\\System32\\cmd.exe";
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath from the active settings source
 * 2. On Windows: Git Bash / bash / sh discovery, then cmd.exe (see
 *    {@link resolveWindowsShell}) — never fails
 * 3. On Unix: $SHELL if bash/zsh, then fallback paths
 * 4. Fallback: sh
 */
export function getShellConfig(customShellPath?: string, options: ShellConfigOptions = {}): ShellConfig {
	const env = options.env ?? Bun.env;
	const cacheable = options.env === undefined;
	const configSource = options.configSource ?? path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);
	// 1. Check user-specified shell path. Validated even on the cached path so a
	// broken shellPath surfaces its guidance error instead of being masked by an
	// earlier successful resolution in the same process.
	if (customShellPath) {
		if (!isSafeShellEnvValue(customShellPath)) {
			throw new Error(
				"Custom shell path contains control characters. Please update shellPath in your OMP settings.",
			);
		}
		if (!fs.existsSync(customShellPath)) {
			throw new Error(`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ${configSource}`);
		}
		if (!cacheable) return buildConfig(customShellPath, env);
		if (cachedShellConfig?.shell !== customShellPath) {
			cachedShellConfig = buildConfig(customShellPath, env);
		}
		return cachedShellConfig;
	}
	if (cacheable && cachedShellConfig) {
		return cachedShellConfig;
	}

	if (process.platform === "win32") {
		const config = buildConfig(resolveWindowsShell(env), env);
		if (cacheable) cachedShellConfig = config;
		return config;
	}

	// Unix: prefer the user's absolute bash/zsh path from $SHELL.
	const userShell = env.SHELL;
	const shellName = userShell ? path.basename(userShell).toLowerCase() : "";
	const isValidShell =
		isSafeShellEnvValue(userShell) &&
		path.isAbsolute(userShell) &&
		(shellName.includes("bash") || shellName.includes("zsh"));
	if (isValidShell && isExecutable(userShell)) {
		const config = buildConfig(userShell, env);
		if (cacheable) cachedShellConfig = config;
		return config;
	}

	// 4. Fallback: use a basic shell from the selected environment.
	const basicShell = resolveBasicShell(options.env === undefined ? undefined : (env.PATH ?? ""));
	const config = buildConfig(basicShell ?? "sh", env);
	if (cacheable) cachedShellConfig = config;
	return config;
}

/**
 * Check if a process is running.
 */
export function isPidRunning(pid: number | Subprocess): boolean {
	if (typeof pid !== "number") {
		if (pid.killed) return false;
		if (pid.exitCode !== null) return false;
		return true;
	}

	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

export async function onProcessExit(proc: Subprocess | number, abortSignal?: AbortSignal): Promise<boolean> {
	if (typeof proc !== "number") {
		return proc.exited.then(
			() => true,
			() => true,
		);
	}

	return (await Process.fromPid(proc)?.waitForExit({ signal: abortSignal })) ?? true;
}
