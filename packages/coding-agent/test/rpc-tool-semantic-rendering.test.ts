import { describe, expect, test, vi } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { RegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { projectRpcToolSemantic } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-tool-semantic-rendering";

describe("RPC tool semantic rendering", () => {
	test("uses an extension semantic renderer without invoking its existing TUI renderer", () => {
		const tuiRenderer = vi.fn();
		const tool: RegisteredTool = {
			extensionPath: "/extensions/deploy.ts",
			definition: {
				name: "deploy",
				label: "Deploy",
				description: "Deploy a service",
				parameters: Type.Object({ target: Type.String() }),
				execute: async (): Promise<AgentToolResult<unknown>> => ({ content: [] }),
				renderCall: tuiRenderer,
				renderCallSemantic: args => {
					const target =
						typeof args === "object" && args !== null && "target" in args ? String(args.target) : "unknown";
					return {
						content: {
							version: 1,
							fallback: { format: "plain", text: `Deploy ${target}` },
							blocks: [{ kind: "fields", fields: [{ label: "Target", value: target }] }],
						},
					};
				},
			},
		};

		expect(
			projectRpcToolSemantic(
				{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "deploy", args: { target: "prod" } },
				[tool],
			),
		).toMatchObject({
			source: { kind: "tool", toolCallId: "tool-1", toolName: "deploy" },
			content: {
				fallback: { format: "plain", text: "Deploy prod" },
				blocks: [{ kind: "fields", fields: [{ label: "Target", value: "prod" }] }],
			},
		});
		expect(tuiRenderer).not.toHaveBeenCalled();
	});

	test("provides a stable host-neutral fallback when an extension has only TUI renderers", () => {
		const tool: RegisteredTool = {
			extensionPath: "/extensions/legacy.ts",
			definition: {
				name: "legacy",
				label: "Legacy",
				description: "Legacy renderer",
				parameters: Type.Object({ path: Type.String() }),
				execute: async (): Promise<AgentToolResult<unknown>> => ({ content: [] }),
				renderResult: vi.fn(),
			},
		};
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "done" }],
			details: { changed: true },
		};

		expect(
			projectRpcToolSemantic(
				{ type: "tool_execution_end", toolCallId: "tool-2", toolName: "legacy", result, isError: false },
				[tool],
			),
		).toEqual({
			source: { kind: "tool", toolCallId: "tool-2", toolName: "legacy" },
			content: {
				version: 1,
				fallback: { format: "plain", text: "Legacy completed" },
				blocks: [
					{
						kind: "tool",
						toolCallId: "tool-2",
						toolName: "legacy",
						state: "completed",
						result: { changed: true },
					},
				],
			},
		});
	});
});
