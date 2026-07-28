import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const MODEL = {
	provider: "test",
	id: "fork-model",
	api: "openai-completions",
	contextWindow: 32_000,
	maxTokens: 4_000,
} as Model;

const AGENT: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "fresh prompt",
	source: "bundled",
};

function createMockSession(
	options: {
		activeTools?: string[];
		messages?: unknown[];
		appendMessage?: (message: AgentMessage) => void;
		listeners?: Array<(event: AgentSessionEvent) => void>;
	} = {},
): AgentSession {
	const listeners = options.listeners ?? [];
	const activeTools = options.activeTools ?? ["read"];
	return {
		agent: {
			state: { systemPrompt: ["parent system"] },
			beforeToolCall: undefined,
			appendMessage: (message: AgentMessage) => options.messages?.push(message),
		},
		model: MODEL,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {}, appendMessage: options.appendMessage ?? (() => {}) },
		getActiveToolNames: () => activeTools,
		getEnabledToolNames: () => activeTools,
		setActiveToolsByName: async () => {},
		setTodoPhases: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			for (const listener of listeners) {
				listener({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "fork result" }],
						api: MODEL.api,
						provider: MODEL.provider,
						model: MODEL.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 21,
							cacheWrite: 0,
							totalTokens: 23,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createRewriteSession() {
	const session = createMockSession({ activeTools: ["bash", "todo"] });
	session.agent.beforeToolCall = async () => ({ args: { command: "rewritten" } });
	return session;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

describe("runSubprocess fork context", () => {
	afterEach(() => vi.restoreAllMocks());

	it("clones through the completed boundary and reports measured cache reads", async () => {
		const parentFile = "/tmp/parent.jsonl";
		const forkManager = SessionManager.inMemory("/tmp");
		const forkBranch = vi.fn(async () => forkManager);
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(createMockSession()));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: AGENT,
			task: "inspect inherited context",
			index: 0,
			id: "ForkAgent",
			artifactsDir: "/tmp",
			settings: Settings.isolated(),
			modelRegistry: { authStorage: {}, refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			contextSource: "fork",
			parentSessionFile: parentFile,
			parentSessionManager: { forkBranch, getCwd: () => "/tmp" },
			parentForkLeafId: "completed-assistant",
			parentModel: MODEL,
			parentSystemPrompt: ["parent system"],
			parentToolNames: ["read"],
			parentPromptCacheKey: "parent-cache",
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("fork result");
		expect(result.contextSource).toEqual({ requested: "fork", used: "fork", cacheReadTokens: 21 });
		expect(forkBranch).toHaveBeenCalledWith({
			cwd: "/tmp",
			sessionDir: "/tmp",
			suppressBreadcrumb: true,
			sessionFile: "/tmp/ForkAgent.jsonl",
			sourceLeafId: "completed-assistant",
		});
		const options = createSpy.mock.calls[0]?.[0];
		expect(options?.model).toBeUndefined();
		expect(options?.systemPrompt).toBeInstanceOf(Function);
		expect(options?.toolNames).toBeUndefined();
		expect(options?.providerPromptCacheKey).toBe("parent-cache");
	});

	it("auto falls back to fresh context when the parent is not persisted", async () => {
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(createMockSession()));
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: AGENT,
			task: "inspect",
			index: 0,
			id: "AutoAgent",
			settings: Settings.isolated(),
			modelRegistry: { authStorage: {}, refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			contextSource: "auto",
		});

		expect(result.exitCode).toBe(0);
		expect(result.contextSource).toEqual({
			requested: "auto",
			used: "fresh",
			cacheReadTokens: 84,
			downgradeReason: "fork context requires a persisted child transcript",
		});
		expect(typeof createSpy.mock.calls[0]?.[0]?.systemPrompt).toBe("function");
	});

	it("blocks non-read tools after extension argument rewrites", async () => {
		const session = createRewriteSession();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(SessionManager.inMemory("/tmp"));
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess({
			cwd: "/tmp",
			agent: AGENT,
			task: "inspect",
			index: 0,
			id: "GuardAgent",
			artifactsDir: "/tmp",
			settings: Settings.isolated(),
			modelRegistry: { authStorage: {}, refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			contextSource: "fork",
			parentSessionFile: "/tmp/parent.jsonl",
			parentSessionManager: { forkBranch: async () => SessionManager.inMemory("/tmp"), getCwd: () => "/tmp" },
			parentForkLeafId: "completed-assistant",
			parentModel: MODEL,
			parentSystemPrompt: ["parent system"],
			parentToolNames: ["bash", "todo"],
		});

		const result = await session.agent.beforeToolCall?.(
			{
				tool: { name: "bash", approval: { tier: "exec" } },
				args: { command: "original" },
			} as never,
			undefined,
		);
		expect(result).toEqual({
			block: true,
			reason: "Forked task agents are read-only; return findings to the parent.",
		});
	});

	it("preserves parent tools and appends fork-specific invocation contracts", async () => {
		const messages: unknown[] = [];
		const session = createMockSession({ activeTools: ["read", "todo"], messages });
		const setTools = vi.spyOn(session, "setActiveToolsByName");
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(SessionManager.inMemory("/tmp"));
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess({
			cwd: "/tmp",
			agent: AGENT,
			task: "inspect",
			context: "Do not change the API contract.",
			outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
			index: 0,
			id: "ContractAgent",
			artifactsDir: "/tmp",
			settings: Settings.isolated(),
			modelRegistry: { authStorage: {}, refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			contextSource: "fork",
			parentSessionFile: "/tmp/parent.jsonl",
			parentSessionManager: { forkBranch: async () => SessionManager.inMemory("/tmp"), getCwd: () => "/tmp" },
			parentForkLeafId: "completed-assistant",
			parentModel: MODEL,
			parentSystemPrompt: ["parent system"],
			parentToolNames: ["read", "todo"],
		});

		expect(setTools).not.toHaveBeenCalled();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "developer" });
		expect(JSON.stringify(messages[0])).toContain("Do not change the API contract.");
		expect(JSON.stringify(messages[0])).toContain("answer");
		expect(JSON.stringify(messages[0])).not.toContain("NEVER fix, audit, or build on it");
	});

	it("reinjects and persists the fork contract after compaction", async () => {
		const messages: unknown[] = [];
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const appendMessage = vi.fn();
		const session = createMockSession({ messages, appendMessage, listeners });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(SessionManager.inMemory("/tmp"));
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess({
			cwd: "/tmp",
			agent: AGENT,
			task: "inspect",
			index: 0,
			id: "CompactAgent",
			artifactsDir: "/tmp",
			settings: Settings.isolated(),
			modelRegistry: { authStorage: {}, refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			contextSource: "fork",
			parentSessionFile: "/tmp/parent.jsonl",
			parentSessionManager: { forkBranch: async () => SessionManager.inMemory("/tmp"), getCwd: () => "/tmp" },
			parentForkLeafId: "completed-assistant",
			parentModel: MODEL,
			parentSystemPrompt: ["parent system"],
			parentToolNames: ["read"],
		});

		expect(appendMessage).toHaveBeenCalledTimes(1);
		for (const listener of listeners) {
			listener({
				type: "auto_compaction_end",
				action: "context-full",
				result: {} as never,
				aborted: false,
				willRetry: true,
			});
		}
		expect(appendMessage).toHaveBeenCalledTimes(2);
		expect(messages).toHaveLength(2);
	});

	it("keeps fork context when headless construction omits a parent tool", async () => {
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(SessionManager.inMemory("/tmp"));
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(createMockSession({ activeTools: ["read"] })));
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: AGENT,
			task: "inspect",
			index: 0,
			id: "IncompatibleAgent",
			artifactsDir: "/tmp",
			settings: Settings.isolated(),
			modelRegistry: { authStorage: {}, refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			contextSource: "fork",
			parentSessionFile: "/tmp/parent.jsonl",
			parentSessionManager: { forkBranch: async () => SessionManager.inMemory("/tmp"), getCwd: () => "/tmp" },
			parentForkLeafId: "completed-assistant",
			parentModel: MODEL,
			parentSystemPrompt: ["parent system"],
			parentToolNames: ["ask"],
		});

		expect(result.exitCode).toBe(0);
		expect(result.contextSource).toMatchObject({ requested: "fork", used: "fork" });
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(createSpy.mock.calls[0]?.[0]?.toolNames).toBeUndefined();
	});
});
