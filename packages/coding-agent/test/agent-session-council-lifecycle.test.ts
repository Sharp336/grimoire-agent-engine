import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface TransitionGate {
	entered: Promise<void>;
	release(): void;
}

describe("AgentSession Council lifecycle seam", () => {
	let sharedDir: TempDir;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-council-lifecycle-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-council-lifecycle-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "source session", timestamp: 1 });
		await sessionManager.flush();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			session.setSessionTransitionReconciler(null);
			await session.dispose();
			session = undefined;
		}
		await tempDir.remove();
	});

	function installTransitionGate(onRelease?: () => void): TransitionGate {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const current = session;
		if (!current) throw new Error("Expected active session");
		current.setSessionTransitionReconciler(async () => {
			entered.resolve();
			await release.promise;
			onRelease?.();
		});
		return { entered: entered.promise, release: release.resolve };
	}

	it("settles planning cleanup before /new opens target storage", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const oldSessionId = sessionManager.getSessionId();
		const oldHandler = async () => ({ content: [{ type: "text" as const, text: "old" }] });
		const newHandler = async () => ({ content: [{ type: "text" as const, text: "new" }] });
		current.setCouncilHandler(oldHandler);
		const newSession = vi.spyOn(sessionManager, "newSession");
		const gate = installTransitionGate(() => {
			sessionManager.appendMessage({ role: "user", content: "late old Council prompt", timestamp: 2 });
			sessionManager.appendCustomMessageEntry("council-summary", "late old Council journal and summary", false);
			current.setCouncilHandler(null);
		});

		const transition = current.newSession();
		await gate.entered;
		expect(newSession).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect(await transition).toBeTrue();
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
		expect(JSON.stringify(sessionManager.getEntries())).not.toContain("late old Council");
		current.setCouncilHandler(newHandler);
		await Promise.resolve();
		expect(current.peekCouncilHandler()).toBe(newHandler);
	});

	it("settles reviewing work before a session switch loads the target", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const target = SessionManager.create(tempDir.path(), tempDir.path());
		target.appendMessage({ role: "user", content: "target session", timestamp: 3 });
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await target.close();
		const oldSessionId = sessionManager.getSessionId();
		const setSessionFile = vi.spyOn(sessionManager, "setSessionFile");
		const gate = installTransitionGate();

		const transition = current.switchSession(targetFile);
		await gate.entered;
		expect(setSessionFile).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect(await transition).toBeTrue();
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
	});

	it("settles reviewing work before fork changes the session identity", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const oldSessionId = sessionManager.getSessionId();
		const fork = vi.spyOn(sessionManager, "fork");
		const gate = installTransitionGate();

		const transition = current.fork();
		await gate.entered;
		expect(fork).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect(await transition).toBeTrue();
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
	});

	it("settles reviewing work before branching changes the session identity", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const sourceEntry = sessionManager.getBranch().find(entry => entry.type === "message");
		if (!sourceEntry) throw new Error("Expected source message");
		const oldSessionId = sessionManager.getSessionId();
		const newSession = vi.spyOn(sessionManager, "newSession");
		const gate = installTransitionGate();

		const transition = current.branch(sourceEntry.id);
		await gate.entered;
		expect(newSession).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect((await transition).cancelled).toBeFalse();
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
	});

	it("settles planning work before /move relocates session storage", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const oldSessionFile = sessionManager.getSessionFile();
		const moveTo = vi.spyOn(sessionManager, "moveTo");
		const gate = installTransitionGate();
		const targetCwd = path.join(tempDir.path(), "moved-worktree");

		const transition = current.moveSession(targetCwd);
		await gate.entered;
		expect(moveTo).not.toHaveBeenCalled();
		expect(sessionManager.getSessionFile()).toBe(oldSessionFile);

		gate.release();
		await transition;
		expect(moveTo).toHaveBeenCalledTimes(1);
		expect(sessionManager.getCwd()).toBe(targetCwd);
	});

	it("does not relocate storage when Council quiescence reaches its bounded deadline", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const oldSessionFile = sessionManager.getSessionFile();
		const oldCwd = sessionManager.getCwd();
		const moveTo = vi.spyOn(sessionManager, "moveTo");
		current.setSessionTransitionReconciler(async () => {
			throw new Error("Council cancellation did not settle before the transition deadline");
		});

		await expect(current.moveSession(path.join(tempDir.path(), "unsafe-target"))).rejects.toThrow(
			"Council cancellation did not settle before the transition deadline",
		);
		expect(moveTo).not.toHaveBeenCalled();
		expect(sessionManager.getSessionFile()).toBe(oldSessionFile);
		expect(sessionManager.getCwd()).toBe(oldCwd);
	});

	it("settles planning work before handoff creates its replacement session", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "source response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
		});
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("Continue safely");
		const oldSessionId = sessionManager.getSessionId();
		const newSession = vi.spyOn(sessionManager, "newSession");
		const gate = installTransitionGate();

		const transition = current.handoff();
		await gate.entered;
		expect(newSession).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect((await transition)?.document).toBe("Continue safely");
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
	});

	it("settles reviewing work before dispose closes storage", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const close = vi.spyOn(sessionManager, "close");
		const gate = installTransitionGate();

		const disposal = current.dispose();
		await gate.entered;
		expect(current.isDisposed).toBeTrue();
		expect(close).not.toHaveBeenCalled();

		gate.release();
		await disposal;
		expect(close).toHaveBeenCalledTimes(1);
		session = undefined;
	});
});
