import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

function makeTool(session: Partial<ToolSession> = {}): HubTool {
	return new HubTool(session as ToolSession);
}

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("fork Hub model surface", () => {
	test("exposes parent-side async and process control only", () => {
		const tool = makeTool();
		const expression = tool.parameters.expression;

		for (const op of ["send", "wait", "jobs", "cancel", "start", "ps", "logs", "stop", "restart", "describe"]) {
			expect(expression).toMatch(new RegExp(`\\b${op}\\b`));
		}
		for (const hiddenOp of ["list", "inbox"]) {
			expect(expression).not.toMatch(new RegExp(`\\b${hiddenOp}\\b`));
		}
		for (const hiddenField of ["to", "message", "replyTo", "await", "from", "peek"]) {
			expect(expression).not.toMatch(new RegExp(`\\b${hiddenField}\\??:`));
		}
	});

	test("descriptions, examples, and task guidance do not teach peer messaging", async () => {
		const tool = makeTool();
		const taskPrompt = await Bun.file(new URL("../../src/prompts/tools/task.md", import.meta.url)).text();
		const modelText = `${tool.summary}\n${tool.description}\n${taskPrompt}`;

		for (const forbidden of [
			"peer messaging",
			"hub send",
			"inbox",
			"replyTo",
			"Parent-to-subagent IRC",
			"coordinate directly over IRC",
		]) {
			expect(modelText).not.toContain(forbidden);
		}
		for (const example of tool.examples) {
			expect(example.call.op).not.toBe("list");
			expect(example.call.op).not.toBe("inbox");
			for (const field of ["to", "message", "replyTo", "await", "from", "peek"]) {
				expect(field in example.call).toBe(false);
			}
		}
	});

	test("keeps the upstream peer-messaging runtime implementation available internally", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null });
		registry.register({ id: "Worker", displayName: "worker", kind: "sub", parentId: "Main", session: null });
		const tool = makeTool({
			agentRegistry: registry,
			getAgentId: () => "Main",
			settings: { get: () => undefined } as ToolSession["settings"],
		});

		const result = await tool.execute("internal_list", { op: "list" });
		expect(result.isError).not.toBe(true);
		const text = result.content.find(item => item.type === "text")?.text ?? "";
		expect(text).toContain("Worker");
	});
});
