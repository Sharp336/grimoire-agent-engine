/**
 * Contract tests for extension `deliverAs: "aside"` on AgentSession.sendCustomMessage.
 *
 * Extension asides queue mid-turn, drain at agent step boundaries via the aside
 * provider, and flush stranded content without waking (unlike peer IRC).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	ASIDE_MESSAGE_DISCARD,
	type AsideMessage,
	type CommittableAsideMessage,
} from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

const ASIDE_TYPE = "extension-aside-test";

interface ParkedHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	streamStarted: Promise<void>;
}

const mockYieldParameters = type({
	result: type("unknown"),
	"type?": type("unknown"),
});

interface MockYieldDetails {
	status: "success";
	data?: unknown;
	type?: string | string[];
}

function asidePayload(content: string): {
	customType: string;
	content: string;
	display: boolean;
} {
	return { customType: ASIDE_TYPE, content, display: false };
}

function isExtensionAside(message: AgentMessage): boolean {
	return message.role === "custom" && (message as { customType?: string }).customType === ASIDE_TYPE;
}

function asideContent(message: AgentMessage): string | undefined {
	if (!isExtensionAside(message)) return undefined;
	const content = (message as CustomMessage).content;
	return typeof content === "string" ? content : undefined;
}

function takeDrainedExtensionAside(thunks: AsideMessage[]): CommittableAsideMessage {
	for (const entry of thunks) {
		const message = typeof entry === "function" ? entry() : entry;
		if (message?.role === "custom" && (message as CustomMessage).customType === ASIDE_TYPE) {
			return message;
		}
	}
	throw new Error("expected a drained extension aside");
}

describe("AgentSession extension deliverAs aside", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];
	let asideProvider: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-extension-aside-");
		asideProvider = undefined;
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await Bun.sleep(0);
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	function captureAsideProvider(agent: Agent): void {
		asideProvider = undefined;
		const originalSet = agent.setAsideMessageProvider.bind(agent);
		agent.setAsideMessageProvider = (fn): void => {
			if (fn !== undefined && asideProvider === undefined) asideProvider = fn;
			originalSet(fn);
		};
	}

	async function drainExtensionAsides(): Promise<CustomMessage[]> {
		if (!asideProvider) throw new Error("aside provider was never captured");
		const thunks = await asideProvider();
		const out: CustomMessage[] = [];
		for (const entry of thunks) {
			const message = typeof entry === "function" ? entry() : entry;
			if (!message) continue;
			if (message.role !== "custom") continue;
			if ((message as CustomMessage).customType !== ASIDE_TYPE) continue;
			out.push(message as CustomMessage);
		}
		return out;
	}

	function capturePersistedAsides(sessionManager: SessionManager): string[] {
		const persisted: string[] = [];
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === ASIDE_TYPE) {
				persisted.push(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return persisted;
	}

	async function createMockSession(
		responses: MockResponse[],
	): Promise<{ session: AgentSession; sessionManager: SessionManager; mock: MockModel }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		captureAsideProvider(agent);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const mockSession = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		session = mockSession;
		return { session: mockSession, sessionManager, mock };
	}

	async function createIdleSession(): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		captureAsideProvider(agent);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const idleSession = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		session = idleSession;
		return { session: idleSession, sessionManager };
	}

	async function createParkedSession(
		tailResponses: MockResponse[] = [],
		sessionManager: SessionManager = SessionManager.inMemory(),
	): Promise<ParkedHarness> {
		const started = Promise.withResolvers<void>();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				...tailResponses,
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		captureAsideProvider(agent);
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return { session, sessionManager, mock, streamStarted: started.promise };
	}

	function readYieldResultData(result: unknown): unknown {
		if (!result || typeof result !== "object" || !("data" in result)) return undefined;
		return result.data;
	}

	function isYieldType(value: unknown): value is string | string[] {
		return (
			typeof value === "string" ||
			(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
		);
	}

	function userMessageText(messages: AgentMessage[]): string[] {
		const out: string[] = [];
		for (const message of messages) {
			if (message.role !== "user") continue;
			const content = message.content;
			if (typeof content === "string") {
				out.push(content);
			} else {
				for (const part of content) if (part.type === "text") out.push(part.text);
			}
		}
		return out;
	}

	function createMockYieldTool(opts?: {
		onExecute?: () => void;
		gate?: Promise<void>;
	}): AgentTool<typeof mockYieldParameters, MockYieldDetails> {
		return {
			name: "work",
			label: "Work",
			description: "Mock non-terminal work tool",
			parameters: mockYieldParameters,
			execute: async (_toolCallId, params) => {
				opts?.onExecute?.();
				if (opts?.gate) await opts.gate;
				const details: MockYieldDetails = { status: "success", data: readYieldResultData(params.result) };
				if (isYieldType(params.type)) details.type = params.type;
				return {
					content: [{ type: "text", text: "Result submitted." }],
					details,
				};
			},
		};
	}

	function createWorkMockResponse(args: { result: { data: unknown }; type?: string | string[] }): MockResponse {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `call_work_${Snowflake.next()}`,
			name: "work",
			arguments: args,
		};
		return {
			content: [toolCall],
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	}

	async function createToolCycleSession(opts: {
		toolGate?: Promise<void>;
		onToolExecute?: () => void;
	}): Promise<{ session: AgentSession; sessionManager: SessionManager; mock: MockModel; toolStarted: Promise<void> }> {
		const toolStarted = Promise.withResolvers<void>();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				createWorkMockResponse({ result: { data: { ok: true } } }),
				{ content: ["done after aside fold"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [
					createMockYieldTool({
						onExecute: () => {
							toolStarted.resolve();
							opts.onToolExecute?.();
						},
						gate: opts.toolGate,
					}),
				],
			},
			streamFn: mock.stream,
		});
		captureAsideProvider(agent);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return { session, sessionManager, mock, toolStarted: toolStarted.promise };
	}

	it("queues a streaming aside without steering, following up, or waking prompt (case 1)", async () => {
		const { session: idleSession } = await createIdleSession();
		const promptSpy = vi.spyOn(idleSession.agent, "prompt").mockResolvedValue(undefined);
		const steerSpy = vi.spyOn(idleSession.agent, "steer");
		const followUpSpy = vi.spyOn(idleSession.agent, "followUp");
		Object.defineProperty(idleSession, "isStreaming", { value: true, configurable: true });

		await idleSession.sendCustomMessage(asidePayload("busy-path note"), { deliverAs: "aside" });

		expect(promptSpy).not.toHaveBeenCalled();
		expect(steerSpy).not.toHaveBeenCalled();
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(idleSession.agent.peekSteeringQueue()).toEqual([]);
		expect(idleSession.agent.peekFollowUpQueue()).toEqual([]);
		expect(await idleSession.agent.hasIrcInterrupts?.()).toBe(false);

		const drained = await drainExtensionAsides();
		expect(drained).toHaveLength(1);
		expect(asideContent(drained[0]!)).toBe("busy-path note");
		expect(idleSession.agent.state.messages.filter(isExtensionAside)).toEqual([]);
	});

	it("ignores triggerTurn while streaming and keeps the aside on the provider drain (case 1b)", async () => {
		const { session: parked, streamStarted } = await createParkedSession();
		const promptSpy = vi.spyOn(parked.agent, "prompt");
		const running = parked.prompt("do work");
		await streamStarted;

		await parked.sendCustomMessage(asidePayload("mid-turn aside"), {
			deliverAs: "aside",
			triggerTurn: true,
		});

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(parked.agent.peekSteeringQueue()).toEqual([]);
		expect(parked.agent.peekFollowUpQueue()).toEqual([]);
		const drained = await drainExtensionAsides();
		expect(drained.map(message => asideContent(message))).toEqual(["mid-turn aside"]);

		await parked.abort();
		await parked.waitForIdle();
		await running.catch(() => {});
	});

	it("ignores triggerTurn when the turn settles during aside image normalize (case 1c)", async () => {
		const normalizeGate = Promise.withResolvers<void>();
		const enteredNormalize = Promise.withResolvers<void>();
		let delayNormalize = false;
		const original = SessionProviderBoundary.prototype.normalizeAgentMessageImages;
		vi.spyOn(SessionProviderBoundary.prototype, "normalizeAgentMessageImages").mockImplementation(async function <
			T extends AgentMessage,
		>(this: SessionProviderBoundary, message: T): Promise<T> {
			if (delayNormalize) {
				enteredNormalize.resolve();
				await normalizeGate.promise;
			}
			return original.call(this, message) as Promise<T>;
		});

		const { session: parked, streamStarted } = await createParkedSession();
		const promptSpy = vi.spyOn(parked.agent, "prompt");
		const running = parked.prompt("do work");
		await streamStarted;
		expect(promptSpy).toHaveBeenCalledTimes(1);

		delayNormalize = true;
		const sendPromise = parked.sendCustomMessage(asidePayload("late aside"), {
			deliverAs: "aside",
			triggerTurn: true,
		});
		await enteredNormalize.promise;
		await parked.abort();
		await parked.waitForIdle();
		normalizeGate.resolve();
		await sendPromise;

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(parked.agent.state.messages.filter(isExtensionAside).map(asideContent)).toContain("late aside");

		await running.catch(() => {});
	});

	it("folds a queued aside at a stop yield boundary without steering (case 3)", async () => {
		const { session: stopSession, mock } = await createMockSession([
			{ content: ["first answer"], stopReason: "stop" },
			{ content: ["continued after aside"] },
		]);
		const steerSpy = vi.spyOn(stopSession.agent, "steer");

		let streamingAtInject: boolean | undefined;
		let injected = false;
		stopSession.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			streamingAtInject = stopSession.isStreaming;
			await stopSession.sendCustomMessage(asidePayload("stop boundary aside"), { deliverAs: "aside" });
		});

		await stopSession.prompt("hello");

		expect(streamingAtInject).toBe(true);
		expect(mock.calls.length).toBe(2);
		expect(steerSpy).not.toHaveBeenCalled();
		expect(stopSession.agent.peekSteeringQueue()).toEqual([]);
		expect(stopSession.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toContain(
			"stop boundary aside",
		);
	});

	it("folds a queued aside into context at a step boundary without steering or aborting tools (case 2)", async () => {
		const toolGate = Promise.withResolvers<void>();
		const { session: toolSession, mock, toolStarted } = await createToolCycleSession({ toolGate: toolGate.promise });
		const steerSpy = vi.spyOn(toolSession.agent, "steer");
		const abortSpy = vi.spyOn(toolSession.agent, "abort");

		const running = toolSession.prompt("run the yield tool");
		await toolStarted;
		await toolSession.sendCustomMessage(asidePayload("fold at boundary"), { deliverAs: "aside" });
		expect(steerSpy).not.toHaveBeenCalled();
		expect(abortSpy).not.toHaveBeenCalled();

		toolGate.resolve();
		await running;
		await toolSession.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(toolSession.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toContain(
			"fold at boundary",
		);
	});

	it("appends and persists an idle aside without starting a turn (case 4)", async () => {
		const { session: idleSession, sessionManager } = await createIdleSession();
		const persisted = capturePersistedAsides(sessionManager);
		const promptSpy = vi.spyOn(idleSession.agent, "prompt").mockResolvedValue(undefined);

		await idleSession.sendCustomMessage(asidePayload("idle context"), { deliverAs: "aside" });

		expect(promptSpy).not.toHaveBeenCalled();
		expect(idleSession.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toEqual([
			"idle context",
		]);
		expect(persisted).toEqual(["idle context"]);
		expect(await drainExtensionAsides()).toEqual([]);
	});

	it("starts a turn when idle aside is sent with triggerTurn (case 5)", async () => {
		const { session: idleSession } = await createIdleSession();
		const promptSpy = vi.spyOn(idleSession.agent, "prompt").mockResolvedValue(undefined);

		const started = await idleSession.sendCustomMessage(asidePayload("wake me"), {
			deliverAs: "aside",
			triggerTurn: true,
		});

		expect(started).toBe(true);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const promptedArg = promptSpy.mock.calls[0]?.[0];
		const prompted = Array.isArray(promptedArg) ? promptedArg[0] : promptedArg;
		expect(prompted && typeof prompted === "object" && "role" in prompted ? prompted.role : undefined).toBe("custom");
		if (prompted && typeof prompted === "object" && "role" in prompted && prompted.role === "custom") {
			expect(prompted.customType).toBe(ASIDE_TYPE);
			expect(asideContent(prompted)).toBe("wake me");
		}
	});

	it("flushes a stranded streaming aside into context without waking prompt (case 6)", async () => {
		const { session: parked, sessionManager, mock, streamStarted } = await createParkedSession();
		const persisted = capturePersistedAsides(sessionManager);
		const promptSpy = vi.spyOn(parked.agent, "prompt");
		const running = parked.prompt("do work");
		await streamStarted;

		await parked.sendCustomMessage(asidePayload("stranded aside"), { deliverAs: "aside" });
		await parked.abort({ reason: USER_INTERRUPT_LABEL });
		await parked.waitForIdle();
		await running.catch(() => {});

		expect(parked.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toEqual([
			"stranded aside",
		]);
		expect(persisted).toEqual(["stranded aside"]);
		expect(
			sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === ASIDE_TYPE),
		).toBe(true);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(mock.calls.length).toBe(1);
	});

	it("flushes a pending aside after Esc settle without waking (case 7)", async () => {
		const { session: parked, mock, streamStarted } = await createParkedSession();
		const running = parked.prompt("do work");
		await streamStarted;

		await parked.sendCustomMessage(asidePayload("survives interrupt"), { deliverAs: "aside" });
		await parked.abort({ reason: USER_INTERRUPT_LABEL });
		await parked.waitForIdle();
		await running.catch(() => {});

		expect(parked.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toEqual([
			"survives interrupt",
		]);
		expect(mock.calls.length).toBe(1);
	});

	it("does not flush a stranded aside ahead of a queued follow-up drain (case 8b)", async () => {
		const { session: stopSession, mock } = await createMockSession([
			{ content: ["first answer"], stopReason: "stop" },
			{ content: ["continued after follow-up"] },
		]);

		let injected = false;
		let allowAsideDrain = false;
		stopSession.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await stopSession.sendCustomMessage(asidePayload("settle aside"), { deliverAs: "aside" });
			const inner = asideProvider;
			if (!inner) throw new Error("aside provider was never captured");
			stopSession.agent.setAsideMessageProvider(() => {
				if (!allowAsideDrain) return [];
				return inner();
			});
		});

		const resumed = Promise.withResolvers<void>();
		let agentEnds = 0;
		stopSession.subscribe(event => {
			if (event.type !== "agent_end") return;
			agentEnds += 1;
			if (agentEnds === 1) {
				allowAsideDrain = true;
				stopSession.agent.followUp({
					role: "user",
					content: [{ type: "text", text: "then add the test" }],
					attribution: "user",
					timestamp: Date.now(),
				});
				return;
			}
			resumed.resolve();
		});

		await stopSession.prompt("hello");
		await resumed.promise;
		await stopSession.waitForIdle();

		expect(mock.calls.length).toBe(2);
		const continuationText = JSON.stringify(mock.calls[1].context.messages);
		expect(continuationText).toContain("settle aside");
		expect(continuationText).toContain("then add the test");
		const messages = stopSession.agent.state.messages;
		const asideIndex = messages.findIndex(message => asideContent(message) === "settle aside");
		const followUpIndex = messages.findIndex(message => {
			if (message.role !== "user") return false;
			const content = message.content;
			if (typeof content === "string") return content === "then add the test";
			return content.some(part => part.type === "text" && part.text === "then add the test");
		});
		expect(asideIndex).toBeGreaterThanOrEqual(0);
		expect(followUpIndex).toBeGreaterThan(asideIndex);
		expect(userMessageText([...stopSession.agent.peekFollowUpQueue()])).not.toContain("then add the test");
	});

	it("still flushes a stranded aside when a follow-up is queued (case 8)", async () => {
		const { session: parked, mock, streamStarted } = await createParkedSession();
		const running = parked.prompt("do work");
		await streamStarted;

		await parked.prompt("then add the test", { streamingBehavior: "followUp" });
		await parked.sendCustomMessage(asidePayload("independent aside"), { deliverAs: "aside" });
		await parked.abort({ reason: USER_INTERRUPT_LABEL });
		await parked.waitForIdle();
		await running.catch(() => {});

		expect(parked.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toEqual([
			"independent aside",
		]);
		expect(userMessageText([...parked.agent.peekFollowUpQueue()])).toContain("then add the test");
		expect(mock.calls.length).toBe(1);
	});

	it("drops pending asides on newSession without flushing into the fresh transcript (case 9)", async () => {
		const { session: parked, sessionManager, streamStarted } = await createParkedSession();
		const running = parked.prompt("do work");
		await streamStarted;

		await parked.sendCustomMessage(asidePayload("must not survive /new"), { deliverAs: "aside" });
		expect(parked.agent.state.messages.filter(isExtensionAside)).toEqual([]);

		await parked.newSession();
		await parked.waitForIdle();
		await running.catch(() => {});

		expect(parked.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		expect(
			sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === ASIDE_TYPE),
		).toBe(false);
	});

	it("drops pending asides on resetSessionContext without flushing into the cleared transcript (case 9i)", async () => {
		const {
			session: idleSession,
			sessionManager,
			mock,
		} = await createMockSession([{ content: ["fresh after clear"] }]);
		Object.defineProperty(idleSession, "isStreaming", { value: true, configurable: true });
		await idleSession.sendCustomMessage(asidePayload("must not survive /clear"), { deliverAs: "aside" });
		expect(idleSession.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		delete (idleSession as { isStreaming?: boolean }).isStreaming;

		const result = await idleSession.resetSessionContext();
		expect(result).toBeDefined();
		expect(await drainExtensionAsides()).toEqual([]);
		expect(idleSession.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		expect(
			sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === ASIDE_TYPE),
		).toBe(false);

		await idleSession.prompt("fresh");
		await idleSession.waitForIdle();
		expect(idleSession.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		expect(mock.calls.length).toBe(1);
	});

	it("queues an idle aside while compacting instead of appending immediately", async () => {
		const { session: idleSession } = await createIdleSession();
		let compacting = true;
		Object.defineProperty(idleSession, "isCompacting", { get: () => compacting, configurable: true });

		await idleSession.sendCustomMessage(asidePayload("compacting queued"), { deliverAs: "aside" });

		expect(idleSession.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		const drained = await drainExtensionAsides();
		expect(drained.map(message => asideContent(message))).toEqual(["compacting queued"]);

		compacting = false;
		await idleSession.sendCustomMessage(asidePayload("idle after compacting"), { deliverAs: "aside" });
		expect(idleSession.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toEqual([
			"idle after compacting",
		]);
	});

	it("drops pending asides on fork without flushing into the forked transcript (case 9c)", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const { session: parked, streamStarted } = await createParkedSession([], sessionManager);
		const running = parked.prompt("do work");
		await streamStarted;

		await parked.sendCustomMessage(asidePayload("must not survive fork"), { deliverAs: "aside" });
		expect(parked.agent.state.messages.filter(isExtensionAside)).toEqual([]);

		const forked = await parked.fork();
		expect(forked).toBe(true);
		await parked.abort();
		await parked.waitForIdle();
		await running.catch(() => {});

		expect(parked.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		expect(
			sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === ASIDE_TYPE),
		).toBe(false);
	});

	it("preserves pending asides when fork returns false without persisting (case 9e)", async () => {
		const { session: parked, streamStarted } = await createParkedSession();
		const running = parked.prompt("do work");
		await streamStarted;

		await parked.sendCustomMessage(asidePayload("survive failed fork"), { deliverAs: "aside" });
		expect(parked.agent.state.messages.filter(isExtensionAside)).toEqual([]);

		expect(await parked.fork()).toBe(false);

		const drained = await drainExtensionAsides();
		expect(drained.map(message => asideContent(message))).toEqual(["survive failed fork"]);

		await parked.abort();
		await parked.waitForIdle();
		await running.catch(() => {});
	});

	it("drops pending asides on switchSession without flushing into the target transcript (case 9b)", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		captureAsideProvider(agent);
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const active = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		session = active;

		sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		if (!previousSessionFile) throw new Error("expected a session file after seed message");

		const otherManager = SessionManager.create(tempDir.path(), tempDir.path());
		otherManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await otherManager.flush();
		const targetSessionFile = otherManager.getSessionFile();
		if (!targetSessionFile) throw new Error("expected target session file");
		await otherManager.close();

		Object.defineProperty(active, "isStreaming", { value: true, configurable: true });
		await active.sendCustomMessage(asidePayload("must not leak on switch"), { deliverAs: "aside" });

		const switched = await active.switchSession(targetSessionFile);
		expect(switched).toBe(true);
		await active.waitForIdle();

		expect(active.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		expect(
			sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === ASIDE_TYPE),
		).toBe(false);
	});

	it("drops asides injected after the first switchSession clear and before reconnect (case 9f)", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		captureAsideProvider(agent);
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const active = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		session = active;

		sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		await sessionManager.flush();

		const otherManager = SessionManager.create(tempDir.path(), tempDir.path());
		otherManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await otherManager.flush();
		const targetSessionFile = otherManager.getSessionFile();
		if (!targetSessionFile) throw new Error("expected target session file");
		await otherManager.close();

		Object.defineProperty(active, "isStreaming", { value: true, configurable: true });

		const setSessionFile = sessionManager.setSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async file => {
			await setSessionFile(file);
			await active.sendCustomMessage(asidePayload("must not leak after clear"), { deliverAs: "aside" });
		});

		const switched = await active.switchSession(targetSessionFile);
		expect(switched).toBe(true);
		await active.waitForIdle();

		expect(active.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		expect(await drainExtensionAsides()).toEqual([]);
	});

	it("restores pending asides when switchSession rolls back after clear (case 9d)", async () => {
		const { session: active, sessionManager } = await createIdleSession();
		Object.defineProperty(active, "isStreaming", { value: true, configurable: true });
		await active.sendCustomMessage(asidePayload("survive rollback"), { deliverAs: "aside" });
		expect(active.agent.state.messages.filter(isExtensionAside)).toEqual([]);

		const failure = new Error("switch failed");
		vi.spyOn(sessionManager, "setSessionFile").mockRejectedValueOnce(failure);

		await expect(active.switchSession(tempDir.join("missing-target.jsonl"))).rejects.toBe(failure);

		expect(active.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		const drained = await drainExtensionAsides();
		expect(drained.map(message => asideContent(message))).toEqual(["survive rollback"]);
	});

	function seedHandoffMessages(sessionManager: SessionManager): void {
		sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "seed-2", timestamp: 2 });
		const lastEntryId = sessionManager.getBranch().at(-1)?.id;
		if (!lastEntryId) throw new Error("expected seeded entry id");
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: compactionModule.DEFAULT_COMPACTION_SETTINGS,
		});
	}

	it("drops pending asides on successful handoff without flushing into the replacement transcript (case 9g)", async () => {
		const { session: active, sessionManager } = await createIdleSession();
		seedHandoffMessages(sessionManager);
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");

		Object.defineProperty(active, "isCompacting", { value: true, configurable: true });
		await active.sendCustomMessage(asidePayload("must not leak on handoff"), { deliverAs: "aside" });
		expect(active.agent.state.messages.filter(isExtensionAside)).toEqual([]);

		const result = await active.handoff();
		expect(result?.document).toBe("## Goal\nContinue");

		expect(active.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		expect(await drainExtensionAsides()).toEqual([]);
		expect(
			sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === ASIDE_TYPE),
		).toBe(false);
	});

	it("preserves pending asides when handoff is cancelled before the replacement session commits (case 9h)", async () => {
		const { session: active, sessionManager } = await createIdleSession();
		seedHandoffMessages(sessionManager);

		Object.defineProperty(active, "isCompacting", { value: true, configurable: true });
		await active.sendCustomMessage(asidePayload("survive cancelled handoff"), { deliverAs: "aside" });
		expect(active.agent.state.messages.filter(isExtensionAside)).toEqual([]);

		const controller = new AbortController();
		controller.abort();
		await expect(active.handoff(undefined, { signal: controller.signal })).rejects.toThrow("Handoff cancelled");

		expect(active.agent.state.messages.filter(isExtensionAside)).toEqual([]);
		const drained = await drainExtensionAsides();
		expect(drained.map(message => asideContent(message))).toEqual(["survive cancelled handoff"]);
	});

	it("flushes a pending aside on beginDispose instead of dropping it (case 10)", async () => {
		const { session: parked, streamStarted } = await createParkedSession();
		const running = parked.prompt("do work");
		await streamStarted;

		await parked.sendCustomMessage(asidePayload("dispose flush"), { deliverAs: "aside" });
		parked.beginDispose();

		expect(parked.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toEqual([
			"dispose flush",
		]);
		running.catch(() => {});
	});

	it("persists a drained-but-uncommitted aside on DISCARD without waking (case 11)", async () => {
		const { session: active, sessionManager } = await createIdleSession();
		const persisted = capturePersistedAsides(sessionManager);
		const promptSpy = vi.spyOn(active.agent, "prompt");
		Object.defineProperty(active, "isStreaming", { value: true, configurable: true });

		await active.sendCustomMessage(asidePayload("polled then discarded"), { deliverAs: "aside" });

		if (!asideProvider) throw new Error("aside provider was never captured");
		const extensionMessage = takeDrainedExtensionAside(await asideProvider());
		extensionMessage[ASIDE_MESSAGE_DISCARD]?.(
			new Error("Aside message was not committed before the agent loop ended"),
		);
		await Bun.sleep(0);

		expect(active.agent.state.messages.filter(isExtensionAside).map(message => asideContent(message))).toEqual([
			"polled then discarded",
		]);
		expect(persisted).toEqual(["polled then discarded"]);
		expect(await drainExtensionAsides()).toEqual([]);
		expect(promptSpy).not.toHaveBeenCalled();
	});
});
