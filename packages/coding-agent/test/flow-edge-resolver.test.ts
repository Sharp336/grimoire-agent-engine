import { describe, expect, test } from "bun:test";
import { resolveEdge } from "../src/flow/flow-edge-resolver";
import type { Flow } from "../src/flow/flow-types";

const flow: Flow = {
	version: 1,
	id: "t",
	nodes: { a: {}, b: {}, c: {}, d: {} },
	edges: [
		{ from: "a", to: "b", when: { kind: "always" } },
		{ from: "a", to: "c", when: { kind: "tool_call", name: "bash" } },
		{ from: "b", to: "c", when: { kind: "ret" } },
		{ from: "b", to: "d", when: { kind: "error" } },
	],
};

describe("resolveEdge", () => {
	test("always matches any event", () => {
		expect(resolveEdge(flow, "a", { kind: "ret" })).toBe("b");
	});

	test("tool_call matches exact tool name", () => {
		const f: Flow = { ...flow, edges: flow.edges.slice(1) };
		expect(resolveEdge(f, "a", { kind: "tool_call", name: "bash" })).toBe("c");
		expect(resolveEdge(f, "a", { kind: "tool_call", name: "grep" })).toBeNull();
	});

	test("ret matches ret event", () => {
		expect(resolveEdge(flow, "b", { kind: "ret" })).toBe("c");
	});

	test("error matches error event", () => {
		expect(resolveEdge(flow, "b", { kind: "error" })).toBe("d");
	});

	test("no matching edge returns null", () => {
		expect(resolveEdge(flow, "c", { kind: "ret" })).toBeNull();
	});
});
