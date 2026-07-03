import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { onHindsightScopeChanged, onSkillsRedactionChanged, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import {
	computeNonMessageBreakdown,
	computeNonMessageTokens,
} from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

/** Flush enough microtask ticks for a fire-and-forget async chain (signal →
 * async rebuild → sync prompt set) to complete. Deterministic — no real timers. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("system prompt model identifier", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("renders the model identifier into the workstation block when provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			model: "anthropic/claude-opus-4",
		});

		expect(systemPrompt.join("\n\n")).toContain("Model: anthropic/claude-opus-4");
	});

	it("omits the model line when no model is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		expect(systemPrompt.join("\n\n")).not.toContain("Model:");
	});
});

describe("AgentSession model-change prompt refresh", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function pickTwoModels(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(m => m.provider !== first.provider || m.id !== first.id);
		if (!first || !second) throw new Error("Expected at least two distinct models in the registry");
		return [first, second];
	}

	function pickTwoModelsWithSameContextWindow(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		const second = all.find(
			m => (m.provider !== first.provider || m.id !== first.id) && m.contextWindow === first.contextWindow,
		);
		if (!second) {
			// Fallback: construct a mock model with the same context window.
			return [first, { ...first, id: `${first.id}-clone`, provider: first.provider }];
		}
		return [first, second];
	}

	function pickTwoModelsWithDifferentContextWindow(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		const second = all.find(
			m => (m.provider !== first.provider || m.id !== first.id) && m.contextWindow !== first.contextWindow,
		);
		if (!second) {
			// Fallback: construct a mock model with a different context window.
			return [first, { ...first, id: `${first.id}-wide`, contextWindow: (first.contextWindow ?? 128000) * 2 }];
		}
		return [first, second];
	}

	function newSession(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
		});
		return created;
	}

	it("rebuilds the prompt with the new model when includeModelInPrompt is enabled", async () => {
		const [modelA, modelB] = pickTwoModels();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(modelA, Settings.isolated({ "compaction.enabled": false }), async () => {
			rebuildCount++;
			const active = session?.model;
			return { systemPrompt: [`model:${active ? `${active.provider}/${active.id}` : ""}`] };
		});

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual([`model:${modelB.provider}/${modelB.id}`]);

		// Re-selecting the same model leaves the rendered model unchanged → no rebuild.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
	});

	it("does not rebuild on model change when includeModelInPrompt is disabled and context window is unchanged", async () => {
		const [modelA, modelB] = pickTwoModelsWithSameContextWindow();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});

	it("rebuilds on model change when includeModelInPrompt is disabled but context window changes", async () => {
		const [modelA, modelB] = pickTwoModelsWithDifferentContextWindow();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["rebuilt"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["rebuilt"]);

		// Re-selecting the same model (same context window) → no additional rebuild.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
	});
});

describe("AgentSession context accounting uses redacted prompt skills", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-ctx-acc-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	it("promptSkills reflects redacted descriptions after refreshBaseSystemPrompt", async () => {
		const [model] = pickTwoModelsForContextTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const longSkill: Skill = {
			name: "verbose-skill",
			description: "This is a very long description. It has multiple sentences. Each one adds tokens.",
			filePath: "/path/to/verbose",
			baseDir: "/path/to",
			source: "test",
		};
		const shortSkill: Skill = {
			name: "short-skill",
			description: "Brief.",
			filePath: "/path/to/short",
			baseDir: "/path/to",
			source: "test",
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
			skills: [longSkill, shortSkill],
			rebuildSystemPrompt: async () => ({
				systemPrompt: ["rebuilt"],
				promptSkills: [{ ...longSkill, description: "This is a very long description." }, shortSkill],
			}),
		});

		await session.refreshBaseSystemPrompt();

		// promptSkills should hold the redacted set, not the unredacted session.skills.
		expect(session.promptSkills.length).toBe(2);
		expect(session.promptSkills[0].description).toBe("This is a very long description.");
		expect(session.promptSkills[1].description).toBe("Brief.");

		// session.skills remains unredacted for skill:// resolution.
		expect(session.skills[0].description).toBe(longSkill.description);

		// computeNonMessageBreakdown should token-count the redacted descriptions.
		const breakdown = computeNonMessageBreakdown(session);
		const redactedTokens = breakdown.skillsTokens;

		// Compare against a breakdown computed with the full unredacted skills.
		// The redacted breakdown must count fewer tokens than the unredacted one
		// would, because the long description was trimmed.
		const fullBreakdown = computeNonMessageBreakdownForSkills(session, [longSkill, shortSkill]);
		expect(redactedTokens).toBeLessThan(fullBreakdown.skillsTokens);
	});

	it("promptSkills is seeded from initialPromptSkills at construction before any refresh", () => {
		const [model] = pickTwoModelsForContextTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const longSkill: Skill = {
			name: "verbose-skill",
			description: "This is a very long description. It has multiple sentences. Each one adds tokens.",
			filePath: "/path/to/verbose",
			baseDir: "/path/to",
			source: "test",
		};
		const shortSkill: Skill = {
			name: "short-skill",
			description: "Brief.",
			filePath: "/path/to/short",
			baseDir: "/path/to",
			source: "test",
		};

		// The redacted set that the initial prompt build would produce.
		const redactedLong: Skill = { ...longSkill, description: "This is a very long description." };

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
			skills: [longSkill, shortSkill],
			initialPromptSkills: [redactedLong, shortSkill],
			rebuildSystemPrompt: async () => ({
				systemPrompt: ["rebuilt"],
				promptSkills: [redactedLong, shortSkill],
			}),
		});

		// /context accounting must match the first provider prompt immediately,
		// before any refreshBaseSystemPrompt or #applyActiveToolsByName call.
		expect(session.promptSkills.length).toBe(2);
		expect(session.promptSkills[0].description).toBe("This is a very long description.");
		expect(session.promptSkills[1].description).toBe("Brief.");

		// session.skills remains unredacted for skill:// resolution.
		expect(session.skills[0].description).toBe(longSkill.description);
	});

	function pickTwoModelsForContextTest(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		return [first, all[1] ?? first];
	}

	function computeNonMessageBreakdownForSkills(s: AgentSession, skills: readonly Skill[]) {
		// Temporarily override promptSkills to compute the unredacted token count.
		const original = s.promptSkills;
		// Use the internal estimateSkillsTokens path by calling the public
		// computeNonMessageBreakdown with a session-like object that returns
		// the unredacted skills.
		const proxy = new Proxy(s, {
			get(target, prop) {
				if (prop === "promptSkills") return skills;
				return Reflect.get(target, prop);
			},
		}) as AgentSession;
		const result = computeNonMessageBreakdown(proxy);
		void original;
		return result;
	}
});

describe("AgentSession skills.redaction settings signal", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-signal-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	it("rebuilds the prompt when skills.redaction.mode changes at runtime", async () => {
		const [model] = pickTwoModelsForSignalTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		let rebuildCount = 0;
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = newAgentSessionForSignal(model, settings, async () => {
			rebuildCount++;
			return { systemPrompt: [`rebuilt-${rebuildCount}`] };
		});

		// Initial prompt is set at construction; no rebuild yet.
		expect(rebuildCount).toBe(0);

		// Changing skills.redaction.mode fires the signal → refreshBaseSystemPrompt.
		// The signal callback is fire-and-forget (void ... .catch), so flush
		// microtasks to let the async rebuild chain complete deterministically.
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["rebuilt-1"]);

		// Changing maxContextShare also fires the signal.
		settings.set("skills.redaction.maxContextShare", 0.1);
		await flushMicrotasks();
		expect(rebuildCount).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual(["rebuilt-2"]);
	});

	function pickTwoModelsForSignalTest(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		return [first, all[1] ?? first];
	}

	function newAgentSessionForSignal(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
		});
	}
});

describe("AgentSession switchSession restores prompt with model context window", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-restore-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	it("refreshes prompt model context window after restoring a saved model with a different context window", async () => {
		// Create a session with model A (context window W_a), then switch to
		// a session that was saved with model B (context window W_b). After
		// switchSession, #promptModelContextWindow must reflect model B's
		// context window so the redaction budget is correct.
		const [modelA, modelB] = pickTwoModelsWithDifferentContextWindowForRestore();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildContextWindow: number | null | undefined;
		let rebuildCount = 0;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			includeModelInPrompt: false,
		});

		// Write session B's session file with a model_change entry for model B.
		const sessionBFile = path.join(tempDir, `session-b-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionBFile,
			`${[
				{ type: "session", version: 3, id: "session-b", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "model-b",
					parentId: null,
					timestamp,
					model: `${modelB.provider}/${modelB.id}`,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		// Create session with model A using a file-based SessionManager.
		const sessionADir = path.join(tempDir, `session-a-${Bun.nanoseconds()}`);
		fs.mkdirSync(sessionADir, { recursive: true });
		const sessionAFile = path.join(sessionADir, "active.jsonl");
		const sessionManager = SessionManager.create(sessionADir, sessionAFile);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: modelA, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				rebuildContextWindow = session?.model?.contextWindow;
				return { systemPrompt: [`rebuilt-${rebuildCount}`] };
			},
		});

		// The initial prompt context window matches model A.
		expect(session.promptModelContextWindow).toBe(modelA.contextWindow);

		// Switch to session B (which has model B saved).
		await session.switchSession(sessionBFile);

		// After restore, the model should be B and the prompt context window
		// must be refreshed to match B's context window.
		expect(session.model?.id).toBe(modelB.id);
		expect(session.promptModelContextWindow).toBe(modelB.contextWindow);
		// The sync must have triggered at least one rebuild.
		expect(rebuildCount).toBeGreaterThan(0);
		// The rebuild saw model B's context window.
		expect(rebuildContextWindow).toBe(modelB.contextWindow);
	});

	function pickTwoModelsWithDifferentContextWindowForRestore(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		const second = all.find(
			m => (m.provider !== first.provider || m.id !== first.id) && m.contextWindow !== first.contextWindow,
		);
		if (!second) {
			// Construct a mock model with a different context window.
			const baseWindow = first.contextWindow ?? 128000;
			return [
				{ ...first, contextWindow: baseWindow },
				{ ...first, id: `${first.id}-wide`, contextWindow: baseWindow * 2 },
			];
		}
		return [first, second];
	}
});

describe("AgentSession context usage rebases after redaction-driven prompt refresh", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-rebase-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	it("reduces reported usedTokens after a prompt-shrinking redaction refresh, without a provider response", async () => {
		// Build a session with a large (unredacted) system prompt, record an
		// assistant usage anchor against it, then rebuild a smaller (redacted)
		// prompt. getContextBreakdown() must reflect the smaller prompt
		// immediately — the negative non-message delta is allowed because the
		// prompt was rebased since the last anchor.
		const [model] = pickTwoModelsForRebaseTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const largePrompt = [`You are a helpful assistant. ${"x".repeat(2000)}`];
		const smallPrompt = ["You are a helpful assistant."];

		let promptToEmit = largePrompt;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: largePrompt, tools: [], messages: [] },
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => ({ systemPrompt: promptToEmit }),
		});

		// Seed an assistant usage anchor with a contextSnapshot whose
		// nonMessageTokens matches the large prompt. This simulates a prior
		// provider response that billed the unredacted prompt.
		const largeNonMessageTokens = computeNonMessageTokens(session);
		const anchorTimestamp = 1000;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 100, nonMessageTokens: largeNonMessageTokens },
			timestamp: anchorTimestamp,
		};
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 500 } as Message);
		sessionManager.appendMessage(assistantMessage);
		// Sync the agent's messages so getContextBreakdown sees the anchor.
		const ctx = session.buildDisplaySessionContext();
		agent.replaceMessages(ctx.messages);

		// Before the refresh, the breakdown is anchored to the large prompt.
		const beforeRefresh = session.getContextBreakdown();
		expect(beforeRefresh?.anchored).toBe(true);
		const beforeUsed = beforeRefresh?.usedTokens ?? 0;

		// Rebuild with the smaller (redacted) prompt.
		promptToEmit = smallPrompt;
		await session.refreshBaseSystemPrompt();

		// After the refresh, the reported usage must drop — the negative
		// non-message delta is no longer clamped to zero.
		const afterRefresh = session.getContextBreakdown();
		expect(afterRefresh?.anchored).toBe(true);
		const afterUsed = afterRefresh?.usedTokens ?? 0;
		expect(afterUsed).toBeLessThan(beforeUsed);

		// The drop must be at least the token difference between the two prompts.
		const smallNonMessageTokens = computeNonMessageTokens(session);
		const promptDelta = largeNonMessageTokens - smallNonMessageTokens;
		expect(promptDelta).toBeGreaterThan(0);
		expect(beforeUsed - afterUsed).toBeGreaterThanOrEqual(promptDelta);
	});

	it("does not rebase when no refresh has occurred since the last anchor", () => {
		// After a provider response sets the context snapshot, the normal clamp
		// (Math.max(0, delta)) must remain in effect — a redaction refresh is
		// required to allow negative deltas.
		const [model] = pickTwoModelsForRebaseTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const prompt = ["You are a helpful assistant."];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: prompt, tools: [], messages: [] },
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => ({ systemPrompt: prompt }),
		});

		// Seed the anchor with a nonMessageTokens larger than the current
		// prompt's non-message tokens. Without a refresh since the anchor, the
		// negative delta (currentNonMessage - anchorNonMessage) must be clamped
		// to zero — usedTokens stays at the anchor's promptTokens, not below.
		const currentNonMessageTokens = computeNonMessageTokens(session);
		const inflatedAnchorNonMessage = currentNonMessageTokens + 500;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 100, nonMessageTokens: inflatedAnchorNonMessage },
			timestamp: 1000,
		};
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 500 } as Message);
		sessionManager.appendMessage(assistantMessage);
		const ctx = session.buildDisplaySessionContext();
		agent.replaceMessages(ctx.messages);

		// No refresh since the anchor → the negative delta is clamped to zero,
		// so usedTokens equals the anchor's promptTokens (no tail messages).
		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBe(100);
	});

	function pickTwoModelsForRebaseTest(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		return [first, all[1] ?? first];
	}
});

describe("Settings fireAllHooks skips unchanged redaction values during clone/replay", () => {
	it("does not broadcast redaction changes during cloneForCwd when values are unchanged", async () => {
		let signalFireCount = 0;
		const unsubscribe = onSkillsRedactionChanged(() => {
			signalFireCount++;
		});

		try {
			const settings = Settings.isolated({ "compaction.enabled": false });
			// Fire the hook by setting a value — this populates #lastHookedValues.
			settings.set("skills.redaction.mode", "trim");
			const firesAfterSet = signalFireCount;
			expect(firesAfterSet).toBeGreaterThan(0);

			// Clone for a different cwd — redaction values haven't changed,
			// so the signal must NOT fire.
			await settings.cloneForCwd("/tmp/different-cwd-for-clone-test");
			expect(signalFireCount).toBe(firesAfterSet);
		} finally {
			unsubscribe();
		}
	});

	it("does not broadcast redaction changes during reloadForCwd when values are unchanged", async () => {
		let signalFireCount = 0;
		const unsubscribe = onSkillsRedactionChanged(() => {
			signalFireCount++;
		});

		try {
			const settings = Settings.isolated({ "compaction.enabled": false });
			// Set a value to populate #lastHookedValues via the hook.
			settings.set("skills.redaction.mode", "cap");
			const firesAfterSet = signalFireCount;
			expect(firesAfterSet).toBeGreaterThan(0);

			// reloadForCwd to a different directory — redaction settings are
			// not path-scoped, so the effective value is unchanged and the
			// signal must NOT fire.
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-reload-"));
			try {
				await settings.reloadForCwd(tempDir);
				expect(signalFireCount).toBe(firesAfterSet);
			} finally {
				removeSyncWithRetries(tempDir);
			}
		} finally {
			unsubscribe();
		}
	});
});

describe("AgentSession redaction refresh serialization", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-serial-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	it("discards stale refreshes when multiple signals fire synchronously", async () => {
		const [model] = pickTwoModelsForSerializationTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		let rebuildCount = 0;
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = newAgentSessionForSerialization(model, settings, async () => {
			rebuildCount++;
			return { systemPrompt: [`result-${rebuildCount}`] };
		});

		// Fire three signals synchronously — only the latest (epoch=3) should
		// trigger a refresh. The two stale refreshes are discarded by the
		// epoch guard before refreshBaseSystemPrompt is called.
		settings.set("skills.redaction.mode", "trim");
		settings.set("skills.redaction.maxContextShare", 0.1);
		settings.set("skills.redaction.maxContextShare", 0.2);
		await flushMicrotasks();

		// Only one rebuild ran — the two stale refreshes were discarded.
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["result-1"]);
	});

	it("serializes async refreshes so the latest settings win after a slow rebuild", async () => {
		const [model] = pickTwoModelsForSerializationTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = newAgentSessionForSerialization(model, settings, async () => {
			rebuildCount++;
			const current = rebuildCount;
			if (current === 1) {
				// First rebuild is slow — controlled by a promise we resolve later.
				const blocker = Promise.withResolvers<void>();
				resolveFirstRebuild = blocker.resolve;
				await blocker.promise;
			}
			return { systemPrompt: [`result-${current}`] };
		});

		// Fire first signal — starts a slow rebuild that blocks the chain.
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		// The slow rebuild hasn't applied yet.
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// Fire second signal while the first rebuild is still pending.
		settings.set("skills.redaction.maxContextShare", 0.1);
		await flushMicrotasks();

		// Resolve the first rebuild — it applies "result-1", then the chain
		// continues to the second refresh which overwrites with "result-2".
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// Both rebuilds ran, but the latest (second) won.
		expect(rebuildCount).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);
	});

	function pickTwoModelsForSerializationTest(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		return [first, all[1] ?? first];
	}

	function newAgentSessionForSerialization(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
		});
	}
});

describe("AgentSession rebase flag persists through pending snapshot until durable anchor", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-rebase-pending-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	it("keeps rebase active until a durable assistant usage anchor clears it", async () => {
		const [model] = pickTwoModelsForRebasePendingTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const largePrompt = [`You are a helpful assistant. ${"x".repeat(2000)}`];
		const smallPrompt = ["You are a helpful assistant."];

		let promptToEmit = largePrompt;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: largePrompt, tools: [], messages: [] },
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => ({ systemPrompt: promptToEmit }),
		});

		// Seed a durable anchor with the large prompt's nonMessageTokens.
		const largeNonMessageTokens = computeNonMessageTokens(session);
		const anchorTimestamp = 1000;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 100, nonMessageTokens: largeNonMessageTokens },
			timestamp: anchorTimestamp,
		};
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 500 } as Message);
		sessionManager.appendMessage(assistantMessage);
		agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const beforeRefresh = session.getContextBreakdown();
		expect(beforeRefresh?.anchored).toBe(true);

		// Rebuild with the smaller (redacted) prompt — rebase flag is set.
		promptToEmit = smallPrompt;
		await session.refreshBaseSystemPrompt();

		// The rebase is active: usage drops because negative non-message
		// deltas are allowed (currentNonMessage - anchorNonMessage < 0).
		const afterRefresh = session.getContextBreakdown();
		expect(afterRefresh?.anchored).toBe(true);
		expect(afterRefresh?.usedTokens).toBeLessThan(beforeRefresh?.usedTokens ?? 0);

		// The rebase flag must persist — it is NOT cleared by a pending
		// context snapshot (in-flight estimate). Repeated breakdown calls
		// must continue to show the reduced usage.
		const stillRebased = session.getContextBreakdown();
		expect(stillRebased?.usedTokens).toBe(afterRefresh?.usedTokens);

		// Now persist a durable assistant message with usage — this IS the
		// durable anchor that clears the rebase flag.
		const smallNonMessageTokens = computeNonMessageTokens(session);
		const newAnchor: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "response 2" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 50,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 55,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 50, nonMessageTokens: smallNonMessageTokens },
			timestamp: 2000,
		};
		sessionManager.appendMessage({ role: "user", content: "again", timestamp: 1500 } as Message);
		sessionManager.appendMessage(newAnchor);
		agent.replaceMessages(session.buildDisplaySessionContext().messages);

		// After the durable anchor, the rebase is cleared. The breakdown
		// uses the new anchor's promptTokens (50) with no negative delta
		// (currentNonMessage ≈ anchorNonMessage since both reflect the
		// small prompt).
		const afterAnchor = session.getContextBreakdown();
		expect(afterAnchor?.anchored).toBe(true);
		// The new anchor's promptTokens (50) is much smaller than the
		// pre-refresh anchor (100), confirming the durable anchor took effect.
		expect(afterAnchor?.usedTokens).toBeLessThan(beforeRefresh?.usedTokens ?? 0);
	});

	function pickTwoModelsForRebasePendingTest(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		return [first, all[1] ?? first];
	}
});

describe("Settings fireAllHooks fires cwd-dependent Hindsight hooks on cwd move even when values unchanged", () => {
	it("fires Hindsight scope signal during cloneForCwd even when hindsight values are unchanged", async () => {
		let signalFireCount = 0;
		const unsubscribe = onHindsightScopeChanged(() => {
			signalFireCount++;
		});

		try {
			const settings = Settings.isolated({ "compaction.enabled": false });
			// Set a hindsight value to populate #lastHookedValues via the hook.
			settings.set("hindsight.scoping", "per-project");
			const firesAfterSet = signalFireCount;
			expect(firesAfterSet).toBeGreaterThan(0);

			// Clone for a different cwd — hindsight values haven't changed,
			// but the hook is cwd-dependent so the signal MUST fire.
			await settings.cloneForCwd("/tmp/different-cwd-for-hindsight-clone");
			expect(signalFireCount).toBeGreaterThan(firesAfterSet);
		} finally {
			unsubscribe();
		}
	});

	it("fires Hindsight scope signal during reloadForCwd even when hindsight values are unchanged", async () => {
		let signalFireCount = 0;
		const unsubscribe = onHindsightScopeChanged(() => {
			signalFireCount++;
		});

		try {
			const settings = Settings.isolated({ "compaction.enabled": false });
			settings.set("hindsight.bankId", "my-bank");
			const firesAfterSet = signalFireCount;
			expect(firesAfterSet).toBeGreaterThan(0);

			// reloadForCwd to a different directory — hindsight values are
			// not path-scoped, so the effective value is unchanged, but the
			// hook is cwd-dependent so the signal MUST fire.
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hindsight-reload-"));
			try {
				await settings.reloadForCwd(tempDir);
				expect(signalFireCount).toBeGreaterThan(firesAfterSet);
			} finally {
				removeSyncWithRetries(tempDir);
			}
		} finally {
			unsubscribe();
		}
	});
});

describe("AgentSession refreshBaseSystemPrompt discards stale result when build version changes during async build", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-tool-race-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	it("discards redaction refresh result when a concurrent refreshBaseSystemPrompt increments the build version", async () => {
		const [model] = pickTwoModelsForToolRaceTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = newAgentSessionForToolRaceTest(model, settings, async () => {
			rebuildCount++;
			const current = rebuildCount;
			if (current === 1) {
				// First rebuild (redaction refresh) is slow — controlled by a
				// promise we resolve later. While it's pending, a concurrent
				// refreshBaseSystemPrompt call will complete and increment
				// #promptBuildVersion.
				const blocker = Promise.withResolvers<void>();
				resolveFirstRebuild = blocker.resolve;
				await blocker.promise;
			}
			return { systemPrompt: [`result-${current}`] };
		});

		// Fire the redaction signal — starts a slow rebuild via the chain.
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		// The slow rebuild hasn't applied yet.
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// While the redaction rebuild is blocked, directly call
		// refreshBaseSystemPrompt — this bypasses the redaction chain and
		// completes immediately, incrementing #promptBuildVersion.
		await session.refreshBaseSystemPrompt();
		expect(rebuildCount).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);

		// Now resolve the first (redaction) rebuild. It should detect that
		// #promptBuildVersion changed during its await and discard its
		// stale result — the prompt must remain "result-2", not "result-1".
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// The redaction refresh's result was discarded — prompt is still
		// from the concurrent call, not overwritten by the stale rebuild.
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);
	});

	it("discards stale old-model rebuild when a model switch triggers a newer build via syncAfterModelChange", async () => {
		const [modelA, modelB] = pickTwoModelsForToolRaceTest();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: modelA, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				const current = rebuildCount;
				if (current === 1) {
					// First rebuild (for modelA) is slow — controlled by a
					// promise we resolve later. While it's pending, a model
					// switch to modelB triggers #syncAfterModelChange, which
					// calls refreshBaseSystemPrompt and increments
					// #promptBuildVersion.
					const blocker = Promise.withResolvers<void>();
					resolveFirstRebuild = blocker.resolve;
					await blocker.promise;
				}
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Start a slow rebuild for modelA (build version 1) without awaiting.
		void session.refreshBaseSystemPrompt();
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// Switch to modelB via setModelTemporary — this calls
		// #syncAfterModelChange, which detects the model key change and
		// calls refreshBaseSystemPrompt, starting a newer build (build
		// version 2) that completes immediately with "result-2".
		await session.setModelTemporary(modelB);
		expect(rebuildCount).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);

		// Now resolve the first (old-model) rebuild. It should detect that
		// #promptBuildVersion changed during its await and discard its
		// stale result — the prompt must remain "result-2", not "result-1".
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// The old-model rebuild's result was discarded.
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);
	});

	it("discards stale tool rebuild when a redaction signal starts a newer build during its await", async () => {
		const [model] = pickTwoModelsForToolRaceTest();
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = newAgentSessionForToolRaceTest(model, settings, async () => {
			rebuildCount++;
			const current = rebuildCount;
			if (current === 1) {
				// First rebuild (tool rebuild via direct refreshBaseSystemPrompt)
				// is slow — controlled by a promise we resolve later. While
				// it's pending, a redaction signal fires and starts a newer
				// build via the redaction chain, incrementing
				// #promptBuildVersion.
				const blocker = Promise.withResolvers<void>();
				resolveFirstRebuild = blocker.resolve;
				await blocker.promise;
			}
			return { systemPrompt: [`result-${current}`] };
		});

		// Start a slow tool rebuild (build version 1) without awaiting.
		void session.refreshBaseSystemPrompt();
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// Fire a redaction signal — this starts a newer build (build version 2)
		// via the redaction chain. The chain is serialized, but the slow
		// direct refresh is NOT on the chain, so the redaction refresh runs
		// concurrently and completes immediately with "result-2".
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();
		expect(rebuildCount).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);

		// Now resolve the first (tool) rebuild. It should detect that
		// #promptBuildVersion changed during its await and discard its
		// stale result — the prompt must remain "result-2", not "result-1".
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// The older tool rebuild's result was discarded — the newer
		// redaction refresh's prompt is preserved.
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);
	});

	function pickTwoModelsForToolRaceTest(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		if (!first) throw new Error("Expected at least one model in the registry");
		return [first, all[1] ?? first];
	}

	function newAgentSessionForToolRaceTest(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
		});
	}
});
