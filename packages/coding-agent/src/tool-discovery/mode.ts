import { estimateTokens } from "../commit/map-reduce/utils";
import type { Settings } from "../config/settings";
import type { SettingValue } from "../config/settings-schema";

export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;
export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValue<"tools.discoveryMode">;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

export interface ToolDiscoveryContextEstimate {
	mcpSchemaTokens: number;
	contextWindow: number;
}

export function estimateMcpToolSchemaTokens(
	tools: Iterable<{ name?: string; description?: string; parameters?: unknown }>,
): number {
	let total = 0;
	for (const tool of tools) {
		// The provider receives each tool's full definition (name, description,
		// parameters) as part of the tool schema, so the cost estimate must cover
		// all three — not parameters alone. A few MCP tools with large
		// descriptions but tiny parameter objects would otherwise stay near zero
		// and evade the discoveryContextShare auto-hide threshold.
		const name = tool.name ?? "";
		const description = tool.description ?? "";
		let parametersJson: string;
		try {
			parametersJson = JSON.stringify(tool.parameters ?? {}) ?? "{}";
		} catch {
			parametersJson = "{}";
		}
		total += estimateTokens(`${name}${description}${parametersJson}`);
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
