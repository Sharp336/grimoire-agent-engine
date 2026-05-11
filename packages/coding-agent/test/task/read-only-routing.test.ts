import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import taskDescriptionTemplate from "../../src/prompts/tools/task.md" with { type: "text" };
import {
	applyUserReadSafeTools,
	buildReadSafeToolSet,
	getUserReadSafeTools,
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

describe("getUserReadSafeTools", () => {
	it("returns string arrays as-is and filters non-string entries", () => {
		expect(getUserReadSafeTools(["my_tool", "other"])).toEqual(["my_tool", "other"]);
		expect(getUserReadSafeTools(["read", 42, null, "ok"])).toEqual(["read", "ok"]);
		expect(getUserReadSafeTools([])).toEqual([]);
	});

	it.each([
		["string scalar", "my_tool"],
		["null", null],
		["object", { my_tool: true }],
	])("returns [] for non-array config: %s", (_label, value) => {
		expect(getUserReadSafeTools(value)).toEqual([]);
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
