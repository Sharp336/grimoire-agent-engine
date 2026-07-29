import { describe, expect, it } from "bun:test";
import type { AgentSession } from "../../src/session/agent-session";
import { handleWorkflowCommand } from "../../src/slash-commands/helpers/workflow";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import type { WorkflowSnapshot } from "../../src/workflows";

function snapshot(status: WorkflowSnapshot["status"]): WorkflowSnapshot {
	return {
		version: 1,
		revision: 1,
		definition: {
			version: 1,
			id: "active-workflow",
			objective: "Cancel active work",
			failurePolicy: "block-descendants",
			nodes: [{ id: "task", agent: "task", task: "Wait" }],
		},
		status,
		nodes: { task: { status: "cancelled", attempts: 1 } },
		createdAt: 1,
		updatedAt: 2,
	};
}

function runtimeWithTool(tool: unknown, output: string[]): SlashCommandRuntime {
	return {
		session: { getToolByName: () => tool } as unknown as AgentSession,
		sessionManager: {} as SlashCommandRuntime["sessionManager"],
		settings: {} as SlashCommandRuntime["settings"],
		cwd: "/tmp",
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
}

describe("/workflow", () => {
	it("cancels through the registered live workflow control", async () => {
		const output: string[] = [];
		let calls = 0;
		const result = await handleWorkflowCommand(
			{ name: "workflow", args: "cancel", text: "workflow cancel" },
			runtimeWithTool(
				{
					cancelActiveWorkflow: async () => {
						calls += 1;
						return snapshot("cancelling");
					},
				},
				output,
			),
		);

		expect(result).toEqual({ consumed: true });
		expect(calls).toBe(1);
		expect(output).toEqual(["Workflow active-workflow: cancelling"]);
	});

	it("rejects unsupported operations without invoking the live control", async () => {
		const output: string[] = [];
		let calls = 0;
		await handleWorkflowCommand(
			{ name: "workflow", args: "status", text: "workflow status" },
			runtimeWithTool(
				{
					cancelActiveWorkflow: async () => {
						calls += 1;
						return snapshot("cancelled");
					},
				},
				output,
			),
		);

		expect(calls).toBe(0);
		expect(output).toEqual(["Usage: /workflow cancel"]);
	});
});
