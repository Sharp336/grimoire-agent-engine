import { describe, expect, test } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction, type SessionEntry } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createAssistantMessage, createUserMessage } from "./helpers";

let sequence = 0;

function entry(message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id: `message-${sequence++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

describe("prepareCompaction provider calibration", () => {
	test("a caller-declared fixed prompt prefix does not shrink the recent-history cut", () => {
		const tokenizer = new Tokenizer();
		const entries: SessionEntry[] = [
			entry(createUserMessage(`first request ${"alpha ".repeat(600)}`)),
			entry(createAssistantMessage([{ type: "text", text: `first answer ${"beta ".repeat(600)}` }])),
			entry(createUserMessage(`second request ${"gamma ".repeat(600)}`)),
			entry(createAssistantMessage([{ type: "text", text: `second answer ${"delta ".repeat(600)}` }])),
			entry(createUserMessage(`third request ${"epsilon ".repeat(600)}`)),
			entry(createAssistantMessage([{ type: "text", text: `third answer ${"zeta ".repeat(600)}` }])),
		];
		const messages = entries.flatMap(candidate => (candidate.type === "message" ? [candidate.message] : []));
		const branchTokens = tokenizer.countMessages(messages);
		const keepRecentTokens = tokenizer.countMessages(messages.slice(-4));
		const last = messages.at(-1);
		if (last?.role !== "assistant") throw new Error("Expected an assistant tail");
		const lastAssistant: AssistantMessage = last;
		const setPromptTokens = (tokens: number) => {
			lastAssistant.usage = {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		};
		const prepare = (fixedPrefixTokens?: number) =>
			prepareCompaction(
				entries,
				{ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens },
				undefined,
				tokenizer,
				fixedPrefixTokens === undefined ? undefined : { fixedPrefixTokens },
			);

		setPromptTokens(branchTokens);
		const baseline = prepare();
		const fixedPrefixTokens = 100_000;
		setPromptTokens(branchTokens + fixedPrefixTokens);
		const calibrated = prepare(fixedPrefixTokens);
		const uncalibrated = prepare();

		expect(calibrated?.firstKeptEntryId).toBe(baseline?.firstKeptEntryId);
		expect(calibrated?.recentMessages.length).toBe(baseline?.recentMessages.length);
		expect(uncalibrated?.recentMessages.length).toBeLessThan(calibrated?.recentMessages.length ?? 0);
	});
});
