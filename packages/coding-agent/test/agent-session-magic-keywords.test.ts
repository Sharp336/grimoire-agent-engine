import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

async function createMagicKeywordSession(root: string): Promise<{
	session: AgentSession;
	settings: Settings;
	authStorage: AuthStorage;
}> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Claude Sonnet model");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
			thinkingLevel: Effort.High,
		},
	});
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const settings = Settings.isolated();
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
	});
	return { session, settings, authStorage };
}

describe("AgentSession magic keyword settings", () => {
	let root: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-magic-keywords-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
		session = undefined;
		authStorage = undefined;
	});

	it("does not append magic keyword notices when disabled", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this and ultrathink through it");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("honors non-ultrathink per-keyword notice toggles", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.orchestrate", false);
		created.settings.set("magicKeywords.workflow", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("still appends enabled non-ultrathink notices", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"workflow-notice",
		]);
	});

	it("does not use a disabled ultrathink keyword to force auto thinking", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.ultrathink", false);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		session.setThinkingLevel(AUTO_THINKING);

		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
	});

	it("injects the workflowz-mode context on every turn while the mode is active", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("do the thing");
		await session.prompt("do the next thing");

		// Standing posture: exactly one context per turn, on *every* turn. A one-shot
		// implementation that injected once and stopped would fail the second turn.
		expect(promptSpy.mock.calls.length).toBe(2);
		for (const call of promptSpy.mock.calls) {
			const messages = call[0] as unknown as Array<{ customType?: string; content?: string }>;
			const modeContext = messages.filter(message => message.customType === "workflowz-mode-context");
			expect(modeContext).toHaveLength(1);
			expect(modeContext[0]!.content).toContain("Workflowz mode is active");
			expect(modeContext[0]!.content).toContain("parallel(");
		}
	});

	it("does not duplicate the workflow notice when the keyword is typed while the mode is active", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this rollout");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		const types = promptMessages.map(message => message.customType).filter(Boolean);
		expect(types).toContain("workflowz-mode-context");
		expect(types).not.toContain("workflow-notice");
		expect(types.filter(type => type === "workflowz-mode-context")).toHaveLength(1);
	});

	it("queues the workflowz-mode context for steer turns while streaming", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);
		(session.agent.state as { isStreaming: boolean }).isStreaming = true;
		const customSpy = vi.spyOn(session, "sendCustomMessage");

		await session.prompt("do the thing", { streamingBehavior: "steer" });

		const queued = customSpy.mock.calls.filter(call => call[0].customType === "workflowz-mode-context");
		expect(queued).toHaveLength(1);
		expect(String(queued[0]![0].content)).toContain("parallel(");
		expect(queued[0]![1]).toMatchObject({ deliverAs: "steer" });
	});

	it("injects the workflowz-mode context for user-attributed skill prompts", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		// Skill invocations are real user turns, so they ride the same keyword-notice
		// rails as a typed prompt and carry the standing posture.
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "run the skill",
			display: true,
			attribution: "user",
			details: { args: "" },
		});

		const messages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(messages.filter(message => message.customType === "workflowz-mode-context")).toHaveLength(1);
	});

	it("does not inject the workflowz-mode context on synthetic prompts", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		// Synthetic/agent-authored turns (plan-mode recovery, todo reminders) are not
		// real user turns. The eval fan-out posture must not derail those corrective
		// turns, so it is gated exactly like the magic-keyword notices.
		await session.prompt("internal reminder", { synthetic: true });

		const messages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(messages.some(message => message.customType === "workflowz-mode-context")).toBe(false);
	});

	it("does not inject the workflowz-mode context on public steer()/followUp() turns", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);
		(session.agent.state as { isStreaming: boolean }).isStreaming = true;
		const customSpy = vi.spyOn(session, "sendCustomMessage");

		// The posture rides the magic-keyword-notice rails (prompt()/skill prompts
		// only), matching ultrathink/orchestrate/workflow. Programmatic steer() and
		// followUp() queue raw user messages and intentionally do not carry it.
		await session.steer("keep going");
		await session.followUp("and then continue");

		const queued = customSpy.mock.calls.filter(call => call[0].customType === "workflowz-mode-context");
		expect(queued).toHaveLength(0);
	});

	it("does not append the workflowz context out-of-band on an idle steer()", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);
		// A public steer() between turns must never push the hidden mode context into
		// history; the posture is delivered only through prompt()'s keyword-notice rails.
		expect(session.isStreaming).toBe(false);

		await session.steer("between turns");

		const messages = session.agent.state.messages as unknown as Array<{ customType?: string }>;
		const appended = messages.filter(message => message.customType === "workflowz-mode-context");
		expect(appended).toHaveLength(0);
	});

	it("filters the hidden workflowz context out of restored queued messages", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);
		(session.agent.state as { isStreaming: boolean }).isStreaming = true;

		// Streaming prompt() queues a visible user steer plus the hidden posture
		// (display:false). The Esc/dequeue editor-restore path (clearQueue) must hand
		// back only the user's text, never the hidden notice.
		await session.prompt("ship it", { streamingBehavior: "steer" });
		const { steering } = session.clearQueue();
		expect(steering.map(entry => entry.text)).toEqual(["ship it"]);
	});

	it("clears the session-only workflowz flag on newSession() so it never carries over", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setWorkflowzModeEnabled(true);

		// newSession() resets the session-only flag directly (covering headless/SDK
		// contexts with no reconciler) so the standing context never leaks into a
		// programmatically-created fresh session.
		await session.newSession();
		expect(session.getWorkflowzModeEnabled()).toBe(false);

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("fresh session work");
		const messages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(messages.some(message => message.customType === "workflowz-mode-context")).toBe(false);
	});
});
