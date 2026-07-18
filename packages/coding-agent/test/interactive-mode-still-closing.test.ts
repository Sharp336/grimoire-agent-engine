/**
 * InteractiveMode.shutdown arms a 3s "Still closing…" status
 * before signal teardown and always clears the timer in finally.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, postmortem, TempDir } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("InteractiveMode.shutdown still-closing status", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-still-closing-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		// Avoid real terminal drain during unit test.
		mode.ui.terminal.drainInput = async () => {};
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		vi.useRealTimers();
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("shows Still closing… after 3s while teardown is still pending, then clears timer", async () => {
		vi.useFakeTimers();
		const statuses: string[] = [];
		vi.spyOn(mode, "showStatus").mockImplementation((message: string) => {
			statuses.push(message);
		});

		const teardownGate = Promise.withResolvers<void>();
		// Force the fallback dispose path (no #signalTeardown) so we control settle.
		vi.spyOn(session, "dispose").mockImplementation(async () => {
			await teardownGate.promise;
		});

		const shutdownPromise = mode.shutdown();
		await flushMicrotasks();
		expect(statuses).toEqual(["Closing session…"]);

		vi.advanceTimersByTime(2_999);
		await flushMicrotasks();
		expect(statuses).toEqual(["Closing session…"]);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(statuses).toEqual(["Closing session…", "Still closing… (flushing memory backend / network)"]);

		teardownGate.resolve();
		await shutdownPromise;

		// Timer must be cleared: advancing further must not re-fire status.
		const after = statuses.length;
		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		expect(statuses.length).toBe(after);
	});

	it("clears the still-closing timer when teardown finishes under 3s", async () => {
		vi.useFakeTimers();
		const statuses: string[] = [];
		vi.spyOn(mode, "showStatus").mockImplementation((message: string) => {
			statuses.push(message);
		});
		vi.spyOn(session, "dispose").mockResolvedValue(undefined);

		await mode.shutdown();
		expect(statuses).toEqual(["Closing session…"]);

		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(statuses).toEqual(["Closing session…"]);
	});

	it("persists a late post-prompt write before /exit quits", async () => {
		vi.useFakeTimers();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const lateWriteGate = Promise.withResolvers<void>();
		const order: string[] = [];
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const model = session.model;
		if (!model) throw new Error("expected session model");
		const lateWrite = lateWriteGate.promise.then(() => {
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "late-write-before-quit" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			order.push("write");
		});
		session.trackPostPromptTaskForTests(lateWrite);
		const originalClose = session.sessionManager.close.bind(session.sessionManager);
		session.sessionManager.close = async () => {
			await originalClose();
			order.push("close");
		};
		vi.spyOn(postmortem, "quit").mockImplementation(async () => {
			expect(fs.readFileSync(sessionFile, "utf8")).toContain("late-write-before-quit");
			order.push("quit");
		});

		const shutdownPromise = mode.shutdown();
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(postmortem.quit).not.toHaveBeenCalled();

		lateWriteGate.resolve();
		await shutdownPromise;

		expect(order).toEqual(["write", "close", "quit"]);
	});

	it("tolerates the expected Phase-B aggregate after session cleanup", async () => {
		const disposeError = new AggregateError([new Error("phase B boom")], "Session dispose subsystem failures");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(session, "dispose").mockRejectedValue(disposeError);

		await expect(mode.shutdown()).resolves.toBeUndefined();

		expect(postmortem.quit).toHaveBeenCalledWith(0);
		expect(warnSpy).toHaveBeenCalledWith("Failed to dispose interactive session during shutdown", {
			error: String(disposeError),
		});
	});
	it("exits non-zero when session storage close fails", async () => {
		const closeError = new Error("storage close failed");
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		vi.spyOn(session, "dispose").mockRejectedValue(closeError);

		await expect(mode.shutdown()).resolves.toBeUndefined();

		expect(postmortem.quit).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith("Failed to close interactive session storage during shutdown", {
			error: String(closeError),
		});
	});
});
