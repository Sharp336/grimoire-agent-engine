import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} memory tool`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

describe("AgentSession memory backend lifecycle", () => {
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let settings: Settings;
	let tempDir: TempDir;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@memory-backend-lifecycle-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "off",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		resetMemoryForTests();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(createMemoryTools: () => Promise<AgentTool[]>): AgentSession {
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const read = createTool("read");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [read] },
			streamFn: createMockModel({ responses: [{ content: ["ok"] }] }).stream,
		});
		const toolRegistry = new Map<string, AgentTool>([[read.name, read]]);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			memoryAgentDir: tempDir.path(),
			memoryTaskDepth: 0,
			createMemoryTools,
			toolRegistry,
			builtInToolNames: [read.name],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`backend:${settings.get("memory.backend")};tools:${toolNames.sort().join(",")}`],
			}),
		});
		return session;
	}

	it("switches runtime state, memory tools, and prompt in one apply", async () => {
		const current = createSession(async () =>
			settings.get("memory.backend") === "mnemopi" ? [createTool("retain"), createTool("memory_edit")] : [],
		);

		settings.override("memory.backend", "mnemopi");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "retain", "memory_edit"]));
		expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:memory_edit,read,retain"]);

		settings.override("memory.backend", "off");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
	});
	it("cancels a displaced local startup generation", async () => {
		const current = createSession(async () => []);
		const localStartup = current.beginLocalMemoryStartup();

		await current.applyMemoryBackend();

		expect(localStartup.aborted).toBe(true);
	});

	it("serializes concurrent backend applies", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		let running = 0;
		let maxRunning = 0;
		const current = createSession(async () => {
			calls++;
			running++;
			maxRunning = Math.max(maxRunning, running);
			if (calls === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			running--;
			return [];
		});

		const first = current.applyMemoryBackend();
		await firstStarted.promise;
		const second = current.applyMemoryBackend();
		await Promise.resolve();
		expect(calls).toBe(1);
		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(maxRunning).toBe(1);
		expect(calls).toBe(2);
	});

	it("waits for backend reconciliation before building the agent-start prompt", async () => {
		const stopStarted = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const current = createSession(async () => []);
		await current.refreshBaseSystemPrompt();
		current.setMemoryBackendReconciler({
			depth: 0,
			parentSession: () => undefined,
			relatedSessions: () => [current],
			start: async () => {},
			stop: async () => {
				stopStarted.resolve();
				await releaseStop.promise;
			},
		});

		const reconcile = current.reconcileMemoryBackend();
		await stopStarted.promise;
		const reconcileWaitStarted = Promise.withResolvers<void>();
		const waitForReconcile = current.waitForMemoryBackendReconcile.bind(current);
		vi.spyOn(current, "waitForMemoryBackendReconcile").mockImplementation(() => {
			reconcileWaitStarted.resolve();
			return waitForReconcile();
		});

		const beforeAgentStartPrompt = vi.fn(async () => "memory from the reconciled backend");
		const reconciledBackend: MemoryBackend = {
			id: "openviking",
			async start() {},
			async buildDeveloperInstructions() {
				return undefined;
			},
			async clear() {},
			async enqueue() {},
			beforeAgentStartPrompt,
		};
		const backendResolutionStarted = Promise.withResolvers<void>();
		const resolveBackend = vi.spyOn(memoryBackend, "resolveMemoryBackend").mockImplementation(async () => {
			backendResolutionStarted.resolve();
			return reconciledBackend;
		});

		const prompt = current.sendUserMessage("remember the new account");
		let firstAgentStartBoundary: "reconcile-wait" | "backend-resolution" | "prompt-settled";
		let resolvedWhileBlocked = false;
		let injectedWhileBlocked = false;
		try {
			firstAgentStartBoundary = await Promise.race([
				reconcileWaitStarted.promise.then(() => "reconcile-wait" as const),
				backendResolutionStarted.promise.then(() => "backend-resolution" as const),
				prompt.then(
					() => "prompt-settled" as const,
					() => "prompt-settled" as const,
				),
			]);
			resolvedWhileBlocked = resolveBackend.mock.calls.length > 0;
			injectedWhileBlocked = beforeAgentStartPrompt.mock.calls.length > 0;
		} finally {
			releaseStop.resolve();
		}
		await Promise.all([reconcile, prompt]);

		expect(firstAgentStartBoundary).toBe("reconcile-wait");
		expect(resolvedWhileBlocked).toBe(false);
		expect(injectedWhileBlocked).toBe(false);
		expect(resolveBackend).toHaveBeenCalledTimes(1);
		expect(beforeAgentStartPrompt).toHaveBeenCalledTimes(1);
		expect(current.systemPrompt).toContain("memory from the reconciled backend");
	});

	it("stops the live backend reconciler within the requested disposal budget", async () => {
		const current = createSession(async () => []);
		let stopCalls = 0;
		let stopBudget: number | undefined;
		current.setMemoryBackendReconciler({
			depth: 0,
			parentSession: () => undefined,
			relatedSessions: () => [current],
			start: async () => {},
			stop: async options => {
				stopCalls++;
				stopBudget = options?.consolidateTimeoutMs;
			},
		});

		await current.dispose({ mnemopiConsolidateTimeoutMs: 123 });

		expect(stopCalls).toBe(1);
		expect(stopBudget).toBe(123);
	});
});
