import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { hasRootMarkers, resolveCommand } from "../lsp/config";
import { adapterRequiresServerPath, resolveAdapterServerPath } from "./adapter-server-resolution";
import DEFAULTS from "./defaults.json" with { type: "json" };
import { resolveBunDapXAdapterCommand } from "./resolution/bun-dap-x-resolution";
import type { DapAdapterConfig, DapCommandResolverName, DapResolvedAdapter, DapServerResolverName } from "./types";

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
	const commandResolver: DapCommandResolverName | undefined =
		config.commandResolver === "bun-dap-x" ? "bun-dap-x" : undefined;
	const serverResolver: DapServerResolverName | undefined =
		config.serverResolver === "js-debug" ? "js-debug" : undefined;
	const serverPathEnv =
		typeof config.serverPathEnv === "string" && config.serverPathEnv.length > 0 ? config.serverPathEnv : undefined;
	const serverPackageName =
		typeof config.serverPackageName === "string" && config.serverPackageName.length > 0
			? config.serverPackageName
			: undefined;
	const serverPathCandidates = normalizeStringArray(config.serverPathCandidates);
	const debugConfigTypes = normalizeStringArray(config.debugConfigTypes);
	return {
		command: config.command,
		args: normalizeStringArray(config.args),
		...(runtimeCommand ? { runtimeCommand } : {}),
		...(commandResolver ? { commandResolver } : {}),
		...(serverResolver ? { serverResolver } : {}),
		...(serverPathEnv ? { serverPathEnv } : {}),
		...(serverPackageName ? { serverPackageName } : {}),
		...(serverPathCandidates.length > 0 ? { serverPathCandidates } : {}),
		languages: normalizeStringArray(config.languages),
		fileTypes: normalizeStringArray(config.fileTypes).map(entry => entry.toLowerCase()),
		rootMarkers: normalizeStringArray(config.rootMarkers),
		debugConfigTypes,
		requiresRootMarkerForAutoSelect: config.requiresRootMarkerForAutoSelect === true,
		launchDefaults: normalizeObject(config.launchDefaults),
		attachDefaults: normalizeObject(config.attachDefaults),
		acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
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

export function resolveAdapter(adapterName: string, cwd: string): DapResolvedAdapter | null {
	const config = DEFAULT_ADAPTERS[adapterName];
	if (!config) return null;

	const commandResolution = config.commandResolver === "bun-dap-x" ? resolveBunDapXAdapterCommand(cwd) : null;
	const resolvedAdapterCommand = commandResolution?.resolvedCommand ?? resolveCommand(config.command, cwd);
	const requiresServerPath = adapterRequiresServerPath(config);
	const serverPath = requiresServerPath ? resolveAdapterServerPath(config, resolvedAdapterCommand, cwd) : null;
	if (requiresServerPath && !serverPath) return null;

	const launchCommand = config.runtimeCommand ?? config.command;
	const resolvedCommand = config.runtimeCommand ? resolveCommand(config.runtimeCommand, cwd) : resolvedAdapterCommand;
	if (!resolvedCommand) return null;
	const configuredArgs = (config.args ?? []).map(arg =>
		serverPath ? arg.replace(DAP_SERVER_PATH_ARGUMENT, serverPath) : arg,
	);
	const args = commandResolution?.args ?? configuredArgs;
	return {
		name: adapterName,
		command: launchCommand,
		args,
		resolvedCommand,
		languages: config.languages ?? [],
		fileTypes: config.fileTypes ?? [],
		rootMarkers: config.rootMarkers ?? [],
		debugConfigTypes: config.debugConfigTypes ?? [],
		launchDefaults: config.launchDefaults ?? {},
		attachDefaults: config.attachDefaults ?? {},
		connectMode: config.connectMode ?? "stdio",
		threadlessContinueNeedsChildStopWait: config.threadlessContinueNeedsChildStopWait,
		acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
		requiresRootMarkerForAutoSelect: config.requiresRootMarkerForAutoSelect,
	};
}

export function getAvailableAdapters(cwd: string): DapResolvedAdapter[] {
	return Object.keys(DEFAULT_ADAPTERS)
		.map(name => resolveAdapter(name, cwd))
		.filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
}

function adapterMatchesDebugConfigType(adapter: DapResolvedAdapter, configType: string): boolean {
	return adapter.debugConfigTypes.some(entry => {
		if (entry.endsWith("*")) {
			return configType.startsWith(entry.slice(0, -1));
		}
		return entry === configType;
	});
}

export function resolveChildAdapterForConfigType(
	configType: string | undefined,
	parentAdapter: DapResolvedAdapter,
	cwd: string,
): DapResolvedAdapter {
	if (!configType) {
		return parentAdapter;
	}
	if (adapterMatchesDebugConfigType(parentAdapter, configType)) {
		return parentAdapter;
	}
	const adapter = getAvailableAdapters(cwd).find(
		candidate => candidate.name !== parentAdapter.name && adapterMatchesDebugConfigType(candidate, configType),
	);
	return adapter ?? parentAdapter;
}

function hasAdapterRootMatch(adapter: DapResolvedAdapter, cwd: string): boolean {
	return adapter.rootMarkers.length > 0 && hasRootMarkers(cwd, adapter.rootMarkers);
}

function isImplicitLaunchCandidate(adapter: DapResolvedAdapter, cwd: string): boolean {
	return !adapter.requiresRootMarkerForAutoSelect || hasAdapterRootMatch(adapter, cwd);
}

function getMatchingAdapters(program: string, cwd: string): DapResolvedAdapter[] {
	const extension = path.extname(program).toLowerCase();
	const available = getAvailableAdapters(cwd).filter(adapter => isImplicitLaunchCandidate(adapter, cwd));
	if (!extension) {
		// For extensionless binaries, only consider native debuggers (gdb, lldb-dap)
		// or adapters that match by root markers. Don't silently fall back to
		// unrelated adapters like debugpy for a C binary.
		const nativeDebuggers: ReadonlySet<string> = new Set(EXTENSIONLESS_DEBUGGER_ORDER);
		return available.filter(adapter => nativeDebuggers.has(adapter.name) || hasAdapterRootMatch(adapter, cwd));
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
		hasRootMatch: hasAdapterRootMatch(adapter, cwd),
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

export function selectAttachAdapter(
	cwd: string,
	adapterName?: string,
	port?: number,
	inspectorUrl?: string,
): DapResolvedAdapter | null {
	if (adapterName) {
		return resolveAdapter(adapterName, cwd);
	}
	const available = getAvailableAdapters(cwd);
	if (inspectorUrl) {
		return available.find(adapter => adapter.name === "bun") ?? null;
	}
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
