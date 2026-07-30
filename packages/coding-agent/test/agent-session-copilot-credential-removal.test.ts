import { expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
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
