/**
 * Activation write-target resolution for Extension Control Center toggles.
 *
 * Activation state intentionally writes to the original OMP state files
 * (`config.yml` / `mcp.json`) instead of the generic project-settings discovery
 * stack. Keep this logic centralized: small differences here can make the UI
 * create `.omp/.omp` under global config roots or miss project MCP overrides.
 */

import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, getConfigDirName, getConfigRootDir } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";

export type ActivationWriteTarget = "global" | "project";
export type ActivationScope = ActivationWriteTarget;

export type ActivationTargetInfo =
	| { target: "global"; configPath: string | null; projectRoot: null }
	| { target: "project"; configPath: string; projectRoot: string };

export function isPathInside(base: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(base), path.resolve(candidate));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function baseConfigRoot(): string {
	return path.join(os.homedir(), getConfigDirName());
}

const SYSTEM_GLOBAL_DIRS = [
	"/Applications",
	"/Library",
	"/Network",
	"/System",
	"/Volumes",
	"/bin",
	"/dev",
	"/etc",
	"/opt",
	"/private",
	"/sbin",
	"/usr",
	"/var",
];

function isTmpCwd(resolved: string): boolean {
	// On macOS, os.tmpdir() often points at /var/folders/... while users still
	// run tools from literal /tmp. Treat both spellings as global-only scratch.
	return (
		isPathInside(os.tmpdir(), resolved) || isPathInside("/tmp", resolved) || isPathInside("/private/tmp", resolved)
	);
}

function isSystemGlobalCwd(resolved: string): boolean {
	if (resolved === path.parse(resolved).root) return true;
	return SYSTEM_GLOBAL_DIRS.some(dir => isPathInside(dir, resolved));
}

export function isGlobalActivationCwd(cwd: string, agentDir: string = getAgentDir()): boolean {
	const resolved = path.resolve(cwd);
	return (
		isSystemGlobalCwd(resolved) ||
		isTmpCwd(resolved) ||
		resolved === path.resolve(os.homedir()) ||
		isPathInside(baseConfigRoot(), resolved) ||
		isPathInside(getConfigRootDir(), resolved) ||
		isPathInside(agentDir, resolved)
	);
}

function isGlobalActivationConfigCwd(cwd: string, agentDir: string): boolean {
	const resolved = path.resolve(cwd);
	return (
		resolved === path.resolve(os.homedir()) ||
		isPathInside(baseConfigRoot(), resolved) ||
		isPathInside(getConfigRootDir(), resolved) ||
		isPathInside(agentDir, resolved)
	);
}

export function resolveExistingActivationProjectRootSync(cwd: string): string | null {
	const resolved = path.resolve(cwd);
	const home = path.resolve(os.homedir());
	let current = resolved;
	while (true) {
		if (isActivationTraversalBoundary(current, home)) return null;
		if (directoryExistsSync(path.join(current, CONFIG_DIR_NAME))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function resolveGitProjectRootSync(cwd: string): string | null {
	const home = path.resolve(os.homedir());
	const root = git.repo.rootSync(cwd);
	return root && !isActivationTraversalBoundary(root, home) ? root : null;
}

function isActivationTraversalBoundary(candidate: string, home: string): boolean {
	return (
		candidate === home ||
		candidate === path.resolve(os.tmpdir()) ||
		candidate === "/tmp" ||
		candidate === "/private/tmp"
	);
}

/** Resolve the nearest OMP project root or enclosing Git worktree root. */
export function resolveActivationProjectRootSync(cwd: string, agentDir: string = getAgentDir()): string | null {
	if (isGlobalActivationConfigCwd(cwd, agentDir)) return null;
	return resolveExistingActivationProjectRootSync(cwd) ?? resolveGitProjectRootSync(cwd);
}

/**
 * Resolve the root for project-owned configuration. A regular directory without
 * an OMP marker is still a valid first-write target; global configuration
 * directories are never one.
 */
export function resolveProjectConfigRootSync(cwd: string, agentDir: string = getAgentDir()): string | null {
	const projectRoot = resolveActivationProjectRootSync(cwd, agentDir);
	if (projectRoot) return projectRoot;
	return isGlobalActivationCwd(cwd, agentDir) ? null : path.resolve(cwd);
}

/** Require a project configuration target rather than nesting one in global configuration. */
export function requireProjectConfigRootSync(cwd: string, agentDir: string = getAgentDir()): string {
	const projectRoot = resolveProjectConfigRootSync(cwd, agentDir);
	if (!projectRoot) throw new Error("Project configuration is unavailable from global configuration.");
	return projectRoot;
}

export function getDefaultActivationScope(cwd: string, agentDir: string = getAgentDir()): ActivationScope {
	if (isGlobalActivationConfigCwd(cwd, agentDir)) return "global";
	return resolveActivationProjectRootSync(cwd, agentDir) ? "project" : "global";
}

export function resolveActivationTarget(
	cwd: string,
	agentDir: string,
	configPath: string | null,
	scope: ActivationScope = getDefaultActivationScope(cwd, agentDir),
): ActivationTargetInfo {
	if (isGlobalActivationConfigCwd(cwd, agentDir)) {
		return { target: "global", configPath, projectRoot: null };
	}
	const projectRoot = resolveActivationProjectRootSync(cwd, agentDir);
	if (scope === "project" && (projectRoot || !isGlobalActivationCwd(cwd, agentDir))) {
		const targetRoot = projectRoot ?? path.resolve(cwd);
		return {
			target: "project",
			configPath: path.join(targetRoot, CONFIG_DIR_NAME, "config.yml"),
			projectRoot: targetRoot,
		};
	}

	return { target: "global", configPath, projectRoot: null };
}

function directoryExistsSync(dir: string): boolean {
	try {
		return fsSync.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
