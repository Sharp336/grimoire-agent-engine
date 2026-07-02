import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

function isPlanApprovedPrompt(text: string): boolean {
	return text.includes("Plan approved.") && text.includes("You MUST read");
}

describe("InteractiveMode plan approve compact busy", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let mode: InteractiveMode;

	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		sharedTempDir = TempDir.createSync("@pi-plan-review-shared-");
		await Settings.init({ inMemory: true, cwd: sharedTempDir.path() });
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage?.close();
		sharedTempDir?.removeSync();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-plan-review-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		const currentMode = mode;
		const currentSession = session;
		const currentTempDir = tempDir;
		mode = undefined as unknown as InteractiveMode;
		session = undefined as unknown as AgentSession;
		tempDir = undefined as unknown as TempDir;
		currentMode?.stop();
		await currentSession?.dispose();
		currentTempDir?.removeSync();
		setKeybindings(KeybindingsManager.inMemory());
		resetSettingsForTest();
	});

	it("avoids AgentBusyError during plan approval with compaction when user message is queued", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;

		let streaming = false;
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => streaming,
		});

		const abortSpy = vi.spyOn(session, "abort").mockImplementation(async () => {
			// Do NOT clear streaming, simulating the race where isStreaming remains/becomes true
		});

		const calls: {
			type: "prompt" | "followUp";
			text: string;
			options?: { streamingBehavior?: string; synthetic?: boolean };
		}[] = [];

		vi.spyOn(session, "prompt").mockImplementation(async (text, opts) => {
			calls.push({ type: "prompt", text, options: opts });
			if (text === "queued message") {
				streaming = true;
			}
			if (streaming && !(opts as { streamingBehavior?: string } | undefined)?.streamingBehavior) {
				throw new AgentBusyError();
			}
			return true;
		});

		vi.spyOn(session, "followUp").mockImplementation(async (text, _images, options) => {
			calls.push({ type: "followUp", text, options });
		});

		session.sessionManager.appendMessage({ role: "user", content: "seed one", timestamp: Date.now() - 2 });
		session.sessionManager.appendMessage({ role: "user", content: "seed two", timestamp: Date.now() - 1 });
		vi.spyOn(session, "compact").mockImplementation(async () => {
			mode.queueCompactionMessage("queued message", "followUp");
			return undefined as never;
		});

		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, options) => {
			return options[1]; // Approve and compact context
		});

		const errorSpy = vi.spyOn(mode, "showError");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Failed to finalize approved plan"));

		// Find the index of the queued message in `calls`
		const queuedMessageIndex = calls.findIndex(c => c.text === "queued message");
		expect(queuedMessageIndex).toBeGreaterThanOrEqual(0);

		// Find the index of the plan-approved message in `calls`
		const planApprovedIndex = calls.findIndex(c => isPlanApprovedPrompt(c.text));
		expect(planApprovedIndex).toBeGreaterThanOrEqual(0);

		// Assert that the plan-approved prompt lands AFTER the queued message as a hidden synthetic follow-up.
		expect(planApprovedIndex).toBeGreaterThan(queuedMessageIndex);
		expect(calls[planApprovedIndex]).toMatchObject({
			type: "followUp",
			options: { synthetic: true },
		});

		expect(abortSpy).toHaveBeenCalled();
	});

	it("queues approved plan as synthetic follow-up when prompt dispatch becomes busy", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;

		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => false,
		});

		vi.spyOn(session, "abort").mockResolvedValue();

		const calls: {
			type: "prompt" | "followUp";
			text: string;
			options?: { synthetic?: boolean };
		}[] = [];

		vi.spyOn(session, "prompt").mockImplementation(async (text, opts) => {
			calls.push({ type: "prompt", text, options: opts });
			throw new AgentBusyError();
		});

		vi.spyOn(session, "followUp").mockImplementation(async (text, _images, options) => {
			calls.push({ type: "followUp", text, options });
		});

		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, options) => {
			return options[2]; // Approve and keep context
		});

		const errorSpy = vi.spyOn(mode, "showError");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Failed to finalize approved plan"));

		const planPromptIndex = calls.findIndex(c => c.type === "prompt" && isPlanApprovedPrompt(c.text));
		expect(planPromptIndex).toBeGreaterThanOrEqual(0);
		expect(calls[planPromptIndex]?.options).toMatchObject({ synthetic: true });

		const queuedPlanIndex = calls.findIndex(c => c.type === "followUp" && isPlanApprovedPrompt(c.text));
		expect(queuedPlanIndex).toBeGreaterThan(planPromptIndex);
		expect(calls[queuedPlanIndex]).toMatchObject({
			type: "followUp",
			options: { synthetic: true },
		});
	});
});
