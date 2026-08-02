/**
 * MCP Configuration File Writer
 *
 * Utilities for reading/writing .omp/mcp.json files at user or project level.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { invalidate as invalidateFsCache } from "../capability/fs";
import { withFileLock } from "../config/file-lock";

import { validateServerConfig } from "./config";
import { MCP_CONFIG_SCHEMA_URL, type MCPConfigFile, type MCPServerConfig } from "./types";

function withSchema(config: MCPConfigFile): MCPConfigFile {
	return {
		$schema: config.$schema ?? MCP_CONFIG_SCHEMA_URL,
		...config,
	};
}

/**
 * Serialize a read-modify-write against one config file.
 *
 * Wraps {@link withFileLock} but first ensures the config's parent directory
 * exists, because the lock directory (`${filePath}.lock`) is created with a
 * non-recursive `mkdir` — without this the very first write (before the config
 * file or its parent exists) would fail to acquire the lock with ENOENT.
 */
function withConfigLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	return fs.promises
		.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
		.then(() => withFileLock(filePath, fn));
}

/**
 * Read an MCP config file.
 * Returns empty config if file doesn't exist.
 */
export async function readMCPConfigFile(filePath: string): Promise<MCPConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as MCPConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			// File doesn't exist, return empty config
			return { mcpServers: {} };
		}
		throw error;
	}
}

/**
 * Write an MCP config file atomically.
 * Creates parent directories if they don't exist.
 */
export async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
	// Ensure parent directory exists
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	// Write to a per-writer temp file, then atomically rename into place. The
	// temp name is unique (pid + random) so two concurrent writers to the same
	// config never share one `.tmp` path and rename each other's file out from
	// under them (which surfaced as ENOENT or a clobbered final file).
	const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const content = JSON.stringify(withSchema(config), null, 2);
	try {
		await fs.promises.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
		// Rename to final path (atomic on most systems)
		await fs.promises.rename(tmpPath, filePath);
	} catch (error) {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
	// Invalidate the capability fs cache so subsequent reads see the new content
	invalidateFsCache(filePath);
}

/**
 * Validate server name.
 * @returns Error message if invalid, undefined if valid
 */
export function validateServerName(name: string): string | undefined {
	if (!name) {
		return "Server name cannot be empty";
	}
	if (name.length > 100) {
		return "Server name is too long (max 100 characters)";
	}
	// Check for invalid characters. Colon is allowed so namespaced plugin servers
	// (e.g. "cloudflare:cloudflare-api" from a Claude Code marketplace plugin) can
	// be persisted: the runtime already accepts colons in server names (tool names
	// sanitize them via createMCPToolName) and `/mcp reauth` writes such names back
	// as a user-config override that shadows the discovered entry.
	if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) {
		return "Server name can only contain letters, numbers, dash, underscore, dot, and colon";
	}
	return undefined;
}

/**
 * Add an MCP server to a config file.
 * Validates the config before writing.
 *
 * @throws Error if server name already exists or validation fails
 */
export async function addMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	// Validate server name
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate the config
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	// Serialize the read-modify-write under a per-file lock so a concurrent
	// mutation cannot overwrite this one (lost update). The lock also guards
	// against cross-process writers sharing the same config file.
	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		// Check for duplicate name
		if (existing.mcpServers?.[name]) {
			throw new Error(`Server "${name}" already exists in ${filePath}`);
		}

		const updated: MCPConfigFile = {
			...existing,
			mcpServers: {
				...existing.mcpServers,
				[name]: config,
			},
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

/**
 * Update an existing MCP server in a config file.
 * If the server doesn't exist, this will add it.
 *
 * @throws Error if validation fails
 */
export async function updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	// Validate server name
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate the config
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	// Serialize the read-modify-write (see addMCPServer).
	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		const updated: MCPConfigFile = {
			...existing,
			mcpServers: {
				...existing.mcpServers,
				[name]: config,
			},
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

/**
 * Remove an MCP server from a config file.
 *
 * @throws Error if server doesn't exist
 */
export async function removeMCPServer(filePath: string, name: string): Promise<void> {
	// Serialize the read-modify-write (see addMCPServer).
	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		if (!existing.mcpServers?.[name]) {
			throw new Error(`Server "${name}" not found in ${filePath}`);
		}

		const { [name]: _removed, ...remaining } = existing.mcpServers;
		const updated: MCPConfigFile = {
			...existing,
			mcpServers: remaining,
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

/**
 * Get a specific server config from a file.
 * Returns undefined if server doesn't exist.
 */
export async function getMCPServer(filePath: string, name: string): Promise<MCPServerConfig | undefined> {
	const config = await readMCPConfigFile(filePath);
	return config.mcpServers?.[name];
}

/** Read the disabled server-name denylist from an MCP config file. */
export async function readDisabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Array.isArray(config.disabledServers) ? config.disabledServers : [];
}

/** Add or remove a server name from an MCP config file's denylist. */
export async function setServerDisabled(filePath: string, name: string, disabled: boolean): Promise<void> {
	await withConfigLock(filePath, async () => {
		const config = await readMCPConfigFile(filePath);
		const current = new Set(config.disabledServers ?? []);
		if (disabled) current.add(name);
		else current.delete(name);

		const updated: MCPConfigFile = {
			...config,
			disabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
		};
		if (!updated.disabledServers) delete updated.disabledServers;
		await writeMCPConfigFile(filePath, updated);
	});
}

/** Read the force-enable allowlist for source-owned disabled MCPs. */
export async function readEnabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Array.isArray(config.enabledServers) ? config.enabledServers : [];
}

/** Add or remove a server name from an MCP config file's force-enable allowlist. */
export async function setServerForceEnabled(filePath: string, name: string, force: boolean): Promise<void> {
	await withConfigLock(filePath, async () => {
		const config = await readMCPConfigFile(filePath);
		const current = new Set(config.enabledServers ?? []);
		if (force) current.add(name);
		else current.delete(name);

		const updated: MCPConfigFile = {
			...config,
			enabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
		};
		if (!updated.enabledServers) delete updated.enabledServers;
		await writeMCPConfigFile(filePath, updated);
	});
}

/** Atomically set an inherited server's project activation overlay. */
export async function setServerOverlayActivation(
	filePath: string,
	name: string,
	state: "disabled" | "enabled" | "inherit",
): Promise<void> {
	await withConfigLock(filePath, async () => {
		const config = await readMCPConfigFile(filePath);
		const disabled = new Set(config.disabledServers ?? []);
		const enabled = new Set(config.enabledServers ?? []);
		if (state === "disabled") {
			enabled.delete(name);
			disabled.add(name);
		} else if (state === "enabled") {
			disabled.delete(name);
			enabled.add(name);
		} else {
			disabled.delete(name);
			enabled.delete(name);
		}
		const updated: MCPConfigFile = { ...config };
		if (disabled.size === 0) delete updated.disabledServers;
		else updated.disabledServers = [...disabled].sort();
		if (enabled.size === 0) delete updated.enabledServers;
		else updated.enabledServers = [...enabled].sort();
		await writeMCPConfigFile(filePath, updated);
	});
}

/** Paths and target state for toggling one MCP server across known config files. */
export interface SetMcpServerEnabledOptions {
	userPath: string;
	projectPath: string;
	/** Absolute source path when the configuration is OMP-owned and writable. */
	sourcePath?: string;
	name: string;
	enabled: boolean;
}

/**
 * Toggle a server without editing a third-party configuration file. A server
 * absent from OMP-owned files is controlled through the user overlay lists.
 */
export async function setMcpServerEnabled(options: SetMcpServerEnabledOptions): Promise<void> {
	const { userPath, projectPath, sourcePath, name, enabled } = options;
	const candidatePaths = [...new Set([sourcePath, projectPath, userPath].filter(path => path !== undefined))];
	let updatedInConfig = false;
	let updatedPath: string | undefined;

	for (const filePath of candidatePaths) {
		const config = await readMCPConfigFile(filePath);
		const server = config.mcpServers?.[name];
		if (server === undefined) continue;
		await updateMCPServer(filePath, name, { ...server, enabled });
		updatedInConfig = true;
		updatedPath = filePath;
		break;
	}

	const updatedUserConfig = updatedPath === userPath;
	if (enabled) {
		if ((await readDisabledServers(userPath)).includes(name) && (!updatedInConfig || updatedUserConfig)) {
			await setServerDisabled(userPath, name, false);
		}
		const forced = (await readEnabledServers(userPath)).includes(name);
		if (!updatedInConfig && !forced) {
			await setServerForceEnabled(userPath, name, true);
		} else if (updatedUserConfig && forced) {
			await setServerForceEnabled(userPath, name, false);
		}
		return;
	}

	if (updatedUserConfig && (await readEnabledServers(userPath)).includes(name)) {
		await setServerForceEnabled(userPath, name, false);
	}
	if (!updatedInConfig) {
		await setServerDisabled(userPath, name, true);
	}
}

/**
 * List all server names in a config file.
 */
export async function listMCPServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Object.keys(config.mcpServers ?? {});
}
