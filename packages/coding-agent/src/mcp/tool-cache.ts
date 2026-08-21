/**
 * MCP tool cache.
 *
 * Stores tool definitions per server in agent.db for fast startup.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import type { MCPServerConfig, MCPToolDefinition } from "./types";

const CACHE_VERSION = 1;
const CACHE_PREFIX = "mcp_tools:";
/** How long cached tool definitions stay fresh before one revalidation handshake. */
const CACHE_FRESH_MS = 60 * 60 * 1000;
/** Storage-level retention; a fresh-expired row stays readable as stale until this lapses. */
const CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type MCPToolCachePayload = {
	version: number;
	configHash: string;
	tools: MCPToolDefinition[];
	requiresConnection?: boolean;
	/**
	 * Epoch ms until which this entry counts as fresh. Absent on legacy v1
	 * rows, which are treated as stale: one revalidation, still advertised.
	 */
	freshUntil?: number;
};

export type MCPToolCacheEntry = {
	tools: MCPToolDefinition[];
	/** `null` means the cache predates capability metadata and needs one handshake. */
	requiresConnection: boolean | null;
};

function stableClone(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => stableClone(item));
	}
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableClone(value[key]);
		}
		return sorted;
	}
	return value;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(stableClone(value));
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let output = "";
	for (const byte of bytes) {
		output += byte.toString(16).padStart(2, "0");
	}
	return output;
}

async function hashConfig(config: MCPServerConfig): Promise<string> {
	const stable = stableStringify(config);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

export class MCPToolCache {
	constructor(
		private storage: AgentStorage,
		private clock: () => number = Date.now,
	) {}

	async get(
		serverName: string,
		config: MCPServerConfig,
		options?: { includeStale?: boolean },
	): Promise<MCPToolDefinition[] | null> {
		return (await this.getEntry(serverName, config, options))?.tools ?? null;
	}

	/**
	 * Fresh-only by default: a stale entry returns null so callers still
	 * trigger one revalidation handshake. Pass `{ includeStale: true }` to read
	 * a config-matching entry whose freshness lapsed but whose storage
	 * retention holds.
	 */
	async getEntry(
		serverName: string,
		config: MCPServerConfig,
		options?: { includeStale?: boolean },
	): Promise<MCPToolCacheEntry | null> {
		const key = cacheKey(serverName);
		const raw = this.storage.getCache(key);
		if (!raw) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("MCP tool cache parse failed", { serverName, error: String(error) });
			return null;
		}

		if (!isRecord(parsed)) return null;
		if (parsed.version !== CACHE_VERSION) return null;
		if (typeof parsed.configHash !== "string") return null;
		if (!Array.isArray(parsed.tools)) return null;
		if (parsed.requiresConnection !== undefined && typeof parsed.requiresConnection !== "boolean") return null;
		if (
			parsed.freshUntil !== undefined &&
			(typeof parsed.freshUntil !== "number" || !Number.isFinite(parsed.freshUntil))
		) {
			return null;
		}

		let currentHash: string;
		try {
			currentHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) return null;

		// Rows without freshness metadata (legacy v1) count as stale.
		const fresh = typeof parsed.freshUntil === "number" && parsed.freshUntil > this.clock();
		if (!fresh && !options?.includeStale) return null;

		return {
			tools: parsed.tools as MCPToolDefinition[],
			requiresConnection: parsed.requiresConnection ?? null,
		};
	}

	async set(
		serverName: string,
		config: MCPServerConfig,
		tools: MCPToolDefinition[],
		requiresConnection = false,
	): Promise<void> {
		let configHash: string;
		try {
			configHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return;
		}

		const nowMs = this.clock();

		const payload: MCPToolCachePayload = {
			version: CACHE_VERSION,
			configHash,
			tools,
			requiresConnection,
			freshUntil: nowMs + CACHE_FRESH_MS,
		};

		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (error) {
			logger.warn("MCP tool cache serialize failed", { serverName, error: String(error) });
			return;
		}

		const expiresAtSec = Math.floor((nowMs + CACHE_RETENTION_MS) / 1000);
		this.storage.setCache(cacheKey(serverName), serialized, expiresAtSec);
	}
}
