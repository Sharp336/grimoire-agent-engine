import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import taskDescriptionTemplate from "../../src/prompts/tools/task.md" with { type: "text" };
import {
	applyUserReadSafeTools,
	assignmentRequiresWrite,
	buildReadSafeToolSet,
	isAgentReadOnly,
	loadBundledAgents,
} from "../../src/task/agents";
import { buildSubagentSystemPrompt } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";

function renderTaskDescription(agents: AgentDefinition[]): string {
	return prompt.render(taskDescriptionTemplate, {
		agents,
		MAX_CONCURRENCY: 5,
		isolationEnabled: true,
		asyncEnabled: false,
		contextEnabled: true,
		customSchemaEnabled: true,
		defaultMode: true,
	});
}

describe("isAgentReadOnly", () => {
	it("uses the explicit frontmatter value when provided", () => {
		expect(isAgentReadOnly({ readOnly: true, tools: ["edit", "write"] })).toBe(true);
		expect(isAgentReadOnly({ readOnly: false, tools: ["read"] })).toBe(false);
	});

	it("infers read-only when every tool is in the allowlist", () => {
		expect(isAgentReadOnly({ tools: ["read", "search", "find", "web_search"] })).toBe(true);
		expect(isAgentReadOnly({ tools: ["read", "yield", "report_finding"] })).toBe(true);
	});

	it("treats write or stateful tools as write-capable", () => {
		expect(isAgentReadOnly({ tools: ["read", "bash"] })).toBe(false);
		// `ask` blocks on user; `exit_plan_mode` persists state — both break fire-and-forget dispatch.
		expect(isAgentReadOnly({ tools: ["read", "ask"] })).toBe(false);
		expect(isAgentReadOnly({ tools: ["read", "exit_plan_mode"] })).toBe(false);
	});

	it("treats unknown tools as write-capable (deny-by-default)", () => {
		expect(isAgentReadOnly({ tools: ["read", "my_custom_tool"] })).toBe(false);
	});

	it("treats agents with no tools restriction as write-capable", () => {
		expect(isAgentReadOnly({})).toBe(false);
		expect(isAgentReadOnly({ tools: [] })).toBe(false);
	});
});

describe("user readSafeTools config", () => {
	it("extends inference to user-vouched tools", () => {
		expect(isAgentReadOnly({ tools: ["read", "my_mcp_doc_lookup"] }, ["my_mcp_doc_lookup"])).toBe(true);
		expect(isAgentReadOnly({ tools: ["read", "untrusted"] }, ["my_mcp_doc_lookup"])).toBe(false);
	});

	it("explicit readOnly still wins over inference", () => {
		expect(isAgentReadOnly({ readOnly: false, tools: ["read", "my_mcp_doc_lookup"] }, ["my_mcp_doc_lookup"])).toBe(
			false,
		);
	});

	it("returns the same set reference when no user list is supplied", () => {
		const base = buildReadSafeToolSet();
		expect(buildReadSafeToolSet([])).toBe(base);
		expect(base.has("read")).toBe(true);
		expect(base.has("my_mcp_doc_lookup")).toBe(false);
	});
});

describe("applyUserReadSafeTools", () => {
	const baseAgent = (overrides: Partial<AgentDefinition>): AgentDefinition => ({
		name: "test",
		description: "",
		systemPrompt: "",
		readOnly: false,
		source: "user",
		...overrides,
	});

	it("is a no-op when the user list is empty", () => {
		const input = [baseAgent({ tools: ["read", "search"] })];
		expect(applyUserReadSafeTools(input, [])).toBe(input);
	});

	it("re-derives readOnly for agents without explicit frontmatter", () => {
		const out = applyUserReadSafeTools(
			[baseAgent({ tools: ["read", "my_mcp_doc_lookup"], explicitReadOnly: undefined })],
			["my_mcp_doc_lookup"],
		);
		expect(out[0].readOnly).toBe(true);
	});

	it("respects explicit readOnly: false even when tools are all user-vouched", () => {
		const out = applyUserReadSafeTools(
			[baseAgent({ tools: ["read", "my_mcp_doc_lookup"], readOnly: false, explicitReadOnly: false })],
			["my_mcp_doc_lookup"],
		);
		expect(out[0].readOnly).toBe(false);
	});

	it("appends user-vouched tools to bundled agents' lists, deduped", () => {
		const out = applyUserReadSafeTools(
			[baseAgent({ tools: ["read", "search", "my_mcp_doc_lookup"], source: "bundled" })],
			["my_mcp_doc_lookup", "company_search"],
		);
		expect(out[0].tools).toEqual(["read", "search", "my_mcp_doc_lookup", "company_search"]);
	});

	it("does not augment user-defined agents (author owns their tools list)", () => {
		const out = applyUserReadSafeTools(
			[baseAgent({ tools: ["read", "search"], source: "user" })],
			["my_mcp_doc_lookup"],
		);
		expect(out[0].tools).toEqual(["read", "search"]);
	});

	it("does not augment bundled agents with no constrained tools list", () => {
		const out = applyUserReadSafeTools([baseAgent({ tools: undefined, source: "bundled" })], ["my_mcp_doc_lookup"]);
		expect(out[0].tools).toBeUndefined();
	});
});

describe("bundled agents and task tool description", () => {
	const bundled = loadBundledAgents();
	const description = renderTaskDescription(bundled);

	it("tags the four read-only bundled agents in the rendered description", () => {
		expect(description).toMatch(/^# explore \[read-only\]$/m);
		expect(description).toMatch(/^# plan \[read-only\]$/m);
		expect(description).toMatch(/^# reviewer \[read-only\]$/m);
		expect(description).toMatch(/^# librarian \[read-only\]$/m);
	});

	it("does not tag write-capable bundled agents", () => {
		expect(description).toMatch(/^# task$/m);
		expect(description).toMatch(/^# quick_task$/m);
		expect(description).toMatch(/^# designer$/m);
	});

	it("carries a routing rule that references the [read-only] tag", () => {
		expect(description).toMatch(/`\[read-only\]`/);
		expect(description).toMatch(/write-capable agent/);
	});
});

describe("buildSubagentSystemPrompt", () => {
	const baseInputs = (agent: Pick<AgentDefinition, "systemPrompt" | "readOnly">) => ({
		agent: { name: "t", description: "", source: "user" as const, ...agent },
		context: undefined,
		worktree: "",
		outputSchema: undefined,
		contextFile: undefined,
		ircPeers: "",
		ircSelfId: "",
	});

	it("emits [CAPABILITY] ahead of [ROLE] when readOnly is true", () => {
		const rendered = buildSubagentSystemPrompt(baseInputs({ systemPrompt: "[body]", readOnly: true }));
		expect(rendered).toContain("[CAPABILITY]");
		expect(rendered.indexOf("[CAPABILITY]")).toBeLessThan(rendered.indexOf("[ROLE]"));
		expect(rendered).toMatch(/yield/);
	});

	it("omits [CAPABILITY] when readOnly is false or undefined", () => {
		const rfalse = buildSubagentSystemPrompt(baseInputs({ systemPrompt: "[body]", readOnly: false }));
		const rundef = buildSubagentSystemPrompt(baseInputs({ systemPrompt: "[body]", readOnly: undefined }));
		expect(rfalse).not.toContain("[CAPABILITY]");
		expect(rundef).not.toContain("[CAPABILITY]");
		// Pre-feature byte-identical: no leading blank line.
		expect(rfalse.startsWith("[ROLE]")).toBe(true);
	});
});

describe("assignmentRequiresWrite", () => {
	it("flags assignments that start with a high-signal write verb", () => {
		expect(assignmentRequiresWrite("Refactor agents.ts to use a class")).toBe(true);
		expect(assignmentRequiresWrite("Implement the feature in foo.ts")).toBe(true);
		expect(assignmentRequiresWrite("Edit foo.ts to handle the new flag")).toBe(true);
		expect(assignmentRequiresWrite("Modify the parser to accept trailing commas")).toBe(true);
		expect(assignmentRequiresWrite("Fix the parser bug in tokenizer.ts")).toBe(true);
		expect(assignmentRequiresWrite("Rename foo to bar across the codebase")).toBe(true);
		expect(assignmentRequiresWrite("Scaffold a new module at src/foo.ts")).toBe(true);
		expect(assignmentRequiresWrite("Migrate the data model to the new schema")).toBe(true);
		expect(assignmentRequiresWrite("Install the missing dependency")).toBe(true);
	});

	it("does not flag assignments that start with an investigation verb", () => {
		expect(assignmentRequiresWrite("Investigate how the parser handles edge cases")).toBe(false);
		expect(assignmentRequiresWrite("Find all call sites of doStuff")).toBe(false);
		expect(assignmentRequiresWrite("Locate the config loader")).toBe(false);
		expect(assignmentRequiresWrite("Summarize the architecture of the task module")).toBe(false);
		expect(assignmentRequiresWrite("Trace the lifecycle of a subagent dispatch")).toBe(false);
		expect(assignmentRequiresWrite("Review the changes in this PR")).toBe(false);
	});

	it("does not flag descriptive verbs commonly used in investigation prose", () => {
		// These verbs are ambiguous: they often describe code behavior or summarization tasks
		// rather than imperative file mutation. They are deliberately excluded from WRITE_INTENT_VERBS.
		expect(assignmentRequiresWrite("Investigate how class Foo generates JSON")).toBe(false);
		expect(assignmentRequiresWrite("Create a summary of the dispatch flow")).toBe(false);
		expect(assignmentRequiresWrite("Write up the findings as structured notes")).toBe(false);
		expect(assignmentRequiresWrite("Add notes about the parser's error handling")).toBe(false);
		expect(assignmentRequiresWrite("Build a picture of how the task graph executes")).toBe(false);
		expect(assignmentRequiresWrite("Update your understanding of the lifecycle")).toBe(false);
		expect(assignmentRequiresWrite("Generate a list of all hot paths")).toBe(false);
		expect(assignmentRequiresWrite("Remove the option from consideration in your report")).toBe(false);
	});

	it("strips markdown list and heading markers before matching", () => {
		expect(assignmentRequiresWrite("# Goal\nRefactor X")).toBe(true);
		expect(assignmentRequiresWrite("- Refactor X")).toBe(true);
		expect(assignmentRequiresWrite("* Implement Y")).toBe(true);
		expect(assignmentRequiresWrite("1. Implement Y")).toBe(true);
		expect(assignmentRequiresWrite("1) Modify Z")).toBe(true);
		expect(assignmentRequiresWrite("> Edit foo.ts")).toBe(true);
	});

	it("strips a single 'Label:' prefix so structured assignments still surface the verb", () => {
		expect(assignmentRequiresWrite("Goal: Refactor agents.ts")).toBe(true);
		expect(assignmentRequiresWrite("Target: Investigate the parser")).toBe(false);
	});

	it("scans every line, not only the first", () => {
		const assignment = "# Target\n- foo.ts\n\n# Change\nRefactor the module";
		expect(assignmentRequiresWrite(assignment)).toBe(true);
	});

	it("ignores write verbs that appear inside a sentence (non-imperative position)", () => {
		// "the" / "we" is the first word, so the inner write verb is not in imperative position
		expect(assignmentRequiresWrite("Understand the refactor pattern used here")).toBe(false);
		expect(assignmentRequiresWrite("Note: we will refactor this later")).toBe(false);
	});

	it("returns false for empty or whitespace-only assignments", () => {
		expect(assignmentRequiresWrite("")).toBe(false);
		expect(assignmentRequiresWrite("   \n\t  \n")).toBe(false);
	});

	it("is case-insensitive on the verb", () => {
		expect(assignmentRequiresWrite("REFACTOR agents.ts")).toBe(true);
		expect(assignmentRequiresWrite("refactor agents.ts")).toBe(true);
		expect(assignmentRequiresWrite("Refactor agents.ts")).toBe(true);
	});
});
