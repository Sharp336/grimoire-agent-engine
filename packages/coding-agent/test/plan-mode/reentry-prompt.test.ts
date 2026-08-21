import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeActivePrompt from "../../src/prompts/system/plan-mode-active.md" with { type: "text" };

const BASE = {
	planFilePath: "local://old-feature-plan.md",
	askToolName: "ask",
	writeToolName: "write",
	editToolName: "edit",
	isHashlineEditMode: false,
	iterative: false,
	askAvailable: true,
	taskAvailable: true,
	scoutAvailable: true,
	reentry: false,
	planExists: true,
} as const;

type Overrides = Partial<Record<keyof typeof BASE, boolean | string>>;

function render(overrides: Overrides = {}): string {
	return prompt.render(planModeActivePrompt, { ...BASE, ...overrides });
}

describe("plan-mode re-entry prompt", () => {
	it("only emits the Re-entry section when re-entering", () => {
		expect(render({ reentry: false })).not.toContain("## Re-entry");
		expect(render({ reentry: true })).toContain("## Re-entry");
	});
});

describe("plan-mode-active tool availability", () => {
	it("omits ask-tool directives when ask is unavailable", () => {
		const withoutAsk = render({ askAvailable: false, iterative: true });
		expect(withoutAsk).not.toContain("ask early via `ask`");
		expect(withoutAsk).not.toContain("`ask` only for critical preferences/tradeoffs");
		expect(withoutAsk).not.toContain("`ask` gathers a required critical clarification");

		const withAsk = render({ askAvailable: true, iterative: true });
		expect(withAsk).toContain("ask early via `ask`");
		expect(withAsk).toContain("`ask` only for critical preferences/tradeoffs");
		expect(withAsk).toContain("`ask` gathers a required critical clarification");
	});

	it("uses prose for critical clarification instead of assuming when ask is unavailable", () => {
		const iterativeWithoutAsk = render({ askAvailable: false, iterative: true });
		expect(iterativeWithoutAsk).toContain("ask the minimum necessary blocking question in prose");
		expect(iterativeWithoutAsk).toContain("NEVER default it");
		expect(iterativeWithoutAsk).not.toContain("Record as Assumptions with a recommended default");
		expect(iterativeWithoutAsk).not.toContain("`ask` only for critical preferences/tradeoffs");

		const parallelWithoutAsk = render({ askAvailable: false, iterative: false });
		expect(parallelWithoutAsk).toContain("ask the minimum necessary blocking question in prose");
		expect(parallelWithoutAsk).toContain("a concise prose question gathers a required critical clarification");
		expect(parallelWithoutAsk).not.toContain("Record preference questions as Assumptions");
	});

	it("allows defaults only for non-load-bearing preferences", () => {
		const rendered = render({ askAvailable: false });
		expect(rendered).toContain("Non-load-bearing preferences MAY use a recommended default");
		expect(rendered).toContain("NEVER record an unresolved key ambiguity as an assumption");
	});

	it("omits scout-via-task dispatch when the task tool is unavailable", () => {
		const withoutTask = render({ taskAvailable: false, scoutAvailable: true });
		expect(withoutTask).not.toContain("(via `task`)");

		const withTask = render({ taskAvailable: true, scoutAvailable: true });
		expect(withTask).toContain("(via `task`)");
	});
});
