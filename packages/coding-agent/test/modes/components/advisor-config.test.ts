import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../../src/config/settings";
import { AdvisorAgentsPickerComponent } from "../../../src/modes/components/advisor-config";
import { getThemeByName, setThemeInstance, type Theme } from "../../../src/modes/theme/theme";
import { parseAgent } from "../../../src/task/agents";
import type { AgentDefinition } from "../../../src/task/types";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";
const ESC = "\x1b";

const SONNET_MODEL: Model = buildModel({
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});
const GPT_MODEL: Model = buildModel({
	provider: "openai",
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	baseUrl: "https://api.openai.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

let darkTheme: Theme | undefined;
const tempDirs: string[] = [];

beforeAll(async () => {
	darkTheme = await getThemeByName("dark");
	if (!darkTheme) throw new Error("Failed to load dark theme");
	setThemeInstance(darkTheme);
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function bundledAgent(name: string, description: string, advisors?: string[]): AgentDefinition {
	return {
		name,
		description,
		systemPrompt: `${description} body`,
		advisors,
		source: "bundled",
		filePath: `embedded:${name}.md`,
	};
}

interface Harness {
	picker: AdvisorAgentsPickerComponent;
	saved: Array<{ enabled: boolean; agents: string[] }>;
	settings: Settings;
	userAgentsDir: string;
	closed: boolean;
	/** Resolves with the selection the moment the component finishes saving. */
	nextSave: () => Promise<{ enabled: boolean; agents: string[] }>;
	frame: () => string;
}

async function createPicker(agents: AgentDefinition[]): Promise<Harness> {
	const userAgentsDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "advisor-picker-")), "agents");
	tempDirs.push(path.dirname(userAgentsDir));
	const settings = Settings.isolated();
	const saved: Array<{ enabled: boolean; agents: string[] }> = [];
	let pending = Promise.withResolvers<{ enabled: boolean; agents: string[] }>();
	const harness: Harness = {
		picker: undefined as unknown as AdvisorAgentsPickerComponent,
		saved,
		settings,
		userAgentsDir,
		closed: false,
		nextSave: () => pending.promise,
		frame: () => stripVTControlCharacters(harness.picker.render(120).join("\n")),
	};
	harness.picker = new AdvisorAgentsPickerComponent(
		{ settings, agents, availableModels: [SONNET_MODEL, GPT_MODEL], userAgentsDir },
		{
			save: sel => {
				saved.push(sel);
				pending.resolve(sel);
				pending = Promise.withResolvers();
			},
			close: () => {
				harness.closed = true;
			},
			requestRender: () => {},
			notify: () => {},
		},
	);
	return harness;
}

describe("AdvisorAgentsPickerComponent", () => {
	it("lists the main session first and excludes the driving agent from its own advisor rows", async () => {
		const { picker, frame } = await createPicker([
			bundledAgent("scout", "Fast scout"),
			bundledAgent("reviewer", "Code reviewer"),
		]);

		const main = frame();
		expect(main.indexOf("default (main session)")).toBeLessThan(main.indexOf("scout"));
		// The global master switch tops the left pane.
		expect(main.indexOf("Advisor runtime")).toBeLessThan(main.indexOf("default (main session)"));

		// Select the main session (one DOWN from the master switch): its roster
		// rows appear on the right.
		picker.handleInput(DOWN);
		const mainRoster = frame();
		expect(mainRoster).toContain("[ ] reviewer");
		expect(mainRoster).toContain("[ ] default");

		// Select "reviewer" on the left (master, main, scout, reviewer → two
		// more downs): its own row disappears from the right.
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		const reviewer = frame();
		expect(reviewer).toContain("Advisor configure · reviewer");
		expect(reviewer).not.toContain("[ ] reviewer");
		expect(reviewer).toContain("[ ] scout");
	});

	it("renders an empty right pane while the global master switch is selected", async () => {
		const { picker, frame } = await createPicker([
			bundledAgent("scout", "Fast scout"),
			bundledAgent("reviewer", "Code reviewer"),
		]);

		// The left cursor starts on the master-switch row: no right-pane rows
		// (roster checkboxes, Save & apply, Close) may render.
		const onMaster = frame();
		expect(onMaster).toContain("[ ] Advisor runtime");
		expect(onMaster).not.toContain("Save & apply");
		expect(onMaster).not.toContain("[ ] default");

		// Moving onto the main session restores its roster.
		picker.handleInput(DOWN);
		expect(frame()).toContain("Save & apply");
		expect(frame()).toContain("[ ] default");

		// And back up onto the master switch blanks it again.
		picker.handleInput(UP);
		const backOnMaster = frame();
		expect(backOnMaster).not.toContain("Save & apply");
		expect(backOnMaster).not.toContain("[ ] default");
	});

	it("omits the built-in default row when a definition named default exists", async () => {
		const { picker, frame } = await createPicker([bundledAgent("default", "Custom default")]);
		// Select the main session so the right pane renders its roster.
		picker.handleInput(DOWN);
		const rendered = frame();
		expect(rendered).not.toContain("Built-in baseline advisor");
		expect(rendered).not.toContain("default model:");
		expect(rendered).toContain("[ ] default");
	});

	it("toggles the master switch on the left pane and the main roster on the right, then save persists settings", async () => {
		const { picker, saved, settings, frame, nextSave } = await createPicker([bundledAgent("scout", "Fast scout")]);

		// The master switch is the left pane's first row; toggling keeps focus left.
		picker.handleInput(ENTER);
		expect(frame()).toContain("[x] Advisor runtime");

		picker.handleInput(DOWN); // default (main session)
		picker.handleInput(TAB); // focus right pane
		picker.handleInput(ENTER); // built-in default row (first on the right)
		expect(frame()).toContain("● unsaved");

		// Right rows: default, default model, scout, save, close — three downs
		// land on Save.
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		// Capture before Enter: the save callback can fire synchronously within
		// handleInput when no frontmatter writes are pending.
		const savePromise = nextSave();
		picker.handleInput(ENTER);
		await savePromise;

		expect(saved).toEqual([{ enabled: true, agents: ["default"] }]);
		expect(settings.get("advisor.enabled")).toBe(true);
		expect(settings.get("advisor.agents")).toEqual(["default"]);
	});

	it("persists a bundled agent's advisors by shadowing it into the user agents dir", async () => {
		const reviewer = bundledAgent("reviewer", "Code reviewer");
		const { picker, userAgentsDir, nextSave } = await createPicker([reviewer, bundledAgent("scout", "Fast scout")]);

		// Select reviewer on the left (master, main, reviewer, scout → two
		// downs), focus right, enable the default advisor (first right row).
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		picker.handleInput(TAB);
		picker.handleInput(ENTER);
		// Right rows: default, default model, scout, save, close — three downs
		// land on Save.
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		const savePromise = nextSave();
		picker.handleInput(ENTER);
		await savePromise;

		const shadowPath = path.join(userAgentsDir, "reviewer.md");
		const shadow = parseAgent(shadowPath, await Bun.file(shadowPath).text(), "user");
		expect(shadow.advisors).toEqual(["default"]);
		expect(shadow.description).toBe("Code reviewer");
		// The local definition now reflects the shadow so reopening shows it.
		expect(reviewer.advisors).toEqual(["default"]);
		expect(reviewer.filePath).toBe(shadowPath);
		expect(reviewer.source).toBe("user");
	});

	/** From the master-switch row: select the main session, focus the right pane, open the model row. */
	function openDefaultModelPicker(picker: AdvisorAgentsPickerComponent): void {
		picker.handleInput(DOWN); // default (main session)
		picker.handleInput(TAB); // focus right pane
		picker.handleInput(DOWN); // "default model:" row
		picker.handleInput(ENTER);
	}

	it("opens a role-and-model picker for the default advisor and shows the current value", async () => {
		const { picker, settings, frame } = await createPicker([bundledAgent("scout", "Fast scout")]);
		settings.setModelRole("slow", "anthropic/claude-sonnet-4-5");

		picker.handleInput(DOWN); // main session roster
		expect(frame()).toContain("default model: auto");

		openDefaultModelPicker(picker);
		const picking = frame();
		expect(picking).toContain("default advisor model — current: auto");
		expect(picking).toContain("@slow");
		expect(picking).toContain("gpt-5.4");
	});

	it("assigns a role to the default advisor and persists it on save", async () => {
		const { picker, settings, frame, nextSave } = await createPicker([bundledAgent("scout", "Fast scout")]);
		settings.setModelRole("slow", "anthropic/claude-sonnet-4-5");

		openDefaultModelPicker(picker);
		// Narrow the browser to the @slow role row and pick it.
		for (const ch of "@slow") picker.handleInput(ch);
		picker.handleInput(ENTER);

		expect(frame()).toContain("default model: @slow");
		expect(frame()).toContain("● unsaved");

		// Right rows: default, default model, scout, save, close — cursor sits
		// on the model row after exiting the picker; two downs land on Save.
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		const savePromise = nextSave();
		picker.handleInput(ENTER);
		await savePromise;

		expect(settings.getModelRole("advisor")).toBe("@slow");
	});

	it("assigns a concrete model to the default advisor and persists it on save", async () => {
		const { picker, settings, frame, nextSave } = await createPicker([bundledAgent("scout", "Fast scout")]);

		openDefaultModelPicker(picker);
		for (const ch of "gpt-5.4") picker.handleInput(ch);
		picker.handleInput(ENTER);

		expect(frame()).toContain("default model: openai/gpt-5.4");
		expect(frame()).toContain("● unsaved");

		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		const savePromise = nextSave();
		picker.handleInput(ENTER);
		await savePromise;

		expect(settings.getModelRole("advisor")).toBe("openai/gpt-5.4");
	});

	it("clears a configured default advisor model back to auto", async () => {
		const { picker, settings, frame, nextSave } = await createPicker([bundledAgent("scout", "Fast scout")]);
		settings.setModelRole("slow", "anthropic/claude-sonnet-4-5");
		settings.setModelRole("advisor", "@slow");

		openDefaultModelPicker(picker);
		for (const ch of "auto") picker.handleInput(ch);
		picker.handleInput(ENTER);

		expect(frame()).toContain("default model: auto");
		expect(frame()).toContain("● unsaved");

		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		const savePromise = nextSave();
		picker.handleInput(ENTER);
		await savePromise;

		expect(settings.getModelRole("advisor")).toBeUndefined();
	});

	it("esc exits the model picker without staging changes", async () => {
		const { picker, frame } = await createPicker([bundledAgent("scout", "Fast scout")]);

		openDefaultModelPicker(picker);
		expect(frame()).toContain("default advisor model — current: auto");

		picker.handleInput(ESC);
		expect(frame()).toContain("Save & apply");
		expect(frame()).not.toContain("● unsaved");
		expect(frame()).not.toContain("default advisor model — current:");
	});

	it("esc closes the overlay", async () => {
		const harness = await createPicker([bundledAgent("scout", "Fast scout")]);
		harness.picker.handleInput("\x1b");
		expect(harness.closed).toBe(true);
	});
});
