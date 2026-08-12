/**
 * Contract tests for extension `deliverAs: "aside"` on AgentSession.sendCustomMessage.
 *
 * Extension asides queue mid-turn, drain at agent step boundaries via the aside
 * provider, and flush stranded content without waking (unlike peer IRC).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
});
