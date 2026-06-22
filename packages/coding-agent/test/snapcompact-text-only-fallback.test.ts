/**
 * Regression test for the snapcompact compaction strategy when the ACTIVE model
 * is text-only (e.g. `umans-glm-5.2`, whose `input` is `["text"]` because Umans
 * reports `supports_vision: "via-handoff"` and rejects inline image blocks with
 * an HTTP 400 — see PR #3186 / issue #3184).
 *
 * Contract: snapcompact renders discarded history onto dense bitmap image frames
 * that the ACTIVE model must read back, so it requires a vision-capable active
 * model. When the active model is text-only, snapcompact MUST degrade cleanly to
 * a context-full LLM summary — it must never invoke the snapcompact rasterizer
 * and must never attach image frames to the post-compaction provider request
 * (which would otherwise 400 against a text-only model). The user is warned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

const CONTINUE_MARKER = "Resume work on the user's most recent intent";

type ContentBlock = TextContent | ImageContent;

interface ObservedCall {
	messageTexts: string[];
	hasImageBlock: boolean;
}

function isTextContentBlock(value: unknown): value is TextContent {
	if (!value || typeof value !== "object") return false;
	return (value as TextContent).type === "text" && typeof (value as TextContent).text === "string";
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(isTextContentBlock).map(block => block.text).join("\n");
}

/** True if any content block in any message is an image frame. */
function requestHasImageBlock(messages: AgentMessage[]): boolean {
	for (const message of messages) {
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		for (const block of message.content as ContentBlock[]) {
			if (block && typeof block === "object" && block.type === "image") return true;
		}
	}
	return false;
}

function createAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "umans-glm-5.2",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** Short-circuit the context-full LLM summary so compaction completes offline. */
function stubCompaction(): void {
	vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
		summary: "compacted into a text summary",
		shortSummary: undefined,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: {},
	}));
}

/** Emit an assistant turn whose usage is ~90% of the model window to fire the threshold. */
function emitHighUsageTurn(session: AgentSession, contextWindow: number): void {
	const highUsage = Math.floor(contextWindow * 0.9);
	const assistantMsg = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done." }],
		api: "anthropic-messages" as const,
		provider: "umans" as const,
		model: "umans-glm-5.2",
		stopReason: "stop" as const,
		usage: {
			input: highUsage,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: highUsage,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
}

describe("AgentSession snapcompact strategy with a text-only active model (umans-glm-5.2)", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-snapcompact-text-only-fallback-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("degrades to a context-full LLM summary without invoking the snapcompact rasterizer", async () => {
		const observedCalls: ObservedCall[] = [];
		const waiters: Array<{
			predicate: (call: ObservedCall) => boolean;
			resolve: (call: ObservedCall) => void;
		}> = [];

		const model = getBundledModel("umans", "umans-glm-5.2");
		if (!model) throw new Error("Expected umans-glm-5.2 model to exist in the bundled catalog");
		// The whole premise: this model is text-only (PR #3186).
		expect(model.input).toEqual(["text"]);

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		// A runtime key is needed so #compactWithFallbackModel reaches the stubbed
		// `compact()` (the getApiKey gate precedes the call).
		authStorage.setRuntimeApiKey("umans", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": true,
			"compaction.strategy": "snapcompact",
			"task.eager": "default",
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		// Capture every provider request the agent makes, including the
		// post-compaction continuation, so we can prove no image frames leaked.
		const captureRequest = (messages: AgentMessage[]): ObservedCall => {
			const call: ObservedCall = {
				messageTexts: messages.map(getMessageText),
				hasImageBlock: requestHasImageBlock(messages),
			};
			observedCalls.push(call);
			for (let i = waiters.length - 1; i >= 0; i--) {
				const waiter = waiters[i];
				if (waiter && waiter.predicate(call)) {
					waiter.resolve(call);
					waiters.splice(i, 1);
				}
			}
			return call;
		};

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context) => {
				captureRequest(context.messages);
				const response = createAssistantResponse("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		// Collect session events: the warning notice + the compaction action.
		const notices: { level: string; message: string; source?: string }[] = [];
		const compactionActions: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			} else if (event.type === "auto_compaction_start") {
				compactionActions.push(event.action);
			}
		});

		const waitForCall = (predicate: (call: ObservedCall) => boolean) => {
			const existing = observedCalls.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<ObservedCall>();
			waiters.push({ predicate, resolve });
			return promise;
		};

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});

		// Spy on the snapcompact rasterizer — it must never run for a text-only model.
		const snapcompactCompactSpy = vi.spyOn(snapcompact, "compact");
		stubCompaction();

		// Seed a turn of history so there is something to compact.
		await session.prompt("do some work that builds up context");

		// Fire threshold auto-compaction (snapcompact strategy, text-only model).
		emitHighUsageTurn(session, model.contextWindow);

		// Wait for the post-compaction continuation turn to be sent to the model.
		const continuation = await waitForCall(call =>
			call.messageTexts.some(text => text.includes(CONTINUE_MARKER)),
		);

		// 1. The snapcompact rasterizer was never invoked (vision gate held).
		expect(snapcompactCompactSpy).not.toHaveBeenCalled();

		// 2. The strategy degraded to a context-full summary, not snapcompact.
		expect(compactionActions).toContain("context-full");
		expect(compactionActions).not.toContain("snapcompact");

		// 3. The user was warned that the active model is text-only.
		expect(
			notices.some(
				n =>
					n.level === "warning" &&
					n.message.includes("vision-capable model") &&
					n.message.includes("text-only") &&
					n.message.includes("umans-glm-5.2"),
			),
		).toBe(true);

		// 4. No image frames leaked into the post-compaction provider request
		//    (sending them to a text-only model would 400 — issue #3184).
		expect(continuation.hasImageBlock).toBe(false);
	});
});
