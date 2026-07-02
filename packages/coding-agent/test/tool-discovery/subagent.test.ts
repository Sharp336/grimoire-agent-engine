import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	resolveEffectiveToolDiscoveryMode,
	TOOL_DISCOVERY_AUTO_THRESHOLD,
	type ToolDiscoveryContextEstimate,
} from "@oh-my-pi/pi-coding-agent/tool-discovery/mode";

// ─── Subagent discovery mode inheritance tests ────────────────────────────────
// These are unit-level tests that verify the settings resolution logic
// without needing to spin up a full AgentSession or subagent.
// ─────────────────────────────────────────────────────────────────────────────

describe("effective discovery mode resolution", () => {
	function resolveEffectiveMode(
		settings: Settings,
		toolCount = 0,
		contextEstimate?: ToolDiscoveryContextEstimate,
	): "off" | "mcp-only" | "all" {
		return resolveEffectiveToolDiscoveryMode(settings, toolCount, contextEstimate);
	}

	it("tools.discoveryMode=all beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "all", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("all");
	});

	it("tools.discoveryMode=mcp-only beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "mcp-only", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=true → mcp-only (back-compat alias)", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": true });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=false → off", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("off");
	});

	it("default auto settings stay off at the threshold", () => {
		const s = Settings.isolated({});
		expect(s.get("tools.discoveryMode")).toBe("auto");
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD)).toBe("off");
	});

	it("default auto settings enable mcp-only above the threshold", () => {
		const s = Settings.isolated({});
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD + 1)).toBe("mcp-only");
	});

	it("auto enables mcp-only when MCP schemas exceed the configured context share", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0.5 });
		expect(resolveEffectiveMode(s, 1, { mcpSchemaTokens: 501, contextWindow: 1000 })).toBe("mcp-only");
	});

	it("auto count trigger remains active when context share is disabled", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0 });
		expect(
			resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD + 1, { mcpSchemaTokens: 0, contextWindow: 1000 }),
		).toBe("mcp-only");
	});

	it("zero discoveryContextShare disables the context-share trigger", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0 });
		expect(resolveEffectiveMode(s, 1, { mcpSchemaTokens: 501, contextWindow: 1000 })).toBe("off");
	});

	it("explicit all and mcp-only beat the context-share trigger", () => {
		const contextEstimate = { mcpSchemaTokens: 501, contextWindow: 1000 };
		expect(resolveEffectiveMode(Settings.isolated({ "tools.discoveryMode": "all" }), 1, contextEstimate)).toBe("all");
		expect(resolveEffectiveMode(Settings.isolated({ "tools.discoveryMode": "mcp-only" }), 1, contextEstimate)).toBe(
			"mcp-only",
		);
	});

	it("does not trigger context-share flip if contextWindow is zero", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0.5 });
		expect(resolveEffectiveMode(s, 1, { mcpSchemaTokens: 501, contextWindow: 0 })).toBe("off");
	});
});
