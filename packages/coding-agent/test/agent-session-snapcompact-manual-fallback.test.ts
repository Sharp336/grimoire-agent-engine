/**
 * Regression test for manual `/compact` with a text-only active model.
 *
 * The snapcompact strategy renders conversation history as image frames that
 * the active model reads back on subsequent turns. A text-only model cannot
 * read those frames. Previously, manual `/compact` hard-failed with:
 *   "snapcompact cannot run locally: <model> is text-only."
 *
 * The fix mirrors the auto-compaction behavior: fall back to LLM-backed
 * context-full compaction (text→text summarization) instead of throwing.
 * The active text-only model handles LLM summarization fine; the compaction
 * candidate chain also includes any configured vision model as a fallback.
 */
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

interface ManualHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	notices: string[];
}

interface ManualHarnessOptions {
	activeModel: { provider: GeneratedProvider; id: string };
	seedMessages?: Message[];
}

async function createManualHarness(
	tempDir: TempDir,
	authStorage: AuthStorage,
	options: ManualHarnessOptions,
): Promise<ManualHarness> {
	const activeModel = getBundledModel(options.activeModel.provider, options.activeModel.id);
	if (!activeModel) {
		throw new Error(`Missing bundled model ${options.activeModel.provider}/${options.activeModel.id}`);
	}
	authStorage.setRuntimeApiKey(options.activeModel.provider, "test-key");

	const modelRegistry = new ModelRegistry(authStorage);
	const agent = new Agent({
		initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const seed = options.seedMessages ?? [{ role: "user", content: "hello", timestamp: Date.now() }];
	for (const message of seed) sessionManager.appendMessage(message);

	const settings = Settings.isolated({
		"compaction.strategy": "snapcompact",
		// Force a tiny kept-recent window so prepareCompaction splits the branch
		// into discard+summarize vs kept-recent, leaving non-empty work for compact().
		"compaction.keepRecentTokens": 1,
		modelRoles: { vision: "aimlapi/claude-sonnet-4-5-20250929" },
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

	vi.spyOn(compactionModule, "compact").mockResolvedValue({
		summary: "compacted",
		shortSummary: undefined,
		firstKeptEntryId: sessionManager.getBranch()[0]?.id ?? "",
		tokensBefore: 123,
		details: {},
	});

	const notices: string[] = [];
	session.subscribe(event => {
		if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
	});

	return { session, sessionManager, notices };
}

describe("AgentSession manual /compact snapcompact text-only fallback", () => {
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

	it("falls back to LLM compaction when the active model is text-only", async () => {
		tempDir = TempDir.createSync("@pi-snapcompact-manual-text-only-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));

		// Seed enough turn-pairs for prepareCompaction to split into
		// discard+summarize vs kept-recent (keepRecentTokens=1 forces a split).
		const filler = "the quick brown fox jumps over the lazy dog. ".repeat(64);
		const seedMessages: Message[] = [];
		for (let i = 0; i < 32; i++) {
			seedMessages.push({
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${filler}` }],
				timestamp: Date.now() - (32 - i) * 1000,
			});
			seedMessages.push({
				role: "assistant",
				content: [{ type: "text", text: `reply ${i}: ${filler}` }],
				timestamp: Date.now() - (32 - i) * 1000 + 100,
			});
		}

		const harness = await createManualHarness(tempDir, authStorage, {
			// qwen3-coder-480b is text-only — cannot read snapcompact frames.
			activeModel: { provider: "aimlapi", id: "alibaba/qwen3-coder-480b-a35b-instruct" },
			seedMessages,
		});
		session = harness.session;

		// Manual /compact must not throw; it must fall through to LLM summarization.
		const result = await session.compact();

		expect(result.summary).toBe("compacted");
		expect(compactionModule.compact).toHaveBeenCalled();
		expect(harness.notices).toContain(
			"snapcompact needs a vision-capable model (alibaba/qwen3-coder-480b-a35b-instruct is text-only); falling back to LLM compaction",
		);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "compacted",
		});
	});
});
