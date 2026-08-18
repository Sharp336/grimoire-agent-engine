import { describe, expect, it } from "bun:test";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { buildResponsesInput, hoistInterleavedAssistantMessages } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, ModelSpec, TextContent } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "test-opencode-go",
	name: "Test opencode-go",
	api: "openai-responses",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16000,
} satisfies ModelSpec<"openai-responses">);

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(text: string): ResponseInput[number] {
	return {
		type: "message",
		id: `msg_${Bun.hash(text).toString(36)}`,
		role: "assistant",
		content: [{ type: "output_text", text, annotations: [] }],
		status: "completed",
	} as ResponseInput[number];
}

function call(id: string, name = "bash"): ResponseInput[number] {
	return {
		type: "function_call",
		call_id: id,
		name,
		arguments: "{}",
	} as ResponseInput[number];
}

function output(id: string): ResponseInput[number] {
	return {
		type: "function_call_output",
		call_id: id,
		output: "ok",
	} as ResponseInput[number];
}

function user(text: string): ResponseInput[number] {
	return { role: "user", content: text } as ResponseInput[number];
}

/** True when an assistant message appears between a tool call and its output. */
function hasInterleavedMessage(items: readonly unknown[]): boolean {
	let pendingCalls = 0;
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const type = (item as { type?: unknown }).type;
		if (type === "function_call" || type === "custom_tool_call" || type === "computer_call") {
			pendingCalls += 1;
			continue;
		}
		if (type === "function_call_output" || type === "custom_tool_call_output" || type === "computer_call_output") {
			pendingCalls = Math.max(0, pendingCalls - 1);
			continue;
		}
		if (pendingCalls > 0 && (item as { role?: unknown }).role === "assistant") return true;
	}
	return false;
}

describe("hoistInterleavedAssistantMessages", () => {
	it("moves a message between a call batch and its outputs to before the first call", () => {
		// Shape captured from a live opencode-go / Console Go 400: the model
		// streamed a trailing thinking block after six tool calls, and the
		// block-encode path preserved stream order, leaving the demoted text
		// message between the calls and the appended outputs.
		const input: ResponseInput = [
			message("<think>\n**Planning focused runtime verification**\n</think>"),
			call("call_a"),
			call("call_b"),
			call("call_c"),
			call("call_d"),
			call("call_e"),
			call("call_f"),
			message("<think>\n</thinking\n</think>"),
			output("call_a"),
			output("call_b"),
			output("call_c"),
			output("call_d"),
			output("call_e"),
			output("call_f"),
		];

		const hoisted = hoistInterleavedAssistantMessages(input);

		expect(hasInterleavedMessage(hoisted)).toBe(false);
		// The interleaved message survives, moved to the canonical position.
		const messageIndex = hoisted.findIndex(item => (item as { content?: unknown }) && item === input[7]);
		expect(messageIndex).toBeGreaterThanOrEqual(0);
		const firstCallIndex = hoisted.findIndex(item => (item as { type?: string }).type === "function_call");
		expect(messageIndex).toBeLessThan(firstCallIndex);
		// All calls precede all outputs, content otherwise untouched.
		expect(hoisted).toHaveLength(input.length);
	});

	it("returns the input unchanged when no message sits between calls and outputs", () => {
		const input: ResponseInput = [
			message("text before calls"),
			call("call_a"),
			call("call_b"),
			output("call_a"),
			output("call_b"),
			user("next turn"),
		];

		expect(hoistInterleavedAssistantMessages(input)).toBe(input);
	});

	it("hoists messages between custom_tool_call batches and their outputs", () => {
		const input: ResponseInput = [
			{ type: "custom_tool_call", call_id: "call_c", name: "apply_patch", input: "patch" } as ResponseInput[number],
			message("trailing think after the call"),
			{ type: "custom_tool_call_output", call_id: "call_c", output: "ok" } as ResponseInput[number],
		];

		const hoisted = hoistInterleavedAssistantMessages(input);

		expect(hasInterleavedMessage(hoisted)).toBe(false);
		const firstCallIndex = hoisted.findIndex(item => (item as { type?: string }).type === "custom_tool_call");
		expect((hoisted[firstCallIndex - 1] as { role?: unknown }).role).toBe("assistant");
	});

	it("does not hoist user messages", () => {
		const input: ResponseInput = [call("call_a"), user("user text while a result is pending"), output("call_a")];

		// A user message between a call and its output is not a shape this pass
		// repairs (it does not arise from the block-encode path); leave it alone.
		expect(hoistInterleavedAssistantMessages(input)).toBe(input);
	});

	it("handles multiple batches, repairing only the interleaved one", () => {
		const input: ResponseInput = [
			message("turn one text"),
			call("call_1"),
			output("call_1"),
			message("turn two text"),
			call("call_2"),
			message("trailing think"),
			output("call_2"),
		];

		const hoisted = hoistInterleavedAssistantMessages(input);

		expect(hasInterleavedMessage(hoisted)).toBe(false);
		expect(hoisted).toHaveLength(input.length);
	});
});

describe("buildResponsesInput interleaved assistant turn", () => {
	it("never emits a message between a call batch and its outputs", () => {
		// Reproduces the failing live turn: one assistant message whose content
		// blocks are [demoted think text, six tool calls, malformed trailing
		// think text] — the block-encode path used to emit the trailing text as
		// a message item after the calls, interleaving it between the calls and
		// the six tool results appended afterwards.
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "<think>\n**Planning focused runtime verification**\n</think>" },
						{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "uv run pytest -q" } },
						{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "npm test" } },
						{ type: "toolCall", id: "call_3", name: "bash", arguments: { command: "docker compose config" } },
						{ type: "toolCall", id: "call_4", name: "grep", arguments: { pattern: "Vite" } },
						{ type: "toolCall", id: "call_5", name: "read", arguments: { path: "README.md" } },
						{ type: "toolCall", id: "call_6", name: "todo", arguments: { op: "view" } },
						{ type: "text", text: "<think>\n</thinking\n</think>" },
					],
					api: "openai-responses",
					provider: "opencode-go",
					model: "test-opencode-go",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				...Array.from({ length: 6 }, (_, index) => ({
					role: "toolResult" as const,
					toolCallId: `call_${index + 1}`,
					toolName: "bash",
					content: [{ type: "text" as const, text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				})),
			],
		};

		const items = buildResponsesInput({
			model,
			context,
			strictResponsesPairing: true,
			supportsImageDetailOriginal: false,
		});

		expect(hasInterleavedMessage(items)).toBe(false);
		// The trailing think text survives, positioned before the calls.
		const texts = items
			.filter(item => (item as { type?: string }).type === "message")
			.map(item => ((item as { content?: unknown }).content as TextContent[])[0]?.text ?? "");
		expect(texts.some(text => text.includes("</thinking"))).toBe(true);
		// Six calls, six outputs, all paired.
		const callIds = items.filter(item => (item as { type?: string }).type === "function_call").length;
		const outputIds = items.filter(item => (item as { type?: string }).type === "function_call_output").length;
		expect(callIds).toBe(6);
		expect(outputIds).toBe(6);
	});
});
