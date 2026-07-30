import { describe, expect, test } from "bun:test";
import { countTokens } from "@oh-my-pi/pi-agent-core";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { GlobTool, GrepTool, ReadTool } from "@oh-my-pi/pi-coding-agent/tools";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "inspect_image.enabled": false }),
		getSessionFile: () => undefined,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => undefined,
		allocateOutputArtifact: async () => undefined,
	} as ToolSession;
}

function requireModelIntent(tool: AgentTool): AgentTool {
	return {
		...tool,
		intent: "require",
		execute: tool.execute.bind(tool),
	};
}

function wireProperties(tool: { parameters: unknown }): Record<string, unknown> {
	const schema = tool.parameters as { properties?: Record<string, unknown> };
	return schema.properties ?? {};
}

function derivedIntent(tool: AgentTool, args: Record<string, unknown>): string {
	if (typeof tool.intent !== "function")
		throw new Error(`${tool.name} must derive intent from its existing arguments`);
	return tool.intent(args as never) ?? "";
}

function providerFootprint(tools: AgentTool[], sampleCalls: Array<Record<string, unknown>>): number {
	const normalized = normalizeTools(tools, true) ?? [];
	return (
		estimateToolSchemaTokens(normalized) +
		sampleCalls.reduce((total, call) => total + countTokens(JSON.stringify(call)), 0)
	);
}

describe("built-in tool intent token usage", () => {
	test("iteration 1 derives read/search intents without a provider-generated i field", () => {
		const tools: AgentTool[] = [
			new ReadTool(makeSession()),
			new GrepTool(makeSession()),
			new GlobTool(makeSession()),
		];
		const normalized = normalizeTools(tools, true) ?? [];

		for (const tool of normalized) {
			expect(wireProperties(tool)).not.toHaveProperty(INTENT_FIELD);
		}
		expect(derivedIntent(tools[0], { path: "src/example.ts:1-20" })).toBe("Reading src/example.ts:1-20");
		expect(derivedIntent(tools[1], { pattern: "TODO", path: "src" })).toBe("Searching src for TODO");
		expect(derivedIntent(tools[2], { path: "src/**/*.ts" })).toBe("Finding src/**/*.ts");

		const intents = [
			derivedIntent(tools[0], { path: "src/example.ts:1-20" }),
			derivedIntent(tools[1], { pattern: "TODO", path: "src" }),
			derivedIntent(tools[2], { path: "src/**/*.ts" }),
			derivedIntent(tools[0], { path: `src/${"nested directory ".repeat(20)}file.ts` }),
		];
		for (const intent of intents) {
			expect(intent.length).toBeLessThanOrEqual(72);
			expect(intent.trim().split(/\s+/).length).toBeLessThanOrEqual(6);
		}

		const baselineCalls = [
			{ i: "Reading source file", path: "src/example.ts:1-20" },
			{ i: "Searching source files", pattern: "TODO", path: "src" },
			{ i: "Finding TypeScript files", path: "src/**/*.ts" },
		];
		const optimizedCalls = baselineCalls.map(({ i: _intent, ...args }) => args);
		const baseline = providerFootprint(tools.map(requireModelIntent), baselineCalls);
		const optimized = providerFootprint(tools, optimizedCalls);

		expect(optimized).toBeLessThan(baseline);
	});
});
