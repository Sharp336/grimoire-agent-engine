import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { hasRootMarkers, resolveCommand } from "../lsp/config";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { DapAdapterConfig, DapResolvedAdapter } from "./types";

const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"] as const;
const DAP_SERVER_PATH_ARGUMENT = "$" + "{serverPath}";
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

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeObject(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

function normalizeAdapterConfig(config: unknown): DapAdapterConfig | null {
	if (!isRecord(config)) return null;
	if (typeof config.command !== "string" || config.command.length === 0) return null;
	const connectMode =
		config.connectMode === "socket" || config.connectMode === "tcp"
			? (config.connectMode as "socket" | "tcp")
			: undefined;
	const runtimeCommand =
		typeof config.runtimeCommand === "string" && config.runtimeCommand.length > 0 ? config.runtimeCommand : undefined;
	const serverPathEnv =
		typeof config.serverPathEnv === "string" && config.serverPathEnv.length > 0 ? config.serverPathEnv : undefined;
	const serverPackageName =
		typeof config.serverPackageName === "string" && config.serverPackageName.length > 0
			? config.serverPackageName
			: undefined;
	const serverPathCandidates = normalizeStringArray(config.serverPathCandidates);
	return {
		command: config.command,
		args: normalizeStringArray(config.args),
		...(runtimeCommand ? { runtimeCommand } : {}),
		...(serverPathEnv ? { serverPathEnv } : {}),
		...(serverPackageName ? { serverPackageName } : {}),
		...(serverPathCandidates.length > 0 ? { serverPathCandidates } : {}),
		languages: normalizeStringArray(config.languages),
		fileTypes: normalizeStringArray(config.fileTypes).map(entry => entry.toLowerCase()),
		rootMarkers: normalizeStringArray(config.rootMarkers),
		launchDefaults: normalizeObject(config.launchDefaults),
		attachDefaults: normalizeObject(config.attachDefaults),
		acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
		childSessionTypes: normalizeStringArray(config.childSessionTypes),
		threadlessContinueNeedsChildStopWait: config.threadlessContinueNeedsChildStopWait === true,
		...(connectMode ? { connectMode } : {}),
	};
}

function getDefaults(): Record<string, DapAdapterConfig> {
	const adapters: Record<string, DapAdapterConfig> = {};
	for (const [name, config] of Object.entries(DEFAULTS)) {
		const normalized = normalizeAdapterConfig(config);
		if (normalized) {
			adapters[name] = normalized;
		}
	}
	return adapters;
}

const DEFAULT_ADAPTERS = getDefaults();

export function getAdapterConfigs(): Record<string, DapAdapterConfig> {
	return { ...DEFAULT_ADAPTERS };
}

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

function resolveConfiguredServerPath(
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

export function resolveAdapter(adapterName: string, cwd: string): DapResolvedAdapter | null {
	const config = DEFAULT_ADAPTERS[adapterName];
	if (!config) return null;

	const resolvedAdapterCommand = resolveCommand(config.command, cwd);
	const usesServerPath = Boolean(config.serverPathEnv || (config.serverPathCandidates?.length ?? 0) > 0);
	const serverPath = usesServerPath ? resolveConfiguredServerPath(config, resolvedAdapterCommand, cwd) : null;
	if (usesServerPath && !serverPath) return null;

	const launchCommand = config.runtimeCommand ?? config.command;
	const resolvedCommand = config.runtimeCommand ? resolveCommand(config.runtimeCommand, cwd) : resolvedAdapterCommand;
	if (!resolvedCommand) return null;
	return {
		name: adapterName,
		command: launchCommand,
		args: (config.args ?? []).map(arg => (serverPath ? arg.replace(DAP_SERVER_PATH_ARGUMENT, serverPath) : arg)),
		resolvedCommand,
		languages: config.languages ?? [],
		fileTypes: config.fileTypes ?? [],
		rootMarkers: config.rootMarkers ?? [],
		launchDefaults: config.launchDefaults ?? {},
		attachDefaults: config.attachDefaults ?? {},
		connectMode: config.connectMode ?? "stdio",
		childSessionTypes: config.childSessionTypes,
		threadlessContinueNeedsChildStopWait: config.threadlessContinueNeedsChildStopWait,
		acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
	};
}

export function getAvailableAdapters(cwd: string): DapResolvedAdapter[] {
	return Object.keys(DEFAULT_ADAPTERS)
		.map(name => resolveAdapter(name, cwd))
		.filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
}

function getMatchingAdapters(program: string, cwd: string): DapResolvedAdapter[] {
	const extension = path.extname(program).toLowerCase();
	const available = getAvailableAdapters(cwd);
	if (!extension) {
		// For extensionless binaries, only consider native debuggers (gdb, lldb-dap)
		// or adapters that match by root markers. Don't silently fall back to
		// unrelated adapters like debugpy for a C binary.
		const nativeDebuggers: ReadonlySet<string> = new Set(EXTENSIONLESS_DEBUGGER_ORDER);
		return available.filter(
			adapter =>
				nativeDebuggers.has(adapter.name) ||
				(adapter.rootMarkers.length > 0 && hasRootMarkers(cwd, adapter.rootMarkers)),
		);
	}
	const exactMatches = available.filter(adapter => adapter.fileTypes.includes(extension));
	if (exactMatches.length > 0) {
		return exactMatches;
	}
	return available;
}

function sortAdaptersForLaunch(program: string, cwd: string, adapters: DapResolvedAdapter[]): DapResolvedAdapter[] {
	const extension = path.extname(program).toLowerCase();
	const rootAware = adapters.map(adapter => ({
		adapter,
		hasExtensionMatch: extension.length > 0 && adapter.fileTypes.includes(extension),
		hasRootMatch: adapter.rootMarkers.length > 0 && hasRootMarkers(cwd, adapter.rootMarkers),
	}));
	rootAware.sort((left, right) => {
		if (left.hasExtensionMatch !== right.hasExtensionMatch) {
			return left.hasExtensionMatch ? -1 : 1;
		}
		if (left.hasRootMatch !== right.hasRootMatch) {
			return left.hasRootMatch ? -1 : 1;
		}
		const leftDebuggerRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
			left.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
		);
		const rightDebuggerRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
			right.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
		);
		const normalizedLeftRank = leftDebuggerRank === -1 ? Number.MAX_SAFE_INTEGER : leftDebuggerRank;
		const normalizedRightRank = rightDebuggerRank === -1 ? Number.MAX_SAFE_INTEGER : rightDebuggerRank;
		if (normalizedLeftRank !== normalizedRightRank) {
			return normalizedLeftRank - normalizedRightRank;
		}
		return left.adapter.name.localeCompare(right.adapter.name);
	});
	return rootAware.map(entry => entry.adapter);
}

export function selectLaunchAdapter(
	program: string,
	cwd: string,
	adapterName?: string,
	programKind: LaunchProgramKind = "file",
): DapResolvedAdapter | null {
	if (adapterName) {
		return resolveAdapter(adapterName, cwd);
	}
	const matches = getMatchingAdapters(program, cwd);
	const candidates =
		programKind === "directory" ? matches.filter(adapter => adapter.acceptsDirectoryProgram) : matches;
	const sorted = sortAdaptersForLaunch(program, cwd, candidates.length > 0 ? candidates : matches);
	return sorted[0] ?? null;
}

export function selectAttachAdapter(cwd: string, adapterName?: string, port?: number): DapResolvedAdapter | null {
	if (adapterName) {
		return resolveAdapter(adapterName, cwd);
	}
	const available = getAvailableAdapters(cwd);
	if (port !== undefined) {
		const debugpy = available.find(adapter => adapter.name === "debugpy");
		if (debugpy) return debugpy;
	}
	for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
		const match = available.find(adapter => adapter.name === preferred);
		if (match) return match;
	}
	return available[0] ?? null;
}

/** How the launch `program` resolves on disk. `"missing"` is reserved for
 *  programs the adapter creates on demand (rare); we treat them like files. */
export type LaunchProgramKind = "file" | "directory" | "missing";

/** Compute adapter-specific launch arguments that depend on the resolved
 *  program. Returned values are spread over `adapter.launchDefaults` so they
 *  take precedence over the static defaults but can still be overridden by
 *  the fields `DapSessionManager.launch` sets explicitly (program, cwd, args).
 *
 *  Currently scoped to dlv, where `mode` selects how the program path is
 *  interpreted: directories and `.go` source files debug as a Go package
 *  (`mode=debug`), anything else is treated as a compiled binary (`mode=exec`).
 */
export function resolveLaunchOverrides(
	adapter: DapResolvedAdapter,
	program: string,
	programKind: LaunchProgramKind,
): Record<string, unknown> {
	if (adapter.name === "dlv") {
		const extension = path.extname(program).toLowerCase();
		if (programKind === "directory" || extension === ".go") {
			return { mode: "debug" };
		}
		if (programKind === "file") {
			return { mode: "exec" };
		}
	}
	return {};
}
