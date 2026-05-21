import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function getAnthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return model;
}

function assistantMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "seed response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("AgentSession approved plan references", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;
	let session: AgentSession;
	let model: Model;
	let capturedAgentPrompts: AgentMessage[][];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-plan-reference-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		model = getAnthropicModel();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		capturedAgentPrompts = [];
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(extensionRunner?: ExtensionRunner): AgentSession {
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Base instructions"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1 }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	async function createCompactionExtension(): Promise<ExtensionRunner> {
		const extensionPath = path.join(tempDir.path(), "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => ({',
				"\t\tcompaction: {",
				'\t\t\tsummary: "compacted",',
				"\t\t\tshortSummary: undefined,",
				"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\tdetails: {},",
				"\t\t},",
				"\t}));",
				"}",
			].join("\n"),
		);
		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		return new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
	}

	async function writePlan(planFilePath: string, content: string): Promise<void> {
		const resolvedPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPath, content);
	}

	function mockAgentPrompt(): void {
		vi.spyOn(session.agent, "prompt").mockImplementation(messageOrMessages => {
			if (!Array.isArray(messageOrMessages)) throw new Error("Expected Agent.prompt to receive a message array");
			capturedAgentPrompts.push(messageOrMessages);
			return Promise.resolve();
		});
	}

	function capturedPromptMessages(): AgentMessage[] {
		const messages = capturedAgentPrompts.at(-1);
		if (!messages) throw new Error("Expected Agent.prompt to receive a message array");
		return messages;
	}

	it("re-injects the approved plan reference after manual compaction rewrites history", async () => {
		const extensionRunner = await createCompactionExtension();
		createSession(extensionRunner);
		const planFilePath = "local://approved-plan.md";
		await writePlan(planFilePath, "# Approved Plan\n\n- [ ] Keep executing this plan");
		session.setPlanReferencePath(planFilePath);
		session.markPlanReferenceSent();

		sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() - 1 });
		sessionManager.appendMessage(assistantMessage(model));

		await session.compact();

		mockAgentPrompt();
		await session.prompt("continue", { expandPromptTemplates: false, skipCompactionCheck: true });

		const planReference = capturedPromptMessages().find(
			message =>
				typeof message === "object" &&
				message !== null &&
				"role" in message &&
				message.role === "custom" &&
				"customType" in message &&
				message.customType === "plan-mode-reference",
		);
		expect(planReference).toEqual(
			expect.objectContaining({
				content: expect.stringContaining(planFilePath),
			}),
		);
		expect(planReference).toEqual(
			expect.objectContaining({
				content: expect.stringContaining("# Approved Plan"),
			}),
		);
	});

	it("uses a newly approved plan path on the next turn", async () => {
		createSession();
		await writePlan("local://first-plan.md", "# First Plan");
		await writePlan("local://second-plan.md", "# Second Plan");
		mockAgentPrompt();

		session.setPlanReferencePath("local://first-plan.md");
		await session.prompt("first", { expandPromptTemplates: false, skipCompactionCheck: true });
		expect(capturedPromptMessages()).toContainEqual(
			expect.objectContaining({
				customType: "plan-mode-reference",
				content: expect.stringContaining("# First Plan"),
			}),
		);

		session.setPlanReferencePath("local://second-plan.md");
		await session.prompt("second", { expandPromptTemplates: false, skipCompactionCheck: true });
		expect(capturedPromptMessages()).toContainEqual(
			expect.objectContaining({
				customType: "plan-mode-reference",
				content: expect.stringContaining("# Second Plan"),
			}),
		);
	});

	it("keeps the approved plan recovery path in the per-turn system prompt", async () => {
		createSession();
		const planFilePath = "local://approved-plan.md";
		await writePlan(planFilePath, "# Approved Plan");
		session.setPlanReferencePath(planFilePath);
		session.markPlanReferenceSent();
		mockAgentPrompt();
		const setSystemPromptSpy = vi.spyOn(session.agent, "setSystemPrompt");

		await session.prompt("continue", { expandPromptTemplates: false, skipCompactionCheck: true });

		const systemPrompt = setSystemPromptSpy.mock.calls.at(-1)?.[0];
		expect(systemPrompt?.join("\n")).toContain(planFilePath);
		expect(systemPrompt?.join("\n")).toContain(`read("${planFilePath}")`);
	});

	it("restores an approved plan reference from persisted session metadata", async () => {
		const planFilePath = "local://persisted-plan.md";
		sessionManager.appendModeChange("none", { approvedPlanFilePath: planFilePath });
		createSession();
		await writePlan(planFilePath, "# Persisted Plan");
		mockAgentPrompt();

		await session.prompt("resume", { expandPromptTemplates: false, skipCompactionCheck: true });

		expect(capturedPromptMessages()).toContainEqual(
			expect.objectContaining({
				customType: "plan-mode-reference",
				content: expect.stringContaining("# Persisted Plan"),
			}),
		);
	});
});
