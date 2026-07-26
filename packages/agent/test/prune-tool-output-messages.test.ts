import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_PRUNE_CONFIG, pruneToolOutputMessages } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { PruneConfig, PruneMessagesConfig } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, TextContent, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantReadCall(toolCallId: string, path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function readResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function messagePruningConfigTypeContract(messages: readonly AgentMessage[]): void {
	const supported: PruneMessagesConfig = { ...DEFAULT_PRUNE_CONFIG };
	pruneToolOutputMessages(messages, supported);

	const entryConfig: PruneConfig = DEFAULT_PRUNE_CONFIG;
	// @ts-expect-error Message-only pruning cannot resolve entry IDs.
	pruneToolOutputMessages(messages, entryConfig);
	// @ts-expect-error Message-only pruning must reject explicit entry boundaries.
	pruneToolOutputMessages(messages, { ...DEFAULT_PRUNE_CONFIG, keepBoundaryId: "entry-id" });
}

void messagePruningConfigTypeContract;

describe("pruneToolOutputMessages", () => {
	it("returns pruned copies without mutating input messages and honors conditional protection", () => {
		const skillResult = Object.freeze(readResult("skill-read", "protected skill output ".repeat(40)));
		const fileResult = Object.freeze(readResult("file-read", "prunable file output ".repeat(40)));
		const messages: readonly AgentMessage[] = Object.freeze([
			assistantReadCall("skill-read", "skill://session-memory"),
			skillResult,
			assistantReadCall("file-read", "packages/agent/src/index.ts"),
			fileResult,
		]);

		const result = pruneToolOutputMessages(messages, {
			...DEFAULT_PRUNE_CONFIG,
			protectTokens: 0,
			minimumSavings: 0,
		});

		expect(result.prunedCount).toBe(1);
		expect(result.messages).not.toBe(messages);
		expect(result.messages[1]).toBe(skillResult);
		expect(result.messages[3]).not.toBe(fileResult);
		expect(((result.messages[3] as ToolResultMessage).content[0] as TextContent).text).toStartWith(
			"[Output truncated - ",
		);
		expect((result.messages[3] as ToolResultMessage).prunedAt).toBeNumber();
		expect((fileResult.content[0] as TextContent).text).toStartWith("prunable file output");
		expect(fileResult.prunedAt).toBeUndefined();
	});
});
