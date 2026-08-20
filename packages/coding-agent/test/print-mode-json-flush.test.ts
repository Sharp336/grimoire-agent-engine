/**
 * Regression (#7635): `--mode json` must not exit until every stdout record
 * has fully drained.
 *
 * The JSON path emitted each event with a fire-and-forget `process.stdout.write`
 * and relied on an empty-write "flush barrier" before dispose/exit. The barrier
 * awaited its own callback, not the preceding large write, so a big
 * `agent_end` (multi-MB) could be truncated when the process exited before the
 * pipe drained — while still exiting 0. The fix serializes every print-mode
 * stdout write on its own completion callback and blocks shutdown on the tail.
 *
 * Contract: `runPrintMode` stays pending until a backpressured `agent_end`
 * write finishes, then emits one final canonical `session_result` record.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { UsageStatistics } from "@oh-my-pi/pi-coding-agent/session/session-entries";

interface FlushHarness {
	session: AgentSession;
	promptStarted: Promise<void>;
	resolvePrompt: () => void;
	emit: (event: AgentSessionEvent) => void;
	setUsage: (usage: UsageStatistics) => void;
	disposed: () => boolean;
}

function createFlushHarness(): FlushHarness {
	const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
	const { promise: promptReleased, resolve: resolvePrompt } = Promise.withResolvers<void>();
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	let disposed = false;
	let advisorDrainPrepared = false;
	let usage: UsageStatistics = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
	};

	const session = {
		sessionManager: {
			getHeader: () => ({ id: "session-flush-test" }),
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
			getUsageStatistics: () => ({ ...usage }),
		},
		sessionId: "session-flush-test",
		settings: { get: () => false },
		extensionRunner: undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			subscriber = listener;
			return () => {};
		},
		prompt: async () => {
			markPromptStarted();
			await promptReleased;
			return true;
		},
		prepareForHeadlessAdvisorDrain: () => {
			advisorDrainPrepared = true;
		},
		waitForAdvisorCatchup: async () => {
			if (!advisorDrainPrepared) throw new Error("advisor catch-up started before headless delivery was armed");
		},
		dispose: async () => {
			disposed = true;
		},
	} as unknown as AgentSession;

	return {
		session,
		promptStarted,
		resolvePrompt,
		emit: event => subscriber?.(event),
		setUsage: next => {
			usage = { ...next };
		},
		disposed: () => disposed,
	};
}

function makeAssistant(payload: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: payload }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 5,
			output: 7,
			cacheRead: 11,
			cacheWrite: 13,
			totalTokens: 36,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		},
		stopReason: "aborted",
		errorMessage: "Deadline exceeded",
		errorStatus: 502,
		errorId: 17,
		errorDiagnostics: {
			kind: "premature_sse_close",
			httpStatus: 200,
			deepseekTraceId: "trace-ds-7",
			requestId: "request-x-7",
			decodedEventCount: 1,
			responseId: "chatcmpl-terminal",
			lastEventType: "chat.completion.chunk",
			sawContent: true,
			sawFinishReason: false,
			elapsedMs: 125,
		},
		timestamp: Date.now(),
	};
}

function makeLargeAgentEnd(message: AssistantMessage): AgentSessionEvent {
	return {
		type: "agent_end",
		messages: [message],
	};
}

describe("print-mode JSON flush (#7635)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits one final session_result after the complete agent_end record drains", async () => {
		const writes: string[] = [];
		let releaseAgentEnd: (() => void) | undefined;
		const { promise: agentEndWriteIssued, resolve: markAgentEndWriteIssued } = Promise.withResolvers<void>();
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
			writes.push(text);
			const cb = args[args.length - 1];
			const invoke = typeof cb === "function" ? (cb as (err?: Error | null) => void) : undefined;
			// Defer the large agent_end record's completion callback to emulate a
			// backpressured pipe; every other write completes synchronously.
			if (text.includes('"type":"agent_end"')) {
				releaseAgentEnd = () => invoke?.(null);
				markAgentEndWriteIssued();
			} else {
				invoke?.(null);
			}
			return true;
		});

		const payload = "x".repeat(1_500_000);
		const harness = createFlushHarness();

		const run = runPrintMode(harness.session, { mode: "json", initialMessage: "hello" });
		let settled = false;
		void run.then(() => {
			settled = true;
		});

		await harness.promptStarted;
		const assistant = makeAssistant(payload);
		harness.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 0,
			errorMessage: "transient",
		});
		harness.emit({ type: "message_end", message: assistant });
		harness.emit(makeLargeAgentEnd(assistant));
		harness.setUsage({
			input: 5,
			output: 7,
			cacheRead: 11,
			cacheWrite: 13,
			totalTokens: 36,
			orchestrationInput: 17,
			orchestrationOutput: 19,
			orchestrationCacheRead: 23,
			premiumRequests: 2,
			cost: 1,
		});
		harness.resolvePrompt();

		// Drain to quiescence: every step runPrintMode can complete without the
		// deferred write is microtask-driven, so one macrotask boundary flushes
		// them all. The pre-fix fire-and-forget path settles and disposes here;
		// the fix must still be blocked on the undrained agent_end write.
		await agentEndWriteIssued;
		const { promise: nextTask, resolve: resolveNextTask } = Promise.withResolvers<void>();
		setImmediate(resolveNextTask);
		await nextTask;
		expect(releaseAgentEnd).toBeDefined();
		expect(settled).toBe(false);
		expect(harness.disposed()).toBe(false);

		releaseAgentEnd?.();
		await run;

		expect(settled).toBe(true);
		expect(harness.disposed()).toBe(true);

		const agentEndLine = writes.find(line => line.includes('"type":"agent_end"'));
		expect(agentEndLine).toBeDefined();
		expect(agentEndLine?.endsWith("\n")).toBe(true);
		// The complete payload survives — not a pipe-buffer-sized prefix.
		expect(agentEndLine).toContain(payload);
		expect(JSON.parse(agentEndLine as string)).toMatchObject({ type: "agent_end" });

		const resultLine = writes.find(line => line.includes('"type":"session_result"'));
		expect(resultLine).toBeDefined();
		expect(writes.at(-1)).toBe(resultLine);
		expect(JSON.parse(resultLine as string)).toMatchObject({
			type: "session_result",
			schema: "omp.session-result/v1",
			sessionId: "session-flush-test",
			status: "aborted",
			stopReason: "aborted",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			result: payload,
			error: {
				message: "Deadline exceeded",
				status: 502,
				id: 17,
				diagnostics: {
					kind: "premature_sse_close",
					httpStatus: 200,
					deepseekTraceId: "trace-ds-7",
					requestId: "request-x-7",
					decodedEventCount: 1,
					responseId: "chatcmpl-terminal",
					lastEventType: "chat.completion.chunk",
					sawContent: true,
					sawFinishReason: false,
					elapsedMs: 125,
				},
			},
			usage: {
				inputTokens: 5,
				outputTokens: 7,
				cacheReadTokens: 11,
				cacheWriteTokens: 13,
				totalTokens: 36,
				orchestrationInputTokens: 17,
				orchestrationOutputTokens: 19,
				orchestrationCacheReadTokens: 23,
				premiumRequests: 2,
				costUsd: 1,
			},
			modelRequests: 1,
			retries: 1,
		});
	});
});
