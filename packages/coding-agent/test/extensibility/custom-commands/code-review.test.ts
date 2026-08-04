import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CodeReviewCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/code-review";
import { loadCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import type {
	CustomCommandAPI,
	CustomCommandContext,
	CustomCommandUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { ExtensionUICustomOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CodeReviewOverlay } from "@oh-my-pi/pi-coding-agent/modes/components/code-review-overlay";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";
import { type Component, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";

const SAMPLE_DIFF = `diff --git i/src/workspace.ts w/src/workspace.ts
--- i/src/workspace.ts
+++ w/src/workspace.ts
@@ -0,0 +1 @@
+export const value = 2;
`;

let darkTheme = await getThemeByName("dark");

describe("CodeReviewCommand", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createContext(
		actionIndex: number,
		pasted: string[],
		customOptions: unknown[],
		selectResults = ["2. Review uncommitted changes"],
	): CustomCommandContext {
		const selections = [...selectResults];
		const pasteToEditor: CustomCommandUIContext["pasteToEditor"] = text => pasted.push(text);
		const custom: CustomCommandUIContext["custom"] = async <T>(
			factory: (
				tui: TUI,
				uiTheme: Theme,
				done: (result: T) => void,
			) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
			options?: ExtensionUICustomOptions,
		): Promise<T> => {
			customOptions.push(options);
			const settled = Promise.withResolvers<T>();
			const component = (await factory({} as TUI, theme, settled.resolve)) as Component;
			const overlay = component as CodeReviewOverlay;
			overlay.render(90);
			overlay.handleInput(TAB);
			overlay.handleInput(TAB);
			overlay.handleInput("a");
			for (const char of "check the workspace transition") overlay.handleInput(char);
			overlay.handleInput(ENTER);
			overlay.handleInput(TAB);
			for (let index = 0; index < actionIndex; index++) overlay.handleInput(DOWN);
			overlay.handleInput(ENTER);
			return settled.promise;
		};
		return {
			hasUI: true,
			ui: {
				select: async () => selections.shift(),
				notify: vi.fn(),
				pasteToEditor,
				custom,
			},
		} as unknown as CustomCommandContext;
	}

	it("continues the regular review flow with annotations as additional instructions", async () => {
		spyOn(jj.repo, "is").mockResolvedValue(true);
		spyOn(jj, "diff").mockResolvedValue(SAMPLE_DIFF);
		const pasted: string[] = [];
		const customOptions: unknown[] = [];
		const command = new CodeReviewCommand({ cwd: "/tmp/review" } as CustomCommandAPI);

		const result = await command.execute(["focus", "authentication"], createContext(0, pasted, customOptions));

		expect(result).toContain("## Code Review Request");
		expect(result).toContain("You MUST verify every annotation against the diff and surrounding code");
		expect(result).toContain("src/workspace.ts");
		expect(result).toContain("## Supplemental Review Instructions");
		expect(result).toContain("focus authentication");
		expect(pasted).toEqual([]);
		expect(customOptions).toEqual([{ overlay: true, fullscreen: true, mouseTracking: false }]);
	});

	it("inserts annotations into the current prompt instead of starting AI review", async () => {
		spyOn(jj.repo, "is").mockResolvedValue(true);
		spyOn(jj, "diff").mockResolvedValue(SAMPLE_DIFF);
		const pasted: string[] = [];
		const command = new CodeReviewCommand({ cwd: "/tmp/review" } as CustomCommandAPI);

		const result = await command.execute([], createContext(1, pasted, []));

		expect(result).toBeUndefined();
		expect(pasted).toHaveLength(1);
		expect(pasted[0]).toContain("check the workspace transition");
		expect(pasted[0]).toContain("### src/workspace.ts — new line 1");
	});

	it("reuses the base-branch review target", async () => {
		spyOn(git.branch, "list").mockResolvedValue(["main"]);
		spyOn(git.branch, "current").mockResolvedValue("feature");
		const diffSpy = spyOn(git, "diff").mockResolvedValue(SAMPLE_DIFF);
		const command = new CodeReviewCommand({ cwd: "/tmp/review" } as CustomCommandAPI);

		const result = await command.execute(
			[],
			createContext(0, [], [], ["1. Review against a base branch (PR Style)", "main"]),
		);

		expect(result).toContain("Reviewing changes between `main` and `feature`");
		expect(diffSpy).toHaveBeenCalledWith("/tmp/review", { base: "main...feature" });
	});

	it("reuses the specific-commit review target", async () => {
		spyOn(git.log, "onelines").mockResolvedValue(["abc1234 Add workspace transition"]);
		const showSpy = spyOn(git, "show").mockResolvedValue(SAMPLE_DIFF);
		const command = new CodeReviewCommand({ cwd: "/tmp/review" } as CustomCommandAPI);

		const result = await command.execute(
			[],
			createContext(0, [], [], ["3. Review a specific commit", "abc1234 Add workspace transition"]),
		);

		expect(result).toContain("Reviewing commit `abc1234`");
		expect(showSpy).toHaveBeenCalledWith("/tmp/review", "abc1234", { format: "" });
	});

	it("registers the bundled slash command", async () => {
		const result = await loadCustomCommands({
			cwd: "/tmp/omp-code-review-command-test",
			agentDir: "/tmp/omp-code-review-command-test-agent",
		});

		expect(result.errors).toEqual([]);
		expect(result.commands.map(command => command.command.name)).toContain("code-review");
	});
});
