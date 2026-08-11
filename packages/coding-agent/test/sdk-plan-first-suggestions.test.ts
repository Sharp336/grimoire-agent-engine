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
	extensions?: ExtensionFactory[];
	hasUI?: boolean;
	settings?: Settings;
	taskDepth?: number;
	toolNames?: string[];
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

	async function assembledPrompt(options: PromptOptions = {}): Promise<string> {
		const cwd = sharedDir.path();
		const sessionManager = SessionManager.inMemory(cwd);
		if (options.existingSession) {
			sessionManager.appendMessage({ role: "user", content: "Prior request", timestamp: 1 });
		}
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry,
			model,
			sessionManager,
			extensions: options.extensions,
			settings: options.settings ?? Settings.isolated(),
			hasUI: options.hasUI ?? true,
			toolNames: options.toolNames,
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
			return session.systemPrompt.join("\n\n");
		} finally {
			await session.dispose();
		}
	}

	it("includes the first-response classification and exact questionnaire contract by default", async () => {
		const prompt = await assembledPrompt();
		const guidanceStart = prompt.indexOf(GUIDANCE_HEADING);

		expect(guidanceStart).toBeGreaterThanOrEqual(0);
		const guidance = prompt.slice(guidanceStart);
		expect(guidance).toContain("classify the user's request as substantial, exempt, or unclear");
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
		expect(guidance).toContain("before using any tool or starting implementation");
		expect(guidance).toContain('"label": "Create a plan"');
		expect(guidance).toContain('"label": "Proceed directly"');
		expect(guidance).toContain('"recommended": 0');
		expect(guidance).toContain(`"helpText": "${HELP_TEXT}"`);
		expect(guidance).toContain("Respect the selected answer");
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
		["resumed sessions", { existingSession: true }],
		["sessions whose active ask is an extension override", { extensions: [askOverrideExtension] }],
		["subagent sessions", { taskDepth: 1 }],
	];

	it.each(suppressionCases)("omits plan-first guidance from %s", async (_name, options) => {
		expect(await assembledPrompt(options)).not.toContain(GUIDANCE_HEADING);
	});
});
