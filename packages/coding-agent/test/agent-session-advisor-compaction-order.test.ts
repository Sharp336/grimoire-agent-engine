import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AdvisorRuntime } from "../src/advisor/runtime";

const OLD_HISTORY = "OLD_HISTORY_BEFORE_ADVISOR_MAINTENANCE";
const CURRENT_TURN = "CURRENT_TURN_REVIEWED_AFTER_MAINTENANCE";

type TurnEndHandler = (
	messages: AgentMessage[],
	signal?: AbortSignal,
	context?: AgentTurnEndContext,
) => Promise<void> | void;

function assistant(text: string, input: number, stopReason: "stop" | "toolUse", timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

describe("advisor compaction ordering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-advisor-compaction-order-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
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

	function createHarness(): {
		agent: Agent;
		manager: SessionManager;
		onTurnEnd: TurnEndHandler;
	} {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model");
		const model = { ...bundled, contextWindow: 20_000, maxTokens: 1_000 };
		const settings = Settings.isolated({
			"advisor.enabled": true,
			"advisor.compactBeforeGuidance": true,
			"advisor.syncBacklog": "off",
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": false,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdTokens": 12_000,
			"compaction.thresholdPercent": -1,
			"compaction.keepRecentTokens": 100,
			"compaction.midTurnEnabled": true,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("advisor", `${bundled.provider}/${bundled.id}`);
		const manager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: [], tools: [], messages: [] },
		});
		let onTurnEnd: TurnEndHandler | undefined;
		const setOnTurnEnd = agent.setOnTurnEnd.bind(agent);
		vi.spyOn(agent, "setOnTurnEnd").mockImplementation(handler => {
			onTurnEnd = handler;
			setOnTurnEnd(handler);
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			advisorTools: [],
		});
		expect(session.getAdvisorAgent()).toBeDefined();
		if (!onTurnEnd) throw new Error("Expected primary turn-end handler");
		return { agent, manager, onTurnEnd };
	}

	function mockCompaction() {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "bounded primary context",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	it("runs existing mid-turn maintenance before a continuing turn reaches the advisor", async () => {
		const { agent, manager, onTurnEnd } = createHarness();
		const now = Date.now();
		const callId = "current-read";
		const prefix: Message[] = [
			{ role: "user", content: `${OLD_HISTORY}\n${"old payload ".repeat(5_000)}`, timestamp: now - 4 },
			assistant("old answer payload ".repeat(2_000), 10, "stop", now - 3),
			{ role: "user", content: "inspect the current file", timestamp: now - 2 },
		];
		const currentAssistant: AssistantMessage = {
			...assistant("", 15_000, "toolUse", now - 1),
			content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "README.md" } }],
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: CURRENT_TURN }],
			isError: false,
			timestamp: now,
		};
		const messages: Message[] = [...prefix, currentAssistant, toolResult];
		for (const message of messages) manager.appendMessage(message);
		agent.replaceMessages(messages);

		const compactSpy = mockCompaction();
		let advisorMessages: AgentMessage[] = [];
		vi.spyOn(AdvisorRuntime.prototype, "onTurnEnd").mockImplementation(messagesAtTurnEnd => {
			advisorMessages = messagesAtTurnEnd ? [...messagesAtTurnEnd] : [];
		});

		await onTurnEnd(messages, undefined, {
			message: currentAssistant,
			toolResults: [toolResult],
			willContinue: true,
		});

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(advisorMessages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(JSON.stringify(advisorMessages)).toContain(CURRENT_TURN);
		expect(JSON.stringify(advisorMessages)).not.toContain(OLD_HISTORY);
	});

	it("defers a terminal review until normal agent-end compaction has finished", async () => {
		const { agent, manager, onTurnEnd } = createHarness();
		const now = Date.now();
		const messages: Message[] = [
			{ role: "user", content: `${OLD_HISTORY}\n${"old payload ".repeat(5_000)}`, timestamp: now - 3 },
			assistant("old answer payload ".repeat(2_000), 10, "stop", now - 2),
			{ role: "user", content: "finish the current task", timestamp: now - 1 },
			assistant(CURRENT_TURN, 15_000, "stop", now),
		];
		for (const message of messages) manager.appendMessage(message);
		agent.replaceMessages(messages);
		const terminalAssistant = messages.at(-1);
		if (terminalAssistant?.role !== "assistant") throw new Error("Expected terminal assistant message");

		const compactSpy = mockCompaction();
		const advisorSnapshots: AgentMessage[][] = [];
		vi.spyOn(AdvisorRuntime.prototype, "onTurnEnd").mockImplementation(messagesAtTurnEnd => {
			advisorSnapshots.push(messagesAtTurnEnd ? [...messagesAtTurnEnd] : []);
		});

		await onTurnEnd(messages, undefined, {
			message: terminalAssistant,
			toolResults: [],
			willContinue: false,
		});
		expect(compactSpy).not.toHaveBeenCalled();
		expect(advisorSnapshots).toHaveLength(0);

		agent.emitExternalEvent({ type: "agent_end", messages: [terminalAssistant] });
		await session?.waitForIdle();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(advisorSnapshots).toHaveLength(1);
		const advisorMessages = advisorSnapshots[0] ?? [];
		expect(advisorMessages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(JSON.stringify(advisorMessages)).toContain(CURRENT_TURN);
		expect(JSON.stringify(advisorMessages)).not.toContain(OLD_HISTORY);
	});
});
