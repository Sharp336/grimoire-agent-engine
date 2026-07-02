import type { Settings } from "../config/settings";
import type { SettingValue } from "../config/settings-schema";
import { estimateTokens } from "../commit/map-reduce/utils";

export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;
export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValue<"tools.discoveryMode">;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

export interface ToolDiscoveryContextEstimate {
	mcpSchemaTokens: number;
	contextWindow: number;
}

export function estimateMcpToolSchemaTokens(tools: Iterable<{ parameters?: unknown }>): number {
	let total = 0;
	for (const tool of tools) {
		try {
			total += estimateTokens(JSON.stringify(tool.parameters ?? {}) ?? "{}");
		} catch {
			total += estimateTokens("{}");
		}
	}
	return total;
}

export function countToolsForAutoDiscovery(toolNames: Iterable<string>): number {
	let count = 0;
	for (const name of toolNames) {
		if (name !== TOOL_DISCOVERY_SEARCH_TOOL_NAME) count++;
	}
	return count;
}

export function resolveEffectiveToolDiscoveryMode(
	settings: Settings,
	toolCount: number,
	contextEstimate?: ToolDiscoveryContextEstimate,
): EffectiveToolDiscoveryMode {
	const configuredMode = settings.get("tools.discoveryMode");
	if (configuredMode === "all" || configuredMode === "mcp-only") return configuredMode;
	if (settings.get("mcp.discoveryMode")) return "mcp-only";
	if (configuredMode === "auto") {
		if (toolCount > TOOL_DISCOVERY_AUTO_THRESHOLD) return "mcp-only";
		const discoveryContextShare = settings.get("tools.discoveryContextShare");
		if (
			discoveryContextShare > 0 &&
			contextEstimate !== undefined &&
			contextEstimate.contextWindow > 0 &&
			contextEstimate.mcpSchemaTokens > contextEstimate.contextWindow * discoveryContextShare
		) {
			return "mcp-only";
		}
	}
	return "off";
}
