import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import type { LoadSkillsResult, Skill } from "../src/extensibility/skills";
import * as skillsModule from "../src/extensibility/skills";
import { SessionTools, type SessionToolsHost } from "../src/session/session-tools";
import { createTools, type ToolSession } from "../src/tools";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	return Promise.withResolvers<T>();
}

function makeSkill(name: string): Skill {
	return {
		name,
		description: name,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		source: "test",
	};
}

type SessionToolsTestOptions = {
	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>;
	onNotify?: () => void;
	onSetSystemPrompt?: (prompt: string[]) => void;
};

function makeSessionTools(options: SessionToolsTestOptions = {}): SessionTools {
	const settings = Settings.isolated({
		includeModelInPrompt: false,
	});
	settings.set("skills.enabled", true);
	const host = {
		agent: {
			state: { tools: [] },
			setSystemPrompt: (prompt: string[]) => options.onSetSystemPrompt?.(prompt),
		} as unknown as Agent,
		sessionManager: { getCwd: () => "/tmp/session" },
		settings,
		agentKind: () => "sub" as const,
		model: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		queuedMessageCount: () => 0,
		planModeEnabled: () => false,
		extensionRunner: () => undefined,
		clientBridge: () => undefined,
		modelRegistry: {},
		memoryBackendSession: () => undefined,
		clearInheritedProviderPromptCacheKey: () => undefined,
		clearMemoryPromotionSnapshot: () => undefined,
		captureMemoryPromotionSnapshot: () => undefined,
		notifyCommandMetadataChanged: () => options.onNotify?.(),
		localProtocolOptions: () => ({}),
		getInspectImageModeOverride: () => undefined,
		setInspectImageModeOverride: () => undefined,
	} as unknown as SessionToolsHost;

	return new SessionTools(host, {
		toolRegistry: new Map<string, AgentTool>(),
		baseSystemPrompt: ["initial"],
		rebuildSystemPrompt: options.rebuildSystemPrompt ?? (async () => ({ systemPrompt: ["rebuilt"] })),
		skillsReloadable: true,
	});
}

type SkillToolSurface = {
	settings: Settings;
	registry: Map<string, AgentTool>;
	sessionTools: SessionTools;
};

async function makeSkillToolSurface(skillsEnabled: boolean): Promise<SkillToolSurface> {
	const settings = Settings.isolated({
		"tools.xdev": false,
		includeModelInPrompt: false,
	});
	settings.set("skills.enabled", skillsEnabled);
	const toolSession = {
		cwd: "/tmp/session",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		skills: [],
		skipPythonPreflight: true,
	} as unknown as ToolSession;
	const initialTools = await createTools(toolSession, ["skill_search", "read"]);
	const registry = toolSession.toolRegistry ?? new Map(initialTools.map(tool => [tool.name, tool]));
	const agentState: { tools: AgentTool[] } = { tools: initialTools };
	const host = {
		agent: {
			state: agentState,
			setSystemPrompt: () => {},
			setTools: (tools: AgentTool[]) => {
				agentState.tools = tools;
			},
		} as unknown as Agent,
		sessionManager: { getCwd: () => "/tmp/session" },
		settings,
		agentKind: () => "sub" as const,
		model: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		queuedMessageCount: () => 0,
		planModeEnabled: () => false,
		extensionRunner: () => undefined,
		clientBridge: () => undefined,
		modelRegistry: {},
		memoryBackendSession: () => undefined,
		clearInheritedProviderPromptCacheKey: () => undefined,
		clearMemoryPromotionSnapshot: () => undefined,
		captureMemoryPromotionSnapshot: () => undefined,
		notifyCommandMetadataChanged: () => {},
		localProtocolOptions: () => ({}),
		getInspectImageModeOverride: () => undefined,
		setInspectImageModeOverride: () => undefined,
	} as unknown as SessionToolsHost;
	const sessionTools = new SessionTools(host, {
		toolRegistry: registry,
		builtInToolNames: registry.keys(),
		baseSystemPrompt: ["initial"],
		rebuildSystemPrompt: async () => ({ systemPrompt: ["rebuilt"] }),
		skillsReloadable: true,
	});
	return { settings, registry, sessionTools };
}

afterEach(() => vi.restoreAllMocks());

describe("SessionTools.refreshSkills", () => {
	it("adds skill_search to the active model-facing surface when skills are enabled at runtime", async () => {
		vi.spyOn(skillsModule, "loadSkills").mockResolvedValue({ skills: [], warnings: [] });
		const surface = await makeSkillToolSurface(false);

		surface.settings.set("skills.enabled", true);
		await surface.sessionTools.refreshSkills();

		expect(surface.registry.has("skill_search")).toBe(true);
		expect(surface.sessionTools.getActiveToolNames()).toContain("read");
		expect(surface.sessionTools.getActiveToolNames()).toContain("skill_search");
		expect(surface.sessionTools.getToolForEvalBridge("skill_search")).toBeDefined();
	});

	it("removes skill_search from the active model-facing surface when skills are disabled at runtime", async () => {
		vi.spyOn(skillsModule, "loadSkills").mockResolvedValue({ skills: [], warnings: [] });
		const surface = await makeSkillToolSurface(true);
		expect(surface.sessionTools.getActiveToolNames()).toContain("skill_search");

		surface.settings.set("skills.enabled", false);
		await surface.sessionTools.refreshSkills();

		expect(surface.registry.has("skill_search")).toBe(true);
		expect(surface.sessionTools.getActiveToolNames()).not.toContain("skill_search");
		expect(surface.sessionTools.getToolForEvalBridge("skill_search")).toBeUndefined();
	});
});

describe("SessionTools.refreshSkills", () => {
	it("serializes concurrent reloads and keeps completion order deterministic", async () => {
		const first = deferred<LoadSkillsResult>();
		const second = deferred<LoadSkillsResult>();
		const results = [first, second];
		let calls = 0;
		vi.spyOn(skillsModule, "loadSkills").mockImplementation(async () => {
			const result = results[calls++];
			if (!result) throw new Error("unexpected third skill reload");
			return result.promise;
		});

		const sessionTools = makeSessionTools();
		const refreshOne = sessionTools.refreshSkills();
		await Promise.resolve();
		expect(calls).toBe(1);

		const refreshTwo = sessionTools.refreshSkills();
		await Promise.resolve();
		expect(calls).toBe(1);

		first.resolve({ skills: [makeSkill("first")], warnings: [] });
		await refreshOne;
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(2);

		second.resolve({ skills: [makeSkill("second")], warnings: [] });
		await Promise.all([refreshOne, refreshTwo]);

		expect(sessionTools.skills.map(skill => skill.name)).toEqual(["second"]);
	});
	it("awaits each prompt rebuild and metadata notification in queue order", async () => {
		const firstLoad = deferred<LoadSkillsResult>();
		const secondLoad = deferred<LoadSkillsResult>();
		const firstLoadStarted = deferred<true>();
		const secondLoadStarted = deferred<true>();
		const firstPrompt = deferred<{ systemPrompt: string[] }>();
		const secondPrompt = deferred<{ systemPrompt: string[] }>();
		const firstPromptStarted = deferred<true>();
		const secondPromptStarted = deferred<true>();
		const loads = [firstLoad, secondLoad];
		let loadCalls = 0;
		let promptCalls = 0;
		let sessionTools!: SessionTools;
		const promptStates: string[] = [];
		const notifications: string[] = [];
		const appliedPrompts: string[] = [];
		vi.spyOn(skillsModule, "loadSkills").mockImplementation(async () => {
			const result = loads[loadCalls];
			if (!result) throw new Error("unexpected third skill reload");
			loadCalls += 1;
			if (loadCalls === 1) firstLoadStarted.resolve(true);
			if (loadCalls === 2) secondLoadStarted.resolve(true);
			return result.promise;
		});

		sessionTools = makeSessionTools({
			rebuildSystemPrompt: async () => {
				const isFirstPrompt = promptCalls++ === 0;
				const prompt = isFirstPrompt ? firstPrompt : secondPrompt;
				(isFirstPrompt ? firstPromptStarted : secondPromptStarted).resolve(true);
				promptStates.push(sessionTools.skills[0]?.name ?? "none");
				return prompt.promise;
			},
			onNotify: () => notifications.push(sessionTools.skills[0]?.name ?? "none"),
			onSetSystemPrompt: prompt => appliedPrompts.push(prompt[0] ?? ""),
		});
		const refreshOne = sessionTools.refreshSkills();
		const refreshTwo = sessionTools.refreshSkills();
		let firstSettled = false;
		let secondSettled = false;
		void refreshOne.then(
			() => {
				firstSettled = true;
			},
			() => {
				firstSettled = true;
			},
		);
		void refreshTwo.then(
			() => {
				secondSettled = true;
			},
			() => {
				secondSettled = true;
			},
		);

		await firstLoadStarted.promise;
		firstLoad.resolve({ skills: [makeSkill("first")], warnings: [] });
		await firstPromptStarted.promise;
		expect(promptStates).toEqual(["first"]);
		expect(firstSettled).toBe(false);
		expect(secondSettled).toBe(false);

		expect(loadCalls).toBe(1);

		firstPrompt.resolve({ systemPrompt: ["first-prompt"] });
		await refreshOne;
		expect(firstSettled).toBe(true);
		expect(notifications).toEqual(["first"]);
		expect(sessionTools.baseSystemPrompt).toEqual(["first-prompt"]);

		await secondLoadStarted.promise;
		secondLoad.resolve({ skills: [makeSkill("second")], warnings: [] });
		await secondPromptStarted.promise;
		expect(promptStates).toEqual(["first", "second"]);
		expect(secondSettled).toBe(false);
		expect(notifications).toEqual(["first"]);

		secondPrompt.resolve({ systemPrompt: ["second-prompt"] });
		await refreshTwo;
		expect(secondSettled).toBe(true);
		expect(notifications).toEqual(["first", "second"]);
		expect(appliedPrompts).toEqual(["first-prompt", "second-prompt"]);
		expect(sessionTools.baseSystemPrompt).toEqual(["second-prompt"]);
	});

	it("continues queued reloads after an earlier reload fails", async () => {
		const first = deferred<LoadSkillsResult>();
		const second = deferred<LoadSkillsResult>();
		const results = [first, second];
		let calls = 0;
		vi.spyOn(skillsModule, "loadSkills").mockImplementation(async () => {
			const result = results[calls++];
			if (!result) throw new Error("unexpected third skill reload");
			return result.promise;
		});

		const sessionTools = makeSessionTools();
		const refreshOne = sessionTools.refreshSkills();
		const refreshTwo = sessionTools.refreshSkills();

		first.reject(new Error("reload failed"));
		await expect(refreshOne).rejects.toThrow("reload failed");
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(2);

		second.resolve({ skills: [makeSkill("recovered")], warnings: [] });
		await refreshTwo;

		expect(sessionTools.skills.map(skill => skill.name)).toEqual(["recovered"]);
	});
});
