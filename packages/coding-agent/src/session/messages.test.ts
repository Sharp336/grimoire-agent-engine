import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens, estimateTokensUncached } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	type CustomMessage,
	convertToLlm,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	invalidateLlmConversion,
	replaceLlmImagesWithText,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
	stripImagesFromMessage,
} from "./messages";

function customMessage(customType: string, attribution: "agent" | "user"): CustomMessage<SkillPromptDetails> {
	return {
		role: "custom",
		customType,
		content: "Use this skill.",
		display: true,
		details: { name: "atomic-commit", path: "/tmp/SKILL.md", lineCount: 1 },
		attribution,
		timestamp: 1,
	};
}

const interruptedUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function abortedAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: interruptedUsage,
		stopReason: "aborted",
		timestamp: 1,
	};
}

function assistantMessage(content: AssistantMessage["content"], duration?: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: interruptedUsage,
		stopReason: "stop",
		timestamp: 1,
		...(duration === undefined ? {} : { duration }),
	};
}

function interruptedThinkingContinuity(): CustomMessage {
	return {
		role: "custom",
		customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
		content: "preserved reasoning",
		display: false,
		attribution: "agent",
		timestamp: 2,
	};
}

describe("convertToLlm", () => {
	it("presents user-invoked skill prompts as user turns", () => {
		const [message] = convertToLlm([customMessage(SKILL_PROMPT_MESSAGE_TYPE, "user")]);

		expect(message?.role).toBe("user");
		if (message?.role !== "user") {
			throw new Error(`Expected user role, received ${message?.role ?? "none"}`);
		}
		expect(message.attribution).toBe("user");
	});

	it("keeps auto-applied skill prompts and other custom messages as developer turns", () => {
		const [autoSkill, otherCustom] = convertToLlm([
			customMessage(SKILL_PROMPT_MESSAGE_TYPE, "agent"),
			customMessage("extension-note", "user"),
		]);

		expect(autoSkill?.role).toBe("developer");
		expect(otherCustom?.role).toBe("developer");
	});

	it("strips the demoted trailing thinking run from the assistant LLM view when its continuity message follows", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "interrupted reasoning" },
			]),
			interruptedThinkingContinuity(),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual(["text"]);
		expect(llm.some(entry => entry.role === "developer")).toBe(true);
	});

	it("keeps trailing thinking on the assistant LLM view when no continuity message follows", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "interrupted reasoning" },
			]),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
	});

	it("keeps a signed (complete) trailing thinking block in the assistant LLM view even with a continuity message", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "complete reasoning", thinkingSignature: "sig" },
			]),
			interruptedThinkingContinuity(),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
	});

	it("reuses identities for unchanged terminal assistant conversions", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], attribution: "user", timestamp: 1 },
			assistantMessage([{ type: "text", text: "final answer" }], 10),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "tool body" }],
				isError: false,
				timestamp: 3,
			},
		];
		const first = convertToLlm(messages);
		const second = convertToLlm(messages);
		expect(second).toBe(first);
		for (let i = 0; i < first.length; i++) {
			expect(second[i]).toBe(first[i]);
		}
	});

	it("keeps terminal aborted assistants eligible for whole-array carry", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "before abort", timestamp: 1 },
			assistantMessage([{ type: "text", text: "settled prefix" }], 10),
			abortedAssistant([{ type: "text", text: "interrupted turn" }]),
			{ role: "user", content: "after abort", timestamp: 2 },
			assistantMessage([{ type: "text", text: "settled tail" }], 10),
		];

		const first = convertToLlm(messages);
		const second = convertToLlm(messages);

		expect(second).toBe(first);
	});

	it("reconverts a live assistant mutated in place on the same source array", () => {
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			attribution: "user",
			timestamp: 1,
		};
		const block = { type: "text" as const, text: "streaming answer" };
		const assistant = assistantMessage([block]);
		const messages: AgentMessage[] = [user, assistant];
		const first = convertToLlm(messages);
		block.text = "streaming answer, now complete";
		const second = convertToLlm(messages);
		const secondAssistant = second.find(message => message.role === "assistant");
		expect(second).not.toBe(first);
		expect(second.find(message => message.role === "user")).toBe(first.find(message => message.role === "user"));
		expect(secondAssistant).toBe(assistant);
		expect(
			Array.isArray(secondAssistant?.content) &&
				secondAssistant.content[0]?.type === "text" &&
				secondAssistant.content[0].text,
		).toBe("streaming answer, now complete");
	});

	it("reconverts the same source array after a live assistant settles in place", () => {
		const assistant = assistantMessage([
			{ type: "text", text: "partial answer" },
			{ type: "thinking", thinking: "streaming reasoning" },
		]);
		const messages: AgentMessage[] = [assistant, interruptedThinkingContinuity()];
		const first = convertToLlm(messages);

		assistant.content.push({ type: "text", text: "final answer" });
		assistant.duration = 10;
		const second = convertToLlm(messages);
		const secondAssistant = second.find(message => message.role === "assistant");

		expect(second).not.toBe(first);
		expect(
			Array.isArray(secondAssistant?.content) &&
				secondAssistant.content.some(block => block.type === "text" && block.text === "final answer"),
		).toBe(true);
	});

	it("recomputes only the interrupted assistant when the continuity follower is inserted or removed", () => {
		const assistant = abortedAssistant([
			{ type: "text", text: "partial answer" },
			{ type: "thinking", thinking: "interrupted reasoning" },
		]);
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			attribution: "user",
			timestamp: 0,
		};
		const withoutFollower: AgentMessage[] = [user, assistant];
		const first = convertToLlm(withoutFollower);
		const firstAssistant = first.find(entry => entry.role === "assistant");
		expect(firstAssistant).toBeDefined();
		expect(Array.isArray(firstAssistant?.content) && firstAssistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);

		const withFollower: AgentMessage[] = [user, assistant, interruptedThinkingContinuity()];
		const second = convertToLlm(withFollower);
		const secondAssistant = second.find(entry => entry.role === "assistant");
		expect(secondAssistant).toBeDefined();
		expect(secondAssistant).not.toBe(firstAssistant);
		expect(Array.isArray(secondAssistant?.content) && secondAssistant.content.map(block => block.type)).toEqual([
			"text",
		]);
		// Unrelated user conversion stays identity-stable across the neighbor flip.
		expect(second.find(entry => entry.role === "user")).toBe(first.find(entry => entry.role === "user"));

		const third = convertToLlm(withoutFollower);
		const thirdAssistant = third.find(entry => entry.role === "assistant");
		expect(thirdAssistant).not.toBe(secondAssistant);
		expect(Array.isArray(thirdAssistant?.content) && thirdAssistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
	});

	it("uses carried neighbor state when the per-message cache changes during append conversion", () => {
		const target = abortedAssistant([
			{ type: "text", text: "partial answer" },
			{ type: "thinking", thinking: "interrupted reasoning" },
		]);
		let injectSeparateConversion = false;
		let roleReads = 0;
		let separateConversionRan = false;
		let assistant: AssistantMessage;
		assistant = new Proxy(target, {
			get(object, property, receiver) {
				if (property === "role") {
					roleReads++;
					if (injectSeparateConversion && roleReads === 2) {
						injectSeparateConversion = false;
						separateConversionRan = true;
						convertToLlm([assistant, interruptedThinkingContinuity()]);
					}
				}
				return Reflect.get(object, property, receiver);
			},
		});
		const messages: AgentMessage[] = [assistant];
		const first = convertToLlm(messages);

		messages.push(interruptedThinkingContinuity());
		roleReads = 0;
		injectSeparateConversion = true;
		const second = convertToLlm(messages);

		const firstAssistant = first.find(entry => entry.role === "assistant");
		const secondAssistant = second.find(entry => entry.role === "assistant");
		expect(separateConversionRan).toBe(true);
		expect(Array.isArray(firstAssistant?.content) && firstAssistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
		expect(Array.isArray(secondAssistant?.content) && secondAssistant.content.map(block => block.type)).toEqual([
			"text",
		]);
	});

	it("invalidates conversion cache when stripImagesFromMessage rewrites content in place", () => {
		const message: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: "aaaa", mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: 1,
		};
		const first = convertToLlm([message]);
		expect(first[0]).toBeDefined();
		expect(stripImagesFromMessage(message)).toBe(1);
		const second = convertToLlm([message]);
		expect(second[0]).not.toBe(first[0]);
		expect(Array.isArray(second[0]?.content) && second[0].content.map(b => b.type)).toEqual(["text"]);
	});

	it("invalidates token estimates when stripImagesFromMessage rewrites content in place", () => {
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [
				{ type: "text", text: "generated" },
				{ type: "image", data: "aaaa", mimeType: "image/png" },
				{ type: "image", data: "bbbb", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 1,
		};
		const before = estimateTokens(message);
		expect(before).toBe(estimateTokens(message)); // warm identity cache
		expect(stripImagesFromMessage(message)).toBe(2);
		const after = estimateTokens(message);
		expect(after).toBeLessThan(before);
		expect(after).toBe(estimateTokensUncached(message));
	});

	it("invalidates conversion cache for an explicit invalidateLlmConversion call", () => {
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "full tool body" }],
			isError: false,
			timestamp: 1,
		};
		const first = convertToLlm([message]);
		message.content = [{ type: "text", text: "[Old tool result content cleared]" }];
		invalidateLlmConversion(message);
		const second = convertToLlm([message]);
		expect(second[0]).not.toBe(first[0]);
		expect(
			Array.isArray(second[0]?.content) &&
				second[0].content[0] &&
				second[0].content[0].type === "text" &&
				second[0].content[0].text,
		).toBe("[Old tool result content cleared]");
	});
});

describe("replaceLlmImagesWithText", () => {
	it("replaces image blocks in user, developer, and tool-result messages with the placeholder", () => {
		const converted = convertToLlm([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "aaaa", mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "inspect_image",
				content: [{ type: "image", data: "bbbb", mimeType: "image/png" }],
				isError: false,
				timestamp: 2,
			},
		]);

		const scrubbed = replaceLlmImagesWithText(converted, "[image omitted]");

		expect(scrubbed).not.toBe(converted);
		const types = scrubbed.flatMap(m => (Array.isArray(m.content) ? m.content.map(b => b.type) : []));
		expect(types).not.toContain("image");
		const user = scrubbed.find(m => m.role === "user");
		expect(Array.isArray(user?.content) && user.content.map(b => (b.type === "text" ? b.text : b.type))).toEqual([
			"look",
			"[image omitted]",
		]);
		const toolResult = scrubbed.find(m => m.role === "toolResult");
		expect(Array.isArray(toolResult?.content) && toolResult.content).toEqual([
			{ type: "text", text: "[image omitted]" },
		]);
	});

	it("collapses consecutive image blocks into a single placeholder", () => {
		const converted = convertToLlm([
			{
				role: "user",
				content: [
					{ type: "image", data: "aaaa", mimeType: "image/png" },
					{ type: "image", data: "bbbb", mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: 1,
			},
		]);

		const scrubbed = replaceLlmImagesWithText(converted, "[image omitted]");
		const user = scrubbed.find(m => m.role === "user");
		expect(Array.isArray(user?.content) && user.content).toEqual([{ type: "text", text: "[image omitted]" }]);
	});

	it("returns the same array reference when there are no image blocks", () => {
		const converted = convertToLlm([
			{ role: "user", content: [{ type: "text", text: "hi" }], attribution: "user", timestamp: 1 },
		]);

		expect(replaceLlmImagesWithText(converted, "[image omitted]")).toBe(converted);
	});
});
