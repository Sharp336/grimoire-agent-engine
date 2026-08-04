import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

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

describe("InteractiveMode routine autocomplete", () => {
	let tempDir: TempDir;
	let originalAgentDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let model: Model<Api>;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		initTheme();
		resetSettingsForTest();
		resetCapabilities();
		tempDir = TempDir.createSync("@pi-routine-autocomplete-");
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		resetCapabilities();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const resolved = registry.find("anthropic", "claude-sonnet-4-5");
		if (!resolved) throw new Error("Expected anthropic model claude-sonnet-4-5 to exist");
		model = resolved;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		resetCapabilities();
		authStorage?.close();
		setAgentDir(originalAgentDir);
		resetCapabilities();
		tempDir?.removeSync();
		resetSettingsForTest();
		mode = undefined;
		session = undefined;
	});

	function createHarness(templates: PromptTemplate[] = []): { mode: InteractiveMode; session: AgentSession } {
		const tools = [makeTool("read")];
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		const created = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools,
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			promptTemplates: templates,
		});
		const createdMode = new InteractiveMode(created, "test");
		session = created;
		mode = createdMode;
		return { mode: createdMode, session: created };
	}

	function captureAutocompleteProvider(target: InteractiveMode): { current: AutocompleteProvider | undefined } {
		const slot: { current: AutocompleteProvider | undefined } = { current: undefined };
		vi.spyOn(target.editor, "setAutocompleteProvider").mockImplementation(provider => {
			slot.current = provider;
		});
		return slot;
	}

	async function writeRoutine(name: string, description = "Run core PR review routines"): Promise<void> {
		await Bun.write(
			path.join(getAgentDir(), "routines", `${name}.yaml`),
			`description: ${description}\nsteps:\n  - command: pr-local-readability\n`,
		);
	}

	async function fetchSlashItems(provider: AutocompleteProvider, query: string) {
		const result = await provider.getSuggestions([query], 0, query.length);
		return result?.items ?? [];
	}

	it("shows routine slash commands with the routine description only", async () => {
		await writeRoutine("review-all");
		const created = createHarness();
		const slot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());

		const item = (await fetchSlashItems(slot.current!, "/rev")).find(item => item.value === "review-all");
		expect(item?.description).toBe("Run core PR review routines");
	});

	it("filters prompt templates that share a routine name", async () => {
		await writeRoutine("review-all");
		const created = createHarness([
			{
				name: "review-all",
				description: "Prompt template should be hidden (project)",
				content: "ignored",
				source: "(project)",
			},
		]);
		const slot = captureAutocompleteProvider(created.mode);

		await created.mode.refreshSlashCommandState(tempDir.path());

		const matches = (await fetchSlashItems(slot.current!, "/review-all")).filter(item => item.value === "review-all");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("Run core PR review routines");
	});

	it("rejects routine collision with builtin slash command", async () => {
		await writeRoutine("fast");
		const created = createHarness();

		await expect(created.mode.refreshSlashCommandState(tempDir.path())).rejects.toThrow(
			"Routine /fast conflicts with existing slash command /fast",
		);
	});

	it("rejects routine collision with file slash command", async () => {
		await writeRoutine("init");
		const created = createHarness();

		await expect(created.mode.refreshSlashCommandState(tempDir.path())).rejects.toThrow(
			"Routine /init conflicts with existing slash command /init",
		);
	});
});
