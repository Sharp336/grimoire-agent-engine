import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const UNRENDERABLE_SNAPCOMPACT_TEXT = "\uE000\uE001\uE002\uE003\uE004\uE005\uE006\uE007\uE008\uE009";

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	activeModel: Model;
	notices: string[];
	awaitCompactionEnd: () => Promise<{ action: string; errorMessage?: string }>;
	triggerThreshold: () => void;
}

interface HarnessOptions {
	activeModel: { provider: GeneratedProvider; id: string };
	compactionModel?: { provider: GeneratedProvider; id: string };
	preferProviderNative?: boolean;
	seedMessages?: Message[];
}

async function createHarness(
	modelRegistry: ModelRegistry,
	authStorage: AuthStorage,
	options: HarnessOptions,
): Promise<Harness> {
	const bundledModel = getBundledModel(options.activeModel.provider, options.activeModel.id);
	if (!bundledModel)
		throw new Error(`Missing bundled model ${options.activeModel.provider}/${options.activeModel.id}`);
	authStorage.setRuntimeApiKey(options.activeModel.provider, "test-key");
	let activeModel = bundledModel;
	if (options.compactionModel) {
		const target = getBundledModel(options.compactionModel.provider, options.compactionModel.id);
		if (!target) {
			throw new Error(`Missing bundled model ${options.compactionModel.provider}/${options.compactionModel.id}`);
		}
		authStorage.setRuntimeApiKey(target.provider, "test-key");
		activeModel = buildModel({
			...bundledModel,
			compactionModel: `${target.provider}/${target.id}`,
			compat: bundledModel.compatConfig,
		});
	}
	const agent = new Agent({
		initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const sessionManager = SessionManager.inMemory();
	const seed = options.seedMessages ?? [{ role: "user", content: "hello", timestamp: Date.now() }];
	for (const message of seed) sessionManager.appendMessage(message);
	const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
	if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");

	const settings = Settings.isolated({
		"compaction.strategy": "snapcompact",
		// Force a 1-token recent window so the post-turn cut always splits off the
		// last turn and summarizes the seeded unrenderable history. With the default
		// 20k window the cut keeps both tiny messages, leaving nothing for
		// snapcompact's renderability preflight to scan.
		"compaction.keepRecentTokens": 1,
		modelRoles: { vision: "aimlapi/claude-sonnet-4-5-20250929" },
	});
	if (options.preferProviderNative !== undefined) {
		settings.set("compaction.preferProviderNative", options.preferProviderNative);
	}
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
	});
	vi.spyOn(compactionModule, "compact").mockResolvedValue({
		summary: "compacted",
		shortSummary: undefined,
		firstKeptEntryId,
		tokensBefore: 123,
		details: {},
	});

	const end = Promise.withResolvers<{ action: string; errorMessage?: string }>();
	const notices: string[] = [];
	session.subscribe(event => {
		if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
		if (event.type === "auto_compaction_end") {
			end.resolve({ action: event.action, errorMessage: event.errorMessage });
		}
	});

	const triggerThreshold = () => {
		// Prompt tokens above the auto-compaction threshold but below the model's
		// context window: post-turn maintenance must run a threshold compaction,
		// NOT the overflow recovery path (which drops the just-ended turn before
		// snapcompact's renderability preflight can scan it, leaving nothing to
		// summarize). Derived from the live window so the fixture survives model
		// metadata changes (claude-sonnet-4-5's 200k window is narrower than the
		// vision-role qwen's, so a fixed count would overflow one of them).
		const contextWindow = activeModel.contextWindow ?? 0;
		const thresholdTokens = compactionModule.resolveThresholdTokens(contextWindow, settings.getGroup("compaction"));
		const promptTokens = contextWindow > 0 ? Math.floor((thresholdTokens + contextWindow) / 2) : 246_000;
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: activeModel.api,
			provider: activeModel.provider,
			model: activeModel.id,
			stopReason: "stop" as const,
			usage: {
				input: promptTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
	};

	return { session, sessionManager, activeModel, notices, awaitCompactionEnd: () => end.promise, triggerThreshold };
}

describe("AgentSession auto snapcompact routing", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("aimlapi", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
	});

	it("downgrades to context-full when the active model cannot read snapcompact frames", async () => {
		const harness = await createHarness(modelRegistry, authStorage, {
			activeModel: { provider: "aimlapi", id: "alibaba/qwen3-coder-480b-a35b-instruct" },
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result).toEqual({ action: "context-full", errorMessage: undefined });
		expect(compactionModule.compact).toHaveBeenCalled();
		expect(harness.notices).toContain(
			"snapcompact needs a vision-capable active model (alibaba/qwen3-coder-480b-a35b-instruct is text-only); using context-full auto-compaction instead.",
		);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "compacted",
		});
	});

	it("downgrades to context-full when unsupported glyphs make snapcompact unsafe", async () => {
		const harness = await createHarness(modelRegistry, authStorage, {
			activeModel: { provider: "aimlapi", id: "claude-sonnet-4-5-20250929" },
			seedMessages: [
				{
					role: "user",
					content: UNRENDERABLE_SNAPCOMPACT_TEXT.repeat(10),
					timestamp: Date.now(),
				},
			],
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result.action).toBe("context-full");
		expect(result.errorMessage).toBeUndefined();
		expect(compactionModule.compact).toHaveBeenCalled();
		const unsupportedGlyphNotice = harness.notices.find(message =>
			message.startsWith("snapcompact disabled: unsupported characters for selected snapcompact font"),
		);
		expect(unsupportedGlyphNotice).toBeDefined();
		expect(unsupportedGlyphNotice).toContain("using context-full auto-compaction instead.");
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "compacted",
		});
	});

	it("uses context-full compaction for text-only DSV4 Pro even when native compaction is preferred", async () => {
		const harness = await createHarness(modelRegistry, authStorage, {
			activeModel: { provider: "zenmux", id: "deepseek/deepseek-v4-pro" },
			preferProviderNative: true,
		});
		session = harness.session;
		expect(harness.activeModel.input).toEqual(["text"]);
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result).toEqual({ action: "context-full", errorMessage: undefined });
		expect(harness.notices).toContain(
			"snapcompact needs a vision-capable active model (deepseek/deepseek-v4-pro is text-only); using context-full auto-compaction instead.",
		);
		expect(
			harness.notices.some(message => message.includes("provider-native compaction instead of snapcompact")),
		).toBe(false);
	});

	it("keeps snapcompact ahead of provider-native compaction by default", async () => {
		const harness = await createHarness(modelRegistry, authStorage, {
			activeModel: { provider: "openai-codex", id: "gpt-5.5" },
			seedMessages: [{ role: "user", content: UNRENDERABLE_SNAPCOMPACT_TEXT.repeat(10), timestamp: Date.now() }],
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result.action).toBe("context-full");
		expect(
			harness.notices.find(message =>
				message.startsWith("snapcompact disabled: unsupported characters for selected snapcompact font"),
			),
		).toBeDefined();
		expect(
			harness.notices.some(message => message.includes("provider-native compaction instead of snapcompact")),
		).toBe(false);
	});

	it("uses provider-native compaction instead of snapcompact when preferred", async () => {
		const harness = await createHarness(modelRegistry, authStorage, {
			activeModel: { provider: "openai-codex", id: "gpt-5.5" },
			preferProviderNative: true,
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result).toEqual({ action: "context-full", errorMessage: undefined });
		expect(harness.notices).toContain(
			"openai-codex compacts server-side; using provider-native compaction instead of snapcompact.",
		);
	});

	it("keeps snapcompact when the configured compaction model is not provider-native", async () => {
		const harness = await createHarness(modelRegistry, authStorage, {
			activeModel: { provider: "openai-codex", id: "gpt-5.5" },
			compactionModel: { provider: "aimlapi", id: "claude-sonnet-4-5-20250929" },
			preferProviderNative: true,
			seedMessages: [{ role: "user", content: UNRENDERABLE_SNAPCOMPACT_TEXT.repeat(10), timestamp: Date.now() }],
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result.action).toBe("context-full");
		expect(
			harness.notices.find(message =>
				message.startsWith("snapcompact disabled: unsupported characters for selected snapcompact font"),
			),
		).toBeDefined();
		expect(
			harness.notices.some(message => message.includes("provider-native compaction instead of snapcompact")),
		).toBe(false);
	});
});
