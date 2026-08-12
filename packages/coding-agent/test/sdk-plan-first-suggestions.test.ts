import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const GUIDANCE_HEADING = "## First-Response Planning Check";
const HELP_TEXT = "Turn off Plan-First Suggestions in /settings → Tasks → Modes.";

function extractGuidanceBullet(guidance: string, prefix: string): string {
	const bullet = guidance.split("\n").find(line => line.startsWith(prefix));
	expect(bullet).toBeDefined();
	return bullet ?? "";
}

const askOverrideExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "ask",
		label: "Extension Ask",
		description: "An extension replacement for the built-in ask tool.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "extension ask" }] };
		},
	});
};

interface PromptOptions {
	existingSession?: boolean;
	existingSummary?: "compaction" | "branch_summary";
	clearAfterCreate?: boolean;
	extensions?: ExtensionFactory[];
	hasUI?: boolean;
	settings?: Settings;
	taskDepth?: number;
	newSessionAfterCreate?: boolean;
	activeTransientModesBeforeNewSession?: boolean;
	activePlanModeAfterCreate?: boolean;
	activeGoalModeAfterCreate?: boolean;
	enableStartupDefaultAfterCreate?: boolean;
	toolNames?: string[];
	systemPrompt?: string;
}

describe("createAgentSession plan-first suggestions", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-plan-first-suggestions-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const bundledModel = getBundledModel("openai", "gpt-4o-mini");
		if (!bundledModel) throw new Error("Expected bundled openai/gpt-4o-mini model");
		model = bundledModel;
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	async function assembledPromptSnapshot(options: PromptOptions = {}) {
		const cwd = sharedDir.path();
		const sessionManager = SessionManager.inMemory(cwd);
		if (options.existingSession) {
			sessionManager.appendMessage({ role: "user", content: "Prior request", timestamp: 1 });
		}
		if (options.existingSummary === "compaction") {
			sessionManager.appendCompaction("Prior conversation summary", undefined, "root", 100);
		} else if (options.existingSummary === "branch_summary") {
			sessionManager.branchWithSummary(null, "Prior branch summary");
		}
		const settings = options.settings ?? Settings.isolated();
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry,
			model,
			sessionManager,
			extensions: options.extensions,
			settings,
			hasUI: options.hasUI ?? true,
			toolNames: options.toolNames,
			systemPrompt: options.systemPrompt,
			taskDepth: options.taskDepth,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			if (options.activeTransientModesBeforeNewSession) {
				const now = Date.now();
				session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
				session.setGoalModeState({
					enabled: true,
					mode: "active",
					goal: {
						id: "goal-before-new-session",
						objective: "Finish the prior session",
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			if (options.newSessionAfterCreate) {
				await session.newSession();
			}
			if (options.clearAfterCreate) {
				await session.resetSessionContext();
			}
			if (options.enableStartupDefaultAfterCreate) {
				settings.set("plan.defaultOnStartup", true);
				await session.refreshBaseSystemPrompt();
			}
			if (options.activePlanModeAfterCreate) {
				session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
				await session.refreshBaseSystemPrompt();
			}
			if (options.activeGoalModeAfterCreate) {
				const now = Date.now();
				session.setGoalModeState({
					enabled: true,
					mode: "active",
					goal: {
						id: "active-goal",
						objective: "Finish the active goal",
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: now,
						updatedAt: now,
					},
				});
				await session.refreshBaseSystemPrompt();
			}
			return {
				prompt: session.systemPrompt.join("\n\n"),
				planModeState: session.getPlanModeState(),
				goalModeState: session.getGoalModeState(),
			};
		} finally {
			await session.dispose();
		}
	}

	async function assembledPrompt(options: PromptOptions = {}): Promise<string> {
		return (await assembledPromptSnapshot(options)).prompt;
	}

	it("includes the first-response classification and exact questionnaire contract by default", async () => {
		const prompt = await assembledPrompt();
		const guidanceStart = prompt.indexOf(GUIDANCE_HEADING);

		expect(guidanceStart).toBeGreaterThanOrEqual(0);
		const guidance = prompt.slice(guidanceStart);
		expect(guidance).toContain("MUST classify the user's request as substantial, exempt, or unclear");
		for (const substantialExample of [
			"whole project or app",
			"feature",
			"multi-file refactor",
			"documentation",
			"report or research deliverable",
			"migration",
			"multi-step build",
		]) {
			expect(guidance).toContain(substantialExample);
		}
		for (const exemptExample of [
			"global rule or instruction change",
			"basic install, update, or upgrade",
			"direct factual answer",
			"one simple command",
			"small isolated correction",
		]) {
			expect(guidance).toContain(exemptExample);
		}
		expect(guidance).toContain("MUST call `ask` before any other tool call or implementation");
		const questionnairePayload = guidance.match(/```json\n([\s\S]*?)\n```/)?.[1];
		expect(questionnairePayload).toBeDefined();
		expect(JSON.parse(questionnairePayload!)).toEqual({
			questions: [
				{
					id: "plan_first",
					question: "How would you like me to continue?",
					options: [
						{ label: "Research first, then start the questionnaire" },
						{ label: "Start the questionnaire now" },
						{ label: "Proceed without a questionnaire or plan" },
					],
					recommended: 0,
				},
			],
			helpText: HELP_TEXT,
		});
		expect(guidance).toContain("MUST follow the selected answer and any custom response");
		expect(guidance).toContain("Exempt classification MUST take precedence over substantial classification");
		expect(guidance).toContain("MUST wait for this initial choice before continuing");
		expect(guidance).toContain("NEVER use another tool or start implementation while the answer is pending");
	});

	it("requires the research-first path to finish the questionnaire before planning", async () => {
		const guidance = (await assembledPrompt()).split(GUIDANCE_HEADING, 2)[1] ?? "";
		const researchBullet = extractGuidanceBullet(
			guidance,
			"- If the user selects `Research first, then start the questionnaire`,",
		);
		const sharedGuardPrefix = "- For either questionnaire path, until the planning questionnaire answers arrive,";
		const sharedGuardBullet = extractGuidanceBullet(guidance, sharedGuardPrefix);

		expect(researchBullet).toContain("MAY use tools only to inspect context that is relevant to the request");
		expect(researchBullet).toContain("MUST NOT start implementation");
		expect(researchBullet).toContain("MUST call `ask` with the planning questionnaire after research");
		expect(researchBullet).toContain("wait for its answers");
		expect(sharedGuardBullet.startsWith(sharedGuardPrefix)).toBe(true);
		expect(sharedGuardBullet).toContain("MUST NOT call a plan or `todo` tool");
		expect(sharedGuardBullet).toContain("create or update a plan or to-do list");
		expect(sharedGuardBullet).toContain("MUST NOT create or update planning files such as `PLAN.md`");
		expect(sharedGuardBullet).toContain("emit a plan in prose");
		expect(sharedGuardBullet).toContain("Only after the answers arrive MAY you start planning");

		const initialAskIndex = guidance.indexOf(
			"If the request is substantial or unclear, you MUST call `ask` before any other tool call or implementation",
		);
		const initialChoiceWaitIndex = guidance.indexOf("MUST wait for this initial choice before continuing");
		const researchPathIndex = guidance.indexOf(researchBullet);
		const sharedGuardIndex = guidance.indexOf(sharedGuardBullet);
		const questionnaireAnswersIndex = guidance.indexOf(
			"until the planning questionnaire answers arrive",
			sharedGuardIndex,
		);
		const planningIndex = guidance.indexOf("Only after the answers arrive MAY you start planning", sharedGuardIndex);

		expect(initialAskIndex).toBeGreaterThanOrEqual(0);
		expect(initialAskIndex).toBeLessThan(initialChoiceWaitIndex);
		expect(initialChoiceWaitIndex).toBeLessThan(researchPathIndex);
		expect(researchPathIndex).toBeLessThan(sharedGuardIndex);
		expect(sharedGuardIndex).toBeLessThan(questionnaireAnswersIndex);
		expect(questionnaireAnswersIndex).toBeLessThan(planningIndex);
	});

	it("requires the immediate-questionnaire path to ask before planning", async () => {
		const guidance = (await assembledPrompt()).split(GUIDANCE_HEADING, 2)[1] ?? "";
		const immediateBullet = extractGuidanceBullet(guidance, "- If the user selects `Start the questionnaire now`,");
		const sharedGuardPrefix = "- For either questionnaire path, until the planning questionnaire answers arrive,";
		const sharedGuardBullet = extractGuidanceBullet(guidance, sharedGuardPrefix);

		expect(immediateBullet).toContain("MUST call `ask` immediately with the planning questionnaire");
		expect(immediateBullet).toContain("before any other tool call, planning content, or implementation");
		expect(sharedGuardBullet.startsWith(sharedGuardPrefix)).toBe(true);
		expect(sharedGuardBullet).toContain("MUST NOT call a plan or `todo` tool");
		expect(sharedGuardBullet).toContain("create or update a plan or to-do list");
		expect(sharedGuardBullet).toContain("MUST NOT create or update planning files such as `PLAN.md`");
		expect(sharedGuardBullet).toContain("emit a plan in prose");
		expect(sharedGuardBullet).toContain("Only after the answers arrive MAY you start planning");

		const initialAskIndex = guidance.indexOf(
			"If the request is substantial or unclear, you MUST call `ask` before any other tool call or implementation",
		);
		const initialChoiceWaitIndex = guidance.indexOf("MUST wait for this initial choice before continuing");
		const immediatePathIndex = guidance.indexOf(immediateBullet);
		const sharedGuardIndex = guidance.indexOf(sharedGuardBullet);
		const questionnaireAnswersIndex = guidance.indexOf(
			"until the planning questionnaire answers arrive",
			sharedGuardIndex,
		);
		const planningIndex = guidance.indexOf("Only after the answers arrive MAY you start planning", sharedGuardIndex);

		expect(initialAskIndex).toBeGreaterThanOrEqual(0);
		expect(initialAskIndex).toBeLessThan(initialChoiceWaitIndex);
		expect(initialChoiceWaitIndex).toBeLessThan(immediatePathIndex);
		expect(immediatePathIndex).toBeLessThan(sharedGuardIndex);
		expect(sharedGuardIndex).toBeLessThan(questionnaireAnswersIndex);
		expect(questionnaireAnswersIndex).toBeLessThan(planningIndex);
	});

	it("requires the go-direct path to skip the questionnaire and planning", async () => {
		const guidance = (await assembledPrompt()).split(GUIDANCE_HEADING, 2)[1] ?? "";
		const directBullet = extractGuidanceBullet(
			guidance,
			"- If the user selects `Proceed without a questionnaire or plan`,",
		);

		expect(directBullet).toContain("MUST proceed without a questionnaire or plan");
		expect(directBullet).toContain("MUST NOT call a plan or `todo` tool");
		expect(directBullet).toContain("MUST NOT create or emit a plan or to-do list");
		expect(directBullet).toContain("MUST NOT create or update planning files such as `PLAN.md`");

		const initialAskIndex = guidance.indexOf(
			"If the request is substantial or unclear, you MUST call `ask` before any other tool call or implementation",
		);
		const initialChoiceWaitIndex = guidance.indexOf("MUST wait for this initial choice before continuing");
		const directPathIndex = guidance.indexOf(directBullet);
		expect(initialAskIndex).toBeGreaterThanOrEqual(0);
		expect(initialAskIndex).toBeLessThan(initialChoiceWaitIndex);
		expect(initialChoiceWaitIndex).toBeLessThan(directPathIndex);
	});

	const suppressionCases: Array<[string, PromptOptions]> = [
		["headless sessions", { hasUI: false }],
		["sessions whose active tools omit ask", { toolNames: ["read"] }],
		["sessions with ask disabled", { settings: Settings.isolated({ "ask.enabled": false }) }],
		["sessions with plan mode disabled", { settings: Settings.isolated({ "plan.enabled": false }) }],
		[
			"sessions with plan-first suggestions disabled",
			{ settings: Settings.isolated({ "plan.suggestBeforeSubstantialWork": false }) },
		],
		["sessions configured to start in plan mode", { settings: Settings.isolated({ "plan.defaultOnStartup": true }) }],
		["sessions already in plan mode", { activePlanModeAfterCreate: true }],
		["sessions already in active goal mode", { activeGoalModeAfterCreate: true }],
		["resumed sessions", { existingSession: true }],
		["sessions resumed from a compaction summary", { existingSummary: "compaction" }],
		["sessions resumed from a branch summary", { existingSummary: "branch_summary" }],
		["fresh sessions cleared in place with /clear", { clearAfterCreate: true }],
		["sessions cleared in place with /clear", { existingSession: true, clearAfterCreate: true }],
		["sessions with a replacement system prompt", { systemPrompt: "Custom SDK prompt" }],
		["sessions whose active ask is an extension override", { extensions: [askOverrideExtension] }],
		["subagent sessions", { taskDepth: 1 }],
	];

	it.each(suppressionCases)("omits plan-first guidance from %s", async (_name, options) => {
		expect(await assembledPrompt(options)).not.toContain(GUIDANCE_HEADING);
	});

	const coexistenceCases: Array<[string, PromptOptions]> = [
		["external thinking enabled", { settings: Settings.isolated({ externalThinking: true }) }],
		["eager todo enforcement", { settings: Settings.isolated({ "todo.eager": "always" }) }],
	];

	it.each(coexistenceCases)("keeps plan-first guidance with %s", async (_name, options) => {
		expect(await assembledPrompt(options)).toContain(GUIDANCE_HEADING);
	});

	it("includes plan-first guidance after /new replaces a resumed session", async () => {
		expect(await assembledPrompt({ existingSession: true, newSessionAfterCreate: true })).toContain(GUIDANCE_HEADING);
	});

	it("clears startup plan and goal state on direct /new so plan-first guidance returns", async () => {
		const snapshot = await assembledPromptSnapshot({
			settings: Settings.isolated({ "plan.defaultOnStartup": true }),
			activeTransientModesBeforeNewSession: true,
			newSessionAfterCreate: true,
		});

		expect(snapshot.planModeState).toBeUndefined();
		expect(snapshot.goalModeState).toBeUndefined();
		expect(snapshot.prompt).toContain(GUIDANCE_HEADING);
	});

	it("preserves current-session guidance when the next-session startup default is enabled", async () => {
		expect(await assembledPrompt({ enableStartupDefaultAfterCreate: true })).toContain(GUIDANCE_HEADING);
	});
});
