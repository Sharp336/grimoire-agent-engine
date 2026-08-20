import { describe, expect, test } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

function makeTool(): HubTool {
	return new HubTool({} as ToolSession);
}

describe("fork Hub model surface", () => {
	test("exposes parent-side async and process control only", () => {
		const tool = makeTool();
		const expression = tool.parameters.expression;

		for (const op of ["send", "wait", "jobs", "cancel", "start", "ps", "logs", "stop", "restart", "describe"]) {
			expect(expression).toMatch(new RegExp(`\\b${op}\\b`));
		}
		for (const hiddenOp of ["list", "inbox"]) {
			expect(expression).not.toMatch(new RegExp(`\\b${hiddenOp}\\b`));
		}
		for (const hiddenField of ["to", "message", "replyTo", "await", "from", "peek"]) {
			expect(expression).not.toMatch(new RegExp(`\\b${hiddenField}\\??:`));
		}
	});

	test("descriptions and examples do not teach peer messaging", () => {
		const tool = makeTool();
		const modelText = `${tool.summary}\n${tool.description}`;

		for (const forbidden of ["peer", "inbox", "replyTo", "message them", "with `to`"]) {
			expect(modelText).not.toContain(forbidden);
		}
		for (const example of tool.examples) {
			expect(example.call.op).not.toBe("list");
			expect(example.call.op).not.toBe("inbox");
			for (const field of ["to", "message", "replyTo", "await", "from", "peek"]) {
				expect(field in example.call).toBe(false);
			}
		}
	});
});
