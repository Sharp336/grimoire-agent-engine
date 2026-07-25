import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

export const MCP_CONNECTION_STATUS_EVENT_CHANNEL = "mcp:connection-status";

export type McpConnectionStatusEvent =
	| { type: "connecting"; serverNames: string[] }
	| { type: "connected"; serverName: string }
	| { type: "failed"; serverName: string; error: string }
	| { type: "reconnecting"; serverName: string }
	| { type: "reconnected"; serverName: string }
	| { type: "reconnect-failed"; serverName: string; error: string }
	| { type: "reconnect-suspended"; serverName: string; crashes: number };

/** Reconnect-phase subset of {@link McpConnectionStatusEvent}. */
export type McpReconnectStatusEvent = Extract<McpConnectionStatusEvent, { type: `reconnect${string}` }>;

export type McpConnectionStatusSnapshot = {
	pendingServers: readonly string[];
	connectedServers: readonly string[];
	failedServers: readonly { serverName: string; error: string }[];
};

function sanitizeMcpStatusText(value: string, maxWidth: number): string {
	const text = shortenEmbeddedPaths(
		replaceTabs(sanitizeText(value))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(text.length > 0 ? text : "(unnamed)", maxWidth);
}

function sanitizeMcpServerName(serverName: string): string {
	return sanitizeMcpStatusText(serverName, TRUNCATE_LENGTHS.SHORT);
}

function formatServerList(serverNames: readonly string[]): string {
	return serverNames.map(sanitizeMcpServerName).join(", ");
}

function formatServerCount(count: number): string {
	return count === 1 ? "server" : "servers";
}
function sanitizeMcpStatusError(error: string): string {
	return sanitizeMcpStatusText(error, TRUNCATE_LENGTHS.CONTENT);
}

function shortenEmbeddedPaths(text: string): string {
	return text
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			return `${leading}${shortenPath(segment.slice(leading.length, end))}${trailing}`;
		})
		.join(" ");
}

export function formatMCPConnectingMessage(serverNames: readonly string[]): string {
	return `Connecting to MCP servers: ${formatServerList(serverNames)}…`;
}

function formatFailedServer({ serverName, error }: { serverName: string; error: string }): string {
	return `${sanitizeMcpServerName(serverName)}: ${sanitizeMcpStatusError(error)}`;
}

export function formatMCPConnectionStatusMessage(snapshot: McpConnectionStatusSnapshot): string {
	const { pendingServers, connectedServers, failedServers } = snapshot;
	if (pendingServers.length > 0) {
		if (connectedServers.length === 0 && failedServers.length === 0) {
			return formatMCPConnectingMessage(pendingServers);
		}
		const parts: string[] = [];
		if (connectedServers.length > 0) {
			parts.push(`Connected: ${formatServerList(connectedServers)}.`);
		}
		if (failedServers.length > 0) {
			parts.push(`Failed: ${failedServers.map(formatFailedServer).join("; ")}.`);
		}
		parts.push(`Still connecting: ${formatServerList(pendingServers)}…`);
		return parts.join(" ");
	}
	if (failedServers.length > 0) {
		const failureText = failedServers.map(formatFailedServer).join("; ");
		if (connectedServers.length === 0) {
			return `MCP ${formatServerCount(failedServers.length)} failed to connect: ${failureText}`;
		}
		return `MCP finished with failures. Connected: ${formatServerList(connectedServers)}. Failed: ${failureText}`;
	}
	if (connectedServers.length > 0) {
		return `Connected to MCP ${formatServerCount(connectedServers.length)}: ${formatServerList(connectedServers)}.`;
	}
	return "";
}

export function formatMCPReconnectNotice(event: McpReconnectStatusEvent): string {
	const name = sanitizeMcpServerName(event.serverName);
	// Keep exact, ordinary names actionable. Control characters cannot be
	// represented safely in a one-line slash command, so those notices direct
	// the user to the interactive MCP menu instead.
	const hasUnsafeCommandChars = /[\r\n\t]/.test(event.serverName);
	const recovery = hasUnsafeCommandChars
		? "Use /mcp to retry manually."
		: `Run /mcp reconnect ${sanitizeText(event.serverName)} to retry.`;
	switch (event.type) {
		case "reconnecting":
			return `MCP server "${name}" lost its connection — reconnecting…`;
		case "reconnected":
			return `MCP server "${name}" reconnected.`;
		case "reconnect-failed":
			return `MCP server "${name}" could not reconnect: ${sanitizeMcpStatusError(event.error)} ${recovery}`;
		case "reconnect-suspended":
			return `MCP server "${name}" crashed ${event.crashes} times in quick succession — automatic reconnects suspended. Fix the server, then ${recovery.charAt(0).toLowerCase()}${recovery.slice(1)}`;
	}
}

function isRecord(data: unknown): data is Record<string, unknown> {
	return typeof data === "object" && data !== null;
}

function isStringArray(data: unknown): data is string[] {
	return Array.isArray(data) && data.every(item => typeof item === "string");
}

/**
 * Runtime validator for the cross-module event payload. The event bus is
 * untyped at runtime, so the subscriber verifies the shape before formatting
 * rather than trusting a cast — a malformed emit is ignored instead of throwing.
 */
export function isMcpConnectionStatusEvent(data: unknown): data is McpConnectionStatusEvent {
	if (!isRecord(data) || typeof data.type !== "string") return false;
	switch (data.type) {
		case "connecting":
			return isStringArray(data.serverNames);
		case "connected":
			return typeof data.serverName === "string";
		case "failed":
			return typeof data.serverName === "string" && typeof data.error === "string";
		case "reconnecting":
		case "reconnected":
			return typeof data.serverName === "string";
		case "reconnect-failed":
			return typeof data.serverName === "string" && typeof data.error === "string";
		case "reconnect-suspended":
			return typeof data.serverName === "string" && typeof data.crashes === "number";
		default:
			return false;
	}
}
