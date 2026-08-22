import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { computeNonMessageTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	resolvePreservedUserMessagePolicy,
	selectPreservedUserMessages,
} from "@oh-my-pi/pi-coding-agent/session/preserve-user-messages";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("AgentSession session stats", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("preserves authoritative provider occupancy above the local transcript estimate", () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model?.contextWindow) {
			throw new Error("Expected bundled model with a context window");
		}

		const userMessage: UserMessage = {
			role: "user",
			content: "Hello",
			timestamp: Date.now(),
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 120_000,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_002,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [userMessage, assistantMessage],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const directUsage = session.getContextUsage();
		const stats = session.getSessionStats();

		expect(directUsage).toEqual({
			tokens: 120_000,
			contextWindow: model.contextWindow,
			percent: (120_000 / model.contextWindow) * 100,
		});
		expect(stats.contextUsage).toEqual(directUsage);
	});

	it("floors anchored post-compaction usage by the local context plus transient overlay", () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model?.contextWindow) throw new Error("Expected bundled model with a context window");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "user",
			content: `preserved requirement ${"detail ".repeat(2_000)}`,
			timestamp: 1,
		});
		const keptId = sessionManager.appendMessage({ role: "user", content: "kept tail", timestamp: 2 });
		const compactionId = sessionManager.appendCompaction("summary", undefined, keptId, 10_000);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "provider anchor with deliberately tiny reported input" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 3,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.keepUserMessages": true,
			"compaction.keepUserMessagesFilter": "all",
		});
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const policy = resolvePreservedUserMessagePolicy(settings.getGroup("compaction"), agent.tokenizer);
		if (!policy) throw new Error("Expected preservation policy");
		const compaction = sessionManager.getEntry(compactionId) as CompactionEntry;
		const overlayTokens = selectPreservedUserMessages(sessionManager.getBranch(), compaction, policy).tokenCount;
		const localTokens =
			computeNonMessageTokens(session, agent.tokenizer) + agent.tokenizer.countMessages(session.messages);

		expect(overlayTokens).toBeGreaterThan(0);
		expect(session.getContextUsage()?.tokens).toBe(localTokens + overlayTokens);
	});

	it("reconstructs persisted and active tool-loop context when provider prompt usage is unavailable", async () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model?.contextWindow) {
			throw new Error("Expected bundled model with a context window");
		}

		const outputOnlyUsage = {
			input: 0,
			output: 29,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 29,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};
		const messages: Message[] = [
			{
				role: "user",
				content: "Map the repository architecture before making changes.",
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I will inspect the relevant files." },
					{
						type: "toolCall",
						id: "read-architecture",
						name: "read",
						arguments: { path: "docs/architecture.md" },
					},
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: outputOnlyUsage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "read-architecture",
				toolName: "read",
				content: [{ type: "text", text: "architecture findings\n".repeat(2_000) }],
				isError: false,
				timestamp: 3,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: outputOnlyUsage,
				contextSnapshot: { promptTokens: 29, nonMessageTokens: 0 },
				stopReason: "stop",
				timestamp: 4,
			},
		];
		for (const persistMessages of [true, false]) {
			const sessionManager = SessionManager.inMemory();
			if (persistMessages) {
				for (const message of messages) {
					sessionManager.appendMessage(message);
				}
			}
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages,
				},
			});
			const candidateSession = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
			});

			expect(candidateSession.getContextUsage()?.tokens).toBeGreaterThan(1_000);
			await candidateSession.dispose();
		}
	});
});
