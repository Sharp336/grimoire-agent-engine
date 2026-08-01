import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Reproduces two related bugs in the optimistic-row lifecycle around
 * `AgentSession#promptWithMessage`'s pre-flight chain (recovery/preflight
 * checks, bash/eval/irc flush, compaction check, plan/goal/vibe message
 * building, before_agent_start extension hook, auto-thinking classification)
 * that runs before `agent.prompt()` ever commits the user's message:
 *
 * 1. Escape racing this chain bumps `#promptGeneration` and bails out early
 *    with a plain `return` (no throw), so `session.prompt()` resolves
 *    normally with no `message_start`/`message_end` ever emitted and nothing
 *    persisted to the session/conversation tree — but the optimistic row
 *    `startPendingSubmission` painted must not be left dangling in
 *    `chatContainer` (must go through `detachOptimisticUserMessage`).
 * 2. The opposite case: once the REAL `message_start` for that exact text
 *    lands, `EventController`'s `wasOptimistic` branch calls
 *    `clearOptimisticUserMessage` to hand the row off to permanent history.
 *    That row already shows the correct final content, so this must NOT
 *    strip it from `chatContainer` too — the fix for (1) briefly collapsed
 *    both methods into one DOM-removing implementation, which erased every
 *    plain submission's own message from the transcript the instant its
 *    turn started streaming.
 */
describe("Esc-abort before agent.prompt() commits the message", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-esc-leak-");
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
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("removes the optimistic row from chatContainer, not just the bookkeeping array", async () => {
		// Simulate AgentSession#promptWithMessage's generation-bail-out: it
		// resolves `true` (as if the prompt were accepted) without ever calling
		// `agent.prompt()`, so no message_start/message_end fires and nothing is
		// persisted to the session — exactly what happens when abort() races the
		// pre-flight setup ahead of the model call.
		vi.spyOn(session, "prompt").mockResolvedValue(true);

		const input = mode.startPendingSubmission({ text: "hello" });
		expect(mode.chatContainer.children.length).toBe(1);
		(mode.ui.requestRender as Mock<() => void>).mockClear();

		await submitInteractiveInput(mode, session, input);

		expect(mode.loadingAnimation).toBeUndefined();
		expect(mode.chatContainer.children.length).toBe(0);
		// Regression: this cleanup branch mutated chat/loader state without ever
		// requesting a repaint, so the "Working... [esc]" loader stayed painted
		// on screen until some unrelated event happened to trigger a render.
		expect(mode.ui.requestRender).toHaveBeenCalled();
	});

	it("keeps the optimistic row on screen once its own message_start commits it", () => {
		// EventController's wasOptimistic branch calls clearOptimisticUserMessage()
		// when the real message_start for this exact text arrives. The row it
		// already painted IS the correct permanent render, so this must be a pure
		// bookkeeping reset — not a chatContainer mutation.
		mode.startPendingSubmission({ text: "hello" });
		expect(mode.chatContainer.children.length).toBe(1);

		mode.clearOptimisticUserMessage();

		expect(mode.chatContainer.children.length).toBe(1);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
	});

	it("removes the optimistic row when showError abandons the submission", () => {
		// The other half of the same contract, through the second call site that
		// needs it: showError() fires when the prompt throws before the message
		// could be committed (e.g. "No API key found"), so no real message_start
		// will ever arrive to replace the row it painted.
		mode.startPendingSubmission({ text: "hello" });
		expect(mode.chatContainer.children.length).toBe(1);
		const optimisticRow = mode.chatContainer.children[0];

		mode.showError("No API key found");

		// showError renders its own error output into the chat, so assert on the
		// row's identity rather than a child count: the abandoned optimistic row
		// specifically must be gone.
		expect(mode.chatContainer.children).not.toContain(optimisticRow);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
	});
});
