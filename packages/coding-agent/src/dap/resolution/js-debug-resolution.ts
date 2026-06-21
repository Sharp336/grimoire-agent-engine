import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DapAdapterConfig } from "../types";

const DAP_SERVER_FILE_NAME = "dapDebugServer.js";
const LAUNCHER_SCRIPT_MAX_BYTES = 64 * 1024;
const LAUNCHER_SCRIPT_DIR_REFERENCES = [
	"$basedir",
	"$" + "{basedir}",
	"$BASEDIR",
	"$" + "{BASEDIR}",
	"$dir",
	"$" + "{dir}",
	"$DIR",
	"$" + "{DIR}",
	"%~dp0",
] as const;

const DEFAULT_XDG_DATA_DIRS = ["/usr/local/share", "/usr/share"] as const;
const DATA_DIR_PACKAGE_PARENT_SEGMENTS = [
	["nvim", "mason", "packages"],
	["mason", "packages"],
	["packages"],
	[],
] as const;

function addSearchRootWithAncestors(roots: Set<string>, start: string, maxDepth: number = 4): void {
	let current = path.resolve(start);
	for (let depth = 0; depth <= maxDepth; depth++) {
		roots.add(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

function normalizeLauncherPath(value: string): string {
	return value.replace(/[\\/]+/g, path.sep);
}

function stripLeadingPathSeparators(value: string): string {
	let offset = 0;
	while (offset < value.length && (value[offset] === "/" || value[offset] === "\\")) {
		offset++;
	}
	return value.slice(offset);
}

function resolveLauncherPathToken(token: string, commandDir: string): string | null {
	const normalizedToken = normalizeLauncherPath(token);
	for (const reference of LAUNCHER_SCRIPT_DIR_REFERENCES) {
		if (normalizedToken.startsWith(reference)) {
			const suffix = stripLeadingPathSeparators(normalizedToken.slice(reference.length));
			return path.resolve(commandDir, suffix);
		}
	}
	if (path.isAbsolute(normalizedToken)) return normalizedToken;
	if (normalizedToken.includes(path.sep) || normalizedToken === DAP_SERVER_FILE_NAME) {
		return path.resolve(commandDir, normalizedToken);
	}
	return null;
}

function addExistingLauncherCandidate(paths: Set<string>, token: string, commandDir: string): void {
	const candidate = resolveLauncherPathToken(token, commandDir);
	if (candidate && fs.existsSync(candidate)) {
		paths.add(candidate);
	}
}

function addLauncherTokenCandidates(paths: Set<string>, token: string, commandDir: string): void {
	addExistingLauncherCandidate(paths, token, commandDir);
	const spaceOffset = token.lastIndexOf(" ");
	if (spaceOffset !== -1) {
		addExistingLauncherCandidate(paths, token.slice(spaceOffset + 1), commandDir);
	}
}

function isLauncherTokenBoundary(char: string): boolean {
	return char === '"' || char === "'" || char === "`" || char === "\n" || char === "\r" || char === "\t";
}

function getServerPathsFromLauncher(commandPath: string): string[] {
	let script: string;
	try {
		const stat = fs.statSync(commandPath);
		if (!stat.isFile() || stat.size > LAUNCHER_SCRIPT_MAX_BYTES) return [];
		script = fs.readFileSync(commandPath, "utf-8");
	} catch {
		return [];
	}

	const paths = new Set<string>();
	const commandDir = path.dirname(commandPath);
	let offset = 0;
	while (offset < script.length) {
		const serverFileIndex = script.indexOf(DAP_SERVER_FILE_NAME, offset);
		if (serverFileIndex === -1) break;
		const tokenEnd = serverFileIndex + DAP_SERVER_FILE_NAME.length;
		let tokenStart = serverFileIndex;
		while (tokenStart > 0 && !isLauncherTokenBoundary(script[tokenStart - 1] ?? "")) {
			tokenStart--;
		}
		const token = script.slice(tokenStart, tokenEnd).trim();
		if (token.length > 0) {
			addLauncherTokenCandidates(paths, token, commandDir);
		}
		offset = tokenEnd;
	}
	return Array.from(paths);
}

function getServerSearchRoots(config: DapAdapterConfig, resolvedAdapterCommand: string | null): string[] {
	const roots = new Set<string>();
	const addCommandPath = (commandPath: string) => {
		addSearchRootWithAncestors(roots, path.dirname(commandPath));
	};

	if (resolvedAdapterCommand) {
		addCommandPath(resolvedAdapterCommand);
		try {
			addCommandPath(fs.realpathSync(resolvedAdapterCommand));
		} catch {
			/* command may not have a stable realpath */
		}
	}

	if (config.serverPackageName) {
		for (const root of Array.from(roots)) {
			const packageRoot = path.join(root, config.serverPackageName);
			if (fs.existsSync(packageRoot)) {
				roots.add(packageRoot);
			}
		}
	}

	return Array.from(roots);
}

function addDataDirRoot(roots: Set<string>, dir: string | undefined): void {
	if (!dir || dir.length === 0) return;
	roots.add(path.resolve(dir));
}

function getXdgDataDirs(): string[] {
	const roots = new Set<string>();
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) {
		addDataDirRoot(roots, xdgDataHome);
	} else {
		const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : os.homedir();
		if (home.length > 0) {
			roots.add(path.join(home, ".local", "share"));
		}
	}

	const dataDirs = process.env.XDG_DATA_DIRS;
	const systemDirs =
		dataDirs && dataDirs.length > 0 ? dataDirs.split(path.delimiter) : Array.from(DEFAULT_XDG_DATA_DIRS);
	for (const dir of systemDirs) {
		addDataDirRoot(roots, dir);
	}
	return Array.from(roots);
}

function getDataDirPackageSearchRoots(config: DapAdapterConfig): string[] {
	if (!config.serverPackageName) return [];
	const roots = new Set<string>();
	for (const dataDir of getXdgDataDirs()) {
		for (const segments of DATA_DIR_PACKAGE_PARENT_SEGMENTS) {
			roots.add(path.join(dataDir, ...segments, config.serverPackageName));
		}
	}
	return Array.from(roots);
}

export function resolveJsDebugServerPath(
	config: DapAdapterConfig,
	resolvedAdapterCommand: string | null,
	cwd: string,
): string | null {
	if (config.serverPathEnv) {
		const envPath = process.env[config.serverPathEnv];
		if (envPath && envPath.length > 0) {
			const candidate = path.isAbsolute(envPath) ? envPath : path.resolve(cwd, envPath);
			return fs.existsSync(candidate) ? candidate : null;
		}
	}

	const candidates = config.serverPathCandidates ?? [];
	if (candidates.length === 0) {
		return null;
	}
	if (resolvedAdapterCommand) {
		const commandPaths = new Set<string>();
		commandPaths.add(resolvedAdapterCommand);
		try {
			commandPaths.add(fs.realpathSync(resolvedAdapterCommand));
		} catch {
			/* command may not have a stable realpath */
		}
		for (const commandPath of commandPaths) {
			for (const candidate of getServerPathsFromLauncher(commandPath)) {
				return candidate;
			}
		}
	}
	for (const root of [
		...getServerSearchRoots(config, resolvedAdapterCommand),
		...getDataDirPackageSearchRoots(config),
	]) {
		for (const relativeCandidate of candidates) {
			const candidate = path.resolve(root, relativeCandidate);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}
