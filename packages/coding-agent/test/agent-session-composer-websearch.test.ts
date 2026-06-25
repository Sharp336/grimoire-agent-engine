import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CursorWebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search/cursor-alias";
import { CURSOR_WEB_SEARCH_TOOL_NAME } from "@oh-my-pi/pi-coding-agent/web/search/composer-surface";
import { TempDir } from "@oh-my-pi/pi-utils";

const FAKE_SESSION = {} as ConstructorParameters<typeof CursorWebSearchTool>[0];

type Harness = {
	session: AgentSession;
	mock: ReturnType<typeof createMockModel>;
	authStorage: AuthStorage;
	tempDir: TempDir;
};

const activeHarnesses: Harness[] = [];

function thinkingOnlyStop(): MockResponse {
	return {
		content: [{ type: "thinking", thinking: "I should call WebSearch next." }],
		stopReason: "stop",
		usage: { output: 1, cacheRead: 100 },
	};
}

function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(message => {
		if (message.role !== "developer") return false;
		return typeof message.content === "string"
			? message.content.includes("<system-injection>")
			: message.content.some(content => content.type === "text" && content.text.includes("<system-injection>"));
	});
}

async function createComposerHarness(responses: MockResponse[]): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-composer-websearch-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ id: "grok-composer-2.5-fast", provider: "mock", responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
	});
	settings.setModelRole("default", `mock/${mock.id}`);

	const webSearchTool = new CursorWebSearchTool(FAKE_SESSION);
	const recordTool: AgentTool = {
		name: "record",
		label: "Record",
		description: "Record a value",
		parameters: z.object({ value: z.string() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `recorded:${params.value}` }],
				details: { value: params.value },
			};
		},
	};

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const tools = [recordTool, webSearchTool];
	let session: AgentSession;
	const agent = new Agent({
		getApiKey: () => "test-key",
		getToolChoice: () => session.nextToolChoice(),
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	agent.setModel({ ...mock, api: "openai-responses" });
	await session.setActiveToolsByName(["record", CURSOR_WEB_SEARCH_TOOL_NAME]);

	const harness = { session, mock, authStorage, tempDir };
	activeHarnesses.push(harness);
	return harness;
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
});

describe("AgentSession composer web search phase 2", () => {
	it("forces WebSearch on search-intent user prompts", async () => {
		const { session, mock } = await createComposerHarness([
			{
				content: [
					{
						type: "toolCall",
						id: "call-websearch",
						name: CURSOR_WEB_SEARCH_TOOL_NAME,
						arguments: { search_term: "glm 5.2 review" },
					},
				],
				stopReason: "toolUse",
			},
			{ content: ["done"], stopReason: "stop" },
		]);

		await session.prompt("web search for glm 5.2 review");
		await session.waitForIdle();

		expect(mock.calls[0]?.options?.toolChoice).toEqual({
			type: "function",
			name: CURSOR_WEB_SEARCH_TOOL_NAME,
		});
	});

	it("adds composer-specific empty-stop guidance after thinking-only stops", async () => {
		const { session } = await createComposerHarness([
			thinkingOnlyStop(),
			{
				content: [
					{
						type: "toolCall",
						id: "call-websearch",
						name: CURSOR_WEB_SEARCH_TOOL_NAME,
						arguments: { search_term: "glm 5.2 review" },
					},
				],
				stopReason: "toolUse",
			},
			{ content: ["done"], stopReason: "stop" },
		]);

		await session.prompt("web search for glm 5.2 review");
		await session.waitForIdle();

		const reminderText = reminderMessages(session.agent.state.messages)
			.flatMap(message =>
				typeof message.content === "string"
					? [message.content]
					: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
			)
			.join("\n");

		expect(reminderText).toContain(CURSOR_WEB_SEARCH_TOOL_NAME);
		expect(reminderText).toContain("search_term");
	});
});