import { isRecord } from "@oh-my-pi/pi-utils";
import { isMCPTimeoutEnabled } from "./timeout";
import type { MCPDiscoverResult, MCPProtocolMode, MCPTransport } from "./types";
import { MCPError, MCPHttpError } from "./types";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-03-26";

const DISCOVERY_TIMEOUT_MS = 500;
const MODERN_ERROR_CODES: Record<number, true> = { [-32020]: true, [-32021]: true, [-32022]: true };
const LEGACY_HTTP_FALLBACK_STATUSES: Record<number, true> = { 400: true, 404: true, 405: true };
const KNOWN_LEGACY_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

export type MCPProtocolNegotiationResult = { kind: "legacy" } | { kind: "modern"; discovery: MCPDiscoverResult };

interface MCPProtocolNegotiationOptions {
	name: string;
	mode: MCPProtocolMode;
	transportType: "stdio" | "http" | "sse";
	timeoutMs: number;
	signal?: AbortSignal;
	modernParams: Record<string, unknown>;
}

function isValidDiscovery(value: unknown): value is MCPDiscoverResult {
	return (
		isRecord(value) &&
		value.resultType === "complete" &&
		Array.isArray(value.supportedVersions) &&
		value.supportedVersions.every(version => typeof version === "string") &&
		isRecord(value.capabilities)
	);
}

function isLegacyHttpEvidence(error: unknown): boolean {
	const status = error instanceof MCPHttpError || error instanceof MCPError ? error.status : undefined;
	if (status === undefined || LEGACY_HTTP_FALLBACK_STATUSES[status] !== true) return false;
	if (error instanceof MCPHttpError) return true;
	return error instanceof MCPError && !MODERN_ERROR_CODES[error.code] && error.code !== -32601;
}

function canFallBackFromDiscovery(error: unknown, transportType: "stdio" | "http" | "sse"): boolean {
	if (error instanceof MCPError && MODERN_ERROR_CODES[error.code]) return false;
	if (transportType === "http") return isLegacyHttpEvidence(error);
	if (transportType === "stdio") return true;
	return false;
}

export async function negotiateMCPProtocol(
	transport: MCPTransport,
	options: MCPProtocolNegotiationOptions,
): Promise<MCPProtocolNegotiationResult> {
	if (options.mode === "legacy" || (options.mode === "auto" && options.transportType === "sse")) {
		return { kind: "legacy" };
	}
	if (options.transportType === "sse") {
		throw new Error(`MCP server "${options.name}" cannot use protocol ${MODERN_PROTOCOL_VERSION} over legacy SSE`);
	}

	const discoveryTimeout = isMCPTimeoutEnabled(options.timeoutMs)
		? Math.min(options.timeoutMs, DISCOVERY_TIMEOUT_MS)
		: DISCOVERY_TIMEOUT_MS;
	let discovery: MCPDiscoverResult;
	try {
		discovery = await transport.request<MCPDiscoverResult>("server/discover", options.modernParams, {
			signal: options.signal,
			timeout: discoveryTimeout,
		});
	} catch (error) {
		if (
			options.signal?.aborted ||
			options.mode === "2026-07-28" ||
			!canFallBackFromDiscovery(error, options.transportType)
		) {
			throw error;
		}
		return { kind: "legacy" };
	}

	if (!isValidDiscovery(discovery)) {
		if (options.mode === "auto" && options.transportType === "stdio") return { kind: "legacy" };
		throw new Error(`MCP server "${options.name}" returned an invalid server/discover result`);
	}
	if (discovery.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) {
		return { kind: "modern", discovery };
	}
	if (
		options.mode === "auto" &&
		discovery.supportedVersions.length > 0 &&
		discovery.supportedVersions.every(version => KNOWN_LEGACY_PROTOCOL_VERSIONS.has(version))
	) {
		return { kind: "legacy" };
	}
	throw new Error(
		`MCP server "${options.name}" does not support protocol ${MODERN_PROTOCOL_VERSION} (${discovery.supportedVersions.join(", ") || "no versions advertised"})`,
	);
}
