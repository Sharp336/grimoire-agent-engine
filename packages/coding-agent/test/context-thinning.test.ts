import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";

import {
	DEFAULT_THINNING_CONFIG,
	THINNED_STUB_PREFIX,
	thinToolOutputs,
} from "../src/session/compaction/context-thinning";

// ============================================================================
// Helpers
// ============================================================================

function toolResult(toolName: string, text: string, opts?: { prunedAt?: number }): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
		toolName,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		...(opts?.prunedAt !== undefined ? { prunedAt: opts.prunedAt } : {}),
	} as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AgentMessage;
}

function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

// ============================================================================
// Tests
// ============================================================================

describe("thinToolOutputs", () => {
	it("returns unchanged when disabled", () => {
		const messages = [userMsg("hello"), assistantMsg("hi"), toolResult("bash", "x".repeat(10000))];
		const result = thinToolOutputs(messages, { enabled: false });
		expect(result.thinnedCount).toBe(0);
		expect(result.messages).toBe(messages); // same reference
	});

	it("returns unchanged for empty messages", () => {
		const result = thinToolOutputs([]);
		expect(result.thinnedCount).toBe(0);
		expect(result.messages).toEqual([]);
	});

	it("keeps all results when count <= keepRecent", () => {
		const messages = [
			userMsg("q"),
			assistantMsg("a"),
			toolResult("bash", "output1"),
			toolResult("bash", "output2"),
			toolResult("bash", "output3"),
		];
		const result = thinToolOutputs(messages, { keepRecent: 5 });
		expect(result.thinnedCount).toBe(0);
	});

	it("thins oldest tool results beyond keepRecent", () => {
		const largeOutput = "x".repeat(4000); // ~1000 tokens
		const messages = [
			userMsg("start"),
			assistantMsg("ok"),
			toolResult("bash", largeOutput), // oldest eligible - should be thinned
			toolResult("bash", largeOutput), // 2nd oldest - should be thinned
			toolResult("bash", "recent1"), // kept
			toolResult("bash", "recent2"), // kept
		];

		const result = thinToolOutputs(messages, { keepRecent: 2, thinnableTools: ["bash", "grep", "read", "skill"] });

		expect(result.thinnedCount).toBe(2);
		expect(result.estimatedTokensSaved).toBeGreaterThan(0);

		// Original messages not mutated
		const origTr = messages[2] as ToolResultMessage;
		expect(origTr.content[0]).toHaveProperty("text", largeOutput);

		// Thinned messages have stubs
		const thinnedTr = result.messages[2] as ToolResultMessage;
		expect(thinnedTr.content).toHaveLength(1);
		expect((thinnedTr.content[0] as { type: "text"; text: string }).text).toStartWith(THINNED_STUB_PREFIX);

		// Recent messages preserved
		const recentTr = result.messages[4] as ToolResultMessage;
		expect((recentTr.content[0] as { type: "text"; text: string }).text).toBe("recent1");
	});

	it("skips tools not on allowlist", () => {
		const messages = [
			toolResult("read", "file content".repeat(500)), // on allowlist
			toolResult("bash", "output".repeat(500)), // on allowlist
			toolResult("skill", "skill content".repeat(500)), // NOT on allowlist
			toolResult("bash", "recent"), // kept (keepRecent=1)
		];

		// Only bash and read are thinnable; skill is not on the list
		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "read"] });

		// read and first bash thinned, skill preserved, last bash kept by keepRecent
		expect(result.thinnedCount).toBe(2);

		// skill left intact
		const skillTr = result.messages[2] as ToolResultMessage;
		expect(skillTr.content[0]).toHaveProperty("text");
		expect((skillTr.content[0] as { text: string }).text).toContain("skill content");
	});

	it("skips already-pruned results", () => {
		const messages = [
			toolResult("bash", "[Output truncated - 5000 tokens]", { prunedAt: Date.now() - 60000 }),
			toolResult("bash", "recent output"),
		];

		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "grep", "read", "skill"] });
		expect(result.thinnedCount).toBe(0); // pruned one is skipped, only 1 eligible <= keepRecent
	});

	it("does not mutate original message objects", () => {
		const original = toolResult("bash", "x".repeat(2000));
		const originalContent = (original as ToolResultMessage).content;
		const messages = [original, toolResult("bash", "kept")];

		thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "grep", "read", "skill"] });

		// Original message content unchanged
		expect((messages[0] as ToolResultMessage).content).toBe(originalContent);
	});

	it("estimates token savings correctly", () => {
		// 4000 chars = ~1000 tokens, stub is ~12 tokens
		const text = "a".repeat(4000);
		const messages = [toolResult("grep", text), toolResult("grep", "kept")];

		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "grep", "read", "skill"] });
		// Original: 4000/4 = 1000 tokens. Stub: ~40 chars / 4 = ~10 tokens. Savings: ~990
		expect(result.estimatedTokensSaved).toBeGreaterThan(900);
		expect(result.estimatedTokensSaved).toBeLessThan(1100);
	});

	it("handles mixed message types correctly", () => {
		const messages: AgentMessage[] = [
			userMsg("query"),
			assistantMsg("thinking..."),
			toolResult("bash", "x".repeat(2000)),
			userMsg("follow up"),
			assistantMsg("more"),
			toolResult("grep", "y".repeat(2000)),
			toolResult("bash", "z".repeat(2000)),
			toolResult("bash", "recent"),
		];

		const result = thinToolOutputs(messages, { keepRecent: 2, thinnableTools: ["bash", "grep", "read", "skill"] });

		// 4 eligible results, keep 2 most recent -> thin 2
		expect(result.thinnedCount).toBe(2);

		// Non-tool messages untouched
		expect(result.messages[0]).toBe(messages[0]);
		expect(result.messages[1]).toBe(messages[1]);
		expect(result.messages[3]).toBe(messages[3]);
	});

	it("uses default config when no config provided", () => {
		// Need > DEFAULT_THINNING_CONFIG.keepRecent eligible results to see thinning.
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 12; i++) {
			messages.push(toolResult("bash", `output ${i}`.repeat(200)));
		}

		const result = thinToolOutputs(messages);
		expect(result.thinnedCount).toBe(12 - DEFAULT_THINNING_CONFIG.keepRecent);
	});

	it("skips tool results with empty content", () => {
		const emptyResult = {
			role: "toolResult" as const,
			toolCallId: "call_empty",
			toolName: "bash",
			content: [],
			isError: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		const messages = [emptyResult, toolResult("bash", "kept")];
		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "grep", "read", "skill"] });
		expect(result.thinnedCount).toBe(0);
	});
});
