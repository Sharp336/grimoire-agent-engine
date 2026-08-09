/**
 * Live `/agent` persona switching: mutable session state (spawns + persona
 * prompt), the `/agent` slash-command spec, and `InteractiveMode.switchAgentPersona`
 * applying tools/model/thinking/spawns/prompt from a discovered agent definition
 * with a persisted `mode_change` entry (`mode: "agent"`, `data: { name }`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

function agentMd(name: string, extraFrontmatter: string[] = []): string {
	return ["---", `name: ${name}`, `description: ${name}`, ...extraFrontmatter, "---", `You are ${name}.`].join("\n");
}

describe("AgentSession persona state", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-persona-state-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const toolRegistry = new Map<string, AgentTool>();
		toolRegistry.set("read", makeTool("read"));
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [makeTool("read")],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: ["read"],
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		session = undefined;
		resetSettingsForTest();
	});

	it("round-trips session spawns (fresh session → null)", () => {
		expect(session?.getSessionSpawns()).toBeNull();
		session?.setSessionSpawns("a,b");
		expect(session?.getSessionSpawns()).toBe("a,b");
		session?.setSessionSpawns(null);
		expect(session?.getSessionSpawns()).toBeNull();
	});

	it("round-trips the persona append prompt", () => {
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		session?.setPersonaAppendPrompt("You are the persona.");
		expect(session?.getPersonaAppendPrompt()).toBe("You are the persona.");
		session?.setPersonaAppendPrompt(undefined);
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
	});
});

describe("BUILTIN_MODE_SLASH_COMMANDS /agent", () => {
	it("registers /agent with allowArgs", () => {
		const spec = BUILTIN_MODE_SLASH_COMMANDS.find(command => command.name === "agent");
		expect(spec).toBeDefined();
		expect(spec?.allowArgs).toBe(true);
		expect(spec?.description).toBe("Switch the main-session agent persona");
	});
});

describe("InteractiveMode.switchAgentPersona", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-switch-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.writeFile(
			path.join(agentsDir, "persona-test.md"),
			agentMd("persona-test", [
				"tools: [read, write]",
				"model: anthropic/claude-haiku-4-5",
				"thinkingLevel: high",
				"spawns: [scout]",
			]),
		);
		await fs.writeFile(
			path.join(agentsDir, "persona-unresolvable.md"),
			agentMd("persona-unresolvable", ["model: nonexistent/model"]),
		);
		await fs.writeFile(path.join(agentsDir, "persona-subagent.md"), agentMd("persona-subagent", ["mode: subagent"]));
		await fs.writeFile(path.join(agentsDir, "persona-minimal.md"), agentMd("persona-minimal"));

		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		mode = undefined;
		session = undefined;
		resetSettingsForTest();
	});

	function createHarness(settings: Settings): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempHome, `models-${Bun.nanoseconds()}.yml`));
		const initialModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!initialModel) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const readTool = makeTool("read");
		const writeTool = makeTool("write");
		const toolRegistry = new Map<string, AgentTool>();
		toolRegistry.set(readTool.name, readTool);
		toolRegistry.set(writeTool.name, writeTool);
		const manager = SessionManager.create(projectDir, path.join(tempHome, `active-${Bun.nanoseconds()}`));
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: ["read", "write"],
		});
		session = createdSession;
		mode = new InteractiveMode(createdSession, "test");
		return mode;
	}

	it("applies tools, model, thinking, spawns, and prompt from the agent definition", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");

		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.model?.id).toBe("claude-haiku-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
		expect(session?.getSessionSpawns()).toBe("scout");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-test.");

		const entries = session?.sessionManager.getEntries() ?? [];
		const modeChange = entries.find(
			(entry): entry is Extract<typeof entry, { type: "mode_change" }> =>
				entry.type === "mode_change" && entry.mode === "agent",
		);
		expect(modeChange).toBeDefined();
		expect(modeChange?.data).toEqual({ name: "persona-test" });
	});

	it("keeps current model with a warning when the agent model pattern does not resolve", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const warning = vi.spyOn(created, "showWarning");
		await created.switchAgentPersona("persona-unresolvable");

		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(warning).toHaveBeenCalledWith(
			'Agent "persona-unresolvable" model pattern did not resolve; keeping current model.',
		);
		// The rest of the switch still applies and persists.
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-unresolvable.");
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(true);
	});

	it("keeps current tools/model/thinking when the agent omits those fields", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-minimal");

		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.configuredThinkingLevel()).toBeUndefined();
		expect(session?.getSessionSpawns()).toBe("*");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-minimal.");
	});

	it("rejects subagent-only agents", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const error = vi.spyOn(created, "showError");
		await created.switchAgentPersona("persona-subagent");

		expect(error).toHaveBeenCalledWith(
			'Agent "persona-subagent" is subagent-only and cannot be used as the main-session persona.',
		);
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("rejects unknown agents", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const error = vi.spyOn(created, "showError");
		await created.switchAgentPersona("does-not-exist");

		expect(error).toHaveBeenCalledWith("Unknown agent: does-not-exist");
	});

	it("rolls back all applied state when the model switch fails mid-apply", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const error = vi.spyOn(created, "showError");
		// First setModelTemporary (the apply) throws; the rollback call uses the real implementation.
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		await created.switchAgentPersona("persona-test");

		expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to switch to agent persona "persona-test"'));
		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.configuredThinkingLevel()).toBeUndefined();
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		// No mode_change persisted on failure.
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(false);
	});
});
