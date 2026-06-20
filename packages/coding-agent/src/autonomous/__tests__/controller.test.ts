import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { CustomMessage } from "../../session/messages";
import { AutonomousController, type AutonomousSession } from "../controller";

/** Build an `agent_end` event carrying the given turn messages. */
function agentEndEvent(messages: AgentMessage[]): AgentSessionEvent {
	return { type: "agent_end", messages };
}

const START: AgentSessionEvent = { type: "agent_start" };

/** A prose-only assistant tail (no actions). Only `role`/`stopReason`/content are read. */
function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", stopReason, content: [{ type: "text", text: "done" }] } as AssistantMessage;
}

/** An assistant turn that called a tool (signals tool activity to the controller). */
function assistantActing(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		stopReason,
		content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }],
	} as AssistantMessage;
}

function abortedToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "edit",
		content: [{ type: "text", text: "Deadline exceeded" }],
		isError: true,
		timestamp: 0,
	};
}

function autonomousPrompt(): CustomMessage {
	return {
		role: "custom",
		customType: "autonomous-continuation",
		content: "Continue autonomously",
		display: false,
		attribution: "user",
		timestamp: 0,
	};
}

function autolearnPrompt(): CustomMessage {
	return {
		role: "custom",
		customType: "autolearn-nudge",
		content: "Capture a lesson",
		display: false,
		attribution: "user",
		timestamp: 0,
	};
}

interface FakeOptions {
	autoNextSteps?: boolean;
	autoNextIdea?: boolean;
	autoCommit?: boolean;
	autoPr?: boolean;
	autoGroupPr?: boolean;
	autoAgents?: number;
	planMode?: boolean;
	goalMode?: boolean;
	history?: AgentMessage[];
}

function setup(options: FakeOptions) {
	let streaming = false;
	let planEnabled = options.planMode ?? false;
	let goalState: { enabled: boolean; mode?: "active" | "exiting" } | undefined = options.goalMode
		? { enabled: true, mode: "active" }
		: undefined;
	const history = options.history ?? [];
	let queueFollowUps = false;
	let handler: ((event: AgentSessionEvent) => void) | undefined;
	const sent: Array<{ content: string; triggerTurn?: boolean; deliverAs?: string }> = [];
	const queuedCustomTypes = new Set<string>();
	const notices: Array<{ level: "info" | "warning" | "error"; message: string; source?: string }> = [];
	let sendError: Error | undefined;
	const session: AutonomousSession = {
		subscribe: h => {
			handler = h;
			return () => {
				handler = undefined;
			};
		},
		get isStreaming() {
			return streaming;
		},
		get messages() {
			return history;
		},
		getPlanModeState: () => ({ enabled: planEnabled }),
		getGoalModeState: () => goalState,
		emitNotice: (level, message, source) => {
			notices.push({ level, message, source });
		},
		hasQueuedCustomMessage: customType => queuedCustomTypes.has(customType),
		dropQueuedCustomMessage: customType => queuedCustomTypes.delete(customType),
		sendCustomMessage: async (message, opts) => {
			if (sendError) throw sendError;
			const content = typeof message.content === "string" ? message.content : "";
			sent.push({ content, triggerTurn: opts?.triggerTurn, deliverAs: opts?.deliverAs });
			if (queueFollowUps || streaming) {
				queuedCustomTypes.add(message.customType);
				return false;
			}
			return true;
		},
	};
	const controller = new AutonomousController({
		session,
		autoNextSteps: options.autoNextSteps ?? false,
		autoNextIdea: options.autoNextIdea ?? false,
		autoCommit: options.autoCommit ?? false,
		autoPr: options.autoPr ?? false,
		autoGroupPr: options.autoGroupPr ?? false,
		autoAgents: options.autoAgents,
	});
	return {
		sent,
		notices,
		controller,
		emit: (event: AgentSessionEvent) => {
			const messages = "messages" in event ? event.messages : [];
			for (const message of messages) {
				if (message.role === "custom") queuedCustomTypes.delete(message.customType);
			}
			handler?.(event);
		},
		appendHistory: (message: AgentMessage) => {
			history.push(message);
		},
		dropQueuedCustomType: (customType: string) => {
			queuedCustomTypes.delete(customType);
		},
		setSendError: (error: Error | undefined) => {
			sendError = error;
		},
		setStreaming: (value: boolean) => {
			streaming = value;
		},
		setPlanMode: (value: boolean) => {
			planEnabled = value;
		},
		setGoalMode: (value: boolean) => {
			goalState = value ? { enabled: true, mode: "active" } : undefined;
		},
		setGoalModeState: (state: { enabled: boolean; mode?: "active" | "exiting" } | undefined) => {
			goalState = state;
		},
		setQueueFollowUps: (value: boolean) => {
			queueFollowUps = value;
		},
	};
}

describe("AutonomousController arming", () => {
	it("ignores agent_end until begin() arms it", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true, history: [assistant("stop")] });
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(0);
		controller.begin({ startupFailed: false });
		expect(sent).toHaveLength(1);
	});

	it("idea/combined self-starts with no message", () => {
		const idea = setup({ autoNextIdea: true });
		idea.controller.begin({ startupFailed: false });
		expect(idea.sent).toHaveLength(1);
		expect(idea.sent[0]!.content).toContain("ideation mode");
	});

	it("surfaces hidden kickoff send failures", async () => {
		const { controller, notices, sent, setSendError } = setup({ autoNextIdea: true });
		setSendError(new Error("missing API key"));
		controller.begin({ startupFailed: false });
		await Promise.resolve();
		await Promise.resolve();
		expect(sent).toHaveLength(0);
		expect(notices).toEqual([
			{
				level: "error",
				message: "Autonomous continuation failed: missing API key",
				source: "auto-next",
			},
		]);
	});

	it("steps-only idles with no restored transcript (continue fallback to fresh)", () => {
		// `--continue --auto-next-steps` in a project with no prior session opens an
		// empty transcript; steps-only must not invent an objective.
		const steps = setup({ autoNextSteps: true });
		steps.controller.begin({ startupFailed: false });
		expect(steps.sent).toHaveLength(0);
	});
	it("steps-only self-starts on resume (transcript already holds an objective)", () => {
		const steps = setup({ autoNextSteps: true, history: [assistant("stop")] });
		steps.controller.begin({ startupFailed: false });
		expect(steps.sent).toHaveLength(1);
	});

	it("begin() honors a failed/aborted startup turn instead of re-queueing", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		emit(agentEndEvent([assistant("aborted")])); // suppressed (not armed), but recorded
		controller.begin({ startupFailed: false });
		expect(sent).toHaveLength(0);
	});

	it("begin() honors a startup prompt that threw without an agent_end (startupFailed)", () => {
		const { controller, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: true });
		expect(sent).toHaveLength(0);
	});

	it("begin() leaves plan/goal mode to its own driver", () => {
		const plan = setup({ autoNextIdea: true, planMode: true });
		plan.controller.begin({ startupFailed: false });
		expect(plan.sent).toHaveLength(0);
	});

	it("begin() skips when the suppressed startup turn started in goal mode (exit-cleanup race)", () => {
		const { controller, emit, sent, setGoalMode } = setup({ autoNextSteps: true });
		setGoalMode(true);
		emit(START); // startup turn began in goal mode
		setGoalMode(false); // goal completed mid-turn; live flag clears before agent_end
		emit(agentEndEvent([assistantActing("stop")])); // suppressed (not armed)
		controller.begin({ startupFailed: false });
		expect(sent).toHaveLength(0);
	});
});

describe("AutonomousController loop", () => {
	it("queues a continuation after a working turn", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false }); // arm, no queue
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(1);
		expect(sent[0]!.triggerTurn).toBe(true);
		expect(sent[0]!.deliverAs).toBe("followUp");
		expect(sent[0]!.content).toContain("continuation mode");
	});

	it("does not re-queue after an interrupted (aborted) turn", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		emit(agentEndEvent([assistantActing("aborted")]));
		expect(sent).toHaveLength(0);
	});

	it("does not re-queue after a failed (error) turn", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		emit(agentEndEvent([assistantActing("error")]));
		expect(sent).toHaveLength(0);
	});

	it("does not re-queue a deadline-style agent_end with no assistant message", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		emit(agentEndEvent([assistantActing("stop")])); // working turn -> queue
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([autonomousPrompt()])); // --max-time expiry after the autonomous prompt: no assistant
		expect(sent).toHaveLength(1); // no spin (idea/combined would otherwise loop past the deadline)
		// The failed path clears the autonomous marker, so the next clean no-action
		// turn re-queues instead of being false-halted as a completed objective.
		emit(agentEndEvent([assistant("stop")]));
		expect(sent).toHaveLength(2);
	});

	it("idea mode does not spin past --max-time (no-assistant agent_end)", () => {
		const { controller, emit, sent } = setup({ autoNextIdea: true });
		controller.begin({ startupFailed: false }); // queues first
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([autonomousPrompt()])); // deadline expiry after the autonomous prompt: no assistant
		expect(sent).toHaveLength(1); // idea would otherwise loop forever appending continuations
	});

	it("idea mode does not spin past deadline-truncated tool turns", () => {
		const { controller, emit, sent } = setup({ autoNextIdea: true });
		controller.begin({ startupFailed: false }); // queues first (canKickoff)
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([autonomousPrompt(), assistantActing("stop"), abortedToolResult()]));
		expect(sent).toHaveLength(1);
	});

	it("queues a continuation behind a turn another controller already started", () => {
		const { appendHistory, controller, emit, sent, setStreaming } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		setStreaming(true); // e.g. AutoLearnController.autoContinue started capture from the same agent_end
		appendHistory(autolearnPrompt());
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(1);
		expect(sent[0]!.deliverAs).toBe("followUp");
	});

	it("does not queue from a generic stale agent_end while another turn is streaming", () => {
		const { controller, emit, sent, setStreaming } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		setStreaming(true);
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(0);
	});

	it("skips a turn that started in goal mode (avoids the exit-cleanup race)", () => {
		const { controller, emit, sent, setGoalMode } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		setGoalMode(true);
		emit(START); // latch start-of-turn goal state
		setGoalMode(false); // goal completed mid-turn, live flag clears before agent_end
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(0);
		// A subsequent normal turn resumes the loop.
		emit(START);
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(1);
	});

	it("skips a turn that started while goal mode was exiting", () => {
		const { controller, emit, sent, setGoalModeState } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		setGoalModeState({ enabled: false, mode: "exiting" });
		emit(START); // latch exiting goal cleanup as mode-owned
		setGoalModeState(undefined); // cleanup clears before agent_end
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(0);
	});

	it("skips a turn that started in plan mode", () => {
		const { controller, emit, sent, setPlanMode } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		setPlanMode(true);
		emit(START);
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(0);
	});

	it("skips a turn that entered plan or goal mode mid-turn", () => {
		const goal = setup({ autoNextSteps: true });
		goal.controller.begin({ startupFailed: false });
		goal.emit(START); // turn began outside goal mode
		goal.setGoalMode(true); // /goal enabled while the autonomous turn was streaming
		goal.emit(agentEndEvent([assistantActing("stop")]));
		expect(goal.sent).toHaveLength(0);

		const plan = setup({ autoNextSteps: true });
		plan.controller.begin({ startupFailed: false });
		plan.emit(START); // turn began outside plan mode
		plan.setPlanMode(true); // /plan enabled while the autonomous turn was streaming
		plan.emit(agentEndEvent([assistantActing("stop")]));
		expect(plan.sent).toHaveLength(0);
	});

	it("skips a mid-turn goal that completed before agent_end cleanup", () => {
		const goal = setup({ autoNextSteps: true });
		goal.controller.begin({ startupFailed: false });
		goal.emit(START); // turn began outside goal mode
		goal.setGoalModeState({ enabled: false, mode: "exiting" }); // goal tool completed before agent_end
		goal.emit(agentEndEvent([assistantActing("stop")]));
		expect(goal.sent).toHaveLength(0);
	});

	it("begin() skips when goal mode is exiting after startup", () => {
		const goal = setup({ autoNextIdea: true, goalMode: true });
		goal.setGoalModeState({ enabled: false, mode: "exiting" }); // startup turn completed a goal
		goal.controller.begin({ startupFailed: false });
		expect(goal.sent).toHaveLength(0);
	});
});

describe("AutonomousController steps completion", () => {
	it("skips immediate requeue when an autonomous turn performs no action", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		emit(agentEndEvent([assistantActing("stop")])); // queues; next turn is autonomous
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([autonomousPrompt(), assistant("stop")])); // autonomous turn, no action -> halt current objective
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([assistantActing("stop")])); // later manual objective: controller remains armed
		expect(sent).toHaveLength(2);
	});

	it("keeps the autonomous marker when a continuation is queued behind another turn", () => {
		const { controller, emit, sent, setQueueFollowUps } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false }); // arm
		setQueueFollowUps(true); // sendCustomMessage resolves false (queued, e.g. behind autolearn's capture turn)
		emit(agentEndEvent([assistantActing("stop")])); // working turn -> queue, marker preserved
		expect(sent).toHaveLength(1);
		setQueueFollowUps(false);
		// The queued follow-up eventually runs; its no-action agent_end must still be
		// classified autonomous and halt (would re-queue to 2 if !started cleared the marker).
		emit(agentEndEvent([autonomousPrompt(), assistant("stop")]));
		expect(sent).toHaveLength(1);
	});

	it("keeps the autonomous marker when the preceding queued turn aborts before draining it", () => {
		const { controller, emit, sent, setQueueFollowUps } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		setQueueFollowUps(true);
		emit(agentEndEvent([assistantActing("stop")])); // queue behind another turn
		expect(sent).toHaveLength(1);
		setQueueFollowUps(false);
		emit(agentEndEvent([assistant("aborted")])); // preceding synthetic turn, no autonomous prompt yet
		emit(agentEndEvent([autonomousPrompt(), assistant("stop")])); // queued autonomous follow-up finally runs
		expect(sent).toHaveLength(1);
	});

	it("clears the autonomous marker when an interrupt dropped the queued follow-up", () => {
		const { controller, dropQueuedCustomType, emit, sent, setQueueFollowUps } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		setQueueFollowUps(true);
		emit(agentEndEvent([assistantActing("stop")])); // queue behind another turn
		expect(sent).toHaveLength(1);
		dropQueuedCustomType("autonomous-continuation"); // clearQueue({ forInterrupt: true }) dropped the hidden prompt
		setQueueFollowUps(false);
		emit(agentEndEvent([assistant("aborted")])); // no autonomous prompt will drain now
		emit(agentEndEvent([assistant("stop")])); // next manual clean turn resumes the loop
		expect(sent).toHaveLength(2);
	});

	it("a superseded agent_end while streaming does not consume the autonomous marker", () => {
		const { controller, emit, sent, setStreaming } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		emit(agentEndEvent([assistantActing("stop")])); // queue -> next turn is autonomous + streaming
		expect(sent).toHaveLength(1);
		setStreaming(true);
		emit(agentEndEvent([assistantActing("stop")])); // stale agent_end while streaming
		expect(sent).toHaveLength(1);
		setStreaming(false);
		// The real autonomous agent_end must still be classified autonomous and halt.
		emit(agentEndEvent([autonomousPrompt(), assistant("stop")])); // no action -> halt (would queue if the stale event cleared the marker)
		expect(sent).toHaveLength(1);
	});

	it("ignores earlier synthetic tool activity when checking autonomous completion", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		emit(agentEndEvent([assistantActing("stop")])); // queue -> next turn is autonomous
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([assistantActing("stop"), autonomousPrompt(), assistant("stop")]));
		expect(sent).toHaveLength(1);
	});

	it("treats no assistant after the autonomous boundary as a deadline halt", () => {
		const { controller, emit, sent } = setup({ autoNextIdea: true });
		controller.begin({ startupFailed: false });
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([assistantActing("stop"), autonomousPrompt()]));
		expect(sent).toHaveLength(1);
	});

	it("a user turn with no action does NOT halt the loop", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		emit(agentEndEvent([assistant("stop")])); // non-autonomous turn (nothing queued yet)
		expect(sent).toHaveLength(1);
	});

	it("an aborted autonomous turn does not misclassify the next manual turn", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ startupFailed: false });
		emit(agentEndEvent([assistantActing("stop")])); // queue (turn becomes autonomous)
		emit(agentEndEvent([autonomousPrompt(), assistant("aborted")])); // autonomous turn aborted -> must reset latch
		emit(agentEndEvent([assistant("stop")])); // manual turn, no action -> must NOT halt
		expect(sent).toHaveLength(2);
	});

	it("idea mode never halts on an action-free turn (endless by design)", () => {
		const { controller, emit, sent } = setup({ autoNextIdea: true });
		controller.begin({ startupFailed: false }); // queues first
		emit(agentEndEvent([autonomousPrompt(), assistant("stop")])); // autonomous, no action -> still continues
		expect(sent).toHaveLength(2);
	});

	it("uses the combined prompt when both flags are set", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true, autoNextIdea: true });
		controller.begin({ startupFailed: false });
		expect(sent[0]!.content).toContain("fully autonomous");
		emit(agentEndEvent([autonomousPrompt(), assistant("stop")])); // combined never halts
		expect(sent).toHaveLength(2);
	});

	it("adds auto-commit instructions when no PR publishing mode is active", () => {
		const { controller, sent } = setup({
			autoNextSteps: true,
			autoCommit: true,
			history: [assistant("stop")],
		});
		controller.begin({ startupFailed: false });
		expect(sent[0]!.content).toContain("continuation mode");
		expect(sent[0]!.content).toContain("--auto-commit is enabled");
		expect(sent[0]!.content).toContain("existing commit workflow");
		expect(sent[0]!.content).not.toContain("--auto-pr is enabled");
	});

	it("auto-pr overrides auto-commit so combined flags always publish through a PR", () => {
		const { controller, sent } = setup({
			autoNextSteps: true,
			autoCommit: true,
			autoPr: true,
			history: [assistant("stop")],
		});
		controller.begin({ startupFailed: false });
		expect(sent[0]!.content).toContain("--auto-pr is enabled");
		expect(sent[0]!.content).toContain("pull-request branch");
		expect(sent[0]!.content).toContain("NEVER treat a local commit alone as complete");
		expect(sent[0]!.content).not.toContain("--auto-commit is enabled");
	});

	it("auto-group-pr overrides auto-pr and uses one shared pull request", () => {
		const { controller, sent } = setup({
			autoNextSteps: true,
			autoPr: true,
			autoGroupPr: true,
			history: [assistant("stop")],
		});
		controller.begin({ startupFailed: false });
		expect(sent[0]!.content).toContain("--auto-group-pr is enabled");
		expect(sent[0]!.content).toContain("one shared pull request");
		expect(sent[0]!.content).toContain("overrides `--auto-pr`");
		expect(sent[0]!.content).not.toContain("--auto-pr is enabled");
	});

	it("adds auto-agents instructions with the configured subagent count", () => {
		const { controller, sent } = setup({
			autoNextSteps: true,
			autoAgents: 3,
			history: [assistant("stop")],
		});
		controller.begin({ startupFailed: false });
		expect(sent[0]!.content).toContain("--auto-agents is enabled with 3 subagent");
		expect(sent[0]!.content).toContain("Coordinate through the irc tool");
	});

	it("drops queued autonomous continuation when plan mode enters", () => {
		const { controller, emit, sent, setQueueFollowUps, setPlanMode, dropQueuedCustomType } = setup({
			autoNextSteps: true,
			history: [assistant("stop")],
		});
		setQueueFollowUps(true); // before begin so the first continuation queues as follow-up
		controller.begin({ startupFailed: false });
		expect(sent).toHaveLength(1);

		// The autonomous turn runs and ends cleanly (with tool activity, so it doesn't halt).
		emit(agentEndEvent([autonomousPrompt(), assistantActing("stop")]));
		expect(sent).toHaveLength(2); // queues next continuation

		// Simulate plan mode entry: session drops the queued message and emits mode_changed.
		setPlanMode(true);
		dropQueuedCustomType("autonomous-continuation");
		emit({ type: "mode_changed", mode: "plan", active: true, droppedCustomType: "autonomous-continuation" });

		// The mode turn's agent_end has no autonomous prompt; controller must not be stuck.
		setPlanMode(false);
		emit(agentEndEvent([assistantActing("stop")]));
		// After mode exits, a clean turn should resume the loop (marker was cleared).
		expect(sent).toHaveLength(3);
	});

	it("drops queued autonomous continuation on goal_updated with enabled state", () => {
		const { controller, emit, sent, setQueueFollowUps } = setup({
			autoNextSteps: true,
			history: [assistant("stop")],
		});
		controller.begin({ startupFailed: false });
		expect(sent).toHaveLength(1); // begin queues first continuation

		// The autonomous turn runs and ends cleanly (with tool activity, so it doesn't halt).
		setQueueFollowUps(true); // before the autonomous turn so its continuation queues as follow-up
		emit(agentEndEvent([autonomousPrompt(), assistantActing("stop")]));
		expect(sent).toHaveLength(2); // queues next continuation

		// GoalRuntime emits goal_updated with state.enabled before setGoalModeState runs.
		// The controller's goal_updated handler drops the queued continuation and clears the marker.
		const goal = {
			id: "goal-1",
			objective: "finish",
			status: "active" as const,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 0,
			updatedAt: 0,
		};
		emit({ type: "goal_updated", goal, state: { enabled: true, mode: "active", goal } });

		// A subsequent clean turn should resume the loop (marker was cleared, not stuck).
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(3);
	});
});
