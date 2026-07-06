import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

/**
 * Regression: when the user sets `modelRoles.default` to a model on a different
 * provider than the current chat, compaction must still pick the active chat's
 * model first. Otherwise an Anthropic chat would route compaction through the
 * OpenAI remote-compaction endpoint (gated by `shouldUseOpenAiRemoteCompaction`),
 * even though the live conversation never used OpenAI.
 */
describe("compaction prefers the current session model over modelRoles.default", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compact-current-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	function modelKey(model: { provider: string; id: string }): string {
		return `${model.provider}/${model.id}`;
	}

	function activeModelKey(): string {
		if (!session.model) throw new Error("Expected session model to remain selected");
		return modelKey(session.model);
	}

	function appendCompactableHistory(targetSession: AgentSession): void {
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			targetSession.agent.appendMessage(user);
			targetSession.sessionManager.appendMessage(user);
			targetSession.agent.appendMessage(assistant);
			targetSession.sessionManager.appendMessage(assistant);
		}
	}

	async function createCompactionSession(
		currentModel: Model,
		settings: Settings,
		authenticatedModels: readonly Model[],
	): Promise<void> {
		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		for (const model of authenticatedModels) {
			authStorage.setRuntimeApiKey(model.provider, `${model.provider}-token`);
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		appendCompactableHistory(session);
	}

	function mockCompaction() {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "ok",
			shortSummary: "ok short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: { provider: model.provider },
		}));
	}

	it("uses the active Anthropic chat model when modelRoles.default points at an OpenAI model", async () => {
		const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const defaultRoleModel = getBundledModel("openai", "gpt-5");
		if (!currentModel || !defaultRoleModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		settings.setModelRole("default", modelKey(defaultRoleModel));
		await createCompactionSession(currentModel, settings, [currentModel, defaultRoleModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(currentModel));
	});

	it("uses modelRoles.compaction before the default fast model and leaves the active model unchanged", async () => {
		const currentModel = getBundledModel("openai", "gpt-5.3-codex");
		const compactionRoleModel = getBundledModel("openai", "gpt-5");
		const fastModel = getBundledModel("openai", "gpt-5.3-codex-spark");
		if (!currentModel || !compactionRoleModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		settings.setModelRole("compaction", modelKey(compactionRoleModel));
		await createCompactionSession(currentModel, settings, [currentModel, fastModel, compactionRoleModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(compactionRoleModel));
		expect(activeModelKey()).toBe(modelKey(currentModel));
	});

	it("uses the provider-local fast compaction model before the active Codex subscription model by default", async () => {
		const currentModel = getBundledModel("openai-codex", "gpt-5.3-codex");
		const fastModel = getBundledModel("openai-codex", "gpt-5.3-codex-spark");
		if (!currentModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		await createCompactionSession(currentModel, settings, [currentModel, fastModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(fastModel));
		expect(activeModelKey()).toBe(modelKey(currentModel));
	});

	it("keeps the active metered OpenAI model when the inferred fast model would forfeit cached input pricing", async () => {
		// API-key OpenAI compaction replays the session's native history, which
		// bills mostly at the 10x-cheaper cacheRead rate on the session model.
		// Spark shares codex's list price, so rerouting the replay to it would be
		// a pure cost regression — the inferred default must not do that silently.
		const currentModel = getBundledModel("openai", "gpt-5.3-codex");
		const fastModel = getBundledModel("openai", "gpt-5.3-codex-spark");
		if (!currentModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		await createCompactionSession(currentModel, settings, [currentModel, fastModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(currentModel));
		expect(activeModelKey()).toBe(modelKey(currentModel));
	});

	it("uses the inferred fast model on a metered provider when remote compaction is disabled", async () => {
		// With provider-native replay off, the summary request serializes the
		// conversation under a dedicated system prompt and never shared a prefix
		// with the session cache — rerouting it costs nothing extra.
		const currentModel = getBundledModel("openai", "gpt-5.3-codex");
		const fastModel = getBundledModel("openai", "gpt-5.3-codex-spark");
		if (!currentModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.remoteEnabled": false,
			"compaction.strategy": "context-full",
		});
		await createCompactionSession(currentModel, settings, [currentModel, fastModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(fastModel));
	});

	it("uses the inferred fast model on a zero-cost catalog", async () => {
		const currentModel = getBundledModel("cursor", "gpt-5.3-codex");
		const fastModel = getBundledModel("cursor", "gpt-5.3-codex-spark-preview");
		if (!currentModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		await createCompactionSession(currentModel, settings, [currentModel, fastModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(fastModel));
	});

	it("honors an explicit modelRoles.compaction fast model on a metered provider", async () => {
		// The cache-economics gate only guards the *inferred* default; a user who
		// explicitly routes compaction to spark accepts the cache trade-off.
		const currentModel = getBundledModel("openai", "gpt-5.3-codex");
		const fastModel = getBundledModel("openai", "gpt-5.3-codex-spark");
		if (!currentModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		settings.setModelRole("compaction", modelKey(fastModel));
		await createCompactionSession(currentModel, settings, [currentModel, fastModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(fastModel));
	});

	it("uses the active Codex model when the fast compaction default is disabled", async () => {
		const currentModel = getBundledModel("openai-codex", "gpt-5.3-codex");
		const fastModel = getBundledModel("openai-codex", "gpt-5.3-codex-spark");
		if (!currentModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.preferFastModel": false,
			"compaction.strategy": "context-full",
		});
		await createCompactionSession(currentModel, settings, [currentModel, fastModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(currentModel));
	});

	it("skips the default fast compaction model when the prepared input exceeds its context", async () => {
		const currentModel = getBundledModel("openai-codex", "gpt-5.3-codex");
		const fastModel = getBundledModel("openai-codex", "gpt-5.3-codex-spark");
		if (!currentModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		await createCompactionSession(currentModel, settings, [currentModel, fastModel]);
		const hugeUser = userMsg(`oversized compact input ${"token ".repeat(140_000)}`);
		const hugeAssistant = assistantMsg("oversized response");
		session.agent.appendMessage(hugeUser);
		session.sessionManager.appendMessage(hugeUser);
		session.agent.appendMessage(hugeAssistant);
		session.sessionManager.appendMessage(hugeAssistant);
		const recentUser = userMsg("recent question");
		const recentAssistant = assistantMsg("recent answer");
		session.agent.appendMessage(recentUser);
		session.sessionManager.appendMessage(recentUser);
		session.agent.appendMessage(recentAssistant);
		session.sessionManager.appendMessage(recentAssistant);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(currentModel));
	});

	it("uses compactionModel before modelRoles.compaction and leaves the active model unchanged", async () => {
		const baseCurrentModel = getBundledModel("openai", "gpt-5.3-codex");
		const compactionModel = getBundledModel("openai", "gpt-5");
		const compactionRoleModel = getBundledModel("openai-codex", "gpt-5.4-mini");
		const fastModel = getBundledModel("openai", "gpt-5.3-codex-spark");
		if (!baseCurrentModel || !compactionModel || !compactionRoleModel || !fastModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const currentModel = buildModel({
			...baseCurrentModel,
			compactionModel: modelKey(compactionModel),
			compat: baseCurrentModel.compatConfig,
		});
		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		settings.setModelRole("compaction", modelKey(compactionRoleModel));
		await createCompactionSession(currentModel, settings, [
			currentModel,
			fastModel,
			compactionModel,
			compactionRoleModel,
		]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(compactionModel));
		expect(activeModelKey()).toBe(modelKey(currentModel));
	});

	it("skips an unauthenticated modelRoles.compaction candidate and uses the active model", async () => {
		const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const compactionRoleModel = getBundledModel("openai", "gpt-5");
		if (!currentModel || !compactionRoleModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		settings.setModelRole("compaction", modelKey(compactionRoleModel));
		await createCompactionSession(currentModel, settings, [currentModel]);
		const compactSpy = mockCompaction();

		await session.compact();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(currentModel));
	});

	it("/compact remote skips a non-remote-capable compactionModel and uses the active remote-capable model", async () => {
		// Active model is OpenAI (provider-native remote-capable per
		// shouldUseOpenAiRemoteCompaction). compactionModel points at an
		// Anthropic model that is NOT remote-capable, so the default candidate
		// chain would try Anthropic first and run a local summary — exactly the
		// silent-fallback the reviewer flagged for `/compact remote`. The fix
		// filters non-remote candidates in this mode, so the spy must observe
		// the OpenAI model as the first invocation.
		const baseCurrentModel = getBundledModel("openai", "gpt-5");
		const nonRemoteCompactionModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseCurrentModel || !nonRemoteCompactionModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const currentModel = buildModel({
			...baseCurrentModel,
			compactionModel: modelKey(nonRemoteCompactionModel),
			compat: baseCurrentModel.compatConfig,
		});

		await createCompactionSession(
			currentModel,
			Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.preferFastModel": false }),
			[currentModel, nonRemoteCompactionModel],
		);
		const compactSpy = mockCompaction();

		await session.compact(undefined, { mode: "remote" });

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(currentModel));
	});

	it("/compact remote skips a non-remote-capable modelRoles.compaction candidate", async () => {
		const currentModel = getBundledModel("openai", "gpt-5");
		const nonRemoteCompactionModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !nonRemoteCompactionModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.preferFastModel": false });
		settings.setModelRole("compaction", modelKey(nonRemoteCompactionModel));
		await createCompactionSession(currentModel, settings, [currentModel, nonRemoteCompactionModel]);
		const compactSpy = mockCompaction();

		await session.compact(undefined, { mode: "remote" });

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(modelKey(firstCandidate)).toBe(modelKey(currentModel));
	});
});
