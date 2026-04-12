import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { FlowRuntime } from "@oh-my-pi/pi-coding-agent/flow/flow-runtime";
import type { Flow, FlowNode } from "../src/flow/flow-types";

function node(description = ""): FlowNode {
	return { description };
}

const flow: Flow = {
	version: 1,
	id: "test",
	nodes: {
		root: node("root"),
		child: node("child"),
		grand: node("grand"),
	},
	edges: [],
};

function userMsg(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

describe("FlowRuntime open/close", () => {
	test("open frame pushes onto stack and into log", () => {
		const r = new FlowRuntime(flow);
		const f = r.openFrame("root", "p");
		expect(r.frameStack.length).toBe(1);
		expect(r.executionLog.length).toBe(1);
		expect(r.topFrame?.id).toBe(f.id);
		expect(r.topFrame?.parentId).toBeNull();
	});

	test("nested call sets parentId", () => {
		const r = new FlowRuntime(flow);
		const a = r.openFrame("root", "p1");
		const b = r.openFrame("child", "p2");
		expect(b.parentId).toBe(a.id);
		expect(r.frameStack.length).toBe(2);
	});

	test("closeFrame pops and returns value", () => {
		const r = new FlowRuntime(flow);
		r.openFrame("root", "p");
		const closed = r.closeFrame("hello");
		expect(closed.returnValue).toBe("hello");
		expect(closed.status).toBe("returned");
		expect(r.isStackEmpty).toBe(true);
	});

	test("appendToCurrentFrame emits trace without storing on frame", () => {
		const r = new FlowRuntime(flow);
		r.openFrame("root", "p");
		// Should not throw — message is traced but not stored on frame.
		r.appendToCurrentFrame(userMsg("hi"));
		// Frame has no pocketMessages field; trace is handled by listeners.
	});

	test("openFrame on unknown node throws", () => {
		const r = new FlowRuntime(flow);
		expect(() => r.openFrame("missing", "p")).toThrow();
	});

	test("currentNode tracks top frame", () => {
		const r = new FlowRuntime(flow);
		r.openFrame("root", "p");
		expect(r.currentNode?.description).toBe("root");
		r.openFrame("child", "p2");
		expect(r.currentNode?.description).toBe("child");
	});
});

describe("FlowRuntime editFlow + supersede", () => {
	test("set_node on inactive node only updates flow", () => {
		const r = new FlowRuntime(flow);
		r.openFrame("root", "p");
		const res = r.editFlow([{ kind: "set_node", nodeId: "newone", node: node("newone") }]);
		expect(res.applied.length).toBe(1);
		expect(res.supersededFrameIds.length).toBe(0);
		expect(r.getNode("newone")).toBeDefined();
		expect(r.frameStack.length).toBe(1);
	});

	test("set_node on active frame supersedes and re-pushes", () => {
		const r = new FlowRuntime(flow);
		r.openFrame("root", "p1");
		r.openFrame("child", "p2");
		r.openFrame("grand", "p3");

		const res = r.editFlow([{ kind: "set_node", nodeId: "child", node: node("child") }]);
		expect(res.supersededFrameIds.length).toBe(2);
		expect(res.rerunFrameId).toBeDefined();
		expect(r.frameStack.length).toBe(2);
		expect(r.frameStack[1].nodeId).toBe("child");
		const supersededInLog = r.executionLog.filter(f => f.status === "superseded");
		expect(supersededInLog.length).toBe(2);
		for (const old of supersededInLog) {
			expect(old.supersededBy).toBe(res.rerunFrameId);
		}
	});

	test("audit trail keeps every frame ever opened", () => {
		const r = new FlowRuntime(flow);
		r.openFrame("root", "p1");
		r.openFrame("child", "p2");
		r.editFlow([{ kind: "set_node", nodeId: "child", node: node("child") }]);
		r.closeFrame("done");
		r.closeFrame("done");
		expect(r.executionLog.length).toBeGreaterThanOrEqual(3);
	});

	test("delete_node on active node supersedes without re-push", () => {
		const r = new FlowRuntime(flow);
		r.openFrame("root", "p1");
		r.openFrame("child", "p2");
		const res = r.editFlow([{ kind: "delete_node", nodeId: "child" }]);
		expect(res.supersededFrameIds.length).toBe(1);
		expect(res.rerunFrameId).toBeUndefined();
		expect(r.frameStack.length).toBe(1);
		expect(r.getNode("child")).toBeUndefined();
	});
});

describe("FlowRuntime snapshot/rehydrate", () => {
	test("snapshot then construct restores stack and log", () => {
		const r1 = new FlowRuntime(flow);
		r1.openFrame("root", "p1");
		r1.appendToCurrentFrame(userMsg("a"));
		r1.openFrame("child", "p2");
		const snap = r1.snapshot();

		const r2 = new FlowRuntime(flow, snap);
		expect(r2.frameStack.length).toBe(2);
		expect(r2.executionLog.length).toBe(2);
		expect(r2.topFrame?.nodeId).toBe("child");
	});
});
