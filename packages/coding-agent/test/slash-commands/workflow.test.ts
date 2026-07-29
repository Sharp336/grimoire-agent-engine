import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSession } from "../../src/session/agent-session";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
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

function tuiRuntime(tool: unknown, output: string[], guest = false) {
	return {
		ctx: {
			session: { isStreaming: true, getToolByName: () => tool },
			sessionManager: { getCwd: () => "/tmp" },
			settings: {},
			showStatus: (text: string) => {
				output.push(text);
			},
			editor: { setText: () => {} },
			refreshSlashCommandState: () => {},
			...(guest ? { collabGuest: {} } : {}),
		} as unknown as InteractiveModeContext,
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

	it("cancels through the real TUI dispatcher while the session is streaming", async () => {
		const output: string[] = [];
		let calls = 0;
		const tool = {
			cancelActiveWorkflow: async () => {
				calls += 1;
				return snapshot("cancelled");
			},
		};

		expect(await executeBuiltinSlashCommand("/workflow cancel", tuiRuntime(tool, output))).toBe(true);
		expect(calls).toBe(1);
		expect(output).toEqual(["Workflow active-workflow: cancelled"]);
	});

	it("keeps active cancellation host-only and out of ACP", async () => {
		const output: string[] = [];
		let calls = 0;
		const tool = {
			cancelActiveWorkflow: async () => {
				calls += 1;
				return snapshot("cancelled");
			},
		};

		expect(await executeBuiltinSlashCommand("/workflow cancel", tuiRuntime(tool, output, true))).toBe(true);
		expect(calls).toBe(0);
		expect(output).toEqual(["/workflow is host-only during a collab session"]);
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "workflow")).toBe(false);
		expect(await executeAcpBuiltinSlashCommand("/workflow cancel", runtimeWithTool(tool, output))).toBe(false);
	});
});
