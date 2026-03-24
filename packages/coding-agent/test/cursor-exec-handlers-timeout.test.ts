import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { CursorExecHandlers } from "../src/cursor";
import { ToolTimeoutError } from "../src/tools/tool-errors";

describe("CursorExecHandlers timeout propagation", () => {
	it("maps shell timeout args and preserves timeout metadata on tool errors", async () => {
		const bashSchema = Type.Object({
			command: Type.String(),
			cwd: Type.Optional(Type.String()),
			timeout: Type.Optional(Type.Number()),
		});
		const calls: Array<{ command: string; cwd?: string; timeout?: number }> = [];
		const bashTool: AgentTool<typeof bashSchema, { command: string; cwd?: string; timeout?: number }> = {
			name: "bash",
			label: "Bash",
			description: "Shell tool",
			parameters: bashSchema,
			async execute(_toolCallId, params) {
				calls.push(params);
				throw new ToolTimeoutError("bash timed out after 7 seconds", {
					toolName: "bash",
					durationSeconds: 7,
					durationMs: 7000,
				});
			},
		};

		const bridge = new CursorExecHandlers({
			cwd: "/repo",
			tools: new Map([["bash", bashTool]]) as unknown as Map<string, AgentTool>,
		});

		const result = await bridge.shell({
			toolCallId: "tool-call-1",
			command: "sleep 10",
			workingDirectory: "/tmp/work",
			timeout: 7,
		} as Parameters<CursorExecHandlers["shell"]>[0]);

		expect(calls).toEqual([{ command: "sleep 10", cwd: "/tmp/work", timeout: 7 }]);
		expect(result.role).toBe("toolResult");
		expect(result.toolCallId).toBe("tool-call-1");
		expect(result.toolName).toBe("bash");
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "bash timed out after 7 seconds" });
		expect(result.details).toEqual({
			error: "bash timed out after 7 seconds",
			errorType: "timeout",
			timeout: {
				toolName: "bash",
				durationSeconds: 7,
				durationMs: 7000,
			},
		});
	});
});
