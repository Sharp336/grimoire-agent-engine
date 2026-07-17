import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

/**
 * Regression coverage for the stop-time async-wake gate. Finite owned jobs
 * defer todo reminders and `session_stop` until their terminal delivery can
 * re-wake the loop. Persistent monitors do not defer those passes merely by
 * remaining alive; only an actually queued monitor event does. Prompt unwind
 * also must not look like pending async work, and events queued during unwind
 * must be re-armed once the outer prompt releases.
 */
describe("AgentSession todo reminder async-job deferral", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let manager: AsyncJobManager;
	let extensionRunner: ExtensionRunner;
	let gates: Array<PromiseWithResolvers<string>>;
	let reminderAttempts: number[];
	let firstReminderPromise: Promise<void>;
	let resolveFirstReminder: () => void;

	function textOnlyAssistantMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "paused at your instruction" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function emitTextOnlyStop(): void {
		const msg = textOnlyAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	/** Register a job that stays running until the returned resolver fires. */
	function registerGatedJob(
		ownerId: string,
		type: "bash" | "monitor" = "bash",
		persistent = false,
	): { jobId: string; resolve: () => void } {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		const jobId = manager.register(type, `gated ${type} owned by ${ownerId}`, async () => await gate.promise, {
			ownerId,
			persistent,
		});
		return { jobId, resolve: () => gate.resolve("done") };
	}

	/** Give the session incomplete todos so the stop-time reminder is armed. */
	function setIncompleteTodos(): void {
		session.setTodoPhases([
			{
				name: "Pending review",
				tasks: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
		]);
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-todo-reminder-async-jobs-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		manager = new AsyncJobManager({ onJobComplete: async () => {} });
		gates = [];
		extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.reminders": true,
				"todo.remindersMax": 3,
			}),
			modelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
			extensionRunner,
		});

		reminderAttempts = [];
		({ promise: firstReminderPromise, resolve: resolveFirstReminder } = Promise.withResolvers<void>());
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") {
				reminderAttempts.push(event.attempt);
				if (reminderAttempts.length === 1) resolveFirstReminder();
			}
		});
	});

	afterEach(async () => {
		// Unblock any still-gated job body so the manager can settle promptly.
		for (const gate of gates) gate.resolve("done");
		await session.dispose();
		manager.cancelAll();
		await manager.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("defers the reminder while an owned async job is running", async () => {
		setIncompleteTodos();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("does not defer for a running job owned by a different agent", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("OtherAgent");

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");

		expect(reminderAttempts).toEqual([1]);
	});

	it("fires the reminder on the next stop once the owned job completes and its delivery drains", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const job = registerGatedJob("Main");

		// While the job runs, the stop stays silent.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(reminderAttempts).toEqual([]);

		// Complete the job and drain its result delivery — nothing is left to
		// re-wake the loop, so the deferral must lift.
		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired after job drained");

		expect(reminderAttempts).toEqual([1]);
	});

	it("defers the session_stop hook pass while an owned async job is running", async () => {
		// No todo phases: the stop reaches the session_stop pass directly, and
		// only the async-wake gate can defer it.
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();
	});

	it("invokes session_stop exactly once on the next stop after the owned job drains", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const job = registerGatedJob("Main");

		// Deferred while the job is in flight.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();

		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("does not defer terminal processing for a suppressed staged completion", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const jobId = manager.register("bash", "stale staged result", async () => "done", { ownerId: "Main" });
		await manager.waitForAll();
		session.yieldQueue.register<{ jobId: string }>("async-result", {
			isStale: entry => manager.isDeliverySuppressed(entry.jobId),
			build: entries => ({
				role: "custom",
				customType: "async-result",
				content: entries.map(entry => entry.jobId).join("\n"),
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			}),
		});
		session.agent.state.isStreaming = true;
		session.yieldQueue.enqueue("async-result", { jobId });
		manager.acknowledgeDeliveries([jobId]);
		session.agent.state.isStreaming = false;

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "stale async result suppressed the todo reminder");

		expect(reminderAttempts).toEqual([1]);
	});

	it("does not mistake the current prompt unwind for pending async work", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			emitTextOnlyStop();
		});

		await session.prompt("finish the turn");
		await withTimeout(firstReminderPromise, 1000, "ordinary prompt unwind suppressed the todo reminder");

		expect(reminderAttempts).toEqual([1]);
	});

	it("re-schedules a monitor event queued during prompt unwind", async () => {
		const idleWake = Promise.withResolvers<void>();
		let idlePrompt: unknown;
		let promptCalls = 0;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			promptCalls++;
			if (promptCalls === 1) {
				session.agent.state.isStreaming = true;
				session.yieldQueue.enqueue("monitor-event", { text: "late event" });
				session.agent.state.isStreaming = false;
				emitTextOnlyStop();
				return;
			}
			idlePrompt = message;
			idleWake.resolve();
		});
		session.yieldQueue.register<{ text: string }>("monitor-event", {
			build: entries => ({
				role: "custom",
				customType: "monitor-event",
				content: entries.map(entry => entry.text).join("\n"),
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			}),
		});

		await session.prompt("start");
		await withTimeout(idleWake.promise, 1000, "queued monitor event did not re-wake after prompt unwind");

		expect(promptSpy).toHaveBeenCalledTimes(2);
		expect(idlePrompt).toEqual(
			expect.objectContaining({ role: "custom", customType: "monitor-event", content: "late event" }),
		);
		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();
	});

	it("defers for a live monitor and cancellation releases the reminder", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const monitor = registerGatedJob("Main", "monitor");

		emitTextOnlyStop();
		await session.waitForIdle();
		expect(reminderAttempts).toEqual([]);

		expect(manager.cancel(monitor.jobId, { ownerId: "Main" })).toBe(true);
		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired after monitor cancellation");
		expect(reminderAttempts).toEqual([1]);
	});

	it("does not defer the reminder for a persistent monitor with no queued event", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main", "monitor", true);

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "persistent monitor suppressed the todo reminder");

		expect(reminderAttempts).toEqual([1]);
	});

	it("does not defer session_stop for a persistent monitor with no queued event", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main", "monitor", true);

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("defers for a live monitor and completion releases the session_stop pass", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const monitor = registerGatedJob("Main", "monitor");

		emitTextOnlyStop();
		await session.waitForIdle();
		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();

		monitor.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});
});
