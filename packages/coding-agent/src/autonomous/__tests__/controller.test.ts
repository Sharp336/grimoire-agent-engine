import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../../session/agent-session";
import { AutonomousController, type AutonomousSession } from "../controller";

/** Build an `agent_end` event carrying the given assistant tail. */
function agentEndEvent(messages: AgentMessage[]): AgentSessionEvent {
	return { type: "agent_end", messages };
}

/** Minimal assistant tail — only `role`/`stopReason` are read by the controller. */
function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", stopReason } as AssistantMessage;
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
	const goalEnabled = options.goalMode ?? false;
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
	};
}

describe("AutonomousController", () => {
	it("queues a continuation after a normally-completed turn", () => {
		const { emit, sent } = setup({ autoNextSteps: true });
		emit(agentEndEvent([assistant("stop")]));
		expect(sent).toHaveLength(1);
		expect(sent[0]!.triggerTurn).toBe(true);
		expect(sent[0]!.deliverAs).toBe("followUp");
		expect(sent[0]!.content).toContain("continuation mode");
	});

	it("does not re-queue after an interrupted (aborted) turn", () => {
		const { emit, sent } = setup({ autoNextSteps: true });
		emit(agentEndEvent([assistant("aborted")]));
		expect(sent).toHaveLength(0);
	});

	it("re-arms on the next normal stop after an interrupt", () => {
		const { emit, sent } = setup({ autoNextSteps: true });
		emit(agentEndEvent([assistant("aborted")]));
		expect(sent).toHaveLength(0);
		emit(agentEndEvent([assistant("stop")]));
		expect(sent).toHaveLength(1);
	});

	it("does not re-queue after a failed (error) turn", () => {
		const { emit, sent } = setup({ autoNextSteps: true });
		emit(agentEndEvent([assistant("error")]));
		expect(sent).toHaveLength(0);
	});

	it("does not re-queue while a new turn is already streaming", () => {
		const { emit, sent, setStreaming } = setup({ autoNextSteps: true });
		setStreaming(true);
		emit(agentEndEvent([assistant("stop")]));
		expect(sent).toHaveLength(0);
	});

	it("leaves plan mode to its own continuation driver", () => {
		const { emit, sent } = setup({ autoNextSteps: true, planMode: true });
		emit(agentEndEvent([assistant("stop")]));
		expect(sent).toHaveLength(0);
	});

	it("leaves goal mode to its own continuation driver", () => {
		const { emit, sent } = setup({ autoNextSteps: true, goalMode: true });
		emit(agentEndEvent([assistant("stop")]));
		expect(sent).toHaveLength(0);
	});

	it("uses the combined prompt when both flags are set", () => {
		const { emit, sent } = setup({ autoNextSteps: true, autoNextIdea: true });
		emit(agentEndEvent([assistant("stop")]));
		expect(sent[0]!.content).toContain("fully autonomous");
	});

	it("uses the ideation prompt when only --auto-next-idea is set", () => {
		const { emit, sent } = setup({ autoNextIdea: true });
		emit(agentEndEvent([assistant("stop")]));
		expect(sent[0]!.content).toContain("ideation mode");
	});

	it("kickoff starts a first turn in idea/combined mode but not steps-only", () => {
		const idea = setup({ autoNextIdea: true });
		idea.controller.kickoff();
		expect(idea.sent).toHaveLength(1);
		expect(idea.sent[0]!.content).toContain("ideation mode");

		const steps = setup({ autoNextSteps: true });
		steps.controller.kickoff();
		expect(steps.sent).toHaveLength(0);
	});

	it("kickoff is a no-op once a turn is already streaming", () => {
		const { controller, sent, setStreaming } = setup({ autoNextIdea: true });
		setStreaming(true);
		controller.kickoff();
		expect(sent).toHaveLength(0);
	});
});
