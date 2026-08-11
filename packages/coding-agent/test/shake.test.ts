import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import {
	type AfterToolCallContext,
	Agent,
	type AgentMessage,
	type AgentTool,
	RESCUE_SHAKE_CONFIG,
} from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { DEFAULT_SHAKE_CONFIG } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 16,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentSession shake", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shake-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
		});
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	/** Seed a user → assistant(toolCall) → toolResult turn carrying a heavy bash result. */
	function seedHeavyToolResult(text: string, toolName = "bash"): void {
		const toolCallId = `call_${toolName}_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "do it" }],
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: { command: "ls" } },
			],
			...apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now() - 1,
		});
	}

	function branchToolResults(): ToolResultMessage[] {
		return sessionManager
			.getBranch()
			.filter(e => e.type === "message" && (e.message as { role?: string }).role === "toolResult")
			.map(e => (e as { message: ToolResultMessage }).message);
	}

	describe("elide", () => {
		it("drops the tool result, offloads to an artifact, and embeds the recovery link", async () => {
			seedHeavyToolResult("X".repeat(4000));
			const replaceSpy = vi.spyOn(session.agent, "replaceMessages");

			const result = await session.shake("elide");

			expect(result.mode).toBe("elide");
			expect(result.toolResultsDropped).toBe(1);
			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(result.artifactId).toBeDefined();
			expect(replaceSpy).toHaveBeenCalled();

			const [tr] = branchToolResults();
			expect(tr.prunedAt).toBeGreaterThan(0);
			const text = tr.content.map(b => (b.type === "text" ? b.text : "")).join("");
			expect(text).toContain(`artifact://${result.artifactId}`);
			expect(text).toContain("shaken");
		});

		it("updates provider-anchored context usage immediately after rewriting prompt history", async () => {
			seedHeavyToolResult("X".repeat(20_000));
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 20_000, totalTokens: 20_008 },
				timestamp: Date.now(),
			});
			session.agent.replaceMessages(
				sessionManager
					.getBranch()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message as AgentMessage),
			);
			const before = session.getContextUsage()?.tokens;
			expect(before).toBe(20_000);

			const result = await session.shake("elide");

			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(session.getContextUsage()?.tokens).toBe(20_000 - result.tokensFreed);
			const anchor = sessionManager
				.getBranch()
				.findLast(
					entry =>
						entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop",
				);
			expect(
				anchor?.type === "message" && anchor.message.role === "assistant"
					? anchor.message.contextSnapshot?.historyRewriteTokensRemoved
					: undefined,
			).toBe(result.tokensFreed);
		});

		it("skips response-only usage when selecting the correction anchor", async () => {
			seedHeavyToolResult("X".repeat(20_000));
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "anchored" }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 20_000, totalTokens: 20_008 },
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "response-only" }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 0, output: 8, totalTokens: 8 },
				timestamp: Date.now() + 1,
			});
			session.agent.replaceMessages(
				sessionManager
					.getBranch()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message as AgentMessage),
			);
			const before = session.getContextUsage()?.tokens;
			expect(before).toBeDefined();

			const result = await session.shake("elide");

			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(session.getContextUsage()?.tokens).toBe(before! - result.tokensFreed);
			const assistants = sessionManager
				.getBranch()
				.filter(entry => entry.type === "message" && entry.message.role === "assistant");
			const usableAnchor = assistants.at(-2);
			const responseOnly = assistants.at(-1);
			expect(
				usableAnchor?.type === "message" && usableAnchor.message.role === "assistant"
					? usableAnchor.message.contextSnapshot?.historyRewriteTokensRemoved
					: undefined,
			).toBe(result.tokensFreed);
			expect(
				responseOnly?.type === "message" && responseOnly.message.role === "assistant"
					? responseOnly.message.contextSnapshot?.historyRewriteTokensRemoved
					: undefined,
			).toBeUndefined();
		});

		it("does not subtract remote-compacted entries omitted from the provider prompt", async () => {
			seedHeavyToolResult("X".repeat(20_000));
			const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
			if (!firstKeptEntryId) throw new Error("Expected seeded branch");
			sessionManager.appendCompaction("remote summary", undefined, firstKeptEntryId, 10_000, {}, false, {
				openaiRemoteCompaction: {
					provider: "openai",
					replacementHistory: [],
				},
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "post-compaction" }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 20_000, totalTokens: 20_008 },
				timestamp: Date.now(),
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			expect(session.getContextUsage()?.tokens).toBe(20_000);

			const result = await session.shake("elide");

			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(session.getContextUsage()?.tokens).toBe(20_000);
			const anchor = sessionManager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			expect(
				anchor?.type === "message" && anchor.message.role === "assistant"
					? anchor.message.contextSnapshot?.historyRewriteTokensRemoved
					: undefined,
			).toBeUndefined();
		});

		it("returns zero counts for an empty branch", async () => {
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
			expect(result.blocksDropped).toBe(0);
			expect(result.tokensFreed).toBe(0);
		});
	});

	describe("images", () => {
		it("mirrors dropImages and reports the removed image count", async () => {
			const png: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "look" }, png],
				timestamp: Date.now(),
			});

			const result = await session.shake("images");

			expect(result.mode).toBe("images");
			expect(result.imagesDropped).toBe(1);
			const branch = sessionManager.getBranch();
			const userMsg = branch.find(e => e.type === "message" && (e.message as { role?: string }).role === "user");
			const content = (userMsg as { message: { content: unknown } }).message.content as Array<{ type: string }>;
			expect(content.some(b => b.type === "image")).toBe(false);
		});
	});

	describe("protected tools", () => {
		it("never shakes skill results", async () => {
			seedHeavyToolResult("S".repeat(4000), "skill");
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
		});

		/** Seed a user → assistant(read toolCall) → toolResult turn recovering an artifact. */
		function seedArtifactRecoveryResult(text: string, args: Record<string, unknown>, details?: unknown): void {
			const toolCallId = `call_read_${Math.random().toString(36).slice(2)}`;
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "recover it" }],
				timestamp: Date.now() - 3,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [
					{ type: "text", text: "recovering" },
					{ type: "toolCall", id: toolCallId, name: "read", arguments: args },
				],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: Date.now() - 2,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text }],
				...(details === undefined ? {} : { details }),
				isError: false,
				timestamp: Date.now() - 1,
			});
		}

		it("rescue config never re-elides artifact recovery reads, by path or by source meta", async () => {
			seedArtifactRecoveryResult("R".repeat(4000), { path: "artifact://0" });
			seedArtifactRecoveryResult(
				"F".repeat(4000),
				{ path: "/tmp/artifacts/3.shake.log" },
				{
					meta: { source: { type: "internal", value: "artifact://3" } },
				},
			);
			const result = await session.shake("elide", { config: RESCUE_SHAKE_CONFIG });
			expect(result.toolResultsDropped).toBe(0);
			const texts = branchToolResults().map(m => (m.content[0] as { text: string }).text);
			expect(texts.some(t => t.startsWith("R"))).toBe(true);
			expect(texts.some(t => t.startsWith("F"))).toBe(true);
		});

		it("rescue config still elides ordinary oversized results", async () => {
			seedHeavyToolResult("B".repeat(4000));
			seedArtifactRecoveryResult("R".repeat(4000), { path: "artifact://0" });
			const result = await session.shake("elide", { config: RESCUE_SHAKE_CONFIG });
			expect(result.toolResultsDropped).toBe(1);
			const texts = branchToolResults().map(m => (m.content[0] as { text: string }).text);
			expect(texts.some(t => t.startsWith("B"))).toBe(false);
			expect(texts.some(t => t.startsWith("R"))).toBe(true);
		});
	});

	describe("auto-shake strategy", () => {
		it("dispatches the elide path and emits a shake action for threshold maintenance", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			// Reclaim enough that the corrected (provider − tokensFreed) figure lands
			// inside the 80% recovery band — otherwise the #2275 post-shake check would
			// (correctly) declare pressure unresolved and fall back to context-full.
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10_000 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(20);

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.anything());
			const start = events.filter(e => e.type === "auto_compaction_start");
			expect(start).toHaveLength(1);
			expect(start[0]).toMatchObject({ type: "auto_compaction_start", reason: "threshold", action: "shake" });
			const end = events.filter(e => e.type === "auto_compaction_end");
			expect(end).toHaveLength(1);
			expect(end[0]).toMatchObject({ type: "auto_compaction_end", action: "shake" });
		});

		it("keeps a successful overflow shake recovery committed before retrying", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("contextPromotion.enabled", false);
			seedHeavyToolResult("X ".repeat(20000));
			branchToolResults()[0].useless = true;
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				...apiInfo,
				stopReason: "error",
				errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
				usage: {
					input: 250_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 250_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.action === "shake") onCompactionDone();
			});
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await compactionDone;
			await session.waitForIdle();

			const shakeEnd = events.find(event => event.type === "auto_compaction_end" && event.action === "shake");
			expect(shakeEnd).toMatchObject({ type: "auto_compaction_end", action: "shake", willRetry: true });
			expect(sessionManager.getBranch()).not.toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "error",
						errorMessage: assistantMessage.errorMessage,
					}),
				}),
			);
			expect(session.agent.state.messages).not.toContainEqual(
				expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMessage.errorMessage,
				}),
			);
		});

		it("keeps a no-op incomplete shake retry committed before rollback can restore the length tail", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("contextPromotion.enabled", false);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "partial response" }],
				...apiInfo,
				stopReason: "length",
				usage: {
					input: 20_000,
					output: 5_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 25_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.action === "shake") onCompactionDone();
			});
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await compactionDone;
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			const shakeEnd = events.find(event => event.type === "auto_compaction_end" && event.action === "shake");
			expect(shakeEnd).toMatchObject({ type: "auto_compaction_end", action: "shake", willRetry: true });
			expect(sessionManager.getBranch()).not.toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "length",
						timestamp: assistantMessage.timestamp,
					}),
				}),
			);
			expect(session.agent.state.messages).not.toContainEqual(
				expect.objectContaining({
					role: "assistant",
					stopReason: "length",
					timestamp: assistantMessage.timestamp,
				}),
			);
		});

		it("has isCompacting true when the shake auto_compaction_start event fires", async () => {
			// Defect 1 parity for the shake strategy: the controller backing isCompacting
			// must be installed before auto_compaction_start is emitted, so a message
			// typed as the loader appears is queued safely rather than mis-routed.
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			let capturedIsCompacting: boolean | undefined;
			const { promise: shakeStarted, resolve: onShakeStarted } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_start" && event.action === "shake") {
					capturedIsCompacting = session.isCompacting;
					onShakeStarted();
				}
			});

			vi.spyOn(session, "shake").mockResolvedValue({
				mode: "elide",
				toolResultsDropped: 1,
				blocksDropped: 0,
				tokensFreed: 10_000,
			});

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await shakeStarted;

			expect(capturedIsCompacting).toBe(true);
		});

		it("falls back to context-full when shake cannot drop context below the threshold (regression #2119)", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			// Seed agent state so the post-shake estimate is well above the 1% threshold
			// (~2K tokens for a 200K window). The mocked shake returns reclaimed=true but
			// does not modify state, mimicking the dead-loop scenario where shake removes
			// nothing material yet the threshold check stays positive.
			session.agent.replaceMessages([
				{
					role: "user",
					content: [{ type: "text", text: "x".repeat(40000) }],
					timestamp: Date.now(),
				} as never,
			]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			// Shake fires once. The pre-fix bug auto-continued, which would re-trigger shake
			// on the next agent_end. The fix replaces that loop with a one-shot fallback.
			expect(shakeSpy).toHaveBeenCalledTimes(1);

			const shakeEnd = events.find(
				e => e.type === "auto_compaction_end" && (e as { action?: string }).action === "shake",
			) as { errorMessage?: string; skipped?: boolean } | undefined;
			expect(shakeEnd).toBeDefined();
			expect(shakeEnd?.errorMessage).toMatch(/falling back to context-full/i);

			// Fallback enters the context-full path so the situation actually resolves.
			const fullStart = events.find(
				e => e.type === "auto_compaction_start" && (e as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});

		it("falls back when provider-reported usage stays above the threshold even though the local estimate is below it (regression #2275)", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 5_000);
			session.settings.set("contextPromotion.enabled", false);

			// Agent state holds almost no content, so #estimatePendingPromptTokens reads
			// well below the 5K threshold. The pre-fix post-shake check trusted that
			// estimate and treated the pressure as resolved, even though the assistant
			// message's provider-reported usage (11K) was well above the threshold.
			// This is the metric-divergence dead loop from #2275: thinking-heavy
			// sessions hit it for real (thinkingSignature payloads aren't counted by
			// the estimator), and an empty-state probe mimics it deterministically.
			session.agent.replaceMessages([]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			expect(shakeSpy).toHaveBeenCalledTimes(1);

			const shakeEnd = events.find(
				e => e.type === "auto_compaction_end" && (e as { action?: string }).action === "shake",
			) as { errorMessage?: string; skipped?: boolean } | undefined;
			expect(shakeEnd).toBeDefined();
			expect(shakeEnd?.errorMessage).toMatch(/falling back to context-full/i);

			const fullStart = events.find(
				e => e.type === "auto_compaction_start" && (e as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});

		it("counts pre-shake prune savings when deciding whether to fall back to context-full", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 76384);
			session.settings.set("compaction.thresholdPercent", -1);
			session.settings.set("compaction.dropUseless", true);
			session.settings.set("contextPromotion.enabled", false);

			const now = Date.now();
			sessionManager.appendMessage({
				role: "user",
				content: "Investigate every module of the project.",
				timestamp: now - 200,
			});
			const bigCallId = "call-big-useless-for-shake";
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: now - 180,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: bigCallId,
				toolName: "grep",
				content: [{ type: "text", text: "match line\n".repeat(20000) }],
				isError: false,
				useless: true,
				timestamp: now - 170,
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 100 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 5000,
					output: 1000,
					cacheRead: 85000,
					cacheWrite: 0,
					totalTokens: 91000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: now,
			};

			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && (event as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeUndefined();
		});

		it("falls back after pre-prompt shake when the floored stored conversation remains over threshold", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 8_000);
			session.settings.set("compaction.keepRecentTokens", 1);
			session.settings.set("contextPromotion.enabled", false);

			const seedUser: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "seed" }],
				timestamp: Date.now() - 2,
			};
			const bulkText = "alpha beta gamma delta epsilon ".repeat(3_000);
			const seedAssistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: bulkText }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_010,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - 1,
			};
			sessionManager.appendMessage(seedUser);
			sessionManager.appendMessage(seedAssistant);
			session.agent.replaceMessages([seedUser, seedAssistant]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "pre-prompt shake fallback compacted",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

			expect(session.getContextUsage({ contextWindow: 200_000 })?.tokens).toBe(1_000);

			await session.prompt("small pending prompt", { skipCompactionCheck: true });

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(compactSpy).toHaveBeenCalled();
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && (event as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});
	});

	describe("periodic shake interval", () => {
		let toolCallCounter = 0;
		const harnessSessions: AgentSession[] = [];

		/** Bump the periodic shake counter by invoking afterToolCall with a minimal fixture. */
		function bumpToolCallCounter(): void {
			const ctx: AfterToolCallContext = {
				assistantMessage: {
					role: "assistant" as const,
					content: [{ type: "text", text: "" }],
					...apiInfo,
					stopReason: "stop",
					usage,
					timestamp: Date.now(),
				},
				toolCall: { type: "toolCall" as const, id: `tc_${toolCallCounter++}`, name: "bash", arguments: {} },
				args: {},
				result: { content: [{ type: "text", text: "" }] },
				isError: false,
				context: { systemPrompt: [], messages: [] },
			};
			session.agent.afterToolCall!(ctx);
		}

		/** Minimal assistant message fixture for emitEnd helper. */
		function makeAssistantMessage(text = "response"): AssistantMessage {
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: Date.now(),
			};
		}
		/** Emit message_end + agent_end for a given message (external-event path). */
		function emitEnd(msg: AssistantMessage): void {
			session.agent.emitExternalEvent({ type: "message_end", message: msg });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
		}

		afterEach(async () => {
			toolCallCounter = 0;
			for (const harnessSession of harnessSessions) await harnessSession.dispose();
			harnessSessions.length = 0;
		});

		// Real-loop harness: session.prompt() drives a scripted mock provider so
		// the awaited onTurnEnd hook fires against the live loop array — the only
		// path that can splice rebuilt messages into the running prompt context.
		// Synthetic external turn_end events (emitExternalEvent) never reach the
		// awaited hook (agent.ts #emit is fire-and-forget), so the mid-run shake
		// contract is exercised through real loops below; agent_end-only paths
		// (disabled interval, no-turn_end fallback) still use external events.
		// ≈10k tokens: clears DEFAULT_SHAKE_CONFIG minSavings; `useless` results
		// bypass the shake's protect-recent window, so a single heavy result is
		// elidable even as the newest entry.
		const HEAVY_USELESS_RESULT = "U".repeat(40_000);
		type ScriptedTurn = {
			text?: string;
			stopReason?: "stop" | "toolUse" | "length" | "error";
			errorMessage?: string;
			usage?: typeof usage;
			toolCalls?: number;
		};
		function createPeriodicHarness(settings: Record<string, unknown> = {}) {
			const callContexts: AgentMessage[][] = [];
			const scripted: ScriptedTurn[] = [];
			let resultText = "";
			let resultUseless = false;

			const mockBash: AgentTool = {
				name: "bash",
				label: "Bash",
				description: "Mock bash tool",
				parameters: type({}),
				execute: async () => ({
					content: [{ type: "text" as const, text: resultText }],
					...(resultUseless ? { useless: true } : {}),
				}),
			};

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model to exist");

			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [mockBash], messages: [] },
				convertToLlm,
				streamFn: (_model, context) => {
					callContexts.push(context.messages.map(message => message));
					const turn = scripted.shift() ?? { stopReason: "stop", text: "done" };
					const message: AssistantMessage = {
						role: "assistant",
						content: [
							...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
							...Array.from({ length: turn.toolCalls ?? 0 }, (_, index) => ({
								type: "toolCall" as const,
								id: `call_${toolCallCounter++}_${index}`,
								name: "bash",
								arguments: { command: "ls" },
							})),
						],
						...apiInfo,
						stopReason: turn.stopReason ?? "stop",
						...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
						usage: turn.usage ?? usage,
						timestamp: Date.now(),
					};
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						if (message.stopReason === "error") {
							stream.push({ type: "error", reason: "error", error: message });
						} else {
							stream.push({ type: "start", partial: message });
							stream.push({
								type: "done",
								reason:
									message.stopReason === "length"
										? "length"
										: message.stopReason === "toolUse"
											? "toolUse"
											: "stop",
								message,
							});
						}
					});
					return stream;
				},
			});

			const harnessSession = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({
					"compaction.enabled": true,
					"compaction.autoContinue": false,
					...settings,
				}),
				modelRegistry,
			});
			harnessSessions.push(harnessSession);

			return {
				session: harnessSession,
				callContexts,
				scripted,
				/** Configure the mock bash tool's result for the next prompt. */
				setResult: (text: string, useless = false) => {
					resultText = text;
					resultUseless = useless;
				},
			};
		}

		/** Let the fire-and-forget agent_end listener settle its shake pass. */
		async function settle(target: AgentSession): Promise<void> {
			await target.agent.waitForIdle();
			await Bun.sleep(30);
		}

		function toolResultText(message: AgentMessage | undefined): string {
			if (message?.role !== "toolResult") return "";
			return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
		}

		it("disabled interval resets pending counter so re-enabling starts fresh", async () => {
			session.settings.set("compaction.strategy", "off");
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 1_000 });

			// Bump counter then disable
			bumpToolCallCounter();
			session.settings.set("shake.interval", 0);
			emitEnd(makeAssistantMessage());
			await Bun.sleep(30);

			expect(shakeSpy).not.toHaveBeenCalled();

			// Re-enable and emit another end without a new tool call
			session.settings.set("shake.interval", 1);
			emitEnd(makeAssistantMessage("again"));
			await Bun.sleep(30);

			// Still no call — counter (and the pending mid-run flag) were reset
			expect(shakeSpy).not.toHaveBeenCalled();
		});

		it("fires at interval boundary, syncs at agent_end, and does not re-fire after reset", async () => {
			const { session, scripted, setResult } = createPeriodicHarness({
				"compaction.strategy": "off",
				"shake.interval": 2,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			setResult("ok");
			// Two tool calls (counter 1, then 2 ≥ interval), then a terminal turn
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			scripted.push({ stopReason: "stop", text: "done" });
			await session.prompt("do it");
			await settle(session);

			// Shakes twice: once mid-run at the turn_end hook, once at agent_end (sync).
			expect(shakeSpy).toHaveBeenCalledTimes(2);
			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.objectContaining({ config: DEFAULT_SHAKE_CONFIG }));

			// Second prompt with no tool calls — counter was reset, no third fire
			scripted.push({ stopReason: "stop", text: "again" });
			await session.prompt("again");
			await settle(session);
			expect(shakeSpy).toHaveBeenCalledTimes(2);
		});

		it("fires once after multiple tool calls in one autonomous turn", async () => {
			const { session, scripted, setResult } = createPeriodicHarness({
				"compaction.strategy": "off",
				"shake.interval": 3,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			setResult("ok");
			// Three tool calls in a single assistant turn — the third reaches interval
			scripted.push({ stopReason: "toolUse", toolCalls: 3 });
			scripted.push({ stopReason: "stop", text: "done" });
			await session.prompt("do it");
			await settle(session);

			// Shakes twice: once mid-run (skipAgentUpdate) and once at agent_end (sync state).
			expect(shakeSpy).toHaveBeenCalledTimes(2);
		});

		it("fires mid-run and syncs agent state at agent_end", async () => {
			const { session, scripted, setResult } = createPeriodicHarness({
				"compaction.strategy": "off",
				"shake.interval": 1,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			setResult("ok");
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			scripted.push({ stopReason: "stop", text: "done" });
			await session.prompt("do it");
			await settle(session);

			// Mid-run shake at the turn_end hook + agent_end sync shake
			expect(shakeSpy).toHaveBeenCalledTimes(2);
		});

		it("splices rebuilt messages into the live loop array before the next model call", async () => {
			const { session, callContexts, scripted, setResult } = createPeriodicHarness({
				"compaction.strategy": "off",
				"shake.interval": 1,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			// Heavy + contextually-useless result: useless results bypass the
			// shake's protect-recent window, so the turn_end hook shake elides it.
			setResult(HEAVY_USELESS_RESULT, true);
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			scripted.push({ stopReason: "stop", text: "done" });
			await session.prompt("do it");
			await settle(session);

			expect(shakeSpy).toHaveBeenCalledTimes(2);

			// The second provider call runs after the hook: the live loop array
			// must already carry the rebuilt (shaken) tool result, not the raw
			// heavy payload — rewriting persisted history alone would not shrink
			// the live prompt in a tool-heavy run.
			const secondContext = callContexts[1];
			expect(secondContext).toBeDefined();
			const text = toolResultText(secondContext.find(message => message.role === "toolResult"));
			expect(text).toContain("artifact://");
			expect(text).toContain("shaken");
			expect(text).not.toContain(HEAVY_USELESS_RESULT.slice(0, 200));
		});

		it("skips periodic shake when compaction continuation owns the next turn", async () => {
			const { session, scripted, setResult } = createPeriodicHarness({
				"compaction.strategy": "handoff",
				"compaction.thresholdPercent": 1,
				"contextPromotion.enabled": false,
				"shake.interval": 1,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			setResult("ok");
			// Mid-run: counter reaches interval, the turn_end hook fires mid-run shake
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			// High-usage terminal turn triggers threshold compaction at agent_end
			scripted.push({
				stopReason: "stop",
				text: "trigger",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await session.prompt("do it");
			await settle(session);

			// Agent_end: the handoff continuation guard prevents the sync shake.
			// Total remains 1 (only the mid-run call).
			expect(shakeSpy).toHaveBeenCalledTimes(1);
		});

		it("skips periodic shake when overflow leaves a pruned tail (no recovery path)", async () => {
			const { session, scripted, setResult } = createPeriodicHarness({
				"contextPromotion.enabled": false,
				"compaction.strategy": "off",
				"shake.interval": 1,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			setResult("ok");
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			// Overflow terminal turn: error stop with a context-overflow message
			scripted.push({ stopReason: "error", errorMessage: "prompt is too long", text: "" });
			await session.prompt("do it");
			await settle(session);

			// Agent_end: the tailPruned guard prevents the sync shake.
			// Total remains 1 (only the mid-run call).
			expect(shakeSpy).toHaveBeenCalledTimes(1);
		});

		it("skips periodic shake when length-stop leaves a pruned tail (no recovery path)", async () => {
			const { session, scripted, setResult } = createPeriodicHarness({
				"contextPromotion.enabled": false,
				"compaction.strategy": "off",
				"shake.interval": 1,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			setResult("ok");
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			scripted.push({ stopReason: "length", text: "" });
			await session.prompt("do it");
			await settle(session);

			// Agent_end: the tailPruned guard prevents the sync shake.
			// Total remains 1 (only the mid-run call).
			expect(shakeSpy).toHaveBeenCalledTimes(1);
		});

		it("tailPruned consumes the pending sync so the pruned assistant is not reintroduced", async () => {
			const { session, scripted, setResult } = createPeriodicHarness({
				"contextPromotion.enabled": false,
				"compaction.strategy": "off",
				"shake.interval": 1,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			setResult("ok");
			// Mid-run: the turn_end hook shake fires and sets #shakeNeedsAgentSync
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			// Overflow terminal turn: agent_end tailPrunes and must consume the
			// pending sync — otherwise the next normal agent_end rebuilds
			// agent.state from the branch and reintroduces the pruned assistant.
			scripted.push({ stopReason: "error", errorMessage: "prompt is too long", text: "" });
			await session.prompt("do it");
			await settle(session);
			expect(shakeSpy).toHaveBeenCalledTimes(1);

			// A normal follow-up prompt must NOT trigger a stale sync shake
			scripted.push({ stopReason: "stop", text: "again" });
			await session.prompt("again");
			await settle(session);
			expect(shakeSpy).toHaveBeenCalledTimes(1);
		});

		it("bails the mid-run shake when turn persistence is out of order", async () => {
			const { session, callContexts, scripted, setResult } = createPeriodicHarness({
				"compaction.strategy": "off",
				"shake.interval": 1,
			});
			const shakeSpy = vi.spyOn(session, "shake");

			// Drop the tool-calling assistant message from the branch while its
			// tool result persists — planTurnPersistence reports out-of-order, so
			// the mid-run shake must bail: shake() would read an unsafe branch and
			// the splice could remove the turn the next model call must see.
			let skippedAssistantAppends = 0;
			const originalAppend = sessionManager.appendMessage.bind(sessionManager);
			const appendSpy = vi.spyOn(sessionManager, "appendMessage");
			appendSpy.mockImplementation(message => {
				const anyMessage = message as { role?: string; content?: { type?: string }[] };
				if (anyMessage.role === "assistant" && anyMessage.content?.some(block => block.type === "toolCall")) {
					skippedAssistantAppends++;
					return "skipped";
				}
				return originalAppend(message);
			});

			setResult("RESULT_TEXT_MARKER");
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			scripted.push({ stopReason: "stop", text: "done" });
			await session.prompt("do it");
			await settle(session);

			expect(skippedAssistantAppends).toBe(1);
			// Mid-run shake bailed (out-of-order persistence); only the agent_end
			// sync shake fired, once persistence settled.
			expect(shakeSpy).toHaveBeenCalledTimes(1);

			// The live loop array was not spliced: the next model call still sees
			// the full assistant turn with its raw tool result.
			const secondContext = callContexts[1];
			expect(secondContext.some(message => message.role === "assistant")).toBe(true);
			expect(toolResultText(secondContext.find(message => message.role === "toolResult"))).toContain(
				"RESULT_TEXT_MARKER",
			);
		});

		it("mid-run shake requires the awaited turn-end hook; agent_end still fires the counter fallback", async () => {
			session.settings.set("compaction.strategy", "off");
			session.settings.set("shake.interval", 1);
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 1_000 });

			// Counter crossed but no turn_end hook fires (external events bypass
			// the awaited onTurnEnd hook) — no mid-run shake.
			bumpToolCallCounter();
			await Bun.sleep(10);
			expect(shakeSpy).not.toHaveBeenCalled();

			// Agent_end still fires via the counter (>= interval) and clears the
			// pending mid-run flag so the next turn does not shake.
			emitEnd(makeAssistantMessage());
			await Bun.sleep(30);
			expect(shakeSpy).toHaveBeenCalledTimes(1);

			// Another end without tool calls — counter was reset, no re-fire
			emitEnd(makeAssistantMessage("again"));
			await Bun.sleep(30);
			expect(shakeSpy).toHaveBeenCalledTimes(1);
		});

		it("agent_end sync rebuilds agent state even when shake finds no new regions", async () => {
			const { session, scripted, setResult } = createPeriodicHarness({
				"compaction.strategy": "off",
				"shake.interval": 1,
			});
			const shakeSpy = vi.spyOn(session, "shake");
			const replaceSpy = vi.spyOn(session.agent, "replaceMessages");

			setResult(HEAVY_USELESS_RESULT, true);
			scripted.push({ stopReason: "toolUse", toolCalls: 1 });
			scripted.push({ stopReason: "stop", text: "done" });
			await session.prompt("do it");
			await settle(session);

			// Mid-run shake (skipAgentUpdate — no replaceMessages) elided the
			// result; the agent_end sync pass finds nothing new and rebuilds
			// agent state via replaceMessages (#shakeNeedsAgentSync).
			expect(shakeSpy).toHaveBeenCalledTimes(2);
			expect(replaceSpy).toHaveBeenCalled();
		});
	});
});
