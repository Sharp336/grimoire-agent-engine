/**
 * Centralized path helpers for omp config directories.
 *
 * Uses PI_CONFIG_DIR (default ".omp") for the config root and
 * PI_CODING_AGENT_DIR to override the agent directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { env } from "bun";
import { engines, version } from "../package.json" with { type: "json" };

/** App name (e.g. "omp") */
export const APP_NAME: string = "omp";

/** Config directory name (e.g. ".omp") */
export const CONFIG_DIR_NAME: string = ".omp";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

// =============================================================================
// Root directories
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

function getXdgDataPath(subpath: string): string | null {
	const xdgDataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
	const fullPath = path.join(xdgDataHome, APP_NAME, subpath);
	return fs.existsSync(fullPath) ? fullPath : null;
}

function getXdgStatePath(subpath: string): string | null {
	const xdgStateHome = env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state");
	const fullPath = path.join(xdgStateHome, APP_NAME, subpath);
	return fs.existsSync(fullPath) ? fullPath : null;
}

function getXdgCachePath(subpath: string): string | null {
	const xdgCacheHome = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
	const fullPath = path.join(xdgCacheHome, APP_NAME, subpath);
	return fs.existsSync(fullPath) ? fullPath : null;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/** Set the project directory. */
export function setProjectDir(dir: string): void {
	projectDir = standardizeMacOSPath(path.resolve(dir));
	process.chdir(projectDir);
}

/** Get the config directory name relative to home (e.g. ".omp" or PI_CONFIG_DIR override). */
export function getConfigDirName(): string {
	return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

/** Get the config agent directory name relative to home (e.g. ".omp/agent" or PI_CONFIG_DIR + "/agent"). */
export function getConfigAgentDirName(): string {
	return `${getConfigDirName()}/agent`;
}

/** Get the config root directory (~/.omp). */
export function getConfigRootDir(): string {
	return path.join(os.homedir(), getConfigDirName());
}

let agentDir = process.env.PI_CODING_AGENT_DIR || path.join(getConfigRootDir(), "agent");

/** Set the coding agent directory. */
export function setAgentDir(dir: string): void {
	agentDir = dir;
	agentCache.clear();
	process.env.PI_CODING_AGENT_DIR = dir;
}

/** Get the agent config directory (~/.omp/agent). */
export function getAgentDir(): string {
	return agentDir;
}

/** Get the project-local config directory (.omp). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Caching utilities
// =============================================================================

const rootCache = new Map<string, any>();

function getRootSubdir(subdir: string): string {
	if (rootCache.has(subdir)) {
		return rootCache.get(subdir);
	}
	const result = path.join(getConfigRootDir(), subdir);
	rootCache.set(subdir, result);
	return result;
}

const agentCache = new Map<string, any>();

// Returns true when the resolved agentDir is the process-default (~/.omp/agent).
// XDG lookup is only meaningful for the default profile; custom profiles
// (PI_CODING_AGENT_DIR / setAgentDir) must never be silently redirected.
function isDefaultAgentDir(dir: string): boolean {
	return dir === path.join(getConfigRootDir(), "agent");
}

function getAgentSubdir(userAgentDir: string | undefined, subdir: string): string {
	if (!userAgentDir || userAgentDir === agentDir) {
		if (agentCache.has(subdir)) {
			return agentCache.get(subdir);
		} else {
			const result = path.join(agentDir, subdir);
			agentCache.set(subdir, result);
			return result;
		}
	} else {
		return path.join(userAgentDir, subdir);
	}
}

// =============================================================================
// Config-root subdirectories (~/.omp/*)
// =============================================================================

/** Get the reports directory (~/.omp/reports). */
export function getReportsDir(): string {
	const xdgPath = getXdgStatePath("reports");
	if (xdgPath) return xdgPath;
	return getRootSubdir("reports");
}

/** Get the logs directory (~/.local/state/omp/logs or ~/.omp/logs). */
export function getLogsDir(): string {
	const xdgPath = getXdgStatePath("logs");
	if (xdgPath) return xdgPath;
	return getRootSubdir("logs");
}

/** Get the path to a dated log file (~/.omp/logs/omp.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}

/** Get the plugins directory (~/.omp/plugins). */
export function getPluginsDir(): string {
	const xdgPath = getXdgDataPath("plugins");
	if (xdgPath) return xdgPath;
	return getRootSubdir("plugins");
}

/** Where npm installs packages (~/.omp/plugins/node_modules). */
export function getPluginsNodeModules(): string {
	return path.join(getPluginsDir(), "node_modules");
}

/** Plugin manifest (~/.omp/plugins/package.json). */
export function getPluginsPackageJson(): string {
	return path.join(getPluginsDir(), "package.json");
}

/** Plugin lock file (~/.omp/plugins/omp-plugins.lock.json). */
export function getPluginsLockfile(): string {
	return path.join(getPluginsDir(), "omp-plugins.lock.json");
}

/** Get the remote mount directory (~/.omp/remote). */
export function getRemoteDir(): string {
	const xdgPath = getXdgDataPath("remote");
	if (xdgPath) return xdgPath;
	return getRootSubdir("remote");
}

/** Get the SSH control socket directory (~/.omp/ssh-control). */
export function getSshControlDir(): string {
	const xdgPath = getXdgStatePath("ssh-control");
	if (xdgPath) return xdgPath;
	return getRootSubdir("ssh-control");
}

/** Get the remote host info directory (~/.omp/remote-host). */
export function getRemoteHostDir(): string {
	const xdgPath = getXdgDataPath("remote-host");
	if (xdgPath) return xdgPath;
	return getRootSubdir("remote-host");
}

/** Get the managed Python venv directory (~/.omp/python-env). */
export function getPythonEnvDir(): string {
	const xdgPath = getXdgDataPath("python-env");
	if (xdgPath) return xdgPath;
	return getRootSubdir("python-env");
}

/** Get the puppeteer sandbox directory (~/.omp/puppeteer). */
export function getPuppeteerDir(): string {
	const xdgPath = getXdgCachePath("puppeteer");
	if (xdgPath) return xdgPath;
	return getRootSubdir("puppeteer");
}

/** Get the worktree base directory (~/.omp/wt). */
export function getWorktreeBaseDir(): string {
	const xdgPath = getXdgDataPath("wt");
	if (xdgPath) return xdgPath;
	return getRootSubdir("wt");
}

/** Get the path to a worktree directory (~/.omp/wt/<project>/<id>). */
export function getWorktreeDir(encodedProject: string, id: string): string {
	return path.join(getWorktreeBaseDir(), encodedProject, id);
}

/** Get the GPU cache path (~/.omp/gpu_cache.json). */
export function getGpuCachePath(): string {
	const xdgPath = getXdgCachePath("gpu_cache.json");
	if (xdgPath) return xdgPath;
	return getRootSubdir("gpu_cache.json");
}

/** Get the natives directory (~/.omp/natives). */
export function getNativesDir(): string {
	const xdgPath = getXdgCachePath("natives");
	if (xdgPath) return xdgPath;
	return getRootSubdir("natives");
}

/** Get the stats database path (~/.omp/stats.db). */
export function getStatsDbPath(): string {
	const xdgPath = getXdgDataPath("stats.db");
	if (xdgPath) return xdgPath;
	return getRootSubdir("stats.db");
}

// =============================================================================
// Agent subdirectories (~/.omp/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgDataPath("agent.db");
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, "agent.db");
}

/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgDataPath("history.db");
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, "history.db");
}

export function getModelDbPath(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgDataPath("models.db");
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, "models.db");
}

/** Get the sessions directory (~/.omp/agent/sessions). */
export function getSessionsDir(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgDataPath("sessions");
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, "sessions");
}

/** Get the content-addressed blob store directory (~/.omp/agent/blobs). */
export function getBlobsDir(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgDataPath("blobs");
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, "blobs");
}

/** Get the custom themes directory (~/.omp/agent/themes). */
export function getCustomThemesDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "themes");
}

/** Get the tools directory (~/.omp/agent/tools). */
export function getToolsDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "tools");
}

/** Get the slash commands directory (~/.omp/agent/commands). */
export function getCommandsDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "commands");
}

/** Get the prompts directory (~/.omp/agent/prompts). */
export function getPromptsDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "prompts");
}

/** Get the user-level Python modules directory (~/.omp/agent/modules). */
export function getAgentModulesDir(agentDir?: string): string {
	return getAgentSubdir(agentDir, "modules");
}

/** Get the memories directory (~/.omp/agent/memories or $XDG_STATE_HOME/omp/memories). */
export function getMemoriesDir(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgStatePath("memories");
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, "memories");
}

/** Get the terminal sessions directory (~/.omp/agent/terminal-sessions or $XDG_STATE_HOME/omp/terminal-sessions). */
export function getTerminalSessionsDir(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgStatePath("terminal-sessions");
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, "terminal-sessions");
}

/** Get the test auth database path (~/.omp/agent/testauth.db). */
export function getTestAuthPath(agentDir?: string): string {
	return getAgentSubdir(agentDir, "testauth.db");
}

/** Get the crash log path (~/.omp/agent/omp-crash.log). */
export function getCrashLogPath(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgStatePath("omp-crash.log");
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, "omp-crash.log");
}

/** Get the debug log path (~/.omp/agent/omp-debug.log). */
export function getDebugLogPath(agentDir?: string): string {
	if (isDefaultAgentDir(agentDir ?? getAgentDir())) {
		const xdgPath = getXdgStatePath(`${APP_NAME}-debug.log`);
		if (xdgPath) return xdgPath;
	}
	return getAgentSubdir(agentDir, `${APP_NAME}-debug.log`);
}

// =============================================================================
// Project subdirectories (.omp/*)
// =============================================================================

/** Get the project-level Python modules directory (.omp/modules). */
export function getProjectModulesDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "modules");
}

/** Get the project-level prompts directory (.omp/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.omp/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/** Get the primary MCP config file path (first candidate). */
export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH config file path. */
export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}
