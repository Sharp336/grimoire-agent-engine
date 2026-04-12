import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { FlowInterpreter } from "../src/flow/flow-interpreter";
import type { Flow } from "../src/flow/flow-types";

function tool(name: string, exec?: () => void): AgentTool<any> {
	return {
		name,
		label: name,
		description: "",
		parameters: Type.Object({}, { additionalProperties: true }),
		strict: false,
		async execute() {
			exec?.();
			return { content: [{ type: "text", text: `${name}_ok` }] };
		},
	};
}

describe("FlowInterpreter", () => {
	test("pushNode and popNode track current node", async () => {
		const flow: Flow = {
			version: 1,
			id: "t",
			nodes: { a: { description: "A" }, b: { description: "B" } },
			edges: [],
		};
		const interp = new FlowInterpreter(flow);
		await interp.pushNode("a", { tools: [] });
		expect(interp.currentNodeId).toBe("a");
		await interp.pushNode("b", { tools: [] });
		expect(interp.currentNodeId).toBe("b");
		await interp.popNode("done", { tools: [] });
		expect(interp.currentNodeId).toBe("a");
		await interp.popNode("done", { tools: [] });
		expect(interp.isStackEmpty).toBe(true);
	});

	test("resolveTools applies available_tools filter", async () => {
		const flow: Flow = {
			version: 1,
			id: "t",
			nodes: { chat: { available_tools: ["bash", "!grep"] } },
			edges: [],
		};
		const interp = new FlowInterpreter(flow);
		await interp.pushNode("chat", { tools: [] });
		const parent = [tool("bash"), tool("grep"), tool("read_file")];
		const out = interp.resolveTools(parent);
		const names = out.map(t => t.name);
		expect(names).toContain("bash");
		expect(names).not.toContain("grep");
	});

	test("node-as-tool exposure: node id in filter becomes a callable tool", async () => {
		const flow: Flow = {
			version: 1,
			id: "t",
			nodes: {
				root: { available_tools: ["sub_task"] },
				sub_task: { description: "child flow" },
			},
			edges: [],
		};
		const interp = new FlowInterpreter(flow);
		await interp.pushNode("root", { tools: [] });
		const out = interp.resolveTools([]);
		expect(out.find(t => t.name === "sub_task")).toBeDefined();
		// calling it pushes a new frame
		const subTool = out.find(t => t.name === "sub_task")!;
		await subTool.execute("call_1", {} as any);
		expect(interp.currentNodeId).toBe("sub_task");
	});

	test("handleEvent transitions in-frame on tool_call edge", async () => {
		const flow: Flow = {
			version: 1,
			id: "t",
			nodes: { a: {}, b: {} },
			edges: [{ from: "a", to: "b", when: { kind: "tool_call", name: "bash" } }],
		};
		const interp = new FlowInterpreter(flow);
		await interp.pushNode("a", { tools: [] });
		const stackBefore = interp.frameStack.length;
		await interp.handleEvent({ kind: "tool_call", name: "bash" }, { tools: [] });
		expect(interp.currentNodeId).toBe("b");
		expect(interp.frameStack.length).toBe(stackBefore);
	});

	test("handleEvent without matching edge keeps node unchanged (multi-turn)", async () => {
		const flow: Flow = {
			version: 1,
			id: "t",
			nodes: { a: {} },
			edges: [],
		};
		const interp = new FlowInterpreter(flow);
		await interp.pushNode("a", { tools: [] });
		const next = await interp.handleEvent({ kind: "tool_call", name: "bash" }, { tools: [] });
		expect(next).toBeNull();
		expect(interp.currentNodeId).toBe("a");
	});

	test("onEnter / onLeave hooks run around push/pop", async () => {
		const calls: string[] = [];
		const flow: Flow = {
			version: 1,
			id: "t",
			nodes: {
				a: {
					onEnter: [{ tool: "enter_hook" }],
					onLeave: [{ tool: "leave_hook" }],
				},
			},
			edges: [],
		};
		const interp = new FlowInterpreter(flow);
		const tools = [tool("enter_hook", () => calls.push("enter")), tool("leave_hook", () => calls.push("leave"))];
		await interp.pushNode("a", { tools });
		expect(calls).toEqual(["enter"]);
		await interp.popNode("bye", { tools });
		expect(calls).toEqual(["enter", "leave"]);
	});
});
