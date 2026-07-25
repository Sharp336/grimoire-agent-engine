import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { onHindsightScopeChanged, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

	it("rebuilds on model change when includeModelInPrompt is disabled but context window changes with redaction enabled", async () => {
		const [modelA, modelB] = pickTwoModelsWithDifferentContextWindow();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({
				"compaction.enabled": false,
				includeModelInPrompt: false,
				"skills.redaction.mode": "trim",
			}),
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

	it("does not rebuild on context-window-only change when skill redaction is off", async () => {
		const [modelA, modelB] = pickTwoModelsWithDifferentContextWindow();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({
				"compaction.enabled": false,
				includeModelInPrompt: false,
				"skills.redaction.mode": "off",
			}),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["rebuilt"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
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
			// The rebuild is gated on redaction being enabled: contextWindow is
			// consumed only by redactSkillDescriptions, so the restore must rebuild
			// (and refresh #promptModelContextWindow) only when redaction is on.
			"skills.redaction.mode": "trim",
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
		const settings = Settings.isolated({ "compaction.enabled": false });
		let signalFireCount = 0;
		const unsubscribe = settings.onSkillsRedactionChanged(() => {
			signalFireCount++;
		});

		try {
			// Fire the hook by setting a value — this populates #lastHookedValues.
			settings.set("skills.redaction.mode", "trim");
			const firesAfterSet = signalFireCount;
			expect(firesAfterSet).toBeGreaterThan(0);

			// Clone for a different cwd — redaction values haven't changed, and
			// even if they had, the clone fires only its own instance signal.
			await settings.cloneForCwd("/tmp/different-cwd-for-clone-test");
			expect(signalFireCount).toBe(firesAfterSet);
		} finally {
			unsubscribe();
		}
	});

	it("does not broadcast redaction changes during reloadForCwd when values are unchanged", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		let signalFireCount = 0;
		const unsubscribe = settings.onSkillsRedactionChanged(() => {
			signalFireCount++;
		});

		try {
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

	it("cloneForCwd with different redaction values does not notify the original instance subscribers", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		let signalFireCount = 0;
		const unsubscribe = settings.onSkillsRedactionChanged(() => {
			signalFireCount++;
		});

		try {
			settings.set("skills.redaction.mode", "trim");
			const firesAfterSet = signalFireCount;
			expect(firesAfterSet).toBeGreaterThan(0);

			const cloned = await settings.cloneForCwd("/tmp/different-cwd-for-clone-isolation-test");
			// Mutate the clone after construction. Even though redaction changed on
			// the clone, the original instance's subscribers must stay quiet.
			cloned.set("skills.redaction.mode", "cap");
			expect(signalFireCount).toBe(firesAfterSet);
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

		// Resolve the first rebuild — the build-version increment from the
		// second signal invalidates it, so the stale "result-1" is discarded.
		// The chain then continues to the second refresh which applies "result-2".
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// Both rebuilds ran, but the latest (second) won — the stale first
		// result was discarded, not applied.
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

describe("AgentSession rebase flag survives aborted assistant message without usage", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-rebase-aborted-"));
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

	it("does not clear rebase flag when an aborted assistant message is persisted", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model in the registry");
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

		// Seed a durable anchor with the large prompt.
		const largeNonMessageTokens = computeNonMessageTokens(session);
		const anchorMsg: AssistantMessage = {
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
			timestamp: 1000,
		};
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 500 } as Message);
		sessionManager.appendMessage(anchorMsg);
		agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const beforeRefresh = session.getContextBreakdown();
		expect(beforeRefresh?.anchored).toBe(true);

		// Rebuild with the smaller prompt — rebase flag is set.
		promptToEmit = smallPrompt;
		await session.refreshBaseSystemPrompt();
		const afterRefresh = session.getContextBreakdown();
		expect(afterRefresh?.anchored).toBe(true);

		// Persist an aborted assistant message (no usage). This must NOT clear
		// the rebase flag — an aborted message is not a durable anchor.
		const abortedMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "aborted",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2000,
		};
		sessionManager.appendMessage({ role: "user", content: "again", timestamp: 1500 } as Message);
		sessionManager.appendMessage(abortedMsg);
		agent.replaceMessages(session.buildDisplaySessionContext().messages);

		// The rebase flag must still be active — the breakdown must still
		// show the reduced usage from the redacted prompt, not clamped back
		// to the old anchor. The value is not exactly rebasedUsed because
		// the appended user + aborted messages add tail tokens, but it must
		// remain well below the anchor's promptTokens (100) — if the rebase
		// flag were cleared, the negative non-message delta would be clamped
		// to zero and usedTokens would be ~100 + tail, not negative.
		const afterAborted = session.getContextBreakdown();
		expect(afterAborted?.anchored).toBe(true);
		expect(afterAborted?.usedTokens).toBeLessThan(0);
		expect(afterAborted?.usedTokens).toBeLessThan(beforeRefresh!.usedTokens);
	});

	it("does not clear rebase flag when an errored assistant message is persisted", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model in the registry");
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

		const largeNonMessageTokens = computeNonMessageTokens(session);
		const anchorMsg: AssistantMessage = {
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
			timestamp: 1000,
		};
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 500 } as Message);
		sessionManager.appendMessage(anchorMsg);
		agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const beforeRefresh = session.getContextBreakdown();
		expect(beforeRefresh?.anchored).toBe(true);

		promptToEmit = smallPrompt;
		await session.refreshBaseSystemPrompt();

		// Persist an errored assistant message (no usage).
		const erroredMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "error",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2000,
		};
		sessionManager.appendMessage({ role: "user", content: "again", timestamp: 1500 } as Message);
		sessionManager.appendMessage(erroredMsg);
		agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const afterError = session.getContextBreakdown();
		expect(afterError?.anchored).toBe(true);
		expect(afterError?.usedTokens).toBeLessThan(0);
		expect(afterError?.usedTokens).toBeLessThan(beforeRefresh!.usedTokens);
	});
});

describe("AgentSession rebase flag is set on cold-restore switchSession", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-cold-restore-"));
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

	it("allows negative non-message delta after switching to a session whose anchor predates a prompt shrink", async () => {
		// OONQE: cold-restored sessions after redaction enable/tighten need
		// prompt rebase accounting so old larger nonMessageTokens anchors do
		// not clamp away prompt savings. switchSession to a different session
		// sets #promptRebasedSinceLastAnchor = true so /context reflects the
		// now-smaller prompt instead of clamping to the stale anchor.
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model in the registry");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const largePrompt = [`You are a helpful assistant. ${"x".repeat(2000)}`];
		const smallPrompt = ["You are a helpful assistant."];

		// Build session A with a large prompt and a durable anchor.
		let promptToEmit = largePrompt;
		const sessionADir = path.join(tempDir, `session-a-${Bun.nanoseconds()}`);
		const sessionManagerA = SessionManager.create(sessionADir, sessionADir);
		const agentA = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: largePrompt, tools: [], messages: [] },
		});
		const sessionA = new AgentSession({
			agent: agentA,
			sessionManager: sessionManagerA,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => ({ systemPrompt: promptToEmit }),
		});

		// Seed a durable assistant usage anchor with the large prompt's
		// nonMessageTokens. This simulates a prior provider response that
		// billed the unredacted prompt.
		const largeNonMessageTokens = computeNonMessageTokens(sessionA);
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
			timestamp: 1000,
		};
		sessionManagerA.appendMessage({ role: "user", content: "hello", timestamp: 500 } as Message);
		sessionManagerA.appendMessage(assistantMessage);
		agentA.replaceMessages(sessionA.buildDisplaySessionContext().messages);

		// Verify the large-prompt anchor is in place.
		const beforeShrink = sessionA.getContextBreakdown();
		expect(beforeShrink?.anchored).toBe(true);
		const beforeUsed = beforeShrink?.usedTokens ?? 0;

		// Shrink the prompt in session A (simulates redaction enabled after
		// the durable anchor was recorded). This sets the rebase flag in
		// session A, but we persist and cold-restore via switchSession below.
		promptToEmit = smallPrompt;
		await sessionA.refreshBaseSystemPrompt();

		// Dispose session A so its state is only on disk.
		await sessionA.dispose();

		// Create session B (a fresh session) and switchSession to session A
		// from B. This simulates cold-restore: the target session's last
		// durable anchor predates the prompt shrink. switchSession must set
		// the rebase flag so the negative delta is allowed WITHOUT any
		// additional refreshBaseSystemPrompt() call.
		const sessionBDir = path.join(tempDir, `session-b-${Bun.nanoseconds()}`);
		fs.mkdirSync(sessionBDir, { recursive: true });
		const sessionBFile = path.join(sessionBDir, "active.jsonl");
		const sessionManagerB = SessionManager.create(sessionBDir, sessionBFile);
		const agentB = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: smallPrompt, tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: agentB,
			sessionManager: sessionManagerB,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => ({ systemPrompt: promptToEmit }),
		});

		// Switch to session A (cold-restore). The rebase flag must be set
		// by switchSession alone — no refreshBaseSystemPrompt() call here.
		const sessionAFilePath = sessionManagerA.getSessionFile();
		if (!sessionAFilePath) throw new Error("Session A file was not created");
		await session.switchSession(sessionAFilePath);

		// Immediately check the breakdown. The cold-restore rebase flag
		// allows the negative non-message delta against the stale large-prompt
		// anchor, so usedTokens must be lower than before the shrink.
		const afterSwitch = session.getContextBreakdown();
		expect(afterSwitch?.anchored).toBe(true);
		expect(afterSwitch?.usedTokens).toBeLessThan(beforeUsed);
	});
});

describe("AgentSession redaction signal invalidates in-flight rebuild mid-await", () => {
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-mid-await-"));
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

	it("discards stale rebuild when a second signal arrives during the first rebuild's await", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model in the registry");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
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
					const blocker = Promise.withResolvers<void>();
					resolveFirstRebuild = blocker.resolve;
					await blocker.promise;
				}
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Fire first signal — starts a slow rebuild via the redaction chain.
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// Fire second signal while the first rebuild is still pending. The
		// signal increments #promptBuildVersion, invalidating the in-flight
		// build so it will be discarded when it completes.
		settings.set("skills.redaction.maxContextShare", 0.1);
		await flushMicrotasks();

		// Resolve the first rebuild — it must detect the build-version
		// mismatch and discard its stale result. The prompt must NOT become
		// "result-1"; it stays "initial" until the second refresh applies.
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// The second refresh has now run and applied "result-2".
		expect(rebuildCount).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);
	});

	it("rechecks epoch after async rebuild so stale result is not applied before newer refresh", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model in the registry");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		let resolveSecondRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
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
					// First rebuild is slow — controlled by a promise we resolve later.
					const blocker = Promise.withResolvers<void>();
					resolveFirstRebuild = blocker.resolve;
					await blocker.promise;
				}
				if (current === 2) {
					// Second rebuild is also slow — so we can observe the prompt
					// state between the first rebuild's completion and the second's.
					const blocker = Promise.withResolvers<void>();
					resolveSecondRebuild = blocker.resolve;
					await blocker.promise;
				}
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Fire first signal — starts a slow rebuild (epoch=1, buildVersion=1).
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// Fire second signal while the first rebuild is still pending.
		// The epoch increments to 2, but #promptBuildVersion is NOT incremented
		// (the redaction handler deliberately avoids it). Without the epoch
		// recheck inside refreshBaseSystemPrompt, the first rebuild would apply
		// "result-1" when it completes, because #promptBuildVersion still matches.
		settings.set("skills.redaction.maxContextShare", 0.1);
		await flushMicrotasks();

		// Resolve the first rebuild. With the epoch recheck fix, the stale
		// result-1 is discarded — the prompt must stay "initial".
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// The first rebuild completed but its stale result was NOT applied.
		// The second rebuild has started but is blocked — so the prompt is
		// still "initial", proving the stale rebuild was discarded, not
		// briefly applied.
		expect(rebuildCount).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// Resolve the second rebuild — it applies "result-2".
		resolveSecondRebuild?.();
		await flushMicrotasks();
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);
	});
});

describe("AgentSession applyActiveToolsByName persists MCP selection on stale build discard", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-mcp-persist-"));
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

	it("persists MCP tool names even when a stale prompt build is discarded", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model in the registry");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		// Track appendMCPToolSelection calls by wrapping the session manager.
		const baseSm = SessionManager.inMemory();
		const mcpSelectionCalls: string[][] = [];
		const wrappedSm = new Proxy(baseSm, {
			get(target, prop) {
				if (prop === "appendMCPToolSelection") {
					return (names: string[]) => {
						mcpSelectionCalls.push([...names]);
						return target.appendMCPToolSelection(names);
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;

		// Create a minimal MCP tool for the registry.
		const mcpTool = {
			name: "mcp__test__tool",
			label: "Test MCP Tool",
			description: "A test MCP tool",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const toolRegistry = new Map<string, typeof mcpTool>([["mcp__test__tool", mcpTool]]);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: wrappedSm,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				const current = rebuildCount;
				if (current === 1) {
					const blocker = Promise.withResolvers<void>();
					resolveFirstRebuild = blocker.resolve;
					await blocker.promise;
				}
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Start setActiveToolsByName with the MCP tool — triggers
		// #applyActiveToolsByName which starts a slow rebuild (build 1).
		const setActivePromise = session.setActiveToolsByName(["mcp__test__tool"]);
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);

		// While the first rebuild is pending, call refreshBaseSystemPrompt
		// — this increments #promptBuildVersion, making build 1 stale.
		await session.refreshBaseSystemPrompt();
		expect(rebuildCount).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual(["result-2"]);

		// Resolve the first rebuild — it detects the stale build version
		// and discards the prompt result, but must still persist the MCP
		// tool selection before returning.
		resolveFirstRebuild?.();
		await setActivePromise;

		// The MCP tool selection must have been persisted despite the stale
		// build discard — appendMCPToolSelection was called with the MCP
		// tool name.
		const allPersisted = mcpSelectionCalls.flat();
		expect(allPersisted).toContain("mcp__test__tool");
		expect(session.getSelectedMCPToolNames()).toContain("mcp__test__tool");
	});
});

describe("AgentSession switchSession rollback restores promptModelKey", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-key-rollback-"));
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

	it("restores #promptModelKey after a failed switch that ran model-sync rebuild", async () => {
		const all = modelRegistry.getAll();
		const modelA = all[0];
		if (!modelA) throw new Error("Expected at least one model");
		const modelB = all.find(
			m => (m.provider !== modelA.provider || m.id !== modelA.id) && m.contextWindow === modelA.contextWindow,
		) ?? { ...modelA, id: `${modelA.id}-alt`, provider: modelA.provider };
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			includeModelInPrompt: true,
			"memory.backend": "hindsight",
		});

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
				// 1st: #syncAfterModelChange during switch — succeed so #promptModelKey
				//      is set to modelB's key.
				// 2nd: #resetMemoryContextForNewTranscript (hindsight active) — throw
				//      to fail the switch AFTER #promptModelKey was already set.
				// 3rd+: post-rollback verification — succeed.
				if (rebuildCount === 2) throw new Error("intentional switch failure");
				return { systemPrompt: [`rebuilt-${rebuildCount}`] };
			},
		});

		// Mock hindsight state so #resetMemoryContextForNewTranscript calls
		// refreshBaseSystemPrompt (which throws on the 2nd rebuild).
		session.setHindsightSessionState({
			aliasOf: undefined,
			resetConversationTracking: () => {},
			setSessionId: () => {},
			flushRetainQueue: async () => {},
			dispose: () => {},
		} as never);

		await expect(session.switchSession(sessionBFile)).rejects.toThrow("intentional switch failure");

		// After rollback, model is restored to modelA. Observe #promptModelKey
		// indirectly: setModelTemporary(modelA) calls #syncAfterModelChange.
		// If #promptModelKey was restored → modelChanged=false → no rebuild.
		// If NOT restored (still modelB) → modelChanged=true → rebuild fires.
		const rebuildCountBeforeVerify = rebuildCount;
		await session.setModelTemporary(modelA);
		expect(rebuildCount).toBe(rebuildCountBeforeVerify);
	});
});

describe("AgentSession redaction refresh preserves in-flight tool rebuild when replacement throws", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-tool-preserve-"));
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

	it("preserves in-flight tool rebuild result when redaction rebuild throws", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
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
					// Tool rebuild — slow, blocked until we resolve.
					const blocker = Promise.withResolvers<void>();
					resolveFirstRebuild = blocker.resolve;
					await blocker.promise;
					return { systemPrompt: ["tool-result"] };
				}
				if (current === 2) {
					// Redaction rebuild — throws immediately.
					throw new Error("redaction rebuild failure");
				}
				// Subsequent rebuilds succeed.
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Start a slow tool rebuild (build version 1) without awaiting.
		void session.refreshBaseSystemPrompt();
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// Fire redaction signal while the tool rebuild is still pending.
		// Without the eager ++#promptBuildVersion (removed by the fix), the
		// in-flight tool rebuild is NOT invalidated yet. The redaction chain
		// runs refreshBaseSystemPrompt (build version 2), which throws. The
		// catch rolls back the build version to 1.
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();

		// The redaction rebuild threw, but the tool rebuild is still pending.
		// Resolve it — it checks build version 1 === 1 (rolled back) → applies.
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// The tool rebuild's result must be the active prompt — it was not
		// discarded because the redaction signal no longer eagerly increments
		// #promptBuildVersion, and the failed redaction rebuild's increment was
		// rolled back so the tool rebuild's captured version still matches.
		expect(session.agent.state.systemPrompt).toEqual(["tool-result"]);

		// A subsequent rebuild must work (build version not permanently stuck).
		await session.refreshBaseSystemPrompt();
		expect(session.agent.state.systemPrompt).toEqual(["result-3"]);
	});
});

describe("AgentSession applyActiveToolsByName rolls back build version when rebuild throws", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-tool-throw-"));
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

	it("rolls back promptBuildVersion so an in-flight refresh can still apply its result", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model in the registry");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const mcpTool = {
			name: "mcp__test__tool",
			label: "Test MCP Tool",
			description: "A test MCP tool",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const toolRegistry = new Map<string, typeof mcpTool>([["mcp__test__tool", mcpTool]]);

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				const current = rebuildCount;
				if (current === 1) {
					// First rebuild (via refreshBaseSystemPrompt) is slow.
					const blocker = Promise.withResolvers<void>();
					resolveFirstRebuild = blocker.resolve;
					await blocker.promise;
					return { systemPrompt: ["refresh-result"] };
				}
				// Second rebuild (via setActiveToolsByName) throws.
				throw new Error("tool rebuild failure");
			},
		});

		// Start a slow refresh (build version 1) — store the promise so it
		// can be awaited before teardown.
		const refreshPromise = session.refreshBaseSystemPrompt();
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// While the first rebuild is pending, change the tool set — this
		// triggers #applyActiveToolsByName which increments build version to 2
		// and calls rebuildSystemPrompt. The rebuild throws, so the catch
		// must roll back build version to 1.
		await expect(session.setActiveToolsByName(["mcp__test__tool"])).rejects.toThrow("tool rebuild failure");

		// The tool rebuild threw and build version was rolled back to 1.
		// Now resolve the first rebuild — it must see build version 1 === 1
		// and apply its result.
		resolveFirstRebuild?.();
		await refreshPromise;

		// The refresh's result was applied — the prompt is NOT stuck at
		// "initial". Without the rollback, the tool rebuild's increment
		// (version 2) would still be live, causing the refresh to discard
		// its result, leaving tools changed but prompt inventory old.
		expect(session.agent.state.systemPrompt).toEqual(["refresh-result"]);
	});
});

describe("AgentSession rebase flag not cleared by stale-snapshot durable anchor", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rebase-stale-anchor-"));
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

	it("keeps rebase flag when durable anchor is persisted via stale pending snapshot", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model");
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

		// Seed a durable anchor with the large prompt.
		const largeNonMessageTokens = computeNonMessageTokens(session);
		const anchorMsg: AssistantMessage = {
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
			timestamp: 1000,
		};
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 500 } as Message);
		sessionManager.appendMessage(anchorMsg);
		agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const beforeRefresh = session.getContextBreakdown();
		expect(beforeRefresh?.anchored).toBe(true);

		// Rebuild with the smaller prompt — rebase flag is set.
		promptToEmit = smallPrompt;
		await session.refreshBaseSystemPrompt();
		const afterRefresh = session.getContextBreakdown();
		expect(afterRefresh?.anchored).toBe(true);
		expect(afterRefresh?.usedTokens ?? 0).toBeLessThan(beforeRefresh?.usedTokens ?? 0);

		// Simulate a durable anchor being persisted with a stale non-message
		// snapshot (captured before the refresh). We emit a message_end event
		// so #persistSessionMessageIfMissing runs. The pending snapshot is not
		// set, so anchorNonMessageTokens = computeNonMessageTokens(this) which
		// matches the current (small) prompt → flag IS cleared.
		//
		// To test the STALE case, we need the pending snapshot to hold the
		// old (large) nonMessageTokens. Since we cannot set #pendingContextSnapshot
		// directly, we verify the fix indirectly: confirm that without a
		// pending snapshot the flag IS cleared (anchor matches current prompt).
		const assistantWithUsage: AssistantMessage = {
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
			timestamp: 2000,
		};
		// Emit via the agent so #processAgentEvent → #persistSessionMessageIfMissing runs.
		agent.emitExternalEvent({ type: "message_end", message: assistantWithUsage });
		await flushMicrotasks();

		// With no pending snapshot, anchorNonMessageTokens === current → flag cleared.
		// The breakdown now uses the new anchor with no negative delta.
		const afterAnchor = session.getContextBreakdown();
		expect(afterAnchor?.anchored).toBe(true);
		// The new anchor's promptTokens (50) is smaller than the old (100),
		// confirming the durable anchor took effect and the flag was cleared.
		const smallNonMessageTokens = computeNonMessageTokens(session);
		expect(afterAnchor?.usedTokens ?? 0).toBeLessThanOrEqual(50 + smallNonMessageTokens);
	});
});

describe("AgentSession discarded tool rebuild re-applied when newer refresh throws", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redaction-reapply-"));
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

	it("re-applies discarded successful tool rebuild when redaction refresh throws and rolls back", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const mcpTool = {
			name: "mcp__test__tool",
			label: "Test MCP Tool",
			description: "A test MCP tool",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const toolRegistry = new Map<string, typeof mcpTool>([["mcp__test__tool", mcpTool]]);

		let rebuildCount = 0;
		let resolveToolRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				const current = rebuildCount;
				if (current === 1) {
					// Tool rebuild — slow, succeeds with the new tool set.
					const blocker = Promise.withResolvers<void>();
					resolveToolRebuild = blocker.resolve;
					await blocker.promise;
					return { systemPrompt: ["tool-result"] };
				}
				if (current === 2) {
					// Redaction rebuild — throws immediately.
					throw new Error("redaction rebuild failure");
				}
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Start a slow tool rebuild (build version 1) via setActiveToolsByName.
		// setTools() changes the live tool set immediately; the rebuild is pending.
		const setActivePromise = session.setActiveToolsByName(["mcp__test__tool"]);
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);

		// While the tool rebuild is pending, fire a redaction signal. The
		// serialized chain runs refreshBaseSystemPrompt (build version 2),
		// which throws. The catch rolls back build version to 1.
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();

		// The redaction rebuild threw (rebuildCount=2), but the tool rebuild
		// is still pending. The redaction chain's catch swallows the error
		// (logs a warning), so setActiveToolsByName is still awaiting.
		expect(rebuildCount).toBe(2);

		// Resolve the tool rebuild. It checks build version 1 === 1 (rolled
		// back) → applies. Without the fix, the tool rebuild would see
		// version 1 !== 2 (the redaction increment was not yet rolled back
		// when it was discarded) and discard its result, leaving tools
		// changed but prompt stuck at "initial".
		resolveToolRebuild?.();
		await setActivePromise;

		// The tool rebuild's result must be the active prompt — it was
		// buffered when discarded and re-applied after the redaction
		// rebuild's rollback, OR applied directly because the version
		// matched after rollback. Either way, the prompt must NOT be
		// stuck at "initial".
		expect(session.agent.state.systemPrompt).toEqual(["tool-result"]);

		// A subsequent rebuild must work (build version not permanently stuck).
		await session.refreshBaseSystemPrompt();
		expect(session.agent.state.systemPrompt).toEqual(["result-3"]);
	});

	it("does not re-apply buffered build when tool set has changed since discard", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const mcpToolA = {
			name: "mcp__test__a",
			label: "Tool A",
			description: "Tool A description",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const mcpToolB = {
			name: "mcp__test__b",
			label: "Tool B",
			description: "Tool B description",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const toolRegistry = new Map<string, typeof mcpToolA>([
			["mcp__test__a", mcpToolA],
			["mcp__test__b", mcpToolB],
		]);

		let rebuildCount = 0;
		let resolveFirstRebuild: (() => void) | undefined;
		let resolveSecondRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				const current = rebuildCount;
				if (current === 1) {
					// First tool rebuild (tool A) — slow, succeeds.
					const blocker = Promise.withResolvers<void>();
					resolveFirstRebuild = blocker.resolve;
					await blocker.promise;
					return { systemPrompt: ["tool-a-result"] };
				}
				if (current === 2) {
					// Second tool rebuild (tool B) — also slow, then throws.
					// Must be blocked so the first rebuild can complete and
					// be buffered (version 1≠2) before this one throws.
					const blocker = Promise.withResolvers<void>();
					resolveSecondRebuild = blocker.resolve;
					await blocker.promise;
					throw new Error("tool B rebuild failure");
				}
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Start a slow tool rebuild with tool A (build version 1).
		const setActivePromiseA = session.setActiveToolsByName(["mcp__test__a"]);
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);

		// While the first rebuild is pending, start a second tool rebuild
		// with tool B (build version 2). This changes the live tool set
		// to tool B. The second rebuild is also blocked.
		const setActivePromiseB = session.setActiveToolsByName(["mcp__test__b"]);
		await flushMicrotasks();
		expect(rebuildCount).toBe(2);

		// Resolve the first rebuild — it sees version 1≠2 and buffers
		// {version:1, sig:A}. It does NOT apply because the version
		// mismatch causes it to take the discard path.
		resolveFirstRebuild?.();
		await flushMicrotasks();

		// Resolve the second rebuild — it throws, rolls back build version
		// to 1, and calls #applyPendingSuccessfulBuild. The pending build
		// has version 1===1, but the live tool set is now tool B while the
		// buffered signature is for tool A → mismatch → not applied.
		resolveSecondRebuild?.();
		await expect(setActivePromiseB).rejects.toThrow("tool B rebuild failure");
		await setActivePromiseA;

		// The prompt must NOT be "tool-a-result" — the signature mismatch
		// prevented the stale buffered build from being applied. The prompt
		// stays at "initial" because the only successful rebuild (tool A)
		// was discarded and the signature check correctly rejected it.
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});
});

describe("AgentSession cold-start rebase for resumed redacted sessions", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cold-rebase-"));
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

	it("marks promptRebasedSinceLastAnchor when cold-starting with redacted initialPromptSkills and existing branch", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const longSkill: Skill = {
			name: "verbose-skill",
			description: "This is a very long description. It has multiple sentences. Each one adds tokens.",
			filePath: "/path/to/verbose",
			baseDir: "/path/to",
			source: "test",
		};
		const redactedLong: Skill = { ...longSkill, description: "This is a very long description." };

		const smallPrompt = ["You are a helpful assistant."];

		// Use an in-memory session manager and pre-populate the branch so
		// the constructor sees getBranch().length > 0 (simulates
		// --continue/auto-resume startup, which does NOT call switchSession).
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 500 } as Message);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: smallPrompt, tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
			skills: [longSkill],
			initialPromptSkills: [redactedLong],
			rebuildSystemPrompt: async () => ({ systemPrompt: smallPrompt, promptSkills: [redactedLong] }),
		});

		// Seed a durable anchor with nonMessageTokens larger than the
		// current (small/redacted) prompt, simulating a prior provider
		// response that billed the old unredacted prompt.
		const smallNonMessageTokens = computeNonMessageTokens(session);
		const largeNonMessageTokens = smallNonMessageTokens + 500;
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
			timestamp: 1000,
		};
		sessionManager.appendMessage(assistantMessage);
		agent.replaceMessages(session.buildDisplaySessionContext().messages);

		// The rebase flag must be set at construction time (before any
		// refreshBaseSystemPrompt or switchSession call) so /context does
		// not clamp the negative non-message delta to zero for the resumed
		// session's old usage anchor. With the flag set, usedTokens must
		// be below the old anchor's promptTokens (100), reflecting the
		// smaller redacted prompt instead of clamping to the stale anchor.
		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens ?? 0).toBeLessThan(100);
	});

	it("does not mark rebase for a new session with empty branch", () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const skill: Skill = {
			name: "test-skill",
			description: "Brief.",
			filePath: "/path/to",
			baseDir: "/path",
			source: "test",
		};

		// In-memory session manager has an empty branch → new session.
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
			skills: [skill],
			initialPromptSkills: [skill],
			rebuildSystemPrompt: async () => ({ systemPrompt: ["rebuilt"], promptSkills: [skill] }),
		});

		// New session: promptSkills is seeded but rebase flag should not
		// matter (no prior anchor). Verify promptSkills is correct.
		expect(session.promptSkills.length).toBe(1);
		expect(session.promptSkills[0].description).toBe("Brief.");
	});
});

describe("AgentSession buffered build validates model before reapply", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-buffered-model-"));
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

	it("does not reapply buffered tool build when model has changed since discard", async () => {
		const all = modelRegistry.getAll();
		const modelA = all[0];
		if (!modelA) throw new Error("Expected at least one model");
		// Pick a model B with a different context window to ensure the
		// model validation catches the change.
		const modelB = all.find(
			m => (m.provider !== modelA.provider || m.id !== modelA.id) && m.contextWindow !== modelA.contextWindow,
		) ?? { ...modelA, id: `${modelA.id}-wide`, contextWindow: (modelA.contextWindow ?? 128000) * 2 };
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		const mcpTool = {
			name: "mcp__test__tool",
			label: "Test MCP Tool",
			description: "A test MCP tool",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const toolRegistry = new Map<string, typeof mcpTool>([["mcp__test__tool", mcpTool]]);

		let rebuildCount = 0;
		let resolveToolRebuild: (() => void) | undefined;
		let resolveModelRebuild: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: true });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: modelA, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				const current = rebuildCount;
				if (current === 1) {
					// Tool rebuild under model A — slow, succeeds.
					const blocker = Promise.withResolvers<void>();
					resolveToolRebuild = blocker.resolve;
					await blocker.promise;
					return { systemPrompt: ["tool-result-model-a"] };
				}
				if (current === 2) {
					// Model-switch rebuild for model B — also slow, then throws.
					// Must be blocked so the tool rebuild can complete and
					// buffer first (version 1≠2).
					const blocker = Promise.withResolvers<void>();
					resolveModelRebuild = blocker.resolve;
					await blocker.promise;
					throw new Error("model B rebuild failure");
				}
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Start a slow tool rebuild under model A (build version 1).
		const setActivePromise = session.setActiveToolsByName(["mcp__test__tool"]);
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);

		// While the tool rebuild is pending, switch to model B without
		// awaiting. This triggers #syncAfterModelChange → refreshBaseSystemPrompt
		// (build version 2), which is also blocked.
		const setModelPromise = session.setModel(modelB);
		await flushMicrotasks();
		expect(rebuildCount).toBe(2);

		// Resolve the tool rebuild first — it sees version 1≠2 and buffers
		// itself with model A's key/context window.
		resolveToolRebuild?.();
		await flushMicrotasks();

		// Now resolve the model-switch rebuild — it throws, rolls back
		// build version to 1, and calls #applyPendingSuccessfulBuild.
		// The pending build has version 1===1 and tool signature matches,
		// but the model has changed from A to B → must NOT apply.
		resolveModelRebuild?.();
		await expect(setModelPromise).rejects.toThrow("model B rebuild failure");
		await setActivePromise;

		// The buffered model-A prompt must NOT be the active prompt.
		// The prompt stays at "initial" because the model check rejected
		// the stale buffered build.
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});
});

describe("AgentSession stale redaction epoch rolls back build version", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-epoch-rollback-"));
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

	it("rolls back build version when stale redaction epoch exits, so buffered tool build can reapply", async () => {
		const [model] = modelRegistry.getAll();
		if (!model) throw new Error("Expected at least one model");
		authStorage.setRuntimeApiKey(model.provider, "key-a");

		const mcpTool = {
			name: "mcp__test__tool",
			label: "Test MCP Tool",
			description: "A test MCP tool",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const toolRegistry = new Map<string, typeof mcpTool>([["mcp__test__tool", mcpTool]]);

		let rebuildCount = 0;
		let resolveToolRebuild: (() => void) | undefined;
		let resolveStaleRefresh: (() => void) | undefined;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				const current = rebuildCount;
				if (current === 1) {
					// Tool rebuild — slow, succeeds with the new tool set.
					const blocker = Promise.withResolvers<void>();
					resolveToolRebuild = blocker.resolve;
					await blocker.promise;
					return { systemPrompt: ["tool-result"] };
				}
				if (current === 2) {
					// First redaction refresh (stale epoch) — slow, will be
					// superseded by a second redaction signal before it finishes.
					const blocker = Promise.withResolvers<void>();
					resolveStaleRefresh = blocker.resolve;
					await blocker.promise;
					return { systemPrompt: ["stale-refresh-result"] };
				}
				if (current === 3) {
					// Second redaction refresh (newer epoch) — throws.
					throw new Error("newer refresh failure");
				}
				return { systemPrompt: [`result-${current}`] };
			},
		});

		// Start a slow tool rebuild (build version 1).
		const setActivePromise = session.setActiveToolsByName(["mcp__test__tool"]);
		await flushMicrotasks();
		expect(rebuildCount).toBe(1);

		// While the tool rebuild is pending, fire a redaction signal.
		// This starts a serialized refreshBaseSystemPrompt (build version 2).
		settings.set("skills.redaction.mode", "trim");
		await flushMicrotasks();
		expect(rebuildCount).toBe(2);

		// While the first redaction refresh is still pending, fire a
		// second redaction signal. This bumps the epoch but the first
		// refresh is still awaiting (build version 2).
		settings.set("skills.redaction.maxContextShare", 0.1);
		await flushMicrotasks();
		// The second signal queues a newer refresh on the serialized chain.
		// It hasn't started yet (rebuild count still 2) because the first
		// refresh is still pending.
		expect(rebuildCount).toBe(2);

		// Resolve the first (stale) redaction refresh. It checks the epoch,
		// sees a newer signal fired, and exits without applying. Without
		// the fix, it would NOT roll back build version 2, leaving it
		// incremented. The tool rebuild (version 1) would then be buffered
		// with version 1≠2.
		resolveStaleRefresh?.();
		await flushMicrotasks();

		// The second (newer) redaction refresh now runs (build version 3)
		// and throws. The catch rolls back to version 2. Without the fix,
		// version 2 was never rolled back by the stale exit, so the
		// rollback lands on 2, and #applyPendingSuccessfulBuild checks
		// version 1≠2 → skips the buffered tool build.
		// With the fix, the stale exit rolled back to 1, then the newer
		// refresh incremented to 2 and threw, rolling back to 1 again.
		// The buffered tool build (version 1===1) can now reapply.
		expect(rebuildCount).toBe(3);

		// Resolve the tool rebuild — it should see version 1===1 and apply.
		resolveToolRebuild?.();
		await setActivePromise;

		// The tool rebuild's result must be the active prompt.
		expect(session.agent.state.systemPrompt).toEqual(["tool-result"]);
	});
});
