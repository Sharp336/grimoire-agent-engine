import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt, type SystemPromptPlan } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { usesCodexTaskPrompt } from "@oh-my-pi/pi-coding-agent/task/prompt-policy";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-coding-agent/utils/local-date";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("formatLocalCalendarDate timezone", () => {
	it("formats the local calendar date in the host timezone, not UTC", () => {
		// 2026-07-01T03:15:00Z is 2026-06-30 in America/Los_Angeles (UTC-7).
		// formatLocalCalendarDate uses getFullYear/getMonth/getDate which respect TZ.
		const previousTz = process.env.TZ;
		try {
			process.env.TZ = "America/Los_Angeles";
			const date = new Date("2026-07-01T03:15:00Z");
			expect(formatLocalCalendarDate(date)).toBe("2026-06-30");
			expect(formatLocalCalendarDate(date)).not.toBe("2026-07-01");
		} finally {
			if (previousTz === undefined) delete process.env.TZ;
			else process.env.TZ = previousTz;
		}
	});
});

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

	it("does not render the date into the stable base prompt", async () => {
		// The date is a volatile suffix injected per-turn via turn-context.md;
		// buildSystemPrompt must keep it out of the stable prefix so the cache
		// breakpoint is byte-stable across midnight.
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		expect(systemPrompt.join("\n\n")).not.toContain("Today is ");
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

describe("SystemPromptPlan NULL_PROMPT and verbatim override", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalNullPrompt: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-null-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-null-home-"));
		originalHome = process.env.HOME;
		originalNullPrompt = Bun.env.NULL_PROMPT;
		process.env.HOME = tempHomeDir;
	});

	afterEach(() => {
		if (originalNullPrompt === undefined) delete Bun.env.NULL_PROMPT;
		else Bun.env.NULL_PROMPT = originalNullPrompt;
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
	});

	it("returns empty verbatim plan with no date or backend side effects under NULL_PROMPT", async () => {
		Bun.env.NULL_PROMPT = "true";
		const plan = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
		});
		expect(plan.systemPrompt).toEqual([]);
		expect(plan.stableSystemPromptBlockCount).toBe(0);
		expect(plan.compositionPolicy).toBe("verbatim");
		// No date rendered — the volatile suffix is never built under NULL_PROMPT.
		expect(plan.systemPrompt.join("\n\n")).not.toContain("Today is ");
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

	function pickTwoModelsWithSameTaskPolicy(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(
			model =>
				(model.provider !== first.provider || model.id !== first.id) &&
				usesCodexTaskPrompt(model.id) === usesCodexTaskPrompt(first.id),
		);
		if (!first || !second) throw new Error("Expected two distinct models with the same task prompt policy");
		return [first, second];
	}

	function pickModelsAcrossTaskPolicies(): [Model, Model] {
		const all = modelRegistry.getAll();
		const defaultPolicy = all.find(model => !usesCodexTaskPrompt(model.id));
		const codexPolicy = all.find(model => usesCodexTaskPrompt(model.id));
		if (!defaultPolicy || !codexPolicy) throw new Error("Expected default-policy and GPT-5.6 models");
		return [defaultPolicy, codexPolicy];
	}

	function newSession(model: Model, settings: Settings, rebuild: () => Promise<SystemPromptPlan>): AgentSession {
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
			return {
				systemPrompt: [`model:${active ? `${active.provider}/${active.id}` : ""}`],
				compositionPolicy: "append-turn-context",
			};
		});

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual([`model:${modelB.provider}/${modelB.id}`]);

		// Re-selecting the same model leaves the rendered model unchanged → no rebuild.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
	});

	it("does not rebuild a hidden-model prompt when the task policy stays the same", async () => {
		const [modelA, modelB] = pickTwoModelsWithSameTaskPolicy();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"], compositionPolicy: "append-turn-context" };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});

	it("rebuilds a hidden-model prompt when the task policy changes", async () => {
		const [modelA, modelB] = pickModelsAcrossTaskPolicies();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["policy changed"], compositionPolicy: "append-turn-context" };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["policy changed"]);
	});
});
