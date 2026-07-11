import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	notices: string[];
}

async function createHarness(
	tempDir: TempDir,
	authStorage: AuthStorage,
	activeModel: { provider: GeneratedProvider; id: string },
): Promise<Harness> {
	const model = getBundledModel(activeModel.provider, activeModel.id);
	if (!model) throw new Error(`Missing bundled model ${activeModel.provider}/${activeModel.id}`);
	if (model.input.includes("image")) {
		throw new Error(`Expected text-only model, got vision-capable ${model.id}`);
	}
	authStorage.setRuntimeApiKey(activeModel.provider, "test-key");

	const modelRegistry = new ModelRegistry(authStorage);
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const seed: Message[] = [
		{ role: "user", content: "hello", timestamp: Date.now() },
		{
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	];
	for (const message of seed) sessionManager.appendMessage(message);
	const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
	if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");

	const settings = Settings.isolated({
		"compaction.strategy": "snapcompact",
		"compaction.keepRecentTokens": 1,
		modelRoles: { vision: "aimlapi/claude-sonnet-4-5-20250929" },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
	});
	vi.spyOn(compactionModule, "compact").mockResolvedValue({
		summary: "manual-compacted",
		shortSummary: undefined,
		firstKeptEntryId,
		tokensBefore: 123,
		details: {},
	});

	const notices: string[] = [];
	session.subscribe(event => {
		if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
	});

	return { session, sessionManager, notices };
}

describe("AgentSession manual /compact text-only snapcompact fallback", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
			session = undefined;
			authStorage = undefined;
			tempDir = undefined;
		}
	});

	it("falls back to LLM compaction instead of throwing when the active model is text-only", async () => {
		tempDir = TempDir.createSync("@pi-manual-snapcompact-text-only-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const harness = await createHarness(tempDir, authStorage, {
			provider: "aimlapi",
			id: "alibaba/qwen3-coder-480b-a35b-instruct",
		});
		session = harness.session;

		const result = await session.compact();

		expect(result.summary).toBe("manual-compacted");
		expect(compactionModule.compact).toHaveBeenCalled();
		expect(harness.notices.some(message => message.includes("text-only") && message.includes("falling back"))).toBe(
			true,
		);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "manual-compacted",
		});
	});
});
