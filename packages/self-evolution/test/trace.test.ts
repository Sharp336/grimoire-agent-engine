import { describe, expect, test } from "bun:test";
import { summarizeTrace, TraceRecorder } from "../src/trace";
import type { SessionTrace } from "../src/types";

describe("TraceRecorder", () => {
	test("accumulates tool calls and errors", () => {
		const recorder = new TraceRecorder();
		// Simulate agent start
		recorder.onAgentStart({ type: "agent_start" }, {
			cwd: "/test",
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		recorder.onInput("fix the bug");
		recorder.onToolExecutionStart({
			type: "tool_execution_start",
			toolCallId: "1",
			toolName: "read",
			args: { path: "x.ts" },
		} as any);
		recorder.onToolExecutionEnd({
			type: "tool_execution_end",
			toolCallId: "1",
			toolName: "read",
			result: {},
			isError: false,
		} as any);
		recorder.onToolExecutionStart({
			type: "tool_execution_start",
			toolCallId: "2",
			toolName: "edit",
			args: { path: "x.ts" },
		} as any);
		recorder.onToolExecutionEnd({
			type: "tool_execution_end",
			toolCallId: "2",
			toolName: "edit",
			result: {},
			isError: true,
		} as any);
		recorder.onToolExecutionStart({
			type: "tool_execution_start",
			toolCallId: "3",
			toolName: "edit",
			args: { path: "x.ts" },
		} as any);
		recorder.onToolExecutionEnd({
			type: "tool_execution_end",
			toolCallId: "3",
			toolName: "edit",
			result: {},
			isError: false,
		} as any);

		const trace = recorder.onAgentEnd({ type: "agent_end", messages: [] });
		expect(trace).toBeDefined();
		expect(trace!.toolCallCount).toBe(3);
		expect(trace!.errorCount).toBe(1);
		expect(trace!.hadRecovery).toBe(true);
		expect(trace!.completedSuccessfully).toBe(false);
	});

	test("summarizeTrace extracts tools and files", () => {
		const trace: SessionTrace = {
			sessionId: "s1",
			cwd: "/test",
			userPrompt: "add a React component",
			startTime: 0,
			endTime: 1000,
			entries: [
				{ type: "tool_call", timestamp: 0, toolName: "write", args: { path: "src/Button.tsx" } },
				{ type: "tool_call", timestamp: 0, toolName: "edit", args: { path: "src/App.tsx" } },
				{ type: "tool_result", timestamp: 0, toolName: "write", result: {}, isError: false },
			],
			toolCallCount: 2,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
		};
		const { summary, toolsUsed, filesModified } = summarizeTrace(trace);
		expect(toolsUsed).toContain("write");
		expect(toolsUsed).toContain("edit");
		expect(filesModified).toContain("src/Button.tsx");
		expect(filesModified).toContain("src/App.tsx");
		expect(summary).toContain("add a React component");
		expect(summary).toContain("completed successfully");
	});
});
