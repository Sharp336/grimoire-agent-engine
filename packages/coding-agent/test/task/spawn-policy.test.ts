import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import * as taskDiscovery from "../../src/task/discovery";
import { TaskTool } from "../../src/task/index";
import type { AgentDefinition } from "../../src/task/types";
import { getTaskSchema } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const factFinderAgent = {
	name: "fact-finder",
	description: "Find facts.",
	systemPrompt: "Find facts.",
	source: "project",
} satisfies AgentDefinition;

const oracleAgent = {
	name: "oracle",
	description: "Answer hard questions.",
	systemPrompt: "Answer hard questions.",
	source: "bundled",
} satisfies AgentDefinition;

function makeSession(spawns: string): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.isolation.mode": "none",
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => spawns,
	};
}

describe("task spawn policy surfaces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the first allowed spawn as the schema default", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "fact-finder" });
		const parsed = schema({ task: "check" });

		expect(parsed).toEqual({ agent: "fact-finder", task: "check" });
	});

	it("filters the agent list to the restricted spawn policy in the description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent, oracleAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("fact-finder"));
		const description = tool.description;

		expect(description).toContain("### fact-finder");
		expect(description).not.toContain("### oracle");
	});
});

describe("resolveEffectiveSubagentPolicy primary-only rejection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("allows all/subagent agents at preflight", async () => {
		const allAgent = {
			name: "all-agent",
			description: "",
			systemPrompt: "",
			availability: "all" as const,
			source: "project" as const,
		} satisfies AgentDefinition;

		const subAgent = {
			name: "sub-agent",
			description: "",
			systemPrompt: "",
			availability: "subagent" as const,
			source: "project" as const,
		} satisfies AgentDefinition;

		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [allAgent, subAgent],
			projectAgentsDir: null,
		});

		const session = makeSession("*");

		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "do something",
				agent: "all-agent",
			}),
		).resolves.toBeDefined();

		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "do something",
				agent: "sub-agent",
			}),
		).resolves.toBeDefined();
	});

	it("rejects primary-only agent", async () => {
		const primaryOnlyAgent = {
			name: "primary-only",
			description: "",
			systemPrompt: "",
			availability: "primary" as const,
			source: "project" as const,
		} satisfies AgentDefinition;

		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [primaryOnlyAgent],
			projectAgentsDir: null,
		});

		const session = makeSession("*");

		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "do something",
				agent: "primary-only",
			}),
		).rejects.toThrow(StructuredSubagentError);

		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "do something",
				agent: "primary-only",
			}),
		).rejects.toThrow(/primary-only/);
	});
});
