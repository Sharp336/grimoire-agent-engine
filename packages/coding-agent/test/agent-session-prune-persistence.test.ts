import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Per-turn prune rewrites must stay aligned across the live provider context,
 * persisted branch, and provider-anchored token estimate. Compaction and reset
 * markers make the persisted branch larger than the live context, so these
 * tests exercise the public AgentSession behavior rather than the boundary
 * resolver in isolation.
 */
describe("AgentSession per-turn prune persistence and accounting", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	const BIG_CALL_ID = "call-big-useless";
	const usageZero = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prune-persistence-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": true,
				"compaction.supersedeReads": true,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	function appendPrunableResult(callId: string, timestamp: number): ToolResultMessage {
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "grep", arguments: { pattern: "TODO" } }],
			...apiInfo,
			stopReason: "toolUse",
			usage: usageZero,
			timestamp,
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20_000) }],
			isError: false,
			useless: true,
			timestamp: timestamp + 1,
		};
		sessionManager.appendMessage(result);
		return result;
	}

	function appendUsageAnchor(input: number, timestamp: number): AssistantMessage {
		const anchor: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Continuing." }],
			...apiInfo,
			stopReason: "stop",
			usage: { ...usageZero, input, output: 10, totalTokens: input + 10 },
			timestamp,
		};
		sessionManager.appendMessage(anchor);
		return anchor;
	}

	function syncActiveContext(): void {
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}

	async function runSettledMaintenance(timestamp: number): Promise<void> {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Maintenance boundary." }],
			...apiInfo,
			stopReason: "stop",
			usage: usageZero,
			timestamp,
		};
		// `agent_end` can use its settled-message fallback. Keeping this response
		// unpersisted leaves the seeded provider anchor and live tail deterministic.
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		await session.waitForIdle();
	}

	function resultText(message: ToolResultMessage): string {
		const text = message.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("Expected text content on the seeded tool result");
		return text.text;
	}

	function entryIdForMessage(message: ToolResultMessage): string {
		const entry = sessionManager
			.getBranch()
			.find(candidate => candidate.type === "message" && candidate.message === message);
		if (!entry) throw new Error("Expected the seeded tool result in the session branch");
		return entry.id;
	}

	function contextTokens(): number {
		const tokens = session.getContextUsage()?.tokens;
		if (tokens === undefined) throw new Error("Expected context usage");
		return tokens;
	}

	it("persists a live prune so a from-disk rebuild matches the active context", async () => {
		const now = Date.now();
		sessionManager.appendMessage({ role: "user", content: "Investigate the project.", timestamp: now });
		const result = appendPrunableResult(BIG_CALL_ID, now + 1);
		appendUsageAnchor(100, now + 3);
		syncActiveContext();

		await runSettledMaintenance(now + 4);

		expect(resultText(result)).toBe(USELESS_NOTICE);
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const rebuilt = reloaded
				.buildSessionContext()
				.messages.find(candidate => candidate.role === "toolResult" && candidate.toolCallId === BIG_CALL_ID);
			if (rebuilt?.role !== "toolResult" || !Array.isArray(rebuilt.content)) {
				throw new Error("Expected the seeded tool result in the from-disk rebuild");
			}
			const rebuiltText = rebuilt.content.find(block => block.type === "text");
			expect(rebuiltText?.type === "text" ? rebuiltText.text : undefined).toBe(USELESS_NOTICE);
		} finally {
			await reloaded.close();
		}
	});

	it("decreases provider-anchored context when an included result is pruned", async () => {
		const now = Date.now();
		sessionManager.appendMessage({ role: "user", content: "Investigate the project.", timestamp: now });
		const result = appendPrunableResult(BIG_CALL_ID, now + 1);
		const anchor = appendUsageAnchor(90_000, now + 3);
		syncActiveContext();
		expect(contextTokens()).toBe(90_000);

		await runSettledMaintenance(now + 4);

		expect(resultText(result)).toBe(USELESS_NOTICE);
		const recorded = anchor.contextSnapshot?.historyRewriteTokensRemoved;
		expect(recorded).toBeGreaterThan(0);
		expect(contextTokens()).toBe(90_000 - (recorded ?? 0));
	});

	it("counts a pruned live tail once without also reducing the provider anchor", async () => {
		const now = Date.now();
		sessionManager.appendMessage({ role: "user", content: "Investigate the project.", timestamp: now });
		const anchor = appendUsageAnchor(90_000, now + 1);
		const result = appendPrunableResult(BIG_CALL_ID, now + 2);
		syncActiveContext();
		const before = contextTokens();
		const resultTokensBefore = session.agent.tokenizer.countMessage(result);

		await runSettledMaintenance(now + 4);

		expect(resultText(result)).toBe(USELESS_NOTICE);
		const resultTokensAfter = session.agent.tokenizer.countMessage(result);
		expect(contextTokens()).toBe(before - (resultTokensBefore - resultTokensAfter));
		expect(anchor.contextSnapshot?.historyRewriteTokensRemoved).toBeUndefined();
	});

	it("prunes and credits only history after the latest reset boundary", async () => {
		const now = Date.now();
		const oldUserId = sessionManager.appendMessage({ role: "user", content: "Old cleared request.", timestamp: now });
		const cleared = appendPrunableResult(BIG_CALL_ID, now + 1);
		sessionManager.appendCompaction("old summary", undefined, oldUserId, 80_000);
		sessionManager.appendResetBoundary();
		sessionManager.appendMessage({ role: "user", content: "Fresh request.", timestamp: now + 3 });
		const live = appendPrunableResult("call-live", now + 4);
		const anchor = appendUsageAnchor(90_000, now + 6);
		syncActiveContext();

		await runSettledMaintenance(now + 7);

		expect(resultText(cleared)).not.toBe(USELESS_NOTICE);
		expect(cleared.prunedAt).toBeUndefined();
		expect(resultText(live)).toBe(USELESS_NOTICE);
		const recorded = anchor.contextSnapshot?.historyRewriteTokensRemoved;
		expect(recorded).toBeGreaterThan(0);
		expect(contextTokens()).toBe(90_000 - (recorded ?? 0));
	});

	it("prunes only the kept tail of a local compaction", async () => {
		const now = Date.now();
		sessionManager.appendMessage({ role: "user", content: "Old summarized request.", timestamp: now });
		const summarized = appendPrunableResult("call-summarized", now + 1);
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "Kept request.",
			timestamp: now + 3,
		});
		const kept = appendPrunableResult("call-kept", now + 4);
		sessionManager.appendCompaction("portable summary", undefined, firstKeptEntryId, 90_000);
		const anchor = appendUsageAnchor(90_000, now + 6);
		syncActiveContext();

		await runSettledMaintenance(now + 7);

		expect(resultText(summarized)).not.toBe(USELESS_NOTICE);
		expect(summarized.prunedAt).toBeUndefined();
		expect(resultText(kept)).toBe(USELESS_NOTICE);
		const recorded = anchor.contextSnapshot?.historyRewriteTokensRemoved;
		expect(recorded).toBeGreaterThan(0);
		expect(contextTokens()).toBe(90_000 - (recorded ?? 0));
	});

	it("preserves originals replaced by opaque remote compaction", async () => {
		const now = Date.now();
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "Investigate the project.",
			timestamp: now,
		});
		const result = appendPrunableResult(BIG_CALL_ID, now + 1);
		sessionManager.appendCompaction("remote summary", undefined, firstKeptEntryId, 90_000, {
			details: {},
			preserveData: {
				openaiRemoteCompaction: { provider: "openai", replacementHistory: [] },
			},
		});
		const anchor = appendUsageAnchor(90_000, now + 3);
		syncActiveContext();

		await runSettledMaintenance(now + 4);

		expect(resultText(result)).not.toBe(USELESS_NOTICE);
		expect(result.prunedAt).toBeUndefined();
		expect(contextTokens()).toBe(90_000);
		expect(anchor.contextSnapshot?.historyRewriteTokensRemoved).toBeUndefined();
	});

	it("fails closed when a local compaction keep id is missing", async () => {
		const now = Date.now();
		sessionManager.appendMessage({ role: "user", content: "Investigate the project.", timestamp: now });
		const result = appendPrunableResult(BIG_CALL_ID, now + 1);
		sessionManager.appendCompaction("portable summary", undefined, "missing-entry", 90_000);
		const anchor = appendUsageAnchor(90_000, now + 3);
		syncActiveContext();

		await runSettledMaintenance(now + 4);

		expect(resultText(result)).not.toBe(USELESS_NOTICE);
		expect(result.prunedAt).toBeUndefined();
		expect(anchor.contextSnapshot?.historyRewriteTokensRemoved).toBeUndefined();
	});

	it("fails closed when a remote replay id is missing", async () => {
		const now = Date.now();
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "Investigate the project.",
			timestamp: now,
		});
		const result = appendPrunableResult(BIG_CALL_ID, now + 1);
		sessionManager.appendCompaction("remote summary", undefined, firstKeptEntryId, 90_000, {
			details: {},
			providerReplayThroughEntryId: "missing-entry",
			preserveData: {
				openaiRemoteCompaction: { provider: "openai", replacementHistory: [] },
			},
		});
		const anchor = appendUsageAnchor(90_000, now + 3);
		syncActiveContext();

		await runSettledMaintenance(now + 4);

		expect(resultText(result)).not.toBe(USELESS_NOTICE);
		expect(result.prunedAt).toBeUndefined();
		expect(anchor.contextSnapshot?.historyRewriteTokensRemoved).toBeUndefined();
	});

	it("credits replayed post-snapshot history before a remote compaction entry", async () => {
		const now = Date.now();
		sessionManager.appendMessage({
			role: "user",
			content: "Snapshot request.",
			timestamp: now,
		});
		const covered = appendPrunableResult("call-covered", now + 1);
		const replayThroughEntryId = entryIdForMessage(covered);
		const result = appendPrunableResult(BIG_CALL_ID, now + 3);
		sessionManager.appendCompaction("remote summary", undefined, replayThroughEntryId, 90_000, {
			details: {},
			providerReplayThroughEntryId: replayThroughEntryId,
			preserveData: {
				openaiRemoteCompaction: { provider: "openai", replacementHistory: [] },
			},
		});
		const anchor = appendUsageAnchor(90_000, now + 5);
		syncActiveContext();

		await runSettledMaintenance(now + 6);

		expect(resultText(covered)).not.toBe(USELESS_NOTICE);
		expect(covered.prunedAt).toBeUndefined();
		expect(resultText(result)).toBe(USELESS_NOTICE);
		const recorded = anchor.contextSnapshot?.historyRewriteTokensRemoved;
		expect(recorded).toBeGreaterThan(0);
		expect(contextTokens()).toBe(90_000 - (recorded ?? 0));
	});
});
