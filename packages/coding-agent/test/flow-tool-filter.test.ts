import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { applyToolFilter } from "../src/flow/flow-tool-filter";

function tool(name: string): AgentTool<any> {
	return {
		name,
		label: name,
		description: "",
		parameters: Type.Object({}),
		strict: true,
		async execute() {
			return { content: [] };
		},
	};
}

const parent = [tool("bash"), tool("grep"), tool("read_file"), tool("mcp_gitea_list"), tool("mcp_gitea_read")];

describe("applyToolFilter", () => {
	test("undefined filter passes through parent scope", () => {
		const out = applyToolFilter(parent, undefined);
		expect(out.map(t => t.name)).toEqual(parent.map(t => t.name));
	});

	test("empty array passes through parent scope (inherit)", () => {
		const out = applyToolFilter(parent, []);
		expect(out.length).toBe(parent.length);
	});

	test("allow-only keeps only listed tools", () => {
		const out = applyToolFilter(parent, ["bash", "grep"]);
		expect(out.map(t => t.name).sort()).toEqual(["bash", "grep"]);
	});

	test("deny-only removes listed tools from parent", () => {
		const out = applyToolFilter(parent, ["!bash"]);
		expect(out.map(t => t.name)).not.toContain("bash");
		expect(out.length).toBe(parent.length - 1);
	});

	test("glob allow matches multiple tools", () => {
		const out = applyToolFilter(parent, ["mcp_gitea_*"]);
		expect(out.map(t => t.name).sort()).toEqual(["mcp_gitea_list", "mcp_gitea_read"]);
	});

	test("mixed order: allow then deny", () => {
		const out = applyToolFilter(parent, ["mcp_gitea_*", "!mcp_gitea_read"]);
		expect(out.map(t => t.name)).toEqual(["mcp_gitea_list"]);
	});

	test("unknown names in allow list are silently ignored", () => {
		const out = applyToolFilter(parent, ["bash", "does_not_exist"]);
		expect(out.map(t => t.name)).toEqual(["bash"]);
	});

	test("glob deny over deny-only start set", () => {
		const out = applyToolFilter(parent, ["!mcp_*"]);
		expect(out.map(t => t.name).sort()).toEqual(["bash", "grep", "read_file"]);
	});
});
