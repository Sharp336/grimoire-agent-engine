import { describe, expect, test } from "bun:test";
import { matchTriggers, pathGlobToRegex, simpleNameGlob } from "../src/flow/flow-trigger-matcher";
import type { Flow } from "../src/flow/flow-types";

function makeFlow(triggers: Flow["triggers"]): Flow {
	return {
		version: 1,
		id: "check_backend",
		nodes: { check_backend: { description: "run typecheck" } },
		edges: [],
		triggers,
	};
}

describe("simpleNameGlob", () => {
	test("literal match", () => {
		expect(simpleNameGlob("bash", "bash")).toBe(true);
		expect(simpleNameGlob("bash", "grep")).toBe(false);
	});
	test("wildcard match", () => {
		expect(simpleNameGlob("mcp_*", "mcp_gitea_list")).toBe(true);
		expect(simpleNameGlob("mcp_*", "bash")).toBe(false);
	});
});

describe("pathGlobToRegex", () => {
	test("star matches single segment", () => {
		expect(pathGlobToRegex("src/*.ts").test("src/main.ts")).toBe(true);
		expect(pathGlobToRegex("src/*.ts").test("src/sub/main.ts")).toBe(false);
	});
	test("double star matches recursively", () => {
		expect(pathGlobToRegex("src/**/*.ts").test("src/main.ts")).toBe(true);
		expect(pathGlobToRegex("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
	});
});

describe("matchTriggers", () => {
	test("tool name glob", () => {
		const flow = makeFlow([{ when: "after_tool_call", match: { tool: "file_write" } }]);
		const ids = matchTriggers(flow, { phase: "after_tool_call", tool: "file_write" });
		expect(ids).toEqual(["check_backend"]);
	});

	test("tool name glob does not match wrong phase", () => {
		const flow = makeFlow([{ when: "after_tool_call", match: { tool: "file_write" } }]);
		const ids = matchTriggers(flow, { phase: "before_tool_call", tool: "file_write" });
		expect(ids).toEqual([]);
	});

	test("path glob", () => {
		const flow = makeFlow([{ when: "after_tool_call", match: { path: "backend/**/*.ts" } }]);
		const ok = matchTriggers(flow, {
			phase: "after_tool_call",
			tool: "file_write",
			args: { path: "backend/foo/bar.ts" },
		});
		expect(ok).toEqual(["check_backend"]);
		const no = matchTriggers(flow, {
			phase: "after_tool_call",
			tool: "file_write",
			args: { path: "frontend/a.ts" },
		});
		expect(no).toEqual([]);
	});

	test("flow id exact match", () => {
		const flow = makeFlow([{ when: "on_flow_enter", match: { flow: "check_backend" } }]);
		expect(matchTriggers(flow, { phase: "on_flow_enter", flowId: "check_backend" })).toEqual(["check_backend"]);
		expect(matchTriggers(flow, { phase: "on_flow_enter", flowId: "other" })).toEqual([]);
	});

	test("combined tool + path match", () => {
		const flow = makeFlow([
			{ when: "after_tool_call", match: { tool: "file_write", path: "backend/**/*.ts" } },
		]);
		expect(
			matchTriggers(flow, {
				phase: "after_tool_call",
				tool: "file_write",
				args: { path: "backend/api.ts" },
			}),
		).toEqual(["check_backend"]);
		expect(
			matchTriggers(flow, {
				phase: "after_tool_call",
				tool: "grep",
				args: { path: "backend/api.ts" },
			}),
		).toEqual([]);
	});
});
