import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { computeNonMessageBreakdown } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
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
