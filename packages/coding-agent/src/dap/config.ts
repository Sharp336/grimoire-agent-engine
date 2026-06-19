import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { hasRootMarkers, resolveCommand } from "../lsp/config";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { DapAdapterConfig, DapResolvedAdapter } from "./types";

const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"] as const;
const DAP_SERVER_PATH_ARGUMENT = "$" + "{serverPath}";

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

function getXdgDataDirs(): string[] {
	const dirs = new Set<string>();
	dirs.add(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"));
	for (const entry of (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(path.delimiter)) {
		if (entry.length > 0) {
			dirs.add(entry);
		}
	}
	return Array.from(dirs);
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
		for (const dataDir of getXdgDataDirs()) {
			roots.add(path.join(dataDir, "nvim", "mason", "packages", config.serverPackageName));
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
	for (const root of getServerSearchRoots(config, resolvedAdapterCommand)) {
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
