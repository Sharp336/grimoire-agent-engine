import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type } from "arktype";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields. The batch shape (`tasks[]` +
// shared `context`) is gated by the `task.batch` setting (default on, covered
// by test/task/task-batch.test.ts), and a per-call `schema` input no longer
// exists at all; follow-ups go through `irc` messaging.

describe("task schema (single-spawn)", () => {
	it("accepts {agent, task}", () => {
		const parsed = taskSchema({ agent: "explore", task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
	});

	it("defaults agent to `task` when omitted", () => {
		const parsed = taskSchema({ task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.agent).toBe("task");
		}
	});

	it("requires task", () => {
		const parsed = taskSchema({ agent: "explore" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("strips tasks/context/schema from the single-spawn schema", () => {
		const parsed = taskSchema({
			agent: "explore",
			task: "Map the auth module.",
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			// Unknown keys are stripped: batch/context exist only on the batch
			// schema and the per-call schema input was removed outright.
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.mode": "none", "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	async function executeText(params: unknown): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "explore" });
		expect(text).toContain("Missing `task`");
	});

	it("rejects an invalid inherited strict schema before dispatching a subagent", async () => {
		const session = createSession();
		Object.assign(session, { outputSchema: false, schemaMode: "strict" });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "Task agent",
					systemPrompt: "Do the task.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		const dispatch = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(session);

		const result = await tool.execute("tool-call", { task: "classify" });
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(text).toContain("Invalid strict output schema");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("returns cancellation before preparing an invalid inherited strict schema", async () => {
		const session = createSession();
		Object.assign(session, { outputSchema: false, schemaMode: "strict" });
		const discovery = vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "Task agent",
					systemPrompt: "Do the task.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		const dispatch = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(session);
		const discoveriesAtCreation = discovery.mock.calls.length;
		const controller = new AbortController();
		controller.abort();

		const result = await tool.execute("tool-call", { task: "classify" }, controller.signal);
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(text).toBe("Cancelled before start");
		expect(text).not.toContain("Invalid strict output schema");
		expect(discovery).toHaveBeenCalledTimes(discoveriesAtCreation);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
