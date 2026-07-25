import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BtwPanelComponent } from "@oh-my-pi/pi-coding-agent/modes/components/btw-panel";
import {
	type ConsultationThreadHandle,
	ConsultController,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/consult-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CommittedSessionFork } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	CONSULTATION_STATUS_MESSAGE_TYPE,
	CONSULTATION_THREAD_CUSTOM_TYPE,
	CONSULTATION_TITLE_CUSTOM_TYPE,
	CONSULTATION_TURN_CUSTOM_TYPE,
	consultationThreadMetadata,
	consultationThreadTitle,
	consultationThreadTitleState,
	consultationTurnStates,
	fallbackConsultationTitle,
	latestConsultationAnswer,
	replayCompletedConsultationMessages,
} from "@oh-my-pi/pi-coding-agent/session/consultation";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function model(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "anthropic",
		provider: "test-provider",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 16_000,
	} as ModelSpec<Api>) as Model<Api>;
}

const executeTool = vi.fn(async () => ({ content: [{ type: "text" as const, text: "bad" }], details: {} }));
const tool: AgentTool = {
	name: "mutate",
	label: "Mutate",
	description: "must never execute",
	parameters: { type: "object", properties: {} },
	execute: executeTool as never,
};

beforeAll(async () => {
	await initTheme();
});

describe("AgentSession durable consultation side turn", () => {
	const sessions: AgentSession[] = [];
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("pins launch identity, keeps full text, discards tool calls, and clears isolated provider state", async () => {
		const original = model("captured-model");
		const replacement = model("replacement-model");
		const longAnswer = "x".repeat(5000);
		let capturedModel: Model | undefined;
		let capturedContext: Context | undefined;
		let capturedOptions: SimpleStreamOptions | undefined;
		const isolatedProviderStates: Array<Map<string, unknown>> = [];
		const isolatedClosers: Array<() => void> = [];
		const sideStreamFn: StreamFn = (streamModel, context, options) => {
			capturedModel = streamModel;
			capturedContext = context;
			capturedOptions = options;
			const providerSessionState = options?.providerSessionState;
			if (!providerSessionState) {
				throw new Error("Consultation side stream must receive an isolated provider state map");
			}
			const closer = vi.fn();
			providerSessionState.set("consultation", { close: closer } as never);
			isolatedProviderStates.push(providerSessionState as Map<string, unknown>);
			isolatedClosers.push(closer);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(longAnswer);
				message.content.push({ type: "toolCall", id: "call", name: "mutate", arguments: {} });
				stream.push({ type: "text_delta", contentIndex: 0, delta: longAnswer, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const onPayload = vi.fn();
		const agent = new Agent({
			initialState: { model: original, systemPrompt: ["captured system"], messages: [], tools: [tool] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { resolver: vi.fn(() => async () => "key") } as never,
			sideStreamFn,
			onPayload,
			readOnlySideTransforms: {
				convertMessages: messages => messages as never,
				transformProviderContext: context => context,
			},
		});
		sessions.push(session);
		const parentCloser = vi.fn();
		session.providerSessionState.set("parent", { close: parentCloser } as never);
		const parentEntries = [...session.sessionManager.getEntries()];
		const parentMemoryState = session.getHindsightSessionState();
		const request = session.captureReadOnlySideRequestSnapshot();
		expect(request).toBeDefined();
		if (!request) throw new Error("missing snapshot");
		agent.setModel(replacement);
		agent.setSystemPrompt(["replacement system"]);

		const result = await session.runReadOnlySideTurn({
			request,
			messages: [],
			promptText: "question",
			developerReminder: "read only",
		});
		const secondResult = await session.runReadOnlySideTurn({
			request,
			messages: [],
			promptText: "follow-up",
			developerReminder: "read only",
		});

		expect(result.replyText).toBe(longAnswer);
		expect(result.assistantMessage.content.some(part => part.type === "toolCall")).toBe(false);
		expect(tool.execute).not.toHaveBeenCalled();
		expect(capturedModel?.id).toBe(original.id);
		expect(capturedContext?.systemPrompt).toEqual(["captured system"]);
		expect(capturedContext?.tools?.map(item => item.name)).toContain("mutate");
		expect(capturedOptions?.promptCacheKey).toBe(request.promptCacheKey);
		expect(capturedOptions?.sessionId).toStartWith(`${request.providerSessionId}:side:`);
		expect(capturedOptions?.onPayload).toBeUndefined();
		expect(capturedOptions?.metadata).toBeUndefined();
		expect(capturedOptions?.providerSessionState?.size).toBe(0);
		expect(onPayload).not.toHaveBeenCalled();
		expect(secondResult.replyText).toBe(longAnswer);
		expect(isolatedProviderStates).toHaveLength(2);
		expect(isolatedProviderStates[0]).not.toBe(isolatedProviderStates[1]);
		expect(isolatedProviderStates.every(state => state.size === 0)).toBe(true);
		expect(isolatedClosers).toHaveLength(2);
		for (const closer of isolatedClosers) expect(closer).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.get("parent")).toEqual({ close: parentCloser });
		expect(parentCloser).not.toHaveBeenCalled();
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.tools).toEqual([tool]);
		expect(session.getHindsightSessionState()).toBe(parentMemoryState);
		expect(session.sessionManager.getEntries()).toEqual(parentEntries);
	});
	it("materializes a header-only parent into an empty, resumable consultation boundary", async () => {
		using temp = TempDir.createSync("@omp-consult-empty-parent-");
		const parentManager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		const parentFile = parentManager.getSessionFile();
		if (!parentFile) throw new Error("expected lazy parent session file");
		expect(await Bun.file(parentFile).exists()).toBe(false);
		parentManager.appendThinkingLevelChange("high", "high");
		parentManager.appendModeChange("plan", { goal: "preserve empty-parent metadata" });
		parentManager.appendSessionInit({
			systemPrompt: "empty parent system",
			task: "preserve durable metadata",
			tools: ["read"],
		});

		let providerContext: Context | undefined;
		const sideStreamFn: StreamFn = (_streamModel, context) => {
			providerContext = context;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const reply = createAssistantMessage("saved answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "saved answer", partial: reply });
				stream.push({ type: "done", reason: "stop", message: reply });
			});
			return stream;
		};
		const uncommittedPartial = createAssistantMessage("uncommitted partial");
		uncommittedPartial.content.push({ type: "toolCall", id: "draft-call", name: "mutate", arguments: {} });
		const uncommittedParentMessages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "queued draft that must not leak" }],
				timestamp: Date.now(),
			},
			uncommittedPartial,
		];
		const agent = new Agent({
			initialState: {
				model: model("consult-model"),
				systemPrompt: ["consult system"],
				messages: uncommittedParentMessages,
				tools: [tool],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: parentManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { resolver: vi.fn(() => async () => "key") } as never,
			sideStreamFn,
			readOnlySideTransforms: {
				convertMessages: messages => messages as never,
				transformProviderContext: context => context,
			},
		});
		sessions.push(session);
		vi.spyOn(session, "generateConsultationTitle").mockResolvedValue("Safe question");

		// The default remains strict: only /consult opts into materializing a
		// metadata-only parent for its dedicated child transcript.
		let committedChild: CommittedSessionFork | undefined;
		await expect(session.createCommittedChildSession("strict-child")).rejects.toThrow(
			"Committed child sessions require a persisted parent session",
		);
		const createChild = session.createCommittedChildSession.bind(session);
		vi.spyOn(session, "createCommittedChildSession").mockImplementation(async (...args) => {
			const child = await createChild(...args);
			committedChild = child;
			return child;
		});

		const { promise: firstConsultationSaved, resolve: resolveFirstConsultation } = Promise.withResolvers<void>();
		const { promise: secondConsultationSaved, resolve: resolveSecondConsultation } = Promise.withResolvers<void>();
		let savedConsultations = 0;
		const showStatus = vi.fn((message: string) => {
			if (!message.startsWith("Consultation saved as consult:")) return;
			savedConsultations += 1;
			if (savedConsultations === 1) resolveFirstConsultation();
			if (savedConsultations === 2) resolveSecondConsultation();
		});
		let composerActive = false;
		const container = new Container();
		const ctx = {
			session,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			btwContainer: container,
			showStatus,
			showError: vi.fn(),
			beginConsultComposer: vi.fn(() => {
				composerActive = true;
			}),
			setActiveConsultThread: vi.fn(),
			restoreParentEditorFromConsult: vi.fn(() => {
				composerActive = false;
				return true;
			}),
			get isConsultComposerActive(): boolean {
				return composerActive;
			},
			getActiveConsultThread: () => undefined,
		} as unknown as InteractiveModeContext;
		const controller = new ConsultController(ctx);

		await controller.start("What is safe to do?");
		await firstConsultationSaved;
		await controller.start("How do I keep the metadata?");
		await secondConsultationSaved;

		expect(committedChild).toMatchObject({
			parentLeafId: null,
			hasCommittedContext: false,
			messages: [],
		});
		expect(session.createCommittedChildSession).toHaveBeenCalledWith(expect.stringMatching(/^__consult\./), {
			materializeParent: true,
		});
		expect(await Bun.file(parentFile).exists()).toBe(true);
		expect(parentManager.getEntries().map(entry => entry.type)).toEqual([
			"thinking_level_change",
			"mode_change",
			"session_init",
		]);
		expect(agent.state.messages).toEqual(uncommittedParentMessages);
		const materializedParent = await SessionManager.open(parentFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		expect(materializedParent.getEntries().map(entry => entry.type)).toEqual([
			"thinking_level_change",
			"mode_change",
			"session_init",
		]);
		await materializedParent.close();

		expect(providerContext?.systemPrompt).toEqual(["consult system"]);
		expect(providerContext?.messages).toHaveLength(2);
		expect(providerContext?.messages.map(message => message.role)).toEqual(["developer", "user"]);
		expect(JSON.stringify(providerContext?.messages)).toContain("How do I keep the metadata?");
		expect(JSON.stringify(providerContext?.messages)).not.toContain("queued draft that must not leak");
		expect(JSON.stringify(providerContext?.messages)).not.toContain("uncommitted partial");
		expect(JSON.stringify(providerContext?.messages)).not.toContain("draft-call");
		expect(JSON.stringify(providerContext?.messages)).not.toContain("strict-child");
		const panel = container.children[0] as BtwPanelComponent | undefined;

		expect(panel).toBeDefined();
		const rendered = Bun.stripANSI(panel?.render(120).join("\n") ?? "");
		expect(rendered).toContain("No committed parent context");

		const thread = controller.getActiveThread();
		expect(thread).toBeDefined();
		if (!thread) throw new Error("expected consultation thread");
		const persisted = await SessionManager.open(thread.sessionFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		const persistedMessages = persisted
			.getEntries()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map(entry => entry.message);
		expect(persistedMessages).toEqual([
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "How do I keep the metadata?" }],
			}),
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "saved answer" }],
			}),
		]);
		await persisted.close();

		const resumed = new ConsultController(ctx);
		await resumed.resume(`Main/consult:${thread.consultationId}`);
		expect(resumed.getActiveThread()).toMatchObject(thread);
	});

	it("preserves committed context when the assigned parent file is temporarily dirty", async () => {
		using temp = TempDir.createSync("@omp-consult-dirty-parent-");
		const parentManager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		const committedMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "committed parent context" }],
			timestamp: Date.now(),
		};
		const committedLeafId = parentManager.appendMessage(committedMessage);
		await parentManager.flush();
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model: model("consult-model"), systemPrompt: ["system"], messages: [], tools: [] },
			}),
			sessionManager: parentManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { resolver: vi.fn(() => async () => "key") } as never,
		});
		sessions.push(session);
		vi.spyOn(parentManager, "hasPersistedSessionFile").mockReturnValue(false);

		const child = await session.createCommittedChildSession("__consult.dirty-parent", {
			materializeParent: true,
		});

		expect(child).toMatchObject({
			parentLeafId: committedLeafId,
			hasCommittedContext: true,
			messages: [committedMessage],
		});
		expect(child.manager.buildSessionContextAt(committedLeafId).messages).toEqual([committedMessage]);
		await child.manager.close();
	});

	it("preserves a persisted empty parent journal while pinning its child at the null boundary", async () => {
		using temp = TempDir.createSync("@omp-consult-empty-parent-state-");
		const parentManager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		parentManager.appendThinkingLevelChange("high", "high");
		parentManager.appendServiceTierChange(null);
		parentManager.appendModeChange("plan");
		parentManager.appendSessionInit({
			systemPrompt: "parent system",
			task: "persist parent setup",
			tools: ["read"],
		});
		await parentManager.ensureOnDisk();
		await parentManager.flush();
		const persistedParentEntries = parentManager.getEntries();
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model: model("consult-model"), systemPrompt: ["system"], messages: [], tools: [] },
			}),
			sessionManager: parentManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { resolver: vi.fn(() => async () => "key") } as never,
		});
		sessions.push(session);

		const child = await session.createCommittedChildSession("__consult.empty-parent", {
			materializeParent: true,
		});

		expect(child).toMatchObject({ parentLeafId: null, hasCommittedContext: false, messages: [] });
		expect(child.manager.getEntries()).toEqual([]);
		expect(parentManager.getEntries()).toEqual(persistedParentEntries);
		const parentFile = parentManager.getSessionFile();
		if (!parentFile) throw new Error("expected persisted parent session file");
		const reopenedParent = await SessionManager.open(parentFile, undefined, undefined, { suppressBreadcrumb: true });
		expect(reopenedParent.getEntries()).toEqual(persistedParentEntries);
		await reopenedParent.close();
		await child.manager.close();
	});

	it("keeps /consult unavailable without a model and does not materialize its lazy parent", async () => {
		using temp = TempDir.createSync("@omp-consult-no-model-");

		const parentManager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		const parentFile = parentManager.getSessionFile();
		if (!parentFile) throw new Error("expected lazy parent session file");
		const session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: ["system"], messages: [], tools: [] } }),
			sessionManager: parentManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { resolver: vi.fn(() => async () => "key") } as never,
		});
		sessions.push(session);
		const createChild = vi.spyOn(session, "createCommittedChildSession");
		const captureSnapshot = vi.spyOn(session, "captureReadOnlySideRequestSnapshot").mockReturnValue(undefined);
		const showError = vi.fn();
		const setText = vi.fn();
		let controller: ConsultController;
		const ctx = {
			session,
			btwContainer: new Container(),
			showError,
			showStatus: vi.fn(),
			beginConsultComposer: vi.fn(),
			editor: { setText },
			handleConsultCommand: async (question: string) => controller.startNewThread(question),
		} as unknown as InteractiveModeContext;
		controller = new ConsultController(ctx);

		await executeBuiltinSlashCommand("/consult Should not start", { ctx } as never);

		expect(setText).toHaveBeenCalledWith("");
		expect(showError).toHaveBeenCalledWith("No active model available for /consult.");
		expect(captureSnapshot).toHaveBeenCalledTimes(1);
		expect(createChild).not.toHaveBeenCalled();
		expect(await Bun.file(parentFile).exists()).toBe(false);

		showError.mockClear();
		await expect(controller.submitCurrentThread("restore this draft")).rejects.toThrow(
			"No active model available for /consult.",
		);
		expect(showError).not.toHaveBeenCalled();
		expect(createChild).not.toHaveBeenCalled();
	});

	it("persists a no-text consultation failure as a transcript message", async () => {
		const manager = SessionManager.inMemory();
		const requestSnapshot = {
			model: model("captured-model"),
			providerSessionId: "provider-session",
			promptCacheKey: "provider-session",
			systemPrompt: ["system"],
			tools: [],
			telemetry: undefined,
		};
		const session = {
			getAgentId: () => "Main",
			captureReadOnlySideRequestSnapshot: () => requestSnapshot,
			createCommittedChildSession: vi.fn(async () => ({
				manager,
				sessionFile: "/tmp/__consult.no-text.jsonl",
				parentSessionId: "parent-session",
				parentLeafId: null,
				hasCommittedContext: false,
				messages: [],
			})),
			runReadOnlySideTurn: vi.fn(async () => ({
				replyText: "",
				assistantMessage: createAssistantMessage(""),
			})),
			generateConsultationTitle: vi.fn(),
		} as unknown as InteractiveModeContext["session"];
		const { promise: saved, resolve: resolveSaved } = Promise.withResolvers<void>();
		const controller = new ConsultController({
			session,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			btwContainer: new Container(),
			showStatus: vi.fn((message: string) => {
				if (message.startsWith("Consultation saved as consult:")) resolveSaved();
			}),
			showError: vi.fn(),
			beginConsultComposer: vi.fn(),
			setActiveConsultThread: vi.fn(),
		} as unknown as InteractiveModeContext);

		await controller.start("return no text");
		await saved;

		const entries = manager.getEntries();
		const thread = controller.getActiveThread();
		expect(thread).toBeDefined();
		if (!thread) throw new Error("missing consultation thread");
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "custom" &&
					entry.message.customType === CONSULTATION_STATUS_MESSAGE_TYPE &&
					entry.message.content ===
						"[Consultation failed: Consultation returned no text; tool calls are disabled.]",
			),
		).toBe(true);
		expect(entries.map(entry => entry.type)).not.toContain("custom_message");
		expect(consultationTurnStates(entries, thread.consultationId).at(-1)?.terminal).toMatchObject({
			status: "failed",
			error: "Consultation returned no text; tool calls are disabled.",
		});
	});

	it("refuses to advertise durable children for intentionally non-persistent parents", async () => {
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model: model("consult-model"), systemPrompt: ["system"], messages: [], tools: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { resolver: vi.fn(() => async () => "key") } as never,
		});
		sessions.push(session);

		await expect(
			session.createCommittedChildSession("__consult.no-session", { materializeParent: true }),
		).rejects.toThrow("Committed child sessions require a persisted parent session");
	});

	it("generates consultation titles through an isolated tool-free request without changing parent usage state", async () => {
		using temp = TempDir.createSync("@omp-consult-title-isolation-");
		const authStorage = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const titleModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!titleModel) throw new Error("Expected bundled title model");
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"providers.tinyModel": "online",
			});
			settings.overrideModelRoles({ smol: `${titleModel.provider}/${titleModel.id}` });
			const titleAgent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: titleModel,
					systemPrompt: ["parent system"],
					tools: [tool],
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "parent context" }],
							timestamp: 1,
						},
					],
				},
			});
			const parentMetadataForProvider = vi.spyOn(titleAgent, "metadataForProvider");
			const modelRegistry = new ModelRegistry(authStorage);
			const getApiKey = vi.spyOn(modelRegistry, "getApiKey");
			const resolver = vi.spyOn(modelRegistry, "resolver");
			const onPayload = vi.fn();
			const session = new AgentSession({
				agent: titleAgent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				providerSessionId: "parent-provider",
				onPayload,
			});
			sessions.push(session);
			parentMetadataForProvider.mockClear();
			const parentCloser = vi.fn();
			session.providerSessionState.set("parent", { close: parentCloser } as never);
			const parentEntries = [...session.sessionManager.getEntries()];
			const parentMessages = structuredClone(titleAgent.state.messages);
			const completeSimple = vi
				.spyOn(ai, "completeSimple")
				.mockResolvedValue(createAssistantMessage("<title>Isolated title</title>"));

			const title = await session.generateConsultationTitle(
				"Audit the committed boundary",
				"The committed boundary contains only persisted parent context.",
			);

			expect(title).toBe("Isolated title");
			expect(completeSimple).toHaveBeenCalledTimes(1);
			const [titleModelRequest, titleContext, titleOptions] = completeSimple.mock.calls[0] ?? [];
			expect(titleModelRequest).toBe(titleModel);
			expect(titleContext).toEqual({
				systemPrompt: expect.any(Array),
				messages: [
					expect.objectContaining({
						role: "user",
						content:
							"<chat>\n<user>\nAudit the committed boundary\n</user>\n\n<assistant>\nThe committed boundary contains only persisted parent context.\n</assistant>\n</chat>",
					}),
				],
			});
			expect(titleContext).not.toHaveProperty("tools");
			const metadata = titleOptions?.metadata as { user_id?: string } | undefined;
			expect(metadata?.user_id).toBeDefined();
			const titleSessionId = JSON.parse(metadata?.user_id ?? "{}").session_id;
			expect(titleSessionId).toMatch(/^consultation-title:/);
			expect(titleSessionId).not.toBe("parent-provider");
			expect(getApiKey.mock.calls[0]?.[1]).toBe(titleSessionId);
			expect(resolver.mock.calls[0]?.[1]).toBe(titleSessionId);
			expect(parentMetadataForProvider).not.toHaveBeenCalled();
			expect(onPayload).not.toHaveBeenCalled();
			expect(tool.execute).not.toHaveBeenCalled();
			expect(titleAgent.state.messages).toEqual(parentMessages);
			expect(session.sessionManager.getEntries()).toEqual(parentEntries);
			expect(session.providerSessionState.get("parent")).toEqual({ close: parentCloser });
			expect(parentCloser).not.toHaveBeenCalled();
		} finally {
			authStorage.close();
		}
	});

	it("replays only completed consultation turns after the frozen parent boundary", () => {
		const parentMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "committed parent" }],
			attribution: "user" as const,
			timestamp: 1,
		};
		const completedQuestion = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "completed question" }],
			attribution: "user" as const,
			timestamp: 2,
		};
		const cancelledQuestion = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "cancelled question" }],
			attribution: "user" as const,
			timestamp: 3,
		};
		const completedAnswer = createAssistantMessage("completed answer");
		const completedRunning = {
			version: 1 as const,
			consultationId: "thread-1",
			turnId: "turn-1",
			turnIndex: 1,
			question: "completed question",
			promptText: "rendered completed question",
			provider: "test-provider",
			model: "captured-model",
			status: "running" as const,
			startedAt: 1,
		};
		const cancelledRunning = {
			...completedRunning,
			turnId: "turn-2",
			turnIndex: 2,
			question: "cancelled question",
			promptText: "rendered cancelled question",
			status: "running" as const,
			startedAt: 2,
		};
		const entry = (id: string, message: AgentMessage): SessionEntry =>
			({
				type: "message",
				id,
				parentId: null,
				timestamp: "2026-07-20T00:00:00.000Z",
				message,
			}) as SessionEntry;
		const turn = (id: string, data: object): SessionEntry =>
			({
				type: "custom",
				id,
				parentId: null,
				timestamp: "2026-07-20T00:00:00.000Z",
				customType: CONSULTATION_TURN_CUSTOM_TYPE,
				data,
			}) as SessionEntry;

		const entries = [
			entry("parent", parentMessage),
			entry("completed-user", completedQuestion),
			turn("completed-running", completedRunning),
			entry("completed-assistant", completedAnswer),
			turn("completed-terminal", { ...completedRunning, status: "completed" as const, finishedAt: 3 }),
			entry("cancelled-user", cancelledQuestion),
			turn("cancelled-running", cancelledRunning),
			entry("cancelled-partial-assistant", createAssistantMessage("partial answer must not replay")),
			turn("cancelled-terminal", { ...cancelledRunning, status: "cancelled" as const, finishedAt: 4 }),
		];

		expect(replayCompletedConsultationMessages(entries, "thread-1")).toEqual([completedQuestion, completedAnswer]);
		expect(latestConsultationAnswer(entries.slice(0, 5), "thread-1")).toBe("completed answer");
		expect(latestConsultationAnswer(entries, "thread-1")).toBeUndefined();
		const partialEntries = [
			...entries.slice(0, -1),
			turn("cancelled-terminal-partial", {
				...cancelledRunning,
				status: "cancelled" as const,
				finishedAt: 4,
				partialAnswer: "saved cancelled partial",
			}),
		];
		expect(latestConsultationAnswer(partialEntries, "thread-1")).toBe("saved cancelled partial");
	});
	it("keeps a failed title as display-only fallback, then retries canonically after persisted discovery", async () => {
		AgentRegistry.resetGlobalForTests();
		using temp = TempDir.createSync("@omp-consult-thread-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		let sessionFile = path.join(temp.path(), "parent", "__consult.thread-1.jsonl");
		const parentMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "frozen parent" }],
			attribution: "user",
			timestamp: 1,
		};
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await Bun.write(
			parentFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "parent",
				timestamp: "2026-07-20T00:00:00.000Z",
				cwd: temp.path(),
			}),
		);
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "parent-leaf",
				parentId: null,
				timestamp: "2026-07-20T00:00:00.000Z",
				message: parentMessage,
			},
		];
		let entryNumber = 0;
		const appendMessage = vi.fn((message: AgentMessage): string => {
			const id = `message-${++entryNumber}`;
			entries.push({
				type: "message",
				id,
				parentId: null,
				timestamp: "2026-07-20T00:00:00.000Z",
				message,
			});
			return id;
		});
		const appendCustomEntry = vi.fn((customType: string, data?: unknown): string => {
			const id = `custom-${++entryNumber}`;
			entries.push({
				type: "custom",
				id,
				parentId: null,
				timestamp: "2026-07-20T00:00:00.000Z",
				customType,
				data,
			});
			return id;
		});
		const flush = vi.fn(async (): Promise<void> => {
			await Bun.write(
				sessionFile,
				[
					JSON.stringify({
						type: "session",
						version: 3,
						id: "thread-1",
						timestamp: "2026-07-20T00:00:00.000Z",
						cwd: temp.path(),
					}),
					...entries.map(entry => JSON.stringify(entry)),
				].join("\n"),
			);
		});
		const close = vi.fn(async (): Promise<void> => {});
		const manager = {
			appendMessage,
			appendCustomEntry,
			buildSessionContextAt: vi.fn(() => ({ messages: [parentMessage] })),
			close,
			flush,
			getEntries: () => entries,
			getSessionFile: () => sessionFile,
		} as unknown as SessionManager;
		vi.spyOn(SessionManager, "open").mockResolvedValue(manager);

		const replies = ["first answer", "second answer"];
		const requestMessages: AgentMessage[][] = [];
		const sideTurn = vi.fn(async (args: { messages: readonly AgentMessage[] }) => {
			requestMessages.push([...args.messages]);
			const answer = replies.shift();
			if (!answer) throw new Error("missing fake answer");
			return { replyText: answer, assistantMessage: createAssistantMessage(answer) };
		});
		const requestSnapshot = {
			model: model("captured-model"),
			providerSessionId: "provider-session",
			promptCacheKey: "provider-session",
			systemPrompt: ["system"],
			tools: [],
			telemetry: undefined,
		};
		const createCommittedChildSession = vi.fn(async () => ({
			manager,
			sessionFile,
			parentSessionId: "parent-session",
			parentLeafId: "parent-leaf",
			messages: [parentMessage],
		}));
		let isConsultComposerActive = false;
		let activeConsultThread: ConsultationThreadHandle | undefined;
		const beginConsultComposer = vi.fn((thread?: ConsultationThreadHandle): void => {
			isConsultComposerActive = true;
			activeConsultThread = thread ? { ...thread } : undefined;
		});
		const setActiveConsultThread = vi.fn((thread: ConsultationThreadHandle): void => {
			if (isConsultComposerActive) activeConsultThread = { ...thread };
		});
		const restoreParentEditorFromConsult = vi.fn((): boolean => {
			if (!isConsultComposerActive) return false;
			isConsultComposerActive = false;
			activeConsultThread = undefined;
			return true;
		});
		const { promise: canonicalRetry, resolve: resolveCanonicalRetry } = Promise.withResolvers<string>();
		const generateConsultationTitle = vi
			.fn()
			.mockRejectedValueOnce(new Error("title provider unavailable"))
			.mockImplementationOnce(async () => canonicalRetry);
		const session = {
			getAgentId: () => "Main",
			sessionManager: { getSessionFile: () => parentFile },
			captureReadOnlySideRequestSnapshot: () => requestSnapshot,
			createCommittedChildSession,
			generateConsultationTitle,
			runReadOnlySideTurn: sideTurn,
		} as unknown as InteractiveModeContext["session"];
		const ctx = {
			session,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			btwContainer: new Container(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			get isConsultComposerActive(): boolean {
				return isConsultComposerActive;
			},
			getActiveConsultThread: () => (activeConsultThread ? { ...activeConsultThread } : undefined),
			beginConsultComposer,
			setActiveConsultThread,
			restoreParentEditorFromConsult,
		} as unknown as InteractiveModeContext;
		const controller = new ConsultController(ctx);

		await controller.start("first question");
		for (let i = 0; i < 8; i++) await Promise.resolve();
		const threadEntry = entries.find(
			entry => entry.type === "custom" && entry.customType === CONSULTATION_THREAD_CUSTOM_TYPE,
		) as { data: { consultationId: string } } | undefined;
		expect(threadEntry).toBeDefined();
		if (!threadEntry) throw new Error("missing consultation thread");
		expect(isConsultComposerActive).toBe(true);
		if (!activeConsultThread) throw new Error("missing active consultation thread");
		expect(consultationThreadTitle(entries, threadEntry.data.consultationId)).toBeUndefined();
		expect(consultationThreadTitleState(entries, threadEntry.data.consultationId)).toMatchObject({
			status: "failed",
			error: "title provider unavailable",
		});
		expect(
			entries.filter(entry => entry.type === "custom" && entry.customType === CONSULTATION_TITLE_CUSTOM_TYPE),
		).toEqual([]);
		expect(session.generateConsultationTitle).toHaveBeenCalledTimes(1);
		expect(session.generateConsultationTitle).toHaveBeenCalledWith("first question", "first answer");
		expect(activeConsultThread).toMatchObject({
			consultationId: threadEntry.data.consultationId,
			sessionFile,
			ownerId: "Main",
		});
		const discoveredSessionFile = path.join(
			path.dirname(sessionFile),
			`__consult.${threadEntry.data.consultationId}.jsonl`,
		);
		await fs.rename(sessionFile, discoveredSessionFile);
		sessionFile = discoveredSessionFile;

		// Discovery keeps the failed first attempt usable under its display fallback,
		// then retries it once from the persisted first completed exchange.
		AgentRegistry.resetGlobalForTests();
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session,
			sessionFile: parentFile,
			status: "running",
		});
		const fallbackController = new ConsultController(ctx);
		await fallbackController.resume(`Main/consult:${threadEntry.data.consultationId}`);
		expect(fallbackController.getVisibleTurnPresentation()).toMatchObject({
			title: fallbackConsultationTitle("first question"),
			status: "saved",
		});
		expect(generateConsultationTitle).toHaveBeenCalledTimes(2);
		resolveCanonicalRetry?.("Recovered canonical title");
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(consultationThreadTitle(entries, threadEntry.data.consultationId)).toBe("Recovered canonical title");
		expect(
			entries.filter(entry => entry.type === "custom" && entry.customType === CONSULTATION_TITLE_CUSTOM_TYPE),
		).toEqual([
			expect.objectContaining({
				data: {
					version: 1,
					consultationId: threadEntry.data.consultationId,
					source: "canonical",
					title: "Recovered canonical title",
					createdAt: expect.any(Number),
				},
			}),
		]);
		expect(session.generateConsultationTitle).toHaveBeenCalledTimes(2);

		const restartedController = new ConsultController(ctx);
		await restartedController.resume(`Main/consult:${threadEntry.data.consultationId}`);
		const resumedThread = restartedController.getActiveThread();
		expect(resumedThread).toBeDefined();
		if (!resumedThread) throw new Error("missing resumed consultation thread");
		expect(resumedThread).toMatchObject({
			consultationId: threadEntry.data.consultationId,
			sessionFile,
			ownerId: "Main",
		});
		await restartedController.submitCurrentThread("second question");
		for (let i = 0; i < 8; i++) await Promise.resolve();

		const thread = consultationThreadMetadata(entries, threadEntry.data.consultationId);
		expect(thread).toEqual({
			version: 1,
			consultationId: threadEntry.data.consultationId,
			parentSessionId: "parent-session",
			parentLeafId: "parent-leaf",
			createdAt: expect.any(Number),
		});
		expect(restartedController.getVisibleTurnPresentation()).toMatchObject({
			title: "Recovered canonical title",
			status: "saved",
		});
		expect(consultationThreadTitle(entries, threadEntry.data.consultationId)).toBe("Recovered canonical title");
		expect(session.generateConsultationTitle).toHaveBeenCalledTimes(2);
		expect(
			entries.filter(entry => entry.type === "custom" && entry.customType === CONSULTATION_THREAD_CUSTOM_TYPE),
		).toHaveLength(1);
		expect(createCommittedChildSession).toHaveBeenCalledTimes(1);
		expect(
			consultationTurnStates(entries, threadEntry.data.consultationId).map(state => state.terminal?.status),
		).toEqual(["completed", "completed"]);
		expect(requestMessages).toHaveLength(2);
		expect(requestMessages[0]).toEqual([parentMessage]);
		expect(requestMessages[1]).toEqual([
			parentMessage,
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "first question" }] }),
			expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "first answer" }] }),
		]);
		expect(manager.buildSessionContextAt).toHaveBeenCalledWith("parent-leaf");
		const flushOrder = flush.mock.invocationCallOrder;
		const [firstSideTurn, secondSideTurn] = sideTurn.mock.invocationCallOrder;
		expect(flushOrder.length).toBeGreaterThanOrEqual(5);
		expect(flushOrder.filter(order => order < firstSideTurn!).length).toBeGreaterThanOrEqual(1);
		expect(
			flushOrder.filter(order => order > firstSideTurn! && order < secondSideTurn!).length,
		).toBeGreaterThanOrEqual(2);
		expect(flushOrder.some(order => order > secondSideTurn!)).toBe(true);
	});
	it("rediscovers a Main-owned direct consultation from disk before resuming latest, full, and short ids after a cold restart", async () => {
		using temp = TempDir.createSync("@omp-consult-cold-restart-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifactsDir = parentFile.slice(0, -".jsonl".length);
		const consultationId = "restart-unique";
		const sessionFile = path.join(artifactsDir, `__consult.${consultationId}.jsonl`);
		const jsonl = (id: string, entries: unknown[]): string =>
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id,
					timestamp: "2026-07-20T00:00:00.000Z",
					cwd: temp.path(),
				}),
				...entries.map(entry => JSON.stringify(entry)),
			].join("\n");

		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await Bun.write(parentFile, jsonl("parent", []));
		await Bun.write(
			sessionFile,
			jsonl(consultationId, [
				{
					type: "custom",
					id: "thread",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_THREAD_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId,
						parentSessionId: "parent",
						parentLeafId: "leaf",
						createdAt: 1,
					},
				},
				{
					type: "custom",
					id: "title",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TITLE_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId,
						source: "canonical",
						title: "Committed boundary audit",
						createdAt: 1,
					},
				},
				{
					type: "custom",
					id: "turn-running",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId,
						turnId: "turn",
						turnIndex: 1,
						question: "saved question",
						promptText: "saved prompt",
						provider: "provider",
						model: "model",
						status: "running",
						startedAt: 1,
					},
				},
				{
					type: "message",
					id: "answer",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					message: createAssistantMessage("saved answer"),
				},
				{
					type: "custom",
					id: "turn-completed",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId,
						turnId: "turn",
						turnIndex: 1,
						question: "saved question",
						promptText: "saved prompt",
						provider: "provider",
						model: "model",
						status: "completed",
						startedAt: 1,
						finishedAt: 2,
					},
				},
			]),
		);

		AgentRegistry.resetGlobalForTests();
		expect(AgentRegistry.global().list()).toEqual([]);
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const btwContainer = new Container();
		const followUpEditor = { text: "stale parent draft" };
		const beginConsultComposer = vi.fn(() => {
			followUpEditor.text = "";
		});
		const controller = new ConsultController({
			session: { getAgentId: () => "Main", sessionManager: { getSessionFile: () => parentFile } },
			sessionManager: { getSessionFile: () => parentFile },
			ui: { requestRender, requestComponentRender } as unknown as TUI,
			btwContainer,
			beginConsultComposer,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		await controller.resume();
		expect(AgentRegistry.global().get(`Main/consult:${consultationId}`)).toMatchObject({
			kind: "consultation",
			parentId: "Main",
			sessionFile,
		});
		expect(controller.getActiveThread()).toMatchObject({ consultationId, ownerId: "Main", sessionFile });
		expect(controller.getVisibleTurnPresentation()).toMatchObject({
			consultationId,
			title: "Committed boundary audit",
			turnIndex: 1,
			turnCount: 1,
			status: "saved",
			isLatest: true,
		});
		expect(followUpEditor.text).toBe("");
		const resumedPanel = Bun.stripANSI(btwContainer.render(120).join("\n"));
		expect(resumedPanel).toContain("Committed boundary audit");
		expect(resumedPanel).toContain("1/1");
		expect(resumedPanel).toContain("Saved");
		expect(resumedPanel).toContain("saved answer");
		expect(controller.canCopyVisibleTurn()).toBe(true);
		expect(requestComponentRender).toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalled();

		await controller.resume(`Main/consult:${consultationId}`);
		expect(controller.getActiveThread()).toMatchObject({ consultationId, ownerId: "Main", sessionFile });

		await controller.resume("restart");
		expect(controller.getActiveThread()).toMatchObject({ consultationId, ownerId: "Main", sessionFile });
		expect(beginConsultComposer).toHaveBeenCalledTimes(3);
	});
	it("resumes the latest partial turn with its saved question, terminal status, and an empty follow-up editor", async () => {
		using temp = TempDir.createSync("@omp-consult-partial-resume-");
		const consultationId = "partial-12345678";
		const sessionFile = path.join(temp.path(), `__consult.${consultationId}.jsonl`);
		const turnRecord = (
			turnId: string,
			turnIndex: number,
			question: string,
			status: "running" | "completed" | "cancelled",
			partialAnswer?: string,
		) => ({
			version: 1,
			consultationId,
			turnId,
			turnIndex,
			question,
			promptText: question,
			provider: "provider",
			model: "model",
			status,
			startedAt: turnIndex,
			...(status === "running" ? {} : { finishedAt: turnIndex + 1 }),
			...(partialAnswer ? { partialAnswer } : {}),
		});
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: consultationId,
					timestamp: "2026-07-20T00:00:00.000Z",
					cwd: temp.path(),
				}),
				JSON.stringify({
					type: "custom",
					id: "thread",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_THREAD_CUSTOM_TYPE,
					data: { version: 1, consultationId, parentSessionId: "parent", parentLeafId: "leaf", createdAt: 1 },
				}),
				JSON.stringify({
					type: "custom",
					id: "title",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TITLE_CUSTOM_TYPE,
					data: { version: 1, consultationId, source: "canonical", title: "Interrupt recovery", createdAt: 1 },
				}),
				JSON.stringify({
					type: "custom",
					id: "first-running",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: turnRecord("first", 1, "first question", "running"),
				}),
				JSON.stringify({
					type: "message",
					id: "first-answer",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					message: createAssistantMessage("first complete answer"),
				}),
				JSON.stringify({
					type: "custom",
					id: "first-completed",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: turnRecord("first", 1, "first question", "completed"),
				}),
				JSON.stringify({
					type: "custom",
					id: "second-running",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: turnRecord("second", 2, "latest question", "running"),
				}),
				JSON.stringify({
					type: "custom",
					id: "second-cancelled",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: turnRecord("second", 2, "latest question", "cancelled", "saved partial answer"),
				}),
			].join("\n"),
		);

		AgentRegistry.resetGlobalForTests();
		AgentRegistry.global().register({
			id: `Main/consult:${consultationId}`,
			displayName: "Interrupt recovery · consult:12345678",
			kind: "consultation",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});
		const followUpEditor = { text: "do not reuse saved answer" };
		const btwContainer = new Container();
		const controller = new ConsultController({
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			btwContainer,
			beginConsultComposer: vi.fn(() => {
				followUpEditor.text = "";
			}),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		await controller.resume(`Main/consult:${consultationId}`);

		expect(controller.getVisibleTurnPresentation()).toMatchObject({
			consultationId,
			title: "Interrupt recovery",
			turnIndex: 2,
			turnCount: 2,
			status: "cancelled",
			isLatest: true,
		});
		expect(followUpEditor.text).toBe("");
		const resumedPanel = Bun.stripANSI(btwContainer.render(120).join("\n"));
		expect(resumedPanel).toContain("Interrupt recovery");
		expect(resumedPanel).toContain("2/2");
		expect(resumedPanel).toContain("follow-up");
		expect(resumedPanel).toContain("Cancelled");
		expect(resumedPanel).toContain("saved partial answer");
		expect(resumedPanel).not.toContain("first complete answer");
	});

	it("finalizes a process-exited running turn before cold resume renders it", async () => {
		using temp = TempDir.createSync("@omp-consult-crash-recovery-");
		const parentManager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		await parentManager.ensureOnDisk();
		await parentManager.flush();
		const parentFile = parentManager.getSessionFile();
		if (!parentFile) throw new Error("expected persisted parent session file");
		const consultationId = "crash-12345678";
		const sessionFile = path.join(parentFile.slice(0, -".jsonl".length), `__consult.${consultationId}.jsonl`);
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: consultationId,
					timestamp: "2026-07-24T00:00:00.000Z",
					cwd: temp.path(),
				}),
				JSON.stringify({
					type: "custom",
					id: "thread",
					parentId: null,
					timestamp: "2026-07-24T00:00:00.000Z",
					customType: CONSULTATION_THREAD_CUSTOM_TYPE,
					data: { version: 1, consultationId, parentSessionId: "parent", parentLeafId: null, createdAt: 1 },
				}),
				JSON.stringify({
					type: "custom",
					id: "running",
					parentId: "thread",
					timestamp: "2026-07-24T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId,
						turnId: "turn",
						turnIndex: 1,
						question: "recover this turn",
						promptText: "recover this turn",
						provider: "provider",
						model: "model",
						status: "running",
						startedAt: 1,
					},
				}),
			].join("\n"),
		);

		const btwContainer = new Container();
		const controller = new ConsultController({
			session: { getAgentId: () => "Main", sessionManager: { getSessionFile: () => parentFile } },
			sessionManager: { getSessionFile: () => parentFile },
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			btwContainer,
			beginConsultComposer: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);
		await controller.resume();

		expect(controller.getVisibleTurnPresentation()).toMatchObject({
			consultationId,
			turnIndex: 1,
			turnCount: 1,
			status: "cancelled",
			isLatest: true,
		});
		const resumedPanel = Bun.stripANSI(btwContainer.render(120).join("\n"));
		expect(resumedPanel).toContain("Cancelled");
		expect(resumedPanel).not.toContain("Streaming");
		const recovered = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
		expect(consultationTurnStates(recovered.getEntries(), consultationId)[0]?.terminal).toMatchObject({
			status: "cancelled",
		});
		await recovered.close();
		await parentManager.close();
	});
	it("resumes the last selected, full, and unique-short consultation ids but rejects ambiguous prefixes", async () => {
		AgentRegistry.resetGlobalForTests();
		using temp = TempDir.createSync("@omp-consult-resume-");
		const beginConsultComposer = vi.fn();
		const showError = vi.fn();
		const now = vi.spyOn(Date, "now");
		const consultations = [
			["full-id", 10],
			["unique-id", 20],
			["ambiguous-one", 30],
			["ambiguous-two", 40],
		] as const;
		const sessionFiles = new Map<string, string>();
		for (const [consultationId] of consultations) {
			const sessionFile = path.join(temp.path(), `__consult.${consultationId}.jsonl`);
			sessionFiles.set(consultationId, sessionFile);
			await Bun.write(
				sessionFile,
				[
					JSON.stringify({
						type: "session",
						version: 3,
						id: consultationId,
						timestamp: "2026-07-20T00:00:00.000Z",
						cwd: temp.path(),
					}),
					JSON.stringify({
						type: "custom",
						id: "thread",
						parentId: null,
						timestamp: "2026-07-20T00:00:00.000Z",
						customType: CONSULTATION_THREAD_CUSTOM_TYPE,
						data: {
							version: 1,
							consultationId,
							parentSessionId: "parent",
							parentLeafId: "leaf",
							createdAt: 1,
						},
					}),
					JSON.stringify({
						type: "custom",
						id: "turn-running",
						parentId: null,
						timestamp: "2026-07-20T00:00:00.000Z",
						customType: CONSULTATION_TURN_CUSTOM_TYPE,
						data: {
							version: 1,
							consultationId,
							turnId: "turn",
							turnIndex: 1,
							question: `question ${consultationId}`,
							promptText: `prompt ${consultationId}`,
							provider: "provider",
							model: "model",
							status: "running",
							startedAt: 1,
						},
					}),
					JSON.stringify({
						type: "message",
						id: "answer",
						parentId: null,
						timestamp: "2026-07-20T00:00:00.000Z",
						message: createAssistantMessage(`answer ${consultationId}`),
					}),
					JSON.stringify({
						type: "custom",
						id: "turn-completed",
						parentId: null,
						timestamp: "2026-07-20T00:00:00.000Z",
						customType: CONSULTATION_TURN_CUSTOM_TYPE,
						data: {
							version: 1,
							consultationId,
							turnId: "turn",
							turnIndex: 1,
							question: `question ${consultationId}`,
							promptText: `prompt ${consultationId}`,
							provider: "provider",
							model: "model",
							status: "completed",
							startedAt: 1,
							finishedAt: 2,
						},
					}),
				].join("\n"),
			);
		}
		for (const [consultationId, timestamp] of consultations) {
			now.mockReturnValueOnce(timestamp);
			const sessionFile = sessionFiles.get(consultationId);
			if (!sessionFile) throw new Error(`missing fixture for ${consultationId}`);
			AgentRegistry.global().register({
				id: `Main/consult:${consultationId}`,
				displayName: `consult:${consultationId}`,
				kind: "consultation",
				parentId: "Main",
				session: null,
				sessionFile,
				status: "parked",
			});
		}
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const controller = new ConsultController({
			ui: { requestRender, requestComponentRender } as unknown as TUI,
			btwContainer: new Container(),
			beginConsultComposer,
			showError,
		} as unknown as InteractiveModeContext);
		const expectSuccessfulResume = async (id?: string): Promise<void> => {
			const renderCountBeforeResume = requestRender.mock.calls.length;
			await controller.resume(id);
			expect(requestRender.mock.calls.length).toBeGreaterThan(renderCountBeforeResume);
		};
		await expectSuccessfulResume();
		const latestThread = controller.getActiveThread();
		expect(latestThread).toBeDefined();
		if (!latestThread) throw new Error("missing latest consultation thread");
		expect(latestThread).toMatchObject({
			consultationId: "ambiguous-two",
			sessionFile: sessionFiles.get("ambiguous-two"),
			ownerId: "Main",
		});
		expect(controller.getVisibleTurnPresentation()).toMatchObject({
			consultationId: "ambiguous-two",
			title: "question ambiguous-two",
			status: "saved",
		});
		await expectSuccessfulResume("Main/consult:full-id");
		const fullIdThread = controller.getActiveThread();
		expect(fullIdThread).toBeDefined();
		if (!fullIdThread) throw new Error("missing full-id consultation thread");
		expect(fullIdThread).toMatchObject({
			consultationId: "full-id",
			sessionFile: sessionFiles.get("full-id"),
			ownerId: "Main",
		});
		await expectSuccessfulResume("unique");
		const uniqueThread = controller.getActiveThread();
		expect(uniqueThread).toBeDefined();
		if (!uniqueThread) throw new Error("missing unique consultation thread");
		expect(uniqueThread).toMatchObject({
			consultationId: "unique-id",
			sessionFile: sessionFiles.get("unique-id"),
			ownerId: "Main",
		});
		await expectSuccessfulResume();
		const reselectedUniqueThread = controller.getActiveThread();
		expect(reselectedUniqueThread).toBeDefined();
		if (!reselectedUniqueThread) throw new Error("missing reselected unique consultation thread");
		expect(reselectedUniqueThread).toMatchObject({
			consultationId: "unique-id",
			sessionFile: sessionFiles.get("unique-id"),
			ownerId: "Main",
		});
		const activeThreadBeforeAmbiguousResume = controller.getActiveThread();
		await controller.resume("ambiguous");

		expect(beginConsultComposer).toHaveBeenCalledTimes(4);
		expect(requestComponentRender).toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalled();
		expect(controller.getActiveThread()).toEqual(activeThreadBeforeAmbiguousResume);
		expect(showError).toHaveBeenLastCalledWith('Consultation id "ambiguous" is ambiguous; use its full id.');
	});

	it("keeps a turn running after Esc, then cancels and flushes it before switching threads", async () => {
		AgentRegistry.resetGlobalForTests();
		using temp = TempDir.createSync("@omp-consult-cancel-");
		const otherSessionFile = path.join(temp.path(), "__consult.other.jsonl");
		const parentMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "frozen parent" }],
			attribution: "user",
			timestamp: 1,
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "parent",
				parentId: null,
				timestamp: "2026-07-20T00:00:00.000Z",
				message: parentMessage,
			},
		];
		const events: string[] = [];
		let serial = 0;
		let createdConsultationId: string | undefined;
		const manager = {
			appendMessage: (message: AgentMessage) => {
				entries.push({
					type: "message",
					id: `message-${++serial}`,
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					message,
				});
				if (message.role === "custom" && typeof message.content === "string") {
					events.push(`status:${message.content}`);
				}
				return `message-${serial}`;
			},
			appendCustomEntry: (customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					id: `custom-${++serial}`,
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType,
					data,
				} as SessionEntry);
				if (
					customType === CONSULTATION_THREAD_CUSTOM_TYPE &&
					data &&
					typeof data === "object" &&
					"consultationId" in data
				) {
					createdConsultationId = typeof data.consultationId === "string" ? data.consultationId : undefined;
				}
				if (customType === CONSULTATION_TURN_CUSTOM_TYPE && data && typeof data === "object" && "status" in data) {
					events.push(`turn:${typeof data.status === "string" ? data.status : "unknown"}`);
				}
				return `custom-${serial}`;
			},
			appendCustomMessageEntry: (_type: string, content: string) => {
				events.push(`status:${content}`);
				return `status-${++serial}`;
			},
			buildSessionContextAt: vi.fn(() => ({ messages: [parentMessage] })),
			close: vi.fn(async () => {
				events.push("close");
			}),
			dropSession: vi.fn(async () => {}),
			flush: vi.fn(async () => {
				events.push("flush");
			}),
			getEntries: () => entries,
			getSessionFile: () => "/tmp/__consult.cancelled.jsonl",
		} as unknown as SessionManager;
		const { promise: entered, resolve: sideTurnEntered } = Promise.withResolvers<void>();
		let runningSignal: AbortSignal | undefined;
		const session = {
			getAgentId: () => "Main",
			captureReadOnlySideRequestSnapshot: () => ({
				model: model("captured-model"),
				providerSessionId: "provider-session",
				promptCacheKey: "provider-session",
				systemPrompt: ["system"],
				tools: [],
				telemetry: undefined,
			}),
			createCommittedChildSession: vi.fn(async () => ({
				manager,
				sessionFile: "/tmp/__consult.cancelled.jsonl",
				parentSessionId: "parent-session",
				parentLeafId: "parent",
				messages: [parentMessage],
			})),
			generateConsultationTitle: vi.fn(async (question: string) => fallbackConsultationTitle(question)),
			runReadOnlySideTurn: vi.fn(async (args: { onTextDelta?: (delta: string) => void; signal?: AbortSignal }) => {
				runningSignal = args.signal;
				args.onTextDelta?.("partial answer");
				sideTurnEntered?.();
				const { promise, reject } = Promise.withResolvers<never>();
				args.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				await promise;
				throw new Error("unreachable");
			}),
		} as unknown as InteractiveModeContext["session"];
		const beginConsultComposer = vi.fn((thread?: ConsultationThreadHandle) => {
			events.push(`composer:${thread?.consultationId ?? "new"}`);
		});
		await Bun.write(
			otherSessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "other",
					timestamp: "2026-07-20T00:00:00.000Z",
					cwd: temp.path(),
				}),
				JSON.stringify({
					type: "custom",
					id: "thread",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_THREAD_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId: "other",
						parentSessionId: "parent-session",
						parentLeafId: "parent",
						createdAt: 1,
					},
				}),
				JSON.stringify({
					type: "custom",
					id: "turn-running",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId: "other",
						turnId: "turn",
						turnIndex: 1,
						question: "other question",
						promptText: "other prompt",
						provider: "provider",
						model: "model",
						status: "running",
						startedAt: 1,
					},
				}),
				JSON.stringify({
					type: "message",
					id: "answer",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					message: createAssistantMessage("other answer"),
				}),
				JSON.stringify({
					type: "custom",
					id: "turn-completed",
					parentId: null,
					timestamp: "2026-07-20T00:00:00.000Z",
					customType: CONSULTATION_TURN_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId: "other",
						turnId: "turn",
						turnIndex: 1,
						question: "other question",
						promptText: "other prompt",
						provider: "provider",
						model: "model",
						status: "completed",
						startedAt: 1,
						finishedAt: 2,
					},
				}),
			].join("\n"),
		);
		AgentRegistry.global().register({
			id: "Main/consult:other",
			displayName: "consult:other",
			kind: "consultation",
			parentId: "Main",
			session: null,
			sessionFile: otherSessionFile,
			status: "parked",
		});
		const restoreParentEditorFromConsult = vi.fn(() => true);
		const controller = new ConsultController({
			session,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			btwContainer: new Container(),
			beginConsultComposer,
			setActiveConsultThread: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			restoreParentEditorFromConsult,
		} as unknown as InteractiveModeContext);

		await controller.start("question to cancel");
		await entered;
		await expect(controller.submitCurrentThread("premature follow-up")).rejects.toThrow(
			"Consultation is still running; use ? to cancel it before submitting a follow-up.",
		);
		expect(runningSignal?.aborted).toBe(false);
		if (!createdConsultationId) throw new Error("consultation thread record was not persisted");
		expect(consultationTurnStates(entries, createdConsultationId)[0]?.terminal).toBeUndefined();
		expect(controller.handleEscape()).toBe(true);
		expect(runningSignal?.aborted).toBe(false);
		expect(restoreParentEditorFromConsult).toHaveBeenCalledTimes(1);
		if (!createdConsultationId) throw new Error("consultation thread record was not persisted");
		expect(consultationTurnStates(entries, createdConsultationId)[0]?.terminal).toBeUndefined();
		events.length = 0;
		await controller.resume();
		expect(runningSignal?.aborted).toBe(false);
		expect(controller.hasActiveTurn()).toBe(true);
		expect(controller.getActiveThread()?.consultationId).toBe(createdConsultationId);
		expect(controller.hasActiveRequest()).toBe(true);
		expect(controller.handleEscape()).toBe(true);
		expect(runningSignal?.aborted).toBe(false);
		events.length = 0;
		await controller.resume("other");

		if (!createdConsultationId) throw new Error("consultation thread record was not persisted");
		const states = consultationTurnStates(entries, createdConsultationId);
		expect(states).toHaveLength(1);
		expect(states[0]?.terminal).toMatchObject({
			status: "cancelled",
			partialAnswer: "partial answer",
		});
		expect(events).toContain("status:partial answer\n\n[Consultation cancelled.]");
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "custom" &&
					entry.message.customType === CONSULTATION_STATUS_MESSAGE_TYPE &&
					entry.message.content === "partial answer\n\n[Consultation cancelled.]",
			),
		).toBe(true);
		expect(events.indexOf("turn:cancelled")).toBeLessThan(events.indexOf("flush"));
		expect(events.indexOf("flush")).toBeLessThan(events.indexOf("close"));
		expect(events.indexOf("close")).toBeLessThan(events.indexOf("composer:other"));
		const otherThread = controller.getActiveThread();
		expect(otherThread).toBeDefined();
		if (!otherThread) throw new Error("missing other consultation thread");
		expect(otherThread).toMatchObject({
			consultationId: "other",
			sessionFile: otherSessionFile,
			ownerId: "Main",
		});
	});
});
