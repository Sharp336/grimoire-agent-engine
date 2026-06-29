import { describe, expect, test } from "bun:test";
import { hasRestartBlockingWork } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { AgentSession, AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";

type RestartBlockingSessionState = Pick<
	AgentSession,
	"isStreaming" | "isCompacting" | "hasPostPromptWork" | "isBashRunning" | "isEvalRunning" | "getAsyncJobSnapshot"
>;

function sessionState(overrides: Partial<RestartBlockingSessionState> = {}): RestartBlockingSessionState {
	return {
		isStreaming: false,
		isCompacting: false,
		hasPostPromptWork: false,
		isBashRunning: false,
		isEvalRunning: false,
		getAsyncJobSnapshot: () => null,
		...overrides,
	};
}

const runningAsyncSnapshot: AsyncJobSnapshot = {
	running: [
		{
			id: "job-1",
			type: "bash",
			status: "running",
			label: "bash: sleep 60",
			startTime: 1,
		},
	],
	recent: [],
	delivery: { queued: 0, delivering: false, pendingJobIds: [] },
};

const queuedDeliverySnapshot: AsyncJobSnapshot = {
	running: [],
	recent: [],
	delivery: { queued: 1, delivering: false, pendingJobIds: ["job-2"] },
};

describe("restart active-work guard", () => {
	test("allows restart when the session is idle", () => {
		expect(hasRestartBlockingWork(sessionState())).toBe(false);
	});

	test("blocks restart while direct work, async work, or async delivery is active", () => {
		expect(hasRestartBlockingWork(sessionState({ isBashRunning: true }))).toBe(true);
		expect(
			hasRestartBlockingWork(
				sessionState({
					getAsyncJobSnapshot: () => runningAsyncSnapshot,
				}),
			),
		).toBe(true);
		expect(
			hasRestartBlockingWork(
				sessionState({
					getAsyncJobSnapshot: () => queuedDeliverySnapshot,
				}),
			),
		).toBe(true);
	});
});
