import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const OLD_HISTORY_SENTINEL = "OLD_HISTORY_BEFORE_TURN_BOUNDARY_COMPACTION";

describe("turn-boundary compaction ordering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-boundary-compaction-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("keeps parallel tool results exactly once in the next provider request", async () => {
		const toolSchema = type({ value: "string" });
		const toolCallCount = 128;
		const allToolsStarted = Promise.withResolvers<void>();
		let toolsStarted = 0;
		const resultSentinels = Array.from(
			{ length: toolCallCount },
			(_, index) => `<parallel-result-${index.toString().padStart(3, "0")}>`,
		);
		const tool: AgentTool<typeof toolSchema, undefined> = {
			name: "parallel-result",
			label: "Parallel result",
			description: "Return a result after overlapping with the other calls",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				toolsStarted++;
				if (toolsStarted === toolCallCount) allToolsStarted.resolve();
				await allToolsStarted.promise;
				const index = Number.parseInt(params.value, 10);
				const sentinel = resultSentinels[index];
				if (!sentinel) throw new Error(`Unexpected parallel tool index: ${params.value}`);
				return { content: [{ type: "text", text: `${sentinel}\n${"parallel payload ".repeat(8)}` }] };
			},
		};

		const settings = Settings.isolated({
			"advisor.enabled": false,
			// Enable inside the first response so pre-prompt maintenance cannot
			// consume the fixture before the tool-result boundary under test.
			"compaction.enabled": false,
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": false,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdTokens": 42_000,
			"compaction.thresholdPercent": -1,
			"compaction.keepRecentTokens": 10_000,
			"compaction.midTurnEnabled": true,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const model = createMockModel({
			id: "turn-boundary-primary",
			contextWindow: 100_000,
			maxTokens: 1_000,
			responses: [
				() => {
					settings.override("compaction.enabled", true);
					return {
						content: Array.from({ length: toolCallCount }, (_, index) => ({
							type: "toolCall" as const,
							id: `parallel-${index}`,
							name: tool.name,
							arguments: { value: String(index) },
						})),
						// Provider usage predates every result. The producer-owned live
						// context is the only complete token floor at this boundary.
						usage: { input: 100 },
					};
				},
				() => {
					settings.override("compaction.enabled", false);
					return { content: ["done"] };
				},
			],
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);

		const manager = SessionManager.inMemory(tempDir.path());
		const now = Date.now();
		const persistedPrefix: Message[] = [
			{
				role: "user",
				content: `${OLD_HISTORY_SENTINEL}\n${"old context payload ".repeat(4_000)}`,
				timestamp: now - 2,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "old answer payload ".repeat(4_000) }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: now - 1,
			},
		];
		for (const message of persistedPrefix) manager.appendMessage(message);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: persistedPrefix },
			convertToLlm,
			streamFn: model.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[tool.name, tool]]),
		});
		expect(session.isAdvisorActive()).toBe(false);
		expect(agent.tokenizer.countMessages(persistedPrefix)).toBeLessThan(42_000);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "parallel tool checkpoint",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		vi.spyOn(session, "getContextUsage").mockReturnValue({
			tokens: 100,
			contextWindow: model.contextWindow,
			percent: 0.5,
		});

		await session.prompt("Run every tool call in parallel, then answer.");

		expect(model.calls).toHaveLength(2);
		const secondCall = model.calls[1];
		if (!secondCall) throw new Error("Expected the post-compaction provider request");
		const providerReplay = JSON.stringify(secondCall.context.messages);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const rawBranchMessages = manager.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
		expect(agent.tokenizer.countMessages(rawBranchMessages)).toBeGreaterThan(42_000);
		const snapshots = [
			providerReplay,
			JSON.stringify(session.messages),
			JSON.stringify(session.buildDisplaySessionContext().messages),
			JSON.stringify(manager.getBranch()),
		];
		const exactlyOnce = Array.from({ length: toolCallCount }, () => 1);
		for (const snapshot of snapshots) {
			expect(resultSentinels.map(sentinel => snapshot.split(sentinel).length - 1)).toEqual(exactlyOnce);
		}
		const providerResultPositions = resultSentinels.map(sentinel => providerReplay.indexOf(sentinel));
		expect(providerResultPositions).toEqual([...providerResultPositions].sort((left, right) => left - right));
	});
});
