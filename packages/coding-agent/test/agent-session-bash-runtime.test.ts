/**
 * Behavior-pinning tests for the session-side bash API.
 *
 * These tests exercise only the public API surface of AgentSession:
 *   executeBash · recordBashResult · abortBash · isBashRunning · hasPendingBashMessages
 *
 * They must pass against the current (unmodified) agent-session.ts AND survive
 * the internal BashRuntime refactor, because they assert only observable
 * behaviour through the public contract — zero references to BashRuntime, #bash,
 * or any private field.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { MockModel as MockModelType, MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { BashExecutionMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stopReply(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

function findBashMessages(messages: readonly { role?: string }[]): BashExecutionMessage[] {
	return messages.filter((m): m is BashExecutionMessage => m.role === "bashExecution");
}

function findBashEntries(sessionManager: SessionManager): BashExecutionMessage[] {
	return sessionManager
		.getEntries()
		.filter((e): e is SessionMessageEntry => e.type === "message")
		.map(e => e.message)
		.filter((m): m is BashExecutionMessage => m.role === "bashExecution");
}

/** A minimal BashResult-shaped object for recordBashResult calls in tests. */
function syntheticResult(output: string, exitCode = 0) {
	return {
		output,
		exitCode,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("AgentSession bash runtime (public API)", () => {
	let tempDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let mock: MockModelType;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-bash-runtime-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
		});
		sessionManager = SessionManager.inMemory(tempDir);

		mock = createMockModel({
			handler: () => stopReply("done"),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		resetSettingsForTest();
	});

	// -------------------------------------------------------------------
	// Contract 1: executeBash while idle
	// -------------------------------------------------------------------
	it("executeBash returns output/exitCode and appends a bashExecution message immediately", async () => {
		const result = await session.executeBash("echo hello-world");

		expect(result.output).toContain("hello-world");
		expect(result.exitCode).toBe(0);

		// Message is in session.messages
		const bashMsgs = findBashMessages(session.messages);
		expect(bashMsgs.length).toBeGreaterThanOrEqual(1);

		const msg = bashMsgs[bashMsgs.length - 1]!;
		expect(msg.role).toBe("bashExecution");
		expect(msg.command).toBe("echo hello-world");
		expect(msg.output).toContain("hello-world");
		expect(msg.exitCode).toBe(0);
		expect(msg.timestamp).toBeGreaterThan(0);

		// Persisted via session manager
		const entries = findBashEntries(sessionManager);
		expect(entries.length).toBeGreaterThanOrEqual(1);
		expect(entries[entries.length - 1]!.command).toBe("echo hello-world");

		// No pending messages when idle
		expect(session.hasPendingBashMessages).toBe(false);
	});

	// -------------------------------------------------------------------
	// Contract 2: excludeFromContext
	// -------------------------------------------------------------------
	it("executeBash with excludeFromContext carries the flag on the recorded message", async () => {
		await session.executeBash("echo hidden", undefined, { excludeFromContext: true });

		const bashMsgs = findBashMessages(session.messages);
		const msg = bashMsgs[bashMsgs.length - 1]!;
		expect(msg.excludeFromContext).toBe(true);
	});

	// -------------------------------------------------------------------
	// Contract 3: deferred ordering while streaming
	// -------------------------------------------------------------------
	it("recordBashResult mid-stream defers the message; it appears after the next prompt()", async () => {
		// Push a handler onto the mock's extras queue. Because MockModel.stream
		// binds to `this`, the extras handler is consumed on the NEXT prompt
		// call (pullHandler checks extras before the fallback). The handler
		// fires inside the mock's async runMock, which runs while
		// #promptInFlightCount > 0 → isStreaming === true → record defers.
		mock.push(() => {
			// isStreaming is true at this point (#promptInFlightCount > 0)
			session.recordBashResult("echo deferred", syntheticResult("deferred-output"));
			return stopReply("streaming-turn");
		});

		// Before any prompt: nothing pending
		expect(session.hasPendingBashMessages).toBe(false);

		// First prompt: the extras handler runs, records bash mid-stream.
		// flushPendingMessages() runs at the START of the next prompt, so
		// after this prompt returns the message is still pending.
		await session.prompt("first turn");
		await session.waitForIdle();

		expect(session.hasPendingBashMessages).toBe(true);
		expect(findBashMessages(session.messages).some(m => m.command === "echo deferred")).toBe(false);

		// Second prompt: flushPendingMessages() fires at the top of
		// #promptWithMessage, draining the pending buffer → message appears.
		await session.prompt("second turn");
		await session.waitForIdle();

		expect(session.hasPendingBashMessages).toBe(false);
		expect(findBashMessages(session.messages).some(m => m.command === "echo deferred")).toBe(true);
		expect(findBashEntries(sessionManager).some(e => e.command === "echo deferred")).toBe(true);
	});

	// -------------------------------------------------------------------
	// Contract 4: abortBash mid-execution
	// -------------------------------------------------------------------
	it("abortBash cancels a running command; result has cancelled=true", async () => {
		// Not running before
		expect(session.isBashRunning).toBe(false);

		// Start a long command — fire-and-forget to observe mid-flight state.
		const resultPromise = session.executeBash("sleep 30");

		// Give the shell time to spawn so the abort controller is registered.
		await Bun.sleep(50);
		expect(session.isBashRunning).toBe(true);

		// Abort
		session.abortBash();

		const result = await resultPromise;
		expect(result.cancelled).toBe(true);
		expect(session.isBashRunning).toBe(false);
	});

	// -------------------------------------------------------------------
	// Contract 5: isBashRunning lifecycle
	// -------------------------------------------------------------------
	it("isBashRunning is false before, true during, false after a short command", async () => {
		expect(session.isBashRunning).toBe(false);

		// "during" can only be observed for a long-running command
		const resultPromise = session.executeBash("sleep 2");
		await Bun.sleep(50);
		expect(session.isBashRunning).toBe(true);

		// Abort so we don't wait the full 2 s
		session.abortBash();
		await resultPromise;

		expect(session.isBashRunning).toBe(false);
	});
});
