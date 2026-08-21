import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, type HubDetails, HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { CompactHubTool, createHubTool } from "@oh-my-pi/pi-coding-agent/tools/hub/compact";

function makeSession(
	overrides: Partial<Record<SettingPath, unknown>> = {},
	extra: Partial<ToolSession> = {},
): ToolSession {
	return {
		cwd: "/tmp/omp-hub-mode-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "tools.xdev": false, ...overrides }),
		...extra,
	};
}

function schemaExpression(tool: HubTool | CompactHubTool): string {
	return tool.parameters.expression;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function resultAgents(details: HubDetails | undefined): CoordinationDetails["agents"] | undefined {
	return details && "agents" in details ? details.agents : undefined;
}

describe("Hub modes", () => {
	test("defaults to compact and switches surfaces without rebuilding", () => {
		const settings = Settings.isolated();
		const session = makeSession({}, { settings });

		expect(SETTINGS_SCHEMA["hub.mode"].default).toBe("compact");
		expect(createHubTool(session)).toBeInstanceOf(CompactHubTool);
		settings.set("hub.mode", "full");
		expect(createHubTool(session)).toBeInstanceOf(HubTool);
	});

	test("compact exposes job and process control without peer messaging", () => {
		const tool = new CompactHubTool(makeSession());
		const expression = schemaExpression(tool);

		for (const visible of ["send", "wait", "jobs", "cancel", "start", "ps", "logs", "stop", "restart", "describe"]) {
			expect(expression).toMatch(new RegExp(`\\b${visible}\\b`));
		}
		for (const hidden of ["list", "inbox", "to", "message", "replyTo", "await", "from", "peek"]) {
			expect(expression).not.toMatch(new RegExp(`\\b${hidden}\\b`));
		}
		expect(`${tool.summary}\n${tool.description}`).not.toMatch(/peer|IRC|inbox|Agent-to-Agent/i);
		for (const example of tool.examples) {
			if (!("call" in example)) continue;
			expect("to" in example.call).toBe(false);
			expect("name" in example.call || example.call.op !== "send").toBe(true);
		}
	});

	test("full restores the official messaging schema, prompt, and examples", () => {
		const tool = new HubTool(makeSession({ "hub.mode": "full" }));
		const expression = schemaExpression(tool);

		for (const visible of ["list", "inbox", "to", "message", "replyTo", "await", "from", "peek"]) {
			expect(expression).toMatch(new RegExp(`\\b${visible}\\b`));
		}
		expect(`${tool.summary}\n${tool.description}`).toContain("peer messaging");
		expect(tool.examples.some(example => "call" in example && example.call.op === "list")).toBe(true);
		expect(tool.examples.some(example => "call" in example && "to" in example.call)).toBe(true);
	});

	test("compact and full preserve the same process error mapping", async () => {
		const compact = new CompactHubTool(makeSession({ "launch.enabled": false }));
		const full = new HubTool(makeSession({ "hub.mode": "full", "launch.enabled": false }));
		const params = { op: "start" as const, name: "web", application: "bun", args: ["run", "dev"] };

		const compactResult = await compact.execute("compact_start", params);
		const fullResult = await full.execute("full_start", params);

		expect(compactResult).toEqual(fullResult);
		expect(compactResult.isError).toBe(true);
	});

	test("compact execution excludes peer messages and jobless-agent rosters", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: null });
		const tool = new CompactHubTool(
			makeSession({}, { asyncJobManager: manager, agentRegistry: registry, getAgentId: () => "Main" }),
		);

		try {
			const jobs = await tool.execute("compact_jobs", { op: "jobs" });
			expect(resultAgents(jobs.details)).toBeUndefined();
			expect(resultText(jobs)).toBe("No background jobs.");

			const wait = await tool.execute("compact_wait", { op: "wait" });
			expect(resultAgents(wait.details)).toBeUndefined();
			expect(resultText(wait)).toBe("No running background jobs to wait for.");
			const missing = await tool.execute("compact_missing", { op: "wait", ids: ["Worker"] });
			expect(resultText(missing)).not.toMatch(/running agent|history:\/\//i);

			const send = await tool.execute("compact_send", { op: "send" });
			expect(send.isError).toBe(true);
			expect(resultText(send)).toContain("`name` is required");
			expect(resultText(send)).not.toMatch(/peer|`to`|`message`/i);
		} finally {
			await manager.dispose({ timeoutMs: 200 });
		}
	});

	test("compact registration depends on jobs or process supervision, not IRC", async () => {
		const enabled = await createTools(
			makeSession({ "hub.mode": "compact", "async.enabled": true, "launch.enabled": false }, { enableIrc: false }),
		);
		const disabled = await createTools(
			makeSession({ "hub.mode": "compact", "async.enabled": false, "launch.enabled": false }, { enableIrc: false }),
		);

		expect(enabled.find(tool => tool.name === "hub")).toBeInstanceOf(CompactHubTool);
		expect(disabled.some(tool => tool.name === "hub")).toBe(false);
	});

	test("task guidance reveals peer coordination only in full mode", async () => {
		const compact = await TaskTool.create(makeSession({ "hub.mode": "compact" }));
		const full = await TaskTool.create(makeSession({ "hub.mode": "full" }));

		expect(compact.description).not.toMatch(/IRC|hub send/);
		expect(compact.description).toContain("Put all required context");
		expect(full.description).toMatch(/IRC|hub send/);
		expect(full.description).not.toContain("Put all required context");
	});
});
