import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type Component, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import * as typebox from "@sinclair/typebox";
import { KeybindingsManager } from "../src/config/keybindings";
import { ReviewCommand } from "../src/extensibility/custom-commands/bundled/review";
import type { CustomCommandAPI } from "../src/extensibility/custom-commands/types";
import type { HookCommandContext, HookUIContext } from "../src/extensibility/hooks/types";
import * as piCodingAgent from "../src/index";
import { SearchableStringSelectorComponent } from "../src/modes/components/searchable-string-selector";
import { initTheme } from "../src/modes/theme/theme";
import * as git from "../src/utils/git";

interface InteractiveComponent extends Component {
	handleInput(keyData: string): void;
}

function createApi(): CustomCommandAPI {
	return {
		cwd: "/tmp/test",
		exec: async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		}),
		typebox,
		pi: piCodingAgent,
	};
}

function renderText(component: Component): string {
	return component.render(120).join("\n");
}

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

describe("searchable review branch selection", () => {
	it("filters branch options as the query is typed and selects the filtered branch", () => {
		let selected: string | undefined;
		const selector = new SearchableStringSelectorComponent(
			"Select base branch to compare against",
			["origin/main", "origin/feature/payments", "origin/chore/docs"],
			value => {
				selected = value;
			},
			() => {},
		);

		selector.handleInput("p");
		selector.handleInput("a");
		selector.handleInput("y");

		const rendered = renderText(selector);
		expect(rendered).toContain("origin/feature/payments");
		expect(rendered).not.toContain("origin/main");
		expect(rendered).not.toContain("origin/chore/docs");

		selector.handleInput("\n");

		expect(selected).toBe("origin/feature/payments");
	});

	it("selects the top-ranked match after filtering from a lower selection", () => {
		let selected: string | undefined;
		const selector = new SearchableStringSelectorComponent(
			"Select base branch to compare against",
			["origin/feature/payroll", "origin/feature/payments", "origin/chore/docs"],
			value => {
				selected = value;
			},
			() => {},
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("p");
		selector.handleInput("a");
		selector.handleInput("y");
		selector.handleInput("\n");

		expect(selected).toBe("origin/feature/payroll");
	});

	it("honors configured select keybindings for navigation and confirmation", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.down": "ctrl+n",
				"tui.select.confirm": "ctrl+y",
			}),
		);
		let selected: string | undefined;
		const selector = new SearchableStringSelectorComponent(
			"Select base branch to compare against",
			["origin/main", "origin/feature/payments", "origin/chore/docs"],
			value => {
				selected = value;
			},
			() => {},
		);

		selector.handleInput("\x0e");
		selector.handleInput("\x19");

		expect(selected).toBe("origin/feature/payments");
	});

	it("treats typed j/k characters as search input instead of navigation", () => {
		let selected: string | undefined;
		const selector = new SearchableStringSelectorComponent(
			"Select base branch to compare against",
			["origin/feature/kappa", "origin/feature/payments", "origin/chore/docs"],
			value => {
				selected = value;
			},
			() => {},
		);

		selector.handleInput("k");

		const rendered = renderText(selector);
		expect(rendered).toContain("origin/feature/kappa");
		expect(rendered).not.toContain("origin/feature/payments");
		expect(rendered).not.toContain("origin/chore/docs");

		selector.handleInput("\n");

		expect(selected).toBe("origin/feature/kappa");
	});

	it("uses the searchable selector for PR-style review base branch selection", async () => {
		vi.spyOn(git.branch, "list").mockResolvedValue(["origin/main", "origin/feature/payments", "origin/chore/docs"]);
		vi.spyOn(git.branch, "current").mockResolvedValue("topic");
		const diffSpy = vi
			.spyOn(git, "diff")
			.mockResolvedValue(
				[
					"diff --git a/src/app.ts b/src/app.ts",
					"index 1111111..2222222 100644",
					"--- a/src/app.ts",
					"+++ b/src/app.ts",
					"@@ -1 +1 @@",
					"-old",
					"+new",
				].join("\n"),
			);
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		let renderedSelector = "";
		const custom: HookUIContext["custom"] = async <T>(
			factory: (
				tui: TUI,
				theme: HookCommandContext["ui"]["theme"],
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		): Promise<T> => {
			const { promise, resolve } = Promise.withResolvers<T>();
			const component = await factory(
				{} as TUI,
				{} as HookCommandContext["ui"]["theme"],
				{} as KeybindingsManager,
				resolve,
			);
			const interactive = component as InteractiveComponent;
			interactive.handleInput("p");
			interactive.handleInput("a");
			interactive.handleInput("y");
			renderedSelector = renderText(interactive);
			interactive.handleInput("\n");
			return promise;
		};
		const ctx = {
			hasUI: true,
			ui: {
				select,
				custom,
				notify: vi.fn(),
			},
		} as unknown as HookCommandContext;
		const command = new ReviewCommand(createApi());

		const result = await command.execute([], ctx);

		expect(select).toHaveBeenCalledTimes(1);
		expect(renderedSelector).toContain("origin/feature/payments");
		expect(renderedSelector).not.toContain("origin/main");
		expect(diffSpy).toHaveBeenCalledWith("/tmp/test", { base: "origin/feature/payments...topic" });
		expect(result).toContain("Reviewing changes between `origin/feature/payments` and `topic` (PR-style)");
	});
});
