import { describe, expect, test } from "bun:test";
import type { AgentContext, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { FlowExecutionStrategy } from "@oh-my-pi/pi-coding-agent/flow/flow-strategy";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTool(name: string): AgentTool<any> {
	return {
		name, label: name, description: `tool ${name}`,
		parameters: Type.Object({}), strict: false,
		async execute() { return { content: [{ type: "text", text: `${name}_ok` }] }; },
	};
}

function assistantToolCall(toolName: string, callId: string): AgentMessage {
	return { role: "assistant", content: [{ type: "toolCall", id: callId, name: toolName, input: {} }], timestamp: Date.now() } as unknown as AgentMessage;
}

function toolResult(callId: string, text: string, toolName?: string): AgentMessage {
	return { role: "toolResult", toolCallId: callId, toolName: toolName ?? "unknown", content: [{ type: "text", text }], isError: false, timestamp: Date.now() } as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

/**
 * Creates a strategy. pushMsg stamps flowFrameId directly on each message
 * using the current top frame from strategy.state — mirrors what the real
 * session manager does in #appendEntry.
 */
function makeStrategy(flowJson: object) {
	const dir = mkdtempSync(join(tmpdir(), "flow-test-"));
	mkdirSync(join(dir, ".omp"), { recursive: true });
	writeFileSync(join(dir, ".omp", "flow.json"), JSON.stringify(flowJson));
	const strategy = new FlowExecutionStrategy({
		storePath: join(dir, ".omp", "flow.json"),
		cwd: dir,
	});
	/** Push messages and stamp each with the correct flowFrameId —
	 *  mirrors what the real session manager does in #appendEntry
	 *  via strategy.getFrameIdForMessage(). */
	const pushMsg = (messages: AgentMessage[], ...msgs: AgentMessage[]) => {
		for (const m of msgs) {
			const frameId = strategy.getFrameIdForMessage(m);
			if (frameId) {
				(m as any).flowFrameId = frameId;
			}
			messages.push(m);
		}
	};
	return { strategy, pushMsg };
}

const BASE_FLOW = {
	version: 1, id: "test_flow",
	nodes: {
		chat: { description: "Root node" },
		scout: { description: "Scout sub-flow", available_tools: ["bash", "read"] },
	},
	edges: [],
};

describe("FlowExecutionStrategy sub-flow lifecycle", () => {
	test("transformContext filters sub-flow messages after ret", async () => {
		const { strategy, pushMsg } = makeStrategy(BASE_FLOW);
		const messages: AgentMessage[] = [];
		pushMsg(messages, userMessage("enter scout"));
		const ctx: AgentContext = { systemPrompt: "", messages, tools: [makeTool("bash"), makeTool("read")] };

		await strategy.syncBeforeModelCall(ctx);
		const entryTool = (ctx.tools ?? []).find(t => t.name === "scout")!;
		const em1 = assistantToolCall("scout", "c1");
		pushMsg(messages, em1);
		await entryTool.execute("c1", { reason: "test entry" });
		pushMsg(messages, toolResult("c1", "Entered scout.", "scout"));
		await strategy.onTurnEnd({ context: ctx, message: em1, newMessages: [messages[1], messages[2]] });

		await strategy.syncBeforeModelCall(ctx);
		const retTool = (ctx.tools ?? []).find(t => t.name === "ret")!;
		const em2 = assistantToolCall("ret", "c2");
		pushMsg(messages, em2);
		await retTool.execute("c2", { value: "Found 3 config files" });
		pushMsg(messages, toolResult("c2", "ret", "ret"));
		await strategy.onTurnEnd({ context: ctx, message: em2, newMessages: [messages[3], messages[4]] });

		const view = await strategy.transformContext(messages);
		const roles = view.map(m => (m as any).role);
		expect(roles.filter(r => r === "user").length).toBe(1);
		// Entry assistant message (with scout tool call) survives — re-stamped with parent frame
		const assistantMsgs = view.filter(m => (m as any).role === "assistant");
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
		// Ret assistant message also survives — re-stamped with parent frame
		const retAssistant = assistantMsgs.find(m =>
			((m as any).content ?? []).some((c: any) => c.type === "toolCall" && c.name === "ret"));
		expect(retAssistant).toBeDefined();
	});

	test("completed sub-flow appears in <scene> block", async () => {
		const { strategy, pushMsg } = makeStrategy(BASE_FLOW);
		const messages: AgentMessage[] = [];
		pushMsg(messages, userMessage("enter scout"));
		const ctx: AgentContext = { systemPrompt: "", messages, tools: [makeTool("bash"), makeTool("read")] };

		await strategy.syncBeforeModelCall(ctx);
		const entryTool = (ctx.tools ?? []).find(t => t.name === "scout")!;
		const em = assistantToolCall("scout", "c1");
		pushMsg(messages, em);
		await entryTool.execute("c1", { reason: "test entry" });
		const er = toolResult("c1", "Entered scout.", "scout");
		pushMsg(messages, er);
		await strategy.onTurnEnd({ context: ctx, message: em, newMessages: [em, er] });

		await strategy.syncBeforeModelCall(ctx);
		const retTool = (ctx.tools ?? []).find(t => t.name === "ret")!;
		const rm = assistantToolCall("ret", "c2");
		pushMsg(messages, rm);
		await retTool.execute("c2", { value: "Found 3 config files" });
		const rr = toolResult("c2", "ret", "ret");
		pushMsg(messages, rr);
		await strategy.onTurnEnd({ context: ctx, message: rm, newMessages: [rm, rr] });

		const view = await strategy.transformContext(messages);
		const flowBlock = view.find(m => {
			const c = (m as any).content;
			return Array.isArray(c) && c.some((b: any) => typeof b.text === "string" && b.text.includes("<scene>"));
		});
		expect(flowBlock).toBeDefined();
		const flowText = ((flowBlock as any).content as any[])[0].text;
		expect(flowText).toContain("scout");
		expect(flowText).toContain("Found 3 config files");
	});

	test("original user message survives subflow entry + work + ret", async () => {
		const { strategy, pushMsg } = makeStrategy(BASE_FLOW);
		const messages: AgentMessage[] = [];

		// [0] user: original request — stamped with chat frame
		pushMsg(messages, userMessage("enter scout and find config files"));
		const ctx: AgentContext = { systemPrompt: "", messages, tools: [makeTool("bash"), makeTool("read")] };

		// Turn 1: model enters scout
		// Real sequence: message_end(assistant) → tool execute → message_end(toolResult)
		await strategy.syncBeforeModelCall(ctx);
		const entryTool = (ctx.tools ?? []).find(t => t.name === "scout")!;
		const assistantEntry = assistantToolCall("scout", "c1");
		pushMsg(messages, assistantEntry); // assistant persisted BEFORE execute — stack is [chat]
		await entryTool.execute("c1", { reason: "find config files" }); // stack becomes [chat, scout]
		pushMsg(messages, toolResult("c1", "Entered scout.", "scout")); // toolResult persisted AFTER — stamped with parent (chat)
		await strategy.onTurnEnd({ context: ctx, message: assistantEntry, newMessages: [messages[1], messages[2]] });

		// Turn 2: model does work inside scout
		await strategy.syncBeforeModelCall(ctx);
		pushMsg(messages, assistantToolCall("read", "c3"), toolResult("c3", "file contents here", "read"));
		await strategy.onTurnEnd({ context: ctx, message: messages[3], newMessages: [messages[3], messages[4]] });

		// Turn 3: user sends message while in scout
		pushMsg(messages, userMessage("ok now use ret to exit"));

		// Turn 4: model rets
		// Real sequence: message_end(assistant) → tool execute → message_end(toolResult)
		await strategy.syncBeforeModelCall(ctx);
		const retTool = (ctx.tools ?? []).find(t => t.name === "ret")!;
		const assistantRet = assistantToolCall("ret", "c4");
		pushMsg(messages, assistantRet); // assistant persisted BEFORE execute — ret detected → parent frame
		await retTool.execute("c4", { value: "Found 3 config files in /etc" });
		pushMsg(messages, toolResult("c4", "ret", "ret")); // toolResult persisted AFTER — stamped with parent
		await strategy.onTurnEnd({ context: ctx, message: assistantRet, newMessages: [messages[6], messages[7]] });

		const view = await strategy.transformContext(messages);
		const userMessages = view.filter(m => (m as any).role === "user");
		const userTexts = userMessages.map(m => {
			const c = (m as any).content;
			return Array.isArray(c) ? c[0]?.text : c;
		});

		// Original user message MUST survive — it was stamped with chat frame
		expect(userTexts).toContain("enter scout and find config files");
		// Entry assistant message (scout tool call) survives — re-stamped with parent
		const assistantMsgs = view.filter(m => (m as any).role === "assistant");
		const entryMsg = assistantMsgs.find(m =>
			((m as any).content ?? []).some((c: any) => c.type === "toolCall" && c.name === "scout"));
		expect(entryMsg).toBeDefined();
		// Ret assistant message survives — re-stamped with parent
		const retMsg = assistantMsgs.find(m =>
			((m as any).content ?? []).some((c: any) => c.type === "toolCall" && c.name === "ret"));
		expect(retMsg).toBeDefined();
		// Sub-flow internal tool calls (read) must NOT survive
		const internalMsg = assistantMsgs.find(m =>
			((m as any).content ?? []).some((c: any) => c.type === "toolCall" && c.name === "read"));
		expect(internalMsg).toBeUndefined();
		// Scene block should mention completed sub-flow
		const sceneMsg = view.find(m => {
			const c = (m as any).content;
			return Array.isArray(c) && c.some((b: any) => typeof b.text === "string" && b.text.includes("<scene>"));
		});
		expect(sceneMsg).toBeDefined();
		const sceneText = ((sceneMsg as any).content as any[])[0].text;
		expect(sceneText).toContain("Found 3 config files in /etc");
	});

	test("drainPendingRet path also works with transformContext filter", async () => {
		const { strategy, pushMsg } = makeStrategy(BASE_FLOW);
		const messages: AgentMessage[] = [];
		pushMsg(messages, userMessage("scout"));
		const ctx: AgentContext = { systemPrompt: "", messages, tools: [makeTool("bash"), makeTool("read")] };

		await strategy.syncBeforeModelCall(ctx);
		const entryTool = (ctx.tools ?? []).find(t => t.name === "scout")!;
		const em = assistantToolCall("scout", "c1");
		pushMsg(messages, em);
		await entryTool.execute("c1", { reason: "test entry" });
		const er = toolResult("c1", "Entered scout.", "scout");
		pushMsg(messages, er);
		await strategy.onTurnEnd({ context: ctx, message: em, newMessages: [em, er] });

		await strategy.syncBeforeModelCall(ctx);
		const retTool = (ctx.tools ?? []).find(t => t.name === "ret")!;
		await retTool.execute("c2", { value: "5 endpoints found" });

		// Skip onTurnEnd, go to next sync (race — drainPendingRet)
		const rm = assistantToolCall("ret", "c2");
		pushMsg(messages, rm);
		pushMsg(messages, toolResult("c2", "ret", "ret"));
		await strategy.syncBeforeModelCall(ctx);

		const view = await strategy.transformContext(messages);
		// 5 original + 2 synthetic (Entering + Exited) + 1 synthetic Entering chat (root re-push)
		expect(messages.length).toBeGreaterThanOrEqual(5);
		const flowText = view.flatMap(m => {
			const c = (m as any).content;
			return Array.isArray(c) ? c.map((b: any) => b.text ?? "") : [];
		}).join("\n");
		expect(flowText).toContain("5 endpoints found");
	});

	test("drainPendingRet never pops the root frame (race condition)", async () => {
		const { strategy, pushMsg } = makeStrategy(BASE_FLOW);
		const messages: AgentMessage[] = [];
		pushMsg(messages, userMessage("scout"));
		const ctx: AgentContext = { systemPrompt: "", messages, tools: [makeTool("bash"), makeTool("read")] };

		await strategy.syncBeforeModelCall(ctx);

		const entryTool = (ctx.tools ?? []).find(t => t.name === "scout")!;
		const em = assistantToolCall("scout", "c1");
		pushMsg(messages, em);
		await entryTool.execute("c1", { reason: "test entry" });
		const er = toolResult("c1", "Entered scout.", "scout");
		pushMsg(messages, er);
		await strategy.onTurnEnd({ context: ctx, message: em, newMessages: [em, er] });

		await strategy.syncBeforeModelCall(ctx);
		const retTool = (ctx.tools ?? []).find(t => t.name === "ret")!;
		const rm = assistantToolCall("ret", "c2");
		pushMsg(messages, rm);
		await retTool.execute("c2", { value: "result" });
		const rr = toolResult("c2", "ret", "ret");
		pushMsg(messages, rr);
		await strategy.onTurnEnd({ context: ctx, message: rm, newMessages: [rm, rr] });

		const state = strategy.state;
		expect(state.frameStack.length).toBeGreaterThanOrEqual(1);
		expect(state.frameStack[0].nodeId).toBe("chat");

		await strategy.syncBeforeModelCall(ctx);
		expect(strategy.state.frameStack.length).toBe(1);
		expect(strategy.state.frameStack[0].nodeId).toBe("chat");
	});
});
