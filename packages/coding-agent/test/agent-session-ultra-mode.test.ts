import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { Effort, type Model, type TextContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

const ULTRA_CONTEXT_TYPE = "ultra-mode-context";
const ULTRA_RESET_TYPE = "ultra-mode-reset";
const CONTINUE_MARKER = "Resume work on the user's most recent intent";

type ObservedPromptCall = {
	toolChoice: string | undefined;
	toolNames: string[];
	messageRoles: AgentMessage["role"][];
	messageTexts: string[];
	agentThinkingLevel: Effort | undefined;
};

type Harness = {
	session: AgentSession;
	sessionManager: SessionManager;
	observedCalls: ObservedPromptCall[];
	authStorage: AuthStorage;
	waitForCall: (predicate: (call: ObservedPromptCall) => boolean) => Promise<ObservedPromptCall>;
	releaseFirstResponse?: () => void;
};

function isTextContentBlock(value: unknown): value is TextContent {
	return Boolean(value && typeof value === "object" && (value as TextContent).type === "text");
}

function getToolChoiceName(choice: unknown): string | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	if (typeof choice !== "object" || !("type" in choice)) return undefined;
	const toolChoice = choice as { type?: string; name?: string; function?: { name?: string } };
	if (toolChoice.type === "tool") return toolChoice.name;
	if (toolChoice.type === "function") return toolChoice.name ?? toolChoice.function?.name;
	return undefined;
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(isTextContentBlock)
		.map(content => content.text)
		.join("\n");
}

function createAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-opus-4-7",
		stopReason: "stop" as const,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function modelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
	return model;
}
function toProviderEffort(level: ThinkingLevel | undefined): Effort | undefined {
	switch (level) {
		case undefined:
		case ThinkingLevel.Inherit:
		case ThinkingLevel.Off:
			return undefined;
		case ThinkingLevel.Ultra:
			return Effort.Max;
		case Effort.Minimal:
		case Effort.Low:
		case Effort.Medium:
		case Effort.High:
		case Effort.XHigh:
		case Effort.Max:
			return level;
	}
}

function createTool(name: string, label: string, customWireName?: string): AgentTool {
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: type({}),
		loadMode: name === "task" ? "discoverable" : "essential",
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		...(customWireName ? { customWireName } : {}),
	} as AgentTool;
}

function stubCompaction(): void {
	vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
		summary: "compacted summary",
		shortSummary: "compacted",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
	}));
}

function emitHighUsageTurn(session: AgentSession): void {
	const assistantMsg = {
		...createAssistantResponse("Done."),
		usage: {
			input: 190_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 191_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
}

describe("AgentSession Ultra mode orchestration", () => {
	let tempDir: TempDir;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-ultra-mode-");
		harnesses.length = 0;
	});

	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.session.dispose();
			harness.authStorage.close();
		}
		harnesses.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(
		options: {
			model?: Model;
			thinkingLevel?: ThinkingLevel;
			settingsOverride?: Record<string, unknown>;
			activeTask?: boolean;
			registerTask?: boolean;
			agentKind?: "main" | "sub";
			persisted?: boolean;
			sessionManager?: SessionManager;
			taskWireName?: string;
			holdFirstResponse?: boolean;
			requestedToolNames?: ReadonlySet<string>;
		} = {},
	): Promise<Harness> {
		let releaseFirstResponse: (() => void) | undefined;
		const observedCalls: ObservedPromptCall[] = [];
		const waiters: Array<{
			predicate: (call: ObservedPromptCall) => boolean;
			resolve: (call: ObservedPromptCall) => void;
		}> = [];
		const selectedModel = options.model ?? modelOrThrow("claude-opus-4-7");
		const model = { ...selectedModel, contextWindow: 200_000, maxTokens: 64_000 };
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${harnesses.length}.db`));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${harnesses.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			...options.settingsOverride,
		});
		const sessionManager =
			options.sessionManager ??
			(options.persisted
				? SessionManager.create(tempDir.path(), tempDir.path())
				: SessionManager.inMemory(tempDir.path()));
		const readTool = createTool("read", "Read");
		const taskTool = createTool("task", "Task", options.taskWireName);
		const tools = options.activeTask === true ? [readTool, taskTool] : [readTool];
		const toolRegistry = new Map<string, AgentTool>([[readTool.name, readTool]]);
		if (options.registerTask !== false) toolRegistry.set(taskTool.name, taskTool);

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: [],
				thinkingLevel: toProviderEffort(options.thinkingLevel),
			},
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, streamOptions) => {
				const call: ObservedPromptCall = {
					toolChoice: getToolChoiceName(streamOptions?.toolChoice),
					toolNames: (context.tools ?? []).map(tool => tool.name),
					messageRoles: context.messages.map(message => message.role),
					messageTexts: context.messages.map(message => getMessageText(message)),
					agentThinkingLevel: agent.state.thinkingLevel,
				};
				observedCalls.push(call);
				for (let i = waiters.length - 1; i >= 0; i--) {
					const waiter = waiters[i];
					if (waiter?.predicate(call)) {
						waiter.resolve(call);
						waiters.splice(i, 1);
					}
				}
				const response = createAssistantResponse("done");
				const stream = new AssistantMessageEventStream();
				if (options.holdFirstResponse && observedCalls.length === 1) {
					queueMicrotask(() => stream.push({ type: "start", partial: response }));
					releaseFirstResponse = () => {
						stream.push({ type: "done", reason: "stop", message: response });
					};
					return stream;
				}
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			thinkingLevel: options.thinkingLevel,
			agentKind: options.agentKind,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
			requestedToolNames: options.requestedToolNames,
		});

		const waitForCall = (predicate: (call: ObservedPromptCall) => boolean) => {
			const existing = observedCalls.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<ObservedPromptCall>();
			waiters.push({ predicate, resolve });
			return promise;
		};

		const harness = {
			session,
			sessionManager,
			observedCalls,
			authStorage,
			waitForCall,
			releaseFirstResponse: () => releaseFirstResponse?.(),
		};
		harnesses.push(harness);
		return harness;
	}

	function customEntries(session: AgentSession, customType: string) {
		return session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom_message" && entry.customType === customType);
	}

	it("keeps the Ultra selector in session state while lowering provider-facing state to max", async () => {
		const { session, observedCalls } = await createHarness({ thinkingLevel: ThinkingLevel.Ultra });

		expect(session.thinkingLevel).toBe(ThinkingLevel.Ultra);
		expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.Ultra);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Max);

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		const call = observedCalls[0];
		expect(call?.agentThinkingLevel).toBe(Effort.Max);
		expect(call?.toolChoice).toBeUndefined();
		expect(call?.toolNames).toContain("task");
		const modeText = call?.messageTexts.find(text => text.includes("meaningfully improves speed or quality")) ?? "";
		expect(modeText).toContain("proactively use `task`");
		expect(modeText).toContain("Keep work inline");
		expect(modeText).not.toMatch(/must fan|subagents are the default/i);
		expect(call?.messageTexts.join("\n")).not.toMatch(/\bultra\b/i);
		expect(customEntries(session, ULTRA_CONTEXT_TYPE)[0]).toMatchObject({
			display: false,
			attribution: "agent",
			details: expect.objectContaining({ status: "active", selector: "ultra" }),
		});
	});

	it("persists Ultra identity across a cold resume without leaking a provider Ultra effort", async () => {
		const first = await createHarness({ thinkingLevel: Effort.High, activeTask: true, persisted: true });
		first.session.setThinkingLevel(ThinkingLevel.Ultra);
		await first.session.prompt("map the project seams");
		const sessionFile = first.session.sessionFile;
		expect(sessionFile).toBeDefined();
		await first.session.sessionManager.flush();
		await first.session.dispose();

		const resumedSessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const resumed = await createHarness({
			thinkingLevel: Effort.Low,
			activeTask: true,
			persisted: true,
			sessionManager: resumedSessionManager,
		});

		expect(await resumed.session.switchSession(sessionFile!)).toBe(true);
		expect(resumed.session.thinkingLevel).toBe(ThinkingLevel.Ultra);
		expect(resumed.session.configuredThinkingLevel()).toBe(ThinkingLevel.Ultra);
		expect(resumed.session.agent.state.thinkingLevel).toBe(Effort.Max);

		await resumed.session.prompt("continue after resume");
		const call = resumed.observedCalls.at(-1);
		expect(call?.agentThinkingLevel).toBe(Effort.Max);
		expect(call?.messageTexts.join("\n")).not.toMatch(/\bultra\b/i);
		expect(call?.messageTexts.some(text => text.includes("meaningfully improves speed or quality"))).toBe(true);
	});

	it("degrades Ultra on a model without max and emits exactly one standing-policy reset", async () => {
		const { session, observedCalls } = await createHarness({ thinkingLevel: ThinkingLevel.Ultra, activeTask: true });
		await session.prompt("parallelize the first pass");
		expect(customEntries(session, ULTRA_CONTEXT_TYPE)).toHaveLength(1);

		await session.setModel(modelOrThrow("claude-sonnet-4-5"));
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.configuredThinkingLevel()).toBe(Effort.XHigh);
		expect(session.agent.state.thinkingLevel).toBe(Effort.XHigh);

		observedCalls.length = 0;
		await session.prompt("continue on the downgraded model");

		const resetEntries = customEntries(session, ULTRA_RESET_TYPE);
		expect(resetEntries).toHaveLength(1);
		expect(resetEntries[0]).toMatchObject({
			display: false,
			attribution: "agent",
			details: expect.objectContaining({ status: "reset", reason: "selector-inactive" }),
		});
		const resetText = observedCalls[0]?.messageTexts.find(text => text.includes("no longer applies")) ?? "";
		expect(resetText).toContain("standing task guidance");
		expect(resetText).not.toMatch(/explicit[- ]request[- ]only|\bultra\b/i);
		expect(customEntries(session, ULTRA_CONTEXT_TYPE)).toHaveLength(1);

		observedCalls.length = 0;
		await session.prompt("one more downgraded turn");
		expect(customEntries(session, ULTRA_RESET_TYPE)).toHaveLength(1);
	});

	it("does not inject implicit mode context for max, subagents, missing task, or explicit task.eager", async () => {
		const cases: Array<Parameters<typeof createHarness>[0]> = [
			{ thinkingLevel: Effort.Max },
			{ thinkingLevel: ThinkingLevel.Ultra, agentKind: "sub", activeTask: true },
			{ thinkingLevel: ThinkingLevel.Ultra, registerTask: false },
			{ thinkingLevel: ThinkingLevel.Ultra, settingsOverride: { "task.eager": "default" } },
		];

		for (const options of cases) {
			const { session, observedCalls } = await createHarness(options);
			await session.prompt("refactor the parser across modules");
			const call = observedCalls[0];
			expect(call?.messageTexts.some(text => text.includes("meaningfully improves speed or quality"))).toBe(false);
			expect(customEntries(session, ULTRA_CONTEXT_TYPE)).toHaveLength(0);
			expect(customEntries(session, ULTRA_RESET_TYPE)).toHaveLength(0);
		}
	});

	it("re-injects the conditional mode context after compaction without forcing task", async () => {
		const { session, waitForCall } = await createHarness({
			thinkingLevel: ThinkingLevel.Ultra,
			activeTask: true,
			settingsOverride: {
				"compaction.enabled": true,
				"compaction.autoContinue": true,
				"compaction.strategy": "context-full",
			},
		});
		stubCompaction();

		await session.prompt("refactor the parser across modules");
		emitHighUsageTurn(session);
		const continuation = await waitForCall(call => call.messageTexts.some(text => text.includes(CONTINUE_MARKER)));

		expect(continuation.toolChoice).toBeUndefined();
		expect(continuation.messageTexts.some(text => text.includes("meaningfully improves speed or quality"))).toBe(
			true,
		);
		expect(continuation.messageTexts.join("\n")).not.toMatch(/\bultra\b/i);
	});

	it("queues the mode context with a streaming follow-up when task is already active", async () => {
		const { session, waitForCall, releaseFirstResponse } = await createHarness({
			thinkingLevel: ThinkingLevel.Ultra,
			activeTask: true,
			holdFirstResponse: true,
		});

		const first = session.prompt("start a long root turn");
		await waitForCall(call => call.messageTexts.includes("start a long root turn"));
		await session.prompt("queue more parallel work", { streamingBehavior: "followUp" });
		releaseFirstResponse?.();
		await first;

		const followUp = await waitForCall(call => call.messageTexts.includes("queue more parallel work"));
		expect(followUp.messageTexts.some(text => text.includes("meaningfully improves speed or quality"))).toBe(true);
		expect(followUp.toolChoice).toBeUndefined();
	});

	it("routes Ultra transitions through synthetic and custom root turns", async () => {
		const { session, observedCalls } = await createHarness({ thinkingLevel: ThinkingLevel.Ultra, activeTask: true });

		await session.promptCustomMessage({
			customType: "rpc-root",
			content: "custom root work",
			display: false,
			attribution: "user",
		});

		expect(observedCalls[0]?.messageTexts.some(text => text.includes("meaningfully improves speed or quality"))).toBe(
			true,
		);
		expect(customEntries(session, ULTRA_CONTEXT_TYPE)).toHaveLength(1);

		observedCalls.length = 0;
		await session.prompt("agent-only maintenance", { synthetic: true });
		expect(customEntries(session, ULTRA_CONTEXT_TYPE)).toHaveLength(1);

		await session.setModel(modelOrThrow("claude-sonnet-4-5"));
		observedCalls.length = 0;
		await session.prompt("synthetic user continuation", { synthetic: true, attribution: "user" });

		expect(customEntries(session, ULTRA_RESET_TYPE)).toHaveLength(1);
		expect(observedCalls[0]?.messageTexts.some(text => text.includes("no longer applies"))).toBe(true);
	});

	it("re-resolves Ultra mode for queued streaming turns before execution", async () => {
		const activated = await createHarness({ thinkingLevel: Effort.Max, holdFirstResponse: true });
		const firstActivationTurn = activated.session.prompt("start without ultra");
		await activated.waitForCall(call => call.messageTexts.includes("start without ultra"));
		activated.session.setThinkingLevel(ThinkingLevel.Ultra);
		await activated.session.prompt("queued after ultra activation", { streamingBehavior: "followUp" });
		activated.releaseFirstResponse?.();
		await firstActivationTurn;

		const activatedFollowUp = await activated.waitForCall(call =>
			call.messageTexts.includes("queued after ultra activation"),
		);
		expect(activatedFollowUp.toolNames).toContain("task");
		expect(activatedFollowUp.messageTexts.some(text => text.includes("meaningfully improves speed or quality"))).toBe(
			true,
		);
		expect(customEntries(activated.session, ULTRA_CONTEXT_TYPE)).toHaveLength(1);

		const downgraded = await createHarness({
			thinkingLevel: ThinkingLevel.Ultra,
			activeTask: true,
			holdFirstResponse: true,
		});
		const firstDowngradedTurn = downgraded.session.prompt("start ultra turn");
		await downgraded.waitForCall(call => call.messageTexts.includes("start ultra turn"));
		await downgraded.session.prompt("queued after downgrade", { streamingBehavior: "followUp" });
		downgraded.session.setThinkingLevel(Effort.Max);
		downgraded.releaseFirstResponse?.();
		await firstDowngradedTurn;

		await downgraded.waitForCall(call => call.messageTexts.some(text => text.includes("no longer applies")));
		await downgraded.waitForCall(call => call.messageTexts.includes("queued after downgrade"));
		expect(customEntries(downgraded.session, ULTRA_CONTEXT_TYPE)).toHaveLength(1);
		expect(customEntries(downgraded.session, ULTRA_RESET_TYPE)).toHaveLength(1);

		const explicitEager = await createHarness({
			thinkingLevel: ThinkingLevel.Ultra,
			activeTask: true,
			holdFirstResponse: true,
		});
		const firstExplicitEagerTurn = explicitEager.session.prompt("start ultra before explicit eager");
		await explicitEager.waitForCall(call => call.messageTexts.includes("start ultra before explicit eager"));
		await explicitEager.session.prompt("queued after explicit eager", { streamingBehavior: "followUp" });
		explicitEager.session.settings.set("task.eager", "default");
		explicitEager.releaseFirstResponse?.();
		await firstExplicitEagerTurn;

		await explicitEager.waitForCall(call => call.messageTexts.some(text => text.includes("no longer applies")));
		await explicitEager.waitForCall(call => call.messageTexts.includes("queued after explicit eager"));
		expect(customEntries(explicitEager.session, ULTRA_CONTEXT_TYPE)).toHaveLength(1);
		expect(customEntries(explicitEager.session, ULTRA_RESET_TYPE)).toHaveLength(1);
	});

	it("does not force Ultra task activation when requested tools exclude task", async () => {
		const { session, observedCalls } = await createHarness({
			thinkingLevel: ThinkingLevel.Ultra,
			requestedToolNames: new Set(["read"]),
		});

		await session.prompt("refactor the parser across modules");

		expect(observedCalls[0]?.toolNames).not.toContain("task");
		expect(observedCalls[0]?.messageTexts.some(text => text.includes("meaningfully improves speed or quality"))).toBe(
			false,
		);
		expect(customEntries(session, ULTRA_CONTEXT_TYPE)).toHaveLength(0);
		expect(customEntries(session, ULTRA_RESET_TYPE)).toHaveLength(0);
	});

	it("ignores unrelated custom status details when deriving Ultra reset state", async () => {
		const unrelatedActive = await createHarness({ thinkingLevel: Effort.Max, activeTask: true });
		await unrelatedActive.session.sendCustomMessage({
			customType: "other-mode",
			content: "not Ultra",
			display: false,
			details: { status: "active" },
			attribution: "agent",
		});
		await unrelatedActive.session.prompt("ordinary max turn");
		expect(customEntries(unrelatedActive.session, ULTRA_RESET_TYPE)).toHaveLength(0);

		const unrelatedReset = await createHarness({ thinkingLevel: ThinkingLevel.Ultra, activeTask: true });
		await unrelatedReset.session.prompt("parallelize the first pass");
		await unrelatedReset.session.sendCustomMessage({
			customType: "other-mode",
			content: "not Ultra",
			display: false,
			details: { status: "reset" },
			attribution: "agent",
		});
		await unrelatedReset.session.setModel(modelOrThrow("claude-sonnet-4-5"));
		await unrelatedReset.session.prompt("continue after downgrade");

		expect(customEntries(unrelatedReset.session, ULTRA_CONTEXT_TYPE)).toHaveLength(1);
		expect(customEntries(unrelatedReset.session, ULTRA_RESET_TYPE)).toHaveLength(1);
	});
});
