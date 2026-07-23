import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentMessage, AgentTool, AgentToolResult, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

async function runComputerTool(tool: AgentTool): Promise<ToolResultMessage> {
	const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [tool] };
	const mock = createMockModel();
	const usage: AssistantMessage["usage"] = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const scriptedContent: AssistantMessage["content"][] = [
		[
			{
				type: "toolCall",
				id: "call-computer|cu-computer",
				name: "computer",
				arguments: {
					actions: [{ type: "screenshot" }],
					pendingSafetyChecks: [{ id: "safe-1", code: null, message: "Confirm navigation" }],
				},
				openaiComputer: {
					pendingSafetyChecks: [{ id: "safe-1", code: null, message: "Confirm navigation" }],
				},
			},
		],
		[{ type: "text", text: "done" }],
	];
	let responseIndex = 0;
	const streamFn: StreamFn = () => {
		const content = scriptedContent[responseIndex++] ?? [];
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: mock.model.api,
			provider: mock.model.provider,
			model: mock.model.id,
			usage,
			stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		const response = new AssistantMessageEventStream();
		queueMicrotask(() => {
			response.push({ type: "start", partial: message });
			for (const block of content) {
				message.content.push(block);
				const contentIndex = message.content.length - 1;
				if (block.type === "toolCall") {
					response.push({ type: "toolcall_start", contentIndex, partial: message });
					response.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
				} else if (block.type === "text") {
					response.push({ type: "text_start", contentIndex, partial: message });
					response.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
					response.push({ type: "text_end", contentIndex, content: block.text, partial: message });
				}
			}
			response.push({
				type: "done",
				reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
				message,
			});
		});
		return response;
	};
	const stream = agentLoop(
		[createUserMessage("inspect the desktop")],
		context,
		{ model: mock.model, convertToLlm: identityConverter },
		undefined,
		streamFn,
	);
	for await (const _event of stream) {
		// Drain the loop.
	}
	const messages = await stream.result();
	const result = messages.find((message): message is ToolResultMessage => message.role === "toolResult");
	if (!result) throw new Error("Expected a computer tool result");
	return result;
}

describe("OpenAI computer metadata propagation", () => {
	it("dispatches by native marker and persists acknowledged safety checks", async () => {
		const parameters = type({ actions: "unknown[]", pendingSafetyChecks: "unknown[]" });
		const executed: unknown[] = [];
		const tool: AgentTool<typeof parameters> = {
			name: "desktop-control",
			label: "Computer",
			description: "Control the desktop",
			parameters,
			openaiNativeTool: "computer",
			intent: "omit",
			async execute(_toolCallId, params) {
				executed.push(params.actions);
				return {
					content: [{ type: "image", mimeType: "image/png", data: "full-resolution-png" }],
					openaiComputer: {
						acknowledgedSafetyChecks: [{ id: "safe-1", code: null, message: "Confirm navigation" }],
					},
				};
			},
		};
		const result = await runComputerTool(tool);

		expect(executed).toEqual([[{ type: "screenshot" }]]);
		expect(result?.content).toEqual([{ type: "image", mimeType: "image/png", data: "full-resolution-png" }]);
		expect(result?.openaiComputer).toEqual({
			acknowledgedSafetyChecks: [{ id: "safe-1", code: null, message: "Confirm navigation" }],
		});
	});

	it("preserves acknowledged safety checks when malformed content is coerced", async () => {
		const parameters = type({ actions: "unknown[]", pendingSafetyChecks: "unknown[]" });
		const acknowledgedSafetyChecks = [{ id: "safe-1", code: null, message: "Confirm navigation" }];
		const tool: AgentTool<typeof parameters> = {
			name: "desktop-control",
			label: "Computer",
			description: "Control the desktop",
			parameters,
			openaiNativeTool: "computer",
			intent: "omit",
			execute: async () =>
				({
					content: "malformed screenshot result",
					details: { source: "computer" },
					openaiComputer: { acknowledgedSafetyChecks },
				}) as unknown as AgentToolResult,
		};

		const result = await runComputerTool(tool);

		expect(result.content).toEqual([
			{ type: "text", text: "Tool returned an invalid result: missing content array." },
		]);
		expect(result.details).toEqual({ source: "computer" });
		expect(result.isError).toBe(true);
		expect(result.openaiComputer?.acknowledgedSafetyChecks).toEqual(acknowledgedSafetyChecks);
	});
});
