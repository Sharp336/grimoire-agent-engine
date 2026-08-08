import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

const ASK_TOOL_CALL_ID = "rpc-native-ask-call";
const ASK_ANSWER_MARKER = "native-ask-answer";

function assistantMessage(
	text: string,
	stopReason: AssistantMessage["stopReason"],
	model = "rpc-hold",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "rpc-process-api",
		provider: "rpc-process",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function askToolResultText(
	messages: ReadonlyArray<{ role: string; toolCallId?: string; content?: string | ReadonlyArray<unknown> }>,
): string | undefined {
	const result = messages.findLast(
		message => message.role === "toolResult" && message.toolCallId === ASK_TOOL_CALL_ID,
	);
	if (!result) return undefined;
	if (typeof result.content === "string") return result.content;
	if (!Array.isArray(result.content)) return undefined;
	return result.content
		.filter((block): block is { type: "text"; text: string } => {
			if (typeof block !== "object" || block === null) return false;
			const record = block as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string";
		})
		.map(block => block.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("rpc-process", {
		baseUrl: "http://127.0.0.1/unused",
		apiKey: "rpc-process-key",
		api: "rpc-process-api",
		streamSimple: (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (model.id === "rpc-native-ask") {
					const toolResult = askToolResultText(context.messages);
					if (toolResult !== undefined) {
						const verified = toolResult.includes(ASK_ANSWER_MARKER);
						const message = assistantMessage(
							verified ? `native-ask-verified:${toolResult}` : `native-ask-result-mismatch:${toolResult}`,
							"stop",
							model.id,
						);
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}
					if (!context.tools?.some(tool => tool.name === "ask")) {
						const message = assistantMessage("native-ask-tool-missing", "stop", model.id);
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}
					const toolCall = {
						type: "toolCall",
						id: ASK_TOOL_CALL_ID,
						name: "ask",
						arguments: {
							questions: [
								{
									id: "native-ask-question",
									question: "Choose the native AskTool answer",
									options: [
										{ label: ASK_ANSWER_MARKER, description: "Proves the native tool round trip." },
										{ label: "wrong-answer" },
									],
									recommended: 0,
								},
							],
						},
					} as const;
					const message: AssistantMessage = {
						...assistantMessage("", "toolUse", model.id),
						content: [toolCall],
					};
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
					return;
				}
				stream.push({ type: "start", partial: assistantMessage("", "stop") });
				options?.signal?.addEventListener(
					"abort",
					() => {
						stream.push({ type: "error", reason: "aborted", error: assistantMessage("Aborted", "aborted") });
					},
					{ once: true },
				);
			});
			return stream;
		},
		models: [
			{
				id: "rpc-hold",
				name: "RPC held stream",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8_192,
				maxTokens: 1_024,
			},
			{
				id: "rpc-native-ask",
				name: "RPC native AskTool",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8_192,
				maxTokens: 1_024,
			},
		],
	});
}
