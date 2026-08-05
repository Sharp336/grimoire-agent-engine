import { describe, expect, it } from "bun:test";
import { createAdvisorAgent } from "../../src/session/session-advisors";
import type { AgentDefinition } from "../../src/task/types";

describe("createAdvisorAgent", () => {
	it("wraps a definition in the advisor role: strips spawning tools, clears driving-agent concerns, preserves identity", () => {
		const definition: AgentDefinition = {
			name: "security-reviewer",
			description: "Reviews each primary turn for safety and correctness.",
			systemPrompt: "Watch module boundaries.",
			tools: ["read", "grep", "write", "task", "hub", "yield"],
			spawns: "*",
			prewalk: true,
			output: { type: "object", properties: {} },
			model: ["anthropic/claude-sonnet-4-5:high"],
			advisors: ["other"],
			source: "user" as const,
		};

		const advisor = createAdvisorAgent(definition);

		// The recursion cut: an advisor can never grow subagents — and therefore
		// advisors — of its own.
		expect(advisor.tools).toEqual(["read", "grep", "write"]);
		expect(advisor.spawns).toBeUndefined();
		expect(advisor.prewalk).toBeUndefined();
		expect(advisor.output).toBeUndefined();
		// Identity and expertise survive untouched.
		expect(advisor.name).toBe("security-reviewer");
		expect(advisor.description).toBe("Reviews each primary turn for safety and correctness.");
		expect(advisor.systemPrompt).toBe("Watch module boundaries.");
		expect(advisor.model).toEqual(["anthropic/claude-sonnet-4-5:high"]);
		expect(advisor.source).toBe("user");
		expect(advisor.advisors).toEqual(["other"]);
	});

	it("leaves a definition with no tools and no driving-agent fields unchanged", () => {
		const definition: AgentDefinition = {
			name: "observer",
			description: "Observes only.",
			systemPrompt: "",
			source: "user" as const,
		};

		expect(createAdvisorAgent(definition)).toEqual(definition);
	});
});
