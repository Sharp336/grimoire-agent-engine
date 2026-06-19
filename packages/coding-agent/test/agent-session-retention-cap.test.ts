import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

// The retention cap (`compaction.toolResultCapKb`) mutates old tool-result text
// blocks in-place each turn, keeping the 3 most-recent results full. This test
// pins that contract: old oversized results are truncated to a notice while the
// keep-count window stays intact, and the cap is a no-op when set to 0.

const CAP_KB = 5; // 5 KB → 5120 bytes
const CAP_BYTES = CAP_KB * 1024;
const KEEP_COUNT = 3;

function makeToolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call_${Math.random().toString(36).slice(2)}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function makeAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A large payload well over the cap so truncation is unambiguous. */
function largePayload(label: string): string {
	return `${label}: ${"x".repeat(CAP_BYTES * 4)}`;
}

function toolResultText(msg: AgentMessage): string {
	if (msg.role !== "toolResult" || !Array.isArray(msg.content)) return "";
	const block = msg.content.find((b): b is { type: "text"; text: string } => b.type === "text");
	return block?.text ?? "";
}

function toolResultMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(m => m.role === "toolResult");
}

describe("AgentSession retention cap (compaction.toolResultCapKb)", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-retention-cap-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createSession(
		messages: AgentMessage[],
		settingsOverride: Record<string, unknown> = {},
	): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.toolResultCapKb": CAP_KB,
			"todo.enabled": false,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBash: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};

		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [mockBash], messages },
				convertToLlm,
				// Mock model returns a text-only assistant turn (no tool calls),
				// so the agent settles after one turn and #applyRetentionCap runs
				// during the agent_end maintenance path before prompt() resolves.
				streamFn: () => {
					const response = makeAssistant("done");
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: response });
						stream.push({ type: "done", reason: "stop", message: response });
					});
					return stream;
				},
			}),
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([[mockBash.name, mockBash]]),
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return session;
	}

	it("truncates old oversized tool results beyond the keep-count window", async () => {
		// 5 large tool results: the 3 most-recent stay full, the 2 oldest are capped.
		const messages: AgentMessage[] = [
			makeAssistant("a1"),
			makeToolResult(largePayload("old-1")),
			makeAssistant("a2"),
			makeToolResult(largePayload("old-2")),
			makeAssistant("a3"),
			makeToolResult(largePayload("recent-3")),
			makeAssistant("a4"),
			makeToolResult(largePayload("recent-4")),
			makeAssistant("a5"),
			makeToolResult(largePayload("recent-5")),
		];
		const session = await createSession(messages);

		// Drive a full turn; when prompt() resolves, the agent_end maintenance
		// path (including #applyRetentionCap) has completed.
		await session.prompt("continue");

		const result = toolResultMessages(session.agent.state.messages);
		expect(result.length).toBe(5);

		// Most-recent KEEP_COUNT (3) are untouched.
		const recent = result.slice(-KEEP_COUNT);
		for (const msg of recent) {
			const text = toolResultText(msg);
			expect(text.startsWith("recent-")).toBe(true);
			expect(text.length).toBeGreaterThan(CAP_BYTES);
		}

		// The 2 oldest are truncated to a notice shorter than the cap.
		const old = result.slice(0, -KEEP_COUNT);
		for (const msg of old) {
			const text = toolResultText(msg);
			expect(text.startsWith("[truncated —")).toBe(true);
			expect(text.length).toBeLessThan(CAP_BYTES);
		}
	});

	it("is a no-op when the cap is 0 (disabled)", async () => {
		const payload = largePayload("keep-me");
		const messages: AgentMessage[] = [
			makeAssistant("a1"),
			makeToolResult(payload),
			makeAssistant("a2"),
			makeToolResult(payload),
			makeAssistant("a3"),
			makeToolResult(payload),
			makeAssistant("a4"),
			makeToolResult(payload),
		];
		const session = await createSession(messages, { "compaction.toolResultCapKb": 0 });

		await session.prompt("continue");

		for (const msg of toolResultMessages(session.agent.state.messages)) {
			expect(toolResultText(msg)).toBe(payload);
		}
	});

	it("leaves tool results under the cap untouched even when old", async () => {
		const small = "small result";
		const messages: AgentMessage[] = [
			makeAssistant("a1"),
			makeToolResult(small),
			makeAssistant("a2"),
			makeToolResult(small),
			makeAssistant("a3"),
			makeToolResult(small),
			makeAssistant("a4"),
			makeToolResult(small),
		];
		const session = await createSession(messages);

		await session.prompt("continue");

		for (const msg of toolResultMessages(session.agent.state.messages)) {
			expect(toolResultText(msg)).toBe(small);
		}
	});
});
