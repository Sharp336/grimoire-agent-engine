/**
 * Tests that a registered session-switch reconciler (set via
 * `setSessionSwitchReconciler`, e.g. the headless goal-mode adapter's
 * `controller.restore()`) is invoked once after each SUCCESSFUL newSession()
 * and branch() transition — mirroring switchSession() — and never on
 * cancel paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession session-switch reconciler on newSession/branch", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-session-reconciler-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await tempDir?.remove();
		}
	});

	async function createSession(extensionRunner?: ExtensionRunner): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: async () => ({ content: ["ok"], stopReason: "stop" }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
	}

	async function seedUserMessage(): Promise<string> {
		await session.prompt("hello");
		await session.agent.waitForIdle();
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBeGreaterThan(0);
		return userMessages[0].entryId;
	}

	it("invokes a registered reconciler once after a successful newSession()", async () => {
		await createSession();
		let calls = 0;
		session.setSessionSwitchReconciler(async () => {
			calls++;
		});

		await expect(session.newSession()).resolves.toBe(true);
		expect(calls).toBe(1);
	});

	it("invokes a registered reconciler once after a successful branch()", async () => {
		await createSession();
		const entryId = await seedUserMessage();
		let calls = 0;
		session.setSessionSwitchReconciler(async () => {
			calls++;
		});

		const result = await session.branch(entryId);
		expect(result.cancelled).toBe(false);
		expect(calls).toBe(1);
	});

	it("does not invoke the reconciler when newSession() is cancelled by a hook", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_switch"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session_before_switch" ? { cancel: true } : undefined,
			),
		} as unknown as ExtensionRunner;
		await createSession(extensionRunner);
		let calls = 0;
		session.setSessionSwitchReconciler(async () => {
			calls++;
		});

		await expect(session.newSession()).resolves.toBe(false);
		expect(calls).toBe(0);
	});

	it("does not invoke the reconciler when branch() is cancelled by a hook", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session_before_branch" ? { cancel: true } : undefined,
			),
			// prompt() calls this unconditionally when an extension runner is set.
			emitBeforeAgentStart: vi.fn(async () => undefined),
		} as unknown as ExtensionRunner;
		await createSession(extensionRunner);
		const entryId = await seedUserMessage();
		let calls = 0;
		session.setSessionSwitchReconciler(async () => {
			calls++;
		});

		const result = await session.branch(entryId);
		expect(result.cancelled).toBe(true);
		expect(calls).toBe(0);
	});
});
