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

export function resolveExistingActivationProjectRootSync(cwd: string): string | null {
	const resolved = path.resolve(cwd);
	const home = path.resolve(os.homedir());
	let current = resolved;
	while (true) {
		if (current !== home && directoryExistsSync(path.join(current, CONFIG_DIR_NAME))) return current;
		const parent = path.dirname(current);
		if (parent === current || current === home) return null;
		current = parent;
	}
}

export function getDefaultActivationScope(cwd: string, _agentDir: string = getAgentDir()): ActivationScope {
	return resolveExistingActivationProjectRootSync(cwd) ? "project" : "global";
}

export function resolveActivationTarget(
	cwd: string,
	agentDir: string,
	configPath: string | null,
	scope: ActivationScope = getDefaultActivationScope(cwd, agentDir),
): ActivationTargetInfo {
	const existingProjectRoot = resolveExistingActivationProjectRootSync(cwd);
	if (scope === "project" && (existingProjectRoot || !isGlobalActivationCwd(cwd, agentDir))) {
		const projectRoot = existingProjectRoot ?? path.resolve(cwd);
		return {
			target: "project",
			configPath: path.join(projectRoot, CONFIG_DIR_NAME, "config.yml"),
			projectRoot,
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
