import { describe, expect, test } from "bun:test";
import {
	buildInteractiveRestartCommandOptions,
	hasRestartBlockingWork,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
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

const deliveringDeliverySnapshot: AsyncJobSnapshot = {
	running: [],
	recent: [],
	delivery: { queued: 0, delivering: true, pendingJobIds: ["job-3"] },
};

describe("restart command options", () => {
	test("uses the live provider session id after stale launch flags", () => {
		const options = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { providerSessionId: "launch-provider-session" },
			liveProviderSessionId: "fresh-provider-session",
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: false,
		});

		expect(options.providerSessionId).toBe("fresh-provider-session");
	});

	test("uses the live advisor state after stale launch flags", () => {
		const enabledOptions = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { advisor: false },
			liveAdvisorEnabled: true,
			liveHideThinkingBlock: false,
			liveProviderSessionId: "provider-session",
		});
		const disabledOptions = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { advisor: true },
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: false,
			liveProviderSessionId: "provider-session",
		});

		expect(enabledOptions.advisor).toBe(true);
		expect(disabledOptions.advisor).toBe(false);
	});

	test("uses the live thinking visibility state after stale launch flags", () => {
		const hiddenOptions = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { hideThinking: false },
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: true,
			liveProviderSessionId: "provider-session",
		});
		const visibleOptions = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { hideThinking: true },
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: false,
			liveProviderSessionId: "provider-session",
		});

		expect(hiddenOptions.hideThinking).toBe(true);
		expect(visibleOptions.hideThinking).toBe(false);
	});
});
describe("restart active-work guard", () => {
	test("allows restart when the session is idle", () => {
		expect(hasRestartBlockingWork(sessionState())).toBe(false);
	});

	test("blocks restart while main session work is active", () => {
		expect(hasRestartBlockingWork(sessionState({ isStreaming: true }))).toBe(true);
		expect(hasRestartBlockingWork(sessionState({ isCompacting: true }))).toBe(true);
		expect(hasRestartBlockingWork(sessionState({ hasPostPromptWork: true }))).toBe(true);
		expect(hasRestartBlockingWork(sessionState({ isBashRunning: true }))).toBe(true);
		expect(hasRestartBlockingWork(sessionState({ isEvalRunning: true }))).toBe(true);
	});

	test("blocks restart while async work or async delivery is active", () => {
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
		expect(
			hasRestartBlockingWork(
				sessionState({
					getAsyncJobSnapshot: () => deliveringDeliverySnapshot,
				}),
			),
		).toBe(true);
	});

	test("blocks restart while detached subagents are running", () => {
		const registry = new AgentRegistry();

		expect(hasRestartBlockingWork(sessionState(), registry)).toBe(false);

		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			status: "running",
			session: null,
			sessionFile: "/tmp/Worker.jsonl",
		});

		expect(hasRestartBlockingWork(sessionState(), registry)).toBe(true);

		registry.setStatus("Worker", "idle");

		expect(hasRestartBlockingWork(sessionState(), registry)).toBe(false);
	});
});
