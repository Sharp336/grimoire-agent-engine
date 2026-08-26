import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import {
	getActiveClients,
	getActiveOrPendingClient,
	getOrCreateClient,
	isRustAnalyzerClient,
	type LspServerStatus,
	notifySaved,
	sendNotification,
	sendRequest,
	setIdleTimeout,
	shutdownClientInstance,
	syncContent,
	WARMUP_TIMEOUT_MS,
} from "./client";
import { getDefaultServerConfigs, getServersForFile, type LspConfig, loadConfig } from "./config";
import { MUX_RESTART_METHOD } from "./mux/protocol";
import type { LspClient, ServerConfig } from "./types";
import { findWorkspaceRoot, type LspCeiling, type LspCeilingKind, resolveLspCeiling } from "./workspace";

/**
 * LSP actions that do not mutate the workspace or language-server state.
 * Anything not in this set (rename, code_actions with apply, rename_file,
 * reload, raw request, etc.) is classified as write-tier.
 */
export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error" | "available";
	fileTypes: string[];
	error?: string;
}

/** Result from warming up LSP servers */
export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}

/** Options for warming up LSP servers */
export interface LspWarmupOptions {
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
}

export function discoverStartupLspServers(
	cwd: string,
	status: LspStartupServerInfo["status"] = "connecting",
): LspStartupServerInfo[] {
	const config = loadConfig(cwd);
	return getLspServers(config).map(([name, serverConfig]) => ({
		name,
		status,
		fileTypes: serverConfig.fileTypes,
	}));
}

/**
 * Warm up LSP servers for a directory by connecting to all detected servers.
 * This should be called at startup to avoid cold-start delays.
 *
 * @param cwd - Working directory to detect and start servers for
 * @param options - Optional callbacks for progress reporting
 * @returns Status of each server that was started
 */
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	// Notify caller which servers we're connecting to
	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	// Start all detected servers in parallel with a short timeout
	// Servers that don't respond quickly will be initialized lazily on first use
	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			const errorMsg = result.reason?.message ?? String(result.reason);
			logger.warn("LSP server failed to start", { server: name, error: errorMsg });
			servers.push({
				name,
				status: "error",
				fileTypes: serverConfig.fileTypes,
				error: errorMsg,
			});
		}
	}

	return { servers };
}

/**
 * Get status of currently active LSP servers.
 */
export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}

/**
 * Sync in-memory file content to all applicable LSP servers.
 * Sends didOpen (if new) or didChange (if already open).
 *
 * @param absolutePath - Absolute path to the file
 * @param content - The new file content
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to sync to
 */
export async function syncFileContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
	createMissing = true,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = createMissing
				? await getOrCreateClient(serverConfig, cwd, undefined, signal)
				: await getActiveOrPendingClient(serverConfig, cwd, signal);
			if (!client) return;
			throwIfAborted(signal);
			await syncContent(client, absolutePath, content, signal);
		}),
	);
	throwIfAborted(signal);
}

/**
 * Notify all LSP servers that a file was saved.
 * Assumes content was already synced via syncFileContent.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to notify
 */
export async function notifyFileSaved(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
	createMissing = true,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = createMissing
				? await getOrCreateClient(serverConfig, cwd, undefined, signal)
				: await getActiveOrPendingClient(serverConfig, cwd, signal);
			if (!client) return;
			await notifySaved(client, absolutePath, signal);
		}),
	);
	throwIfAborted(signal);
}

// Cache config per cwd to avoid repeated file I/O
export const configCache = new Map<string, LspConfig>();

export function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		configCache.set(cwd, config);
	}
	setIdleTimeout(config.idleTimeoutMs);
	return config;
}

// =============================================================================
// File-driven workspace resolution
// =============================================================================

/** One candidate language server resolved for a concrete file. */
export interface ResolvedFileServer {
	/** Server key in the config (e.g. "typescript-language-server"). */
	name: string;
	/** Server config; `resolvedCommand` is set when the binary resolved inside the project. */
	config: ServerConfig;
	/** Nearest marker-having project root for this server, inside the ceiling (logical path). */
	workspaceRoot: string;
	/** realpath(workspaceRoot): the canonical identity basis for clientKey, mux projectDir, rootUri, and workspaceFolders. */
	workspaceRootReal: string;
	/** The bounded discovery boundary the root was found under. */
	ceiling: string;
	ceilingKind: LspCeilingKind;
	/** Root markers matched but the command could not be resolved inside the project ($PATH excluded for clones). */
	missingBinary: boolean;
}

export interface FileLspResolution {
	ceiling: LspCeiling;
	servers: ResolvedFileServer[];
}

/**
 * Cache config per workspace root + ceiling for file-driven discovery. Never
 * keyed by session cwd, so sibling clones with the same marker layout get
 * independent configs and binary policies.
 */
export const fileConfigCache = new Map<string, LspConfig>();

/** realpath of a workspace root; falls back to the resolved path when the root does not exist. */
export function canonicalRoot(root: string): string {
	try {
		return fs.realpathSync(root);
	} catch {
		return path.resolve(root);
	}
}

/**
 * Load (and cache) the LSP config for a workspace root discovered under a
 * ceiling. Clone ceilings resolve binaries from the workspace root and the
 * clone only — never $PATH — and require the resolved binary to realpath
 * inside the clone (a node_modules symlink into a sibling clone or the
 * founder checkout fails closed as missing-in-clone).
 *
 * Resolved configs cache normally. A miss for the looked-up server (markers
 * matched but the binary does not resolve inside the project) is never
 * cached: the next lookup re-checks the clone, so a clone-local install is
 * picked up without any reload.
 */
export function getFileConfig(root: string, ceiling: LspCeiling, forServer?: string): LspConfig {
	const key = `${root}\u0000${ceiling.path}\u0000${ceiling.kind}`;
	let config = fileConfigCache.get(key);
	if (config && forServer !== undefined && config.unresolved?.[forServer]) {
		// The cached config reports this server as missing; re-check the
		// project so a clone-local install is observed on the next call.
		fileConfigCache.delete(key);
		config = undefined;
	}
	if (!config) {
		const allowPath = ceiling.kind === "session";
		config = loadConfig(root, {
			localRoots: [root, ceiling.path],
			allowPath,
			containmentRoot: allowPath ? undefined : ceiling.path,
		});
		if (forServer === undefined || !config.unresolved?.[forServer]) {
			fileConfigCache.set(key, config);
		}
	}
	setIdleTimeout(config.idleTimeoutMs);
	return config;
}

/** Drop every file-scoped config cache entry for one ceiling (single-file reload keeps other clones). */
export function invalidateFileConfigs(ceiling: LspCeiling): void {
	const suffix = `\u0000${ceiling.path}\u0000${ceiling.kind}`;
	for (const key of [...fileConfigCache.keys()]) {
		if (key.endsWith(suffix)) fileConfigCache.delete(key);
	}
}

/** Drop every file-scoped config cache entry (reload * full refresh). */
export function clearFileConfigCache(): void {
	fileConfigCache.clear();
}

/**
 * Resolve the language servers that apply to a concrete file, each with the
 * workspace identity it must be attached to.
 *
 * Files inside the session cwd keep the session-scoped config and identity —
 * the session is the project the user launched. Files outside it are
 * discovered per file: a git ceiling (an independent clone) bounds the marker
 * walk to the work tree and restricts binary resolution to the clone, so
 * sibling /tmp checkouts and the founder project never share a server.
 *
 * Markers absent inside the ceiling => no servers (not configured). Markers
 * present but the binary unresolvable inside the project => a `missingBinary`
 * entry, so callers can report a structured miss instead of collapsing it
 * into "No language server found".
 */
export function resolveFileLspServers(filePath: string, sessionCwd: string): FileLspResolution {
	const ceiling = resolveLspCeiling(filePath, sessionCwd);
	if (ceiling.escaped) return { ceiling, servers: [] };

	if (ceiling.kind === "session") {
		const config = getConfig(sessionCwd);
		const root = canonicalRoot(sessionCwd);
		return {
			ceiling,
			servers: getServersForFile(config, filePath).map(([name, serverConfig]) => ({
				name,
				config: serverConfig,
				workspaceRoot: sessionCwd,
				workspaceRootReal: root,
				ceiling: ceiling.path,
				ceilingKind: ceiling.kind,
				missingBinary: false,
			})),
		};
	}

			// Clone / stray-file discovery: per-server nearest marker root inside the
		// ceiling, config loaded at that root with clone-local binary resolution.
		// The candidate name keeps an unresolved miss from being cached, so a
		// later clone-local install is observed on the next call.
		const candidates = getServersForFile({ servers: getDefaultServerConfigs() }, filePath);
		const servers: ResolvedFileServer[] = [];
		for (const [name, candidate] of candidates) {
			const root = findWorkspaceRoot(filePath, ceiling, candidate.rootMarkers);
			if (root === null) continue;
			const config = getFileConfig(root, ceiling, name);
		const serverConfig = config.servers[name];
		if (serverConfig) {
			servers.push({
				name,
				config: serverConfig,
				workspaceRoot: root,
				workspaceRootReal: canonicalRoot(root),
				ceiling: ceiling.path,
				ceilingKind: ceiling.kind,
				missingBinary: false,
			});
		} else if (config.unresolved?.[name]) {
			servers.push({
				name,
				config: config.unresolved[name],
				workspaceRoot: root,
				workspaceRootReal: canonicalRoot(root),
				ceiling: ceiling.path,
				ceilingKind: ceiling.kind,
				missingBinary: true,
			});
		}
	}
	return { ceiling, servers };
}

function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

export function splitServers(servers: Array<[string, ServerConfig]>): {
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
} {
	const lspServers: Array<[string, ServerConfig]> = [];
	const customLinterServers: Array<[string, ServerConfig]> = [];
	for (const entry of servers) {
		if (isCustomLinter(entry[1])) {
			customLinterServers.push(entry);
		} else {
			lspServers.push(entry);
		}
	}
	return { lspServers, customLinterServers };
}

export function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}

export function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig));
}

export function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && !serverConfig.isLinter;
}

/** True when an LSP error indicates the server doesn't implement the requested method. */
export function isMethodNotFoundError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("method not found") ||
		msg.includes("unhandled method") ||
		msg.includes("not supported") ||
		msg.includes("-32601")
	);
}

export async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	// rust-analyzer exposes a real reload request. Only rust-analyzer implements
	// it, so gate the request on the binary (or registered name) rather than
	// probing every server: some servers (Roslyn) crash the whole process on an
	// unknown method instead of replying with method-not-found — killing the
	// server `lsp reload` was meant to refresh (issue #8571, dotnet/roslyn#84890).
	// A caller cancel or tool timeout must propagate, never be mistaken for an
	// unsupported method and swallowed into a bogus "Restarted" (issue #6369).
	if (isRustAnalyzerClient(client) || serverName === "rust-analyzer") {
		try {
			await sendRequest(client, "rust-analyzer/reloadWorkspace", undefined, signal);
			return `Reloaded ${serverName}`;
		} catch (err) {
			throwIfAborted(signal);
			if (!isMethodNotFoundError(err)) throw err;
			// Method not supported — fall through to the generic reload.
		}
	}
	// workspace/didChangeConfiguration is a notification per spec; sending it
	// as a request hangs until the tool deadline on servers that route it to
	// the notification handler and never respond.
	try {
		await sendNotification(client, "workspace/didChangeConfiguration", { settings: {} }, signal);
		return `Reloaded ${serverName}`;
	} catch {
		throwIfAborted(signal);
		// The reload notification could not be delivered — the connection is
		// wedged or the process already died. Tear the client down (removing it
		// from the registry by identity and awaiting confirmed process exit) so
		// the next request cold-starts a fresh client. A kill that never confirms
		// exit is not a restart: surface the teardown failure truthfully.
		//
		// On a broker-shared link a per-session teardown only detaches this
		// process while the wedged server keeps serving everyone else — ask the
		// mux to kill the shared server first (best-effort; it also severs us).
		if (client.proc.sharedMux) {
			await sendNotification(client, MUX_RESTART_METHOD, undefined, AbortSignal.timeout(2_000)).catch(() => {});
		}
		if (!(await shutdownClientInstance(client))) {
			throw new Error(`Failed to restart ${serverName}: server process did not exit after kill`);
		}
		return `Restarted ${serverName}`;
	}
}
