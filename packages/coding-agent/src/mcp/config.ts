/**
 * MCP configuration loader.
 *
 * Uses the capability system to load MCP servers from multiple sources.
 */

import * as path from "node:path";
import { getMCPConfigPath, tryParseJson } from "@oh-my-pi/pi-utils";
import { mcpCapability } from "../capability/mcp";
import type { SourceMeta } from "../capability/types";
import type { MCPServer } from "../discovery";
import { loadCapability } from "../discovery";
import { type MCPConfigFile, transformMCPConfig, validateMCPConfigFile } from "../discovery/mcp-json";
import { expandTilde } from "../tools/path-utils";
import { readDisabledServers, readEnabledServers } from "./config-writer";
import type { MCPServerConfig } from "./types";

/** Options for loading MCP configs */
export interface LoadMCPConfigsOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when builtin browser tool is enabled (default: false) */
	filterBrowser?: boolean;
	/**
	 * Extra MCP config files (`mcpServers` JSON, e.g. from `--mcp-config`).
	 * Servers from these files override same-named discovered servers.
	 */
	extraConfigPaths?: string[];
}

/** Result of loading MCP configs */
export interface LoadMCPConfigsResult {
	/** Loaded server configs */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any were filtered) */
	exaApiKeys: string[];
	/** Source metadata for each server */
	sources: Record<string, SourceMeta>;
}

/**
 * Convert canonical MCPServer to legacy MCPServerConfig.
 */
function convertToLegacyConfig(server: MCPServer): MCPServerConfig {
	// Determine transport type
	const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
	const shared = {
		enabled: server.enabled,
		timeout: server.timeout,
		auth: server.auth,
		oauth: server.oauth,
	};

	if (transport === "stdio") {
		const config: MCPServerConfig = {
			...shared,
			type: "stdio" as const,
			command: server.command ?? "",
		};
		if (server.args) config.args = server.args;
		if (server.env) config.env = server.env;
		if (server.cwd) config.cwd = server.cwd;
		return config;
	}

	if (transport === "http") {
		const config: MCPServerConfig = {
			...shared,
			type: "http" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		return config;
	}

	if (transport === "sse") {
		const config: MCPServerConfig = {
			...shared,
			type: "sse" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		return config;
	}

	// Fallback to stdio
	return {
		...shared,
		type: "stdio" as const,
		command: server.command ?? "",
	};
}

/** Provider id attached to servers loaded from explicit config paths (--mcp-config). */
const EXTRA_CONFIG_PROVIDER_ID = "mcp-config-flag";

/**
 * An explicitly named MCP config file (`--mcp-config`) could not be used.
 *
 * Distinct from discovery failures so the layers that degrade discovery to a
 * best-effort result — `discoverAndLoadMCPTools`, session startup — can let
 * this one through instead of starting without the servers the caller named.
 */
export class ExplicitMCPConfigError extends Error {
	constructor(
		readonly configPath: string,
		message: string,
	) {
		super(message);
		this.name = "ExplicitMCPConfigError";
	}
}

/**
 * An `enabled: false` entry with no endpoint. It exists to suppress a name
 * rather than to describe a server, so it is exempt from the endpoint checks
 * every real entry has to pass.
 */
function isTombstone(server: MCPServer): boolean {
	return server.enabled === false && !server.command && !server.url;
}

/**
 * Whether two servers address the same endpoint, ignoring credentials.
 *
 * `mcpCapability.equivalent` folds `auth`/`oauth` into the comparison, which is
 * right for deduplication but wrong for recognising an auth overlay — the whole
 * point of which is that the credentials differ. Same predicate, auth terms
 * neutralised, so the two stay in step on what an endpoint is.
 */
function sameEndpoint(left: MCPServer, right: MCPServer): boolean {
	return (
		mcpCapability.equivalent?.(
			{ ...left, auth: undefined, oauth: undefined },
			{ ...right, auth: undefined, oauth: undefined },
		) ?? false
	);
}

/**
 * Load MCP servers from explicitly specified `mcpServers` JSON files.
 * Unlike provider discovery, an unreadable or malformed file is a hard error:
 * the caller asked for this exact file.
 */
async function loadExtraMCPConfigs(cwd: string, configPaths: string[]): Promise<MCPServer[]> {
	const servers: MCPServer[] = [];
	for (const configPath of configPaths) {
		const resolved = path.resolve(cwd, expandTilde(configPath));
		let content: string;
		try {
			content = await Bun.file(resolved).text();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ExplicitMCPConfigError(resolved, `Cannot read MCP config ${resolved}: ${message}`);
		}
		const config = tryParseJson<MCPConfigFile>(content);
		if (!config) {
			throw new ExplicitMCPConfigError(resolved, `Invalid JSON in MCP config ${resolved}`);
		}
		// Syntactically valid JSON of the wrong shape would otherwise be iterated
		// into blank servers named by character/array index. `mcpServers` must be
		// present too: pointing the flag at some other valid JSON file (say
		// `package.json`) is a mistake, and accepting it would start the session
		// with none of the servers the caller asked for.
		const invalid = validateMCPConfigFile(config, { strict: true });
		if (invalid) {
			throw new ExplicitMCPConfigError(resolved, `Invalid MCP config ${resolved}: ${invalid}`);
		}
		const source: SourceMeta = {
			provider: EXTRA_CONFIG_PROVIDER_ID,
			providerName: "--mcp-config",
			path: resolved,
			level: "project",
		};
		servers.push(...transformMCPConfig(config, source));
	}
	return servers;
}

/**
 * Load all MCP server configs from standard locations.
 * Uses the capability system for multi-source discovery.
 *
 * @param cwd Working directory (project root)
 * @param options Load options
 */
export async function loadAllMCPConfigs(cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> {
	const enableProjectConfig = options?.enableProjectConfig ?? true;
	const filterExa = options?.filterExa ?? true;
	const filterBrowser = options?.filterBrowser ?? false;

	// Load user-level disable/force-enable lists. The denylist always wins; the
	// allowlist overrides a non-writable source config's `enabled: false`.
	const userPath = getMCPConfigPath("user", cwd);
	const [disabledServers, forcedEnabled] = await Promise.all([
		readDisabledServers(userPath).then(list => new Set(list)),
		readEnabledServers(userPath).then(list => new Set(list)),
	]);

	// Scope exclusions drop entries entirely BEFORE deduplication: with project
	// config disabled, a project entry must not shadow anything.
	const includeServer = (server: MCPServer & { _source: SourceMeta }): boolean =>
		enableProjectConfig || server._source.level !== "project";

	// Disabled servers are suppressed rather than dropped: they still own their
	// name at key-level dedupe (a disabled project `foo` keeps a same-named,
	// lower-priority user `foo` disabled), but never equivalence-shadow a
	// differently-named enabled server — otherwise the disabled alias would be
	// removed downstream and starve the surviving connection.
	const suppressServer = (server: MCPServer & { _source: SourceMeta }): boolean => {
		if (disabledServers.has(server.name)) return true;
		if (server.enabled === false && !forcedEnabled.has(server.name)) return true;
		return false;
	};

	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		filter: includeServer,
		suppress: suppressServer,
	});

	// Servers from explicitly named config files (--mcp-config) take the name
	// over same-named discovered ones. They skip the project-scope gate — the
	// caller named this exact file — but still honour the user denylist and
	// their own `enabled: false`, so an `enabled: false` entry here also drops
	// the discovered server that shares its name. Merged before the Exa/browser
	// filters below so those apply uniformly to every source.
	let servers = result.items;
	if (options?.extraConfigPaths?.length) {
		const extraServers = await loadExtraMCPConfigs(cwd, options.extraConfigPaths);
		// The flag is repeatable, and later files win per name. Resolve that
		// precedence BEFORE suppression: filtering first would drop a later
		// `enabled: false` entry and leave the earlier enabled definition
		// standing, so a downstream file could never turn off a server an
		// upstream one generated.
		const resolved = new Map<string, MCPServer>();
		for (const server of extraServers) {
			// Re-insert rather than overwrite in place: `Map#set` on an existing key
			// keeps the original slot, which would walk a redefined name at its
			// first-appearance position. The alias collapse below reads this order as
			// "who was written last", so a later file redefining an earlier name has
			// to sort after everything written before it — otherwise it loses to an
			// alias for the same endpoint that it was meant to supersede.
			resolved.delete(server.name);
			resolved.set(server.name, server);
		}

		// `/mcp reauth` and `/mcp unauth` persist auth for an explicitly configured
		// server into the writable user config, because a generated `--mcp-config`
		// file is not omp's to edit (`#resolveServerForAuth` falls back to the user
		// path for anything it cannot find in a discovery config). That makes the
		// user entry the live record of auth for these servers, so its `auth` and
		// `oauth` win here — including their absence, which is what `unauth` leaves
		// behind. Only those two fields: the explicit file stays the source of
		// truth for the endpoint, so a regenerated config can still move a port
		// without the user copy masking it.
		//
		// The name alone does not identify an overlay, though: a user config is a
		// general store, and a stale entry for some other endpoint that happens to
		// share a name would otherwise strip an explicit server's credentials. The
		// auth commands write back the endpoint they were run against, so an
		// overlay is a same-named entry describing the same endpoint.
		const userEntries = new Map<string, MCPServer>();
		for (const server of result.items) {
			if (server._source.path === userPath) userEntries.set(server.name, server);
		}

		const kept: MCPServer[] = [];
		const claimed = new Set<string>();
		for (const server of resolved.values()) {
			// A tombstone can never become a config in its own right — it just takes
			// the same-named discovered server down with it. When the user's
			// force-enable list stops it from suppressing, it has to yield the name
			// back to discovery, the only source then holding a real definition;
			// keeping it would leave a blank stdio config that fails to connect. An
			// entry carrying a transport is a complete config that happens to be
			// off, so force-enabling keeps it — the same way `suppressServer` treats
			// a disabled-but-complete discovered server.
			if (isTombstone(server) && forcedEnabled.has(server.name)) continue;
			claimed.add(server.name);
			if (suppressServer(server)) continue;
			// Aliases collapse among the explicit entries too, not just against
			// discovered ones: `loadCapability` applies the same rule to everything
			// it loads, including two names for one endpoint inside a single file.
			// Later wins, matching the same-name rule above — whichever entry the
			// caller wrote last is the one whose name the endpoint keeps.
			const userEntry = userEntries.get(server.name);
			const isAuthOverlay = userEntry !== undefined && sameEndpoint(userEntry, server);
			const merged = isAuthOverlay ? { ...server, auth: userEntry.auth, oauth: userEntry.oauth } : server;
			const aliasIndex = kept.findIndex(existing => mcpCapability.equivalent?.(existing, merged) ?? false);
			if (aliasIndex >= 0) kept.splice(aliasIndex, 1);
			kept.push(merged);
		}

		// Validation runs last, over survivors only, exactly where `loadCapability`
		// puts it: it validates `deduped`, so an entry that was suppressed or
		// shadowed is never checked. Validating at load time instead would abort
		// startup over a server the user had switched off, or over one a later
		// file replaced. Discovered servers get this from the pipeline; explicit
		// ones raise instead of being dropped, because the caller named the file.
		for (const server of kept) {
			const error = mcpCapability.validate?.(server);
			if (error) {
				const configPath = server._source.path;
				throw new ExplicitMCPConfigError(
					configPath,
					`Invalid MCP config ${configPath}: server "${server.name}": ${error}`,
				);
			}
		}

		// Same-endpoint aliases shadow each other inside `loadCapability` via
		// `mcpCapability.equivalent`; extras are merged after that, so a discovered
		// server the caller renamed in an explicit file has to be dropped here too.
		// Otherwise the manager opens a second connection to the one endpoint and
		// mounts its tools twice — the exact case this flag invites, since a
		// generated per-workspace config renames what the project file already has.
		const shadowedByExtra = (server: MCPServer): boolean =>
			kept.some(extra => mcpCapability.equivalent?.(extra, server) ?? false);
		servers = [...kept, ...servers.filter(server => !claimed.has(server.name) && !shadowedByExtra(server))];
	}

	// Convert to legacy format and preserve source metadata.
	let configs: Record<string, MCPServerConfig> = {};
	let sources: Record<string, SourceMeta> = {};
	for (const server of servers) {
		configs[server.name] = convertToLegacyConfig(server);
		sources[server.name] = server._source;
	}

	let exaApiKeys: string[] = [];

	if (filterExa) {
		const exaResult = filterExaMCPServers(configs, sources);
		configs = exaResult.configs;
		sources = exaResult.sources;
		exaApiKeys = exaResult.exaApiKeys;
	}

	if (filterBrowser) {
		const browserResult = filterBrowserMCPServers(configs, sources);
		configs = browserResult.configs;
		sources = browserResult.sources;
	}

	return { configs, exaApiKeys, sources };
}

/** Pattern to match Exa MCP servers */
const EXA_MCP_URL_PATTERN = /mcp\.exa\.ai/i;
const EXA_API_KEY_PATTERN = /exaApiKey=([^&\s]+)/i;

/**
 * Check if a server config is an Exa MCP server.
 */
export function isExaMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (name.toLowerCase() === "exa") {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && EXA_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by args for stdio servers (e.g., mcp-remote to exa)
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args?.some(arg => EXA_MCP_URL_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/**
 * Extract Exa API key from an MCP server config.
 */
export function extractExaApiKey(config: MCPServerConfig): string | undefined {
	// Check URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url) {
			const match = EXA_API_KEY_PATTERN.exec(httpConfig.url);
			if (match) return match[1];
		}
	}

	// Check args for stdio servers
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args) {
			for (const arg of stdioConfig.args) {
				const match = EXA_API_KEY_PATTERN.exec(arg);
				if (match) return match[1];
			}
		}
	}

	// Check env vars
	if ("env" in config && config.env) {
		const envConfig = config as { env: Record<string, string> };
		if (envConfig.env.EXA_API_KEY) {
			return envConfig.env.EXA_API_KEY;
		}
	}

	return undefined;
}

/** Result of filtering Exa MCP servers */
export interface ExaFilterResult {
	/** Configs with Exa servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any) */
	exaApiKeys: string[];
	/** Source metadata for remaining servers */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out Exa MCP servers and extract their API keys.
 * Since we have native Exa integration, we don't need the MCP server.
 */
export function filterExaMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): ExaFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};
	const exaApiKeys: string[] = [];

	for (const [name, config] of Object.entries(configs)) {
		if (isExaMCPServer(name, config)) {
			// Extract API key before filtering
			const apiKey = extractExaApiKey(config);
			if (apiKey) {
				exaApiKeys.push(apiKey);
			}
		} else {
			filtered[name] = config;
			if (sources[name]) {
				filteredSources[name] = sources[name];
			}
		}
	}

	return { configs: filtered, exaApiKeys, sources: filteredSources };
}

/**
 * Validate server config has required fields.
 */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
	const errors: string[] = [];

	const serverType = config.type ?? "stdio";

	// Check for conflicting transport fields
	const hasCommand = "command" in config && config.command;
	const hasUrl = "url" in config && (config as { url?: string }).url;
	if (hasCommand && hasUrl) {
		errors.push(
			`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`,
		);
	}

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(`Server "${name}": stdio server requires "command" field`);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(`Server "${name}": ${serverType} server requires "url" field`);
		}
	} else {
		errors.push(`Server "${name}": unknown server type "${serverType}"`);
	}

	return errors;
}

/** Known browser automation MCP server names (lowercase) */
const BROWSER_MCP_NAMES = new Set([
	"puppeteer",
	"playwright",
	"browserbase",
	"browser-tools",
	"browser-use",
	"browser",
]);

/** Patterns matching browser MCP package names in command/args */
const BROWSER_MCP_PKG_PATTERN =
	// Official packages
	// - @modelcontextprotocol/server-puppeteer
	// - @playwright/mcp
	// - @browserbasehq/mcp-server-browserbase
	// - @agentdeskai/browser-tools-mcp
	// - @agent-infra/mcp-server-browser
	// Community packages: puppeteer-mcp-server, playwright-mcp, pptr-mcp, etc.
	/(?:@modelcontextprotocol\/server-puppeteer|@playwright\/mcp|@browserbasehq\/mcp-server-browserbase|@agentdeskai\/browser-tools-mcp|@agent-infra\/mcp-server-browser|puppeteer-mcp|playwright-mcp|pptr-mcp|browser-use-mcp|mcp-browser-use)/i;

/** URL patterns for hosted browser MCP services */
const BROWSER_MCP_URL_PATTERN = /browserbase\.com|browser-use\.com/i;

/**
 * Check if a server config is a browser automation MCP server.
 */
export function isBrowserMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (BROWSER_MCP_NAMES.has(name.toLowerCase())) {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && BROWSER_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by command/args for stdio servers
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { command?: string; args?: string[] };
		if (stdioConfig.command && BROWSER_MCP_PKG_PATTERN.test(stdioConfig.command)) {
			return true;
		}
		if (stdioConfig.args?.some(arg => BROWSER_MCP_PKG_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/** Result of filtering browser MCP servers */
export interface BrowserFilterResult {
	/** Configs with browser servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Source metadata for remaining servers */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out browser automation MCP servers.
 * Since we have a native browser tool, we don't need these MCP servers.
 */
export function filterBrowserMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): BrowserFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};

	for (const [name, config] of Object.entries(configs)) {
		if (!isBrowserMCPServer(name, config)) {
			filtered[name] = config;
			if (sources[name]) {
				filteredSources[name] = sources[name];
			}
		}
	}

	return { configs: filtered, sources: filteredSources };
}
