/**
 * Tests for skill invocation tracking in AcpAgent.#tryRunSkillCommand.
 *
 * Drives `/skill:<name>` prompts through the real AcpAgent using a minimal
 * FakeAgentSession that emits the lifecycle events AcpAgent needs to settle
 * its prompt turn.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import type { Model } from "@oh-my-pi/pi-ai";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ACP_BOOTSTRAP_RACE_GUARD_MS, AcpAgent } from "../src/modes/acp/acp-agent";
import type { PlanModeState } from "../src/plan-mode/state";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";
import type { AgentStorage } from "../src/session/agent-storage";
import { SessionManager } from "../src/session/session-manager";

// ---------------------------------------------------------------------------
// Minimal model
// ---------------------------------------------------------------------------

const TEST_MODEL: Model = {
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function makeAssistantMessage() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "skill pong" }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: TEST_MODEL.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// FakeAgentSession — emits lifecycle events so AcpAgent prompt turn settles
// ---------------------------------------------------------------------------

class FakeAgentSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined = TEST_MODEL;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	fastMode = false;
	forcedToolChoice: string | undefined;
	get settings(): Settings {
		return Settings.instance;
	}
	promptCalls: string[] = [];
	customMessages: Array<{ customType: string; content: string; details?: unknown }> = [];
	skillsSettings = { enableSkillCommands: true };
	skills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string }> = [];
	planModeState: PlanModeState | undefined;
	#listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(cwd: string) {
		this.sessionManager = SessionManager.create(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = {
			sessionId: this.sessionId,
			waitForIdle: async () => this.waitForIdle(),
		};
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return { getApiKey: async () => "test-key" };
	}

	getAvailableModels(): Model[] {
		return [TEST_MODEL];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(level: string | undefined): void {
		this.thinkingLevel = level;
	}

	setSlashCommands(_commands: unknown[]): void {}

	async refreshSshTool(): Promise<void> {}

	async setModel(model: Model): Promise<void> {
		this.model = model;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	async prompt(text: string): Promise<void> {
		this.promptCalls.push(text);
		this.isStreaming = true;
		const msg = makeAssistantMessage();
		this.#emit({
			type: "message_update",
			message: msg,
			assistantMessageEvent: { type: "text_delta", delta: "skill pong" },
		} as AgentSessionEvent);
		this.sessionManager.appendMessage(msg);
		this.#emit({ type: "agent_end", messages: [msg] } as AgentSessionEvent);
		this.isStreaming = false;
	}

	async waitForIdle(): Promise<void> {}

	async drainAsyncJobDeliveriesForAcp(): Promise<boolean> {
		return false;
	}

	async abort(): Promise<void> {
		this.isStreaming = false;
	}

	/** Must emit agent_end so AcpAgent's prompt turn settles. */
	async promptCustomMessage(message: { customType: string; content: string; details?: unknown }): Promise<void> {
		this.customMessages.push(message);
		this.isStreaming = true;
		const msg = makeAssistantMessage();
		this.#emit({
			type: "message_update",
			message: msg,
			assistantMessageEvent: { type: "text_delta", delta: "skill pong" },
		} as AgentSessionEvent);
		this.sessionManager.appendMessage(msg);
		this.#emit({ type: "agent_end", messages: [msg] } as AgentSessionEvent);
		this.isStreaming = false;
	}

	async refreshMCPTools(): Promise<void> {}

	getContextUsage(): undefined {
		return undefined;
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		await this.sessionManager.setSessionFile(sessionPath);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.sessionManager.close();
	}

	async reload(): Promise<void> {}

	async newSession(): Promise<boolean> {
		await this.sessionManager.newSession();
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}

	async branch(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}

	async navigateTree(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}

	getActiveToolNames(): string[] {
		return [];
	}

	getAllToolNames(): string[] {
		return [];
	}

	setActiveToolsByName(): void {}
	setClientBridge(): void {}

	getPlanModeState(): PlanModeState | undefined {
		return this.planModeState;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.planModeState = state;
	}

	standingResolveHandler: ((input: unknown) => Promise<unknown> | unknown) | undefined;

	setStandingResolveHandler(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void {
		this.standingResolveHandler = handler ?? undefined;
	}

	peekStandingResolveHandler(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.standingResolveHandler;
	}

	planReferencePath: string | undefined;

	setPlanReferencePath(p: string): void {
		this.planReferencePath = p;
	}

	getToolByName(): undefined {
		return undefined;
	}

	toggleFastMode(): boolean {
		this.fastMode = !this.fastMode;
		return this.fastMode;
	}

	setFastMode(enabled: boolean): void {
		this.fastMode = enabled;
	}

	isFastModeEnabled(): boolean {
		return this.fastMode;
	}

	setForcedToolChoice(toolName: string): void {
		this.forcedToolChoice = toolName;
	}

	async sendCustomMessage(): Promise<void> {}
	async sendUserMessage(): Promise<void> {}
	async compact(): Promise<void> {}

	async fork(): Promise<boolean> {
		await this.sessionManager.flush();
		const forked = await this.sessionManager.fork();
		if (!forked) return false;
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const cleanupRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	resetSettingsForTest();
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function createHarness(): Promise<{
	agent: AcpAgent;
	fakeSession: FakeAgentSession;
	sessionId: string;
}> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-skill-track-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwd, { recursive: true });
	setAgentDir(agentDir);
	await Settings.init({ agentDir, inMemory: true });

	const updates: SessionNotification[] = [];
	const abortController = new AbortController();
	const connection = {
		sessionUpdate: async (notification: SessionNotification) => {
			updates.push(notification);
		},
		signal: abortController.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	const fakeSession = new FakeAgentSession(cwd);
	const agent = new AcpAgent(
		connection,
		async () => fakeSession as unknown as AgentSession,
		fakeSession as unknown as AgentSession,
	);

	const created = await agent.newSession({ cwd, mcpServers: [] });
	const sessionId = created.sessionId;
	await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 30);

	return { agent, fakeSession, sessionId };
}

function makeFakeStorage(): AgentStorage & { _calls: string[] } {
	const calls: string[] = [];
	return {
		_calls: calls,
		recordSkillUsage(skillName: string) {
			calls.push(skillName);
		},
	} as unknown as AgentStorage & { _calls: string[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AcpAgent #tryRunSkillCommand skill tracking", () => {
	it("/skill:foo via ACP prompt records skill usage", async () => {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-skill-file-"));
		cleanupRoots.push(tmpDir);
		const skillFile = path.join(tmpDir, "SKILL.md");
		await fs.promises.writeFile(skillFile, "# my-skill\nDoes things.\n");

		const { agent, fakeSession, sessionId } = await createHarness();

		fakeSession.skills.push({
			name: "my-skill",
			description: "A test skill",
			filePath: skillFile,
			baseDir: tmpDir,
			source: "test",
		});

		const storage = makeFakeStorage();
		spyOn(Settings.instance, "getStorage").mockReturnValue(storage);

		await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "/skill:my-skill" }],
		} as PromptRequest);

		expect(storage._calls).toEqual(["my-skill"]);
	});

	it("unknown /skill:missing via ACP prompt does NOT record usage", async () => {
		const { agent, sessionId } = await createHarness();

		const storage = makeFakeStorage();
		spyOn(Settings.instance, "getStorage").mockReturnValue(storage);

		await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "/skill:missing" }],
		} as PromptRequest);

		expect(storage._calls).toEqual([]);
	});
});
