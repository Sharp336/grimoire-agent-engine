import type { ChatGptWebEvent } from "../../src/provider/types";

export const REASONING_TEXT_EVENTS: readonly ChatGptWebEvent[] = [
	{ type: "start", responseId: "response-fixture" },
	{ type: "reasoning", text: "Checking", continuation: false },
	{ type: "reasoning", text: " context", continuation: true },
	{ type: "commentary", text: "Working", continuation: false },
	{ type: "text", text: " answer", continuation: true },
	{ type: "usage", inputTokens: 11, outputTokens: 7, totalTokens: 18 },
	{ type: "done", reason: "stop" },
];

export const TOOL_CALL_EVENTS: readonly ChatGptWebEvent[] = [
	{ type: "start", responseId: "response-tool-fixture" },
	{
		type: "tool_call",
		callId: "call-fixture",
		name: "read_wire",
		argumentsJson: '{"path":"src/index.ts"}',
		freeform: false,
	},
	{ type: "done", reason: "toolUse" },
];

export const ABORT_EVENTS: readonly ChatGptWebEvent[] = [
	{ type: "start", responseId: "response-abort-fixture" },
	{ type: "error", errorClass: "aborted", retryable: false },
];
