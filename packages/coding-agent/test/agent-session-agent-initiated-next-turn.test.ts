import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession agent-initiated nextTurn context", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		if (authStorage) {
			authStorage.close();
			authStorage = undefined;
		}
		if (tempDir) {
			try {
				await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
			} catch (error) {
				if (!isBusyError(error)) throw error;
			}
			tempDir = undefined;
		}
		vi.restoreAllMocks();
	});

	function isBusyError(error: unknown): boolean {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "EBUSY"
		);
	}

	async function createSession(): Promise<{ session: AgentSession; firstTurnStarted: Promise<void> }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const firstTurnStarted = Promise.withResolvers<void>();
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					firstTurnStarted.resolve();
					abortSignal?.addEventListener(
						"abort",
						() => {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						},
						{ once: true },
					);
				});
				return stream;
			},
		});

		tempDir = path.join(os.tmpdir(), `pi-agent-initiated-next-turn-${Date.now()}-${Math.random()}`);
		await fs.mkdir(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		return { session, firstTurnStarted: firstTurnStarted.promise };
	}

	it("restores hidden nextTurn context when an agent-initiated prompt fails before acceptance", async () => {
		const { session: activeSession, firstTurnStarted } = await createSession();
		const firstPrompt = activeSession.prompt("First message");
		await firstTurnStarted;
		await activeSession.sendCustomMessage(
			{
				customType: "todo-error-reminder",
				content: "Fix the todo payload",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
		await activeSession.abort();
		await firstPrompt.catch(() => {});
		await activeSession.waitForIdle();

		const promptInputs: AgentMessage[][] = [];
		const promptSpy = vi.spyOn(activeSession.agent, "prompt");
		promptSpy.mockImplementationOnce(async messages => {
			promptInputs.push(Array.isArray(messages) ? messages : [messages as AgentMessage]);
			throw new Error("missing model");
		});

		await expect(
			activeSession.sendCustomMessage(
				{
					customType: "autonomous-continuation",
					content: "continue",
					display: false,
					attribution: "user",
				},
				{ deliverAs: "nextTurn", triggerTurn: true },
			),
		).rejects.toThrow("missing model");

		promptSpy.mockImplementationOnce(async messages => {
			promptInputs.push(Array.isArray(messages) ? messages : [messages as AgentMessage]);
		});

		await activeSession.sendCustomMessage(
			{
				customType: "autonomous-continuation",
				content: "continue again",
				display: false,
				attribution: "user",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);

		expect(promptInputs).toHaveLength(2);
		expect(
			promptInputs[1]?.some(message => {
				if (message.role !== "custom" || message.customType !== "todo-error-reminder") return false;
				if (typeof message.content === "string") return message.content.includes("Fix the todo payload");
				return message.content.some(
					content => content.type === "text" && content.text.includes("Fix the todo payload"),
				);
			}),
		).toBe(true);
	});
});
