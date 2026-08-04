import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool, type Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/**
 * SessionTitleGenerator behavioral contracts, exercised through the AgentSession
 * public surface (`prompt`, `maybeStartTitleGeneration`, `setSessionName`). Each
 * race is made deterministic with `Promise.withResolvers` gating the tiny-model
 * `completeSimple` call — no timers.
 */

function createTodoInitAssistantMessage(phase: string, item: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_todo_${phase}`,
				name: "todo",
				arguments: { op: "init", list: [{ phase, items: [item] }] },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

/** Flush microtasks until `predicate` holds or the bounded budget is exhausted. Deterministic (no timers). */
async function flushUntil(predicate: () => boolean, max = 200): Promise<void> {
	for (let i = 0; i < max; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	if (!predicate()) throw new Error("flushUntil: condition not met within microtask budget");
}

async function flushMicrotasks(turns = 30): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("SessionTitleGenerator contracts", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let scriptedResponses: AssistantMessage[] = [];
	let previousNoTitle: string | undefined;

	function buildAgent(model: ai.Model, tools: Tool[] = []): Agent {
		return new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, _context, _options) => {
				const response = scriptedResponses.shift() ?? createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					const reason =
						response.stopReason === "toolUse" || response.stopReason === "length" ? response.stopReason : "stop";
					stream.push({ type: "done", reason, message: response });
				});
				return stream;
			},
		});
	}

	async function makeSession(
		settingsOverride: Record<string, unknown> = {},
		sessionOverride: Partial<AgentSessionConfig> = {},
	): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.eager": "default",
			"todo.reminders": false,
			"title.refreshOnReplan": false,
			"providers.tinyModel": "online",
			...settingsOverride,
		});
		settings.overrideModelRoles({ smol: `${model.provider}/${model.id}` });
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
			setTodoPhases: phases => session?.setTodoPhases(phases),
		};
		const todoTool = new TodoTool(toolSession);
		const agent = buildAgent(model, [todoTool]);

		const toolRegistry = new Map<string, Tool>([[todoTool.name, todoTool]]);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, toolRegistry, ...sessionOverride });
	}

	/** Appends a prior user/assistant exchange so the replan context is non-empty. */
	function seedReplanContext(active: AgentSession): void {
		const priorUser: AgentMessage = { role: "user", content: "fix parser recovery", timestamp: Date.now() - 2 };
		const priorAssistant = createAssistantMessage("I found the parser recovery path.");
		active.agent.appendMessage(priorUser);
		active.sessionManager.appendMessage(priorUser);
		active.agent.appendMessage(priorAssistant);
		active.sessionManager.appendMessage(priorAssistant);
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-session-title-");
		scriptedResponses = [];
		session = undefined;
		authStorage = undefined;
		previousNoTitle = process.env.PI_NO_TITLE;
		delete process.env.PI_NO_TITLE;
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		vi.restoreAllMocks();
		tempDir.removeSync();
		if (previousNoTitle === undefined) delete process.env.PI_NO_TITLE;
		else process.env.PI_NO_TITLE = previousNoTitle;
		session = undefined;
		authStorage = undefined;
	});

	it("checks the local extension-command gate before invoking onStart (contract a)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({ "compaction.enabled": false, "providers.tinyModel": "online" });
		settings.overrideModelRoles({ smol: `${model.provider}/${model.id}` });

		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerCommand("widget-status", { description: "Display widget status", handler: async () => {} });
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"widget-status-test",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			settings,
		);

		const agent = buildAgent(model);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		const titleSpy = vi.spyOn(session, "generateTitle").mockResolvedValue(null);

		let localStarted = false;
		session.maybeStartTitleGeneration("/widget-status", () => {
			localStarted = true;
		});
		expect(localStarted).toBe(false);
		expect(titleSpy).not.toHaveBeenCalled();

		// A normal first message passes the gate: onStart fires synchronously,
		// before the (spied) generation promise settles.
		let normalStarted = false;
		session.maybeStartTitleGeneration("investigate the failing parser recovery path", () => {
			normalStarted = true;
		});
		expect(normalStarted).toBe(true);
		expect(titleSpy).toHaveBeenCalledTimes(1);
	});

	it("guards a second replan refresh while the first is in flight (contract b)", async () => {
		await makeSession({ "title.refreshOnReplan": true });
		const active = session;
		if (!active) throw new Error("session not created");
		await active.setSessionName("Old auto title", "auto");
		seedReplanContext(active);

		const gate = Promise.withResolvers<ai.AssistantMessage>();
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation(() => gate.promise);

		try {
			scriptedResponses = [
				createTodoInitAssistantMessage("Parser", "Rework parser diagnostics"),
				createAssistantMessage("todo initialized"),
			];
			await active.prompt("replan parser diagnostics");
			await flushUntil(() => completeSimpleMock.mock.calls.length === 1);

			scriptedResponses = [
				createTodoInitAssistantMessage("Parser2", "Rework parser diagnostics again"),
				createAssistantMessage("todo initialized"),
			];
			await active.prompt("replan parser diagnostics once more");
			await flushMicrotasks();

			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve(createAssistantMessage("<title>Parser recovery replan</title>"));
			await flushMicrotasks();
		}
	});

	it("discards a replan title when the session id rotates during generation (contract c)", async () => {
		await makeSession({ "title.refreshOnReplan": true });
		const active = session;
		if (!active) throw new Error("session not created");
		await active.setSessionName("Old auto title", "auto");
		seedReplanContext(active);

		const realId = active.sessionManager.getSessionId();
		let rotated = false;
		vi.spyOn(active.sessionManager, "getSessionId").mockImplementation(() =>
			rotated ? `${realId}-rotated` : realId,
		);

		const gate = Promise.withResolvers<ai.AssistantMessage>();
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation(() => gate.promise);
		const setNameSpy = vi.spyOn(active.sessionManager, "setSessionName");

		scriptedResponses = [
			createTodoInitAssistantMessage("Parser", "Rework parser diagnostics"),
			createAssistantMessage("todo initialized"),
		];
		await active.prompt("replan parser diagnostics");
		await flushUntil(() => completeSimpleMock.mock.calls.length === 1);

		rotated = true;
		gate.resolve(createAssistantMessage("<title>Parser recovery replan</title>"));
		await flushMicrotasks();

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(setNameSpy).not.toHaveBeenCalled();
		expect(active.sessionManager.getSessionName()).toBe("Old auto title");
	});

	it("discards a replan title when the title becomes user-owned during generation (contract d, after await)", async () => {
		await makeSession({ "title.refreshOnReplan": true });
		const active = session;
		if (!active) throw new Error("session not created");
		await active.setSessionName("Old auto title", "auto");
		seedReplanContext(active);

		const gate = Promise.withResolvers<ai.AssistantMessage>();
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation(() => gate.promise);

		scriptedResponses = [
			createTodoInitAssistantMessage("Parser", "Rework parser diagnostics"),
			createAssistantMessage("todo initialized"),
		];
		await active.prompt("replan parser diagnostics");
		await flushUntil(() => completeSimpleMock.mock.calls.length === 1);

		// User renames mid-generation; the post-await titleSource guard must win.
		await active.setSessionName("User Chosen", "user");

		gate.resolve(createAssistantMessage("<title>Generated Replan</title>"));
		await flushMicrotasks();

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(active.sessionManager.getSessionName()).toBe("User Chosen");
	});

	it("skips replan generation entirely when the title is already user-owned (contract d, before await)", async () => {
		await makeSession({ "title.refreshOnReplan": true });
		const active = session;
		if (!active) throw new Error("session not created");
		await active.setSessionName("Manual parser title", "user");
		seedReplanContext(active);

		const completeSimpleMock = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage("<title>should not run</title>"));

		scriptedResponses = [
			createTodoInitAssistantMessage("Parser", "Rework parser diagnostics"),
			createAssistantMessage("todo initialized"),
		];
		await active.prompt("replan parser diagnostics");
		await flushMicrotasks();

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(active.sessionManager.getSessionName()).toBe("Manual parser title");
	});
});
