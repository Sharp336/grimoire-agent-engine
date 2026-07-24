import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	buildInteractiveRestartCommandOptions,
	hasRestartBlockingWork,
	spawnRestartAfterStartupMarketplaceUpdate,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";

type RestartBlockingSessionState = Pick<
	AgentSession,
	| "isStreaming"
	| "isCompacting"
	| "hasPostPromptWork"
	| "isBashRunning"
	| "isEvalRunning"
	| "queuedMessageCount"
	| "getAsyncJobSnapshot"
	| "hasPendingAsyncWork"
>;

function restartModel(overrides: Pick<Model, "provider" | "id"> & Partial<Model>): Model {
	return {
		name: overrides.id,
		api: "openai-completions",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		compat: {},
		...overrides,
	} as Model;
}

function sessionState(overrides: Partial<RestartBlockingSessionState> = {}): RestartBlockingSessionState {
	return {
		isStreaming: false,
		isCompacting: false,
		hasPostPromptWork: false,
		isBashRunning: false,
		isEvalRunning: false,
		queuedMessageCount: 0,
		getAsyncJobSnapshot: () => null,
		hasPendingAsyncWork: () => false,
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

	test("uses the live model after stale launch flags", () => {
		const options = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { provider: "anthropic", model: "claude-launch" },
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: false,
			liveModel: restartModel({ provider: "openai", id: "gpt-5-live" }),
			liveProviderSessionId: "provider-session",
		});

		expect(options.provider).toBeUndefined();
		expect(options.model).toBe("openai/gpt-5-live");
	});

	test("preserves routed live model selectors", () => {
		const options = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { provider: "openrouter", model: "z-ai/glm-4.7" },
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: false,
			liveModel: restartModel({
				provider: "openrouter",
				id: "z-ai/glm-4.7",
				compat: { openRouterRouting: { only: ["cerebras"] } } as Model["compat"],
			}),
			liveProviderSessionId: "provider-session",
		});

		expect(options.provider).toBeUndefined();
		expect(options.model).toBe("openrouter/z-ai/glm-4.7@cerebras");
	});

	test("omits model/provider overrides and relies on session restore when the live model is an ephemeral fallback", () => {
		const options = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { provider: "anthropic", model: "claude-launch" },
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: false,
			liveModel: restartModel({ provider: "openrouter", id: "fallback-live" }),
			liveModelChangeRole: "fallback",
			liveProviderSessionId: "provider-session",
		});

		expect(options.provider).toBeUndefined();
		expect(options.model).toBeUndefined();
	});

	test("launch A -> switch B -> fallback C restart selection", () => {
		const options = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { provider: "openai", model: "gpt-A" },
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: false,
			liveModel: restartModel({ provider: "anthropic", id: "claude-C" }),
			liveModelChangeRole: "fallback",
			liveProviderSessionId: "provider-session",
		});

		expect(options.provider).toBeUndefined();
		expect(options.model).toBeUndefined();
	});

	test("preserves autoApprove flag from launch flags", () => {
		const options = buildInteractiveRestartCommandOptions({
			sessionId: "local-session",
			cwd: "/repo/project",
			sessionDir: "/repo/project/.sessions",
			approvalMode: "write",
			launchFlags: { autoApprove: true },
			liveAdvisorEnabled: false,
			liveHideThinkingBlock: false,
			liveModel: restartModel({ provider: "openai", id: "gpt-5-live" }),
			liveProviderSessionId: "provider-session",
		});

		expect(options.autoApprove).toBe(true);
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

	test("blocks restart while user messages are queued", () => {
		expect(hasRestartBlockingWork(sessionState({ queuedMessageCount: 1 }))).toBe(true);
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

describe("restart startup lifecycle", () => {
	test("waits for the parent marketplace auto-update before spawning the child", async () => {
		const update = Promise.withResolvers<void>();
		let spawned = false;
		const restarted = spawnRestartAfterStartupMarketplaceUpdate(
			update.promise,
			{ cmd: ["omp"], cwd: "/repo/project" },
			async () => {
				spawned = true;
				return 0;
			},
		);

		await Promise.resolve();
		expect(spawned).toBe(false);

		update.resolve();
		expect(await restarted).toBe(0);
		expect(spawned).toBe(true);
	});
});
