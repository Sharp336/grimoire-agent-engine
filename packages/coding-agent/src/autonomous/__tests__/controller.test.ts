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
	planMode?: boolean;
	goalMode?: boolean;
}

function setup(options: FakeOptions) {
	let streaming = false;
	let planEnabled = options.planMode ?? false;
	let goalEnabled = options.goalMode ?? false;
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
		getPlanModeState: () => ({ enabled: planEnabled }),
		getGoalModeState: () => ({ enabled: goalEnabled }),
		emitNotice: (level, message, source) => {
			notices.push({ level, message, source });
		},
		hasQueuedCustomMessage: customType => queuedCustomTypes.has(customType),
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
			goalEnabled = value;
		},
		setQueueFollowUps: (value: boolean) => {
			queueFollowUps = value;
		},
	};
}

describe("AutonomousController arming", () => {
	it("ignores agent_end until begin() arms it", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(0);
		controller.begin({ hadInitialMessage: true, resuming: false, startupFailed: false });
		expect(sent).toHaveLength(1);
	});

	it("idea/combined self-starts with no message", () => {
		const idea = setup({ autoNextIdea: true });
		idea.controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		expect(idea.sent).toHaveLength(1);
		expect(idea.sent[0]!.content).toContain("ideation mode");
	});

	it("surfaces hidden kickoff send failures", async () => {
		const { controller, notices, sent, setSendError } = setup({ autoNextIdea: true });
		setSendError(new Error("missing API key"));
		controller.begin({ startupFailed: false });
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
		steps.controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		expect(steps.sent).toHaveLength(0);
	});

	it("steps-only self-starts on resume (transcript already holds an objective)", () => {
		const steps = setup({ autoNextSteps: true });
		steps.controller.begin({ hadInitialMessage: false, resuming: true, startupFailed: false });
		expect(steps.sent).toHaveLength(1);
	});

	it("begin() honors a failed/aborted startup turn instead of re-queueing", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		emit(agentEndEvent([assistant("aborted")])); // suppressed (not armed), but recorded
		controller.begin({ hadInitialMessage: true, resuming: false, startupFailed: false });
		expect(sent).toHaveLength(0);
	});

	it("begin() honors a startup prompt that threw without an agent_end (startupFailed)", () => {
		const { controller, sent } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: true, resuming: false, startupFailed: true });
		expect(sent).toHaveLength(0);
	});

	it("begin() leaves plan/goal mode to its own driver", () => {
		const plan = setup({ autoNextIdea: true, planMode: true });
		plan.controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		expect(plan.sent).toHaveLength(0);
	});

	it("begin() skips when the suppressed startup turn started in goal mode (exit-cleanup race)", () => {
		const { controller, emit, sent, setGoalMode } = setup({ autoNextSteps: true });
		setGoalMode(true);
		emit(START); // startup turn began in goal mode
		setGoalMode(false); // goal completed mid-turn; live flag clears before agent_end
		emit(agentEndEvent([assistantActing("stop")])); // suppressed (not armed)
		controller.begin({ hadInitialMessage: true, resuming: false, startupFailed: false });
		expect(sent).toHaveLength(0);
	});
});

describe("AutonomousController loop", () => {
	it("queues a continuation after a working turn", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false }); // arm, no queue
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(1);
		expect(sent[0]!.triggerTurn).toBe(true);
		expect(sent[0]!.deliverAs).toBe("followUp");
		expect(sent[0]!.content).toContain("continuation mode");
	});

	it("does not re-queue after an interrupted (aborted) turn", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		emit(agentEndEvent([assistantActing("aborted")]));
		expect(sent).toHaveLength(0);
	});

	it("does not re-queue after a failed (error) turn", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		emit(agentEndEvent([assistantActing("error")]));
		expect(sent).toHaveLength(0);
	});

	it("does not re-queue a deadline-style agent_end with no assistant message", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
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
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false }); // queues first
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
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		setStreaming(true);
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(0);
	});

	it("skips a turn that started in goal mode (avoids the exit-cleanup race)", () => {
		const { controller, emit, sent, setGoalMode } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
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

	it("skips a turn that started in plan mode", () => {
		const { controller, emit, sent, setPlanMode } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		setPlanMode(true);
		emit(START);
		emit(agentEndEvent([assistantActing("stop")]));
		expect(sent).toHaveLength(0);
	});
});

describe("AutonomousController steps completion", () => {
	it("disarms when an autonomous turn performs no action (objective done)", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		emit(agentEndEvent([assistantActing("stop")])); // queues; next turn is autonomous
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([autonomousPrompt(), assistant("stop")])); // autonomous turn, no action -> halt
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([assistantActing("stop")])); // disarmed: no further queue
		expect(sent).toHaveLength(1);
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
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
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
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		emit(agentEndEvent([assistant("stop")])); // non-autonomous turn (nothing queued yet)
		expect(sent).toHaveLength(1);
	});

	it("an aborted autonomous turn does not misclassify the next manual turn", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
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
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		expect(sent[0]!.content).toContain("fully autonomous");
		emit(agentEndEvent([autonomousPrompt(), assistant("stop")])); // combined never halts
		expect(sent).toHaveLength(2);
	});
});
