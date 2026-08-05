import { expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

it("removes a Copilot credential for 401 but retains it for a 403 account cap", async () => {
	const tempDir = TempDir.createSync("@pi-copilot-credential-removal-");
	const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model to exist");

	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
	});
	const removeSpy = spyOn(authStorage, "remove").mockResolvedValue(undefined);

	try {
		const unauthorized: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5-mini",
			stopReason: "error",
			errorMessage: "GitHub Copilot authentication failed (HTTP 401).",
			errorStatus: 401,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: unauthorized });
		agent.emitExternalEvent({ type: "agent_end", messages: [unauthorized] });
		await session.waitForIdle();
		expect(removeSpy).toHaveBeenCalledWith("github-copilot");

		removeSpy.mockClear();
		const accountCap: AssistantMessage = {
			...unauthorized,
			errorMessage: "Reached overall message rate limit. Your limit will reset in 13 minutes.",
			errorStatus: 403,
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: accountCap });
		agent.emitExternalEvent({ type: "agent_end", messages: [accountCap] });
		await session.waitForIdle();
		expect(removeSpy).not.toHaveBeenCalled();
	} finally {
		await session.dispose();
		removeSpy.mockRestore();
		authStorage.close();
		tempDir.removeSync();
	}
});

it("retains a Copilot credential for a 403 concurrency cap", async () => {
	const tempDir = TempDir.createSync("@pi-copilot-concurrency-cap-");
	const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model to exist");

	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry,
	});
	const removeSpy = spyOn(authStorage, "remove").mockResolvedValue(undefined);

	try {
		// Simulate the real provider catch-block flow: finalize() calls
		// classify(ProviderHttpError(...)) and sets errorId on the message.
		// Without the F3 fix, classify() structurally adds AuthFailed for every
		// 403 ProviderHttpError, and the agent-session guard deletes the
		// still-valid credential.
		const cap403 = new ProviderHttpError("Too many concurrent requests", 403);
		const concurrencyCap: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5-mini",
			stopReason: "error",
			errorMessage: "Too many concurrent requests",
			errorStatus: 403,
			errorId: AIError.classify(cap403, "openai-responses"),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: concurrencyCap });
		agent.emitExternalEvent({ type: "agent_end", messages: [concurrencyCap] });
		await session.waitForIdle();
		// A concurrency cap is transient — the credential is still valid, so
		// it must NOT be removed. Without the AuthFailed suppression in
		// classify(), the structural 403 sets Flag.AuthFailed and the guard
		// deletes the credential.
		expect(removeSpy).not.toHaveBeenCalled();
	} finally {
		await session.dispose();
		removeSpy.mockRestore();
		authStorage.close();
		tempDir.removeSync();
	}
});
