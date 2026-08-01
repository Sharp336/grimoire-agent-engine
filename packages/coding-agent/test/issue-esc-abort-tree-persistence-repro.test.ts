import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Effort, ModelUsageHealth } from "@oh-my-pi/pi-ai";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Installs a classifier mock that never resolves on its own -- it only
 * settles (by rejecting) once its own `AbortSignal` fires. Returns a promise
 * that resolves with that signal the instant the classifier is actually
 * invoked, so callers can await the real event instead of polling/sleeping.
 */
function mockHangingClassifier(): Promise<AbortSignal | undefined> {
	const { promise: signalCaptured, resolve: onSignalCaptured } = Promise.withResolvers<AbortSignal | undefined>();
	vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockImplementation((_text, options) => {
		const { promise, reject } = Promise.withResolvers<Effort>();
		options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
		onSignalCaptured(options.signal);
		return promise;
	});
	return signalCaptured;
}

/**
 * Same shape as {@link mockHangingClassifier}, for the *usage-aware preflight*
 * window instead: `#runUsageAwarePreflight` runs before every generation
 * checkpoint in the pre-flight chain and reports an abort as a plain `false`
 * return rather than letting the next checkpoint observe the bumped
 * generation, so it needs its own coverage.
 */
function mockHangingUsageHealth(storage: AuthStorage): Promise<AbortSignal | undefined> {
	const { promise: signalCaptured, resolve: onSignalCaptured } = Promise.withResolvers<AbortSignal | undefined>();
	vi.spyOn(storage, "getModelUsageHealth").mockImplementation((_provider, options) => {
		const { promise, reject } = Promise.withResolvers<ModelUsageHealth>();
		options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
		onSignalCaptured(options.signal);
		return promise;
	});
	return signalCaptured;
}

/**
 * Reproduces the original report: pressing Escape immediately after sending a
 * message races `AgentSession#promptWithMessage`'s pre-flight chain (see
 * `issue-esc-optimistic-leak-repro.test.ts` for the full chain description).
 * Patch 0009 fixed the UI-side symptoms (stuck optimistic row, frozen loader),
 * but the underlying bail-out still just `return`s -- the user's message never
 * reaches `agent.prompt()`, so it's never persisted via
 * `sessionManager.appendMessage()`. It has no node in the session tree at all,
 * so `/tree` can't reach it and there is nothing to undo: exactly the
 * "doesn't get added to the conversation tree so you can't undo it" bug.
 *
 * The auto-thinking classifier call is the realistic way this window gets hit
 * live (a several-hundred-ms local-model-load/classify round trip), so this
 * drives the race the same way the classifier-cancellation regression test in
 * `agent-session-role-thinking.test.ts` does: mock the classifier to hang
 * until its signal aborts, then call `session.abort()` while the prompt is
 * still inside that window.
 */
describe("Esc-abort before agent.prompt() still lands the message in the tree", () => {
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-esc-tree-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		settings = Settings.isolated();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		session.setThinkingLevel(AUTO_THINKING);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("commits the user message and an aborted assistant turn instead of discarding it", async () => {
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const signalCaptured = mockHangingClassifier();
		expect(session.isAutoThinking).toBe(true);

		const promptPromise = session.prompt("Say the word banana.");
		const signal = await signalCaptured;

		await session.abort({ reason: "test interrupt" });
		await promptPromise;

		expect(signal?.aborted).toBe(true);
		// The regression: this used to be `[]` -- the message vanished with no
		// trace, unreachable from `/tree` and impossible to undo.
		expect(session.messages).toHaveLength(2);
		const [userMessage, assistantMessage] = session.messages;
		if (userMessage?.role !== "user") throw new Error("Expected committed user message");
		expect(userMessage.content).toEqual([{ type: "text", text: "Say the word banana." }]);
		if (assistantMessage?.role !== "assistant") throw new Error("Expected committed assistant message");
		expect(assistantMessage.stopReason).toBe("aborted");
	});
	it("commits the message when the abort lands inside the usage-aware preflight", async () => {
		// `retry.usageAwareFallback` is off by default, which makes the preflight a
		// pair of setting reads; enabling it is what opens the real window (a
		// `getModelUsageHealth` round trip per fallback candidate).
		settings.set("retry.usageAwareFallback", true);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const signalCaptured = mockHangingUsageHealth(authStorage);

		const promptPromise = session.prompt("Say the word banana.");
		const signal = await signalCaptured;

		await session.abort({ reason: "test interrupt" });
		await promptPromise;

		expect(signal?.aborted).toBe(true);
		expect(session.messages).toHaveLength(2);
		const [userMessage, assistantMessage] = session.messages;
		if (userMessage?.role !== "user") throw new Error("Expected committed user message");
		expect(userMessage.content).toEqual([{ type: "text", text: "Say the word banana." }]);
		if (assistantMessage?.role !== "assistant") throw new Error("Expected committed assistant message");
		expect(assistantMessage.stopReason).toBe("aborted");
	});
});
