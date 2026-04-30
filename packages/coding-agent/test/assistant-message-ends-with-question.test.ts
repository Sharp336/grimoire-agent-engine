import { describe, expect, it } from "bun:test";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { assistantMessageEndsWithQuestion } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function text(text: string): TextContent {
	return { type: "text", text };
}

function toolCall(name: string, id = `call_${name}`): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("assistantMessageEndsWithQuestion", () => {
	describe("ask tool calls", () => {
		it("returns true when the turn ends with an `ask` tool call", () => {
			const msg = makeAssistantMessage([text("Two options."), toolCall("ask")]);
			expect(assistantMessageEndsWithQuestion(msg)).toBe(true);
		});

		it("returns true when `ask` is anywhere in a multi-tool turn", () => {
			const msg = makeAssistantMessage([toolCall("read"), toolCall("ask")]);
			expect(assistantMessageEndsWithQuestion(msg)).toBe(true);
		});

		it("returns false when only non-ask tool calls are present", () => {
			const msg = makeAssistantMessage([text("Reading."), toolCall("read"), toolCall("bash")]);
			expect(assistantMessageEndsWithQuestion(msg)).toBe(false);
		});
	});

	describe("plain-text questions", () => {
		it("returns true on a trailing '?'", () => {
			const msg = makeAssistantMessage([text("Which approach do you want?")]);
			expect(assistantMessageEndsWithQuestion(msg)).toBe(true);
		});

		it("ignores trailing whitespace before the '?'", () => {
			const msg = makeAssistantMessage([text("Which approach do you want?\n  \n")]);
			expect(assistantMessageEndsWithQuestion(msg)).toBe(true);
		});

		it("strips trailing closing punctuation after the '?'", () => {
			expect(assistantMessageEndsWithQuestion(makeAssistantMessage([text("Got it (right?)")]))).toBe(true);
			expect(assistantMessageEndsWithQuestion(makeAssistantMessage([text('Title: "Done?"')]))).toBe(true);
			expect(assistantMessageEndsWithQuestion(makeAssistantMessage([text("**ready?**")]))).toBe(true);
		});

		it("uses only the LAST text block when multiple are present", () => {
			const msg = makeAssistantMessage([text("Earlier sentence?"), text("Final statement.")]);
			expect(assistantMessageEndsWithQuestion(msg)).toBe(false);
		});

		it("returns false on a declarative trailing sentence", () => {
			const msg = makeAssistantMessage([text("Done. Phase 3 complete.")]);
			expect(assistantMessageEndsWithQuestion(msg)).toBe(false);
		});

		it("returns false on an empty text block", () => {
			expect(assistantMessageEndsWithQuestion(makeAssistantMessage([text("")]))).toBe(false);
			expect(assistantMessageEndsWithQuestion(makeAssistantMessage([text("   \n")]))).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("returns false on a message with no content", () => {
			expect(assistantMessageEndsWithQuestion(makeAssistantMessage([]))).toBe(false);
		});

		it("ignores trailing-text question when a non-ask tool call exists", () => {
			// Tool calls take priority — if the agent invoked a non-ask tool, control is not
			// being handed to the user.
			const msg = makeAssistantMessage([text("Check this?"), toolCall("bash")]);
			expect(assistantMessageEndsWithQuestion(msg)).toBe(false);
		});
	});
});
