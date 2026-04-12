import { describe, expect, test } from "bun:test";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { runHooks } from "../src/flow/flow-hook-executor";

function echoTool(name: string, fail = false): AgentTool<any> {
	return {
		name,
		label: name,
		description: "",
		parameters: Type.Object({}, { additionalProperties: true }),
		strict: false,
		async execute(_id, args) {
			if (fail) throw new Error(`${name} boom`);
			return { content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] };
		},
	};
}

describe("runHooks", () => {
	test("runs hooks in order and appends results", async () => {
		const messages: AgentMessage[] = [];
		const tools = [echoTool("load_rules"), echoTool("run_build")];
		await runHooks(
			[
				{ tool: "load_rules", args: { kind: "backend" } },
				{ tool: "run_build" },
			],
			{ tools, appendMessage: m => messages.push(m) },
		);
		expect(messages.length).toBe(2);
		const t0 = ((messages[0] as any).content as any)[0].text as string;
		const t1 = ((messages[1] as any).content as any)[0].text as string;
		expect(t0).toContain("load_rules");
		expect(t0).toContain("backend");
		expect(t1).toContain("run_build");
	});

	test("unknown tool is skipped with a note and does not throw", async () => {
		const messages: AgentMessage[] = [];
		await runHooks([{ tool: "missing" }], { tools: [], appendMessage: m => messages.push(m) });
		expect(messages.length).toBe(1);
		expect(((messages[0] as any).content as any)[0].text).toContain("tool not found");
	});

	test("hook error triggers onError hooks and rethrows", async () => {
		const messages: AgentMessage[] = [];
		const tools = [echoTool("bad", true), echoTool("cleanup")];
		let threw = false;
		try {
			await runHooks(
				[{ tool: "bad" }],
				{ tools, appendMessage: m => messages.push(m) },
				[{ tool: "cleanup" }],
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		// First message: error note. Then cleanup result.
		const texts = messages.map(m => ((m as any).content as any)[0].text as string);
		expect(texts.some(t => t.includes("bad") && t.includes("error"))).toBe(true);
		expect(texts.some(t => t.includes("cleanup"))).toBe(true);
	});
});
