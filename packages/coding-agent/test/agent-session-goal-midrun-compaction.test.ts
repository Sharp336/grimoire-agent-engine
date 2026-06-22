import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

// Issue #3174: an active /goal continuation can iterate tool-call turns for the
// entire goal in a single agent run. Such a run never settles to an `agent_end`,
// so the agent_end/pre-prompt threshold checkpoints never fire and context grows
// unbounded past the configured threshold. The per-turn `onTurnEnd` maintenance
// pass must catch this and compact in place between tool-call turns.

function activeGoalState(): GoalModeState {
	const now = Date.now();
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-1",
			objective: "Ship the release",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		},
	};
}

function highUsage(input: number) {
	return {
		input,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession mid-run goal compaction (issue #3174)", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-goal-midrun-compaction-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(settingsOverride: Record<string, unknown> = {}): Promise<{
		session: AgentSession;
		observedContexts: string[][];
	}> {
		const observedContexts: string[][] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.autoContinue": true,
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			"todo.enabled": false,
			"todo.reminders": false,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "tool output" }] }),
		};
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};
		void toolSession;

		// Turn 1: tool-call turn with high usage (drives the threshold). Turn 2+:
		// a plain text stop so the run finally settles. Without the mid-run fix the
		// only compaction checkpoint is the final agent_end, which sees turn 2's low
		// usage and never fires.
		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockBashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context, _options) => {
				const index = call++;
				observedContexts.push(context.messages.map(m => JSON.stringify(m)));
				const stream = new AssistantMessageEventStream();
				const isToolTurn = index === 0;
				const message = isToolTurn
					? {
							role: "assistant" as const,
							content: [
								{ type: "toolCall" as const, id: `tc-${index}`, name: "bash", arguments: { cmd: "ls" } },
							],
							api: "anthropic-messages" as const,
							provider: "anthropic" as const,
							model: "claude-sonnet-4-5",
							usage: highUsage(50_000),
							stopReason: "toolUse" as const,
							timestamp: Date.now(),
						}
					: {
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "All done." }],
							api: "anthropic-messages" as const,
							provider: "anthropic" as const,
							model: "claude-sonnet-4-5",
							usage: highUsage(200),
							stopReason: "stop" as const,
							timestamp: Date.now(),
						};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([[mockBashTool.name, mockBashTool]]),
		});

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, observedContexts };
	}

	it("compacts between tool-call turns during an active goal run", async () => {
		const { session } = await createHarness();
		session.setGoalModeState(activeGoalState());

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "MID-RUN-COMPACTED",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await session.prompt("work on the release");

		// Compaction ran mid-run, triggered by the per-turn maintenance pass — not by
		// a final agent_end (the run never settled until the threshold was relieved).
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("does not compact mid-run when no goal is active", async () => {
		const { session } = await createHarness();
		// No goal mode set — ordinary interactive runs reach agent_end between turns.

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "SHOULD-NOT-RUN",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await session.prompt("work on the release");

		expect(compactSpy).not.toHaveBeenCalled();
	});
});
