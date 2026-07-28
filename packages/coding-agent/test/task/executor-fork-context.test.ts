import { afterEach, describe, expect, it, vi } from "bun:test";
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

function createMockSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		agent: {
			state: { systemPrompt: ["parent system"] },
			beforeToolCall: undefined,
			appendMessage: () => {},
		},
		model: MODEL,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read"],
		getEnabledToolNames: () => ["read"],
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
		const parent = SessionManager.inMemory("/tmp");
		const parentFile = "/tmp/parent.jsonl";
		const forkManager = SessionManager.inMemory("/tmp");
		const ensureOnDisk = vi.fn(async () => {});
		const flush = vi.fn(async () => {});
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(forkManager);
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
			parentSessionManager: { ensureOnDisk, flush, getCwd: () => "/tmp" },
			parentForkLeafId: "completed-assistant",
			parentModel: MODEL,
			parentSystemPrompt: ["parent system"],
			parentToolNames: ["read"],
			parentPromptCacheKey: "parent-cache",
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("fork result");
		expect(result.contextSource).toEqual({ requested: "fork", used: "fork", cacheReadTokens: 21 });
		expect(forkSpy).toHaveBeenCalledWith(parentFile, "/tmp", "/tmp", undefined, {
			suppressBreadcrumb: true,
			sessionFile: "/tmp/ForkAgent.jsonl",
			sourceLeafId: "completed-assistant",
		});
		const options = createSpy.mock.calls[0]?.[0];
		expect(options?.model).toBe(MODEL);
		expect(options?.systemPrompt).toEqual(["parent system"]);
		expect(options?.toolNames).toEqual(["read"]);
		expect(options?.providerPromptCacheKey).toBe("parent-cache");
		expect(parent.getEntries()).toEqual([]);
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
});
