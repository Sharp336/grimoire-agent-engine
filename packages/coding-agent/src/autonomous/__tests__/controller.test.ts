import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../../session/agent-session";
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
	let handler: ((event: AgentSessionEvent) => void) | undefined;
	const sent: Array<{ content: string; triggerTurn?: boolean; deliverAs?: string }> = [];
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
		sendCustomMessage: async (message, opts) => {
			const content = typeof message.content === "string" ? message.content : "";
			sent.push({ content, triggerTurn: opts?.triggerTurn, deliverAs: opts?.deliverAs });
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
		controller,
		emit: (event: AgentSessionEvent) => handler?.(event),
		setStreaming: (value: boolean) => {
			streaming = value;
		},
		setPlanMode: (value: boolean) => {
			planEnabled = value;
		},
		setGoalMode: (value: boolean) => {
			goalEnabled = value;
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

	it("steps-only with no message and no resume idles (nothing to continue)", () => {
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

	it("does not re-queue while a new turn is already streaming", () => {
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
		emit(agentEndEvent([assistant("stop")])); // autonomous turn, no action -> halt
		expect(sent).toHaveLength(1);
		emit(agentEndEvent([assistantActing("stop")])); // disarmed: no further queue
		expect(sent).toHaveLength(1);
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
		emit(agentEndEvent([assistant("stop")])); // no action -> halt (would queue if the stale event cleared the marker)
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
		emit(agentEndEvent([assistant("aborted")])); // autonomous turn aborted -> must reset latch
		emit(agentEndEvent([assistant("stop")])); // manual turn, no action -> must NOT halt
		expect(sent).toHaveLength(2);
	});

	it("idea mode never halts on an action-free turn (endless by design)", () => {
		const { controller, emit, sent } = setup({ autoNextIdea: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false }); // queues first
		emit(agentEndEvent([assistant("stop")])); // autonomous, no action -> still continues
		expect(sent).toHaveLength(2);
	});

	it("uses the combined prompt when both flags are set", () => {
		const { controller, emit, sent } = setup({ autoNextSteps: true, autoNextIdea: true });
		controller.begin({ hadInitialMessage: false, resuming: false, startupFailed: false });
		expect(sent[0]!.content).toContain("fully autonomous");
		emit(agentEndEvent([assistant("stop")])); // combined never halts
		expect(sent).toHaveLength(2);
	});
});
