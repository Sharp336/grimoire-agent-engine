/**
 * Owner-routed async delivery + quiescence (structured concurrency for
 * background jobs): each AgentSession registers a delivery sink for its own
 * agent id, owned job completions inject async-result follow-up turns into
 * THAT session, and `hasPendingAsyncWork()` / `settleAsyncWork()` define the
 * run quiescence the task executor's barrier is built on.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { DaemonCompletionNotification, DaemonOutputNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	ASYNC_PROGRESS_WAKE_QUEUE_KIND,
	type AsyncProgressEntry,
	type AsyncResultEntry,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession owner-routed async delivery", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		AsyncJobManager.resetForTests();
	});

	it("injects an owned completion as a follow-up turn and reaches quiescence", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "gated job", () => gate.promise, { id: "sub-job", ownerId: "SubAgent" });

		// A running owned job holds the session out of quiescence.
		expect(session.hasPendingAsyncWork()).toBe(true);

		gate.resolve("job finished: ALL GREEN");
		await session.settleAsyncWork();

		// The completion routed to THIS session (not a global default sink) and
		// ran as a follow-up turn whose context carries the job result.
		expect(session.hasPendingAsyncWork()).toBe(false);
		const sawResult = mock.calls.some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("ALL GREEN");
				}
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("ALL GREEN"))
				);
			}),
		);
		expect(sawResult).toBe(true);
	});

	it("routes an advisor-owned launch completion through the session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const owner = `${sessionManager.getSessionId()}-advisor`;
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const completion = {
			event: "daemon-completed",
			completionId: "advisor-completion",
			owner,
			daemon: {
				name: "advisor-worker",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification;

		await session.queueLaunchCompletion(completion);
		await session.waitForIdle();

		expect(
			mock.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("advisor-worker")
						: message.content.some(content => content.type === "text" && content.text.includes("advisor-worker")),
				),
			),
		).toBe(true);
	});

	it("settles each wake process event then parks again while its monitor remains active", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
		});
		session.setLaunchMonitorActive("monitor-1", "wake", true);
		await session.prompt("start monitoring");
		expect(session.hasPendingAsyncWork()).toBe(true);
		let settled = false;
		const settling = session.settleAsyncWork().then(() => {
			settled = true;
		});
		await Bun.sleep(1);
		expect(settled).toBe(false);

		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "monitor-1",
				name: "watched",
				daemonId: "daemon-1",
				seq: 1,
				text: "PUSHED WHILE SETTLING",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"wake",
			Date.now(),
		);
		await settling;
		expect(session.hasPendingAsyncWork()).toBe(true);
		expect(
			mock.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("PUSHED WHILE SETTLING")
						: message.content.some(
								content => content.type === "text" && content.text.includes("PUSHED WHILE SETTLING"),
							),
				),
			),
		).toBe(true);

		let settledAgain = false;
		const settlingAgain = session.settleAsyncWork().then(() => {
			settledAgain = true;
		});
		await Bun.sleep(1);
		expect(settledAgain).toBe(false);

		session.setLaunchMonitorActive("monitor-1", "wake", false);
		await settlingAgain;
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	it("fences old process progress while switching to another session", async () => {
		using tempDir = TempDir.createSync("@omp-launch-progress-switch-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "old session", timestamp: 1 });
		await sessionManager.flush();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target session", timestamp: 2 });
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		session.setLaunchMonitorActive("old-monitor", "wake", true);
		session.registerSessionChangeCallback(() => session.setLaunchMonitorActive("old-monitor", "wake", false));
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "old-ambient-monitor",
				name: "old-ambient-process",
				daemonId: "old-ambient-daemon",
				seq: 1,
				text: "QUEUED OLD AMBIENT EVENT",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
		);
		session.setSessionBeforeSwitchReconciler(async () => {
			session.queueLaunchProgress(
				{
					event: "daemon-output",
					monitorId: "old-monitor",
					name: "old-process",
					daemonId: "old-daemon",
					seq: 1,
					text: "OLD SESSION PROCESS EVENT",
					batchKind: "progress",
					suppressedEvents: 0,
				},
				"wake",
				Date.now(),
			);
		});

		await expect(session.switchSession(targetFile)).resolves.toBe(true);
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "new-monitor",
				name: "new-process",
				daemonId: "new-daemon",
				seq: 1,
				text: "FRESH SESSION PROCESS EVENT",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
		);
		await session.sendUserMessage("inspect target");

		expect(session.hasPendingAsyncWork()).toBe(false);
		const observedText = mock.calls
			.flatMap(call =>
				call.context.messages.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
				),
			)
			.join("\n");
		expect(observedText).not.toContain("OLD SESSION PROCESS EVENT");
		expect(observedText).not.toContain("QUEUED OLD AMBIENT EVENT");
		expect(observedText).toContain("FRESH SESSION PROCESS EVENT");
	});

	it("purges finished owned jobs when starting a new session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const completedJobId = manager.register("task", "prior session", async () => "done", {
			id: "prior-session-job",
			ownerId: "Main",
		});
		const failedJobId = manager.register(
			"task",
			"failed prior session",
			async () => {
				throw new Error("prior session failure");
			},
			{
				id: "failed-prior-session-job",
				ownerId: "Main",
			},
		);
		const otherOwnerJobId = manager.register("task", "other session", async () => "done", {
			id: "other-session-job",
			ownerId: "Other",
		});
		manager.watchJobs([completedJobId, failedJobId, otherOwnerJobId]);
		await manager.waitForAll();

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(failedJobId)?.status).toBe("failed");
		expect(await session.newSession()).toBe(true);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(failedJobId)).toBeUndefined();
		expect(manager.getJob(otherOwnerJobId)?.status).toBe("completed");
	});

	it("does not inject a prior session's pending async result after a new session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		// Complete a job and push its result all the way onto the yield queue, so a
		// follow-up turn is pending injection into the (soon-to-be-replaced) session.
		manager.register("task", "prior session", async () => "STALE ASYNC RESULT", {
			id: "prior-session-job",
			ownerId: "Main",
		});
		await manager.waitForOwnerJobs("Main");
		await manager.drainDeliveries({ filter: { ownerId: "Main" } });
		expect(session.hasPendingAsyncWork()).toBe(true);

		expect(await session.newSession()).toBe(true);
		expect(session.hasPendingAsyncWork()).toBe(false);

		// A fresh turn in the replacement session must not carry the prior result.
		const callsBefore = mock.calls.length;
		await session.sendUserMessage("fresh turn");
		const leaked = mock.calls.slice(callsBefore).some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") return message.content.includes("STALE ASYNC RESULT");
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("STALE ASYNC RESULT"))
				);
			}),
		);
		expect(leaked).toBe(false);
	});

	it("drops a prior session's late delivery even after its job id is reused", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		// The delivery generation starts at 0; a new session bumps it to 1.
		expect(await session.newSession()).toBe(true);

		// Simulate a delivery that finished formatting in the prior session (epoch
		// 0) but only reaches the yield queue after the transition — the exact
		// window a reused job id would reopen by clearing the manager's per-id
		// suppression marker. It must not inject into the replacement transcript.
		session.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
			jobId: "bg_1",
			result: "STALE ASYNC RESULT",
			job: undefined,
			durationMs: 0,
			epoch: 0,
		});

		const callsBefore = mock.calls.length;
		await session.sendUserMessage("fresh turn");
		await session.settleAsyncWork();
		const leaked = mock.calls.slice(callsBefore).some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") return message.content.includes("STALE ASYNC RESULT");
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("STALE ASYNC RESULT"))
				);
			}),
		);
		expect(leaked).toBe(false);
		// The stale entry was consumed by the run's aside/flush path and dropped,
		// not left lingering as pending work.
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	it("still reports pending async work while a delivered result awaits injection", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "gated job", () => gate.promise, { id: "sub-job", ownerId: "SubAgent" });
		gate.resolve("job finished: QUEUED RESULT");
		await manager.waitForOwnerJobs("SubAgent");
		await manager.drainDeliveries({ filter: { ownerId: "SubAgent" } });

		// The manager has fully handed off — no running jobs, no queued or
		// in-flight deliveries — but the async-result follow-up still sits on
		// the session's yield queue awaiting the (delayed) idle flush / next
		// step boundary. A terminal yield observed in this window MUST still
		// count as pending async work, or the run driver terminates and the
		// delivered result is silently dropped from the final report.
		expect(session.hasPendingAsyncWork()).toBe(true);

		// Settling drains the queued follow-up into a real turn and only then
		// reaches quiescence.
		await session.settleAsyncWork();
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	it("holds progress while idle and injects it at the next active turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "progress job", () => gate.promise, { id: "progress-job", ownerId: "Main" });
		const job = manager.getJob("progress-job");
		if (!job) throw new Error("Expected registered progress job");
		session.yieldQueue.enqueue<AsyncProgressEntry>("async-progress", {
			jobId: job.id,
			text: "LAZY PROGRESS MARKER",
			job,
			seq: 1,
			elapsedMs: 10,
			epoch: 0,
			delivery: "ambient",
		});

		await Promise.resolve();
		expect(mock.calls).toHaveLength(0);

		await session.sendUserMessage("inspect progress");
		expect(
			mock.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("LAZY PROGRESS MARKER")
						: message.content.some(
								content => content.type === "text" && content.text.includes("LAZY PROGRESS MARKER"),
							),
				),
			),
		).toBe(true);

		manager.watchJobs([job.id]);
		gate.resolve("done");
		await manager.waitForAll();
	});

	it("permanently drops queued ambient progress when its job is acknowledged", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressMarker = "ACKNOWLEDGED PROGRESS MUST STAY STALE";
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "acknowledged progress job", () => gate.promise, {
			id: "acknowledged-progress-job",
			ownerId: "Main",
			progressDelivery: "ambient",
		});
		const job = manager.getJob("acknowledged-progress-job");
		if (!job) throw new Error("Expected registered acknowledged progress job");
		session.yieldQueue.enqueue<AsyncProgressEntry>("async-progress", {
			jobId: job.id,
			text: progressMarker,
			job,
			seq: 1,
			elapsedMs: 10,
			epoch: 0,
			delivery: "ambient",
		});

		manager.watchJobs([job.id]);
		gate.resolve("done");
		await manager.waitForAll();
		expect(manager.getJob(job.id)?.status).toBe("completed");

		manager.acknowledgeDeliveries([job.id]);
		expect(session.yieldQueue.has("async-progress")).toBe(false);
		manager.unwatchJobs([job.id]);
		expect(manager.evictCompletedJobs({ ownerId: "Main" })).toBe(1);
		expect(manager.getJob(job.id)).toBeUndefined();

		await session.sendUserMessage("later turn after retention eviction");
		expect(
			mock.calls.every(call =>
				call.context.messages.every(message =>
					typeof message.content === "string"
						? !message.content.includes(progressMarker)
						: message.content.every(content => content.type !== "text" || !content.text.includes(progressMarker)),
				),
			),
		).toBe(true);
	});

	it("folds queued ambient progress into the completion-triggered flush before the result", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressMarker = "AMBIENT PROGRESS MARKER";
		const resultMarker = "AMBIENT RESULT MARKER";
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "ambient job", () => gate.promise, {
			id: "ambient-ordered-job",
			ownerId: "Main",
			progressDelivery: "ambient",
		});
		const job = manager.getJob("ambient-ordered-job");
		if (!job) throw new Error("Expected registered ambient job");
		// Ambient progress delivered while the owner idles sits on the
		// skip-idle-flush queue without waking the session.
		session.yieldQueue.enqueue<AsyncProgressEntry>("async-progress", {
			jobId: job.id,
			text: progressMarker,
			job,
			seq: 1,
			elapsedMs: 10,
			epoch: 0,
			delivery: "ambient",
		});
		await Promise.resolve();
		expect(mock.calls).toHaveLength(0);

		gate.resolve(`finished: ${resultMarker}`);
		await session.settleAsyncWork();

		// The completion-triggered flush must inject the queued ambient
		// progress ahead of the completion result that references it.
		const markerIndex = (messages: (typeof mock.calls)[number]["context"]["messages"], marker: string) =>
			messages.findIndex(message =>
				typeof message.content === "string"
					? message.content.includes(marker)
					: message.content.some(content => content.type === "text" && content.text.includes(marker)),
			);
		const followUp = mock.calls.find(call => markerIndex(call.context.messages, resultMarker) >= 0);
		if (!followUp) throw new Error("Completion follow-up never reached the model");
		const progressIndex = markerIndex(followUp.context.messages, progressMarker);
		const resultIndex = markerIndex(followUp.context.messages, resultMarker);
		expect(progressIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBeGreaterThan(progressIndex);
	}, 10_000);

	it("wakes an idle model for supervised process output independently of async job ids", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const marker = "SUPERVISED PROCESS WAKE";
		const wakeObserved = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				const sawMarker = context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes(marker)
						: message.content.some(content => content.type === "text" && content.text.includes(marker)),
				);
				if (sawMarker) wakeObserved.resolve();
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");
		// A foreground wait may suppress an async job with the same textual id.
		// Process-monitor delivery has a distinct source identity and must remain visible.
		manager.acknowledgeDeliveries(["watcher"]);
		const notification: DaemonOutputNotification = {
			event: "daemon-output",
			monitorId: "monitor-1",
			name: "watcher",
			daemonId: "daemon-1",
			seq: 1,
			text: marker,
			batchKind: "progress",
			suppressedEvents: 0,
		};
		session.queueLaunchProgress(notification, "wake", Date.now());

		await wakeObserved.promise;
		expect(mock.calls).toHaveLength(2);
	}, 10_000);

	it("keeps a final response nonterminal when wake progress queues at the release boundary", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const marker = "BOUNDARY PROCESS WAKE";
		const wakeObserved = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (text.includes(marker)) wakeObserved.resolve();
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		let queued = false;
		const extensionRunner = {
			emit: vi.fn((event: { type: string }) => {
				if (event.type !== "agent_end" || queued) return Promise.resolve();
				queued = true;
				session.queueLaunchProgress(
					{
						event: "daemon-output",
						monitorId: "monitor-boundary",
						name: "watcher",
						daemonId: "daemon-boundary",
						seq: 1,
						text: marker,
						batchKind: "progress",
						suppressedEvents: 0,
					},
					"wake",
					Date.now(),
				);
				return Promise.resolve();
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
			extensionRunner,
		});
		const terminalStates: Array<boolean | undefined> = [];
		session.subscribe(event => {
			if (event.type === "agent_end") terminalStates.push(event.isTerminal);
		});

		await session.sendUserMessage("initialize then wait");
		await wakeObserved.promise;
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(terminalStates).toEqual([false, true]);
	}, 10_000);

	it("batches every supervised process event emitted while busy before terminal completion", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const busyStarted = Promise.withResolvers<void>();
		const releaseBusy = Promise.withResolvers<void>();
		const batchObserved = Promise.withResolvers<string>();
		let invocation = 0;
		const mock = createMockModel({
			handler: async context => {
				invocation++;
				if (invocation === 2) {
					busyStarted.resolve();
					await releaseBusy.promise;
				}
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (
					text.includes("PROCESS EVENT TWO") &&
					text.includes("PROCESS EVENT THREE") &&
					text.includes("Supervised process watcher exited")
				) {
					batchObserved.resolve(text);
				}
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const sessionManager = SessionManager.inMemory();

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");
		const progress = (text: string, seq: number): DaemonOutputNotification => ({
			event: "daemon-output",
			monitorId: "monitor-1",
			name: "watcher",
			daemonId: "daemon-1",
			seq,
			text,
			batchKind: "progress",
			suppressedEvents: 0,
		});

		session.setLaunchMonitorActive("monitor-1", "wake", true);
		session.queueLaunchProgress(progress("PROCESS EVENT ONE", 1), "wake", Date.now());
		await busyStarted.promise;
		session.queueLaunchProgress(progress("PROCESS EVENT TWO", 2), "wake", Date.now());
		session.queueLaunchProgress(progress("PROCESS EVENT THREE", 3), "wake", Date.now());
		const completion = session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: "completion-1",
			owner: sessionManager.getSessionId(),
			daemon: {
				name: "watcher",
				id: "daemon-1",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: sessionManager.getSessionId(),
				persist: true,
				detached: false,
			},
		});
		session.setLaunchMonitorActive("monitor-1", "wake", false);
		expect(session.hasPendingAsyncWork()).toBe(true);
		releaseBusy.resolve();

		const batch = await batchObserved.promise;
		await completion;
		expect(batch.lastIndexOf("PROCESS EVENT TWO")).toBeLessThan(batch.lastIndexOf("PROCESS EVENT THREE"));
		expect(batch.lastIndexOf("PROCESS EVENT THREE")).toBeLessThan(
			batch.lastIndexOf("Supervised process watcher exited"),
		);
		expect(mock.calls).toHaveLength(3);
		expect(session.hasPendingAsyncWork()).toBe(false);
	}, 10_000);

	it("promotes queued ambient process output ahead of the launch completion", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressMarker = "AMBIENT PROCESS OUTPUT MARKER";
		const completionMarker = "Supervised process watcher exited";
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});

		// Ambient monitor output while the owner idles sits on the
		// skip-idle-flush queue without waking the session.
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "monitor-ambient",
				name: "watcher",
				daemonId: "daemon-ambient",
				seq: 1,
				text: progressMarker,
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
		);
		await Promise.resolve();
		expect(mock.calls).toHaveLength(0);

		// The terminal notification's idle flush must carry the queued ambient
		// output with it, ahead of the completion — not strand it for a later
		// out-of-order turn.
		await session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: "completion-ambient",
			owner: sessionManager.getSessionId(),
			daemon: {
				name: "watcher",
				id: "daemon-ambient",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: sessionManager.getSessionId(),
				persist: false,
				detached: false,
			},
		});
		await session.waitForIdle();

		const markerIndex = (messages: (typeof mock.calls)[number]["context"]["messages"], marker: string) =>
			messages.findIndex(message =>
				typeof message.content === "string"
					? message.content.includes(marker)
					: message.content.some(content => content.type === "text" && content.text.includes(marker)),
			);
		const followUp = mock.calls.find(call => markerIndex(call.context.messages, completionMarker) >= 0);
		if (!followUp) throw new Error("Launch completion follow-up never reached the model");
		const progressIndex = markerIndex(followUp.context.messages, progressMarker);
		const completionIndex = markerIndex(followUp.context.messages, completionMarker);
		expect(progressIndex).toBeGreaterThanOrEqual(0);
		expect(completionIndex).toBeGreaterThan(progressIndex);
	}, 10_000);

	it("pushes wake progress into an idle session before the job completes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const marker = "WAKE PROGRESS BEFORE COMPLETION";
		const wakeObserved = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				const sawMarker = context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes(marker)
						: message.content.some(content => content.type === "text" && content.text.includes(marker)),
				);
				if (sawMarker) wakeObserved.resolve();
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		await session.sendUserMessage("initialize then wait");
		expect(mock.calls).toHaveLength(1);

		const gate = Promise.withResolvers<string>();
		const reporter = Promise.withResolvers<(text: string) => void>();
		const jobId = manager.register(
			"bash",
			"wake progress job",
			async ({ reportAgentProgress }) => {
				reporter.resolve(reportAgentProgress);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);
		const report = await reporter.promise;
		report(marker);

		await wakeObserved.promise;
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(mock.calls).toHaveLength(2);

		manager.watchJobs([jobId]);
		gate.resolve("done");
		await manager.waitForAll();
	}, 10_000);

	it("batches every wake event queued while busy even when the job completes before the follow-up", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const busyStarted = Promise.withResolvers<void>();
		const releaseBusy = Promise.withResolvers<void>();
		const batchObserved = Promise.withResolvers<string>();
		let invocation = 0;
		const mock = createMockModel({
			handler: async context => {
				invocation += 1;
				if (invocation === 2) {
					busyStarted.resolve();
					await releaseBusy.promise;
				}
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (
					text.includes("BUSY EVENT TWO") &&
					text.includes("BUSY EVENT THREE") &&
					text.includes("BUSY COMPLETION AFTER EVENTS")
				)
					batchObserved.resolve(text);
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "busy batching job", () => gate.promise, {
			id: "busy-batch",
			ownerId: "Main",
			progressDelivery: "wake",
		});
		const job = manager.getJob("busy-batch");
		if (!job) throw new Error("Expected registered busy batching job");
		const progressEntry = (text: string, seq: number): AsyncProgressEntry => ({
			jobId: job.id,
			text,
			job,
			seq,
			elapsedMs: seq,
			epoch: 0,
			delivery: "wake",
		});

		session.yieldQueue.enqueue(ASYNC_PROGRESS_WAKE_QUEUE_KIND, progressEntry("BUSY EVENT ONE", 1));
		await busyStarted.promise;
		session.yieldQueue.enqueue(ASYNC_PROGRESS_WAKE_QUEUE_KIND, progressEntry("BUSY EVENT TWO", 2));
		session.yieldQueue.enqueue(ASYNC_PROGRESS_WAKE_QUEUE_KIND, progressEntry("BUSY EVENT THREE", 3));
		gate.resolve("BUSY COMPLETION AFTER EVENTS");
		await manager.waitForAll();
		releaseBusy.resolve();

		const batch = await batchObserved.promise;
		expect(batch.indexOf("BUSY EVENT TWO")).toBeLessThan(batch.indexOf("BUSY EVENT THREE"));
		expect(batch.indexOf("BUSY EVENT THREE")).toBeLessThan(batch.indexOf("BUSY COMPLETION AFTER EVENTS"));
		expect(mock.calls).toHaveLength(3);
		expect(manager.getJob(job.id)?.status).toBe("completed");
	}, 10_000);

	it("drops late progress from a prior session after its job id is reused", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		expect(await session.newSession()).toBe(true);

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "reused progress job", () => gate.promise, { id: "reused-job", ownerId: "Main" });
		const job = manager.getJob("reused-job");
		if (!job) throw new Error("Expected registered reused job");
		session.yieldQueue.enqueue<AsyncProgressEntry>("async-progress", {
			jobId: job.id,
			text: "STALE PROGRESS MARKER",
			job,
			seq: 1,
			elapsedMs: 10,
			epoch: 0,
			delivery: "ambient",
		});

		await session.sendUserMessage("fresh turn");
		expect(
			mock.calls.every(call =>
				call.context.messages.every(message =>
					typeof message.content === "string"
						? !message.content.includes("STALE PROGRESS MARKER")
						: message.content.every(
								content => content.type !== "text" || !content.text.includes("STALE PROGRESS MARKER"),
							),
				),
			),
		).toBe(true);

		manager.watchJobs([job.id]);
		gate.resolve("done");
		await manager.waitForAll();
	});

	it("keeps the event loop live until a delayed idle flush runs", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});

		let flushed = false;
		session.yieldQueue.register("keepalive-probe", {
			isStale: () => {
				flushed = true;
				return true;
			},
			build: () => null,
		});
		vi.useFakeTimers();
		const baselineTimers = vi.getTimerCount();
		session.yieldQueue.enqueue("keepalive-probe", {});

		// The 1ms flush timer and a keepalive must both remain armed until the
		// flush runs. Without the keepalive, Bun can park here until unrelated
		// TTY I/O wakes the loop.
		expect(vi.getTimerCount()).toBeGreaterThanOrEqual(baselineTimers + 2);

		vi.advanceTimersByTime(1);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(flushed).toBe(true);
		expect(vi.getTimerCount()).toBe(baselineTimers + 1);
	});

	it("summarizes artifact-backed progress without replaying byte-identical terminal text", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressObserved = Promise.withResolvers<void>();
		const completionObserved = Promise.withResolvers<string>();
		const mock = createMockModel({
			handler: context => {
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (text.includes("FULL RESULT BODY MUST NOT REAPPEAR")) progressObserved.resolve();
				if (text.includes("Resume your work using the result below")) completionObserved.resolve(text);
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");

		const gate = Promise.withResolvers<string>();
		const reporter = Promise.withResolvers<(text: string, info?: { artifactId?: string }) => void>();
		manager.register(
			"bash",
			"summarized job",
			async ({ reportAgentProgress }) => {
				reporter.resolve(reportAgentProgress);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);
		const report = await reporter.promise;
		report("FULL RESULT BODY MUST NOT REAPPEAR", { artifactId: "77" });
		await progressObserved.promise;

		report("LEFTOVER LINE", { artifactId: "77" });
		gate.resolve("FULL RESULT BODY MUST NOT REAPPEAR");
		await manager.waitForAll();

		const completion = await completionObserved.promise;
		expect(completion).toContain("artifact://77");
		expect(completion).toContain("LEFTOVER LINE");
		// The terminal result is identical to the already-delivered cumulative
		// progress and therefore appears only in progress history, not again in
		// the completion's <result> block.
		expect(completion.split("FULL RESULT BODY MUST NOT REAPPEAR")).toHaveLength(2);
	}, 10_000);

	it("preserves a successful post-processed terminal result beside its progress artifact", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressObserved = Promise.withResolvers<void>();
		const completionObserved = Promise.withResolvers<string>();
		const mock = createMockModel({
			handler: context => {
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (text.includes("RAW STREAMED OUTPUT")) progressObserved.resolve();
				if (text.includes("Resume your work using the result below")) completionObserved.resolve(text);
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");

		const gate = Promise.withResolvers<string>();
		const reporter = Promise.withResolvers<(text: string, info?: { artifactId?: string }) => void>();
		manager.register(
			"bash",
			"post-processed successful job",
			async ({ reportAgentProgress }) => {
				reporter.resolve(reportAgentProgress);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);
		const report = await reporter.promise;
		report("RAW STREAMED OUTPUT", { artifactId: "78" });
		await progressObserved.promise;

		// This successful terminal text was synthesized after streaming (the
		// Bash minimizer has the same shape) and never traversed progress.
		gate.resolve("MINIMIZED\tSUCCESS OUTPUT");
		await manager.waitForAll();

		const completion = await completionObserved.promise;
		expect(completion).toContain("artifact://78");
		expect(completion).toContain("MINIMIZED\tSUCCESS OUTPUT");
		expect(completion).not.toContain("MINIMIZED   SUCCESS OUTPUT");
	}, 10_000);

	it("folds a failed artifact-backed job's never-progressed error into the completion", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressObserved = Promise.withResolvers<void>();
		const completionObserved = Promise.withResolvers<string>();
		const mock = createMockModel({
			handler: context => {
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (text.includes("DELIVERED PROGRESS LINE")) progressObserved.resolve();
				if (text.includes("Resume your work using the result below")) completionObserved.resolve(text);
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");

		const gate = Promise.withResolvers<never>();
		const reporter = Promise.withResolvers<(text: string, info?: { artifactId?: string }) => void>();
		manager.register(
			"bash",
			"failing summarized job",
			async ({ reportAgentProgress }) => {
				reporter.resolve(reportAgentProgress);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);
		const report = await reporter.promise;
		report("DELIVERED PROGRESS LINE", { artifactId: "88" });
		await progressObserved.promise;

		// The failure text never flows through reportAgentProgress — it must
		// still reach the completion instead of being dropped with the
		// already-delivered stream.
		gate.reject(new Error("TERMINAL SPAWN FAILURE NEVER PROGRESSED"));
		await manager.waitForAll();

		const completion = await completionObserved.promise;
		expect(completion).toContain("artifact://88");
		expect(completion).toContain("failed");
		expect(completion).toContain("TERMINAL SPAWN FAILURE NEVER PROGRESSED");
	}, 10_000);
});
